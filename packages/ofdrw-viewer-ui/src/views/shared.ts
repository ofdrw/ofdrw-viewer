/**
 * 缩略图/大纲/书签共享工具（设计方案 §7 / §8）。
 *
 * 本模块只负责导航视图共用的小工具：
 * - 统一跳转锚点：校验 `DocumentDestination`，换算 mm→px，按目标类型调整缩放，
 *   再落到目标页的精确位置；无效目标只告警、不抛错；
 * - 导航样式：复用 `style.css` 中的缩略图/大纲类名，并补充书签、占位与空态样式；
 * - 导航视图依赖的最小宿主接口，避免直接依赖 `OFDViewer` 实现。
 */

import type {
  BookmarkItem,
  DocumentDestination,
  OutlineNode,
  PageInfo,
  PageRenderParameters,
  Viewport,
} from '@ofdrw/ofdrw-viewer-engine';
import type { ViewerFeature } from '../features';
import type { Translator } from '../i18n';
import {
  DEFAULT_PAGE_GAP,
  DEFAULT_PAGE_PADDING,
  MM_TO_CSS_PX,
  PageLayout,
} from '../page-layout';
import type { Rotation, SidebarView, ViewerState, ZoomMode } from '../state';
import type {
  ViewerEventMap,
  ViewerEventName,
  ViewerWarning,
} from '../types';
import type { UIShellElements } from '../ui/types';

/** 引擎渲染任务的最小结构。 */
export interface NavigationRenderTask {
  /** 完成/失败 promise。 */
  readonly promise: Promise<void>;
  /** 取消渲染。 */
  cancel(): void;
}

/** 导航视图使用的最小页面结构；`OFDPage` 结构兼容。 */
export interface NavigationPage {
  /** 页面尺寸，单位 mm。 */
  getSize(): { readonly width: number; readonly height: number };
  /** 指定 DPI 的像素尺寸。 */
  getViewport(options?: { readonly dpi?: number }): Viewport;
  /** 渲染到缩略图 canvas。 */
  render(params: PageRenderParameters): NavigationRenderTask;
}

/** 导航视图使用的最小文档结构；`OFDDocument` 结构兼容。 */
export interface NavigationDocument {
  /** 大纲；缺失表示引擎不支持。 */
  getOutline?(options?: { readonly signal?: AbortSignal }): Promise<readonly OutlineNode[]>;
  /** 书签；缺失表示引擎不支持。 */
  getBookmarks?(options?: { readonly signal?: AbortSignal }): Promise<readonly BookmarkItem[]>;
}

/**
 * 导航视图依赖的阅读器接口。
 *
 * `OFDViewer` 结构兼容；单元测试可注入最小实现。
 */
export interface NavigationViewer {
  /** 最新状态快照。 */
  getState(): ViewerState;
  /** 核心结构元素。 */
  getElements(): UIShellElements;
  /** 全部页信息。 */
  getPageInfos(): readonly PageInfo[];
  /** 指定页信息，页码 1-based。 */
  getPageInfo(pageNumber: number): PageInfo | undefined;
  /** 底层引擎文档。 */
  getDocument(): NavigationDocument | null;
  /** 读取指定页，页码 1-based。 */
  getPage(pageNumber: number): Promise<NavigationPage>;
  /** 当前缩放倍率。 */
  getScale(): number;
  /** 当前旋转角度。 */
  getRotation(): Rotation;
  /** 当前页码，1-based。 */
  getPageNumber(): number;
  /** 当前侧栏；关闭时为 null。 */
  getSidebarView(): SidebarView | null;
  /** 判断功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean;
  /** 跳转到指定页，页码 1-based。 */
  goToPage(pageNumber: number, options?: { readonly smooth?: boolean }): void;
  /** 设置缩放倍率。 */
  setScale(scale: number): void;
  /** 设置缩放模式。 */
  setZoomMode(mode: ZoomMode): void;
  /** 订阅阅读器事件。 */
  on<K extends ViewerEventName>(
    event: K,
    handler: (payload: ViewerEventMap[K]) => void,
  ): () => void;
}

/** 页信息缺省值：A4，单位 mm。 */
const A4: PageInfo = Object.freeze({ index: 0, widthMm: 210, heightMm: 297 });

/** 允许的 OFD 跳转类型。 */
const DEST_TYPES: ReadonlySet<string> = new Set(['XYZ', 'Fit', 'FitH', 'FitV', 'FitR']);

/** 导航告警事件名；宿主可监听根节点上的该事件读取导航 warning。 */
export const NAVIGATION_WARNING_EVENT = 'ofdviewerwarning';

/**
 * 上报导航 warning。
 *
 * 核心没有公开 warning 方法，这里同时写 `console.warn` 并在阅读器根节点派发
 * `ofdviewerwarning` 事件；不抛出、不阻断阅读。
 *
 * @param viewer 阅读器。
 * @param code 诊断码，例如 `W_NAV_DEST`。
 * @param message 面向用户的信息。
 * @param pageIndex 关联页索引，0-based；省略表示与页面无关。
 */
export function reportNavigationWarning(
  viewer: NavigationViewer,
  code: string,
  message: string,
  pageIndex?: number,
): void {
  const warning: ViewerWarning =
    pageIndex === undefined ? { code, message } : { code, message, pageIndex };
  // eslint-disable-next-line no-console
  console.warn(`[ofdrw-viewer-ui] ${code}: ${message}`);
  const root = viewer.getElements().root;
  const win = root.ownerDocument.defaultView;
  if (!win || typeof win.CustomEvent !== 'function') return;
  root.dispatchEvent(
    new win.CustomEvent(NAVIGATION_WARNING_EVENT, { detail: warning, bubbles: false }),
  );
}

/**
 * 规范化页尺寸；非法值回退 A4。
 *
 * @param info 页信息；可为 undefined。
 * @returns 宽高，单位 mm。
 */
export function normalizePageInfo(info: PageInfo | undefined): { widthMm: number; heightMm: number } {
  const widthMm =
    info && Number.isFinite(info.widthMm) && info.widthMm > 0 ? info.widthMm : A4.widthMm;
  const heightMm =
    info && Number.isFinite(info.heightMm) && info.heightMm > 0 ? info.heightMm : A4.heightMm;
  return { widthMm, heightMm };
}

/**
 * 按阅读器当前缩放/旋转建立一份与核心一致的页排版，用于计算页顶偏移。
 *
 * @param viewer 阅读器。
 * @returns 页排版实例。
 */
export function createViewerLayout(viewer: NavigationViewer): PageLayout {
  return new PageLayout({
    pageInfos: viewer.getPageInfos(),
    scale: viewer.getScale(),
    rotation: viewer.getRotation(),
    gap: DEFAULT_PAGE_GAP,
    padding: DEFAULT_PAGE_PADDING,
  });
}

/**
 * mm 换算为当前缩放下的 CSS 像素。
 *
 * @param mm 长度，单位 mm。
 * @param scale 缩放倍率。
 * @returns CSS 像素。
 */
export function mmToCssPx(mm: number, scale: number): number {
  return mm * MM_TO_CSS_PX * scale;
}

/**
 * 校验跳转目标。
 *
 * @param dest 跳转目标；可为 undefined。
 * @param pageCount 总页数。
 * @returns 合法时返回 null，否则返回原因。
 */
export function validateDestination(
  dest: DocumentDestination | undefined,
  pageCount: number,
): string | null {
  if (!dest) return '缺少跳转目标';
  if (!DEST_TYPES.has(dest.type)) return `未知跳转类型 ${String(dest.type)}`;
  if (!Number.isInteger(dest.pageIndex) || dest.pageIndex < 0 || dest.pageIndex >= pageCount) {
    return `目标页越界 ${String(dest.pageIndex)}`;
  }
  for (const key of ['leftMm', 'topMm', 'rightMm', 'bottomMm'] as const) {
    const value = dest[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) return `非法坐标 ${key}`;
  }
  if (dest.zoom !== undefined && (!Number.isFinite(dest.zoom) || dest.zoom <= 0)) {
    return '非法缩放倍率';
  }
  return null;
}

/** 判断跳转目标是否可用于跳转。 */
export function isJumpableDestination(
  dest: DocumentDestination | undefined,
  pageCount: number,
): boolean {
  return validateDestination(dest, pageCount) === null;
}

/** 视图主区域可用尺寸，单位 px。 */
function measureMain(viewer: NavigationViewer): { width: number; height: number } {
  const main = viewer.getElements().main;
  const win = main.ownerDocument.defaultView;
  return {
    width: main.clientWidth || win?.innerWidth || 1024,
    height: main.clientHeight || win?.innerHeight || 800,
  };
}

/**
 * 按目标类型调整缩放；缩放功能关闭或失败时只告警。
 *
 * @param viewer 阅读器。
 * @param dest 已通过校验的跳转目标。
 */
function applyDestinationZoom(viewer: NavigationViewer, dest: DocumentDestination): void {
  if (!viewer.isFeatureEnabled('zoom')) return;
  try {
    if (dest.type === 'XYZ') {
      if (dest.zoom && Math.abs(dest.zoom - viewer.getScale()) > 0.001) {
        viewer.setScale(dest.zoom);
      }
      return;
    }
    if (dest.type === 'Fit') {
      viewer.setZoomMode('page-fit');
      return;
    }
    const viewport = measureMain(viewer);
    if (dest.type === 'FitH') {
      const width = (dest.rightMm ?? 0) - (dest.leftMm ?? 0);
      if (width > 0) viewer.setScale(viewport.width / mmToCssPx(width, 1));
      else viewer.setZoomMode('page-width');
      return;
    }
    if (dest.type === 'FitV') {
      const height = (dest.bottomMm ?? 0) - (dest.topMm ?? 0);
      if (height > 0) viewer.setScale(viewport.height / mmToCssPx(height, 1));
      else viewer.setZoomMode('page-fit');
      return;
    }
    // FitR：按矩形宽高比适配。
    const width = (dest.rightMm ?? 0) - (dest.leftMm ?? 0);
    const height = (dest.bottomMm ?? 0) - (dest.topMm ?? 0);
    if (width > 0 && height > 0) {
      viewer.setScale(
        Math.min(
          viewport.width / mmToCssPx(width, 1),
          viewport.height / mmToCssPx(height, 1),
        ),
      );
    }
  } catch (error) {
    reportNavigationWarning(
      viewer,
      'W_NAV_ZOOM',
      `按跳转目标调整缩放失败：${error instanceof Error ? error.message : String(error)}`,
      dest.pageIndex,
    );
  }
}

/**
 * 统一锚点跳转。
 *
 * 先按目标类型调整缩放，再滚动到目标页，最后按 `topMm` 修正页内偏移；无效目标
 * 只上报 warning 并返回 false，节点仍保留在列表中。
 *
 * @param viewer 阅读器。
 * @param dest 跳转目标。
 * @returns 是否完成跳转。
 */
export function goToDestination(
  viewer: NavigationViewer,
  dest: DocumentDestination | undefined,
): boolean {
  const pageCount = viewer.getPageInfos().length || viewer.getState().document.pageCount;
  const reason = validateDestination(dest, pageCount);
  if (!dest || reason) {
    reportNavigationWarning(viewer, 'W_NAV_DEST', `无效的跳转目标：${reason ?? '未知原因'}`);
    return false;
  }
  applyDestinationZoom(viewer, dest);
  try {
    viewer.goToPage(dest.pageIndex + 1);
  } catch (error) {
    reportNavigationWarning(
      viewer,
      'W_NAV_JUMP',
      `跳转到第 ${dest.pageIndex + 1} 页失败：${error instanceof Error ? error.message : String(error)}`,
      dest.pageIndex,
    );
    return false;
  }
  // 缩放后重新排版，再滚动到页内目标位置。
  const layout = createViewerLayout(viewer);
  const main = viewer.getElements().main;
  const scale = viewer.getScale();
  const pageTop = layout.getPageTop(dest.pageIndex);
  let offset = 0;
  if (dest.type === 'XYZ' || dest.type === 'FitH' || dest.type === 'FitR') {
    offset = mmToCssPx(dest.topMm ?? 0, scale);
  }
  const pageHeight = layout.getPageHeight(dest.pageIndex);
  const maxOffset = Math.max(0, pageHeight - 1);
  main.scrollTop = Math.max(0, pageTop + Math.min(offset, maxOffset));
  return true;
}

/**
 * 生成“第 x 页，共 y 页”的可访问标签。
 *
 * @param translator 翻译器。
 * @param pageNumber 页码，1-based。
 * @param pageCount 总页数。
 * @returns 本地化文案。
 */
export function formatPageLabel(
  translator: Translator,
  pageNumber: number,
  pageCount: number,
): string {
  return translator.t('toolbar.pageNumberOf', {
    page: translator.formatNumber(pageNumber),
    total: translator.formatNumber(pageCount),
  });
}

/** 导航补充样式；复用 `style.css` 中已有的缩略图/大纲类名。 */
const NAVIGATION_CSS = `
.ofd-thumbnails { margin: 0; padding: 0; }
.ofd-nav__empty { margin: 0; padding: 16px 8px; color: var(--ofd-text-secondary, #5b616b); text-align: center; }
.ofd-nav__empty--unsupported { color: var(--ofd-warning, #d97706); }
.ofd-thumbnail[data-state='rendering'] .ofd-thumbnail__canvas-wrapper { opacity: 0.72; }
.ofd-thumbnail[data-state='failed'] .ofd-thumbnail__canvas-wrapper {
  background: var(--ofd-hover-bg, rgba(0, 0, 0, 0.06));
  border: 1px dashed var(--ofd-border, #d8dbe0);
}
.ofd-thumbnail__fallback {
  display: block;
  padding: 8px 4px;
  color: var(--ofd-text-secondary, #5b616b);
  font-size: 12px;
  text-align: center;
}
.ofd-thumbnail__fallback[hidden] { display: none; }
.ofd-thumbnail__canvas-wrapper { position: relative; }
.ofd-thumbnails[data-rotation='90'] .ofd-thumbnail__canvas-wrapper canvas { transform: rotate(90deg); }
.ofd-thumbnails[data-rotation='180'] .ofd-thumbnail__canvas-wrapper canvas { transform: rotate(180deg); }
.ofd-thumbnails[data-rotation='270'] .ofd-thumbnail__canvas-wrapper canvas { transform: rotate(270deg); }
.ofd-outline__title {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  color: inherit;
  background: transparent;
  border: none;
  font: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.ofd-outline__toggle[data-empty='true'] { visibility: hidden; }
.ofd-outline__item[data-dest-invalid='true'] .ofd-outline__title {
  color: var(--ofd-text-secondary, #5b616b);
}
.ofd-bookmarks { margin: 0; padding: 0; list-style: none; }
.ofd-bookmark {
  display: block;
  width: 100%;
  min-height: 28px;
  padding: 4px;
  color: var(--ofd-text, #1f2328);
  background: transparent;
  border: none;
  border-radius: var(--ofd-radius, 2px);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ofd-bookmark:hover { background: var(--ofd-hover-bg, rgba(0, 0, 0, 0.06)); }
.ofd-bookmark[aria-current='true'] {
  color: var(--ofd-accent, #0b66d0);
  background: var(--ofd-accent-soft, rgba(11, 102, 208, 0.12));
}
.ofd-bookmark__page { margin-left: 8px; color: var(--ofd-text-secondary, #5b616b); font-size: 12px; }
.ofd-bookmark[data-dest-invalid='true'] { color: var(--ofd-text-secondary, #5b616b); }
`;

/**
 * 注入导航补充样式；同一 document 只注入一次。
 *
 * @param doc 目标文档。
 */
export function ensureNavigationStyle(doc: Document): void {
  if (doc.querySelector('style[data-ofd-nav-style]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-ofd-nav-style', '');
  style.textContent = NAVIGATION_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * 在空闲时执行回调；无 `requestIdleCallback` 时退化为 `setTimeout(0)`。
 *
 * @param callback 待执行回调。
 * @param timeoutMs 空闲回调的超时时间，单位毫秒。
 * @returns 取消函数。
 */
export function scheduleIdle(callback: () => void, timeoutMs = 200): () => void {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function' &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    const handle = window.requestIdleCallback(() => callback(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

/**
 * 创建导航空态文本节点。
 *
 * @param doc 文档。
 * @param text 文案。
 * @param unsupported 是否为引擎能力缺失。
 * @returns 段落元素。
 */
export function createEmptyState(
  doc: Document,
  text: string,
  unsupported = false,
): HTMLParagraphElement {
  const empty = doc.createElement('p');
  empty.className = unsupported ? 'ofd-nav__empty ofd-nav__empty--unsupported' : 'ofd-nav__empty';
  empty.textContent = text;
  return empty;
}

