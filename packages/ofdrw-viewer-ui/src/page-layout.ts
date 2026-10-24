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
import type { Rotation, VisiblePageRange } from './state';

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
  /** 初始旋转，默认 0。 */
  readonly rotation?: Rotation;
  /** 页间距，单位 px；默认 8。 */
  readonly gap?: number;
  /** 首尾留白，单位 px；默认 24。 */
  readonly padding?: number;
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

  /**
   * @param options 页信息与初始缩放/旋转。
   */
  constructor(options: PageLayoutOptions) {
    this.infos = options.pageInfos;
    this.currentScale = sanitizeScale(options.scale ?? 1);
    this.currentRotation = options.rotation ?? 0;
    this.gapPx = Math.max(0, options.gap ?? DEFAULT_PAGE_GAP);
    this.paddingPx = Math.max(0, options.padding ?? DEFAULT_PAGE_PADDING);
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

  /** 全部排版盒（只读）。 */
  getBoxes(): readonly PageBox[] {
    return this.boxes;
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
    const next = sanitizeScale(scale);
    if (next === this.currentScale) return;
    this.currentScale = next;
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
    const quarter = isQuarterTurn(this.currentRotation);
    for (let index = 0; index < this.infos.length; index += 1) {
      const info = this.infos[index]!;
      const { widthMm, heightMm } = normalizePageSize(info);
      const surfaceWidth = widthMm * MM_TO_CSS_PX * scale;
      const surfaceHeight = heightMm * MM_TO_CSS_PX * scale;
      const width = quarter ? surfaceHeight : surfaceWidth;
      const height = quarter ? surfaceWidth : surfaceHeight;
      boxes.push({
        index,
        pageNumber: index + 1,
        top,
        width,
        height,
        surfaceWidth,
        surfaceHeight,
        widthMm,
        heightMm,
      });
      top += height + this.gapPx;
    }
    const total =
      boxes.length === 0
        ? this.paddingPx * 2
        : top - this.gapPx + this.paddingPx;
    this.boxes = boxes;
    this.height = Math.max(total, this.paddingPx * 2);
  }
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