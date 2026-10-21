/**
 * 模型解码共用的小工具：属性兼容读取、数字/矩形/矩阵解析、warning 出口。
 *
 * 这里只做纯函数转换；不读 ZIP、不加载资源、不依赖 DOM。
 */

import type { Box, FillRule, LineCap, LineJoin, Matrix, Point } from '../common/types';
import type { BadNumberHandler, XmlNode } from '../xml/types';
import type { OFDWarning } from '../warnings';
import type { ResourceId } from './types';
import { normalizeBox } from '../common/matrix';
import { toBoolean, toNumber, toNumberArray } from '../xml/numbers';

/** 解码过程中的 warning/上下文。 */
export interface DecodeWarningContext {
  /** warning 回调；缺省静默。 */
  onWarning?: (warning: OFDWarning) => void;
  /** 当前对象 ID，用于 warning 定位。 */
  objectId?: ResourceId;
  /** 当前资源 ID，用于 warning 定位。 */
  resourceId?: ResourceId;
}

/**
 * 上报一条 warning。
 *
 * @param context 解码上下文。
 * @param code warning 码，见设计方案 15.4。
 * @param message 诊断信息。
 * @param overrides 覆盖上下文中的对象/资源 ID。
 */
export function emitWarning(
  context: DecodeWarningContext | undefined,
  code: string,
  message: string,
  overrides: { objectId?: ResourceId; resourceId?: ResourceId; pageIndex?: number } = {},
): void {
  if (!context?.onWarning) return;
  const warning: OFDWarning = { code, message };
  const objectId = overrides.objectId ?? context.objectId;
  const resourceId = overrides.resourceId ?? context.resourceId;
  if (objectId !== undefined && objectId !== '') warning.objectId = objectId;
  if (resourceId !== undefined && resourceId !== '') warning.resourceId = resourceId;
  if (overrides.pageIndex !== undefined) warning.pageIndex = overrides.pageIndex;
  context.onWarning(warning);
}

/**
 * 生成交给 `xml/numbers` 的坏数字回调。
 *
 * @param context 解码上下文。
 * @param field 字段名，用于诊断信息。
 * @returns BadNumberHandler。
 */
export function badNumberHandler(
  context: DecodeWarningContext | undefined,
  field: string,
): BadNumberHandler {
  return (raw, _fallback, reason) => {
    emitWarning(
      context,
      'W_BAD_NUMBER',
      `${field} 数值非法${raw === undefined ? '（缺失）' : `：${JSON.stringify(raw)}`}（${reason}）`,
    );
  };
}

/**
 * 按精确名称取属性。
 *
 * @param node XML 节点。
 * @param name 属性名（大小写敏感）。
 * @returns 属性值或 undefined。
 */
export function attr(node: XmlNode, name: string): string | undefined {
  const value = node.attrs[name];
  return value === undefined ? undefined : value;
}

/**
 * 按候选名依次取属性，用于兼容标准拼写错误（如 `LineWidth`/`LincWidth`）。
 *
 * @param node XML 节点。
 * @param names 候选属性名，按优先级排列。
 * @returns 第一个存在的属性值或 undefined。
 */
export function attrAny(node: XmlNode, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = attr(node, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 取指定名称的第一个子节点。
 *
 * @param node 父节点。
 * @param name 子节点 local name。
 * @returns 子节点或 undefined。
 */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((item) => item.name === name);
}

/**
 * 取指定名称的全部子节点。
 *
 * @param node 父节点。
 * @param name 子节点 local name。
 * @returns 子节点数组（保持文档顺序）。
 */
export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((item) => item.name === name);
}

/**
 * 取子节点文本（去前后空白）。
 *
 * @param node 父节点。
 * @param name 子节点 local name。
 * @returns 文本；节点缺失时返回 undefined。
 */
export function childText(node: XmlNode, name: string): string | undefined {
  const target = child(node, name);
  if (!target) return undefined;
  const text = (target.text ?? '').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * 解析数值属性。
 *
 * @param node XML 节点。
 * @param name 属性名。
 * @param fallback 缺失/非法时的回退值。
 * @param context warning 上下文。
 * @param field 诊断字段名。
 * @returns 数值。
 */
export function numberAttr(
  node: XmlNode,
  name: string,
  fallback: number,
  context?: DecodeWarningContext,
  field: string = name,
): number {
  return toNumber(attr(node, name), fallback, badNumberHandler(context, field));
}

/**
 * 解析布尔属性。
 *
 * @param node XML 节点。
 * @param name 属性名。
 * @param fallback 缺失/非法时的回退值。
 * @param context warning 上下文。
 * @returns 布尔值。
 */
export function booleanAttr(
  node: XmlNode,
  name: string,
  fallback: boolean,
  context?: DecodeWarningContext,
): boolean {
  return toBoolean(attr(node, name), fallback, badNumberHandler(context, name));
}

/**
 * 解析数值数组属性；属性缺失时返回 fallback 的副本。
 *
 * @param node XML 节点。
 * @param name 属性名。
 * @param fallback 缺失时的回退数组。
 * @param context warning 上下文。
 * @returns 数值数组。
 */
export function numberArrayAttr(
  node: XmlNode,
  name: string,
  fallback: readonly number[],
  context?: DecodeWarningContext,
): number[] {
  return toNumberArray(attr(node, name), fallback, badNumberHandler(context, name));
}

/**
 * 解析 4 元组文本为 Box。
 *
 * @param raw 原始文本，例如 `0 0 210 297`；单位由调用方上下文决定（通常 mm）。
 * @param context warning 上下文。
 * @param field 诊断字段名。
 * @returns Box；不足 4 个有效数字时返回 undefined。
 */
export function parseBox(
  raw: string | undefined,
  context?: DecodeWarningContext,
  field: string = 'Box',
): Box | undefined {
  if (raw === undefined) return undefined;
  const values = toNumberArray(raw, [], badNumberHandler(context, field));
  if (values.length < 4) {
    emitWarning(context, 'W_BAD_NUMBER', `${field} 需要 4 个数值，实际 ${values.length} 个`);
    return undefined;
  }
  return { x: values[0] as number, y: values[1] as number, w: values[2] as number, h: values[3] as number };
}

/**
 * 解析子元素文本为 Box。
 *
 * @param node 包含 Box 文本子元素的节点。
 * @param name 子元素名，例如 `PhysicalBox`。
 * @param context warning 上下文。
 * @returns Box；缺失/非法时返回 undefined。
 */
export function parseBoxChild(
  node: XmlNode,
  name: string,
  context?: DecodeWarningContext,
): Box | undefined {
  return parseBox(childText(node, name), context, name);
}

/**
 * 解析 6 元仿射矩阵属性。
 *
 * @param raw 原始文本，`[a b c d e f]`。
 * @param context warning 上下文。
 * @param field 诊断字段名。
 * @returns Matrix；缺失或长度不足时返回 undefined。
 */
export function parseMatrix(
  raw: string | undefined,
  context?: DecodeWarningContext,
  field: string = 'CTM',
): Matrix | undefined {
  if (raw === undefined) return undefined;
  const values = toNumberArray(raw, [], badNumberHandler(context, field));
  if (values.length < 6) {
    emitWarning(context, 'W_BAD_NUMBER', `${field} 需要 6 个数值，实际 ${values.length} 个`);
    return undefined;
  }
  return [values[0] as number, values[1] as number, values[2] as number, values[3] as number, values[4] as number, values[5] as number];
}

/**
 * 解析 2 元点属性。
 *
 * @param raw 原始文本，例如 `1 2`；单位由调用方上下文决定。
 * @param fallback 缺失时的回退点。
 * @param context warning 上下文。
 * @param field 诊断字段名。
 * @returns 点。
 */
export function parsePoint(
  raw: string | undefined,
  fallback: Point,
  context?: DecodeWarningContext,
  field: string = 'Point',
): Point {
  if (raw === undefined) {
    emitWarning(context, 'W_BAD_NUMBER', `${field} 缺失，使用回退值`);
    return { ...fallback };
  }
  const values = toNumberArray(raw, [], badNumberHandler(context, field));
  if (values.length < 2) {
    emitWarning(context, 'W_BAD_NUMBER', `${field} 需要 2 个数值，实际 ${values.length} 个`);
    return { ...fallback };
  }
  return { x: values[0] as number, y: values[1] as number };
}

/**
 * 解析方向枚举（0/90/180/270）。
 *
 * @param raw 原始属性值。
 * @param fallback 缺失/非法时的回退值。
 * @param context warning 上下文。
 * @param field 诊断字段名。
 * @returns 方向角，单位度。
 */
export function parseDirection(
  raw: string | undefined,
  fallback: 0 | 90 | 180 | 270,
  context?: DecodeWarningContext,
  field: string = 'Direction',
): 0 | 90 | 180 | 270 {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  emitWarning(context, 'W_BAD_NUMBER', `${field} 非法：${JSON.stringify(raw)}，回退 ${fallback}`);
  return fallback;
}

/**
 * 解析线端点样式。
 *
 * @param raw 原始属性值，大小写不敏感。
 * @param fallback 缺失/非法时的回退值。
 * @param context warning 上下文。
 * @returns LineCap。
 */
export function parseCap(
  raw: string | undefined,
  fallback: LineCap,
  context?: DecodeWarningContext,
): LineCap {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'butt') return 'Butt';
  if (normalized === 'round') return 'Round';
  if (normalized === 'square') return 'Square';
  emitWarning(context, 'W_BAD_NUMBER', `Cap 非法：${JSON.stringify(raw)}，回退 ${fallback}`);
  return fallback;
}

/**
 * 解析线连接样式。
 *
 * @param raw 原始属性值，大小写不敏感。
 * @param fallback 缺失/非法时的回退值。
 * @param context warning 上下文。
 * @returns LineJoin。
 */
export function parseJoin(
  raw: string | undefined,
  fallback: LineJoin,
  context?: DecodeWarningContext,
): LineJoin {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'miter') return 'Miter';
  if (normalized === 'round') return 'Round';
  if (normalized === 'bevel') return 'Bevel';
  emitWarning(context, 'W_BAD_NUMBER', `Join 非法：${JSON.stringify(raw)}，回退 ${fallback}`);
  return fallback;
}

/**
 * 解析填充规则：`NonZero`/`EvenOdd`/`Even-Odd` 均兼容。
 *
 * @param raw 原始属性值。
 * @param fallback 缺失/非法时的回退值。
 * @param context warning 上下文。
 * @returns FillRule。
 */
export function parseFillRule(
  raw: string | undefined,
  fallback: FillRule,
  context?: DecodeWarningContext,
): FillRule {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase().replace(/-/g, '');
  if (normalized === 'nonzero') return 'nonzero';
  if (normalized === 'evenodd') return 'evenodd';
  emitWarning(context, 'W_BAD_NUMBER', `Rule 非法：${JSON.stringify(raw)}，回退 ${fallback}`);
  return fallback;
}

/**
 * 解码 Boundary：缺失/非法时回退为零矩形；负宽高归一化并 warning。
 *
 * @param raw 原始 `Boundary` 属性。
 * @param context warning 上下文。
 * @param required 是否为必选属性（缺失时 warning）。
 * @returns 归一化后的 Box；单位与对象空间一致（通常 mm）。
 */
export function decodeBoundary(
  raw: string | undefined,
  context?: DecodeWarningContext,
  required: boolean = true,
): Box {
  const parsed = parseBox(raw, context, 'Boundary');
  if (!parsed) {
    if (required) emitWarning(context, 'W_BAD_NUMBER', 'Boundary 缺失，按零矩形处理');
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  if (parsed.w < 0 || parsed.h < 0) {
    emitWarning(
      context,
      'W_NEGATIVE_BOUNDARY',
      `Boundary 宽高为负（${parsed.w} × ${parsed.h}），已归一化`,
    );
    return normalizeBox(parsed);
  }
  return parsed;
}

/**
 * 判断矩阵是否为单位矩阵（容差 1e-9）。
 *
 * @param matrix 输入矩阵。
 * @returns 是否等价于单位矩阵。
 */
export function isIdentityMatrix(matrix: Matrix | undefined): boolean {
  if (!matrix) return true;
  return (
    Math.abs(matrix[0] - 1) <= 1e-9 &&
    Math.abs(matrix[1]) <= 1e-9 &&
    Math.abs(matrix[2]) <= 1e-9 &&
    Math.abs(matrix[3] - 1) <= 1e-9 &&
    Math.abs(matrix[4]) <= 1e-9 &&
    Math.abs(matrix[5]) <= 1e-9
  );
}

/**
 * 把 Windows 风格路径统一为包内 `/`。
 *
 * @param raw 原始路径。
 * @returns 统一分隔符后的路径。
 */
export function normalizePathSeparators(raw: string): string {
  return raw.replace(/\\/g, '/');
}