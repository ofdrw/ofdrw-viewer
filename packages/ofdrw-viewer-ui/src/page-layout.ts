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
    return this.snapToDevicePixel(Math.max(0, (viewportWidth - this.width) / 2));
  }

  /**
   * 把长度对齐到设备像素网格。
   *
   * 对齐后的长度在屏幕上恰好覆盖整数个物理像素，画布位图与设备像素一一对应；不对齐时
   * 整页会落在半像素上，浏览器需重采样，表现为全页（尤其文字）均匀发虚。
   *
   * @param value 长度，单位 px。
   * @returns 对齐后的长度，单位 px。
   */
  snapToDevicePixel(value: number): number {
    const ratio = this.devicePixelRatio;
    return Math.round(value * ratio) / ratio;
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
   * 计算可见页范围。
   *
   * @param scrollTop 主区域滚动位置，单位 px。
   * @param viewportHeight 主区域高度，单位 px。
   * @param overscan 上下额外扩展页数；默认 0。
   * @returns 0-based 闭区间；无页时 `end < start`。
   */
  getVisibleRange(scrollTop: number, viewportHeight: number, overscan = 0): VisiblePageRange {
    if (this.boxes.length === 0) return { start: 0, end: -1 };
    const top = Math.max(0, scrollTop);
    const bottom = top + Math.max(0, viewportHeight);
    const startIndex = this.getPageAtOffset(top);
    let endIndex = startIndex;
    while (
      endIndex + 1 < this.boxes.length &&
      this.boxes[endIndex + 1]!.top < bottom
    ) {
      endIndex += 1;
    }
    const extra = Math.max(0, Math.trunc(overscan));
    return {
      start: Math.max(0, startIndex - extra),
      end: Math.min(this.boxes.length - 1, endIndex + extra),
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

  /** 重建页盒与偏移。 */
  private rebuild(): void {
    const boxes: PageBox[] = [];
    let top = this.paddingPx;
    const scale = this.currentScale;
    // 记录重建前的页高：锚点里的“页内像素”是按旧布局量的，换回坐标时要按页高
    // 等比换算（见 {@link offsetForContentPoint}）。
    this.previousHeights = this.boxes.map((box) => box.height);
    this.previousWidth = this.width;
    const quarter = isQuarterTurn(this.currentRotation);
    // 内容宽度取最宽页，窄页相对它居中（混排不同尺寸的页时不贴左边）。
    let widest = 0;
    let widestUnit = 0;
    for (let index = 0; index < this.infos.length; index += 1) {
      const info = this.infos[index]!;
      const { widthMm, heightMm } = normalizePageSize(info);
      // 与 pdf.js 一致：页宽高以 96 DPI 的“单位尺寸”为准，实际尺寸 = 单位尺寸 × 倍率；
      // 缩放只改倍率，尺寸在每次取值时按倍率推导，避免“布局尺寸/视觉尺寸”两套坐标。
      const unitWidth = widthMm * MM_TO_CSS_PX;
      const unitHeight = heightMm * MM_TO_CSS_PX;
      // 尺寸取整到设备像素网格：幅面恰好覆盖整数个物理像素，画布位图与屏幕像素一一对应，
      // 整页不再落在半像素上（否则全页包括文字都会被重采样而均匀发虚）。
      const width = this.snapToDevicePixel(quarter ? unitHeight * scale : unitWidth * scale);
      const height = this.snapToDevicePixel(quarter ? unitWidth * scale : unitHeight * scale);
      const surfaceWidth = quarter ? height : width;
      const surfaceHeight = quarter ? width : height;
      widest = Math.max(widest, width);
      widestUnit = Math.max(widestUnit, unitWidth);
      boxes.push({
        index,
        pageNumber: index + 1,
        top,
        left: width,
        width,
        height,
        surfaceWidth,
        surfaceHeight,
        widthMm,
        heightMm,
        unitWidth,
        unitHeight,
      });
      // 页高已对齐设备像素，页间距与留白为整数 px，纵向累加不会产生小数偏移。
      top += height + this.gapPx;
    }
    const total =
      boxes.length === 0
        ? this.paddingPx * 2
        : top - this.gapPx + this.paddingPx;
    this.height = Math.max(total, this.paddingPx * 2);
    this.width = widest;
    this.unitWidth = widestUnit;
    this.maxUnitArea = boxes.reduce((area, box) => {
      return Math.max(area, box.unitWidth * box.unitHeight);
    }, 0);
    // 与 pdf.js 的 `.page { margin: 0 auto }` 等价：每页相对内容左缘居中；内容整体比可视区
    // 窄时的偏移由 {@link centeredOffset} 补。
    for (const box of boxes) {
      box.left = this.snapToDevicePixel((widest - box.width) / 2);
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
 * @returns {@link MIN_SCALE}..{@link MAX_SCALE}（25%..2500%）的倍率。
 */
function clampScale(value: number): number {
  return clamp(value, MIN_SCALE, MAX_SCALE);
}