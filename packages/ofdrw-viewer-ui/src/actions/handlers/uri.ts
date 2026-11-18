/**
 * `URI` 动作处理器（UI 动作处理机制设计 §8.3）。
 *
 * **不静默跳转**：文档可携带任意 URL，静默打开是钓鱼与钓鱼式重定向的典型载体。
 * 因此每次执行都先弹确认框，让用户看到完整地址与主机名后才打开；不提供
 * “记住选择”，不做节流/豁免，不写任何存储。
 *
 * 安全约束：
 * - 协议白名单**仅 `http:` / `https:`**；`javascript:`/`data:`/`file:`/`blob:`/
 *   `mailto:`/`tel:`/`ftp:` 一律拒绝，**不弹框**，直接 `skipped('policy')`；
 * - `_blank` 强制 `noopener,noreferrer`，防反向控制与 Referer 泄漏；
 * - `_self` 用 `location.assign` 当前窗口跳转（尊重文档声明；阅读器文档状态会丢失，
 *   宿主可从 `action:executed` 的 `target: '_self'` 自行拦截）；
 * - `window.open` 返回 `null`（弹窗被拦截）→ `failed('popup-blocked')`。
 */

import type { ActionInfo, UriActionPayload } from '@ofdrw/ofdrw-viewer-engine';
import type { ActionHandler, ActionHandlerResult, UriConfirmRequest, UriConfirmer } from '../types';

/** 允许打开的协议白名单。 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** URI handler 依赖的宿主能力。 */
export interface UriHandlerHost {
  /** 确认框；由动作模块注入（复用 `DialogManager`）。 */
  readonly confirm: UriConfirmer;
  /** 当前文档的基地址（`Document.xml` 或页面 URL）；相对地址按它解析。 */
  readonly getBaseUrl?: () => string | undefined;
  /**
   * 打开窗口；默认 `window.open`。
   *
   * 抽成可替换函数便于测试与屏蔽环境差异。
   */
  readonly openWindow?: (url: string, target: string, features: string) => Window | null;
  /**
   * 当前窗口跳转；默认 `location.assign`。
   *
   * @param url 目标地址。
   */
  readonly assignLocation?: (url: string) => void;
}

/**
 * 创建 `URI` 动作处理器。
 *
 * @param host 宿主能力。
 * @returns 动作处理器。
 */
export function createUriHandler(host: UriHandlerHost): ActionHandler {
  return async (
    _context,
    action: ActionInfo,
  ): Promise<ActionHandlerResult> => {
    if (action.payload.type !== 'uri') {
      return { outcome: 'skipped', skipReason: 'policy' };
    }
    const resolved = resolveUri(action.payload, host.getBaseUrl?.());
    if (!resolved) {
      // 相对地址解析失败：目标无效，不弹框。
      return { outcome: 'skipped', skipReason: 'target-missing' };
    }
    if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) {
      // 协议不在白名单：直接拒绝，**不弹确认框**。
      return { outcome: 'skipped', skipReason: 'policy' };
    }

    const target = normalizeTarget(action.payload.target);
    const request: UriConfirmRequest = {
      url: resolved.href,
      host: resolved.host,
      target,
    };
    const confirmed = await host.confirm(request);
    if (!confirmed) return { outcome: 'skipped', skipReason: 'declined' };

    if (target === '_self') {
      // 当前窗口跳转：阅读器文档状态会丢失，由宿主按 target 自行决定是否拦截。
      (host.assignLocation ?? defaultAssignLocation)(resolved.href);
      return { outcome: 'executed', target: '_self' };
    }

    const open = host.openWindow ?? defaultOpenWindow;
    // `_blank` 强制 noopener,noreferrer：防反向控制与 Referer 泄漏。
    const opened = open(resolved.href, '_blank', 'noopener,noreferrer');
    if (!opened) {
      return {
        outcome: 'failed',
        code: 'OFD_URI_POPUP_BLOCKED',
        errorReason: 'popup-blocked',
        message: '浏览器阻止了弹出窗口',
      };
    }
    return { outcome: 'executed', target: '_blank' };
  };
}

/**
 * 解析 URI：`new URL(uri, base)`，相对地址按 `Base` / 文档基地址解析。
 *
 * @param payload URI 动作 payload。
 * @param documentBase 文档基地址；省略时用 `location.href`。
 * @returns 解析后的 URL；解析失败时 undefined。
 */
function resolveUri(payload: UriActionPayload, documentBase: string | undefined): URL | undefined {
  const raw = payload.uri?.trim();
  if (!raw) return undefined;
  const base = payload.base?.trim() || documentBase;
  try {
    // 有 Base 时按 Base 解析；无 Base 时用当前页面地址兜底相对路径。
    if (base) return new URL(raw, base);
    if (typeof location !== 'undefined') return new URL(raw, location.href);
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * 规范化 `Target`：只认 `_self`，其余（含缺省、`_blank`、未知值）一律按 `_blank`。
 *
 * @param target 文档声明的打开方式。
 * @returns `'_self'` 或 `'_blank'`。
 */
function normalizeTarget(target: string | undefined): '_self' | '_blank' {
  return target?.trim().toLowerCase() === '_self' ? '_self' : '_blank';
}

/**
 * 默认新窗口打开实现。
 *
 * @param url 目标地址。
 * @param target 窗口目标。
 * @param features 窗口特性（含 `noopener,noreferrer`）。
 * @returns 新窗口；被拦截时 null。
 */
function defaultOpenWindow(url: string, target: string, features: string): Window | null {
  if (typeof window === 'undefined') return null;
  return window.open(url, target, features);
}

/**
 * 默认当前窗口跳转实现。
 *
 * @param url 目标地址。
 */
function defaultAssignLocation(url: string): void {
  if (typeof location !== 'undefined') location.assign(url);
}