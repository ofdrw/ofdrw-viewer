/**
 * 模型层 Paint 解码：基本颜色、颜色空间、轴向/径向渐变、Gouraud、底纹。
 *
 * 只把 XML 转成可序列化模型；不解析资源路径、不加载字体图片、不依赖渲染器。
 * 底纹 CellContent 需要页面块解码器，通过 `PaintDecodeContext.decodePageBlock`
 * 注入，避免 model 内部循环依赖。
 */

import type { Rgba } from '../common/types';
import type { XmlNode } from '../xml/types';
import type {
  AxialShade,
  ColorSpaceDef,
  GouraudShade,
  PageBlock,
  Paint,
  Pattern,
  RadialShade,
  ResourceId,
} from './types';
import { normalizeResourceId } from './ids';
import { badNumberHandler, child, children, emitWarning } from './decode-utils';
import type { DecodeWarningContext } from './decode-utils';
import { attr, attrAny, childText, numberAttr, parseMatrix, parsePoint } from './decode-utils';

/** Paint 解码上下文。 */
export interface PaintDecodeContext extends DecodeWarningContext {
  /** 已解析的颜色空间表（页级/文档级合并后）。 */
  colorSpaces?: ReadonlyMap<ResourceId, ColorSpaceDef>;
  /** DefaultCS 颜色空间 ID。 */
  defaultColorSpaceId?: ResourceId;
  /** 内联底纹按 ID 收集（部分生成器会给 Pattern 写 ID）。 */
  patterns?: Map<ResourceId, Pattern>;
  /** 底纹 CellContent 解码器；由 content.ts 注入。 */
  decodePageBlock?: (node: XmlNode, context: DecodeWarningContext) => PageBlock;
}

const HEX_TOKEN = /^#([0-9a-fA-F]+)$/;
const NUMBER_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 把颜色文本拆成 token；支持空白与逗号分隔。
 *
 * @param raw 原始文本。
 * @returns token 数组。
 */
function tokenize(raw: string): string[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .filter((token) => token.length > 0);
}

/**
 * 解析单个颜色通道 token。
 *
 * - `#RRGGBB`/`#RGB` 作为整色处理，由调用方优先识别；
 * - `#F`/`#FF` 视为该通道按 8 位归一化的十六进制值；
 * - 普通数字按 `BitsPerComponent` 缩放。
 *
 * @param token 颜色 token。
 * @param bitsPerComponent 每通道位数，1/2/4/8/16。
 * @param context warning 上下文。
 * @returns 归一化到 0..255 的通道值；非法时返回 0。
 */
function parseChannel(token: string, bitsPerComponent: number, context?: DecodeWarningContext): number {
  const hex = HEX_TOKEN.exec(token);
  if (hex) {
    const digits = hex[1] as string;
    const value = Number.parseInt(digits, 16);
    if (!Number.isFinite(value)) {
      emitWarning(context, 'W_BAD_NUMBER', `颜色十六进制通道非法：${token}`);
      return 0;
    }
    const denominator = digits.length >= 2 ? 255 : 15;
    return clampByte((value / denominator) * 255);
  }
  if (!NUMBER_TOKEN.test(token)) {
    emitWarning(context, 'W_BAD_NUMBER', `颜色通道非法：${JSON.stringify(token)}`);
    return 0;
  }
  const value = Number(token);
  const bits = validBits(bitsPerComponent);
  const max = 2 ** bits - 1;
  return clampByte((value / max) * 255);
}

/** 合法位数。 */
function validBits(bits: number | undefined): number {
  return bits === 1 || bits === 2 || bits === 4 || bits === 8 || bits === 16 ? bits : 8;
}

/** 四舍五入并夹到 0..255。 */
function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** 解析 Alpha（0..255，默认 255）。 */
function parseAlpha(node: XmlNode, context?: DecodeWarningContext): number {
  const value = numberAttr(node, 'Alpha', 255, context, 'Alpha');
  return clampByte(value);
}

/**
 * 按颜色空间把通道值转换为 RGBA；CMYK 使用设计方案 9.3 的近似公式。
 *
 * @param channels 归一化到 0..255 的通道值。
 * @param type 颜色空间类型。
 * @param alpha Alpha，0..255。
 * @returns RGBA。
 */
function channelsToRgba(channels: readonly number[], type: ColorSpaceDef['type'], alpha: number): Rgba {
  if (type === 'GRAY') {
    const gray = clampByte(channels[0] ?? 0);
    return { r: gray, g: gray, b: gray, a: alpha };
  }
  if (type === 'CMYK') {
    const c = (channels[0] ?? 0) / 255;
    const m = (channels[1] ?? 0) / 255;
    const y = (channels[2] ?? 0) / 255;
    const k = (channels[3] ?? 0) / 255;
    return {
      r: clampByte(255 * (1 - c) * (1 - k)),
      g: clampByte(255 * (1 - m) * (1 - k)),
      b: clampByte(255 * (1 - y) * (1 - k)),
      a: alpha,
    };
  }
  return {
    r: clampByte(channels[0] ?? 0),
    g: clampByte(channels[1] ?? 0),
    b: clampByte(channels[2] ?? 0),
    a: alpha,
  };
}

/**
 * 解析 `#RRGGBB`/`#RGB` 整色 token。
 *
 * @param token 原始 token。
 * @returns RGB 通道；不是整色形式时返回 undefined。
 */
function parseFullHexColor(token: string): [number, number, number] | undefined {
  const hex = HEX_TOKEN.exec(token);
  if (!hex) return undefined;
  const digits = hex[1] as string;
  if (digits.length === 3) {
    const r = Number.parseInt(digits[0] as string, 16);
    const g = Number.parseInt(digits[1] as string, 16);
    const b = Number.parseInt(digits[2] as string, 16);
    return [r * 17, g * 17, b * 17];
  }
  if (digits.length === 6) {
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ];
  }
  return undefined;
}

/**
 * 解析颜色空间引用。
 *
 * @param raw ColorSpace 属性值。
 * @param context Paint 上下文。
 * @returns 颜色空间定义；未引用/找不到时返回 undefined（回退 RGB 8 位）。
 */
function resolveColorSpace(
  raw: string | undefined,
  context: PaintDecodeContext,
): ColorSpaceDef | undefined {
  const requested = raw !== undefined ? normalizeResourceId(raw) : context.defaultColorSpaceId;
  if (!requested) return undefined;
  const found = context.colorSpaces?.get(normalizeResourceId(requested));
  if (!found) {
    emitWarning(context, 'W_BAD_NUMBER', `未知 ColorSpace：${requested}，按 RGB 8 位处理`);
  }
  return found;
}

/**
 * 解码基本颜色（`FillColor`/`StrokeColor`/`Color`/`BackColor`/`BorderColor`/调色板 CV）。
 *
 * @param node XML 节点；读取 `Value`/`ColorSpace`/`Alpha`/`Index`。
 * @param context Paint 上下文。
 * @returns RGBA；完全缺失时返回黑色不透明。
 */
export function decodeBasicColor(node: XmlNode, context: PaintDecodeContext): Rgba {
  const colorSpace = resolveColorSpace(attr(node, 'ColorSpace'), context);
  const alpha = parseAlpha(node, context);
  const bits = validBits(colorSpace?.bitsPerComponent);

  const indexRaw = attr(node, 'Index');
  if (indexRaw !== undefined) {
    const index = Number.parseInt(indexRaw.trim(), 10);
    const palette = colorSpace?.palette;
    if (!Number.isFinite(index) || index < 0 || !palette || index >= palette.length) {
      emitWarning(
        context,
        'W_BAD_NUMBER',
        `调色板 Index 越界：${JSON.stringify(indexRaw)}（调色板 ${palette?.length ?? 0} 色），按黑色处理`,
      );
      return { r: 0, g: 0, b: 0, a: alpha };
    }
    const entry = palette[index] as Rgba;
    return { r: entry.r, g: entry.g, b: entry.b, a: alpha };
  }

  const rawValue = attr(node, 'Value');
  if (rawValue === undefined || rawValue.trim().length === 0) {
    // CT_Color 缺省为黑色；Alpha 仍生效。
    return { r: 0, g: 0, b: 0, a: alpha };
  }
  const tokens = tokenize(rawValue);
  const fullHex = tokens.length > 0 ? parseFullHexColor(tokens[0] as string) : undefined;
  if (fullHex) {
    return { r: fullHex[0], g: fullHex[1], b: fullHex[2], a: alpha };
  }
  const channels = tokens.map((token) => parseChannel(token, bits, context));
  return channelsToRgba(channels, colorSpace?.type ?? 'RGB', alpha);
}

/**
 * 解码颜色空间资源。
 *
 * @param node `ColorSpace` 节点。
 * @param context warning 上下文。
 * @returns 颜色空间定义；缺少 ID 时返回 `id=''`（调用方决定是否跳过）。
 */
export function decodeColorSpace(
  node: XmlNode,
  context?: DecodeWarningContext,
): ColorSpaceDef {
  const id = normalizeResourceId(attr(node, 'ID'));
  if (!id) emitWarning(context, 'W_BAD_NUMBER', 'ColorSpace 缺少 ID');
  const typeRaw = (attr(node, 'Type') ?? 'RGB').trim().toUpperCase();
  let type: ColorSpaceDef['type'];
  if (typeRaw === 'GRAY' || typeRaw === 'GREY') type = 'GRAY';
  else if (typeRaw === 'CMYK') type = 'CMYK';
  else {
    type = 'RGB';
    if (typeRaw !== 'RGB') {
      emitWarning(context, 'W_BAD_NUMBER', `未知 ColorSpace Type：${typeRaw}，按 RGB 处理`);
    }
  }
  const bits = validBits(numberAttr(node, 'BitsPerComponent', 8, context, 'BitsPerComponent'));
  const paletteNode = child(node, 'Palette');
  const palette: Rgba[] = [];
  if (paletteNode) {
    for (const cv of children(paletteNode, 'CV')) {
      const raw = (cv.text ?? '').trim();
      const tokens = tokenize(raw);
      const fullHex = tokens.length > 0 ? parseFullHexColor(tokens[0] as string) : undefined;
      if (fullHex) {
        palette.push({ r: fullHex[0], g: fullHex[1], b: fullHex[2], a: 255 });
        continue;
      }
      const channels = tokens.map((token) => parseChannel(token, bits, context));
      palette.push(channelsToRgba(channels, type, 255));
    }
  }
  return palette.length > 0 ? { id, type, bitsPerComponent: bits, palette } : { id, type, bitsPerComponent: bits };
}

/** 解析 MapType。 */
function parseMapType(raw: string | undefined, context: DecodeWarningContext): AxialShade['mapType'] {
  if (raw === undefined) return 'Direct';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'direct') return 'Direct';
  if (normalized === 'repeat') return 'Repeat';
  if (normalized === 'reflect') return 'Reflect';
  emitWarning(context, 'W_BAD_NUMBER', `MapType 非法：${JSON.stringify(raw)}，回退 Direct`);
  return 'Direct';
}

/** 解析 Extend（0..3）。 */
function parseExtend(raw: string | undefined, context: DecodeWarningContext): 0 | 1 | 2 | 3 {
  if (raw === undefined) return 0;
  const value = Number(raw.trim());
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  emitWarning(context, 'W_BAD_NUMBER', `Extend 非法：${JSON.stringify(raw)}，回退 0`);
  return 0;
}

/** 颜色段中间结果。 */
interface SegmentCandidate {
  position?: number;
  color: Rgba;
}

/**
 * 解码渐变颜色段，并按规则补齐/夹紧位置。
 *
 * 规则（设计方案 13.2）：第一个默认 0、最后一个默认 1；中间缺失按区间均分；
 * 保证单调不减，越界 clamp 并 warning。
 *
 * @param shadeNode 渐变节点。
 * @param context Paint 上下文。
 * @returns 颜色段数组（position 单调、0..1）。
 */
function decodeSegments(shadeNode: XmlNode, context: PaintDecodeContext): { position: number; color: Rgba }[] {
  const rawSegments: SegmentCandidate[] = [];
  for (const segment of children(shadeNode, 'Segment')) {
    const positionRaw = attr(segment, 'Position');
    let position: number | undefined;
    if (positionRaw !== undefined) {
      const parsed = Number(positionRaw.trim());
      if (Number.isFinite(parsed)) position = parsed;
      else emitWarning(context, 'W_BAD_NUMBER', `Segment Position 非法：${JSON.stringify(positionRaw)}`);
    }
    const colorNode = child(segment, 'Color');
    const color = colorNode ? decodeBasicColor(colorNode, context) : { r: 0, g: 0, b: 0, a: 255 };
    rawSegments.push({ position, color });
  }
  const count = rawSegments.length;
  if (count === 0) return [];
  const positions: (number | undefined)[] = rawSegments.map((item) => item.position);
  if (count === 1) {
    positions[0] = clamp01(positions[0] ?? 0);
  } else {
    if (positions[0] === undefined) positions[0] = 0;
    if (positions[count - 1] === undefined) positions[count - 1] = 1;
    let previousAnchor = 0;
    for (let index = 1; index < count; index += 1) {
      if (positions[index] === undefined) continue;
      const start = positions[previousAnchor] as number;
      const end = positions[index] as number;
      const gap = index - previousAnchor;
      for (let step = 1; step < gap; step += 1) {
        positions[previousAnchor + step] = start + ((end - start) * step) / gap;
      }
      previousAnchor = index;
    }
  }
  let previous = -Infinity;
  const result: { position: number; color: Rgba }[] = [];
  for (let index = 0; index < count; index += 1) {
    const rawPosition = positions[index] as number;
    let position = clamp01(rawPosition);
    if (position !== rawPosition) {
      emitWarning(context, 'W_BAD_NUMBER', `Segment Position 越界：${rawPosition}，已夹紧`);
    }
    if (position < previous) {
      emitWarning(context, 'W_BAD_NUMBER', `Segment Position 非单调：${position} < ${previous}，已夹紧`);
      position = previous;
    }
    previous = position;
    result.push({ position, color: (rawSegments[index] as SegmentCandidate).color });
  }
  return result;
}

/** 夹到 0..1。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * 解码轴向渐变。
 *
 * @param node `AxialShd` 节点。
 * @param context Paint 上下文。
 * @returns 轴向渐变模型；坐标位于对象空间（通常 mm）。
 */
export function decodeAxialShade(node: XmlNode, context: PaintDecodeContext): AxialShade {
  const start = parsePoint(attr(node, 'StartPoint'), { x: 0, y: 0 }, context, 'StartPoint');
  const end = parsePoint(attr(node, 'EndPoint'), { x: 0, y: 0 }, context, 'EndPoint');
  const mapType = parseMapType(attr(node, 'MapType'), context);
  const mapUnitRaw = attr(node, 'MapUnit');
  let mapUnit: number | undefined;
  if (mapUnitRaw !== undefined) {
    const parsed = Number(mapUnitRaw.trim());
    if (Number.isFinite(parsed) && parsed > 0) mapUnit = parsed;
    else emitWarning(context, 'W_BAD_NUMBER', `MapUnit 非法：${JSON.stringify(mapUnitRaw)}`);
  }
  return { start, end, mapType, mapUnit, extend: parseExtend(attr(node, 'Extend'), context), segments: decodeSegments(node, context) };
}

/**
 * 解码径向渐变（v1 只保留模型，渲染阶段降级）。
 *
 * @param node `RadialShd` 节点。
 * @param context Paint 上下文。
 * @returns 径向渐变模型；坐标/半径位于对象空间。
 */
export function decodeRadialShade(node: XmlNode, context: PaintDecodeContext): RadialShade {
  const start = parsePoint(attr(node, 'StartPoint'), { x: 0, y: 0 }, context, 'StartPoint');
  const end = parsePoint(attr(node, 'EndPoint'), { x: 0, y: 0 }, context, 'EndPoint');
  const startRadius = numberAttr(node, 'StartRadius', 0, context, 'StartRadius');
  const endRadius = numberAttr(node, 'EndRadius', 0, context, 'EndRadius');
  if (endRadius <= 0) emitWarning(context, 'W_BAD_NUMBER', 'EndRadius 缺失或非正，径向渐变可能无效');
  const mapUnitRaw = attr(node, 'MapUnit');
  let mapUnit: number | undefined;
  if (mapUnitRaw !== undefined) {
    const parsed = Number(mapUnitRaw.trim());
    if (Number.isFinite(parsed) && parsed > 0) mapUnit = parsed;
    else emitWarning(context, 'W_BAD_NUMBER', `MapUnit 非法：${JSON.stringify(mapUnitRaw)}`);
  }
  return {
    start,
    startRadius,
    end,
    endRadius,
    mapType: parseMapType(attr(node, 'MapType'), context),
    mapUnit,
    extend: parseExtend(attr(node, 'Extend'), context),
    segments: decodeSegments(node, context),
  };
}

/**
 * 解码 Gouraud / LaGouraud 网格渐变。
 *
 * @param node `GouraudShd` 或 `LaGouraudShd` 节点。
 * @param context Paint 上下文。
 * @param laGouraud 是否为网格形式。
 * @returns 网格渐变模型；顶点坐标位于对象空间。
 */
export function decodeGouraudShade(
  node: XmlNode,
  context: PaintDecodeContext,
  laGouraud: boolean,
): GouraudShade {
  const points: GouraudShade['points'] = [];
  for (const pointNode of children(node, 'Point')) {
    const point = parsePoint(attr(pointNode, 'X') === undefined ? undefined : `${attr(pointNode, 'X')} ${attr(pointNode, 'Y') ?? '0'}`, { x: 0, y: 0 }, context, 'Point');
    const edgeRaw = attr(pointNode, 'EdgeFlag');
    let edgeFlag: 0 | 1 | 2 | undefined;
    if (edgeRaw !== undefined) {
      const parsed = Number(edgeRaw.trim());
      if (parsed === 0 || parsed === 1 || parsed === 2) edgeFlag = parsed;
      else emitWarning(context, 'W_BAD_NUMBER', `EdgeFlag 非法：${JSON.stringify(edgeRaw)}`);
    }
    const colorNode = child(pointNode, 'Color');
    const color = colorNode ? decodeBasicColor(colorNode, context) : { r: 0, g: 0, b: 0, a: 255 };
    points.push(edgeFlag === undefined ? { x: point.x, y: point.y, color } : { x: point.x, y: point.y, color, edgeFlag });
  }
  const vertexRaw = attrAny(node, ['VerticesPerRow', 'VverticesPcrRow']);
  let verticesPerRow: number | undefined;
  if (vertexRaw !== undefined) {
    const parsed = Number.parseInt(vertexRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 2) verticesPerRow = parsed;
    else emitWarning(context, 'W_BAD_NUMBER', `VerticesPerRow 非法：${JSON.stringify(vertexRaw)}`);
  }
  if (laGouraud && verticesPerRow === undefined) {
    emitWarning(context, 'W_GOURAUD_APPROX', 'LaGouraudShd 缺少 VerticesPerRow，无法按网格绘制');
  }
  const minimum = laGouraud ? 4 : 3;
  if (points.length < minimum) {
    emitWarning(context, 'W_GOURAUD_APPROX', `网格渐变控制点不足 ${minimum} 个（实际 ${points.length}）`);
  }
  const extendValue = Number(attr(node, 'Extend') ?? '0');
  const extend: 0 | 1 = extendValue === 1 ? 1 : 0;
  const backNode = child(node, 'BackColor');
  return {
    points,
    verticesPerRow,
    extend,
    ...(backNode ? { backColor: decodeBasicColor(backNode, context) } : {}),
  };
}

/**
 * 解码底纹。
 *
 * @param node `Pattern` 节点。
 * @param context Paint 上下文；必须提供 `decodePageBlock`。
 * @returns 底纹模型；tile 尺寸单位与对象空间一致（通常 mm）。
 */
export function decodePattern(node: XmlNode, context: PaintDecodeContext): Pattern {
  const width = numberAttr(node, 'Width', 0, context, 'Pattern.Width');
  const height = numberAttr(node, 'Height', 0, context, 'Pattern.Height');
  if (width <= 0 || height <= 0) {
    emitWarning(context, 'W_UNSUPPORTED_PAINT', `Pattern 尺寸非法：${width} × ${height}`);
  }
  let xStep = numberAttr(node, 'XStep', width, context, 'Pattern.XStep');
  let yStep = numberAttr(node, 'YStep', height, context, 'Pattern.YStep');
  if (xStep < width) xStep = width;
  if (yStep < height) yStep = height;
  const reflectRaw = (attr(node, 'ReflectMethod') ?? 'Normal').trim().toLowerCase();
  let reflectMethod: Pattern['reflectMethod'] = 'Normal';
  if (reflectRaw === 'column') reflectMethod = 'Column';
  else if (reflectRaw === 'row') reflectMethod = 'Row';
  else if (reflectRaw === 'rowandcolumn') reflectMethod = 'RowAndColumn';
  else if (reflectRaw !== 'normal') {
    emitWarning(context, 'W_BAD_NUMBER', `ReflectMethod 非法：${JSON.stringify(attr(node, 'ReflectMethod'))}，回退 Normal`);
  }
  const relativeRaw = (attr(node, 'RelativeTo') ?? 'Object').trim().toLowerCase();
  const relativeTo: Pattern['relativeTo'] = relativeRaw === 'page' ? 'Page' : 'Object';
  const ctm = parseMatrix(attr(node, 'CTM'), context, 'Pattern.CTM');
  const cellNode = child(node, 'CellContent');
  let cell: PageBlock = { kind: 'block', children: [] };
  if (cellNode && context.decodePageBlock) {
    cell = context.decodePageBlock(cellNode, context);
  } else if (cellNode) {
    emitWarning(context, 'W_UNSUPPORTED_PAINT', 'Pattern.CellContent 无解码器，底纹将为空');
  }
  const id = normalizeResourceId(attr(node, 'ID'));
  const pattern: Pattern = {
    ...(id ? { id } : {}),
    width,
    height,
    xStep,
    yStep,
    reflectMethod,
    relativeTo,
    cell,
  };
  if (ctm) pattern.ctm = ctm;
  if (id && context.patterns) context.patterns.set(id, pattern);
  return pattern;
}

/**
 * 把 `FillColor`/`StrokeColor` 等节点解码为 Paint。
 *
 * 优先识别复杂 Paint 子节点（AxialShd/RadialShd/GouraudShd/LaGouraudShd/Pattern），
 * 否则按基本颜色处理。
 *
 * @param node 颜色节点。
 * @param context Paint 上下文。
 * @returns Paint；节点完全为空时返回黑色（与 CT_Color 缺省一致）。
 */
export function decodePaint(node: XmlNode, context: PaintDecodeContext): Paint {
  const axial = child(node, 'AxialShd');
  if (axial) return { type: 'axial', shade: decodeAxialShade(axial, context) };
  const radial = child(node, 'RadialShd');
  if (radial) return { type: 'radial', shade: decodeRadialShade(radial, context) };
  const gouraud = child(node, 'GouraudShd');
  if (gouraud) return { type: 'gouraud', shade: decodeGouraudShade(gouraud, context, false) };
  const laGouraud = child(node, 'LaGouraudShd');
  if (laGouraud) return { type: 'gouraud', shade: decodeGouraudShade(laGouraud, context, true) };
  const patternNode = child(node, 'Pattern');
  if (patternNode) return { type: 'pattern', pattern: decodePattern(patternNode, context) };
  return { type: 'color', color: decodeBasicColor(node, context) };
}

/**
 * 取节点的 `FillColor`/`StrokeColor` 子元素并解码。
 *
 * @param node 图元节点。
 * @param name 子元素名（`FillColor`/`StrokeColor`）。
 * @param context Paint 上下文。
 * @returns Paint 或 undefined。
 */
export function decodePaintChild(
  node: XmlNode,
  name: 'FillColor' | 'StrokeColor',
  context: PaintDecodeContext,
): Paint | undefined {
  const colorNode = child(node, name);
  return colorNode ? decodePaint(colorNode, context) : undefined;
}

/** 供资源解码复用的工具：读取 `MediaFile` 等子元素文本。 */
export { childText as textChild };