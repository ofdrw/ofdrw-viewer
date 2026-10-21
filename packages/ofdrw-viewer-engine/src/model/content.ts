/**
 * 页面内容解码：图层、文本/路径/图片/复合对象、PageBlock、裁剪区与图片边框。
 *
 * 输入为 XML 节点 + 解码上下文；输出为纯数据模型，不加载字体/图片，不接触 Canvas。
 * 坐标与长度单位通常为 mm；图片/复合对象内部的 0.3528 mm 单位由资源层换算。
 */

import type { Box, FillRule } from '../common/types';
import { IDENTITY_MATRIX, multiplyMatrix, transformPoint } from '../common/matrix';
import type { XmlNode } from '../xml/types';
import type {
  Annotation,
  CgTransform,
  Clip,
  ClipArea,
  CompositeObject,
  GraphicUnitBase,
  ImageBorder,
  ImageObject,
  Layer,
  PageBlock,
  PageModel,
  PageObject,
  PageSize,
  PathObject,
  TextCode,
  TextObject,
  TemplateRef,
} from './types';
import type { DecodeWarningContext } from './decode-utils';
import type { PaintDecodeContext } from './paint';
import {
  attr,
  attrAny,
  booleanAttr,
  child,
  children,
  childText,
  decodeBoundary,
  emitWarning,
  isIdentityMatrix,
  numberArrayAttr,
  numberAttr,
  parseCap,
  parseDirection,
  parseFillRule,
  parseJoin,
  parseMatrix,
} from './decode-utils';
import { decodeBasicColor, decodePaintChild } from './paint';
import { normalizeResourceId } from './ids';

/** 内容解码上下文。 */
export interface ContentDecodeContext extends PaintDecodeContext {
  /** 当前 PageBlock 嵌套深度，0 为页面顶层。 */
  depth?: number;
  /** 把 Content 内的相对路径解析为包内绝对路径；由 decode.ts 注入。 */
  resolvePath?: (raw: string) => string | undefined;
}

/** PageBlock 最大嵌套深度；防止恶意/损坏文件无限递归。 */
const MAX_PAGE_BLOCK_DEPTH = 32;

/** 浅拷贝上下文并设置当前对象 ID。 */
function withObject(context: ContentDecodeContext, objectId: string | undefined): ContentDecodeContext {
  if (!objectId) return context;
  return { ...context, objectId };
}

/**
 * 解码图元公共字段。
 *
 * @param node 图元节点。
 * @param context 内容上下文。
 * @returns 公共字段；长度字段单位为对象空间（通常 mm）。
 */
function decodeGraphicUnitBase(node: XmlNode, context: ContentDecodeContext): GraphicUnitBase {
  const id = normalizeResourceId(attr(node, 'ID'));
  const objectContext = withObject(context, id || undefined);
  const boundary = decodeBoundary(attr(node, 'Boundary'), objectContext, true);
  const alphaRaw = numberAttr(node, 'Alpha', 255, objectContext, 'Alpha');
  const alpha = Math.max(0, Math.min(255, alphaRaw));
  const visible = booleanAttr(node, 'Visible', true, objectContext);
  const base: GraphicUnitBase = {
    boundary,
    alpha,
    visible,
  };
  if (id) base.id = id;
  const ctm = parseMatrix(attr(node, 'CTM'), objectContext, 'CTM');
  if (ctm) base.ctm = ctm;
  const drawParamRaw = attr(node, 'DrawParam');
  if (drawParamRaw !== undefined) {
    const drawParam = normalizeResourceId(drawParamRaw);
    if (drawParam) base.drawParam = drawParam;
  }
  const lineWidthRaw = attrAny(node, ['LineWidth', 'LincWidth']);
  if (lineWidthRaw !== undefined) {
    base.lineWidth = numberAttr(node, lineWidthRaw === attr(node, 'LineWidth') ? 'LineWidth' : 'LincWidth', 0.353, objectContext, 'LineWidth');
  }
  if (attr(node, 'Cap') !== undefined) base.cap = parseCap(attr(node, 'Cap'), 'Butt', objectContext);
  if (attr(node, 'Join') !== undefined) base.join = parseJoin(attr(node, 'Join'), 'Miter', objectContext);
  if (attr(node, 'MiterLimit') !== undefined) base.miterLimit = numberAttr(node, 'MiterLimit', 4.234, objectContext, 'MiterLimit');
  if (attr(node, 'DashOffset') !== undefined) base.dashOffset = numberAttr(node, 'DashOffset', 0, objectContext, 'DashOffset');
  if (attr(node, 'DashPattern') !== undefined) base.dashPattern = numberArrayAttr(node, 'DashPattern', [], objectContext);
  const clips = decodeClipsNode(node, objectContext);
  if (clips.length > 0) base.clips = clips;
  return base;
}

/**
 * 解码文本对象。
 *
 * @param node `TextObject` 或裁剪区 `Text` 节点。
 * @param context 内容上下文。
 * @returns 文本对象；缺失字体时字体 ID 为空串并由上层 warning。
 */
export function decodeTextNode(node: XmlNode, context: ContentDecodeContext): TextObject {
  const base = decodeGraphicUnitBase(node, context);
  const objectContext = withObject(context, base.id);
  const font = normalizeResourceId(attr(node, 'Font'));
  if (!font) emitWarning(objectContext, 'W_FONT_MISSING', 'TextObject 缺少 Font 属性');
  const size = numberAttr(node, 'Size', 0, objectContext, 'Size');
  let hScale = numberAttr(node, 'HScale', 1, objectContext, 'HScale');
  if (hScale <= 0) {
    emitWarning(objectContext, 'W_BAD_NUMBER', `HScale 非正：${hScale}，按 1 处理`);
    hScale = 1;
  }
  const readDirection = parseDirection(attr(node, 'ReadDirection'), 0, objectContext, 'ReadDirection');
  const charDirection = parseDirection(attr(node, 'CharDirection'), 0, objectContext, 'CharDirection');
  const weight = numberAttr(node, 'Weight', 400, objectContext, 'Weight');
  const italic = booleanAttr(node, 'Italic', false, objectContext);
  const fill = booleanAttr(node, 'Fill', true, objectContext);
  const stroke = booleanAttr(node, 'Stroke', false, objectContext);
  const fillColor = decodePaintChild(node, 'FillColor', objectContext);
  const strokeColor = decodePaintChild(node, 'StrokeColor', objectContext);
  const codes = decodeTextCodes(node, objectContext);
  const result: TextObject = {
    ...base,
    kind: 'text',
    font,
    size,
    hScale,
    readDirection,
    charDirection,
    weight,
    italic,
    fill,
    stroke,
    codes,
  };
  if (fillColor) result.fillColor = fillColor;
  if (strokeColor) result.strokeColor = strokeColor;
  return result;
}

/**
 * 解码文本编码段；`CGTransform` 可以位于 `TextCode` 之前（标准）或内部（兼容）。
 *
 * @param node TextObject 节点。
 * @param context 内容上下文。
 * @returns TextCode 数组。
 */
function decodeTextCodes(node: XmlNode, context: ContentDecodeContext): TextCode[] {
  const codes: TextCode[] = [];
  let pending: CgTransform[] = [];
  for (const item of node.children) {
    if (item.name === 'CGTransform') {
      pending.push(decodeCgTransform(item, context));
    } else if (item.name === 'TextCode') {
      const code = decodeTextCode(item, context, pending);
      pending = [];
      codes.push(code);
    }
  }
  if (pending.length > 0 && codes.length > 0) {
    const last = codes[codes.length - 1] as TextCode;
    last.cgTransforms.push(...pending);
  }
  return codes;
}

/**
 * 解码单个 TextCode。
 *
 * @param node `TextCode` 节点。
 * @param context 内容上下文。
 * @param pending 该段之前的 CGTransform。
 * @returns TextCode；文本中的 `\XXXX` 已解码。
 */
function decodeTextCode(node: XmlNode, context: ContentDecodeContext, pending: readonly CgTransform[]): TextCode {
  const text = decodeTextEscapes(node.text ?? '');
  const code: TextCode = {
    text,
    deltaX: attr(node, 'DeltaX') !== undefined ? numberArrayAttr(node, 'DeltaX', [], context) : [],
    deltaY: attr(node, 'DeltaY') !== undefined ? numberArrayAttr(node, 'DeltaY', [], context) : [],
    cgTransforms: [...pending],
  };
  if (attr(node, 'X') !== undefined) code.x = numberAttr(node, 'X', 0, context, 'TextCode.X');
  if (attr(node, 'Y') !== undefined) code.y = numberAttr(node, 'Y', 0, context, 'TextCode.Y');
  for (const item of node.children) {
    if (item.name === 'CGTransform') code.cgTransforms.push(decodeCgTransform(item, context));
  }
  // 兼容少数生成器把 CGTransform 写成 TextCode 的属性。
  if (
    attrAny(node, ['CodePosition', 'CodecPosition']) !== undefined ||
    attr(node, 'Glyphs') !== undefined
  ) {
    code.cgTransforms.push(decodeCgTransform(node, context));
  }
  return code;
}

/**
 * 解码 `\XXXX` 形式字符转义。
 *
 * @param raw 原始文本；反斜杠后非 4 位十六进制时原样保留。
 * @returns Unicode 文本。
 */
export function decodeTextEscapes(raw: string): string {
  return raw.replace(/\\([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * 解码 CGTransform。
 *
 * @param node `CGTransform` 节点或携带映射属性的 `TextCode` 节点。
 * @param context 内容上下文。
 * @returns 字符→字形映射。
 */
function decodeCgTransform(node: XmlNode, context: ContentDecodeContext): CgTransform {
  const codePosition = integerAttr(node, ['CodePosition', 'CodecPosition'], 0, context, 'CodePosition');
  const codeCount = Math.max(1, integerAttr(node, ['CodeCount', 'CodecCount'], 1, context, 'CodeCount'));
  const glyphsText = childText(node, 'Glyphs') ?? attr(node, 'Glyphs');
  let glyphs: number[] = [];
  if (glyphsText !== undefined) {
    glyphs = numberArrayAttr({ ...node, attrs: { ...node.attrs, Glyphs: glyphsText } }, 'Glyphs', [], context)
      .map((value) => Math.trunc(value))
      .filter((value) => value >= 0);
  }
  const glyphCount = integerAttr(node, 'GlyphCount', glyphs.length, context, 'GlyphCount');
  return { codePosition: Math.max(0, codePosition), codeCount, glyphCount, glyphs };
}

/** 读取整型属性。 */
function integerAttr(
  node: XmlNode,
  names: string | readonly string[],
  fallback: number,
  context: ContentDecodeContext,
  field: string,
): number {
  const name = typeof names === 'string' ? names : names.find((item) => attr(node, item) !== undefined);
  if (!name || attr(node, name) === undefined) return fallback;
  return Math.trunc(numberAttr(node, name, fallback, context, field));
}

/**
 * 解码路径对象。
 *
 * @param node `PathObject` 或裁剪区 `Path` 节点。
 * @param context 内容上下文。
 * @returns 路径对象；`AbbreviatedData` 缺失时为空路径。
 */
export function decodePathNode(node: XmlNode, context: ContentDecodeContext): PathObject {
  const base = decodeGraphicUnitBase(node, context);
  const objectContext = withObject(context, base.id);
  const data = childText(node, 'AbbreviatedData') ?? '';
  if (!data) emitWarning(objectContext, 'W_BAD_PATH', 'PathObject 缺少 AbbreviatedData');
  const fill = booleanAttr(node, 'Fill', false, objectContext);
  const stroke = booleanAttr(node, 'Stroke', true, objectContext);
  const rule: FillRule = parseFillRule(attr(node, 'Rule'), 'nonzero', objectContext);
  const fillColor = decodePaintChild(node, 'FillColor', objectContext);
  const strokeColor = decodePaintChild(node, 'StrokeColor', objectContext);
  const result: PathObject = {
    ...base,
    kind: 'path',
    data,
    fill,
    stroke,
    rule,
  };
  if (fillColor) result.fillColor = fillColor;
  if (strokeColor) result.strokeColor = strokeColor;
  return result;
}

/**
 * 解码图片对象。
 *
 * @param node `ImageObject` 节点。
 * @param context 内容上下文。
 * @returns 图片对象；缺少 ResourceID 时返回 undefined（调用方跳过）。
 */
export function decodeImageNode(node: XmlNode, context: ContentDecodeContext): ImageObject | undefined {
  const base = decodeGraphicUnitBase(node, context);
  const objectContext = withObject(context, base.id);
  const resourceId = normalizeResourceId(attr(node, 'ResourceID'));
  if (!resourceId) {
    emitWarning(objectContext, 'W_IMAGE_DECODE', 'ImageObject 缺少 ResourceID，已跳过');
    return undefined;
  }
  const result: ImageObject = {
    ...base,
    kind: 'image',
    resourceId,
  };
  const substitution = normalizeResourceId(attr(node, 'Substitution'));
  if (substitution) result.substitution = substitution;
  const imageMask = normalizeResourceId(attr(node, 'ImageMask'));
  if (imageMask) result.imageMask = imageMask;
  const borderNode = child(node, 'Border');
  if (borderNode) result.border = decodeBorder(borderNode, objectContext);
  return result;
}

/**
 * 解码图片边框。
 *
 * @param node `Border` 节点。
 * @param context 内容上下文。
 * @returns 边框；长度单位 mm，线宽 0 表示不画。
 */
function decodeBorder(node: XmlNode, context: ContentDecodeContext): ImageBorder {
  const lineWidth = numberAttr(node, 'LineWidth', 0.353, context, 'Border.LineWidth');
  const horizontal = numberAttr(
    node,
    attr(node, 'HorizonalCornerRadius') !== undefined ? 'HorizonalCornerRadius' : 'HorizontalCornerRadius',
    0,
    context,
    'Border.HorizontalCornerRadius',
  );
  const vertical = numberAttr(node, 'VerticalCornerRadius', 0, context, 'Border.VerticalCornerRadius');
  const dashOffset = numberAttr(node, 'DashOffset', 0, context, 'Border.DashOffset');
  const dashPattern = attr(node, 'DashPattern') !== undefined ? numberArrayAttr(node, 'DashPattern', [], context) : [];
  const colorNode = child(node, 'BorderColor');
  const color = colorNode ? decodeBasicColor(colorNode, context) : { r: 0, g: 0, b: 0, a: 255 };
  return {
    lineWidth,
    horizontalRadius: horizontal,
    verticalRadius: vertical,
    dashOffset,
    dashPattern,
    color,
  };
}

/**
 * 解码复合对象引用。
 *
 * @param node `CompositeObject` 节点。
 * @param context 内容上下文。
 * @returns 复合对象；缺少 ResourceID 时返回 undefined。
 */
export function decodeCompositeObjectNode(
  node: XmlNode,
  context: ContentDecodeContext,
): CompositeObject | undefined {
  const base = decodeGraphicUnitBase(node, context);
  const objectContext = withObject(context, base.id);
  const resourceId = normalizeResourceId(attr(node, 'ResourceID'));
  if (!resourceId) {
    emitWarning(objectContext, 'W_COMPOSITE_DEPTH', 'CompositeObject 缺少 ResourceID，已跳过');
    return undefined;
  }
  return { ...base, kind: 'composite', resourceId };
}

/**
 * 解码 PageBlock（含独立空间块与普通嵌套块）。
 *
 * @param node `PageBlock`/`Content`/`CellContent` 节点。
 * @param context 内容上下文。
 * @returns 页面块；超过最大嵌套深度时返回空块。
 */
export function decodePageBlockNode(node: XmlNode, context: ContentDecodeContext): PageBlock {
  const depth = context.depth ?? 0;
  const id = normalizeResourceId(attr(node, 'ID'));
  if (depth >= MAX_PAGE_BLOCK_DEPTH) {
    emitWarning(context, 'W_COMPOSITE_DEPTH', `PageBlock 嵌套超过 ${MAX_PAGE_BLOCK_DEPTH} 层，已截断`);
    return id ? { kind: 'block', id, children: [] } : { kind: 'block', children: [] };
  }
  const childContext: ContentDecodeContext = { ...context, depth: depth + 1 };
  const result: PageBlock = { kind: 'block', children: [] };
  if (id) result.id = id;
  for (const item of node.children) {
    const decoded = decodePageObjectNode(item, childContext);
    if (decoded) result.children.push(decoded);
  }
  return result;
}

/**
 * 解码任意页面对象；未知节点忽略。
 *
 * @param node XML 节点。
 * @param context 内容上下文。
 * @returns 页面对象；不支持/无效时返回 undefined。
 */
export function decodePageObjectNode(
  node: XmlNode,
  context: ContentDecodeContext,
): PageObject | undefined {
  switch (node.name) {
    case 'TextObject':
    case 'Text':
      return decodeTextNode(node, context);
    case 'PathObject':
    case 'Path':
      return decodePathNode(node, context);
    case 'ImageObject':
      return decodeImageNode(node, context);
    case 'CompositeObject':
      return decodeCompositeObjectNode(node, context);
    case 'PageBlock':
      return decodePageBlockNode(node, context);
    default:
      return undefined;
  }
}

/**
 * 解码图层列表（Content 的直接 Layer 子节点）。
 *
 * @param contentNode `Content` 节点。
 * @param context 内容上下文。
 * @returns 图层数组，保持文档顺序。
 */
export function decodeLayersNode(contentNode: XmlNode, context: ContentDecodeContext): Layer[] {
  const layers: Layer[] = [];
  for (const layerNode of children(contentNode, 'Layer')) {
    const id = normalizeResourceId(attr(layerNode, 'ID'));
    const layerContext = withObject(context, id || undefined);
    const typeRaw = (attr(layerNode, 'Type') ?? 'Body').trim().toLowerCase();
    let type: Layer['type'];
    if (typeRaw === 'background') type = 'Background';
    else if (typeRaw === 'body') type = 'Body';
    else if (typeRaw === 'foreground') type = 'Foreground';
    else if (typeRaw === 'custom') type = 'Custom';
    else {
      type = 'Body';
      emitWarning(layerContext, 'W_LAYER_ORDER', `未知 Layer Type：${typeRaw}，按 Body 处理`);
    }
    const layer: Layer = { type, children: [] };
    const drawParamRaw = attr(layerNode, 'DrawParam');
    if (drawParamRaw !== undefined) {
      const drawParam = normalizeResourceId(drawParamRaw);
      if (drawParam) layer.drawParam = drawParam;
    }
    for (const item of layerNode.children) {
      const decoded = decodePageObjectNode(item, layerContext);
      if (decoded) layer.children.push(decoded);
    }
    layers.push(layer);
  }
  return layers;
}

/**
 * 解码对象裁剪区。
 *
 * `Area.CTM` 在模型中无独立字段；这里按 `Area.CTM × T(Boundary) × Path.CTM`
 * 等价变换：把 Area.CTM 左乘进对象 CTM，并用它变换 Boundary 原点，保证后续
 * 统一按“平移到 Boundary 原点再应用对象 CTM”绘制时结果一致。
 *
 * @param node 图元节点。
 * @param context 内容上下文。
 * @returns Clip 数组；多个 Clip 取交集。
 */
function decodeClipsNode(node: XmlNode, context: ContentDecodeContext): Clip[] {
  const clipsNode = child(node, 'Clips');
  if (!clipsNode) return [];
  const result: Clip[] = [];
  for (const clipNode of children(clipsNode, 'Clip')) {
    const clipContext = withObject(context, normalizeResourceId(attr(clipNode, 'ID')) || undefined);
    const clip: Clip = { areas: [] };
    const clipCtm = parseMatrix(attr(clipNode, 'CTM'), clipContext, 'Clip.CTM');
    if (clipCtm) clip.ctm = clipCtm;
    const drawParamRaw = attr(clipNode, 'DrawParam');
    if (drawParamRaw !== undefined) {
      const drawParam = normalizeResourceId(drawParamRaw);
      if (drawParam) clip.drawParam = drawParam;
    }
    for (const areaNode of children(clipNode, 'Area')) {
      const areaCtm = parseMatrix(attr(areaNode, 'CTM'), clipContext, 'Area.CTM');
      for (const areaChild of areaNode.children) {
        const decoded = decodePageObjectNode(areaChild, clipContext);
        if (!decoded) continue;
        if (decoded.kind === 'path') {
          const path = applyAreaCtm(decoded, areaCtm);
          clip.areas.push({ kind: 'path', path });
        } else if (decoded.kind === 'text') {
          const text = applyAreaCtm(decoded, areaCtm);
          clip.areas.push({ kind: 'text', text });
        }
        // 裁剪区内其他对象类型按规范无效，忽略。
      }
    }
    result.push(clip);
  }
  return result;
}

/**
 * 把 Area.CTM 折叠进裁剪对象。
 *
 * @param object 裁剪区路径/文本对象。
 * @param areaCtm Area 的 CTM；缺省/单位矩阵时原样返回。
 * @returns 折叠后的新对象。
 */
function applyAreaCtm<T extends PathObject | TextObject>(object: T, areaCtm: import('../common/types').Matrix | undefined): T {
  if (!areaCtm || isIdentityMatrix(areaCtm)) return object;
  const origin = transformPoint(areaCtm, { x: object.boundary.x, y: object.boundary.y });
  const ctm = multiplyMatrix(areaCtm, object.ctm ?? IDENTITY_MATRIX);
  return {
    ...object,
    boundary: { ...object.boundary, x: origin.x, y: origin.y },
    ctm,
  };
}

/**
 * 解码 Content.xml 为页面模型。
 *
 * @param root Content 根节点。
 * @param pageId 页 ID。
 * @param context 内容上下文（颜色空间/底纹收集器）。
 * @returns 页面模型；页尺寸可能为零，由上层按模板/CommonData 回退。
 */
export function decodePageContentNode(
  root: XmlNode,
  pageId: string,
  context: ContentDecodeContext,
): PageModel {
  const areaNode = child(root, 'Area');
  let physical: Box | undefined;
  if (areaNode) {
    physical = parsePhysicalBox(areaNode, context);
  }
  if (!physical) {
    emitWarning(context, 'W_BAD_NUMBER', 'Page 缺少 Area/PhysicalBox，页尺寸按回退链处理');
    physical = { x: 0, y: 0, w: 0, h: 0 };
  }
  const size: PageSize = { width: physical.w, height: physical.h };
  const templates = decodeTemplates(root, context);
  const pageRes = decodePageRes(root, context);
  const contentNode = child(root, 'Content');
  const layers = contentNode ? decodeLayersNode(contentNode, context) : [];
  return {
    id: normalizeResourceId(pageId),
    area: physical,
    size,
    layers,
    templates,
    pageRes,
  };
}

/**
 * 解析 Area/PhysicalBox。
 *
 * @param areaNode `Area` 节点。
 * @param context 内容上下文。
 * @returns PhysicalBox；缺失/非法时为 undefined。
 */
function parsePhysicalBox(areaNode: XmlNode, context: ContentDecodeContext): Box | undefined {
  const raw = childText(areaNode, 'PhysicalBox');
  if (!raw) return undefined;
  const box = decodeBoundary(raw, context, false);
  if (box.w <= 0 || box.h <= 0) {
    emitWarning(context, 'W_BAD_NUMBER', `PhysicalBox 宽高非正：${box.w} × ${box.h}`);
  }
  if (box.x !== 0 || box.y !== 0) {
    emitWarning(
      context,
      'W_PHYSICALBOX_ORIGIN',
      `PhysicalBox 原点非零：(${box.x}, ${box.y})；页尺寸仍取 width/height`,
    );
  }
  return box;
}

/**
 * 解码 Template 引用；`loc` 由调用方用文档模板表补齐。
 *
 * @param root 页面根节点。
 * @param context 内容上下文。
 * @returns 模板引用数组，保持文档顺序。
 */
function decodeTemplates(root: XmlNode, context: ContentDecodeContext): TemplateRef[] {
  const result: TemplateRef[] = [];
  for (const templateNode of children(root, 'Template')) {
    const id = normalizeResourceId(attr(templateNode, 'TemplateID'));
    if (!id) {
      emitWarning(context, 'W_BAD_NUMBER', 'Template 缺少 TemplateID，已跳过');
      continue;
    }
    const templateContext = withObject(context, id);
    const template: TemplateRef = { id };
    const zOrderRaw = (attr(templateNode, 'ZOrder') ?? 'Background').trim();
    if (zOrderRaw === 'Background' || zOrderRaw === 'Body' || zOrderRaw === 'Foreground') {
      template.zOrder = zOrderRaw;
    } else {
      emitWarning(templateContext, 'W_LAYER_ORDER', `未知 Template ZOrder：${zOrderRaw}，按 Background 处理`);
      template.zOrder = 'Background';
    }
    result.push(template);
  }
  return result;
}

/**
 * 解码 PageRes 路径列表。
 *
 * @param root 页面根节点。
 * @param context 内容上下文，需包含 `baseDir` 与路径解析器。
 * @returns 已解析为包内路径的 PageRes 列表。
 */
function decodePageRes(root: XmlNode, context: ContentDecodeContext): string[] {
  const paths: string[] = [];
  for (const pageResNode of children(root, 'PageRes')) {
    const raw = (pageResNode.text ?? '').trim();
    if (!raw) continue;
    const resolved = context.resolvePath?.(raw);
    if (resolved) paths.push(resolved);
    else emitWarning(context, 'W_BAD_NUMBER', `PageRes 路径非法：${JSON.stringify(raw)}`);
  }
  return paths;
}

/**
 * 解码注释文件中的单个 PageAnnot。
 *
 * @param root `PageAnnot` 根节点（或包含 `Annot` 子节点的容器）。
 * @param pageIds 页 ID 列表（用于诊断；PageAnnot 本身不携带页 ID）。
 * @param context 内容上下文。
 * @returns 注释数组；空外观保留模型，由渲染管线跳过。
 */
export function decodeAnnotationsNode(
  root: XmlNode,
  pageIds: readonly string[],
  context: ContentDecodeContext,
): Annotation[] {
  void pageIds;
  const annotations: Annotation[] = [];
  for (const annotNode of children(root, 'Annot')) {
    const id = normalizeResourceId(attr(annotNode, 'ID'));
    const annotContext = withObject(context, id || undefined);
    const visible = booleanAttr(annotNode, 'Visible', true, annotContext);
    const type = (attr(annotNode, 'Type') ?? 'Path').trim();
    const appearanceNode = child(annotNode, 'Appearance');
    const annotation: Annotation = { id, type, visible };
    if (appearanceNode) {
      const boundaryRaw = attr(appearanceNode, 'Boundary');
      if (boundaryRaw !== undefined) {
        annotation.boundary = decodeBoundary(boundaryRaw, annotContext, false);
      }
      const appearance = decodePageBlockNode(appearanceNode, annotContext);
      if (appearance.children.length === 0) {
        emitWarning(annotContext, 'W_ANNOT_EMPTY', `注释 ${id || '(无 ID)'} 的 Appearance 为空`);
      } else {
        annotation.appearance = appearance;
      }
    } else {
      emitWarning(annotContext, 'W_ANNOT_EMPTY', `注释 ${id || '(无 ID)'} 缺少 Appearance`);
    }
    annotations.push(annotation);
  }
  return annotations;
}