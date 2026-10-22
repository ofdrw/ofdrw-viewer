/**
 * URL hash 与浏览器历史（设计方案 §6.7）。
 *
 * 默认不写 URL（`updateHash=false`），避免嵌入场景污染宿主地址。启用后把
 * `#page=3&zoom=page-width&rotation=90&sidebar=outline` 与视图状态同步，并监听
 * `hashchange`/`popstate` 恢复；解析失败时忽略对应字段。
 *
 * 纯解析/格式化函数与 DOM 解耦，便于单测。
 */

import type { Rotation, ScaleValue, SidebarView } from './state';

/** 可从 hash 恢复的视图状态。 */
export interface ViewerHashState {
  /** 页码，1-based。 */
  readonly page?: number;
  /** 缩放：数字倍率或模式。 */
  readonly zoom?: ScaleValue;
  /** 旋转角度。 */
  readonly rotation?: Rotation;
  /** 侧栏视图；省略表示默认（不改变）。 */
  readonly sidebar?: SidebarView | null;
}

/** 历史控制器选项。 */
export interface ViewerHistoryOptions {
  /** 是否写入 URL；false 时只解析、不写。 */
  readonly enabled: boolean;
  /**
   * hash/历史变化回调。
   *
   * @param state 解析出的状态。
   */
  readonly onChange: (state: ViewerHashState) => void;
  /** 宿主 window；默认全局 window。 */
  readonly window?: Window;
}

/** 合法侧栏视图。 */
const SIDEBAR_VIEWS: readonly SidebarView[] = [
  'thumbnails',
  'outline',
  'bookmarks',
  'signatures',
];

/** 合法缩放模式。 */
const ZOOM_MODES = ['auto', 'page-actual', 'page-fit', 'page-width'] as const;

/**
 * 解析 URL hash。
 *
 * @param hash 带或不带 `#` 的 hash 字符串。
 * @returns 解析出的状态；非法字段被忽略。
 */
export function parseViewerHash(hash: string): ViewerHashState {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!text) return {};
  const params = new URLSearchParams(text);
  const result: { page?: number; zoom?: ScaleValue; rotation?: Rotation; sidebar?: SidebarView | null } =
    {};

  const page = Number(params.get('page'));
  if (Number.isInteger(page) && page >= 1) result.page = page;

  const rotation = Number(params.get('rotation'));
  if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) {
    result.rotation = rotation;
  }

  const zoomText = params.get('zoom');
  if (zoomText) {
    if ((ZOOM_MODES as readonly string[]).includes(zoomText)) {
      result.zoom = zoomText as ScaleValue;
    } else {
      const zoom = Number(zoomText);
      if (Number.isFinite(zoom) && zoom > 0) result.zoom = zoom;
    }
  }

  if (params.has('sidebar')) {
    const sidebar = params.get('sidebar') ?? '';
    if (!sidebar || sidebar === 'none') result.sidebar = null;
    else if ((SIDEBAR_VIEWS as readonly string[]).includes(sidebar)) {
      result.sidebar = sidebar as SidebarView;
    }
  }

  return result;
}

/**
 * 格式化 URL hash。
 *
 * @param state 视图状态。
 * @param base 现有 hash，用于保留未知参数；默认空。
 * @returns 不带 `#` 的 hash 字符串。
 */
export function formatViewerHash(state: ViewerHashState, base = ''): string {
  const params = new URLSearchParams(base.startsWith('#') ? base.slice(1) : base);
  if (state.page !== undefined) params.set('page', String(Math.max(1, Math.trunc(state.page))));
  if (state.zoom !== undefined) params.set('zoom', String(state.zoom));
  if (state.rotation !== undefined) params.set('rotation', String(state.rotation));
  if (state.sidebar !== undefined) {
    params.set('sidebar', state.sidebar ?? 'none');
  }
  return params.toString();
}

/** URL hash 历史控制器。 */
export class ViewerHistory {
  private readonly options: ViewerHistoryOptions;
  private readonly win: Window;
  private lastHash = '';
  private startedValue = false;
  private readonly onHashChange = (): void => {
    const state = parseViewerHash(this.win.location.hash);
    if (Object.keys(state).length > 0) this.options.onChange(state);
  };
  private readonly onPopState = (): void => {
    this.onHashChange();
  };

  /**
   * @param options 启停、回调与 window。
   */
  constructor(options: ViewerHistoryOptions) {
    this.options = options;
    this.win = options.window ?? window;
  }

  /** 是否已绑定监听。 */
  get started(): boolean {
    return this.startedValue;
  }

  /**
   * 读取当前 URL 中的状态；未启用时返回空对象。
   *
   * @returns 解析出的状态。
   */
  read(): ViewerHashState {
    if (!this.options.enabled) return {};
    return parseViewerHash(this.win.location.hash);
  }

  /** 绑定 hashchange/popstate。 */
  start(): void {
    if (this.startedValue || !this.options.enabled) return;
    this.startedValue = true;
    this.win.addEventListener('hashchange', this.onHashChange);
    this.win.addEventListener('popstate', this.onPopState);
  }

  /**
   * 同步状态到 URL。
   *
   * @param state 视图状态。
   * @param mode `push` 新增历史、`replace` 替换当前；默认 replace。
   */
  sync(state: ViewerHashState, mode: 'push' | 'replace' = 'replace'): void {
    if (!this.options.enabled) return;
    const hash = formatViewerHash(state, this.win.location.hash);
    if (hash === this.lastHash || hash === this.win.location.hash.replace(/^#/, '')) return;
    this.lastHash = hash;
    const url = `${this.win.location.pathname}${this.win.location.search}#${hash}`;
    try {
      if (mode === 'push') this.win.history.pushState(null, '', url);
      else this.win.history.replaceState(null, '', url);
    } catch {
      // 受限环境（about:blank/sandbox）写入失败时忽略，不影响阅读。
    }
  }

  /** 解绑监听。 */
  destroy(): void {
    if (!this.startedValue) return;
    this.startedValue = false;
    this.win.removeEventListener('hashchange', this.onHashChange);
    this.win.removeEventListener('popstate', this.onPopState);
  }
}