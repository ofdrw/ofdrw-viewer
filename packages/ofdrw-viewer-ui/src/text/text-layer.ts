/**
 * 透明文本层服务（设计方案 §9.2 / §9.3）。
 *
 * 只给可见页（含上下各 1 页预取）构建文本层；canvas 负责视觉，DOM span 负责
 * 选择、复制、读屏与查找高亮。文本层坐标按 96 DPI 构建，页面容器的
 * `--scale-factor` 负责缩放，页面旋转由容器 CSS transform 承担。
 *
 * 该服务不调用任何 Canvas 文字 API，也不修改 canvas 绘制结果。
 */

import { replaceChildren, runMicrotask } from '../compat';

import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import type { PageView } from '../page-view';
import type { ViewerState } from '../state';
import type {
  BuildTextLayerOptions,
  TextLayerSpecs,
  TextSpanSpec,
} from './geometry';
import { MAX_TEXT_LAYER_NODES, buildTextLayerSpecs, mmToCssPx } from './geometry';
import type { FindHighlightRenderer, FindMatch } from './types';
import type { TextViewerHost, ViewerBridge, ViewerTextLayerServiceLike } from './viewer-bridge';
import { textContentOptions } from './viewer-bridge';
import { UI_WARNING_CODES } from '../diagnostics';

/** 单页文本层状态。 */
interface PageTextState {
  /** 当前加载代次；可见页变化时递增，旧结果丢弃。 */
  generation: number;
  /** 取消信号。 */
  abort: AbortController | null;
  /** 是否已成功构建。 */
  built: boolean;
  /** 是否加载失败；离开可见区后重置，避免每次滚动重复请求。 */
  failed: boolean;
  /** 已渲染节点数。 */
  nodeCount: number;
}

/** 文本层服务选项。 */
export interface TextLayerServiceOptions {
  /** 单页节点上限；默认 5000。 */
  readonly maxNodes?: number;
  /** 可见页上下额外预取页数；默认 1。 */
  readonly overscan?: number;
}

/**
 * 把 96 DPI 坐标系图层铺满纸面并按布局倍率缩放内容。
 *
 * 文本层与查找高亮层的 span 坐标都是 **96 DPI 基准**（不含布局倍率），因此图层
 * 布局框必须等于“纸面尺寸 / 布局倍率”，再由 `--scale-factor` 放大回来，与 canvas
 * 恰好重合。若直接把图层设成 `100%` 铺满纸面，纸面尺寸已含倍率，再接 `transform`
 * 就会把倍率乘两次（实测 2 倍缩放时文字层宽度是画布的 2 倍）。
 *
 * @param layer 图层元素。
 * @param surfaceWidth 纸面宽，单位 px（已含布局倍率）。
 * @param surfaceHeight 纸面高，单位 px（已含布局倍率）。
 * @param scaleFactor 布局倍率；非法或非正时按 1。
 */
export function applyLayerScale(
  layer: HTMLElement,
  surfaceWidth: number,
  surfaceHeight: number,
  scaleFactor: number,
): void {
  const factor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const width = Number.isFinite(surfaceWidth) && surfaceWidth > 0 ? surfaceWidth : 0;
  const height = Number.isFinite(surfaceHeight) && surfaceHeight > 0 ? surfaceHeight : 0;
  const style = layer.style;
  style.position = 'absolute';
  style.left = '0';
  style.top = '0';
  style.width = `${width / factor}px`;
  style.height = `${height / factor}px`;
  style.right = 'auto';
  style.bottom = 'auto';
  style.transformOrigin = '0 0';
  style.transform = `scale(${factor})`;
}

/**
 * 创建透明文本层 span；不拼 innerHTML，避免 XSS。
 *
 * @param doc 宿主文档。
 * @param spec span 描述。
 * @param pageNumber 页码，1-based。
 * @param selectable 是否允许选择。
 * @returns span 元素。
 */
export function createTextSpan(
  doc: Document,
  spec: TextSpanSpec,
  pageNumber: number,
  selectable: boolean,
): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = spec.className;
  span.textContent = spec.text;
  const style = span.style;
  style.position = 'absolute';
  style.left = `${spec.left}px`;
  style.top = `${spec.top}px`;
  style.width = `${spec.width}px`;
  style.height = `${spec.height}px`;
  style.fontSize = `${spec.fontSize}px`;
  style.lineHeight = `${spec.lineHeight}px`;
  style.transform = spec.transform;
  style.transformOrigin = '0 0';
  style.margin = '0';
  style.padding = '0';
  style.border = '0';
  style.whiteSpace = 'pre';
  style.color = 'transparent';
  style.caretColor = 'transparent';
  style.cursor = 'text';
  style.userSelect = selectable ? 'text' : 'none';
  style.setProperty('-webkit-user-select', selectable ? 'text' : 'none');
  // 供选区文本抽取判断行/段关系，不依赖布局引擎。
  span.dataset.pageNumber = String(pageNumber);
  span.dataset.itemIndex = String(spec.itemIndex);
  if (spec.charIndex !== undefined) span.dataset.charIndex = String(spec.charIndex);
  span.dataset.x = String(spec.left);
  span.dataset.y = String(spec.top);
  span.dataset.size = String(spec.fontSize);
  span.dataset.angle = String(spec.angle);
  return span;
}

/**
 * 文本层与查找高亮服务。
 *
 * `OFDViewer` 通过 `attachTextLayerService` 挂载；同时作为 `FindController` 的
 * 高亮渲染器。
 */
export class TextLayerService implements FindHighlightRenderer, ViewerTextLayerServiceLike {
  /** 单页节点上限。 */
  readonly maxNodes: number;
  /** 可见页额外预取页数。 */
  readonly overscan: number;

  private readonly host: TextViewerHost;
  private readonly bridge: ViewerBridge;
  private readonly pages = new Map<number, PageTextState>();
  private readonly findLayers = new Map<number, HTMLElement>();
  private readonly cleanups: Array<() => void> = [];
  private matches: readonly FindMatch[] = [];
  private current = 0;
  private highlightAll = true;
  private refreshQueued = false;
  private disposed = false;

  /**
   * @param host 阅读器能力集合。
   * @param bridge 核心状态/事件桥。
   * @param options 节点上限与预取页数。
   */
  constructor(
    host: TextViewerHost,
    bridge: ViewerBridge,
    options: TextLayerServiceOptions = {},
  ) {
    this.host = host;
    this.bridge = bridge;
    this.maxNodes = Math.max(0, options.maxNodes ?? MAX_TEXT_LAYER_NODES);
    this.overscan = Math.max(0, options.overscan ?? 1);
    this.cleanups.push(
      host.on('statechange', () => this.scheduleRefresh()),
      host.on('documentopen', () => {
        this.resetPages();
        this.refresh();
      }),
      host.on('documentclose', () => this.resetPages()),
      host.on('pagesloaded', () => this.refresh()),
      host.on('featureschange', () => {
        this.applyFeatureStates();
        this.scheduleRefresh();
      }),
    );
    this.refresh();
  }

  /** 立即按当前可见页刷新文本层（服务接口）。 */
  refresh(): void {
    this.refreshQueued = false;
    if (this.disposed) return;
    const textLayerEnabled = this.host.isFeatureEnabled('textLayer');
    if (!textLayerEnabled) {
      this.clearAllTextLayers();
      return;
    }
    const state = this.host.getState();
    if (state.document.status !== 'ready' || this.host.getPageCount() === 0) return;

    const visible = this.visiblePageNumbers(state);
    const visibleSet = new Set(visible);
    for (const pageNumber of this.pages.keys()) {
      if (!visibleSet.has(pageNumber)) this.clearPageTextLayer(pageNumber);
    }
    for (const pageNumber of visible) {
      const view = this.host.getPageView(pageNumber);
      if (!view || view.isDestroyed) continue;
      const pageState = this.pages.get(pageNumber);
      if (pageState?.built || pageState?.failed) {
        // 已建好的文字层 span 坐标不变，但布局框要跟随纸面尺寸/倍率更新，
        // 否则缩放提交后文字层与 canvas 尺寸不一致。
        this.syncPageTextLayerGeometry(pageNumber, view);
        continue;
      }
      void this.loadPage(pageNumber, view);
    }
    this.renderFindHighlights();
  }

  /**
   * 按当前布局刷新单页文字层的布局框与缩放；已建好的 span 不重建。
   *
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   */
  private syncPageTextLayerGeometry(pageNumber: number, view: PageView): void {
    const layer = view.textLayer;
    if (!layer || layer.childElementCount === 0) return;
    applyLayerScale(
      layer,
      this.surfaceWidthOf(pageNumber, view),
      this.surfaceHeightOf(pageNumber, view),
      view.layoutScale || 1,
    );
  }

  /** 纸面宽，单位 px（含布局倍率）；页视图未布局时按 96 DPI 页宽兜底。 */
  private surfaceWidthOf(pageNumber: number, view: PageView): number {
    if (view.surfaceWidth > 0) return view.surfaceWidth;
    const info = this.host.getPageInfo(pageNumber);
    return mmToCssPx(info?.widthMm ?? 210) * (view.layoutScale || 1);
  }

  /** 纸面高，单位 px（含布局倍率）；页视图未布局时按 96 DPI 页高兜底。 */
  private surfaceHeightOf(pageNumber: number, view: PageView): number {
    if (view.surfaceHeight > 0) return view.surfaceHeight;
    const info = this.host.getPageInfo(pageNumber);
    return mmToCssPx(info?.heightMm ?? 297) * (view.layoutScale || 1);
  }

  /** 销毁并释放全部 DOM/监听/进行中的请求。 */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const state of this.pages.values()) {
      state.generation += 1;
      state.abort?.abort();
    }
    this.pages.clear();
    this.clearAllTextLayers();
    this.clearFindHighlights();
    for (const pageNumber of this.findLayers.keys()) this.removeFindLayer(pageNumber);
  }

  // -------------------------------------------------------------------------
  // 查找高亮渲染
  // -------------------------------------------------------------------------

  /**
   * 更新命中集合并重绘。
   *
   * @param matches 全部命中。
   * @param current 当前命中序号，1-based；0 表示无。
   * @param highlightAll 是否显示全部命中。
   */
  setFindMatches(
    matches: readonly FindMatch[],
    current: number,
    highlightAll: boolean,
  ): void {
    this.matches = matches;
    this.current = current;
    this.highlightAll = highlightAll;
    this.renderFindHighlights();
  }

  /**
   * 更新当前命中。
   *
   * @param current 当前命中序号，1-based。
   */
  setFindCurrent(current: number): void {
    this.current = current;
    this.renderFindHighlights();
  }

  /** 清除全部查找高亮。 */
  clearFindHighlights(): void {
    this.matches = [];
    this.current = 0;
    for (const layer of this.findLayers.values()) replaceChildren(layer);
  }

  /**
   * 滚动到命中项，并让高亮位于滚动区域中部。
   *
   * @param match 命中项。
   */
  scrollToMatch(match: FindMatch): void {
    if (this.disposed) return;
    this.host.goToPage(match.pageNumber, { smooth: false });
    this.renderFindHighlights();
    const layer = this.ensureFindLayer(match.pageNumber);
    if (!layer) return;
    const target = layer.querySelector<HTMLElement>(
      `.ofd-find-highlight[data-match-id="${match.id}"]`,
    );
    if (target) {
      scrollIntoViewCenter(target);
      return;
    }
    // 页视图可能刚切换可见；下一帧再试一次。
    scheduleFrame(() => {
      const retry = layer.querySelector<HTMLElement>(
        `.ofd-find-highlight[data-match-id="${match.id}"]`,
      );
      if (retry) scrollIntoViewCenter(retry);
    });
  }

  // -------------------------------------------------------------------------
  // 内部：文本层
  // -------------------------------------------------------------------------

  /** 合并多次状态变化，一帧内只刷新一次。 */
  private scheduleRefresh(): void {
    if (this.disposed || this.refreshQueued) return;
    this.refreshQueued = true;
    runMicrotask(() => {
      if (!this.refreshQueued) return;
      this.refresh();
    });
  }

  /** 计算需要文本层的可见页（1-based），含预取。 */
  private visiblePageNumbers(state: ViewerState): number[] {
    const count = this.host.getPageCount();
    if (count === 0) return [];
    const result = new Set<number>();
    const range = state.view.visiblePageRange;
    const start = Math.max(0, range.start - this.overscan);
    const end = Math.min(count - 1, range.end + this.overscan);
    for (let index = start; index <= end; index += 1) result.add(index + 1);
    const currentPage = state.view.pageNumber;
    if (currentPage >= 1 && currentPage <= count) result.add(currentPage);
    return [...result].sort((a, b) => a - b);
  }

  /** 异步加载单页文本内容并构建 span。 */
  private async loadPage(pageNumber: number, view: PageView): Promise<void> {
    let state = this.pages.get(pageNumber);
    if (!state) {
      state = { generation: 0, abort: null, built: false, failed: false, nodeCount: 0 };
      this.pages.set(pageNumber, state);
    }
    state.generation += 1;
    const generation = state.generation;
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;

    let content: TextContent;
    try {
      const page = await this.host.getPage(pageNumber);
      if (this.isStale(pageNumber, generation, abort)) return;
      if (typeof page.getTextContent !== 'function') {
        state.failed = true;
        this.bridge.warn(UI_WARNING_CODES.W_TEXT_UNSUPPORTED, '当前引擎页面不支持文本提取', pageNumber - 1);
        return;
      }
      content = await page.getTextContent(textContentOptions(abort.signal));
    } catch (error) {
      if (this.isStale(pageNumber, generation, abort) || isAbortError(error)) return;
      const current = this.pages.get(pageNumber);
      if (current) current.failed = true;
      this.bridge.warn(
        UI_WARNING_CODES.W_TEXT_LOAD,
        `第 ${pageNumber} 页文本提取失败：${error instanceof Error ? error.message : String(error)}`,
        pageNumber - 1,
      );
      return;
    }
    if (this.isStale(pageNumber, generation, abort)) return;
    if (!view.isDestroyed) this.renderPageText(pageNumber, view, content, generation);
  }

  /** 判断加载是否已过期。 */
  private isStale(pageNumber: number, generation: number, abort: AbortController): boolean {
    const state = this.pages.get(pageNumber);
    return (
      this.disposed ||
      abort.signal.aborted ||
      !state ||
      state.generation !== generation
    );
  }

  /** 把 span 写入页文本层。 */
  private renderPageText(
    pageNumber: number,
    view: PageView,
    content: TextContent,
    generation: number,
  ): void {
    const state = this.pages.get(pageNumber);
    if (!state || state.generation !== generation) return;
    const layer = view.textLayer;
    if (!layer) return;
    const doc = layer.ownerDocument;
    const specs = buildTextLayerSpecs(content, this.buildOptions());
    const selectable = this.host.isFeatureEnabled('selection');
    const fragment = doc.createDocumentFragment();
    for (const spec of specs.spans) {
      fragment.appendChild(createTextSpan(doc, spec, pageNumber, selectable));
    }
    replaceChildren(layer, fragment);
    this.applyTextLayerGeometry(layer, specs, pageNumber, view);
    state.built = true;
    state.nodeCount = specs.spans.length;
    state.abort = null;
    if (specs.truncated) {
      this.bridge.warn(
        UI_WARNING_CODES.W_TEXT_LAYER_LIMIT,
        `第 ${pageNumber} 页文字节点超过 ${this.maxNodes}，已合并或截断`,
        pageNumber - 1,
      );
    }
  }

  /**
   * 设置文本层布局框与缩放。
   *
   * span 坐标是 96 DPI 基准，图层布局框取“纸面尺寸 / 布局倍率”，再由
   * `--scale-factor` 放大，因此缩放时无需重算 span，且始终与 canvas 重合。
   */
  private applyTextLayerGeometry(
    layer: HTMLElement,
    specs: TextLayerSpecs,
    pageNumber: number,
    view: PageView,
  ): void {
    // 纸面尺寸由页布局决定（含旋转后的宽高交换）；未布局时用 96 DPI 页尺寸兜底。
    applyLayerScale(
      layer,
      this.surfaceWidthOf(pageNumber, view) || specs.width,
      this.surfaceHeightOf(pageNumber, view) || specs.height,
      view.layoutScale || 1,
    );
    layer.style.pointerEvents = '';
    layer.dataset.pageNumber = String(pageNumber);
    layer.dataset.dpi = String(specs.dpi);
    const selectable = this.host.isFeatureEnabled('selection');
    layer.dataset.selectable = selectable ? 'true' : 'false';
    layer.style.userSelect = selectable ? 'text' : 'none';
    layer.style.setProperty('-webkit-user-select', selectable ? 'text' : 'none');
  }

  /** 构建选项。 */
  private buildOptions(): BuildTextLayerOptions {
    return { maxNodes: this.maxNodes };
  }

  /** 清空单页文本层并放弃进行中的加载。 */
  private clearPageTextLayer(pageNumber: number): void {
    const state = this.pages.get(pageNumber);
    if (state) {
      state.generation += 1;
      state.abort?.abort();
      state.abort = null;
    }
    this.pages.delete(pageNumber);
    const view = this.host.getPageView(pageNumber);
    if (view?.textLayer) {
      replaceChildren(view.textLayer);
      view.textLayer.removeAttribute('data-dpi');
      view.textLayer.style.pointerEvents = 'none';
    }
  }

  /** 清空全部文本层。 */
  private clearAllTextLayers(): void {
    for (const pageNumber of [...this.pages.keys()]) this.clearPageTextLayer(pageNumber);
  }

  /** 应用功能状态：文本层可见性与 user-select。 */
  private applyFeatureStates(): void {
    const textLayerEnabled = this.host.isFeatureEnabled('textLayer');
    const selectionEnabled = this.host.isFeatureEnabled('selection');
    for (const view of this.host.getPageViews()) {
      if (view.isDestroyed || !view.textLayer) continue;
      view.setTextLayerVisible(textLayerEnabled);
      view.textLayer.dataset.selectable = selectionEnabled ? 'true' : 'false';
      view.textLayer.style.userSelect = selectionEnabled ? 'text' : 'none';
      view.textLayer.style.setProperty(
        '-webkit-user-select',
        selectionEnabled ? 'text' : 'none',
      );
      for (const span of view.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item, .ofd-text-char')) {
        span.style.userSelect = selectionEnabled ? 'text' : 'none';
        span.style.setProperty('-webkit-user-select', selectionEnabled ? 'text' : 'none');
      }
    }
  }

  /** 关闭文档后清理页状态、文本层 DOM 与高亮层。 */
  private resetPages(): void {
    this.clearAllTextLayers();
    for (const pageNumber of [...this.findLayers.keys()]) this.removeFindLayer(pageNumber);
    this.clearFindHighlights();
  }

  // -------------------------------------------------------------------------
  // 内部：查找高亮
  // -------------------------------------------------------------------------

  /** 按当前命中集合重绘可见页高亮。 */
  private renderFindHighlights(): void {
    if (this.disposed) return;
    const enabled = this.host.isFeatureEnabled('find');
    if (!enabled) {
      this.clearFindHighlights();
      return;
    }
    const state = this.host.getState();
    const visible = new Set(this.visiblePageNumbers(state));
    const currentMatch = this.current > 0 ? this.matches[this.current - 1] : undefined;
    if (currentMatch) visible.add(currentMatch.pageNumber);

    const rendered = new Set<number>();
    for (let index = 0; index < this.matches.length; index += 1) {
      const match = this.matches[index]!;
      if (!this.highlightAll && index + 1 !== this.current) continue;
      if (!visible.has(match.pageNumber)) continue;
      const view = this.host.getPageView(match.pageNumber);
      if (!view || view.isDestroyed) continue;
      let layer = this.findLayers.get(match.pageNumber);
      if (!layer || !layer.isConnected) {
        layer = this.createFindLayer(view);
        this.findLayers.set(match.pageNumber, layer);
      }
      if (!rendered.has(match.pageNumber)) {
        replaceChildren(layer);
        rendered.add(match.pageNumber);
      }
      const isCurrent = index + 1 === this.current;
      for (const box of match.boxes) {
        const element = layer.ownerDocument.createElement('div');
        element.className = 'ofd-find-highlight';
        element.dataset.matchId = match.id;
        if (isCurrent) element.dataset.current = 'true';
        element.style.left = `${box.x}px`;
        element.style.top = `${box.y}px`;
        element.style.width = `${box.width}px`;
        element.style.height = `${box.height}px`;
        layer.appendChild(element);
      }
    }
    for (const [pageNumber, layer] of [...this.findLayers]) {
      if (rendered.has(pageNumber)) continue;
      replaceChildren(layer);
      if (!visible.has(pageNumber)) this.removeFindLayer(pageNumber);
    }
  }

  /** 创建页查找高亮层；坐标与文本层一致（96 DPI 基准 + 显式倍率）。 */
  private createFindLayer(view: PageView): HTMLElement {
    const doc = view.element.ownerDocument;
    const layer = doc.createElement('div');
    layer.className = 'ofd-page__find-layer';
    this.syncFindLayerGeometry(layer, view);
    layer.style.pointerEvents = 'none';
    layer.style.overflow = 'visible';
    layer.style.zIndex = '3';
    view.surface.appendChild(layer);
    return layer;
  }

  /**
   * 按页视图当前布局刷新查找高亮层盒子；与文字层共用同一换算。
   *
   * @param layer 高亮层元素。
   * @param view 页视图。
   */
  private syncFindLayerGeometry(layer: HTMLElement, view: PageView): void {
    applyLayerScale(
      layer,
      this.surfaceWidthOf(view.pageNumber, view),
      this.surfaceHeightOf(view.pageNumber, view),
      view.layoutScale || 1,
    );
  }

  /** 获取或创建页查找高亮层；布局变化时按当前纸面尺寸重算盒子。 */
  private ensureFindLayer(pageNumber: number): HTMLElement | null {
    const existing = this.findLayers.get(pageNumber);
    const view = this.host.getPageView(pageNumber);
    if (existing?.isConnected) {
      if (view && !view.isDestroyed) this.syncFindLayerGeometry(existing, view);
      return existing;
    }
    if (!view || view.isDestroyed) return null;
    const layer = this.createFindLayer(view);
    this.findLayers.set(pageNumber, layer);
    return layer;
  }

  /** 移除页查找高亮层。 */
  private removeFindLayer(pageNumber: number): void {
    const layer = this.findLayers.get(pageNumber);
    layer?.remove();
    this.findLayers.delete(pageNumber);
  }
}

/** 安全滚动到元素中部；环境不支持时忽略。 */
function scrollIntoViewCenter(element: HTMLElement): void {
  if (typeof element.scrollIntoView !== 'function') return;
  try {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {
    // 某些旧内核不支持 options；忽略滚动失败，不影响阅读。
  }
}

/** 请求下一帧；无 rAF 时回退 setTimeout。 */
function scheduleFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
}

/** 判断是否取消错误。 */
function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'OFD_ABORTED';
}