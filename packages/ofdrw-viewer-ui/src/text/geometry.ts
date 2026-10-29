/**
 * 文本层几何计算（设计方案 §9.2 / §9.3）。
 *
 * 引擎 `getTextContent` 以 px 输出，坐标系为页面左上角、y 向下。文本层统一按
 * **96 DPI CSS px** 构建，再由页面容器的 `--scale-factor` 缩放；旋转由页面容器
 * 的 CSS transform 完成，坐标不重算。因此本模块做两件事：
 *
 * 1. 把任意输出 DPI 的 px 归一化到 96 DPI（`96 / content.dpi`）；
 * 2. 把 `TextItem.transform` 的“局部 mm → 页面 px”换算成 CSS 矩阵：局部坐标使用
 *    字号 px 为单位，故矩阵线性部分需要除以 `dpi / 25.4`（px/mm）。
 *
 * 不调用 Canvas 文字 API，也不修改页面绘制结果。
 */

import type {
  Matrix,
  TextContent,
  TextItem,
  TextQuad,
  TextRect,
} from '@ofdrw/ofdrw-viewer-engine';

/** 文本层坐标基准 DPI；与 `--scale-factor` 配合对齐 canvas。 */
export const TEXT_LAYER_DPI = 96;

/** 每英寸毫米数。 */
export const MM_PER_INCH = 25.4;

/** 96 DPI 下 1 mm 对应的 CSS px。 */
export const CSS_PX_PER_MM = TEXT_LAYER_DPI / MM_PER_INCH;

/** 单页文本层默认 span 上限；超出时降级/截断，避免异常页撑爆 DOM。 */
export const MAX_TEXT_LAYER_NODES = 100_000;

/** 文本 span 类型。 */
export type TextSpanKind = 'item' | 'char';

/** 文本 span 定位描述；由 `buildTextLayerSpecs` 生成，DOM 构建与测试共用。 */
export interface TextSpanSpec {
  /** item 级 span 或字符级 span。 */
  readonly kind: TextSpanKind;
  /** 文本内容。 */
  readonly text: string;
  /** CSS class：`ofd-text-item` / `ofd-text-char`。 */
  readonly className: 'ofd-text-item' | 'ofd-text-char';
  /** 文本框左边，单位 CSS px（96 DPI 坐标系）。 */
  readonly left: number;
  /** 文本框上边，单位 CSS px（96 DPI 坐标系）。 */
  readonly top: number;
  /** 文本框宽，单位 CSS px。 */
  readonly width: number;
  /** 文本框高，单位 CSS px。 */
  readonly height: number;
  /** 字号，单位 CSS px。 */
  readonly fontSize: number;
  /** 行高，单位 CSS px；与字高一致，保证选区高度贴合字符单元。 */
  readonly lineHeight: number;
  /** CSS transform（只含旋转/缩放，不含平移）。 */
  readonly transform: string;
  /** 文本基线方向，单位弧度；供选区按几何关系分行。 */
  readonly angle: number;
  /** 所属 TextItem 下标。 */
  readonly itemIndex: number;
  /** 字符下标；item span 为 undefined。 */
  readonly charIndex?: number;
}

/** 文本层构建结果。 */
export interface TextLayerSpecs {
  /** span 列表，按阅读/绘制顺序。 */
  readonly spans: readonly TextSpanSpec[];
  /** 未缩放页宽，单位 CSS px（96 DPI）。 */
  readonly width: number;
  /** 未缩放页高，单位 CSS px（96 DPI）。 */
  readonly height: number;
  /** span 对应的原始 DPI。 */
  readonly dpi: number;
  /** 是否因单页 span 上限而降级或截断。 */
  readonly truncated: boolean;
}

/** 构建文本层选项。 */
export interface BuildTextLayerOptions {
  /** 单页 span 上限；默认 {@link MAX_TEXT_LAYER_NODES}，0 表示不限。 */
  readonly maxNodes?: number;
}

/** 高亮框；单位 CSS px（96 DPI 坐标系）。 */
export interface HighlightBox {
  /** 左边，单位 px。 */
  readonly x: number;
  /** 上边，单位 px。 */
  readonly y: number;
  /** 宽，单位 px。 */
  readonly width: number;
  /** 高，单位 px。 */
  readonly height: number;
}

/** 字符引用。 */
export interface CharRef {
  /** TextItem 下标。 */
  readonly itemIndex: number;
  /** TextItem.chars 下标；无字符数据时为 -1。 */
  readonly charIndex: number;
}

/** 文字行：与可见区判定的最小构建单位。 */
export interface TextRow {
  /** 稳定行标识；`${首个 itemIndex}:${行序号}`，同一页内跨调用稳定。 */
  readonly id: string;
  /** 行在主轴法向上的起始位置，单位 px（96 DPI）；主轴水平时即 `y`。 */
  readonly top: number;
  /** 行在主轴法向上的结束位置，单位 px（96 DPI）；主轴水平时即 `y + height`。 */
  readonly bottom: number;
  /** 行内 span，按阅读方向排序。 */
  readonly spans: readonly TextSpanSpec[];
}

/** 行划分结果。 */
export interface TextRowLayout {
  /** 行列表；按主轴法向升序（阅读顺序）。 */
  readonly rows: readonly TextRow[];
  /** 主轴方向，单位弧度；主轴水平时为 0。 */
  readonly axisRowRad: number;
  /** 行带高度（该页全部 span 在主轴法向投影高度的中位数），单位 px，下限 1。 */
  readonly bandHeight: number;
  /** span 总数（行内 span 之和）。 */
  readonly spanCount: number;
  /** 是否因单页 span 上限而降级或截断。 */
  readonly truncated: boolean;
}

/** 页在 96 DPI 坐标系中的可见区间；主轴方向的上下界，单位 px。 */
export interface VisibleRange {
  /** 可见区在主轴方向的起点（含）。 */
  readonly top: number;
  /** 可见区在主轴方向的终点（含）。 */
  readonly bottom: number;
}

/** 屏幕坐标系下的矩形（`DOMRect` 的子集）；单位 px。 */
export interface RectLike {
  /** 左边。 */
  readonly left: number;
  /** 上边。 */
  readonly top: number;
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 96 DPI 坐标系下的页尺寸；单位 px。 */
export interface PageSize {
  /** 未旋转页宽。 */
  readonly width: number;
  /** 未旋转页高。 */
  readonly height: number;
}

/** 页旋转角度。 */
export type PageRotation = 0 | 90 | 180 | 270;

/** 行划分主轴判定使用的扇区数：每 15° 一个扇区。 */
const AXIS_SECTOR_RAD = Math.PI / 12;

/** 行带归并阈值系数：跨度超过 0.5 倍最大 span 高度即开新行。 */
const BAND_MERGE_RATIO = 0.5;

/**
 * 16 进制颜色/透明度无关的数值清洗。
 *
 * @param value 原值。
 * @param fallback 非法时回退值。
 * @returns 有限数值。
 */
function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 计算四边形轴对齐包围盒。
 *
 * @param quad 四边形的四个点（左上/右上/右下/左下）。
 * @returns 轴对齐矩形；单位与输入一致。
 */
export function quadBounds(quad: TextQuad): TextRect {
  const xs = quad.map((point) => finite(point.x));
  const ys = quad.map((point) => finite(point.y));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/**
 * 计算页面 px 到文本层 CSS px 的归一化系数。
 *
 * @param dpi 文本内容输出 DPI；非法或非正时按 96。
 * @returns 96 / dpi。
 */
export function cssScaleForDpi(dpi: number): number {
  const value = Number.isFinite(dpi) && dpi > 0 ? dpi : TEXT_LAYER_DPI;
  return TEXT_LAYER_DPI / value;
}

/**
 * 把 TextItem.transform 的线性部分换算为 CSS 矩阵。
 *
 * 局部坐标以字号 px 为单位，而引擎矩阵以 mm 为单位，故线性部分除以
 * `dpi / 25.4`；平移由 span 的 left/top 承担。
 *
 * @param transform 引擎矩阵。
 * @param dpi 文本输出 DPI。
 * @returns CSS 矩阵四个线性分量。
 */
export function cssLinearOf(
  transform: Matrix,
  dpi: number,
): { a: number; b: number; c: number; d: number } {
  const pxPerMm = (Number.isFinite(dpi) && dpi > 0 ? dpi : TEXT_LAYER_DPI) / MM_PER_INCH;
  return {
    a: finite(transform[0], 1) / pxPerMm,
    b: finite(transform[1]) / pxPerMm,
    c: finite(transform[2]) / pxPerMm,
    d: finite(transform[3], 1) / pxPerMm,
  };
}

/**
 * 判断 TextItem 是否需要拆成字符 span。
 *
 * 字符方向与 item 的主方向不一致（竖排/逐字旋转）时，单 span 无法对齐选区，
 * 改用字符级 quad 定位。
 *
 * @param item 文本项。
 * @returns 需要字符级 span 时 true。
 */
export function shouldSplitChars(item: TextItem): boolean {
  const chars = item.chars;
  if (!chars || chars.length === 0) return false;
  const base = Math.atan2(item.quad[1].y - item.quad[0].y, item.quad[1].x - item.quad[0].x);
  for (const char of chars) {
    const angle = Math.atan2(
      char.quad[1].y - char.quad[0].y,
      char.quad[1].x - char.quad[0].x,
    );
    if (Math.abs(normalizeAngle(angle - base)) > 0.05) return true;
  }
  return false;
}

/** 把弧度差归一到 -π..π。 */
function normalizeAngle(radians: number): number {
  let value = radians;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

/**
 * 生成 item 级 span 定位。
 *
 * 字符单元在局部坐标中的上边为 `-font-size`；先求该点再叠加矩阵，可保证旋转文字
 * 的文本框仍贴合字符单元。
 */
function itemSpanSpec(item: TextItem, itemIndex: number, dpi: number): TextSpanSpec {
  const k = cssScaleForDpi(dpi);
  const linear = cssLinearOf(item.transform, dpi);
  const size = Math.max(0, finite(item.size) * k);
  const originX = finite(item.origin.x) * k;
  const originY = finite(item.origin.y) * k;
  const left = originX - linear.c * size;
  const top = originY - linear.d * size;
  const advance = Math.max(0, finite(item.advance) * k);
  return {
    kind: 'item',
    text: item.text,
    className: 'ofd-text-item',
    left,
    top,
    width: Math.max(1, advance),
    height: Math.max(1, size),
    fontSize: Math.max(1, size),
    lineHeight: Math.max(1, size),
    transform: `matrix(${linear.a}, ${linear.b}, ${linear.c}, ${linear.d}, 0, 0)`,
    angle: Math.atan2(item.quad[1].y - item.quad[0].y, item.quad[1].x - item.quad[0].x),
    itemIndex,
  };
}

/** 生成字符级 span 定位；使用字符 quad 的左上点与旋转角。 */
function charSpanSpec(
  item: TextItem,
  itemIndex: number,
  charIndex: number,
  dpi: number,
): TextSpanSpec {
  const k = cssScaleForDpi(dpi);
  const char = item.chars![charIndex]!;
  const p0 = { x: char.quad[0].x * k, y: char.quad[0].y * k };
  const p1 = { x: char.quad[1].x * k, y: char.quad[1].y * k };
  const p3 = { x: char.quad[3].x * k, y: char.quad[3].y * k };
  const width = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const height = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  const fontSize = Math.max(1, height > 0 ? height : finite(item.size) * k);
  return {
    kind: 'char',
    text: char.text,
    className: 'ofd-text-char',
    left: p0.x,
    top: p0.y,
    width: Math.max(1, width),
    height: Math.max(1, height),
    fontSize,
    lineHeight: fontSize,
    transform: `rotate(${angle}rad)`,
    angle,
    itemIndex,
    charIndex,
  };
}

/**
 * 根据 TextContent 生成透明文本层 span 描述。
 *
 * 节点数超过上限时优先降级为 item 级 span；item 仍超限则截断并标记 `truncated`，
 * 避免单页异常文本撑爆 DOM。0 表示不限制。
 *
 * @param content 引擎文本内容。
 * @param options 节点上限。
 * @returns span 描述、未缩放页尺寸、DPI 与截断标记。
 */
export function buildTextLayerSpecs(
  content: TextContent,
  options: BuildTextLayerOptions = {},
): TextLayerSpecs {
  const maxNodes = Math.max(0, options.maxNodes ?? MAX_TEXT_LAYER_NODES);
  const items = content.items ?? [];
  const dpi = Number.isFinite(content.dpi) && content.dpi > 0 ? content.dpi : TEXT_LAYER_DPI;
  const k = cssScaleForDpi(dpi);
  const width = Math.max(0, finite(content.pageWidth) * k);
  const height = Math.max(0, finite(content.pageHeight) * k);

  // 先按字符级估算；超限则全部降级为 item 级，再决定是否截断。
  const split = items.map((item) => shouldSplitChars(item));
  let planned = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (!items[index]!.text) continue;
    planned += split[index] ? items[index]!.chars!.length : 1;
  }
  let effectiveSplit = split;
  let truncated = false;
  if (maxNodes > 0 && planned > maxNodes) {
    effectiveSplit = items.map(() => false);
    planned = items.reduce((total, item) => total + (item.text ? 1 : 0), 0);
    truncated = planned > maxNodes;
  }

  const spans: TextSpanSpec[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (maxNodes > 0 && spans.length >= maxNodes) break;
    const item = items[index]!;
    if (!item.text) continue;
    if (effectiveSplit[index]) {
      const chars = item.chars!;
      for (let charIndex = 0; charIndex < chars.length; charIndex += 1) {
        if (maxNodes > 0 && spans.length >= maxNodes) {
          truncated = true;
          break;
        }
        if (!chars[charIndex]!.text) continue;
        spans.push(charSpanSpec(item, index, charIndex, dpi));
      }
    } else {
      spans.push(itemSpanSpec(item, index, dpi));
    }
  }

  return { spans, width, height, dpi, truncated };
}

/**
 * 计算 span 在主法向上的旋转后高度（轴对齐包围盒高度），单位 px。
 *
 * @param span 文本 span。
 * @returns 投影高度；旋转角为 0 时等于 `span.height`。
 */
function spanNormalHeight(span: TextSpanSpec): number {
  return Math.abs(Math.sin(span.angle) * span.width) + Math.abs(Math.cos(span.angle) * span.height);
}

/** 参与主轴投影的二维位置；单位 px。 */
export interface ProjectablePoint {
  /** 横向位置（96 DPI CSS px）。 */
  readonly left: number;
  /** 纵向位置（96 DPI CSS px）。 */
  readonly top: number;
}

/**
 * 计算位置在行划分主轴法向上的投影坐标，单位 px。
 *
 * 与选区文本拼接的行内排序同式，保证行划分与选区共用同一套投影。
 *
 * @param point 二维位置（文本 span 或字符顶点）。
 * @param axisRowRad 主轴方向，单位弧度。
 * @returns 投影坐标；主轴水平时即 `point.top`。
 */
export function perpendicularOf(point: ProjectablePoint, axisRowRad: number): number {
  return -Math.sin(axisRowRad) * point.left + Math.cos(axisRowRad) * point.top;
}

/**
 * 计算位置在阅读推进方向上的投影坐标，单位 px。
 *
 * @param point 二维位置（文本 span 或字符顶点）。
 * @param axisRowRad 主轴方向，单位弧度。
 * @returns 阅读方向坐标；主轴水平时即 `point.left`。
 */
export function flowOf(point: ProjectablePoint, axisRowRad: number): number {
  return Math.cos(axisRowRad) * point.left + Math.sin(axisRowRad) * point.top;
}

/** 行内 flow 方向相邻区间的合并容差：间隙小于该值视为连续，单位 px。 */
export const FLOW_MERGE_EPSILON = 0.5;

/** 相邻行选区矩形之间保留的缝隙，单位 px。 */
export const SELECTION_ROW_GAP_PX = 1;

/** 主轴坐标系中的一维区间；单位 px。 */
export interface FlowInterval {
  /** 区间起点（含）。 */
  readonly min: number;
  /** 区间终点（含）。 */
  readonly max: number;
}

/** 字符四边形在行主轴坐标系中的投影矩形；单位 px。 */
export interface ProjectedRect {
  /** 阅读推进方向起点（含）。 */
  readonly flowMin: number;
  /** 阅读推进方向终点（含）。 */
  readonly flowMax: number;
  /** 行法向起点（含）。 */
  readonly perpMin: number;
  /** 行法向终点（含）。 */
  readonly perpMax: number;
}

/** 带行归属的主轴投影矩形；供行内合并与行间留缝使用。 */
export interface RowFlowRect extends ProjectedRect {
  /** 所属行的稳定标识。 */
  readonly rowId: string;
}

/** 反变换回页面坐标后的矩形；旋转角单位弧度。 */
export interface SelectionBox {
  /** 未旋转时的左边，单位 px。 */
  readonly left: number;
  /** 未旋转时的上边，单位 px。 */
  readonly top: number;
  /** 宽（沿 flow 方向），单位 px。 */
  readonly width: number;
  /** 高（沿行法向），单位 px。 */
  readonly height: number;
  /** 绕矩形中心旋转的角度，单位弧度；0 表示轴对齐。 */
  readonly rotationRad: number;
}

/**
 * 把字符四边形投影到行主轴坐标系。
 *
 * @param quad 字符四边形，四点顺序为左上/右上/右下/左下。
 * @param axisRowRad 主轴方向，单位弧度。
 * @returns 主轴坐标系中的投影矩形；单位 px。
 */
export function projectQuad(quad: TextQuad, axisRowRad: number): ProjectedRect {
  let flowMin = Number.POSITIVE_INFINITY;
  let flowMax = Number.NEGATIVE_INFINITY;
  let perpMin = Number.POSITIVE_INFINITY;
  let perpMax = Number.NEGATIVE_INFINITY;
  for (const point of quad) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const position = { left: point.x, top: point.y };
    const flow = flowOf(position, axisRowRad);
    const perp = perpendicularOf(position, axisRowRad);
    if (flow < flowMin) flowMin = flow;
    if (flow > flowMax) flowMax = flow;
    if (perp < perpMin) perpMin = perp;
    if (perp > perpMax) perpMax = perp;
  }
  if (!Number.isFinite(flowMin)) {
    return { flowMin: 0, flowMax: 0, perpMin: 0, perpMax: 0 };
  }
  return { flowMin, flowMax, perpMin, perpMax };
}

/**
 * 合并 flow 方向的区间并集。
 *
 * 排序后依次合并：与当前并集区间间隙不超过 {@link FLOW_MERGE_EPSILON}（含相等）
 * 视为连续，并入同一段；否则开启新段。
 *
 * @param intervals 区间列表；顺序不限。
 * @returns 按起点升序、互不相接的并集区间。
 */
export function mergeFlowIntervals(intervals: readonly FlowInterval[]): FlowInterval[] {
  const sorted = intervals
    .map((interval) => ({ min: finite(interval.min), max: finite(interval.max) }))
    .sort((first, second) => first.min - second.min || first.max - second.max);
  const merged: FlowInterval[] = [];
  for (const interval of sorted) {
    const current = merged[merged.length - 1];
    if (current && interval.min - current.max <= FLOW_MERGE_EPSILON) {
      merged[merged.length - 1] = {
        min: current.min,
        max: Math.max(current.max, interval.max),
      };
      continue;
    }
    merged.push({ min: interval.min, max: interval.max });
  }
  return merged;
}

/**
 * 对一行内的矩形收缩顶边。
 *
 * 每个矩形最多收缩自身高度的一半，因此净高不会小于原高度的一半；极薄矩形会
 * 自动少收缩，宁可让行间缝隙小于目标值，也不把矩形压成零高。
 *
 * @param rects 待原地修改的矩形列表。
 * @param indices 当前行矩形下标。
 * @param shrink 行级期望收缩量，单位 px。
 */
function shrinkRowTop(
  rects: RowFlowRect[],
  indices: readonly number[],
  shrink: number,
): void {
  if (!(shrink > 0)) return;
  for (const rectIndex of indices) {
    const rect = rects[rectIndex]!;
    const height = Math.max(0, rect.perpMax - rect.perpMin);
    const amount = Math.min(shrink, height / 2);
    if (!(amount > 0)) continue;
    rects[rectIndex] = { ...rect, perpMin: rect.perpMin + amount };
  }
}

/**
 * 为相邻行之间留出缝隙。
 *
 * 按 rowId 分组得到每行的法向范围，再按法向位置排序相邻行；如果两行之间（或重叠时）
 * 的间隙小于 `gapPx`，只收缩下行顶边，使间隙恰好为 `gapPx`。上行底边保持原始
 * 字符范围不变，避免文字底部出现未覆盖条带。下行每个矩形最多收缩自身高度的一半，
 * 因此矮矩形不会被行级收缩量压成零高；收缩不足时缝隙可小于 `gapPx`，但绝不向外
 * 扩张。同一行内的多个矩形只分别收缩，不跨 flow 合并。
 *
 * @param rects 投影矩形列表；可来自多行。
 * @param gapPx 目标缝隙，单位 px；非正时原样返回。
 * @returns 调整后的新数组，顺序与输入一致。
 */
export function applyRowGap(rects: readonly RowFlowRect[], gapPx: number): RowFlowRect[] {
  const result = rects.map((rect) => ({ ...rect }));
  if (!Number.isFinite(gapPx) || gapPx <= 0 || result.length === 0) return result;

  const groups = new Map<string, number[]>();
  for (let index = 0; index < result.length; index += 1) {
    const rowId = result[index]!.rowId;
    const indices = groups.get(rowId);
    if (indices) indices.push(index);
    else groups.set(rowId, [index]);
  }
  const rows = [...groups.entries()].map(([rowId, indices]) => {
    let perpMin = Number.POSITIVE_INFINITY;
    let perpMax = Number.NEGATIVE_INFINITY;
    for (const index of indices) {
      const rect = result[index]!;
      perpMin = Math.min(perpMin, rect.perpMin);
      perpMax = Math.max(perpMax, rect.perpMax);
    }
    return { rowId, indices, perpMin, perpMax };
  });
  rows.sort((first, second) => first.perpMin - second.perpMin);

  for (let index = 1; index < rows.length; index += 1) {
    const upper = rows[index - 1]!;
    const lower = rows[index]!;
    const gap = lower.perpMin - upper.perpMax;
    if (gap >= gapPx) continue;
    const needed = gapPx - gap;
    const lowerRoom = Math.max(0, (lower.perpMax - lower.perpMin) / 2);
    // 缝隙全部由下行顶边让出，上行底边保持与原始字符范围对齐。
    // 逐矩形按自身高度的一半封顶，避免矮矩形被行级收缩量压成零高。
    shrinkRowTop(result, lower.indices, Math.min(needed, lowerRoom));
  }
  return result;
}

/**
 * 把主轴坐标系中的矩形反变换回页面坐标。
 *
 * `axisRowRad` 为 0 时直接得到轴对齐矩形；非 0 时返回“未旋转矩形 + 绕中心旋转角”，
 * 由渲染侧用 CSS `rotate()` 绕中心旋转，保证旋转前后几何一致。
 *
 * @param rect 主轴坐标系中的矩形，单位 px。
 * @param axisRowRad 主轴方向，单位弧度。
 * @returns 页面坐标矩形；`rotationRad` 为绕中心旋转角，单位弧度。
 */
export function unprojectRect(rect: ProjectedRect, axisRowRad: number): SelectionBox {
  const width = Math.max(0, rect.flowMax - rect.flowMin);
  const height = Math.max(0, rect.perpMax - rect.perpMin);
  if (!Number.isFinite(axisRowRad) || axisRowRad === 0) {
    return {
      left: rect.flowMin,
      top: rect.perpMin,
      width,
      height,
      rotationRad: 0,
    };
  }
  const flowMid = (rect.flowMin + rect.flowMax) / 2;
  const perpMid = (rect.perpMin + rect.perpMax) / 2;
  const cos = Math.cos(axisRowRad);
  const sin = Math.sin(axisRowRad);
  const centerX = flowMid * cos - perpMid * sin;
  const centerY = flowMid * sin + perpMid * cos;
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
    rotationRad: axisRowRad,
  };
}

/**
 * 计算数值集合的中位数；空集合返回 0。
 *
 * @param values 数值集合，单位随调用方。
 * @returns 中位数。
 */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * 判定页级主行轴方向。
 *
 * 取不需要拆分字符的 item 的 quad 上边方向角，按“span 数量”加权统计 24 个 15° 扇区的众数；
 * 平票时取更接近水平（0°）的扇区。页内没有这类 item 时退化为全部 item；
 * 没有 item 时返回 0。
 *
 * @param items 文本项。
 * @returns 主轴方向，单位弧度，取值 `[0, 2π)` 的扇区中心角。
 */
function pageRowAxisRad(items: readonly TextItem[]): number {
  let candidates = items.filter((item) => !shouldSplitChars(item));
  if (candidates.length === 0) candidates = [...items];
  const votes = new Map<number, number>();
  for (const item of candidates) {
    const angle = Math.atan2(item.quad[1].y - item.quad[0].y, item.quad[1].x - item.quad[0].x);
    const sector = sectorOf(angle);
    votes.set(sector, (votes.get(sector) ?? 0) + (shouldSplitChars(item) ? item.chars!.length : 1));
  }
  let best: number | null = null;
  let bestVotes = -1;
  for (const [sector, count] of votes) {
    if (best === null || count > bestVotes) {
      best = sector;
      bestVotes = count;
      continue;
    }
    if (count === bestVotes && horizontalDistanceOf(sector) < horizontalDistanceOf(best)) {
      best = sector;
    }
  }
  return (best ?? 0) * AXIS_SECTOR_RAD;
}

/** 把方向角归一化为 15° 扇区下标，取值 0..23。 */
function sectorOf(angleRad: number): number {
  const normalized = Number.isFinite(angleRad) ? angleRad : 0;
  const sector = Math.round(normalized / AXIS_SECTOR_RAD) % 24;
  return (sector + 24) % 24;
}

/** 扇区到水平方向的角距离，单位弧度；用于平票时取更接近水平的扇区。 */
function horizontalDistanceOf(sector: number): number {
  return Math.min(sector, 24 - sector) * AXIS_SECTOR_RAD;
}

/** 行划分中间结构：带投影位置的 span。 */
interface ProjectedSpan {
  /** span 描述。 */
  readonly spec: TextSpanSpec;
  /** 属于该 span 的行序号；同一 item 的 span 强制同号。 */
  readonly group: number;
  /** 主轴法向投影位置，单位 px。 */
  readonly perp: number;
  /** 主轴法向投影高度，单位 px。 */
  readonly height: number;
}

/**
 * 把文本层 span 按阅读主轴划分成行。
 *
 * 规则（文本层按需构建设计 §3.2）：
 * 1. 页级主轴取非拆分 item 的方向角加权众数扇区（15° 一格），页内无这类 item 时用全部 item；
 * 2. 每个 span 投影到主轴法向，按投影升序扫描并做“重力行带”归并：与当前行带首个 span
 *    的距离不超过 0.5 倍最大 span 高度即并入，同一 item 的全部 span 强制同行；
 * 3. 行内按阅读推进方向排序（同位置再按字符下标、item 下标），行间按投影升序；
 * 4. 行 ID 为 `${行内最小 itemIndex}:${行序号}`。
 *
 * 页内全部 span 恰好出现一次、顺序稳定；空页返回空行表，不抛错。
 *
 * @param content 引擎文本内容。
 * @param options 单页 span 上限。
 * @returns 行列表、主轴方向、行带高度、span 数与截断标记。
 */
export function buildTextRows(
  content: TextContent,
  options: BuildTextLayerOptions = {},
): TextRowLayout {
  return buildTextRowsFromSpecs(buildTextLayerSpecs(content, options), content);
}

/**
 * 用已有的 span 描述划分文字行，避免重复生成 specs。
 *
 * @param specs 文本层 span 描述与页尺寸。
 * @param content 引擎文本内容（用于页级主轴判定）。
 * @returns 行列表、主轴方向、行带高度、span 数与截断标记。
 */
export function buildTextRowsFromSpecs(
  specs: TextLayerSpecs,
  content: TextContent,
): TextRowLayout {
  const spans = specs.spans;
  if (spans.length === 0) {
    return { rows: [], axisRowRad: 0, bandHeight: 1, spanCount: 0, truncated: specs.truncated };
  }
  const axisRowRad = pageRowAxisRad(content.items ?? []);
  const bandHeight = Math.max(1, medianOf(spans.map((span) => spanNormalHeight(span))));

  const projected: ProjectedSpan[] = spans.map((spec) => ({
    spec,
    group: spec.itemIndex,
    perp: perpendicularOf(spec, axisRowRad),
    height: spanNormalHeight(spec),
  }));
  projected.sort((a, b) => a.perp - b.perp);

  const bands: ProjectedSpan[][] = [];
  /** 每个 item 首次出现时进入的行带下标；后续同 item span 一律并入。 */
  const groupBand = new Map<number, number>();
  let current: ProjectedSpan[] = [];
  for (const entry of projected) {
    const forced = groupBand.get(entry.group);
    if (forced !== undefined) {
      bands[forced]!.push(entry);
      continue;
    }
    const first = current[0];
    const maxHeight = Math.max(first?.height ?? 0, entry.height);
    if (first && entry.perp - first.perp <= BAND_MERGE_RATIO * maxHeight) {
      current.push(entry);
      groupBand.set(entry.group, bands.length);
      continue;
    }
    current = [entry];
    groupBand.set(entry.group, bands.length);
    bands.push(current);
  }

  const rows: TextRow[] = bands.map((band, index) => {
    const ordered = band.slice().sort((a, b) => {
      const flowDiff = flowOf(a.spec, axisRowRad) - flowOf(b.spec, axisRowRad);
      if (Math.abs(flowDiff) > 1e-9) return flowDiff;
      const charDiff = (a.spec.charIndex ?? -1) - (b.spec.charIndex ?? -1);
      if (charDiff !== 0) return charDiff;
      return a.spec.itemIndex - b.spec.itemIndex;
    });
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let firstItemIndex = Number.POSITIVE_INFINITY;
    for (const entry of band) {
      top = Math.min(top, entry.perp);
      bottom = Math.max(bottom, entry.perp + entry.height);
      firstItemIndex = Math.min(firstItemIndex, entry.spec.itemIndex);
    }
    return {
      id: `${firstItemIndex}:${index}`,
      top,
      bottom,
      spans: ordered.map((entry) => entry.spec),
    };
  });

  return {
    rows,
    axisRowRad,
    bandHeight,
    spanCount: spans.length,
    truncated: specs.truncated,
  };
}

/**
 * 按字符引用查找所属行标识。
 *
 * 匹配方式与文本层 `lastRowBottomOf()` 一致：item 级 span（无 `charIndex`）对应整个
 * item 的任意字符，字符级 span 要求 `charIndex` 相等。
 *
 * @param rows 行划分结果。
 * @param ref 字符引用。
 * @returns 行标识；行表为空或找不到所属行时返回 null。
 */
export function rowIdOfRef(rows: readonly TextRow[], ref: CharRef): string | null {
  const row = rows.find((candidate) =>
    candidate.spans.some(
      (span) =>
        span.itemIndex === ref.itemIndex &&
        (span.charIndex === undefined || span.charIndex === ref.charIndex),
    ),
  );
  return row?.id ?? null;
}

/**
 * 判断矩形是否为空或不可测量（宽或高不为正的有限数）。
 *
 * @param rect 屏幕矩形。
 * @returns 不可测量时 true。
 */
export function isRectUnmeasurable(rect: RectLike): boolean {
  return !(
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * 把页元素包围盒内的相对位置映射到 96 DPI 页内坐标。
 *
 * 页容器以中心为原点、正角度在屏幕上顺时针旋转，页内容随之旋转：`rotation` 为 90° 时
 * 内容原点落在包围盒右上角，页内 `y` 增大对应屏幕 `x` 减小；270° 时内容原点落在包围盒
 * 左下角，页内 `y` 增大对应屏幕 `x` 增大。
 *
 * @param sx 包围盒内横向比例，0..1。
 * @param sy 包围盒内纵向比例，0..1。
 * @param page 未旋转页尺寸，单位 px。
 * @param rotation 页旋转角度。
 * @returns 96 DPI 页面坐标，单位 px。
 */
function toPagePoint(
  sx: number,
  sy: number,
  page: PageSize,
  rotation: PageRotation,
): [number, number] {
  const rx = sx - 0.5;
  const ry = sy - 0.5;
  switch (rotation) {
    case 90:
      return [(-ry + 0.5) * page.width, (rx + 0.5) * page.height];
    case 180:
      return [(-rx + 0.5) * page.width, (-ry + 0.5) * page.height];
    case 270:
      return [(ry + 0.5) * page.width, (-rx + 0.5) * page.height];
    default:
      return [(rx + 0.5) * page.width, (ry + 0.5) * page.height];
  }
}

/**
 * 求出 96 DPI 页内点在页元素包围盒内的相对位置（{@link toPagePoint} 的逆）。
 *
 * @param x 96 DPI 页面横坐标，单位 px。
 * @param y 96 DPI 页面纵坐标，单位 px。
 * @param page 未旋转页尺寸，单位 px。
 * @param rotation 页旋转角度。
 * @returns 包围盒内比例 `[sx, sy]`，0..1（可越界）。
 */
function toBoxRatio(
  x: number,
  y: number,
  page: PageSize,
  rotation: PageRotation,
): [number, number] {
  const u = x / page.width - 0.5;
  const v = y / page.height - 0.5;
  switch (rotation) {
    case 90:
      return [-v + 0.5, u + 0.5];
    case 180:
      return [-u + 0.5, -v + 0.5];
    case 270:
      return [v + 0.5, -u + 0.5];
    default:
      return [u + 0.5, v + 0.5];
  }
}

/**
 * 由页元素与滚动容器在屏幕上的矩形，求出可见区在 96 DPI **页内 y 方向**上的区间。
 *
 * `TextRow.top/bottom` 以页内 y 表达（行划分主轴为水平），可见区因此只换算为页内 y 区间：
 * 取两者交集，把交集四角按页旋转映射回 96 DPI 页内坐标后取 y 的最小/最大值（180° 时屏幕
 * 上部对应页内下部，方向自然反转）。旋转 90°/270° 时屏幕纵向对应页内 x，行（按页内 y
 * 分组）没有可见边界，返回页内 y 全幅，由调用方按整页构建——这是已知限制。
 *
 * @param pageRect 页元素屏幕矩形，单位 px。
 * @param viewportRect 滚动容器屏幕矩形，单位 px。
 * @param page 未旋转页尺寸，单位 px（96 DPI）。
 * @param rotation 页旋转角度。
 * @returns 页内 y 区间；页不可见时返回 null。
 */
export function visibleYRangeOf(
  pageRect: RectLike,
  viewportRect: RectLike,
  page: PageSize,
  rotation: PageRotation,
): VisibleRange | null {
  if (isRectUnmeasurable(pageRect) || isRectUnmeasurable(viewportRect)) return null;
  if (page.width <= 0 || page.height <= 0) return null;
  if (rotation === 90 || rotation === 270) {
    // 屏幕纵向对应页内 x：页内 y 方向没有可见边界，按整页处理。
    return { top: 0, bottom: page.height };
  }
  const left = Math.max(pageRect.left, viewportRect.left);
  const right = Math.min(pageRect.left + pageRect.width, viewportRect.left + viewportRect.width);
  const top = Math.max(pageRect.top, viewportRect.top);
  const bottom = Math.min(pageRect.top + pageRect.height, viewportRect.top + viewportRect.height);
  if (right <= left || bottom <= top) return null;

  // 分母用屏幕包围盒尺寸：旋转 180° 时包围盒宽高与未旋转页宽高一致，映射为绕中心反向。
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const [screenX, screenY] of [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ] as const) {
    const boxX = (screenX - pageRect.left) / pageRect.width;
    const boxY = (screenY - pageRect.top) / pageRect.height;
    const [, y] = toPagePoint(boxX, boxY, page, rotation);
    start = Math.min(start, y);
    end = Math.max(end, y);
  }
  return { top: start, bottom: end };
}

/**
 * 计算 96 DPI 页内点在屏幕上的纵坐标；用于页内滚动定位。
 *
 * @param pageRect 页元素包围盒，单位屏幕 px。
 * @param x 96 DPI 页面横坐标，单位 px。
 * @param y 96 DPI 页面纵坐标，单位 px。
 * @param page 未旋转页尺寸，单位 px（96 DPI）。
 * @param rotation 页旋转角度。
 * @returns 屏幕纵坐标，单位 px；不可测量时返回 NaN。
 */
export function screenYOfPagePoint(
  pageRect: RectLike,
  x: number,
  y: number,
  page: PageSize,
  rotation: PageRotation,
): number {
  if (isRectUnmeasurable(pageRect) || page.width <= 0 || page.height <= 0) return Number.NaN;
  const [, sy] = toBoxRatio(x, y, page, rotation);
  return pageRect.top + sy * pageRect.height;
}



/**
 * 把文本里的字符引用转成高亮框并合并同一行的相邻框。
 *
 * @param content 文本内容。
 * @param refs 按阅读顺序的字符引用。
 * @returns 高亮框，单位 CSS px（96 DPI）。
 */
export function highlightBoxesForRefs(
  content: TextContent,
  refs: readonly CharRef[],
): HighlightBox[] {
  const k = cssScaleForDpi(content.dpi);
  const items = content.items ?? [];
  const boxes: HighlightBox[] = [];
  for (const ref of refs) {
    const item = items[ref.itemIndex];
    if (!item) continue;
    const char = ref.charIndex >= 0 ? item.chars?.[ref.charIndex] : undefined;
    const quad = char?.quad ?? item.quad;
    const bounds = quadBounds(quad);
    const box: HighlightBox = {
      x: bounds.x * k,
      y: bounds.y * k,
      width: Math.max(0, bounds.width * k),
      height: Math.max(0, bounds.height * k),
    };
    mergeHighlightBox(boxes, box);
  }
  return boxes;
}

/** 合并同一行（y 接近、水平距离小）的相邻高亮框。 */
function mergeHighlightBox(boxes: HighlightBox[], box: HighlightBox): void {
  const previous = boxes[boxes.length - 1];
  if (!previous) {
    boxes.push(box);
    return;
  }
  const height = Math.max(1, Math.min(previous.height, box.height));
  const sameLine = Math.abs(previous.y - box.y) <= height * 0.5;
  const gap = box.x - (previous.x + previous.width);
  const touching = gap >= -height * 0.2 && gap <= height * 0.6;
  const overlap = box.x >= previous.x && box.x <= previous.x + previous.width;
  if (sameLine && (touching || overlap)) {
    const right = Math.max(previous.x + previous.width, box.x + box.width);
    const bottom = Math.max(previous.y + previous.height, box.y + box.height);
    const top = Math.min(previous.y, box.y);
    boxes[boxes.length - 1] = {
      x: Math.min(previous.x, box.x),
      y: top,
      width: Math.max(0, right - Math.min(previous.x, box.x)),
      height: Math.max(0, bottom - top),
    };
    return;
  }
  boxes.push(box);
}

/**
 * 判断字符是否为 CJK（选择/复制时不额外插入空格）。
 *
 * @param char 单个字符。
 * @returns CJK 或全角标点时 true。
 */
export function isCjkChar(char: string): boolean {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 规范化选区文本：合并行内多余空白、保留段落/跨行换行。
 *
 * @param raw 原始文本。
 * @returns 规范化文本。
 */
export function normalizeSelectionText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const trimmed = lines.map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim());
  while (trimmed.length > 0 && trimmed[0] === '') trimmed.shift();
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  const output: string[] = [];
  for (const line of trimmed) {
    if (line === '' && output[output.length - 1] === '') continue;
    output.push(line);
  }
  return output.join('\n');
}

/**
 * 把毫米换算为 96 DPI CSS px。
 *
 * @param mm 毫米。
 * @returns CSS px。
 */
export function mmToCssPx(mm: number): number {
  return finite(mm) * CSS_PX_PER_MM;
}