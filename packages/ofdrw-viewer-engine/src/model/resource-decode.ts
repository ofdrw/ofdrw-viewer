/**
 * 资源 XML（PublicRes/DocumentRes/PageRes）解码。
 *
 * 只建立定义集合：字体/图片保留包内路径，不加载二进制；颜色空间先于其他资源解析，
 * 供 DrawParam、复合对象和底纹中的颜色引用使用。
 */

import type { XmlNode } from '../xml/types';
import type {
  ColorSpaceDef,
  CompositeGraphicUnit,
  DrawParam,
  FontResource,
  ImageFormat,
  ImageResource,
  Pattern,
  ResourceDefinitionSet,
  ResourceId,
} from './types';
import { dirnameOf, normalizePackagePath, resolvePackagePath } from '../container/path';
import { normalizeResourceId } from './ids';
import type { ContentDecodeContext } from './content';
import { decodePageBlockNode } from './content';
import type { DecodeWarningContext } from './decode-utils';
import {
  attr,
  attrAny,
  booleanAttr,
  child,
  childText,
  children,
  emitWarning,
  numberArrayAttr,
  numberAttr,
  parseCap,
  parseJoin,
} from './decode-utils';
import type { DecodeOptions } from './decode';
import { decodeColorSpace, decodePaintChild } from './paint';

/** 图片扩展名 → 格式。 */
const IMAGE_FORMATS: Readonly<Record<string, ImageFormat>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  tif: 'tiff',
  tiff: 'tiff',
  jb2: 'jbig2',
  jbig2: 'jbig2',
};

/** MultiMedia 的 Format 属性可能写 MIME/大写枚举。 */
const FORMAT_ATTRS: Readonly<Record<string, ImageFormat>> = {
  png: 'png',
  'image/png': 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  'image/jpeg': 'jpeg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  tif: 'tiff',
  tiff: 'tiff',
  jbig2: 'jbig2',
  'image/jbig2': 'jbig2',
};

/**
 * 推断图片格式：优先 Format 属性，其次扩展名。
 *
 * @param formatAttr `Format` 属性。
 * @param path 包内路径。
 * @returns 图片格式；未知时 `unknown`。
 */
function inferImageFormat(formatAttr: string | undefined, path: string): ImageFormat {
  if (formatAttr !== undefined) {
    const key = formatAttr.trim().toLowerCase();
    const mapped = FORMAT_ATTRS[key];
    if (mapped) return mapped;
  }
  const match = /\.([^./]+)$/.exec(path);
  if (match) {
    const mapped = IMAGE_FORMATS[(match[1] as string).toLowerCase()];
    if (mapped) return mapped;
  }
  return 'unknown';
}

/**
 * 构造包内路径解析器。
 *
 * @param filePath 资源 XML 的包内路径。
 * @param baseLoc `BaseLoc` 属性。
 * @param context warning 上下文。
 * @returns 解析函数；非法路径返回 undefined 并 warning。
 */
function createPathResolver(
  filePath: string,
  baseLoc: string | undefined,
  context: DecodeWarningContext,
): (raw: string) => string | undefined {
  const xmlDir = dirnameOf(filePath);
  let baseDir = xmlDir;
  const normalizedBaseLoc = baseLoc?.trim();
  if (normalizedBaseLoc) {
    try {
      baseDir = resolvePackagePath(xmlDir, normalizedBaseLoc);
    } catch (error) {
      emitWarning(context, 'W_BAD_NUMBER', `BaseLoc 非法：${JSON.stringify(normalizedBaseLoc)}（${String(error)}）`);
    }
  }
  return (raw: string): string | undefined => {
    const value = raw.trim().replace(/\\/g, '/');
    if (!value) return undefined;
    try {
      return value.startsWith('/') ? normalizePackagePath(value) : resolvePackagePath(baseDir, value);
    } catch (error) {
      emitWarning(context, 'W_BAD_NUMBER', `资源路径非法：${JSON.stringify(raw)}（${String(error)}）`);
      return undefined;
    }
  };
}

/**
 * 解析资源 XML。
 *
 * @param root 资源 XML 根节点。
 * @param filePath 资源 XML 的包内路径。
 * @param options 解码选项（颜色空间、DefaultCS、warning）。
 * @returns 资源定义集合；同一文件内重复 ID 保留第一个并 warning。
 */
export function decodeResourceSet(
  root: XmlNode,
  filePath: string,
  options?: DecodeOptions,
): ResourceDefinitionSet {
  const baseContext: DecodeWarningContext = {
    ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
    resourceId: filePath,
  };
  const colorSpaces = new Map<ResourceId, ColorSpaceDef>(options?.colorSpaces ?? []);
  const patterns = new Map<ResourceId, Pattern>();
  const context: ContentDecodeContext = {
    ...baseContext,
    colorSpaces,
    ...(options?.defaultColorSpaceId ? { defaultColorSpaceId: options.defaultColorSpaceId } : {}),
    patterns,
    resolvePath: createPathResolver(filePath, attr(root, 'BaseLoc'), baseContext),
  };
  context.decodePageBlock = (node) => decodePageBlockNode(node, context);

  const colors = new Set<ResourceId>();
  const ownColorSpaces: ColorSpaceDef[] = [];
  for (const group of children(root, 'ColorSpaces')) {
    for (const node of children(group, 'ColorSpace')) {
      const decoded = decodeColorSpace(node, context);
      if (!decoded.id) continue;
      if (colors.has(decoded.id)) {
        emitWarning(context, 'W_DUPLICATE_RESOURCE', `ColorSpace ID 重复：${decoded.id}，保留先出现者`, {
          resourceId: decoded.id,
        });
        continue;
      }
      colors.add(decoded.id);
      colorSpaces.set(decoded.id, decoded);
      ownColorSpaces.push(decoded);
    }
  }

  const fonts: FontResource[] = [];
  const fontIds = new Set<ResourceId>();
  for (const group of children(root, 'Fonts')) {
    for (const node of children(group, 'Font')) {
      const decoded = decodeFont(node, context);
      if (!decoded) continue;
      if (fontIds.has(decoded.id)) {
        emitWarning(context, 'W_DUPLICATE_RESOURCE', `Font ID 重复：${decoded.id}，保留先出现者`, {
          resourceId: decoded.id,
        });
        continue;
      }
      fontIds.add(decoded.id);
      fonts.push(decoded);
    }
  }

  const images: ImageResource[] = [];
  const imageIds = new Set<ResourceId>();
  for (const group of children(root, 'MultiMedias')) {
    for (const node of children(group, 'MultiMedia')) {
      const decoded = decodeImage(node, context);
      if (!decoded) continue;
      if (imageIds.has(decoded.id)) {
        emitWarning(context, 'W_DUPLICATE_RESOURCE', `MultiMedia ID 重复：${decoded.id}，保留先出现者`, {
          resourceId: decoded.id,
        });
        continue;
      }
      imageIds.add(decoded.id);
      images.push(decoded);
    }
  }

  const drawParams: DrawParam[] = [];
  const drawParamIds = new Set<ResourceId>();
  for (const group of children(root, 'DrawParams')) {
    for (const node of children(group, 'DrawParam')) {
      const decoded = decodeDrawParam(node, context);
      if (!decoded?.id) continue;
      if (drawParamIds.has(decoded.id)) {
        emitWarning(context, 'W_DUPLICATE_RESOURCE', `DrawParam ID 重复：${decoded.id}，保留先出现者`, {
          resourceId: decoded.id,
        });
        continue;
      }
      drawParamIds.add(decoded.id);
      drawParams.push(decoded);
    }
  }

  const compositeGraphicUnits: CompositeGraphicUnit[] = [];
  const compositeIds = new Set<ResourceId>();
  for (const group of children(root, 'CompositeGraphicUnits')) {
    for (const node of children(group, 'CompositeGraphicUnit')) {
      const decoded = decodeComposite(node, context);
      if (!decoded) continue;
      if (compositeIds.has(decoded.id)) {
        emitWarning(context, 'W_DUPLICATE_RESOURCE', `CompositeGraphicUnit ID 重复：${decoded.id}，保留先出现者`, {
          resourceId: decoded.id,
        });
        continue;
      }
      compositeIds.add(decoded.id);
      compositeGraphicUnits.push(decoded);
    }
  }

  return { fonts, images, drawParams, compositeGraphicUnits, colorSpaces: ownColorSpaces, patterns };
}

/**
 * 解码字体定义。
 *
 * @param node `Font` 节点。
 * @param context 解码上下文。
 * @returns 字体资源；缺少 ID 时返回 undefined。
 */
function decodeFont(node: XmlNode, context: ContentDecodeContext): FontResource | undefined {
  const id = normalizeResourceId(attr(node, 'ID'));
  if (!id) {
    emitWarning(context, 'W_BAD_NUMBER', 'Font 缺少 ID，已跳过');
    return undefined;
  }
  const fontContext = { ...context, resourceId: id };
  const fontFileRaw = childText(node, 'FontFile');
  const fontFile = fontFileRaw ? context.resolvePath?.(fontFileRaw) : undefined;
  if (fontFileRaw && !fontFile) {
    emitWarning(fontContext, 'W_FONT_MISSING', `FontFile 路径无法解析：${fontFileRaw}`);
  }
  // 无 FontFile 是合法声明：字体可由 FontProvider/supplementaryFonts 提供，
  // 真正无法解析时由 FontLibrary.resolve 统一产生 W_FONT_MISSING。
  const fontName = (attr(node, 'FontName') ?? attr(node, 'FamilyName') ?? '').trim();
  if (!fontName) emitWarning(fontContext, 'W_FONT_MISSING', `Font ${id} 缺少 FontName`);
  const result: FontResource = {
    id,
    fontName,
    charset: (attr(node, 'Charset') ?? 'unicode').trim().toLowerCase(),
    serif: booleanAttr(node, 'Serif', false, fontContext),
    bold: booleanAttr(node, 'Bold', false, fontContext),
    italic: booleanAttr(node, 'Italic', false, fontContext),
    fixedSize: booleanAttr(node, attr(node, 'FixedSize') !== undefined ? 'FixedSize' : 'FixedWidth', false, fontContext),
  };
  const familyName = attr(node, 'FamilyName');
  if (familyName) result.familyName = familyName.trim();
  if (fontFile) result.fontFile = fontFile;
  return result;
}

/**
 * 解码图片资源（MultiMedia）。
 *
 * @param node `MultiMedia` 节点。
 * @param context 解码上下文。
 * @returns 图片资源；非 Image 类型或缺少 ID/MediaFile 时返回 undefined。
 */
function decodeImage(node: XmlNode, context: ContentDecodeContext): ImageResource | undefined {
  const typeRaw = attr(node, 'Type');
  if (typeRaw !== undefined && typeRaw.trim().toLowerCase() !== 'image') return undefined;
  const id = normalizeResourceId(attr(node, 'ID'));
  if (!id) {
    emitWarning(context, 'W_BAD_NUMBER', 'MultiMedia 缺少 ID，已跳过');
    return undefined;
  }
  const imageContext = { ...context, resourceId: id };
  const mediaRaw = childText(node, 'MediaFile');
  if (!mediaRaw) {
    emitWarning(imageContext, 'W_IMAGE_DECODE', `图片资源 ${id} 缺少 MediaFile，已跳过`);
    return undefined;
  }
  const mediaFile = context.resolvePath?.(mediaRaw);
  if (!mediaFile) {
    emitWarning(imageContext, 'W_IMAGE_DECODE', `图片资源 ${id} 的 MediaFile 路径无法解析，已跳过`);
    return undefined;
  }
  return {
    id,
    mediaFile,
    format: inferImageFormat(attr(node, 'Format'), mediaFile),
  };
}

/**
 * 解码 DrawParam 资源。
 *
 * @param node `DrawParam` 节点。
 * @param context 解码上下文。
 * @returns DrawParam；缺少 ID 时返回 undefined。
 */
function decodeDrawParam(node: XmlNode, context: ContentDecodeContext): DrawParam | undefined {
  const id = normalizeResourceId(attr(node, 'ID'));
  if (!id) {
    emitWarning(context, 'W_BAD_NUMBER', 'DrawParam 缺少 ID，已跳过');
    return undefined;
  }
  const drawContext = { ...context, resourceId: id };
  const result: DrawParam = { id };
  const relativeRaw = attr(node, 'Relative');
  if (relativeRaw !== undefined) {
    const relative = normalizeResourceId(relativeRaw);
    if (relative) result.relative = relative;
  }
  const lineWidthRaw = attrAny(node, ['LineWidth', 'LincWidth']);
  if (lineWidthRaw !== undefined) result.lineWidth = numberAttr(node, attr(node, 'LineWidth') !== undefined ? 'LineWidth' : 'LincWidth', 0.353, drawContext, 'LineWidth');
  if (attr(node, 'Cap') !== undefined) result.cap = parseCap(attr(node, 'Cap'), 'Butt', drawContext);
  if (attr(node, 'Join') !== undefined) result.join = parseJoin(attr(node, 'Join'), 'Miter', drawContext);
  if (attr(node, 'MiterLimit') !== undefined) result.miterLimit = numberAttr(node, 'MiterLimit', 4.234, drawContext, 'MiterLimit');
  if (attr(node, 'DashOffset') !== undefined) result.dashOffset = numberAttr(node, 'DashOffset', 0, drawContext, 'DashOffset');
  if (attr(node, 'DashPattern') !== undefined) result.dashPattern = numberArrayAttr(node, 'DashPattern', [], drawContext);
  if (attr(node, 'Alpha') !== undefined) {
    const alpha = numberAttr(node, 'Alpha', 255, drawContext, 'Alpha');
    result.alpha = Math.max(0, Math.min(255, alpha));
  }
  const fillColor = decodePaintChild(node, 'FillColor', drawContext);
  if (fillColor) result.fillColor = fillColor;
  const strokeColor = decodePaintChild(node, 'StrokeColor', drawContext);
  if (strokeColor) result.strokeColor = strokeColor;
  return result;
}

/**
 * 解码复合图形资源。
 *
 * @param node `CompositeGraphicUnit` 节点。
 * @param context 解码上下文。
 * @returns 复合资源；缺少 ID 时返回 undefined。
 */
function decodeComposite(
  node: XmlNode,
  context: ContentDecodeContext,
): CompositeGraphicUnit | undefined {
  const id = normalizeResourceId(attr(node, 'ID'));
  if (!id) {
    emitWarning(context, 'W_BAD_NUMBER', 'CompositeGraphicUnit 缺少 ID，已跳过');
    return undefined;
  }
  const compositeContext = { ...context, resourceId: id };
  const width = numberAttr(node, 'Width', 0, compositeContext, 'Width');
  const height = numberAttr(node, 'Height', 0, compositeContext, 'Height');
  if (width <= 0 || height <= 0) {
    emitWarning(compositeContext, 'W_BAD_NUMBER', `CompositeGraphicUnit ${id} 尺寸非正：${width} × ${height}`);
  }
  const contentNode = child(node, 'Content');
  const content = contentNode
    ? decodePageBlockNode(contentNode, compositeContext)
    : { kind: 'block' as const, children: [] };
  if (!contentNode) {
    emitWarning(compositeContext, 'W_COMPOSITE_DEPTH', `CompositeGraphicUnit ${id} 缺少 Content`);
  }
  return { id, width, height, content };
}