/**
 * 页面排版（设计方案 §6.2 / §12.5）。
 *
 * 纯计算模块：把 `PageInfo`（mm）换算为连续滚动下的 CSS 像素盒、累计偏移、
 * 总高度、可见页范围与滚动锚点；不访问 DOM、不渲染。
 *
 * 约定：
 * - 页码对外 1-based，内部索引 0-based；
 * - CSS 尺寸按 96 DPI 换算，再由 `scale` 放大；
 * - 旋转 90/270 时交换页面外框宽高，内层纸面仍按未旋转尺寸渲染；
 * - 页间 gap 固定，首尾有 padding。
 */

import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';
import { MAX_SCALE, MIN_SCALE } from './options';
import type { Rotation, VisiblePageRange, ZoomMode } from './state';

/** 毫米到 96 DPI CSS 像素的换算系数（1 mm = 96 / 25.4 px）。 */
export const MM_TO_CSS_PX = 96 / 25.4;

/** 每英寸毫米数。 */
export const MM_PER_INCH = 25.4;

/** 默认页间距，单位 px。 */
export const DEFAULT_PAGE_GAP = 8;

/** 桌面端页面上下留白，单位 px。 */
export const DEFAULT_PAGE_PADDING = 24;

/**
 * 整数 scrollTop 与小数页顶的容差，单位 px。
 *
 * 浏览器按整数像素保存 `scrollTop`：例如页顶 2285.039 被截断为 2285。
 * `getPageAtOffset` 允许 1px 容差，避免这类截断把当前页回落到上一页。
 */
export const SCROLL_TOP_TOLERANCE = 1;

/**
 * 滚动方向：决定页面之间如何衔接。
 *
 * - `page`（页面滚动）：页与页上下衔接，纵向连续滚动，一列到底；
 * - `horizontal`（水平滚动）：页与页左右衔接，横向单行，一页接一页向右滑动。
 */
export type ScrollDirection = 'page' | 'horizontal';

/**
 * 视图模式：决定一次“滚动/翻页”推进多少页。
 *
 * - `single`（单页）：一次推进一页；
 * - `spread`（双页）：一次推进一组两页，两页之间保留间隔，整组作为一个整体缩放。
 *
 * 默认是 `single` + `page`（单页纵向滚动）。
 */
export type ViewMode = 'single' | 'spread';

/**
 * 阅读器版式配置（滚动方式与视图模式两个正交维度）。
 */
export interface LayoutConfig {
  /** 滚动方向；默认 `page`（纵向）。 */
  readonly direction: ScrollDirection;
  /** 视图模式；默认 `single`（单页）。 */
  readonly viewMode: ViewMode;
}

/** 默版式：单页 + 纵向滚动。 */
export const DEFAULT_LAYOUT: LayoutConfig = Object.freeze({
  direction: 'page',
  viewMode: 'single',
});

/** 双页模式下两页之间的间隔，单位 px。 */
export const SPREAD_GUTTER = 16;

/**
 * 把 GB/T 33190-2016 表 9 的 `PageLayout` 取值换算为版式配置。
 *
 * 阅读器只有“单页/双页 × 纵向/横向”两种维度，因此：
 * - `OneColumn` → 单页 + 纵向；`OnePage` → 单页 + 横向（一屏一页，左右切换）；
 * - `TwoColumnL/R` → 双页 + 纵向；`TwoPageL/R` → 双页 + 横向。
 *
 * @param value 文档声明的 `PageLayout` 取值。
 * @returns 版式配置；未声明或非法时 undefined。
 */
export function layoutConfigFromPageLayout(
  value: string | undefined,
): LayoutConfig | undefined {
  switch (value) {
    case 'OneColumn':
      return { direction: 'page', viewMode: 'single' };
    case 'OnePage':
      return { direction: 'horizontal', viewMode: 'single' };
    case 'TwoColumnL':
    case 'TwoColumnR':
      return { direction: 'page', viewMode: 'spread' };
    case 'TwoPageL':
    case 'TwoPageR':
      return { direction: 'horizontal', viewMode: 'spread' };
    default:
      return undefined;
  }
}

/**
 * 规范化版式配置；非法值回落到默认值。
 *
 * @param config 部分版式配置。
 * @returns 完整版式配置。
 */
export function resolveLayoutConfig(config: Partial<LayoutConfig> | undefined): LayoutConfig {
  const direction =
    config?.direction === 'horizontal' ? 'horizontal' : ('page' as ScrollDirection);
  const viewMode = config?.viewMode === 'spread' ? 'spread' : ('single' as ViewMode);
  return { direction, viewMode };
}

/** 默认 A4 页宽，单位 mm。 */
export const A4_WIDTH_MM = 210;

/** 默认 A4 页高，单位 mm。 */
export const A4_HEIGHT_MM = 297;

/** 单页排版盒。 */
export interface PageBox {
  /** 页索引，0-based。 */
  readonly index: number;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 页盒顶部相对滚动内容顶部的偏移，单位 px。 */
  readonly top: number;
  /** 页盒左缘相对滚动内容左缘的偏移（居中排版时按最宽页对齐），单位 px。 */
  left: number;
  /** 旋转后的外框宽，单位 px。 */
  readonly width: number;
  /** 旋转后的外框高，单位 px。 */
  readonly height: number;
  /** 未旋转纸面宽（canvas CSS 宽），单位 px。 */
  readonly surfaceWidth: number;
  /** 未旋转纸面高（canvas CSS 高），单位 px。 */
  readonly surfaceHeight: number;
  /** 页宽，mm。 */
  readonly widthMm: number;
  /** 页高，mm。 */
  readonly heightMm: number;
  /** 96 DPI 下的页宽（不含缩放倍率），单位 px；与 pdf.js 的 `pageWidth` 对应。 */
  readonly unitWidth: number;
  /** 96 DPI 下的页高（不含缩放倍率），单位 px；与 pdf.js 的 `pageHeight` 对应。 */
  readonly unitHeight: number;
}

/** 滚动锚点。 */
export interface ScrollAnchor {
  /** 锚点所在页索引，0-based。 */
  readonly pageIndex: number;
  /** 页内相对位置，0..1；0 表示页顶。 */
  readonly ratio: number;
}

/** 页面排版选项。 */
export interface PageLayoutOptions {
  /** 页尺寸信息，按索引升序。 */
  readonly pageInfos: readonly PageInfo[];
  /** 初始缩放倍率，默认 1。 */
  readonly scale?: number;
  /** 初始缩放模式，默认 `auto`。 */
  readonly zoomMode?: ZoomMode;
  /** 初始旋转，默认 0。 */
  readonly rotation?: Rotation;
  /** 页间距，单位 px；默认 8。 */
  readonly gap?: number;
  /** 首尾留白，单位 px；默认 24。 */
  readonly padding?: number;
  /** 版式配置（滚动方向 + 视图模式）；默认单页 + 纵向滚动。 */
  readonly layout?: Partial<LayoutConfig>;
  /**
   * 设备像素比，默认 1。
   *
   * 页盒尺寸会取整到该比率的整数倍，使幅面在屏幕上恰好覆盖整数个物理像素：
   * 画布位图与设备像素一一对应，避免整页落在半像素上导致的均匀发虚。
   */
  readonly devicePixelRatio?: number;
}

/** 旋转后是否交换宽高。 */
export function isQuarterTurn(rotation: Rotation): boolean {
  return rotation === 90 || rotation === 270;
}

/**
 * 规范化页尺寸；非法值回退 A4。
 *
 * @param info 页信息。
 * @returns 有效宽高，单位 mm。
 */
export function normalizePageSize(info: PageInfo): { widthMm: number; heightMm: number } {
  const widthMm =
    Number.isFinite(info.widthMm) && info.widthMm > 0 ? info.widthMm : A4_WIDTH_MM;
  const heightMm =
    Number.isFinite(info.heightMm) && info.heightMm > 0 ? info.heightMm : A4_HEIGHT_MM;
  return { widthMm, heightMm };
}

/** 页面排版。 */
export class PageLayout {
  /** 页信息。 */
  private infos: readonly PageInfo[];
  /** 当前缩放倍率。 */
  private currentScale: number;
  /** 当前缩放模式；倍率由用户指定时固定为 `page-actual`。 */
  private currentZoomMode: ZoomMode = 'auto';
  /** 当前旋转角度。 */
  private currentRotation: Rotation;
  /** 页间距，单位 px。 */
  private gapPx: number;
  /** 首尾留白，单位 px。 */
  private paddingPx: number;
  /** 页盒缓存；随缩放/旋转/页信息变化重建。 */
  private boxes: PageBox[] = [];
  /** 累计总高度，单位 px。 */
  private height = 0;
  /** 单列排版的内容宽度（取最宽页），单位 px。 */
  private width = 0;
  /** 96 DPI 下最宽页的宽度（不含倍率），单位 px。 */
  private unitWidth = 0;
  /** 面积最大的页在 96 DPI 下的单位面积，单位 px²；用于自适应渲染预算。 */
  private maxUnitArea = 0;
  /** 上一次重建时各页的高度，单位 px；用于把“页内像素”按页高等比换算。 */
  private previousHeights: number[] = [];
  /** 上一次重建时的内容宽度，单位 px；用于把横向锚点按宽度等比换算。 */
  private previousWidth = 0;
  /** 设备像素比；页盒尺寸按它取整到设备像素网格。 */
  private devicePixelRatio = 1;
  /** 版式配置。 */
  private layoutConfig: LayoutConfig;
  /** 当前列数：单页 1、双页 2。 */
  private columnCount = 1;

  /**
   * @param options 页信息与初始缩放/旋转。
   */
  constructor(options: PageLayoutOptions) {
    this.infos = options.pageInfos;
    this.currentScale = sanitizeScale(options.scale ?? 1);
    this.currentZoomMode = options.zoomMode ?? 'auto';
    this.currentRotation = options.rotation ?? 0;
    this.gapPx = Math.max(0, options.gap ?? DEFAULT_PAGE_GAP);
    this.paddingPx = Math.max(0, options.padding ?? DEFAULT_PAGE_PADDING);
    this.devicePixelRatio = normalizeDevicePixelRatio(options.devicePixelRatio);
    this.layoutConfig = resolveLayoutConfig(options.layout);
    this.rebuild();
  }

  /** 页数。 */
  get pageCount(): number {
    return this.infos.length;
  }

  /** 当前缩放倍率。 */
  get scale(): number {
    return this.currentScale;
  }

  /** 当前缩放模式。 */
  get zoomMode(): ZoomMode {
    return this.currentZoomMode;
  }

  /** 当前旋转角度。 */
  get rotation(): number {
    return this.currentRotation;
  }

  /** 页间距，单位 px。 */
  get gap(): number {
    return this.gapPx;
  }

  /** 首尾留白，单位 px。 */
  get padding(): number {
    return this.paddingPx;
  }

  /** 内容总高度（含首尾留白），单位 px。 */
  get totalHeight(): number {
    return this.height;
  }

  /** 单列排版的滚动内容宽度（最宽页），单位 px。 */
  get totalWidth(): number {
    return this.width;
  }

  /** 96 DPI 下最宽页的宽度（不含倍率），单位 px。 */
  get maxUnitWidth(): number {
    return this.unitWidth;
  }

  /** 96 DPI 下面积最大的页的单位面积（不含倍率），单位 px²。 */
  get maxPageUnitArea(): number {
    return this.maxUnitArea;
  }

  /** 全部排版盒（只读）。 */
  getBoxes(): readonly PageBox[] {
    return this.boxes;
  }

  /**
   * 内容比可视区窄时的横向居中偏移（与 pdf.js 的 `.page { margin: 0 auto }` 等价）。
   *
   * 内容比可视区宽时返回 0：此时两侧留白由滚动位置承担，页面左缘可以滚到可视区左缘。
   *
   * @param viewportWidth 主区域可视宽度（不含滚动条），单位 px。
   * @returns 内容左缘相对可视区左缘的偏移，单位 px；不小于 0。
   */
  centeredOffset(viewportWidth: number): number {
    const contentWidth =
      this.horizontal && this.viewportSize.width > 0
        ? Math.max(this.width, this.viewportSize.width)
        : this.width;
    return this.snapToDevicePixel(Math.max(0, (viewportWidth - contentWidth) / 2));
  }

  /**
   * 横向滚动时整组在视口中垂直居中所需的偏移，单位 px。
   *
   * 横向滚动只有一行，页面比视口矮时贴顶部会显得头上重下轻；这里给出让该行内容
   * 垂直居中的顶部偏移（内容高于视口时为 0）。
   */
  verticalCenteredOffset(viewportHeight: number): number {
    if (!this.horizontal || viewportHeight <= 0) return 0;
    return this.snapToDevicePixel(Math.max(0, (viewportHeight - this.height) / 2));
  }

  /**
   * 把长度对齐到设备像素网格（向上取整）。
   *
   * 对齐后的长度在屏幕上恰好覆盖整数个物理像素，画布位图与设备像素一一对应；不对齐时
   * 整页会落在半像素上，浏览器需重采样，表现为全页（尤其文字）均匀发虚。
   *
   * 必须向上取整而不是四舍五入：画布位图尺寸由 `Math.ceil(viewport)` 得出（引擎要求
   * canvas 不小于 viewport），页盒若四舍五入就可能比位图少 1 像素，使 canvas 被 CSS
   * 拉伸约 0.999 倍而重采样。取同一方向后两者恒等，缩放后位图与显示像素始终 1:1。
   *
   * @param value 长度，单位 px。
   * @returns 对齐后的长度，单位 px。
   */
  snapToDevicePixel(value: number): number {
    const ratio = this.devicePixelRatio;
    return Math.ceil(value * ratio) / ratio;
  }

  /**
   * 设置设备像素比并重建布局。
   *
   * 显示器切换或页面缩放到不同缩放比时，设备像素比会变化，需要按新比率重新对齐。
   *
   * @param devicePixelRatio 设备像素比。
   */
  setDevicePixelRatio(devicePixelRatio: number): void {
    const next = normalizeDevicePixelRatio(devicePixelRatio);
    if (next === this.devicePixelRatio) return;
    this.devicePixelRatio = next;
    this.rebuild();
  }

  /** 当前设备像素比。 */
  get devicePixelRatioValue(): number {
    return this.devicePixelRatio;
  }

  /**
   * 替换页信息。
   *
   * @param infos 新页信息，按索引升序。
   */
  setPageInfos(infos: readonly PageInfo[]): void {
    this.infos = infos;
    this.rebuild();
  }

  /**
   * 设置缩放倍率。
   *
   * @param scale 缩放倍率；非法值按 1 处理。
   */
  setScale(scale: number): void {
    this.setZoom(scale, 'page-actual');
  }

  /**
   * 同时设置缩放倍率与缩放模式；倍率与模式都未变时不做任何事。
   *
   * @param scale 缩放倍率；非法值按 1 处理。
   * @param mode 缩放模式。
   */
  setZoom(scale: number, mode: ZoomMode): void {
    const next = sanitizeScale(scale);
    if (next === this.currentScale && mode === this.currentZoomMode) return;
    this.currentScale = next;
    this.currentZoomMode = mode;
    this.rebuild();
  }

  /**
   * 设置旋转角度。
   *
   * @param rotation 0/90/180/270。
   */
  setRotation(rotation: Rotation): void {
    if (rotation === this.currentRotation) return;
    this.currentRotation = rotation;
    this.rebuild();
  }

  /**
   * 设置页间距。
   *
   * @param gap 间距，单位 px。
   */
  setGap(gap: number): void {
    const next = Math.max(0, gap);
    if (next === this.gapPx) return;
    this.gapPx = next;
    this.rebuild();
  }

  /**
   * 设置首尾留白。
   *
   * @param padding 留白，单位 px。
   */
  setPadding(padding: number): void {
    const next = Math.max(0, padding);
    if (next === this.paddingPx) return;
    this.paddingPx = next;
    this.rebuild();
  }

  /**
   * 读取页盒。
   *
   * @param index 页索引，0-based。
   * @returns 页盒；越界返回 undefined。
   */
  getBox(index: number): PageBox | undefined {
    return this.boxes[index];
  }

  /**
   * 读取页顶偏移。
   *
   * @param index 页索引，0-based。
   * @returns 偏移，单位 px；越界返回 0。
   */
  getPageTop(index: number): number {
    return this.boxes[index]?.top ?? 0;
  }

  /**
   * 读取页外框高度。
   *
   * @param index 页索引，0-based。
   * @returns 高度，单位 px；越界返回 0。
   */
  getPageHeight(index: number): number {
    return this.boxes[index]?.height ?? 0;
  }

  /**
   * 按缩放模式计算所需倍率；模式计算针对当前页。
   *
   * @param mode 缩放模式。
   * @param viewport 可用视口尺寸，单位 px。
   * @param pageIndex 参考页索引，0-based；默认第一页。
   * @returns 倍率；无页时返回 1。
   */
  scaleForMode(
    mode: 'auto' | 'page-actual' | 'page-fit' | 'page-width',
    viewport: { readonly width: number; readonly height: number },
    pageIndex = 0,
  ): number {
    if (mode === 'page-actual') return 1;
    const box = this.boxes[Math.min(Math.max(0, pageIndex), Math.max(0, this.boxes.length - 1))];
    if (!box) return 1;
    const width = Math.max(1, viewport.width);
    const height = Math.max(1, viewport.height);
    const widthScale = width / Math.max(1, box.width / this.currentScale);
    if (mode === 'page-width' || mode === 'auto') return clampScale(widthScale);
    const heightScale = height / Math.max(1, box.height / this.currentScale);
    return clampScale(Math.min(widthScale, heightScale));
  }

  /**
   * 计算“最近一组”的首页索引。
   *
   * 双页模式下一组两页共享同一位置，普通命中只能得到组内首列，因此这里按组定位。
   *
   * @param offset 沿滚动方向的坐标，单位 px。
   * @param viewportExtent 视口在滚动方向上的长度，单位 px；大于 0 时按“重叠最多”的组判定。
   * @returns 组的首页索引，0-based；无页时 0。
   */
  groupStartAtOffset(offset: number, viewportExtent = 0): number {
    if (this.boxes.length === 0) return 0;
    const pageIndex = this.getPageAtOffset(offset);
    const rowStart = this.groupRangeOf(pageIndex).start;
    if (viewportExtent <= 0) return rowStart;
    // 视角落在两组交界时以“与视口重叠最多”的组为准；只看命中组会把刚滚到下一组
    // 的情况判成上一组。
    const top = Math.max(0, offset);
    const bottom = top + viewportExtent;
    let best = rowStart;
    let bestOverlap = -1;
    for (let index = 0; index < this.boxes.length; index += this.columnCount) {
      const box = this.boxes[index]!;
      const start = this.horizontal ? box.left : box.top;
      const extent = this.horizontal ? box.width : box.height;
      const overlap = Math.min(bottom, start + extent) - Math.max(top, start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = index;
      }
    }
    return best;
  }

  /**
   * 计算可见页范围。
   *
   * @param scrollTop 主区域滚动位置，单位 px。
   * @param viewportHeight 主区域高度，单位 px。
   * @param overscan 上下额外扩展页数；默认 0。
   * @returns 0-based 闭区间；无页时 `end < start`。
   */
  getVisibleRange(scrollTop: number, viewportHeight: number, overscan = 0): VisiblePageRange {
    return this.visibleRangeIn(scrollTop, viewportHeight, overscan, false);
  }

  /**
   * 计算可见页范围（沿当前滚动方向）。
   *
   * 纵向滚动按 `top`/高度判定、横向滚动按 `left`/宽度判定：横向布局下所有页 top 相同，
   * 若仍按纵向判定会把全部页都算作可见，导致文本层与图层被全量构建。
   *
   * @param position 沿滚动方向的滚动位置，单位 px。
   * @param extent 视口在滚动方向上的长度，单位 px。
   * @param overscan 前后额外扩展页数；默认 0。
   * @returns 0-based 闭区间；无页时 `end < start`。
   */
  getVisibleRangeAlong(
    position: number,
    extent: number,
    overscan = 0,
  ): VisiblePageRange {
    return this.visibleRangeIn(position, extent, overscan, true);
  }

  /**
   * 可见页范围的统一实现。
   *
   * @param position 沿滚动方向的滚动位置，单位 px。
   * @param extent 视口在滚动方向上的长度，单位 px。
   * @param overscan 额外扩展页数。
   * @param along 是否按当前布局的滚动方向（否则强制按纵向）。
   * @returns 0-based 闭区间。
   */
  private visibleRangeIn(
    position: number,
    extent: number,
    overscan: number,
    along: boolean,
  ): VisiblePageRange {
    if (this.boxes.length === 0) return { start: 0, end: -1 };
    const byAxis = along && this.horizontal;
    const startOf = (index: number): number =>
      byAxis ? this.boxes[index]!.left : this.boxes[index]!.top;
    const sizeOf = (index: number): number =>
      byAxis ? this.boxes[index]!.width : this.boxes[index]!.height;
    const start = Math.max(0, position);
    const end = start + Math.max(0, extent);
    // 首个与区间相交的页：按起点排序后用线性扫描（页数有限且常驻可见范围很小）。
    let first = -1;
    for (let index = 0; index < this.boxes.length; index += 1) {
      const boxStart = startOf(index);
      if (boxStart + sizeOf(index) > start && boxStart < end) {
        first = index;
        break;
      }
    }
    if (first === -1) {
      // 落在全部页之后：取最后一页。
      return { start: this.boxes.length - 1, end: this.boxes.length - 1 };
    }
    let last = first;
    for (let index = first + 1; index < this.boxes.length; index += 1) {
      if (startOf(index) >= end) break;
      last = index;
    }
    const extra = Math.max(0, Math.trunc(overscan));
    return {
      start: Math.max(0, first - extra),
      end: Math.min(this.boxes.length - 1, last + extra),
    };
  }

  /**
   * 计算指定滚动位置所在页。
   *
   * 滚动超过内容末尾时返回最后一页；内容为空返回 0。浏览器会把小数滚动位置
   * 截断为整数像素，因此比较页顶时允许 {@link SCROLL_TOP_TOLERANCE} 的容差，
   * 避免 2285.039 的页顶在 scrollTop=2285 时被判为上一页。
   *
   * @param scrollTop 滚动位置，单位 px。
   * @returns 页索引，0-based。
   */
  getPageAtOffset(scrollTop: number): number {
    const count = this.boxes.length;
    if (count === 0) return 0;
    if (scrollTop <= this.boxes[0]!.top) return 0;
    const last = this.boxes[count - 1]!;
    if (scrollTop >= last.top + last.height + this.paddingPx) return count - 1;
    const offset = Math.max(0, scrollTop) + SCROLL_TOP_TOLERANCE;
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.boxes[mid]!.top <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /**
   * 由滚动位置生成锚点（页索引 + 页内比例）。
   *
   * @param scrollTop 滚动位置，单位 px。
   * @returns 锚点；比例被限制在 0..1。
   */
  getAnchor(scrollTop: number): ScrollAnchor {
    if (this.boxes.length === 0) return { pageIndex: 0, ratio: 0 };
    const pageIndex = this.getPageAtOffset(scrollTop);
    const box = this.boxes[pageIndex]!;
    const ratio =
      box.height > 0 ? clamp((scrollTop - box.top) / box.height, 0, 1) : 0;
    return { pageIndex, ratio };
  }

  /**
   * 由滚动内容坐标生成缩放锚点；与 {@link getAnchor} 不同，页间留白也保留真实坐标。
   *
   * @param offset 滚动内容坐标，单位 px。
   * @param offsetX 内容的横向偏移，相对滚动内容左边缘，单位 px。
   * @returns 缩放锚点。
   */
  contentPointAt(offset: number, offsetX = 0): ContentPoint {
    // `offset` 原样保留、不做页边夹取：连续多帧捏合时，若每帧都把落在页间留白上的
    // 坐标压回页顶/页底，换算误差会逐帧累加，表现为画面缓慢漂移。这里只额外给出
    // “页索引 + 页内像素”，供需要在布局变化后还原同一视觉位置的地方使用。
    const pageIndex = this.getPageAtOffset(offset);
    const box = this.boxes[pageIndex];
    return {
      offset,
      offsetX,
      pageIndex,
      pageOffset: box ? offset - box.top : offset,
      ratio: box && box.height > 0 ? clamp((offset - box.top) / box.height, 0, 1) : 0,
    };
  }

  /**
   * 把缩放锚点换回当前布局下的滚动内容坐标。
   *
   * 用“页索引 + 页内像素”表达而非页内比例：比例在多帧缩放里会被页间留白与 1px 容差
   * 反复夹取、逐帧累积误差；页内像素只与倍率线性相关，换算是一次乘法。
   *
   * @param point 缩放锚点。
   * @returns 滚动内容坐标，单位 px。
   */
  offsetForContentPoint(point: ContentPoint): number {
    if (this.boxes.length === 0) return point.offset;
    const box = this.boxes[Math.min(Math.max(0, point.pageIndex), this.boxes.length - 1)]!;
    // 页内像素按页高等比换算：缩放与旋转都会改变页高，用页高比一次覆盖两种情形。
    const previousHeight = this.previousHeights[point.pageIndex] ?? 0;
    const factor = previousHeight > 0 ? box.height / previousHeight : 1;
    return box.top + point.pageOffset * factor;
  }

  /**
   * 把缩放锚点的横向内容坐标换回当前布局下的值。
   *
   * 锚点记录的 `offsetX` 是缩放前的内容坐标；内容以左缘为原点整体等比缩放，因此乘上
   * 新旧内容宽度之比即可，不做比例夹取，避免连续缩放逐帧累积误差。
   *
   * @param point 缩放锚点。
   * @returns 当前布局下的横向内容坐标，单位 px。
   */
  leftForContentPoint(point: ContentPoint): number {
    if (this.previousWidth <= 0 || this.width <= 0) return point.offsetX;
    return (point.offsetX * this.width) / this.previousWidth;
  }

  /**
   * 由锚点计算滚动位置。
   *
   * @param anchor 锚点。
   * @returns 滚动位置，单位 px；无页时 0。
   */
  getOffsetForAnchor(anchor: ScrollAnchor): number {
    if (this.boxes.length === 0) return 0;
    const index = Math.min(Math.max(0, anchor.pageIndex), this.boxes.length - 1);
    const box = this.boxes[index]!;
    return box.top + clamp(anchor.ratio, 0, 1) * box.height;
  }

  /**
   * 页码（1-based）转页索引。
   *
   * @param pageNumber 页码，1-based。
   * @returns 页索引，0-based；无页返回 0。
   */
  indexOfPageNumber(pageNumber: number): number {
    if (this.boxes.length === 0) return 0;
    return Math.min(Math.max(0, Math.trunc(pageNumber) - 1), this.boxes.length - 1);
  }

  /** 当前版式配置。 */
  get layout(): LayoutConfig {
    return this.layoutConfig;
  }

  /** 当前滚动方向：纵向衔接（`page`）或横向衔接（`horizontal`）。 */
  get direction(): ScrollDirection {
    return this.layoutConfig.direction;
  }

  /** 当前视图模式：单页或双页。 */
  get viewMode(): ViewMode {
    return this.layoutConfig.viewMode;
  }

  /** 是否双页模式（两页一组，组间与组内均有间隔）。 */
  get spread(): boolean {
    return this.layoutConfig.viewMode === 'spread';
  }

  /** 是否横向滚动（单行、左右衔接）。 */
  get horizontal(): boolean {
    return this.layoutConfig.direction === 'horizontal';
  }

  /** 当前布局的列数：单页 1、双页 2。 */
  get columns(): number {
    return this.columnCount;
  }

  /** 一组包含的页数：单页 1、双页 2。 */
  get groupSize(): number {
    return this.columnCount;
  }

  /**
   * 设置版式配置并重建排版。
   *
   * @param layout 目标版式（可只给一个维度，另一维度保持不变）。
   */
  setLayout(layout: Partial<LayoutConfig>): void {
    const next = resolveLayoutConfig({ ...this.layoutConfig, ...layout });
    if (next.direction === this.layoutConfig.direction && next.viewMode === this.layoutConfig.viewMode) {
      return;
    }
    this.layoutConfig = next;
    this.rebuild();
  }

  /**
   * 上次已知的视口尺寸，单位 px。
   *
   * 用于给滚动内容末端补足“一屏”留白：只有补足后，最后一组才能滚动到与中间组相同
   * 的位置（贴齐视口起点），否则滚动到底时末端被夹住，吸附又把它拉回组起点，表现为
   * “被弹回、无法继续滚动”。
   */
  private viewportSize = { width: 0, height: 0 };

  /**
   * 更新滚动视口尺寸。
   *
   * @param width 视口宽，单位 px。
   * @param height 视口高，单位 px。
   */
  setViewport(width: number, height: number): void {
    const nextWidth = Math.max(0, Number.isFinite(width) ? width : 0);
    const nextHeight = Math.max(0, Number.isFinite(height) ? height : 0);
    if (nextWidth === this.viewportSize.width && nextHeight === this.viewportSize.height) return;
    this.viewportSize = { width: nextWidth, height: nextHeight };
    this.rebuild();
  }

  /** 组数：单页 1 页一组、双页 2 页一组。 */
  get groupCount(): number {
    if (this.boxes.length === 0) return 0;
    return Math.ceil(this.boxes.length / this.columnCount);
  }

  /**
   * 页索引所在分组的首末页索引。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 0-based 闭区间；无页时 `end < start`。
   */
  groupRangeOf(pageIndex: number): { readonly start: number; readonly end: number } {
    if (this.boxes.length === 0) return { start: 0, end: -1 };
    const count = Math.max(1, this.columnCount);
    const index = Math.min(Math.max(0, Math.trunc(pageIndex)), this.boxes.length - 1);
    const start = Math.floor(index / count) * count;
    return { start, end: Math.min(this.boxes.length - 1, start + count - 1) };
  }

  /**
   * 页索引所在分组的序号（单页即页序号，双页为 `floor(页索引 / 2)`）。
   *
   * 供翻页使用：双页一次翻两页、单页一次翻一页。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 组序号，0-based。
   */
  groupIndexOf(pageIndex: number): number {
    const count = Math.max(1, this.columnCount);
    return Math.floor(Math.max(0, Math.trunc(pageIndex)) / count);
  }

  /**
   * 组在原点的位置（沿滚动方向的偏移）。
   *
   * @param groupIndex 组序号，0-based。
   * @returns 偏移，单位 px；无内容时为留白。
   */
  groupOffset(groupIndex: number): number {
    const box = this.boxes[groupIndex * this.columnCount];
    if (!box) return this.paddingPx;
    return this.horizontal ? box.left : box.top;
  }

  /**
   * 重建页盒与偏移。
   *
   * 两个维度决定排布：
   * - **滚动方向**：`page` 逐组向下堆叠（纵向连续），`horizontal` 逐组向右排开（单行横滑）；
   * - **视图模式**：`single` 每组一页，`spread` 每组两页并排、组内保留间隔。
   *
   * 页盒尺寸始终按 `scale` 推导（与缩放模式一致），不做任何“按视口整体缩放”。
   * 组内两页横向间隔为 {@link SPREAD_GUTTER}，组与组之间使用 `gap`。
   */
  private rebuild(): void {
    // 记录重建前的页高/内容宽度：锚点里的“页内像素”是按旧布局量的，换回坐标时要按
    // 页高与内容宽度等比换算（见 {@link offsetForContentPoint} / {@link leftForContentPoint}）。
    this.previousHeights = this.boxes.map((box) => box.height);
    this.previousWidth = this.width;

    const columns = this.spread ? 2 : 1;
    this.columnCount = columns;
    const horizontal = this.horizontal;
    const quarter = isQuarterTurn(this.currentRotation);
    const scale = this.currentScale;

    // 组内一行的宽高：双页时两页并排，行高取组内较高者。
    const slots = measureSlots(this.infos, columns, quarter);
    const rowWidth = slots.columnWidths.reduce((sum, value) => sum + value, 0);
    const rowHeight = slots.rowHeight;
    // 组沿滚动方向占据的长度：横向为整组宽度（含组内间隔），纵向为组高。
    const groupAdvance =
      columns > 1 && horizontal
        ? rowWidth * scale + SPREAD_GUTTER * (columns - 1) * scale
        : (horizontal ? rowWidth : rowHeight) * scale;

    // 纵向单页的逐页顶部偏移（每页高度各自对齐设备像素后累加）。
    const rowTops: number[] = [];
    {
      let cursor = this.paddingPx;
      for (let index = 0; index < this.infos.length; index += 1) {
        rowTops.push(cursor);
        const { widthMm, heightMm } = normalizePageSize(this.infos[index]!);
        const unitWidth = widthMm * MM_TO_CSS_PX;
        const unitHeight = heightMm * MM_TO_CSS_PX;
        cursor +=
          this.snapToDevicePixel(scale * (quarter ? unitWidth : unitHeight)) + this.gapPx;
      }
    }

    const boxes: PageBox[] = [];
    for (let index = 0; index < this.infos.length; index += 1) {
      const info = this.infos[index]!;
      const { widthMm, heightMm } = normalizePageSize(info);
      // 与 pdf.js 一致：页宽高以 96 DPI 的“单位尺寸”为准，实际尺寸 = 单位尺寸 × 倍率。
      const unitWidth = widthMm * MM_TO_CSS_PX;
      const unitHeight = heightMm * MM_TO_CSS_PX;
      // 尺寸取整到设备像素网格：幅面恰好覆盖整数个物理像素，画布位图与屏幕像素一一对应。
      const width = this.snapToDevicePixel(scale * (quarter ? unitHeight : unitWidth));
      const height = this.snapToDevicePixel(scale * (quarter ? unitWidth : unitHeight));
      const surfaceWidth = quarter ? height : width;
      const surfaceHeight = quarter ? width : height;

      const group = Math.floor(index / columns);
      const column = index % columns;
      // 组起点沿滚动方向累加：横向滚动按组宽向右，纵向滚动按组高向下。
      // 组内第 2 页只在“横向”坐标上偏移（跳过第 1 页宽度 + 组内间隔），
      // 沿滚动方向的坐标与组内第 1 页完全一致，保证同组两页落在同一行/列。
      const groupOffset = group * (groupAdvance + this.gapPx);
      let columnOffset = 0;
      for (let slot = 0; slot < column; slot += 1) {
        columnOffset += slots.columnWidths[slot]! * scale + SPREAD_GUTTER * scale;
      }
      // 横向坐标（left）与纵向坐标（top）：
      // - 横向滚动：left = 留白 + 组起点 + 组内偏移，top = 留白 + 组内垂直居中；
      // - 纵向滚动：top = 留白 + 组起点，left = 留白 + 组内偏移（单页居中由末段统一处理）。
      const crossExtent = rowHeight * scale;
      const crossOffset = columns > 1 ? Math.max(0, (crossExtent - height) / 2) : 0;
      // 纵向单页按“逐页高度累加”定位：页高各自对齐设备像素，累计误差按页线性增长，
      // 与历史行为一致；双页按组起点定位，保证同组两页严格同行。
      const top = horizontal
        ? this.paddingPx + crossOffset
        : columns === 1
          ? rowTops[index]!
          : this.paddingPx + groupOffset;
      const left = horizontal
        ? this.paddingPx + groupOffset + columnOffset
        : columns === 1
          ? 0
          : this.paddingPx + columnOffset;

      boxes.push({
        index,
        pageNumber: index + 1,
        top,
        left,
        width,
        height,
        surfaceWidth,
        surfaceHeight,
        widthMm,
        heightMm,
        unitWidth,
        unitHeight,
      });
    }

    const groups = Math.max(0, Math.ceil(this.infos.length / columns));
    // 最后一组沿滚动方向的实际长度（用于末端留白）。
    const lastGroupBoxes = boxes.slice(Math.max(0, (groups - 1) * columns));
    const lastGroupExtent = lastGroupBoxes.length === 0
      ? 0
      : horizontal
        ? Math.max(...lastGroupBoxes.map((box) => box.left + box.width)) -
          Math.min(...lastGroupBoxes.map((box) => box.left))
        : Math.max(...lastGroupBoxes.map((box) => box.top + box.height)) -
          Math.min(...lastGroupBoxes.map((box) => box.top));
    const contentExtent =
      groups === 0 ? 0 : groups * (groupAdvance + this.gapPx) - this.gapPx;
    const widest = boxes.length > 0 ? Math.max(...boxes.map((box) => box.width)) : 0;
    // 纵向双页：内容宽度 = 整组右缘（组内坐标已含左侧留白）+ 右侧留白。
    // 居中偏移用 `centeredOffset()` 按该宽度补足，保证左右留白相等。
    const widestGroupWidth = boxes.length === 0
      ? 0
      : Math.max(...boxes.map((box) => box.left + box.width)) + this.paddingPx;
    const tallest = boxes.length > 0 ? Math.max(...boxes.map((box) => box.height)) : 0;
    // 末端补足一屏留白：分页/双页布局下每组应能滚到“贴齐视口起点”，否则最后一组
    // 被滚动范围夹住、无法对齐（吸附会把它拉回组起点，表现为弹回）。
    const tail = (extent: number): number =>
      extent > 0 ? Math.max(this.paddingPx, extent - lastGroupExtent) : this.paddingPx;
    this.height = Math.max(
      horizontal
        ? this.paddingPx * 2 + tallest
        : this.paddingPx + contentExtent + tail(this.viewportSize.height),
      this.paddingPx * 2,
    );
    this.width = Math.max(
      horizontal
        ? this.paddingPx + contentExtent + tail(this.viewportSize.width)
        : // 纵向滚动：单页取最宽页；双页取整组宽度（两页 + 组内间隔），否则居中偏移
          // 会按单页宽度计算，导致整组偏左。
          (widestGroupWidth ?? widest),
      this.paddingPx * 2,
    );
    this.unitWidth = slots.widestUnitWidth;
    this.maxUnitArea = boxes.reduce(
      (area, box) => Math.max(area, box.unitWidth * box.unitHeight),
      0,
    );
    // 单页纵向：与 pdf.js 的 `.page { margin: 0 auto }` 等价，每页相对内容左缘居中。
    if (columns === 1 && !horizontal) {
      for (const box of boxes) box.left = this.snapToDevicePixel((this.width - box.width) / 2);
    }
    this.boxes = boxes;
  }

  /**
   * 指定倍率下的排版盒，不修改当前布局（用于预计算锚点落位）。
   *
   * @param scale 目标缩放倍率。
   * @returns 新倍率下的页盒列表。
   */
  boxesAt(scale: number): PageBox[] {
    const layout = new PageLayout({
      pageInfos: this.infos,
      scale,
      rotation: this.currentRotation,
      gap: this.gapPx,
      padding: this.paddingPx,
    });
    return [...layout.getBoxes()];
  }
}

/**
 * 滚动内容中的任意一点（不再局限于“页索引 + 页内比例”）。
 *
 * 用于缩放锚点：不论锚点落在页面上还是页间留白里，都能在缩放前后按内容坐标还原。
 */
export interface ContentPoint {
  /** 内容坐标，相对滚动内容顶部的偏移，单位 px；不做页边夹取，是精确值。 */
  readonly offset: number;
  /** 内容的横向偏移，相对滚动内容左边缘，单位 px。 */
  readonly offsetX: number;
  /** 所在页索引，0-based。 */
  readonly pageIndex: number;
  /** 距所在页顶的像素距离，单位 px；可为负（页间留白）或大于页高，与倍率线性相关。 */
  readonly pageOffset: number;
  /** 在该页内的高度比例，0..1；供按比例表达的调用方使用。 */
  readonly ratio: number;
}

/**
 * 计算以指定点为中心缩放后的滚动位置。
 *
 * 固定的是「视口中心」下的内容：设视口中心的内容坐标为 `c`，滚动位置为 `s`，
 * 缩放前后该点相对视口中心的内容偏移按 `r` 缩放，于是
 * `s' = offset' - (c - s) * r`。
 *
 * @param offsetBefore 视口中心当前的滚动内容坐标，单位 px。
 * @param scrollTop 当前滚动位置，单位 px。
 * @param ratio 新倍率与旧倍率之比。
 * @param nextOffset 视口中心在新布局中的滚动内容坐标，单位 px。
 * @returns 缩放后的滚动位置，单位 px；未夹取到滚动范围内。
 */
export function scrollTopForZoomAnchor(
  offsetBefore: number,
  scrollTop: number,
  ratio: number,
  nextOffset: number,
): number {
  return nextOffset - (offsetBefore - scrollTop) * ratio;
}

/**
 * 计算布局槽位：每列宽度、行高与最宽页单位宽度。
 *
 * 列宽取该列所有页的最大宽度（双页时两列独立），行高取全表最高页，使双页的两页
 * 在组内对齐。尺寸单位为 96 DPI CSS 像素（不含缩放倍率）。
 *
 * @param infos 页信息，按索引升序。
 * @param columnCount 列数：单页 1、双页 2。
 * @param quarter 是否 90/270 旋转（交换宽高）。
 * @returns 列宽数组、行高与最宽页的单位宽度。
 */
function measureSlots(
  infos: readonly PageInfo[],
  columnCount: number,
  quarter: boolean,
): {
  readonly columnWidths: number[];
  readonly rowHeight: number;
  readonly widestUnitWidth: number;
} {
  const columnWidths: number[] = new Array<number>(columnCount).fill(0);
  let rowHeight = 0;
  let widestUnitWidth = 0;
  for (let index = 0; index < infos.length; index += 1) {
    const { widthMm, heightMm } = normalizePageSize(infos[index]!);
    const unitWidth = widthMm * MM_TO_CSS_PX;
    const unitHeight = heightMm * MM_TO_CSS_PX;
    const slotWidth = quarter ? unitHeight : unitWidth;
    const slotHeight = quarter ? unitWidth : unitHeight;
    const column = index % columnCount;
    columnWidths[column] = Math.max(columnWidths[column]!, slotWidth);
    rowHeight = Math.max(rowHeight, slotHeight);
    widestUnitWidth = Math.max(widestUnitWidth, unitWidth);
  }
  if (infos.length === 0) {
    return {
      columnWidths,
      rowHeight: A4_HEIGHT_MM * MM_TO_CSS_PX,
      widestUnitWidth: 0,
    };
  }
  return { columnWidths, rowHeight, widestUnitWidth };
}

/**
 * 限制缩放倍率到合法范围。
 *
 * @param value 原始倍率。
 * @returns 有限且 > 0 的倍率；非法时回退 1。
 */
function sanitizeScale(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * 限制设备像素比到合法范围。
 *
 * @param value 原始设备像素比。
 * @returns 有限且 > 0 的比率；非法时回退 1。
 */
function normalizeDevicePixelRatio(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * 限制数值到闭区间。
 *
 * @param value 数值。
 * @param min 最小值。
 * @param max 最大值。
 * @returns 限制后的数值。
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 限制到阅读器允许的缩放范围。
 *
 * @param value 倍率。
 * @returns {@link MIN_SCALE}..{@link MAX_SCALE}（25%..1000%）的倍率。
 */
function clampScale(value: number): number {
  return clamp(value, MIN_SCALE, MAX_SCALE);
}