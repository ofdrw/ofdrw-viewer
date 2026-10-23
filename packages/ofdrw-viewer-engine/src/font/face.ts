/**
 * fontkit 封装与字体面创建（对应设计方案 12.1/12.2/12.8）。
 *
 * 兼容 TTF/OTF/TTC/CFF CID 与无 cmap/name/OS2 的剥离子集；
 * fontkit 对象只存在于本模块闭包内，不暴露给文字层与渲染器。
 */

import { create as createFontkit } from 'fontkit';
import type { PathCommand } from '../common/types';
import { OFDError, toOFDError } from '../errors';
import { expandFontNames } from './aliases';
import type { FontFace, FontFaceCreateOptions, Glyph } from './types';
import { LruCache } from './glyph';

/** fontkit 字体面的最小结构；用于在运行时收窄集合/单字体。 */
interface FontkitFaceLike {
  readonly familyName?: string | null;
  readonly postscriptName?: string | null;
  readonly fullName?: string | null;
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  readonly cmap?: unknown;
  readonly 'OS/2'?: { readonly usWeightClass?: number };
  readonly head?: { readonly macStyle?: { readonly bold?: boolean; readonly italic?: boolean } };
  readonly post?: { readonly italicAngle?: number };
  readonly fonts?: readonly FontkitFaceLike[];
  getGlyph(glyphId: number): {
    readonly id?: number;
    readonly advanceWidth?: number;
    readonly path?: { readonly commands?: readonly FontkitPathCommandLike[] };
  };
  glyphForCodePoint(codePoint: number): {
    readonly id?: number;
    readonly advanceWidth?: number;
    readonly path?: { readonly commands?: readonly FontkitPathCommandLike[] };
  };
}

/** fontkit 路径命令的运行时形状。 */
interface FontkitPathCommandLike {
  readonly command?: string;
  readonly args?: readonly number[];
}

/** 已创建字体面的内部记录。 */
interface FaceRecord {
  face: FontFace;
  font: FontkitFaceLike;
}

/** 字体面 → 内部记录的映射；`disposeFontFace` 用。 */
const FACE_RECORDS = new WeakMap<FontFace, FaceRecord>();

/**
 * 全局字形缓存：按 (字体面实例, gid) 计数，上限 20,000。
 *
 * 与设计方案 12.7 一致，跨字体面共享预算，避免 TTC 多字体面各自缓存造成内存膨胀。
 * 键使用字体面实例序号而不是调用方给定的 `face.key`：`face.key` 只由资源元数据
 * （FontFile/FontName/字号）构成，不同文档中同名同路径的字体子集字节可能不同，
 * 若共用缓存键会把 A 文档的字形轮廓串给 B 文档。
 */
const FACE_GLYPH_CACHE = new LruCache<string, Glyph | null>(20_000);

/** 未显式提供缓存键时的序号，保证不同字体文件不会共用轮廓缓存键。 */
let faceSequence = 0;

/** 字体面实例序号；字形缓存按实例隔离，跨文档不复用轮廓。 */
let faceInstanceSequence = 0;

/**
 * 安全读取字体属性；剥离字体可能缺少 name/OS2 表并使 getter 抛错。
 *
 * @param read 属性读取函数。
 * @returns 读取结果；异常时为 undefined。
 */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * 读取字体名；缺失/抛错时返回 undefined。
 *
 * @param font fontkit 字体面。
 * @param property 属性名。
 * @returns 非空字体名。
 */
function readName(
  font: FontkitFaceLike,
  property: 'familyName' | 'postscriptName' | 'fullName',
): string | undefined {
  const value = safeRead(() => font[property]);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 判断字体是否已有粗体样式。
 *
 * @param font fontkit 字体面。
 * @param names 可用字体名。
 * @returns 判定结果。
 */
function detectBold(font: FontkitFaceLike, names: readonly string[]): boolean {
  const weight = safeRead(() => font['OS/2']?.usWeightClass);
  if (typeof weight === 'number' && weight >= 600) return true;
  if (safeRead(() => font.head?.macStyle?.bold) === true) return true;
  return names.some((name) => /bold|black|heavy|semibold/i.test(name));
}

/**
 * 判断字体是否已有斜体样式。
 *
 * @param font fontkit 字体面。
 * @param names 可用字体名。
 * @returns 判定结果。
 */
function detectItalic(font: FontkitFaceLike, names: readonly string[]): boolean {
  if (safeRead(() => font.head?.macStyle?.italic) === true) return true;
  const angle = safeRead(() => font.post?.italicAngle);
  if (typeof angle === 'number' && Math.abs(angle) > 1e-6) return true;
  return names.some((name) => /italic|oblique/i.test(name));
}

/**
 * 判断字体是否存在可用 cmap。
 *
 * 无 cmap 时 fontkit 的 cmap getter 可能返回 undefined/false 或直接抛错。
 *
 * @param font fontkit 字体面。
 * @returns 是否存在 cmap。
 */
function detectCmap(font: FontkitFaceLike): boolean {
  return safeRead(() => Boolean(font.cmap)) === true;
}

/**
 * 把 fontkit 路径命令转换为引擎 `PathCommand`。
 *
 * 未知命令/参数不足时跳过，避免损坏字体导致整个对象失败。
 *
 * @param commands fontkit 路径命令。
 * @returns 引擎路径命令（字体单位，y 向上）。
 */
function convertPathCommands(
  commands: readonly FontkitPathCommandLike[] | undefined,
): PathCommand[] {
  if (!commands || commands.length === 0) return [];
  const result: PathCommand[] = [];
  for (const item of commands) {
    const args = item.args;
    if (!args) continue;
    switch (item.command) {
      case 'moveTo':
        if (args.length >= 2 && isFinitePoint(args[0], args[1])) {
          result.push({ type: 'moveTo', x: args[0], y: args[1] });
        }
        break;
      case 'lineTo':
        if (args.length >= 2 && isFinitePoint(args[0], args[1])) {
          result.push({ type: 'lineTo', x: args[0], y: args[1] });
        }
        break;
      case 'quadraticCurveTo':
        if (args.length >= 4 && isFinitePoint(args[0], args[1]) && isFinitePoint(args[2], args[3])) {
          result.push({
            type: 'quadraticCurveTo',
            cpx: args[0],
            cpy: args[1],
            x: args[2],
            y: args[3],
          });
        }
        break;
      case 'bezierCurveTo':
        if (
          args.length >= 6 &&
          isFinitePoint(args[0], args[1]) &&
          isFinitePoint(args[2], args[3]) &&
          isFinitePoint(args[4], args[5])
        ) {
          result.push({
            type: 'bezierCurveTo',
            cp1x: args[0],
            cp1y: args[1],
            cp2x: args[2],
            cp2y: args[3],
            x: args[4],
            y: args[5],
          });
        }
        break;
      case 'closePath':
        result.push({ type: 'closePath' });
        break;
      default:
        break;
    }
  }
  return result;
}

/**
 * 判断两个坐标是否为有限数。
 *
 * @param x X 坐标。
 * @param y Y 坐标。
 * @returns 都是有限数时返回 true。
 */
function isFinitePoint(x: number | undefined, y: number | undefined): boolean {
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y);
}

/**
 * 把 fontkit 字形转换为引擎字形；轮廓异常时返回 null。
 *
 * @param font fontkit 字体面。
 * @param glyphId 期望的字形 ID。
 * @returns 引擎字形或 null。
 */
function convertGlyph(font: FontkitFaceLike, glyphId: number): Glyph | null {
  try {
    const source = font.getGlyph(glyphId);
    const id = Number.isInteger(source.id) ? (source.id as number) : glyphId;
    const advanceWidth =
      typeof source.advanceWidth === 'number' && Number.isFinite(source.advanceWidth)
        ? source.advanceWidth
        : 0;
    return { id, advanceWidth, path: convertPathCommands(source.path?.commands) };
  } catch {
    return null;
  }
}

/**
 * 创建单字体面并绑定内部缓存。
 *
 * @param font fontkit 字体面。
 * @param options 创建选项。
 * @param index 字体面在集合中的索引。
 * @param baseKey 缓存键前缀。
 * @returns 引擎字体面。
 */
function wrapFontFace(
  font: FontkitFaceLike,
  options: FontFaceCreateOptions,
  index: number,
  baseKey: string,
): FontFace {
  const family = readName(font, 'familyName');
  const postscriptName = readName(font, 'postscriptName');
  const fullName = readName(font, 'fullName');
  const names = [family, postscriptName, fullName].filter((name): name is string => Boolean(name));
  const hasCmap = detectCmap(font);
  const rawUnitsPerEm = safeRead(() => font.unitsPerEm);
  const unitsPerEm =
    typeof rawUnitsPerEm === 'number' && rawUnitsPerEm > 0 ? rawUnitsPerEm : 1000;
  const numGlyphs = Math.max(0, safeRead(() => font.numGlyphs) ?? 0);
  const key = `${options.key ?? baseKey}#${index}`;
  // 字形缓存按“字体面实例”隔离：face.key 仅用于回退链去重/诊断/内嵌判定，
  // 不能假设相同 face.key 的两个字体面字节一致（跨文档同名子集场景）。
  const cacheKeyPrefix = `${key}#${(faceInstanceSequence += 1)}`;
  const wantedNames = expandFontNames(
    [options.fontName, options.familyName],
    options.aliases,
  );
  const actualNames = expandFontNames([family, postscriptName, fullName], options.aliases);
  const explicitGlyphs =
    options.authoritative === true
      ? true
      : options.substitute === true
        ? false
        : wantedNames.length === 0 ||
          actualNames.some((name) => wantedNames.includes(name));

  const face: FontFace = {
    key,
    family: family ?? options.familyName ?? options.fontName ?? 'unknown',
    postscriptName,
    unitsPerEm,
    numGlyphs,
    hasCmap,
    bold: options.bold === true || detectBold(font, names),
    italic: options.italic === true || detectItalic(font, names),
    explicitGlyphs,
    weightClass: safeRead(() => font['OS/2']?.usWeightClass),
    italicAngle: safeRead(() => font.post?.italicAngle),
    glyphForCodePoint(codePoint: number): Glyph | null {
      if (!hasCmap) return null;
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return null;
      let glyphId: number | undefined;
      try {
        glyphId = font.glyphForCodePoint(codePoint).id;
      } catch {
        return null;
      }
      if (!Number.isInteger(glyphId) || glyphId === undefined) return null;
      // gid 0 通常是 .notdef；只有 U+0000 才允许把它当作真实字形。
      if (glyphId === 0 && codePoint !== 0) return null;
      return record.glyph(glyphId);
    },
    glyph(glyphId: number): Glyph | null {
      return record.glyph(glyphId);
    },
  };

  const record: FaceRecord & { glyph(gid: number): Glyph | null } = {
    face,
    font,
    glyph(gid: number): Glyph | null {
      if (!Number.isInteger(gid) || gid < 0 || gid >= numGlyphs) return null;
      const cacheKey = `${cacheKeyPrefix}#${gid}`;
      const cached = FACE_GLYPH_CACHE.get(cacheKey);
      if (cached !== undefined) return cached;
      const glyph = convertGlyph(font, gid);
      FACE_GLYPH_CACHE.set(cacheKey, glyph);
      return glyph;
    },
  };
  FACE_RECORDS.set(face, record);
  return face;
}

/**
 * 在字体集合中按 FontName/FamilyName/PostScript 名选择字体面。
 *
 * @param faces 候选字体面。
 * @param options 期望名称与索引。
 * @param isCollection 是否来自 TTC。
 * @returns 选中的字体面索引。
 */
function selectFaceIndex(
  faces: readonly FontkitFaceLike[],
  options: FontFaceCreateOptions,
  isCollection: boolean,
): number {
  if (typeof options.index === 'number') {
    if (Number.isInteger(options.index) && options.index >= 0 && options.index < faces.length) {
      return options.index;
    }
    options.onWarning?.('W_BAD_NUMBER', `字体面索引 ${options.index} 越界，已取第 0 个字体面`, {
      resourceId: options.resourceId,
    });
    return 0;
  }
  if (!isCollection) return 0;

  const wanted = new Set(
    expandFontNames([options.fontName, options.familyName], options.aliases),
  );
  if (wanted.size > 0) {
    for (let index = 0; index < faces.length; index += 1) {
      const font = faces[index];
      const candidates = expandFontNames(
        [readName(font, 'familyName'), readName(font, 'postscriptName'), readName(font, 'fullName')],
        options.aliases,
      );
      if (candidates.some((name) => wanted.has(name))) return index;
    }
  }
  options.onWarning?.(
    'W_FONT_MISSING',
    `字体集合未匹配到 FontName=${options.fontName ?? ''}/FamilyName=${options.familyName ?? ''}，已使用第 0 个字体面`,
    { resourceId: options.resourceId },
  );
  return 0;
}

/**
 * 把输入统一为 Uint8Array。
 *
 * @param data 字体字节。
 * @returns 非空的 Uint8Array。
 */
function toBytes(data: Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  throw new OFDError('OFD_FONT_PARSE', '字体数据不是 Uint8Array');
}

/**
 * 解析字体字节并返回字体集合的全部字体面。
 *
 * @param data 字体文件字节。
 * @param options 缓存键、TTC 选面与 warning 选项。
 * @returns fontkit 字体面数组。
 */
function parseFaces(
  data: Uint8Array,
  options: FontFaceCreateOptions,
): { faces: FontkitFaceLike[]; isCollection: boolean } {
  const bytes = toBytes(data);
  let parsed: FontkitFaceLike;
  try {
    parsed = createFontkit(bytes) as unknown as FontkitFaceLike;
  } catch (error) {
    throw toOFDError(
      error,
      'OFD_FONT_PARSE',
      `字体解析失败${options.fontName ? `（${options.fontName}）` : ''}`,
    );
  }
  const collection = Array.isArray(parsed.fonts) ? parsed.fonts : undefined;
  const isCollection = Boolean(collection && collection.length > 0);
  const faces = isCollection && collection ? [...collection] : [parsed];
  if (faces.length === 0) {
    throw new OFDError('OFD_FONT_PARSE', '字体集合为空');
  }
  return { faces, isCollection };
}

/**
 * 从字节创建单个字体面。
 *
 * TTC 按 `options.index` 或字体名选择字体面；名称匹配失败时取第 0 个并 warning。
 *
 * @param data 字体文件字节。
 * @param options 缓存键与 TTC 选面选项。
 * @returns 字体面。
 * @throws OFDError `OFD_FONT_PARSE` 字体无法解析。
 */
export function createFontFace(data: Uint8Array, options: FontFaceCreateOptions = {}): FontFace {
  const { faces, isCollection } = parseFaces(data, options);
  const index = selectFaceIndex(faces, options, isCollection);
  const baseKey = options.key ?? `font-${(faceSequence += 1)}`;
  return wrapFontFace(faces[index], options, index, baseKey);
}

/**
 * 从字体集合（TTC）创建多个字体面。
 *
 * 非集合字体返回单元素数组；不会因名称不匹配而丢弃字体面。
 *
 * @param data 字体集合字节。
 * @param options 可选的缓存键与 warning 选项。
 * @returns 按文件内顺序排列的字体面。
 * @throws OFDError `OFD_FONT_PARSE` 字体无法解析。
 */
export function createFontFaces(data: Uint8Array, options: FontFaceCreateOptions = {}): FontFace[] {
  const { faces } = parseFaces(data, options);
  const baseKey = options.key ?? `font-${(faceSequence += 1)}`;
  return faces.map((font, index) => wrapFontFace(font, options, index, baseKey));
}

/**
 * 释放字体面持有的底层资源。
 *
 * fontkit 对象由 GC 回收；这里只丢弃内部字形缓存引用。
 *
 * @param face 字体面。
 */
export function disposeFontFace(face: FontFace): void {
  FACE_RECORDS.delete(face);
}