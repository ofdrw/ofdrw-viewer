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

/** 单页文本层节点上限（设计方案 §9.2）。 */
export const MAX_TEXT_LAYER_NODES = 5000;

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
  /** 是否因节点上限截断。 */
  readonly truncated: boolean;
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

/** 构建文本层选项。 */
export interface BuildTextLayerOptions {
  /** 节点上限；默认 {@link MAX_TEXT_LAYER_NODES}，0 表示不限。 */
  readonly maxNodes?: number;
}

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
 * 避免 1000 页文档中单页异常文本撑爆 DOM。
 *
 * @param content 引擎文本内容。
 * @param options 节点上限。
 * @returns span 描述、未缩放页尺寸与 DPI。
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

  const split = items.map((item) => shouldSplitChars(item));
  let planned = 0;
  for (let index = 0; index < items.length; index += 1) {
    planned += split[index] ? items[index]!.chars!.length : 1;
  }
  let effectiveSplit = split;
  let truncated = false;
  if (maxNodes > 0 && planned > maxNodes) {
    // 先合并为 item span；仍超限才截断 item。
    effectiveSplit = items.map(() => false);
    planned = items.length;
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