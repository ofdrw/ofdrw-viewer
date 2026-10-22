/**
 * 打印服务（设计方案 §10.2–§10.4）。
 *
 * 支持当前页/全部页/自定义范围；逐页图片 + `@page`，不生成 PDF；支持旋转、
 * 混合页尺寸、自适应 DPI、进度、取消与千页任务警告。
 */

import type { DocumentPermissions } from '@ofdrw/ofdrw-viewer-engine';
import {
  createFeatureDisabledError,
  OFDViewerError,
  toOFDViewerError,
} from '../errors';
import type { PrintOptions } from '../types';
import {
  createAbortScope,
  createAbortError,
  getExportablePage,
  isAbortError,
  throwIfAborted,
} from '../export/image';
import {
  normalizeRotation,
  resolveDpi,
  resolvePageRange,
  type PageRangeInput,
} from '../export/options';
import {
  createProgressDialog,
  warnForLargeTask,
  type OutputHooks,
} from '../export/progress';
import type { OutputHost } from '../export/host';
import { emitOutputEvent } from '../export/events';
import {
  preparePrintDocument,
  printPreparedDocument,
  type PreparedPrintDocument,
} from './print-document';

/** 打印选项；`range` 为 `pages` 的别名，便于自定义工具栏传范围文本。 */
export interface PrintRequestOptions extends Omit<PrintOptions, 'pages'> {
  /** 打印范围；默认 `current`。 */
  readonly pages?: PageRangeInput;
  /** 打印范围别名；与 `pages` 同时出现时优先 `range`。 */
  readonly range?: PageRangeInput;
}

/**
 * 打印服务。
 */
export class PrintService {
  /**
   * @param host 阅读器宿主。
   * @param hooks 进度/警告回调；内置 UI 负责进度对话框与警示 Toast。
   */
  constructor(
    private readonly host: OutputHost,
    private readonly hooks: OutputHooks = {},
  ) {}

  /**
   * 执行打印：准备逐页图片、调用 `window.print()`，结束后清理 DOM。
   *
   * @param options 打印选项；默认打印当前页、自动 DPI、沿用当前旋转。
   */
  async print(options: PrintRequestOptions = {}): Promise<void> {
    const scope = createAbortScope(options.signal);
    let prepared: PreparedPrintDocument | null = null;
    let progressDialog: ReturnType<typeof createProgressDialog> = null;
    let printedPages = 0;
    let totalPages = 0;
    try {
      this.assertFeature();
      const pageCount = this.host.getPageCount();
      if (!Number.isFinite(pageCount) || pageCount < 1) {
        throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开');
      }
      const pages = resolvePageRange(
        options.range ?? options.pages,
        this.host.getPageNumber(),
        pageCount,
      );
      const dpi = resolveDpi(options.dpi, pages.length);
      const autoDpi = options.dpi === undefined || options.dpi === 'auto';
      const rotation =
        options.rotation === undefined || options.rotation === 'current'
          ? normalizeRotation(this.host.getRotation())
          : normalizeRotation(options.rotation);
      const includeBackground = options.includeBackground ?? false;
      totalPages = pages.length;
      warnForLargeTask(this.host, this.hooks, 'print', pages.length, autoDpi);
      await this.assertPermission();
      throwIfAborted(scope);
      // 预检首页能力，避免准备进度框后才失败。
      await getExportablePage(this.host, pages[0]!, 'print');
      throwIfAborted(scope);

      emitOutputEvent(this.host, 'printstart', { current: 0, total: pages.length });
      progressDialog = createProgressDialog(
        this.host,
        'print',
        '正在准备打印',
        pages.length,
        () => scope.abort(),
      );
      prepared = await preparePrintDocument(this.host, {
        pages,
        dpi,
        rotation,
        includeBackground,
        signal: scope.signal,
        onProgress: (progress) => {
          printedPages = progress.current;
          this.hooks.onProgress?.(progress);
          emitOutputEvent(this.host, 'printprogress', progress);
          progressDialog?.update(progress.current, progress.total);
        },
      });
      throwIfAborted(scope);
      await printPreparedDocument(prepared);
    } catch (error) {
      if (isAbortError(error)) throw createAbortError();
      if (error instanceof OFDViewerError) throw error;
      throw toOFDViewerError(
        error,
        'OFD_PRINT_FAILED',
        `打印失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      prepared?.cleanup();
      progressDialog?.close();
      if (totalPages > 0) {
        emitOutputEvent(this.host, 'printend', {
          current: printedPages,
          total: totalPages,
        });
      }
      scope.dispose();
    }
  }

  /** 断言打印功能可用。 */
  private assertFeature(): void {
    const state = this.host.getFeatureState('print');
    if (!state.enabled) throw createFeatureDisabledError('print');
  }

  /** 文档权限禁止打印时按功能关闭处理。 */
  private async assertPermission(): Promise<void> {
    let permissions: DocumentPermissions | null = null;
    try {
      permissions = await this.host.getPermissions();
    } catch {
      permissions = null;
    }
    if (
      permissions?.print &&
      (permissions.print.printable === false || permissions.print.copies === 0)
    ) {
      throw createFeatureDisabledError('print', '当前文档不允许打印');
    }
  }
}