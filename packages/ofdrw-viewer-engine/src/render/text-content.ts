/**
 * 阅读器文本内容收集内核（v1.1）。
 *
 * 只读已准备的页面模型与 `layoutText` 的 glyph placement，不调用 Canvas 文字
 * API、不绘制。内部以 mm 保存布局，按输出 DPI 转 px；页面/模板/复合/注释
 * 遍历顺序复用 `resolvePageDrawOrder`，保证与 `drawPage` 的视觉顺序一致。
 */

import type { Box, Matrix } from '../common/types';
import type { FontFace, FontFaceSet } from '../font/types';
import type {
  GraphicUnitBase,
  Layer,
  PageObject,
  ResourceId,
  TextObject,
} from '../model/types';
import type { PreparedPageBundle } from './prepare';
import { OFDError } from '../errors';
import {
  IDENTITY_MATRIX,
  multiplyMatrix,
  normalizeBox,
  transformPoint,
  translateMatrix,
} from '../common/matrix';
import { compositeBlockCacheKey, getBlockStyles } from './object';
import { resolvePageDrawOrder } from './page';
import type { PageContentFilter } from './content-filter';
import { layoutText } from './text';
import type { GlyphPlacement, TextLayout, TextLayoutUnit } from './text';

/** 文本项默认上限；与文本内容 API 契约一致。 */
const DEFAULT_MAX_TEXT_ITEMS = 20_000;

/** 字符默认上限；与文本内容 API 契约一致。 */
const DEFAULT_MAX_TEXT_CHARS = 500_000;

/** 独立块递归深度上限；与绘制阶段一致。 */
const MAX_BLOCK_DEPTH = 16;

/** 页面内容层类型。 */
export type TextContentLayer = 'template' | 'page' | 'annotation';

/** 字体元信息；不包含字体对象。 */
export interface TextFontInfoData {
  /** 字体资源 ID。 */
  resourceId: ResourceId;
  /** 字体族名。 */
  family: string;
  /** PostScript 名。 */
  postscriptName?: string;
  /** OS/2 weightClass。 */
  weightClass?: number;
  /** 字体本身是否斜体。 */
  italic: boolean;
}

/** 字符单元：mm 坐标，供内部缓存。 */
export interface TextCharMm {
  /** 该码点的文本。 */
  text: string;
  /** Unicode 码点。 */
  codePoint: number;
  /** 实际字形 ID；缺字时 undefined。 */
  glyphId?: number;
  /** 实际字体面 key；缺字时 undefined。 */
  faceKey?: string;
  /** 是否使用回退字体。 */
  fallback: boolean;
  /** 字符起点（baseline），mm。 */
  origin: { x: number; y: number };
  /** 字符推进量，mm；缺字为 0。 */
  advance: number;
  /** 字符包围盒，mm。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 字符单元四点，mm；顺序左上、右上、右下、左下。 */
  quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  /** 是否由多字形 run 的组框近似。 */
  approximate: boolean;
}

/** 文本项：mm 坐标，供内部缓存。 */
export interface TextItemMm {
  /** 绘制顺序下标。 */
  order: number;
  /** TextObject ID。 */
  objectId?: string;
  /** 模板页 ID。 */
  templateId?: string;
  /** 注释 ID。 */
  annotationId?: string;
  /** 复合块 ID。 */
  blockId?: string;
  /** 所在层。 */
  layer: TextContentLayer;
  /** 所在图层类型。 */
  layerType: Layer['type'];
  /** 模板有效 ZOrder。 */
  zOrder?: 'Background' | 'Body' | 'Foreground';
  /** 对象自身是否参与绘制。 */
  visible: boolean;
  /** 对象自身 alpha，0..1。 */
  alpha: number;
  /** 按 TextCode 顺序拼接的可见文本；过滤 XML 排版 CR/LF。 */
  text: string;
  /** 主字体元信息。 */
  font: TextFontInfoData;
  /** 字号，mm。 */
  size: number;
  /** 布局局部坐标 → 页面 mm 的矩阵。 */
  transform: Matrix;
  /** 首字符 baseline 起点，mm。 */
  origin: { x: number; y: number };
  /** 文本项包围盒，mm。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 文本项外接四边形，mm。 */
  quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  /** 沿阅读方向的推进量，mm。 */
  advance: number;
  /** 字符数（按布局码点计）。 */
  charCount: number;
  /** 字符级数据；includeChars=false 时省略。 */
  chars?: TextCharMm[];
}

/** 单页文本布局：mm 缓存形态。 */
export interface TextPageMm {
  /** 页索引。 */
  pageIndex: number;
  /** 页宽，mm。 */
  pageWidthMm: number;
  /** 页高，mm。 */
  pageHeightMm: number;
  /** 按绘制顺序的文本项。 */
  items: TextItemMm[];
  /** 文本项数。 */
  itemCount: number;
  /** 字符数；不受 includeChars 影响。 */
  charCount: number;
  /** 截断状态。 */
  truncated: { items: boolean; chars: boolean };
}

/** 字符单元：px 输出。 */
export interface TextCharPx extends Omit<TextCharMm, 'origin' | 'advance' | 'rect' | 'quad'> {
  /** 字符起点，px。 */
  origin: { x: number; y: number };
  /** 字符推进量，px。 */
  advance: number;
  /** 字符包围盒，px。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 字符四点，px。 */
  quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
}

/** 文本项：px 输出。 */
export interface TextItemPx extends Omit<
  TextItemMm,
  'size' | 'transform' | 'origin' | 'rect' | 'quad' | 'advance' | 'chars'
> {
  /** 字号，px。 */
  size: number;
  /** 布局局部 mm → 页面 px 的矩阵。 */
  transform: Matrix;
  /** 首字符起点，px。 */
  origin: { x: number; y: number };
  /** 包围盒，px。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 外接四边形，px。 */
  quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  /** 沿阅读方向推进量，px。 */
  advance: number;
  /** 字符级数据。 */
  chars?: TextCharPx[];
}

/** 单页文本内容：px 输出。 */
export interface TextPagePx extends Omit<TextPageMm, 'pageWidthMm' | 'pageHeightMm' | 'items'> {
  /** 输出 DPI。 */
  dpi: number;
  /** 坐标单位。 */
  unit: 'px';
  /** 页宽，px。 */
  pageWidth: number;
  /** 页高，px。 */
  pageHeight: number;
  /** 文本项。 */
  items: TextItemPx[];
}

/** 文本收集选项。 */
export interface TextContentCollectOptions {
  /** 输出层保持原顺序；mm 收集阶段不换算 DPI。 */
  layerOrder?: 'document' | 'type';
  /** 是否返回 chars，默认 true。 */
  includeChars?: boolean;
  /** 是否包含注释 Appearance，默认 false；注释类型仍受 contentFilter 白名单约束。 */
  includeAnnotations?: boolean;
  /**
   * 页级绘制内容白名单；不传表示全部绘制。
   * 与 `drawPage` 使用同一组判定，隐藏的内容不会进入文本层。
   */
  contentFilter?: PageContentFilter;
  /** 是否包含不可见文字，默认 false。 */
  includeInvisible?: boolean;
  /** 取消信号；中止抛 `OFD_ABORTED`。 */
  signal?: AbortSignal;
  /** 文本项上限，默认 20,000；0 表示不限。 */
  maxTextItems?: number;
  /** 字符上限，默认 500,000；0 表示不限。 */
  maxTextChars?: number;
  /** 页索引，仅用于 warning 与结果。 */
  pageIndex?: number;
  /** warning 回调。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/** 收集过程中的可变计数与停止标志。 */
interface CollectState {
  items: TextItemMm[];
  charCount: number;
  /** 是否继续遍历。 */
  stop: boolean;
  truncated: { items: boolean; chars: boolean };
  warnedItemLimit: boolean;
  warnedCharLimit: boolean;
}

/** 单次遍历的层上下文。 */
interface LayerContext {
  layer: TextContentLayer;
  layerType: Layer['type'];
  templateId?: string;
  annotationId?: string;
  zOrder?: 'Background' | 'Body' | 'Foreground';
}

/**
 * 收集一页文本布局（mm）。
 *
 * 页面内容按 `resolvePageDrawOrder` 展开，模板/页图层/注释与绘制顺序一致；
 * Pattern tile 与 ClipArea.text 不属于页面内容，不会被访问。
 *
 * @param prepared 已准备页面。
 * @param options 遍历、可见性、内容过滤、字符与上限选项。
 * @returns mm 文本布局；同一结果可复用于任意 DPI。
 */
export function collectTextPageMm(
  prepared: PreparedPageBundle,
  options: TextContentCollectOptions = {},
): TextPageMm {
  const page = prepared.page.page;
  const pageIndex = options.pageIndex ?? 0;
  const warn = (code: string, message: string, objectId?: string): void => {
    options.onWarning?.(code, message, objectId);
  };
  const state: CollectState = {
    items: [],
    charCount: 0,
    stop: false,
    truncated: { items: false, chars: false },
    warnedItemLimit: false,
    warnedCharLimit: false,
  };
  const maxItems = normalizeLimit(options.maxTextItems, DEFAULT_MAX_TEXT_ITEMS);
  const maxChars = normalizeLimit(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
  const includeChars = options.includeChars ?? true;
  const includeInvisible = options.includeInvisible ?? false;
  const base = translateMatrix(IDENTITY_MATRIX, -page.area.x, -page.area.y);

  const entries = resolvePageDrawOrder(prepared, {
    layerOrder: options.layerOrder ?? 'type',
    includeAnnotations: options.includeAnnotations ?? false,
    contentFilter: options.contentFilter,
    onWarning: options.onWarning
      ? (warning) => options.onWarning?.(warning.code, warning.message, warning.objectId)
      : undefined,
  });

  for (const entry of entries) {
    if (state.stop) break;
    checkAborted(options.signal);
    if (entry.kind === 'annotation') {
      const block = entry.block;
      // 注释块按 drawPage 的放置方式平移；Boundary 不做归一化，保持与绘制一致。
      const boundary = block.boundary;
      const matrix = boundary
        ? multiplyMatrix(base, translateMatrix(IDENTITY_MATRIX, boundary.x, boundary.y))
        : base;
      const styles = getBlockStyles(block);
      if (!styles) continue;
      visitObjects(block.content.children, matrix, styles, {
        layer: 'annotation',
        layerType: 'Body',
        annotationId: block.id,
      });
      continue;
    }
    const info: LayerContext = {
      layer: entry.kind,
      layerType: entry.layerType,
      ...(entry.templateId !== undefined ? { templateId: entry.templateId } : {}),
      ...(entry.zOrder !== undefined ? { zOrder: entry.zOrder } : {}),
    };
    visitObjects(entry.objects, base, prepared.page.styles, info);
  }

  return {
    pageIndex,
    pageWidthMm: page.size.width,
    pageHeightMm: page.size.height,
    items: state.items,
    itemCount: state.items.length,
    charCount: state.charCount,
    truncated: state.truncated,
  };

  /**
   * 递归访问页面对象；块本身不产生文本项。
   *
   * @param objects 当前对象数组。
   * @param matrix 当前空间 → 页面 mm 矩阵。
   * @param styles 当前样式映射。
   * @param info 层上下文。
   * @param blockId 当前复合块 ID。
   * @param depth 块递归深度。
   */
  function visitObjects(
    objects: readonly PageObject[],
    matrix: Matrix,
    styles: WeakMap<GraphicUnitBase, import('../style/types').ResolvedStyle>,
    info: LayerContext,
    blockId?: string,
    depth = 0,
  ): void {
    for (const object of objects) {
      if (state.stop) return;
      checkAborted(options.signal);
      if (object.kind === 'block') {
        if (depth >= MAX_BLOCK_DEPTH) {
          warn('W_COMPOSITE_DEPTH', '页面块递归超过上限，已跳过', object.id);
          continue;
        }
        visitObjects(object.children, matrix, styles, info, blockId, depth + 1);
        continue;
      }
      const style = styles.get(object);
      if (!style) {
        warn('W_UNSUPPORTED_PAINT', `对象 ${object.id ?? '(anonymous)'} 缺少结算样式，已跳过`, object.id);
        continue;
      }
      if (!includeInvisible && (!object.visible || object.alpha === 0)) continue;
      const boundary = normalizeBox(object.boundary);
      if (!(boundary.w > 0) || !(boundary.h > 0)) continue;

      if (object.kind === 'text') {
        if (!(style.fill || style.stroke)) continue;
        if (!(object.size > 0)) continue;
        addTextItem(object, matrix, boundary, info, blockId);
        continue;
      }
      if (object.kind !== 'composite') continue;
      if (depth >= MAX_BLOCK_DEPTH) {
        warn('W_COMPOSITE_DEPTH', '复合对象递归超过上限，已跳过', object.id);
        continue;
      }
      const childMatrix = multiplyMatrix(
        multiplyMatrix(matrix, translateMatrix(IDENTITY_MATRIX, boundary.x, boundary.y)),
        object.ctm ?? IDENTITY_MATRIX,
      );
      const block =
        prepared.blocks.get(compositeBlockCacheKey(object.resourceId, style)) ??
        prepared.blocks.get(object.resourceId);
      if (!block) {
        warn('W_COMPOSITE_DEPTH', `复合资源 ${object.resourceId} 缺少独立块，已跳过`, object.id);
        continue;
      }
      // 底纹 cell 是 Paint，不是页面内容；即使被错误引用也不进入阅读层。
      if (block.source === 'pattern-cell') continue;
      const blockStyles = getBlockStyles(block);
      if (!blockStyles) {
        warn('W_UNSUPPORTED_PAINT', `复合块 ${object.resourceId} 缺少样式，已跳过`, object.id);
        continue;
      }
      visitObjects(
        block.content.children,
        childMatrix,
        blockStyles,
        info,
        block.id ?? object.id ?? object.resourceId,
        depth + 1,
      );
    }
  }

  /**
   * 把一个 TextObject 加入结果。
   *
   * @param object 文字对象。
   * @param matrix 当前空间 → 页面 mm 矩阵。
   * @param boundary 归一化 Boundary。
   * @param info 层上下文。
   * @param blockId 复合块 ID。
   */
  function addTextItem(
    object: TextObject,
    matrix: Matrix,
    boundary: Box,
    info: LayerContext,
    blockId: string | undefined,
  ): void {
    const faces = prepared.fonts.get(object.font);
    if (!faces) {
      warn('W_FONT_MISSING', `字体资源 ${object.font} 未加载，已跳过文本项`, object.id);
      return;
    }
    const charCount = textCodePointCount(object);
    if (!state.truncated.chars && maxChars > 0 && state.charCount + charCount > maxChars) {
      state.truncated.chars = true;
      if (!state.warnedCharLimit) {
        state.warnedCharLimit = true;
        warn(
          'W_TEXT_CHAR_LIMIT',
          `文本字符数超过上限 ${maxChars}，已停止收集`,
          object.id,
        );
      }
      state.stop = true;
      return;
    }
    if (!state.truncated.items && maxItems > 0 && state.items.length >= maxItems) {
      state.truncated.items = true;
      if (!state.warnedItemLimit) {
        state.warnedItemLimit = true;
        warn(
          'W_TEXT_ITEM_LIMIT',
          `文本项数达到上限 ${maxItems}，已停止收集`,
          object.id,
        );
      }
      state.stop = true;
      return;
    }

    const itemMatrix = multiplyMatrix(
      multiplyMatrix(matrix, translateMatrix(IDENTITY_MATRIX, boundary.x, boundary.y)),
      object.ctm ?? IDENTITY_MATRIX,
    );
    const layout = layoutText(object, faces, {
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      ...(object.id !== undefined ? { objectId: object.id } : {}),
    });
    const chars = buildChars(object, layout, itemMatrix, faces);
    const font = fontInfo(object.font, faces);
    // origin 取第一个真正有 placement 的字符；全缺字时取第一个字符/对象起点。
    const positioned = chars.find((char) => char.glyphId !== undefined);
    const first = chars[0];
    const origin = positioned?.origin ?? (first ? first.origin : transformPoint(itemMatrix, { x: 0, y: 0 }));
    const advance = itemAdvance(layout);
    const rect =
      chars.length > 0
        ? unionCharRects(chars)
        : {
            x: origin.x,
            y: origin.y - object.size,
            width: 0,
            height: object.size,
          };
    const textItem: TextItemMm = {
      order: state.items.length,
      ...(object.id !== undefined ? { objectId: object.id } : {}),
      ...(info.templateId !== undefined ? { templateId: info.templateId } : {}),
      ...(info.annotationId !== undefined ? { annotationId: info.annotationId } : {}),
      ...(blockId !== undefined ? { blockId } : {}),
      layer: info.layer,
      layerType: info.layerType,
      ...(info.zOrder !== undefined ? { zOrder: info.zOrder } : {}),
      visible: object.visible && object.alpha > 0,
      alpha: object.alpha / 255,
      // CR/LF 是 XML 排版字符，不参与可见文字布局；普通空格等其他码点保留。
      text: object.codes.map((code) => visibleCodePointText(code.text)).join(''),
      font,
      size: object.size,
      transform: itemMatrix,
      origin,
      rect,
      quad: rectQuad(rect),
      advance,
      charCount,
      ...(includeChars ? { chars } : {}),
    };
    state.items.push(textItem);
    state.charCount += charCount;
  }
}

/**
 * 把 mm 布局转换为 px 输出；DPI 不参与缓存。
 *
 * @param page mm 文本布局。
 * @param dpi 输出精度，单位 DPI；非法值回退 96。
 * @returns px 文本内容。
 */
export function toTextPagePx(page: TextPageMm, dpi = 96): TextPagePx {
  const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 96;
  const scale = safeDpi / 25.4;
  return {
    pageIndex: page.pageIndex,
    dpi: safeDpi,
    unit: 'px',
    pageWidth: page.pageWidthMm * scale,
    pageHeight: page.pageHeightMm * scale,
    itemCount: page.itemCount,
    charCount: page.charCount,
    truncated: { ...page.truncated },
    items: page.items.map((item) => toItemPx(item, scale)),
  };
}

/**
 * 把单个 mm 文本项转换为 px。
 *
 * @param item mm 文本项。
 * @param scale 每 mm 像素数。
 * @returns px 文本项。
 */
function toItemPx(item: TextItemMm, scale: number): TextItemPx {
  return {
    ...item,
    size: item.size * scale,
    transform: [
      item.transform[0] * scale,
      item.transform[1] * scale,
      item.transform[2] * scale,
      item.transform[3] * scale,
      item.transform[4] * scale,
      item.transform[5] * scale,
    ],
    origin: scalePoint(item.origin, scale),
    rect: scaleRect(item.rect, scale),
    quad: scaleQuad(item.quad, scale),
    advance: item.advance * scale,
    ...(item.chars
      ? {
          chars: item.chars.map((char) => ({
            ...char,
            origin: scalePoint(char.origin, scale),
            advance: char.advance * scale,
            rect: scaleRect(char.rect, scale),
            quad: scaleQuad(char.quad, scale),
          })),
        }
      : {}),
  };
}

/**
 * 构造一个文字对象的字符几何。
 *
 * 1:1 placement 逐字符映射；多字形/连字按 run 组框近似；缺失字形保持
 * advance=0、四点为起点。
 *
 * @param object 文字对象。
 * @param layout 布局结果。
 * @param matrix 对象局部 → 页面 mm 矩阵。
 * @param faces 字体链。
 * @returns 按码点顺序的字符。
 */
function buildChars(
  object: TextObject,
  layout: TextLayout,
  matrix: Matrix,
  faces: FontFaceSet,
): TextCharMm[] {
  const result: TextCharMm[] = [];
  const unitsByCode = new Map<number, TextLayoutUnit[]>();
  for (const unit of layout.units) {
    const list = unitsByCode.get(unit.codeIndex);
    if (list) list.push(unit);
    else unitsByCode.set(unit.codeIndex, [unit]);
  }
  const [dirX, dirY] = readDirection(object.readDirection);

  for (const [codeIndex, code] of object.codes.entries()) {
    const codePoints = layoutCodePoints(code.text);
    const fallback = new Array<TextCharMm | undefined>(codePoints.length);
    for (const unit of unitsByCode.get(codeIndex) ?? []) {
      const start = Math.max(0, unit.cpStart);
      const end = Math.min(codePoints.length, start + unit.codeCount);
      if (unit.placements.length === 0) {
        for (let index = start; index < end; index += 1) {
          fallback[index] = missingChar(codePoints[index], unit, matrix);
        }
        continue;
      }
      if (unit.placements.length === unit.codeCount) {
        for (let index = start; index < end; index += 1) {
          const placement = unit.placements[index - start];
          if (placement) {
            fallback[index] = placementChar(
              codePoints[index],
              placement,
              matrix,
              faces,
              object,
            );
          }
        }
        continue;
      }
      // 多字形 run / 连字：用一个组框近似覆盖该 run 的所有字符。
      const first = unit.placements[0];
      const last = unit.placements[unit.placements.length - 1];
      const endX = last.x + dirX * last.advance;
      const endY = last.y + dirY * last.advance;
      const advance = Math.hypot(endX - first.x, endY - first.y);
      for (let index = start; index < end; index += 1) {
        fallback[index] = approximateChar(
          codePoints[index],
          unit,
          first.x,
          first.y,
          advance,
          matrix,
          object,
        );
      }
    }
    for (let index = 0; index < codePoints.length; index += 1) {
      result.push(fallback[index] ?? missingCharAt(codePoints[index], 0, 0, matrix));
    }
  }
  return result;
}

/**
 * 1:1 placement 的字符几何。
 *
 * @param codePoint Unicode 码点。
 * @param placement 字形放置。
 * @param matrix 对象局部 → 页面 mm 矩阵。
 * @param faces 字体链。
 * @param object 文字对象。
 * @returns 字符几何。
 */
function placementChar(
  codePoint: number,
  placement: GlyphPlacement,
  matrix: Matrix,
  faces: FontFaceSet,
  object: TextObject,
): TextCharMm {
  const origin = transformPoint(matrix, { x: placement.x, y: placement.y });
  const quad = charQuad(matrix, placement.x, placement.y, placement.advance, object);
  return {
    text: String.fromCodePoint(codePoint),
    codePoint,
    glyphId: placement.gid,
    faceKey: placement.faceKey,
    fallback: placement.faceKey !== faces.primary.key,
    origin,
    advance: placement.advance,
    rect: quadRect(quad),
    quad,
    approximate: false,
  };
}

/**
 * 缺失字形的字符几何。
 *
 * @param codePoint Unicode 码点。
 * @param unit 布局单元。
 * @param matrix 对象局部 → 页面 mm 矩阵。
 * @returns 字符几何。
 */
function missingChar(codePoint: number, unit: TextLayoutUnit, matrix: Matrix): TextCharMm {
  return missingCharAt(codePoint, unit.x, unit.y, matrix);
}

/**
 * 在指定起点构造缺失字形。
 *
 * @param codePoint Unicode 码点。
 * @param x 起点 x，mm。
 * @param y 起点 y，mm。
 * @param matrix 对象局部 → 页面 mm 矩阵。
 * @returns 字符几何。
 */
function missingCharAt(
  codePoint: number,
  x: number,
  y: number,
  matrix: Matrix,
): TextCharMm {
  const origin = transformPoint(matrix, { x, y });
  return {
    text: String.fromCodePoint(codePoint),
    codePoint,
    fallback: false,
    origin,
    advance: 0,
    rect: { x: origin.x, y: origin.y, width: 0, height: 0 },
    quad: [origin, origin, origin, origin],
    approximate: false,
  };
}

/**
 * 多字形 run 的近似字符几何；每个字符使用同一个 run 组框。
 *
 * @param codePoint Unicode 码点。
 * @param unit 布局单元。
 * @param x run 起点 x，mm。
 * @param y run 起点 y，mm。
 * @param advance run 推进量，mm。
 * @param matrix 对象局部 → 页面 mm 矩阵。
 * @param object 文字对象。
 * @returns 字符几何。
 */
function approximateChar(
  codePoint: number,
  unit: TextLayoutUnit,
  x: number,
  y: number,
  advance: number,
  matrix: Matrix,
  object: TextObject,
): TextCharMm {
  const origin = transformPoint(matrix, { x, y });
  const quad = charQuad(matrix, x, y, advance, object);
  return {
    text: String.fromCodePoint(codePoint),
    codePoint,
    fallback: false,
    origin,
    advance,
    rect: quadRect(quad),
    quad,
    approximate: true,
  };
}

/**
 * 计算字符单元四点：局部 (0,-size)-(advance,0) 经 T(placement)×R(charDirection)。
 *
 * @param matrix 对象局部 → 页面 mm 矩阵。
 * @param x 字符起点 x，mm。
 * @param y 字符起点 y，mm。
 * @param advance 字符推进量，mm。
 * @param object 文字对象。
 * @returns 页面 mm 四点，顺序左上、右上、右下、左下。
 */
function charQuad(
  matrix: Matrix,
  x: number,
  y: number,
  advance: number,
  object: TextObject,
): TextCharMm['quad'] {
  const angle = (normalizeAngle(object.charDirection) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cell = multiplyMatrix(
    multiplyMatrix(matrix, translateMatrix(IDENTITY_MATRIX, x, y)),
    [cos, sin, -sin, cos, 0, 0],
  );
  const size = Number.isFinite(object.size) ? object.size : 0;
  const local = [
    { x: 0, y: -size },
    { x: advance, y: -size },
    { x: advance, y: 0 },
    { x: 0, y: 0 },
  ] as const;
  return [
    transformPoint(cell, local[0]),
    transformPoint(cell, local[1]),
    transformPoint(cell, local[2]),
    transformPoint(cell, local[3]),
  ];
}

/**
 * 计算轴对齐四边形包围盒。
 *
 * @param quad 四点。
 * @returns 包围盒。
 */
function quadRect(quad: TextCharMm['quad']): TextCharMm['rect'] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of quad) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 合并所有字符包围盒。
 *
 * @param chars 字符数组。
 * @returns 包围盒；空数组为零框。
 */
function unionCharRects(chars: readonly TextCharMm[]): TextCharMm['rect'] {
  if (chars.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const char of chars) {
    minX = Math.min(minX, char.rect.x);
    minY = Math.min(minY, char.rect.y);
    maxX = Math.max(maxX, char.rect.x + char.rect.width);
    maxY = Math.max(maxY, char.rect.y + char.rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 由矩形构造轴对齐四边形。
 *
 * @param rect 矩形。
 * @returns 左上、右上、右下、左下。
 */
function rectQuad(rect: TextCharMm['rect']): TextItemMm['quad'] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/**
 * 计算文本项沿阅读方向的推进量。
 *
 * @param layout 布局结果。
 * @returns 推进量，mm。
 */
function itemAdvance(layout: TextLayout): number {
  const first = layout.units[0];
  if (!first) return 0;
  return Math.hypot(layout.endX - first.x, layout.endY - first.y);
}

/**
 * 取字体元信息；主字体没有 PostScript/weight 时省略对应字段。
 *
 * @param resourceId 字体资源 ID。
 * @param faces 字体链。
 * @returns 字体元信息。
 */
function fontInfo(resourceId: ResourceId, faces: FontFaceSet): TextFontInfoData {
  const primary: FontFace = faces.primary;
  return {
    resourceId,
    family: primary.family,
    ...(primary.postscriptName !== undefined ? { postscriptName: primary.postscriptName } : {}),
    ...(primary.weightClass !== undefined ? { weightClass: primary.weightClass } : {}),
    italic: primary.italic ?? false,
  };
}

/**
 * 按可见码点重建文本；过滤 XML 排版 CR/LF，避免大文本展开参数导致栈溢出。
 *
 * @param text TextCode 文本。
 * @returns 过滤后的文本。
 */
function visibleCodePointText(text: string): string {
  let result = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint === 0x0a || codePoint === 0x0d) continue;
    result += char;
  }
  return result;
}

/**
 * 统计文字对象参与布局的码点数。
 *
 * @param object 文字对象。
 * @returns 码点数。
 */
function textCodePointCount(object: TextObject): number {
  let count = 0;
  for (const code of object.codes) count += layoutCodePoints(code.text).length;
  return count;
}

/**
 * 读取码点序列；XML 排版用 CR/LF 不参与文字布局与字符几何。
 *
 * @param text TextCode 文本。
 * @returns Unicode 码点数组。
 */
function layoutCodePoints(text: string): number[] {
  const result: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint === 0x0a || codePoint === 0x0d) continue;
    result.push(codePoint);
  }
  return result;
}

/**
 * 读取方向对应的单位步进。
 *
 * @param direction 阅读方向。
 * @returns X/Y 单位步进。
 */
function readDirection(direction: TextObject['readDirection']): readonly [number, number] {
  switch (direction) {
    case 90:
      return [0, 1];
    case 180:
      return [-1, 0];
    case 270:
      return [0, -1];
    default:
      return [1, 0];
  }
}

/**
 * 归一化字符方向到 0..359。
 *
 * @param direction 字符方向。
 * @returns 角度，度。
 */
function normalizeAngle(direction: TextObject['charDirection']): number {
  return direction === 90 || direction === 180 || direction === 270 ? direction : 0;
}

/**
 * 判断取消并抛出统一错误。
 *
 * @param signal 取消信号。
 */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OFDError('OFD_ABORTED', '文本内容收集已取消');
}

/**
 * 归一化上限；非整数/负数回退默认，0 表示不限。
 *
 * @param value 调用方输入。
 * @param fallback 默认值。
 * @returns 非负整数上限。
 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * 缩放点。
 *
 * @param point mm 点。
 * @param scale 每 mm 像素数。
 * @returns px 点。
 */
function scalePoint(
  point: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  return { x: point.x * scale, y: point.y * scale };
}

/**
 * 缩放矩形。
 *
 * @param rect mm 矩形。
 * @param scale 每 mm 像素数。
 * @returns px 矩形。
 */
function scaleRect(
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * 缩放四边形。
 *
 * @param quad mm 四点。
 * @param scale 每 mm 像素数。
 * @returns px 四点。
 */
function scaleQuad(
  quad: TextCharMm['quad'],
  scale: number,
): TextCharMm['quad'] {
  return [
    scalePoint(quad[0], scale),
    scalePoint(quad[1], scale),
    scalePoint(quad[2], scale),
    scalePoint(quad[3], scale),
  ];
}
