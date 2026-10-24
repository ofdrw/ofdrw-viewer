/**
 * 输出任务的进度与警告展示（设计方案 §10.4 / §10.6）。
 *
 * 有内置 UI 时用对话框展示进度并提供取消按钮；没有 UI（宿主自绘工具栏）时
 * 静默执行，但 `onProgress`/`onWarning` 回调仍可用。进度对话框只在任务页数
 * 超过阈值时打开，避免小任务闪烁。
 */

import type { ViewerFeature } from '../features';
import type { ExportProgressEvent, ViewerWarning } from '../types';
import { getUIShell, type UIShellHost } from '../ui';
import type { OutputHost } from './host';
import { emitOutputEvent } from './events';
import { UI_WARNING_CODES } from '../diagnostics';

/** 打开进度对话框的最小页数。 */
const PROGRESS_DIALOG_THRESHOLD = 20;

/** 输出模块回调；宿主自绘工具栏时用于接入自己的进度 UI。 */
export interface OutputHooks {
  /** 每完成一页回调一次；`total` 为本次任务页数。 */
  onProgress?: (progress: ExportProgressEvent) => void;
  /** 非阻断警告；例如自动降低 DPI 或大任务提示。 */
  onWarning?: (warning: ViewerWarning) => void;
}

/** 进度展示句柄。 */
export interface OutputProgressHandle {
  /** 更新进度；`current` 为已完成页数。 */
  update(current: number, total: number): void;
  /** 关闭对话框；完成任务时调用。 */
  close(): void;
}

/** 读取内置 UI；宿主未挂载 UI 或为测试桩时返回 undefined。 */
function findShell(host: OutputHost) {
  try {
    return getUIShell(host as unknown as UIShellHost);
  } catch {
    return undefined;
  }
}

/** 是否中文环境。 */
function isChinese(host: OutputHost): boolean {
  const locale = findShell(host)?.translatorInstance.locale ?? 'zh-CN';
  return locale.toLowerCase().startsWith('zh');
}

/**
 * 创建进度对话框。
 *
 * @param host 输出宿主。
 * @param feature 功能键，用于对话框名称与关闭联动。
 * @param title 标题。
 * @param total 总页数。
 * @param onCancel 用户取消回调。
 * @returns 进度句柄；无 UI 或页数较少时返回 null。
 */
export function createProgressDialog(
  host: OutputHost,
  feature: ViewerFeature,
  title: string,
  total: number,
  onCancel: () => void,
): OutputProgressHandle | null {
  if (total <= PROGRESS_DIALOG_THRESHOLD) return null;
  const shell = findShell(host);
  if (!shell) return null;

  const doc = host.getElements().root.ownerDocument;
  const chinese = isChinese(host);
  const content = doc.createElement('div');
  content.className = 'ofd-output-progress';
  const progress = doc.createElement('progress');
  progress.className = 'ofd-output-progress__bar';
  progress.max = total;
  progress.value = 0;
  progress.setAttribute('aria-label', title);
  const text = doc.createElement('p');
  text.className = 'ofd-output-progress__text';
  text.textContent = `0 / ${total}`;
  content.append(progress, text);

  let done = false;
  let cancelled = false;
  try {
    shell.openDialog({
      name: feature,
      title,
      content,
      dismissible: true,
      actions: [
        {
          label: chinese ? '取消' : 'Cancel',
          onClick: () => undefined,
        },
      ],
      onClose: () => {
        if (done || cancelled) return;
        cancelled = true;
        onCancel();
      },
    });
  } catch {
    return null;
  }

  return {
    update(current: number, nextTotal: number) {
      if (done || cancelled) return;
      const value = Math.max(0, Math.min(current, nextTotal));
      progress.max = nextTotal;
      progress.value = value;
      text.textContent = `${value} / ${nextTotal}`;
    },
    close() {
      if (done) return;
      done = true;
      try {
        shell.closeDialog();
      } catch {
        // 对话框可能已被功能开关关闭。
      }
    },
  };
}

/**
 * 上报非阻断警告：始终调用回调，有内置 UI 时额外显示 Toast。
 *
 * @param host 输出宿主。
 * @param hooks 回调。
 * @param code 警告码。
 * @param message 人类可读信息。
 */
export function reportOutputWarning(
  host: OutputHost,
  hooks: OutputHooks,
  code: string,
  message: string,
): void {
  const warning = { code, message } as const;
  hooks.onWarning?.(warning);
  emitOutputEvent(host, 'warning', warning);
  const shell = findShell(host);
  if (!shell) return;
  try {
    shell.showToast(message, { level: 'warning', id: `ofd-output-${code}` });
  } catch {
    // Toast 失败不影响任务。
  }
}

/**
 * 根据任务规模提示精度与内存风险。
 *
 * @param host 输出宿主。
 * @param hooks 回调。
 * @param feature `print` 或 `export`。
 * @param total 本次任务页数。
 * @param autoDpi 是否使用自动 DPI。
 */
export function warnForLargeTask(
  host: OutputHost,
  hooks: OutputHooks,
  feature: 'print' | 'export',
  total: number,
  autoDpi: boolean,
): void {
  if (autoDpi && total > 200) {
    reportOutputWarning(
      host,
      hooks,
      UI_WARNING_CODES.W_OUTPUT_DPI_REDUCED,
      `${total} 页任务较大，已自动降低${feature === 'print' ? '打印' : '导出'}精度至 96 DPI`,
    );
  }
  if (total >= 1000) {
    reportOutputWarning(
      host,
      hooks,
      UI_WARNING_CODES.W_OUTPUT_LARGE_TASK,
      `本次任务共 ${total} 页，可能占用较多内存，建议分批处理`,
    );
  }
}
