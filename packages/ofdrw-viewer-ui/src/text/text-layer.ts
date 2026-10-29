/**
 * 透明文本层服务（页面缓存与文本层生命周期设计、选区高亮块状渲染设计）。
 *
 * 只给可见页（含上下各 1 页预取）构建文本层；canvas 负责视觉，DOM span 负责
 * 选择、复制、读屏与查找高亮。文本层坐标按 96 DPI 构建，页面容器的
 * `--scale-factor` 负责缩放，页面旋转由容器 CSS transform 承担。
 *
 * 构建粒度是“页”：页进入可见集合后一次性构建该页全部行，滚动期间不再增删 span；
 * 页级缓存由核心 `trimCache()` 统一淘汰，选区端点页在选区存续期间 pin 保留。
 * 该服务不调用任何 Canvas 文字 API，也不修改 canvas 绘制结果。
 */

import { replaceChildren } from '../compat';

import type { TextContent, TextQuad } from '@ofdrw/ofdrw-viewer-engine';
import type { EnginePage } from '../document-controller';
import type { PageView } from '../page-view';
import type { Rotation } from '../state';
import type { ViewerState } from '../state';
import type {
  PageRotation,
  PageSize,
  CharRef,
  ProjectedRect,
  RectLike,
  RowFlowRect,
  SelectionBox,
  TextRow,
  TextSpanSpec,
} from './geometry';
import {
  applyRowGap,
  buildTextLayerSpecs,
  buildTextRowsFromSpecs,
  cssScaleForDpi,
  FLOW_MERGE_EPSILON,
  isRectUnmeasurable,
  MAX_TEXT_LAYER_NODES,
  mergeFlowIntervals,
  mmToCssPx,
  projectQuad,
  rowIdOfRef,
  screenYOfPagePoint,
  SELECTION_ROW_GAP_PX,
  unprojectRect,
} from './geometry';
import { W_SELECTION_EVICTED, W_SELECTION_UNPINNABLE } from './selection';
import type {
  SelectionFragment,
  SelectionModel,
  SelectionSnapshot,
} from './selection';
import type { FindHighlightRenderer, FindMatch } from './types';
import type { TextViewerHost, ViewerBridge, ViewerTextLayerServiceLike } from './viewer-bridge';
import { textContentOptions } from './viewer-bridge';
import { UI_WARNING_CODES } from '../diagnostics';

/** 滚动停止后到允许构建首次访问页的延迟，单位毫秒。 */
const DEFAULT_SETTLE_MS = 150;

/** 桌面端选区 pin 的 span 上限。 */
const DEFAULT_DESKTOP_PIN_SPAN_BUDGET = 50_000;

/** 移动端选区 pin 的 span 上限。 */
const DEFAULT_MOBILE_PIN_SPAN_BUDGET = 20_000;

/** 分帧构建单帧时间预算，单位毫秒。 */
const BUILD_FRAME_BUDGET_MS = 8;

/** 分帧构建单帧 span 数量上限；与 8 ms 预算共同约束首帧长任务。 */
const BUILD_FRAME_SPAN_COUNT = 700;

/** 单页 span 超限告警码；诊断码表由后续诊断任务登记。 */
const W_TEXT_LAYER_CAP = 'W_TEXT_LAYER_CAP';

/** 选区矩形渲染失败后的 native 兜底告警码。 */
const W_SELECTION_RENDER = 'W_SELECTION_RENDER';

/** 滚动容器 overflow 判定为可滚动的取值。 */
const SCROLL_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay']);

/** 分帧构建任务；同一页同一时刻最多一个。 */
interface PageBuildTask {
  /** 构建代次；与页状态 generation 一致。 */
  readonly generation: number;
  /** 已挂入 DOM 的 span 数。 */
  spanCount: number;
  /** 下一行下标。 */
  rowIndex: number;
  /** 当前行内下一个 span 下标。 */
  spanIndex: number;
  /** 待执行的帧句柄；null 表示未排队。 */
  frame: number | null;
  /** 是否因节点上限降级/截断。 */
  readonly truncated: boolean;
}

/** 单页文本层状态；只记录数据与整页 DOM 状态。 */
interface PageTextState {
  /** 引擎文本内容（含行划分）；页缓存存活期间保留。 */
  content: TextContent | null;
  /** 行划分结果；null 表示尚未划分。 */
  rows: readonly TextRow[] | null;
  /** 行主轴方向，单位弧度；与 `rows` 同时就绪。 */
  axisRowRad: number;
  /** 是否已把整页全部行挂入 DOM。 */
  domBuilt: boolean;
  /** 当前文本层 span 数；分帧构建期间为已挂入数量。 */
  spanCount: number;
  /** 是否因节点上限降级/截断。 */
  truncated: boolean;
  /** 分帧构建任务；null 表示未在构建。 */
  build: PageBuildTask | null;
  /** 生成代次，用于丢弃迟到的异步结果。 */
  generation: number;
  /** 取消信号。 */
  abort: AbortController | null;
  /** 是否加载失败（页被淘汰后允许重试）。 */
  failed: boolean;
  /** 已取到但尚未允许抽取的引擎页句柄；settle 后继续。 */
  page: EnginePage | null;
  /** 是否正在抽取文本；避免刷新重入重复调用 getTextContent。 */
  extracting: boolean;
}

/** 文本层服务选项。 */
export interface TextLayerServiceOptions {
  /** 可见页上下额外预取页数；默认 1。 */
  readonly overscan?: number;
  /** 滚动停止后允许构建首次访问页的延迟，单位毫秒；默认 150。 */
  readonly settleMs?: number;
  /**
   * 选区端点页 pin 的 span 上限；超过时清空选区并告警。
   *
   * 默认桌面 50,000、移动端 20,000；显式传入时优先。
   */
  readonly selectionPinSpanBudget?: number;
  /**
   * 单页 span 上限；默认 {@link MAX_TEXT_LAYER_NODES}（10 万），0 表示不限。
   *
   * 超限时先降级为 item 级 span，仍超限则截断并告警。
   */
  readonly textLayerMaxSpans?: number;
  /**
   * 本服务即将改动选区所在页 DOM 前的回调；用于开启 selectionchange 抑制窗口。
   *
   * 只在淘汰页、整页重建等会移除 span 的操作前调用。
   */
  readonly onDomMutation?: () => void;
}

/** 滚动容器识别结果；`element` 为 null 时退化为窗口可视区。 */
interface ScrollViewport {
  /** 滚动容器；null 表示使用窗口可视区。 */
  readonly element: HTMLElement | null;
  /** 可视矩形，单位屏幕 px。 */
  readonly rect: RectLike;
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
 * @param pageNumber 页码，1-based；由文本层 `data-page-number` 统一承载，不逐 span 写。
 * @param selectable 是否允许选择；由文本层统一控制，不逐 span 写。
 * @param legacy 是否写 legacy 复制路径所需的 x/y/size/angle；独立调用默认保留。
 * @returns span 元素。
 */
export function createTextSpan(
  doc: Document,
  spec: TextSpanSpec,
  pageNumber: number,
  selectable: boolean,
  legacy = true,
): HTMLSpanElement {
  void pageNumber; // 页码由文本层 data-page-number 提供，不再逐 span 写。
  void selectable; // user-select 由文本层统一控制，span 不逐条写。
  const span = doc.createElement('span');
  span.className = spec.className;
  span.textContent = spec.text;
  // 不变样式已外提到 .ofd-text-item / .ofd-text-char；这里只提交几何。
  const css = [
    `left:${spec.left}px`,
    `top:${spec.top}px`,
    `width:${spec.width}px`,
    `height:${spec.height}px`,
    `font-size:${spec.fontSize}px`,
    `line-height:${spec.lineHeight}px`,
  ];
  if (!isIdentityTransform(spec.transform)) css.push(`transform:${spec.transform}`);
  span.style.cssText = css.join(';');
  // 查表主键必须逐 span 保留；页码由图层提供。
  span.dataset.itemIndex = String(spec.itemIndex);
  if (spec.charIndex !== undefined) span.dataset.charIndex = String(spec.charIndex);
  if (legacy) {
    // legacy 复制路径仍从 dataset 读取旧坐标；独立调用默认保留，文本层构建显式关闭。
    span.dataset.x = String(spec.left);
    span.dataset.y = String(spec.top);
    span.dataset.size = String(spec.fontSize);
    span.dataset.angle = String(spec.angle);
  } else if (spec.angle !== 0) {
    // 生产构建只保留旋转角这一项最小几何：部分 DOM 实现读不到内联 transform。
    span.dataset.angle = String(spec.angle);
  }
  return span;
}

/** 判断 CSS transform 是否为恒等变换；水平文字不写 transform。 */
function isIdentityTransform(transform: string): boolean {
  const value = transform.replace(/\s+/g, '');
  if (value === '' || value === 'rotate(0rad)' || value === 'rotate(0deg)') return true;
  const matrix = /^matrix\(([^)]*)\)$/.exec(value);
  if (!matrix) return false;
  const parts = matrix[1]!.split(',').map(Number);
  if (parts.length !== 6 || parts.some((part) => !Number.isFinite(part))) return false;
  return (
    Math.abs(parts[0]! - 1) < 1e-6 &&
    Math.abs(parts[1]!) < 1e-6 &&
    Math.abs(parts[2]!) < 1e-6 &&
    Math.abs(parts[3]! - 1) < 1e-6
  );
}

/**
 * 文本层与查找高亮服务。
 *
 * `OFDViewer` 通过 `attachTextLayerService` 挂载；同时作为 `FindController` 的
 * 高亮渲染器。
 */
export class TextLayerService implements FindHighlightRenderer, ViewerTextLayerServiceLike {
  /** 可见页额外预取页数。 */
  readonly overscan: number;

  private readonly host: TextViewerHost;
  private readonly bridge: ViewerBridge;
  private readonly pages = new Map<number, PageTextState>();
  private readonly findLayers = new Map<number, HTMLElement>();
  private readonly selectionLayers = new Map<number, HTMLElement>();
  private readonly cleanups: Array<() => void> = [];
  /** 最近一次选区快照/模型；页淘汰或布局变化后据此重绘。 */
  private lastSelectionModel: SelectionModel | SelectionSnapshot | null = null;
  private matches: readonly FindMatch[] = [];
  private current = 0;
  private highlightAll = true;
  private refreshQueued = false;
  private disposed = false;
  /** 滚动停止后的构建延迟，单位毫秒。 */
  private readonly settleMs: number;
  /** 选区端点页 pin 的 span 上限。 */
  private readonly selectionPinSpanBudget: number;
  /** 单页 span 上限；0 表示不限。 */
  private readonly maxSpans: number;
  /** DOM 变更前的选区抑制回调。 */
  private readonly onDomMutation: (() => void) | null;
  /** 当前 pin 的端点页（1-based）。 */
  private pinnedPages = new Set<number>();
  /** 当前 pin 页持有的 span 数。 */
  private pinnedSpans = 0;
  /** 最近一次滚动时间（performance.now 口径），单位毫秒。 */
  private lastScrollAt = Number.NEGATIVE_INFINITY;
  /** 停止滚动后统一刷新的定时器。 */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一帧观察到的滚动位置，用于区分滚动与其它状态变化。 */
  private lastScrollTop = Number.NaN;
  /** 上一次布局倍率。 */
  private lastScale = Number.NaN;
  /** 上一次旋转角度。 */
  private lastRotation = -1;
  /** 上一次可见页范围与当前页，用于识别跳页。 */
  private lastVisibleKey = '';

  /**
   * @param host 阅读器能力集合。
   * @param bridge 核心状态/事件桥。
   * @param options 服务选项（预取页数、settle 延迟、pin 预算）。
   */
  constructor(
    host: TextViewerHost,
    bridge: ViewerBridge,
    options: TextLayerServiceOptions = {},
  ) {
    this.host = host;
    this.bridge = bridge;
    this.overscan = Math.max(0, options.overscan ?? 1);
    this.settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
    this.selectionPinSpanBudget = Math.max(
      0,
      options.selectionPinSpanBudget ?? defaultPinSpanBudget(),
    );
    this.maxSpans = Math.max(0, options.textLayerMaxSpans ?? MAX_TEXT_LAYER_NODES);
    this.onDomMutation = options.onDomMutation ?? null;
    const view = host.getState().view;
    this.lastScrollTop = view.scrollTop;
    this.lastScale = view.scale;
    this.lastRotation = view.rotation;
    this.lastVisibleKey = `${view.visiblePageRange.start}:${view.visiblePageRange.end}:${view.pageNumber}`;
    this.cleanups.push(
      host.on('statechange', () => this.handleStateChange()),
      host.on('documentopen', () => {
        this.cancelSettle();
        this.resetPages();
        this.refresh();
      }),
      host.on('documentclose', () => {
        this.cancelSettle();
        this.resetPages();
      }),
      host.on('pagesloaded', () => {
        this.cancelSettle();
        this.refresh();
      }),
      host.on('featureschange', () => {
        this.cancelSettle();
        this.applyFeatureStates();
        this.refresh();
      }),
    );
    this.refresh();
  }

  /**
   * 处理状态变化：布局变化立即刷新；滚动/可见页变化延迟到停止 150ms 后刷新。
   *
   * 选区文本、查找状态等非滚动状态变化不触发文本层重建。
   */
  private handleStateChange(): void {
    if (this.disposed) return;
    const view = this.host.getState().view;
    const previousScrollTop = this.lastScrollTop;
    const scrollChanged =
      Number.isFinite(previousScrollTop) && Math.abs(view.scrollTop - previousScrollTop) >= 0.5;
    const layoutChanged =
      view.scale !== this.lastScale || view.rotation !== this.lastRotation;
    const visibleKey = `${view.visiblePageRange.start}:${view.visiblePageRange.end}:${view.pageNumber}`;
    const visibleChanged = visibleKey !== this.lastVisibleKey;
    this.lastScrollTop = view.scrollTop;
    this.lastScale = view.scale;
    this.lastRotation = view.rotation;
    this.lastVisibleKey = visibleKey;
    if (layoutChanged) {
      this.cancelSettle();
      this.refresh();
      return;
    }
    if (scrollChanged || visibleChanged) {
      this.lastScrollAt = nowMs();
      this.scheduleSettleRefresh();
    }
  }

  /** 安排停止滚动后的统一刷新；重复滚动会重置计时。 */
  private scheduleSettleRefresh(): void {
    if (this.disposed) return;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      // 定时器可能比 150ms 略早触发；显式标记“已停止滚动”再刷新。
      this.lastScrollAt = Number.NEGATIVE_INFINITY;
      this.refresh();
    }, this.settleMs);
  }

  /** 取消待执行的 settle 刷新。 */
  private cancelSettle(): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  /** 当前是否已停止滚动足够久，可以构建首次访问页。 */
  private canBuildNow(): boolean {
    return nowMs() - this.lastScrollAt >= this.settleMs;
  }

  /** 立即按当前可见页刷新文本层（服务接口）。 */
  refresh(): void {
    const textLayerEnabled = this.host.isFeatureEnabled('textLayer');
    if (!textLayerEnabled) {
      // 关闭功能时取消排队中的刷新，避免重新开启后仍停留在旧状态。
      this.refreshQueued = false;
      this.cancelSettle();
      if (this.disposed) return;
      this.clearAllTextLayers();
      this.clearAllSelectionLayers();
      this.lastSelectionModel = null;
      this.setPinnedPages([]);
      return;
    }
    this.refreshQueued = false;
    if (this.disposed) return;
    const state = this.host.getState();
    if (state.document.status !== 'ready' || this.host.getPageCount() === 0) return;
    const visible = this.visiblePageNumbers(state);
    const visibleSet = new Set(visible);
    // 失败页没有可保留产物；离开可见集后释放，允许下次进入时重试。
    for (const [pageNumber, pageState] of [...this.pages]) {
      if (!visibleSet.has(pageNumber) && pageState.failed) this.clearPageTextLayer(pageNumber);
    }
    for (const pageNumber of visible) {
      const view = this.host.getPageView(pageNumber);
      if (!view || view.isDestroyed) continue;
      const pageState = this.pages.get(pageNumber);
      if (!pageState) {
        void this.loadPage(pageNumber, view);
        continue;
      }
      if (pageState.failed) {
        this.syncPageTextLayerGeometry(pageNumber, view);
        continue;
      }
      if (!pageState.rows) {
        if (!pageState.content && pageState.page) {
          // getPage 已返回但滚动未停止：settle 后从保存的页句柄继续抽取。
          if (this.canBuildNow()) {
            void this.extractPageText(
              pageNumber,
              view,
              pageState,
              pageState.generation,
              pageState.page,
            );
          } else {
            this.scheduleSettleRefresh();
          }
          this.syncPageTextLayerGeometry(pageNumber, view);
          continue;
        }
        if (pageState.content && this.canBuildNow()) {
          this.renderPageText(pageNumber, view, pageState.content, pageState.generation);
          continue;
        }
        // 文本仍在加载：保留进行中的请求，避免重复提取。
        this.syncPageTextLayerGeometry(pageNumber, view);
        continue;
      }
      if (pageState.build) {
        // 分帧构建中：不重入、不删除已挂 span，只同步布局框。
        this.syncPageTextLayerGeometry(pageNumber, view);
        continue;
      }
      if (pageState.domBuilt) {
        // 整页已建满：滚动期间不遍历行、不做 DOM 变更，只同步布局框。
        this.syncPageTextLayerGeometry(pageNumber, view);
        continue;
      }
      if (!this.canBuildNow()) {
        this.scheduleSettleRefresh();
        continue;
      }
      this.buildPageTextLayer(pageNumber, view, pageState);
    }
    this.renderFindHighlights();
    this.syncSelectionLayers();
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
      this.cancelPageBuild(state);
      state.generation += 1;
      state.abort?.abort();
    }
    this.pages.clear();
    this.clearAllTextLayers();
    this.clearFindHighlights();
    for (const pageNumber of this.findLayers.keys()) this.removeFindLayer(pageNumber);
    this.clearAllSelectionLayers();
    this.setNativeSelectionMode(false);
    this.lastSelectionModel = null;
    this.pinnedPages.clear();
    this.pinnedSpans = 0;
  }

  // -------------------------------------------------------------------------
  // 字符几何查询（供选区模型消费）
  // -------------------------------------------------------------------------

  /**
   * 返回指定字符在 96 DPI 文本层坐标系中的四边形。
   *
   * 数据取自页缓存的 `TextContent.items[].chars[]`，按 `cssScaleForDpi()` 从引擎输出
   * DPI 换算到文本层坐标；字符级 span 与 item 级 span 共用同一口径。
   *
   * @param pageNumber 页码，1-based。
   * @param refs 字符引用。
   * @returns 与 `refs` 等长的四边形数组；页文本未就绪、`chars` 缺失或下标越界时为 null。
   */
  getCharQuads(pageNumber: number, refs: readonly CharRef[]): (TextQuad | null)[] {
    const content = this.pages.get(pageNumber)?.content;
    const items = content?.items;
    if (!content || !items) return refs.map(() => null);
    const k = cssScaleForDpi(content.dpi);
    return refs.map((ref) => {
      const item = items[ref.itemIndex];
      const char = item?.chars?.[ref.charIndex];
      if (!char) return null;
      return char.quad.map((point) => ({ x: point.x * k, y: point.y * k })) as unknown as TextQuad;
    });
  }

  /**
   * 返回指定字符所属行的稳定标识。
   *
   * @param pageNumber 页码，1-based。
   * @param ref 字符引用。
   * @returns 行标识；页文本未就绪或找不到所属行时返回 null。
   */
  getRowIdOf(pageNumber: number, ref: CharRef): string | null {
    const rows = this.pages.get(pageNumber)?.rows;
    if (!rows) return null;
    return rowIdOfRef(rows, ref);
  }

  /**
   * 返回指定页的行主轴方向。
   *
   * @param pageNumber 页码，1-based。
   * @returns 主轴方向，单位弧度；页文本未就绪时返回 null。
   */
  getAxisRowRad(pageNumber: number): number | null {
    const state = this.pages.get(pageNumber);
    return state?.rows ? state.axisRowRad : null;
  }

  // -------------------------------------------------------------------------
  // 选区块状高亮渲染
  // -------------------------------------------------------------------------

  /**
   * 按统一选区模型重绘块状选区层。
   *
   * 字符四边形按行主轴投影：同一 rowId 内 flow 方向取并集，行间留
   * {@link SELECTION_ROW_GAP_PX} 缝隙后反变换回 96 DPI 页面坐标。模型缓存下来，
   * 页重建或布局变化后无需重新抽取即可重绘。`legacy` 模式不画块，恢复浏览器
   * 原生高亮。
   *
   * @param model 统一选区模型或完整快照；空片段表示清空。
   */
  renderSelection(model: SelectionModel | SelectionSnapshot): void {
    // 端点页 pin 是选区存续的唯一保留机制；中间页允许被 LRU 淘汰。
    if (this.setPinnedPages(endpointPagesOfModel(model)) === false) {
      // 预算拒绝时连旧 pin 一起释放，避免留下与当前选区不一致的 pin。
      this.setPinnedPages([]);
      this.lastSelectionModel = null;
      this.clearAllSelectionLayers();
      return;
    }
    this.lastSelectionModel = model;
    this.renderSelectionFromModel();
  }

  /**
   * 用缓存的选区模型/快照重绘全部页。
   *
   * 快照带 `rectsByPage` 时直接绘制预合并矩形，页被淘汰、span 不存在也能画；
   * 普通模型则回退到片段 quad 合并。两者都不再按 `state.domBuilt` 过滤。
   */
  private renderSelectionFromModel(): void {
    if (this.disposed) return;
    const model = this.lastSelectionModel;
    if (!model || model.mode === 'legacy') {
      this.clearAllSelectionLayers();
      this.setNativeSelectionMode(model?.mode === 'legacy');
      return;
    }
    this.setNativeSelectionMode(false);
    if (!this.host.isFeatureEnabled('textLayer') || !this.host.isFeatureEnabled('selection')) {
      this.clearAllSelectionLayers();
      return;
    }
    try {
      const snapshot = isSelectionSnapshot(model) ? model : null;
      const fragmentsByPage = new Map<number, SelectionFragment[]>();
      for (const fragment of model.fragments) {
        const fragments = fragmentsByPage.get(fragment.pageNumber);
        if (fragments) fragments.push(fragment);
        else fragmentsByPage.set(fragment.pageNumber, [fragment]);
      }
      const rendered = new Set<number>();
      const pageNumbers = snapshot?.pageNumbers ?? [...fragmentsByPage.keys()];
      for (const pageNumber of pageNumbers) {
        const view = this.host.getPageView(pageNumber);
        if (!view || view.isDestroyed) continue;
        const boxes = snapshot?.rectsByPage.get(pageNumber);
        if (boxes) {
          if (boxes.length === 0) continue;
          this.renderSelectionBoxes(pageNumber, boxes);
          rendered.add(pageNumber);
          continue;
        }
        const fragments = fragmentsByPage.get(pageNumber) ?? [];
        // 页可能已被缓存淘汰；只要片段 quad 仍在快照里就按页坐标绘制。
        const drawable = fragments.filter((fragment) => fragment.rowId !== null);
        if (drawable.length === 0) continue;
        this.renderSelectionRects(pageNumber, drawable);
        rendered.add(pageNumber);
      }
      for (const pageNumber of [...this.selectionLayers.keys()]) {
        if (!rendered.has(pageNumber)) this.removeSelectionLayer(pageNumber);
      }
    } catch (error) {
      // 不静默吞掉异常：清理块状层、恢复原生高亮并上报原因。
      this.clearAllSelectionLayers();
      this.setNativeSelectionMode(true);
      this.bridge.warn(
        W_SELECTION_RENDER,
        `选区矩形渲染失败，已回退原生高亮：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  /**
   * 把选区矩形写入指定页的选区层。
   *
   * @param pageNumber 页码，1-based。
   * @param fragments 该页的选区片段。
   */
  private renderSelectionRects(
    pageNumber: number,
    fragments: readonly SelectionFragment[],
  ): void {
    const axisRowRad = fragments[0]?.axisRowRad ?? 0;
    const boxes = selectionRectsOfFragments(fragments, axisRowRad).map((rect) =>
      unprojectRect(rect, axisRowRad),
    );
    this.renderSelectionBoxes(pageNumber, boxes);
  }

  /**
   * 把页坐标中的选区矩形写入指定页的选区层。
   *
   * @param pageNumber 页码，1-based。
   * @param boxes 已合并、留缝的页坐标矩形。
   */
  private renderSelectionBoxes(
    pageNumber: number,
    boxes: readonly SelectionBox[],
  ): void {
    const layer = this.ensureSelectionLayer(pageNumber);
    if (!layer) return;
    const doc = layer.ownerDocument;
    const content = doc.createDocumentFragment();
    for (const box of boxes) {
      const element = doc.createElement('div');
      element.className = 'ofd-selection-rect';
      element.style.left = `${box.left}px`;
      element.style.top = `${box.top}px`;
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
      if (box.rotationRad !== 0) {
        element.style.transform = `rotate(${box.rotationRad}rad)`;
        element.style.transformOrigin = '50% 50%';
      }
      content.appendChild(element);
    }
    replaceChildren(layer, content);
  }

  /** 取得（必要时懒创建）页选区层。 */
  private ensureSelectionLayer(pageNumber: number): HTMLElement | null {
    const existing = this.selectionLayers.get(pageNumber);
    const view = this.host.getPageView(pageNumber);
    if (existing?.isConnected) {
      if (view && !view.isDestroyed) this.syncSelectionLayerGeometry(existing, view);
      return existing;
    }
    if (!view || view.isDestroyed) return null;
    const layer = this.createSelectionLayer(view);
    this.selectionLayers.set(pageNumber, layer);
    return layer;
  }

  /** 在文字层之上、查找/签章层之前创建选区层。 */
  private createSelectionLayer(view: PageView): HTMLElement {
    const doc = view.element.ownerDocument;
    const layer = doc.createElement('div');
    layer.className = 'ofd-page__selection-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.pointerEvents = 'none';
    layer.style.overflow = 'visible';
    layer.style.zIndex = '2';
    this.syncSelectionLayerGeometry(layer, view);
    view.surface.insertBefore(layer, view.textLayer.nextSibling);
    return layer;
  }

  /** 应用与文本层一致的布局框与缩放。 */
  private syncSelectionLayerGeometry(layer: HTMLElement, view: PageView): void {
    applyLayerScale(
      layer,
      this.surfaceWidthOf(view.pageNumber, view),
      this.surfaceHeightOf(view.pageNumber, view),
      view.layoutScale || 1,
    );
  }

  /** 布局变化后同步所有选区层的布局框；页视图已销毁的层移除。 */
  private syncSelectionLayers(): void {
    for (const [pageNumber, layer] of [...this.selectionLayers]) {
      const view = this.host.getPageView(pageNumber);
      if (view && !view.isDestroyed) this.syncSelectionLayerGeometry(layer, view);
      else this.removeSelectionLayer(pageNumber);
    }
  }

  /** 移除单页选区层。 */
  private removeSelectionLayer(pageNumber: number): void {
    const layer = this.selectionLayers.get(pageNumber);
    layer?.remove();
    this.selectionLayers.delete(pageNumber);
  }

  /** 清空全部选区层（不改写原生高亮模式）。 */
  private clearAllSelectionLayers(): void {
    for (const pageNumber of [...this.selectionLayers.keys()]) this.removeSelectionLayer(pageNumber);
  }

  /**
   * 切换浏览器原生选区样式模式。
   *
   * @param native 是否回退原生高亮；false 时移除标记，恢复“原生选区透明 + 块状高亮”。
   */
  private setNativeSelectionMode(native: boolean): void {
    for (const view of this.host.getPageViews()) {
      if (view.isDestroyed) continue;
      if (native) view.element.dataset.selectionMode = 'native';
      else view.element.removeAttribute('data-selection-mode');
    }
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
   * 定位基于命中框的 96 DPI 页坐标换算为页面元素内的屏幕位置，再滚动滚动容器；
   * 不依赖目标 span 是否已构建（目标页可能尚未进入文本层缓存）。
   *
   * @param match 命中项。
   */
  scrollToMatch(match: FindMatch): void {
    if (this.disposed) return;
    this.host.goToPage(match.pageNumber, { smooth: false });
    this.renderFindHighlights();
    this.scrollToMatchBox(match);
  }

  /**
   * 在跳页后把命中框中心滚到可视区中部；页视图尚未就绪时下一帧重试一次。
   *
   * @param match 命中项。
   * @param retried 是否已重试；避免无限重试。
   */
  private scrollToMatchBox(match: FindMatch, retried = false): void {
    if (this.disposed) return;
    const view = this.host.getPageView(match.pageNumber);
    if (view && !view.isDestroyed) {
      const measuredPageRect = view.element.getBoundingClientRect();
      const targetY = this.screenYOfMatch(match, view);
      const viewport = this.scrollViewport();
      if (Number.isFinite(targetY) && !isRectUnmeasurable(viewport.rect) && !isRectUnmeasurable(measuredPageRect)) {
        const delta = targetY - (viewport.rect.top + viewport.rect.height / 2);
        if (Math.abs(delta) >= 1) {
          const element = viewport.element;
          if (element) element.scrollTop += delta;
          else if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
            window.scrollBy(0, delta);
          }
        }
        return;
      }
    }
    // 页视图未就绪、不可测量：复用高亮层的 scrollIntoView（下一帧重试一次）。
    const layer = this.ensureFindLayer(match.pageNumber);
    if (!layer) return;
    const target = layer.querySelector<HTMLElement>(
      `.ofd-find-highlight[data-match-id="${match.id}"]`,
    );
    if (target) {
      scrollIntoViewCenter(target);
      return;
    }
    if (retried) return;
    scheduleFrame(() => this.scrollToMatchBox(match, true));
  }

  /**
   * 命中框在屏幕上的纵坐标（页内滚动定位用）。
   *
   * 页矩形优先用真实 `getBoundingClientRect()`（与滚动容器同源）；页不可测量时
   * 退化为按主区布局位置与偏移换算。
   *
   * @param match 命中项。
   * @param view 页视图。
   * @returns 屏幕纵坐标，单位 px；无法换算时返回 NaN。
   */
  private screenYOfMatch(match: FindMatch, view: PageView): number {
    const box = boundingCenterOf(match);
    if (!box) return Number.NaN;
    const page = this.pageSizeOf(match.pageNumber, view, null);
    const rotation = this.pageRotationOf(view);
    const measured = view.element.getBoundingClientRect();
    if (!isRectUnmeasurable(measured)) {
      return screenYOfPagePoint(measured, box.x, box.y, page, rotation);
    }
    // 页不可测量：页包围盒按“96 DPI 页尺寸 × 布局倍率”，原点取滚动容器内容区内的布局位置。
    // 旋转 90°/270° 时包围盒宽高互换。
    const scale = view.layoutScale > 0 ? view.layoutScale : 1;
    const quarter = rotation === 90 || rotation === 270;
    const viewport = this.scrollViewport();
    const fallback = {
      left: 0,
      top: view.element.offsetTop - scrollTopOf(viewport.element),
      width: (quarter ? page.height : page.width) * scale,
      height: (quarter ? page.width : page.height) * scale,
    };
    const y = screenYOfPagePoint(fallback, box.x, box.y, page, rotation);
    return Number.isFinite(y) ? y + viewport.rect.top : y;
  }

  // -------------------------------------------------------------------------
  // 内部：文本层
  // -------------------------------------------------------------------------

  /** 合并多次状态变化，一帧内只刷新一次。 */
  private scheduleRefresh(): void {
    if (this.disposed || this.refreshQueued) return;
    this.refreshQueued = true;
    scheduleFrame(() => {
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

  /** 异步取页并抽取文本；滚动未停止时保存页句柄，等 settle 后再抽取。 */
  private async loadPage(pageNumber: number, view: PageView): Promise<void> {
    const state = this.pages.get(pageNumber) ?? this.createPageState();
    this.pages.set(pageNumber, state);
    this.cancelPageBuild(state);
    state.generation += 1;
    const generation = state.generation;
    const abort = new AbortController();
    state.abort = abort;

    let page: EnginePage;
    try {
      page = await this.host.getPage(pageNumber);
    } catch (error) {
      if (this.isStale(pageNumber, generation, abort) || isAbortError(error)) return;
      this.failPage(pageNumber, error);
      return;
    }
    if (this.isStale(pageNumber, generation, abort)) return;
    state.page = page;
    if (!this.canBuildNow()) {
      // 滚动尚未停止：先保存页句柄，避免 getPage 迟到后把 100ms 级抽取算进滚动帧。
      this.scheduleSettleRefresh();
      return;
    }
    await this.extractPageText(pageNumber, view, state, generation, page);
  }

  /**
   * 抽取一页文本，并在抽取前后复检滚动状态。
   *
   * 抽取前未停止滚动则保留页句柄等待 settle；抽取后未停止滚动则先缓存内容，
   * 等 settle 后只做行划分与 DOM 构建，避免重复抽取。
   *
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   * @param state 页文字层状态。
   * @param generation 当前构建代次。
   * @param page 已取得的引擎页句柄。
   */
  private async extractPageText(
    pageNumber: number,
    view: PageView,
    state: PageTextState,
    generation: number,
    page: EnginePage,
  ): Promise<void> {
    const abort = state.abort;
    if (!abort || state.extracting || state.failed) return;
    state.extracting = true;
    try {
      if (!this.canBuildNow()) {
        this.scheduleSettleRefresh();
        return;
      }
      if (typeof page.getTextContent !== 'function') {
        state.page = null;
        state.failed = true;
        this.bridge.warn(
          UI_WARNING_CODES.W_TEXT_UNSUPPORTED,
          '当前引擎页面不支持文本提取',
          pageNumber - 1,
        );
        return;
      }
      const content = await page.getTextContent(textContentOptions(abort.signal));
      if (this.isStale(pageNumber, generation, abort)) return;
      state.page = null;
      state.abort = null;
      if (view.isDestroyed) return;
      if (this.canBuildNow()) {
        this.renderPageText(pageNumber, view, content, generation);
      } else {
        // 滚动未停止：先缓存内容，等 settle 后只做行划分与 DOM 构建，避免重复抽取。
        state.content = content;
        this.scheduleSettleRefresh();
      }
    } catch (error) {
      if (this.isStale(pageNumber, generation, abort) || isAbortError(error)) return;
      state.page = null;
      this.failPage(pageNumber, error);
    } finally {
      state.extracting = false;
    }
  }

  /**
   * 标记页文本加载失败并告警；页离开可见集后允许重试。
   *
   * @param pageNumber 页码，1-based。
   * @param error 失败原因。
   */
  private failPage(pageNumber: number, error: unknown): void {
    const current = this.pages.get(pageNumber);
    if (current) current.failed = true;
    this.bridge.warn(
      UI_WARNING_CODES.W_TEXT_LOAD,
      `第 ${pageNumber} 页文本提取失败：${error instanceof Error ? error.message : String(error)}`,
      pageNumber - 1,
    );
  }

  /** 创建空的页文字层状态。 */
  private createPageState(): PageTextState {
    return {
      content: null,
      rows: null,
      axisRowRad: 0,
      domBuilt: false,
      spanCount: 0,
      truncated: false,
      build: null,
      generation: 0,
      abort: null,
      failed: false,
      page: null,
      extracting: false,
    };
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

  /**
   * 划分文字行并一次性构建整页文本层。
   *
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   * @param content 引擎文本内容。
   * @param generation 请求代次。
   */
  private renderPageText(
    pageNumber: number,
    view: PageView,
    content: TextContent,
    generation: number,
  ): void {
    const state = this.pages.get(pageNumber);
    if (!state || state.generation !== generation) return;
    this.cancelPageBuild(state);
    const specs = buildTextLayerSpecs(content, { maxNodes: this.maxSpans });
    const layout = buildTextRowsFromSpecs(specs, content);
    state.content = content;
    state.rows = layout.rows;
    state.axisRowRad = layout.axisRowRad;
    state.truncated = layout.truncated;
    this.buildPageTextLayer(pageNumber, view, state);
  }

  /**
   * 启动整页分帧构建；已建页或构建中的页直接返回。
   *
   * 每帧只向文本层追加新 span，不删除已有节点；因此构建过程中已挂出的文字可以
   * 被用户选中，后续帧不会破坏选区锚点。
   *
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   * @param state 页文字层状态。
   */
  private buildPageTextLayer(pageNumber: number, view: PageView, state: PageTextState): void {
    if (state.domBuilt || !state.rows || state.build) return;
    const layer = view.textLayer;
    if (!layer) return;
    this.onDomMutation?.();
    replaceChildren(layer);
    state.spanCount = 0;
    state.domBuilt = false;
    this.applyTextLayerGeometry(layer, pageNumber, view, state.content?.dpi ?? 96);
    state.build = {
      generation: state.generation,
      spanCount: 0,
      rowIndex: 0,
      spanIndex: 0,
      frame: null,
      truncated: state.truncated,
    };
    this.pumpPageBuild(pageNumber, view, state);
  }

  /**
   * 按 8 ms / 700 span 预算推进一帧；未完成时通过 rAF 续帧。
   *
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   * @param state 页文字层状态。
   */
  private pumpPageBuild(pageNumber: number, view: PageView, state: PageTextState): void {
    const task = state.build;
    const rows = state.rows;
    const layer = view.textLayer;
    if (!task || !rows || !layer || !this.isBuildCurrent(pageNumber, state, task)) {
      this.cancelPageBuild(state);
      return;
    }
    const doc = layer.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const startedAt = nowMs();
    const legacy = needsLegacyData(state.content);
    let appended = 0;
    let exhausted = false;
    while (task.rowIndex < rows.length) {
      const row = rows[task.rowIndex]!;
      while (task.spanIndex < row.spans.length) {
        const spec = row.spans[task.spanIndex]!;
        fragment.appendChild(createTextSpan(doc, spec, pageNumber, true, legacy));
        task.spanCount += 1;
        task.spanIndex += 1;
        appended += 1;
        if (appended >= BUILD_FRAME_SPAN_COUNT || nowMs() - startedAt >= BUILD_FRAME_BUDGET_MS) {
          exhausted = true;
          break;
        }
      }
      if (exhausted) break;
      task.rowIndex += 1;
      task.spanIndex = 0;
    }
    if (appended > 0) layer.appendChild(fragment);
    state.spanCount = task.spanCount;
    if (this.pinnedPages.has(pageNumber)) this.refreshPinnedSpanCount();
    if (task.rowIndex < rows.length) {
      task.frame = requestFrame(() => {
        task.frame = null;
        this.pumpPageBuild(pageNumber, view, state);
      });
      return;
    }
    this.finishPageBuild(pageNumber, view, state, task);
  }

  /**
   * 完成分帧构建：标记整页可用、补布局与告警，并补绘缓存选区。
   *
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   * @param state 页文字层状态。
   * @param task 已完成的任务。
   */
  private finishPageBuild(
    pageNumber: number,
    view: PageView,
    state: PageTextState,
    task: PageBuildTask,
  ): void {
    state.build = null;
    state.domBuilt = true;
    state.spanCount = task.spanCount;
    const layer = view.textLayer;
    if (layer) this.applyTextLayerGeometry(layer, pageNumber, view, state.content?.dpi ?? 96);
    if (this.pinnedPages.has(pageNumber)) this.refreshPinnedSpanCount();
    if (task.truncated) {
      this.bridge.warn(
        W_TEXT_LAYER_CAP,
        `第 ${pageNumber} 页文字节点超过 ${this.maxSpans}，已降级或截断`,
        pageNumber - 1,
      );
    }
    this.host.textLayerPageBuilt?.(pageNumber);
    this.host.textLayerPinsChanged?.();
    // 页可能从 LRU 淘汰后重建；缓存模型仍有效时把该页高亮补回来。
    if (this.lastSelectionModel) this.renderSelectionFromModel();
  }

  /** 判断分帧任务是否仍属于当前页与当前代次。 */
  private isBuildCurrent(pageNumber: number, state: PageTextState, task: PageBuildTask): boolean {
    return (
      !this.disposed &&
      this.pages.get(pageNumber) === state &&
      state.build === task &&
      state.generation === task.generation &&
      !!state.rows
    );
  }

  /** 取消未完成的分帧任务并清除排队中的 rAF。 */
  private cancelPageBuild(state: PageTextState | undefined): void {
    if (!state?.build) return;
    if (state.build.frame !== null) cancelFrame(state.build.frame);
    state.build.frame = null;
    state.build = null;
  }

  /**
   * 设置文本层布局框与缩放。
   *
   * span 坐标是 96 DPI 基准，图层布局框取“纸面尺寸 / 布局倍率”，再由
   * `--scale-factor` 放大，因此缩放时无需重算 span，且始终与 canvas 重合。
   *
   * @param layer 文字层元素。
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   * @param dpi span 对应的原始 DPI。
   */
  private applyTextLayerGeometry(
    layer: HTMLElement,
    pageNumber: number,
    view: PageView,
    dpi: number,
  ): void {
    applyLayerScale(
      layer,
      this.surfaceWidthOf(pageNumber, view),
      this.surfaceHeightOf(pageNumber, view),
      view.layoutScale > 0 ? view.layoutScale : 1,
    );
    layer.style.pointerEvents = '';
    layer.dataset.pageNumber = String(pageNumber);
    layer.dataset.dpi = String(dpi);
    const selectable = this.host.isFeatureEnabled('selection');
    layer.dataset.selectable = selectable ? 'true' : 'false';
    layer.style.userSelect = selectable ? 'text' : 'none';
    layer.style.setProperty('-webkit-user-select', selectable ? 'text' : 'none');
  }

  /**
   * 读取滚动容器与可视矩形。
   *
   * 从页元素向上找第一个可滚动且 `overflowX/overflowY` 可滚动的祖先；找不到时退化为
   * 窗口可视区。页面遮挡滚动容器（`transform` 使页视口落在滚动容器之外）时同样退化，
   * 否则以滚动容器覆盖的页范围作为视野。不可测量时返回 0 尺寸矩形，由调用方退化为整页。
   *
   * @returns 滚动容器与可视矩形，单位屏幕 px。
   */
  private scrollViewport(): ScrollViewport {
    const fallback = windowViewportRect();
    // 优先按当前页定位滚动容器；当前页被销毁时退化为任一页视图。
    const views = this.host.getPageViews();
    const current = this.host.getPageView(this.host.getState().view.pageNumber) ?? views[0];
    const anchor = current && !current.isDestroyed ? current.element : null;
    if (!anchor) return { element: null, rect: fallback };
    const element = scrollableAncestorOf(anchor);
    if (!element) return { element: null, rect: fallback };
    if (element.clientWidth <= 0 || element.clientHeight <= 0) return { element, rect: fallback };
    return { element, rect: elementViewportRect(element) };
  }

  /**
   * 页在 96 DPI 坐标系中的未旋转尺寸。
   *
   * @param pageNumber 页码，1-based。
   * @param view 页视图。
   * @returns 页宽高，单位 px。
   */
  private pageSizeOf(pageNumber: number, view: PageView, content?: TextContent | null): PageSize {
    const rotation = this.pageRotationOf(view);
    const quarter = rotation === 90 || rotation === 270;
    let surfaceWidth = this.surfaceWidthOf(pageNumber, view);
    let surfaceHeight = this.surfaceHeightOf(pageNumber, view);
    if (content && content.pageWidth > 0 && content.pageHeight > 0) {
      // 页布局尚未提交时纸面尺寸为 0（会按 A4 兜底），以文本内容的 96 DPI 页尺寸为准。
      const k = view.layoutScale > 0 ? view.layoutScale : 1;
      surfaceWidth = content.pageWidth * k;
      surfaceHeight = content.pageHeight * k;
    }
    return quarter
      ? { width: surfaceHeight, height: surfaceWidth }
      : { width: surfaceWidth, height: surfaceHeight };
  }

  /**
   * 读取页面容器的旋转角度；非 90 的整数倍时按 0 处理。
   *
   * @param view 页视图。
   * @returns 页旋转角度。
   */
  private pageRotationOf(view: PageView): PageRotation {
    const rotation: Rotation = this.host.getState().view.rotation;
    return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
  }

  /**
   * 释放单页文本层、页数据与查找高亮层；核心页缓存淘汰时调用。
   *
   * 若最后选区模型/快照覆盖该页，选区层与矩形保留，复制与块状高亮不受 span
   * 淘汰影响；仅原生 Shift 扩选可能失去锚点。
   *
   * @param pageNumber 页码，1-based。
   */
  releasePage(pageNumber: number): void {
    // 快照覆盖该页时保留选区层，页淘汰后仍按预合并矩形绘制。
    const preserveSelectionLayer =
      this.lastSelectionModel?.fragments.some(
        (fragment) => fragment.pageNumber === pageNumber,
      ) ?? false;
    const wasPinned = this.pinnedPages.has(pageNumber);
    this.clearPageTextLayer(pageNumber, preserveSelectionLayer);
    if (wasPinned) {
      this.pinnedPages.delete(pageNumber);
      this.refreshPinnedSpanCount();
      // 端点页正常受 pin 保护；这里是被预算/失败强行释放的防御分支。
      this.bridge.warn(
        W_SELECTION_EVICTED,
        `选区端点页 ${pageNumber} 已被释放，原生 Shift 扩选不可用；快照文本与高亮仍保留。`,
        pageNumber - 1,
      );
    }
  }

  /**
   * 指定页是否持有可释放的文本数据。
   *
   * 包含已缓存内容、行划分、等待 settle 的页句柄与进行中的构建，使“只缓存了
   * TextContent、尚未建 span”的页也进入页级 LRU 候选，避免永久驻留。
   *
   * @param pageNumber 页码，1-based。
   * @returns 持有文本数据时 true。
   */
  hasTextData(pageNumber: number): boolean {
    const state = this.pages.get(pageNumber);
    return (
      !!state &&
      (state.content !== null ||
        state.rows !== null ||
        state.page !== null ||
        state.build !== null ||
        state.extracting)
    );
  }

  /** 读取当前 pin 端点页（1-based），供核心淘汰时跳过。 */
  getPinnedPages(): readonly number[] {
    return [...this.pinnedPages].sort((a, b) => a - b);
  }

  /** 当前 pin 页持有的 span 数；用于预算核算与测试断言。 */
  getPinnedSpanCount(): number {
    return this.pinnedSpans;
  }

  /**
   * 更新选区端点页 pin；超出 pin span 预算时拒绝并保持原 pin 不变。
   *
   * @param pages 端点页页码（1-based）。
   * @returns 是否接受；false 表示调用方必须清空选区。
   */
  setPinnedPages(pages: readonly number[]): boolean {
    const next = new Set<number>();
    for (const pageNumber of pages) {
      if (Number.isInteger(pageNumber) && pageNumber >= 1) next.add(pageNumber);
    }
    const spanCount = this.pinnedSpanCountOf(next);
    if (spanCount > this.selectionPinSpanBudget) {
      return false;
    }
    this.pinnedPages = next;
    this.pinnedSpans = spanCount;
    this.host.textLayerPinsChanged?.();
    return true;
  }

  /** 计算给定页集合的 span 总数；未构建页按 0 计。 */
  private pinnedSpanCountOf(pages: ReadonlySet<number>): number {
    let total = 0;
    for (const pageNumber of pages) total += this.pages.get(pageNumber)?.spanCount ?? 0;
    return total;
  }

  /** pin 页的 span 数变化后重算；超预算则解除 pin 并通知选区清空。 */
  private refreshPinnedSpanCount(): void {
    this.pinnedSpans = this.pinnedSpanCountOf(this.pinnedPages);
    this.host.textLayerPinsChanged?.();
    if (this.pinnedSpans > this.selectionPinSpanBudget) {
      this.discardPinnedSelection();
    }
  }

  /**
   * pin 在分帧构建中增长到超预算：解除全部 pin、清空快照并告警。
   *
   * 首帧提交时可能只有几十个 span，随后逐帧增长才越过预算，因此必须在构建
   * 过程中复查，而不能只在建 pin 时判断。
   */
  private discardPinnedSelection(): void {
    if (this.pinnedPages.size === 0) return;
    this.pinnedPages.clear();
    this.pinnedSpans = 0;
    this.host.textLayerPinsChanged?.();
    this.bridge.warn(
      W_SELECTION_UNPINNABLE,
      '选区端点页文本量在构建中超过 pin 预算，已清空选区，请缩小选择范围。',
    );
    // 宿主可选回调：核心实现该能力时清空选区快照；测试替身可省略。
    this.host.textLayerPinBudgetExceeded?.();
  }

  /**
   * 清空单页文本层并放弃进行中的加载。
   *
   * @param pageNumber 页码，1-based。
   * @param preserveSelectionLayer 是否保留选区层（快照仍覆盖该页时）。
   */
  private clearPageTextLayer(pageNumber: number, preserveSelectionLayer = false): void {
    this.onDomMutation?.();
    const state = this.pages.get(pageNumber);
    if (state) {
      this.cancelPageBuild(state);
      state.generation += 1;
      state.abort?.abort();
      state.abort = null;
      state.domBuilt = false;
      state.spanCount = 0;
      state.truncated = false;
    }
    this.pages.delete(pageNumber);
    const view = this.host.getPageView(pageNumber);
    if (view?.textLayer) {
      replaceChildren(view.textLayer);
      view.textLayer.removeAttribute('data-dpi');
      view.textLayer.removeAttribute('data-selectable');
      view.textLayer.style.pointerEvents = 'none';
    }
    if (!preserveSelectionLayer) this.removeSelectionLayer(pageNumber);
    this.removeFindLayer(pageNumber);
  }

  /** 清空全部文本层。 */
  private clearAllTextLayers(): void {
    const pageNumbers = new Set<number>(this.pages.keys());
    for (const view of this.host.getPageViews()) pageNumbers.add(view.pageNumber);
    for (const pageNumber of pageNumbers) this.clearPageTextLayer(pageNumber);
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
      // user-select 是图层级属性，不能在构建/切换功能时逐 span 写。
    }
    if (!textLayerEnabled || !selectionEnabled) {
      this.clearAllSelectionLayers();
      this.setNativeSelectionMode(false);
      this.lastSelectionModel = null;
      this.setPinnedPages([]);
    }
  }

  /** 关闭文档后清理页状态、文本层 DOM 与高亮层。 */
  private resetPages(): void {
    this.setPinnedPages([]);
    this.clearAllTextLayers();
    for (const pageNumber of [...this.findLayers.keys()]) this.removeFindLayer(pageNumber);
    this.clearFindHighlights();
    this.clearAllSelectionLayers();
    this.setNativeSelectionMode(false);
    this.lastSelectionModel = null;
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

/** 选区模型的首尾页（1-based）；空模型返回空数组。 */
function endpointPagesOfModel(model: SelectionModel): number[] {
  if (model.fragments.length === 0) return [];
  const first = model.fragments[0]!.pageNumber;
  const last = model.fragments[model.fragments.length - 1]!.pageNumber;
  return first === last ? [first] : [first, last];
}

/** 判断选区模型是否带预合并矩形（完整快照）。 */
function isSelectionSnapshot(
  model: SelectionModel | SelectionSnapshot,
): model is SelectionSnapshot {
  return 'rectsByPage' in model;
}

/** 按当前环境给出选区 pin span 默认上限：移动端 2 万，桌面 5 万。 */

function defaultPinSpanBudget(): number {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { deviceMemory?: number })
      : null;
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const lowMemory = typeof nav?.deviceMemory === 'number' && nav.deviceMemory <= 4;
  return lowMemory || coarse ? DEFAULT_MOBILE_PIN_SPAN_BUDGET : DEFAULT_DESKTOP_PIN_SPAN_BUDGET;
}

/** 单调时钟，单位毫秒；无 performance 时回退 Date.now。 */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 把同一页的选区片段合并为互不重叠的选区矩形。
 *
 * 先按 rowId 分组，组内把字符 quad 投影到行主轴坐标系并做 flow 方向并集；同一并集
 * 区间内所有字符的 perp 范围取并集。最后按行留缝，保证相邻行矩形之间恰好为
 * {@link SELECTION_ROW_GAP_PX}（行高不足时收缩量不超过半行高）。
 *
 * @param fragments 同一页的选区片段；已按阅读顺序排序。
 * @param axisRowRad 该页行主轴方向，单位弧度。
 * @returns 主轴坐标系中的选区矩形；顺序按行内片段首次出现顺序。
 */
function selectionRectsOfFragments(
  fragments: readonly SelectionFragment[],
  axisRowRad: number,
): RowFlowRect[] {
  const rows = new Map<string, ProjectedRect[]>();
  for (const fragment of fragments) {
    if (!fragment.quad || fragment.rowId === null) continue;
    const projected = projectQuad(fragment.quad, axisRowRad);
    const row = rows.get(fragment.rowId);
    if (row) row.push(projected);
    else rows.set(fragment.rowId, [projected]);
  }
  const rects: RowFlowRect[] = [];
  for (const [rowId, projected] of rows) {
    const intervals = mergeFlowIntervals(
      projected.map((rect) => ({ min: rect.flowMin, max: rect.flowMax })),
    );
    for (const interval of intervals) {
      let perpMin = Number.POSITIVE_INFINITY;
      let perpMax = Number.NEGATIVE_INFINITY;
      for (const rect of projected) {
        if (rect.flowMax < interval.min - FLOW_MERGE_EPSILON) continue;
        if (rect.flowMin > interval.max + FLOW_MERGE_EPSILON) continue;
        perpMin = Math.min(perpMin, rect.perpMin);
        perpMax = Math.max(perpMax, rect.perpMax);
      }
      if (!Number.isFinite(perpMin)) continue;
      rects.push({
        rowId,
        flowMin: interval.min,
        flowMax: interval.max,
        perpMin,
        perpMax,
      });
    }
  }
  return applyRowGap(rects, SELECTION_ROW_GAP_PX);
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

/** 请求下一帧；无 rAF 时回退 setTimeout。返回可用于取消的句柄。 */
function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(() => callback());
  }
  return setTimeout(callback, 0) as unknown as number;
}

/** 取消由 {@link requestFrame} 排队的帧。 */
function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

/** 请求下一帧；无 rAF 时回退 setTimeout。 */
function scheduleFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
}

/**
 * 判断是否需要为 legacy 复制路径写入旧几何 dataset。
 *
 * 引擎没有 chars 时字符级几何不可用，选区会回退到按 span 坐标估算；只有这种页
 * 需要 x/y/size/angle，正常字符几何页不写，以降低单 span 成本。
 *
 * @param content 页文本内容；未加载时为 null。
 * @returns 是否需要旧几何 dataset。
 */
function needsLegacyData(content: TextContent | null): boolean {
  if (!content) return false;
  return (content.items ?? []).some(
    (item) => item.text.length > 0 && (!item.chars || item.chars.length === 0),
  );
}

/**
 * 向上查找页元素最近的滚动容器。
 *
 * 取**第一个**满足以下条件的祖先：内容超出可视区，且 `overflowX/overflowY` 为
 * `auto|scroll|overlay`。
 *
 * @param anchor 页元素。
 * @returns 滚动容器；找不到时返回 null。
 */
function scrollableAncestorOf(anchor: HTMLElement): HTMLElement | null {
  for (let node = anchor.parentElement; node; node = node.parentElement) {
    if (!isScrollableElement(node)) continue;
    const style = getComputedStyleOf(node);
    if (
      style &&
      (SCROLL_OVERFLOW_VALUES.has(style.overflowY) || SCROLL_OVERFLOW_VALUES.has(style.overflowX))
    ) {
      return node;
    }
  }
  return null;
}

/** 判断元素自身是否可滚动（内容超出可视区）。 */
function isScrollableElement(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
}

/** 安全读取计算样式；环境不支持时返回 null。 */
function getComputedStyleOf(element: Element): CSSStyleDeclaration | null {
  if (typeof getComputedStyle !== 'function') return null;
  try {
    return getComputedStyle(element);
  } catch {
    return null;
  }
}

/**
 * 滚动容器的可视矩形，单位屏幕 px。
 *
 * 按布局盒（`offsetWidth/offsetHeight`）与 padding、滚动偏移换算，使结果与页元素布局位置
 * （`offsetTop`）同源；客户端尺寸不可测量（未布局）时回退到 `getBoundingClientRect()`。
 *
 * @param element 滚动容器。
 * @returns 可视矩形。
 */
function elementViewportRect(element: HTMLElement): RectLike {
  const style = getComputedStyleOf(element);
  const px = (value: string | undefined): number => {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const paddingTop = px(style?.paddingTop);
  const paddingBottom = px(style?.paddingBottom);
  const paddingLeft = px(style?.paddingLeft);
  const paddingRight = px(style?.paddingRight);
  const width =
    element.clientWidth || element.offsetWidth - paddingLeft - paddingRight - element.clientLeft * 2;
  const height =
    element.clientHeight || element.offsetHeight - paddingTop - paddingBottom - element.clientTop * 2;
  if (width > 0 && height > 0) {
    const borderLeft = element.clientLeft || 0;
    const borderTop = element.clientTop || 0;
    return {
      left: element.offsetLeft + borderLeft + paddingLeft,
      top: element.offsetTop + borderTop + paddingTop,
      width,
      height,
    };
  }
  return element.getBoundingClientRect();
}

/**
 * 读取元素的滚动偏移。
 *
 * @param element 滚动容器；null 表示使用窗口。
 * @returns 纵向滚动偏移，单位 px。
 */
function scrollTopOf(element: HTMLElement | null): number {
  if (element) return Number.isFinite(element.scrollTop) ? element.scrollTop : 0;
  if (typeof window !== 'undefined' && Number.isFinite(window.scrollY)) return window.scrollY;
  return 0;
}

/** 窗口可视矩形；无窗口环境返回 0 尺寸矩形。 */
function windowViewportRect(): RectLike {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const width = document.documentElement?.clientWidth || window.innerWidth || 0;
  const height = window.innerHeight || 0;
  return { left: 0, top: 0, width, height };
}

/** 命中框包围盒中心（96 DPI px）；无命中框时返回 null。 */
function boundingCenterOf(match: FindMatch): { x: number; y: number } | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const box of match.boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/** 判断是否取消错误。 */
function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'OFD_ABORTED';
}
