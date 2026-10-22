/**
 * 字体来源匹配、字体库与逐字形回退（对应设计方案 12.2）。
 *
 * 字体来源优先级：内嵌 FontFile → 宿主 FontProvider → supplementaryFonts。
 * 回退是逐字形的：主字体缺字时才尝试回退链，而不是整段文字切换字体。
 */

import type { FontInput, FontMatchRequest, FontProvider } from '../platform/font-provider';
import type { FontResource, ResourceId } from '../model/types';
import type { FontAliasTable } from './aliases';
import { expandFontNames } from './aliases';
import { createFontFace } from './face';
import type {
  FontFace,
  FontFaceSet,
  FontWarningCallback,
  FontFaceCreateOptions,
  Glyph,
} from './types';
import type { WarningCode } from '../warnings';

/** 从宿主字体来源读取字节；url/path/filePath 由宿主平台实现。 */
export type FontInputLoader = (
  input: FontInput,
) => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>;

/** 字体库选项。 */
export interface FontLibraryOptions {
  /** 宿主字体提供者。 */
  fontProvider?: FontProvider;
  /** 补充字体列表，按顺序参与缺字回退；也用于完全无字体时的主字体。 */
  supplementaryFonts?: readonly FontInput[];
  /** url/path/filePath 来源的字节读取器；`data` 来源不需要。 */
  loadInput?: FontInputLoader;
  /** 字体层 warning 回调。 */
  onWarning?: FontWarningCallback;
  /** 宿主扩展别名表。 */
  aliases?: FontAliasTable;
  /** 单个字体字节上限，byte；默认 64 MiB。 */
  maxFontBytes?: number;
}

/** 一次字形解析的结果。 */
export interface ResolvedGlyph {
  /** 实际提供字形的字体面。 */
  face: FontFace;
  /** 字形。 */
  glyph: Glyph;
  /** 是否来自回退字体。 */
  fallback: boolean;
  /** 是否实际使用了调用方提供的显式 gid。 */
  explicit?: boolean;
}

/** 字体解析缓存键。 */
function fontCacheKey(font: FontResource): string {
  const names = expandFontNames([font.fontName, font.familyName]).join('|');
  return `${font.fontFile ?? font.id}\u0000${names}\u0000${font.bold ? 'b' : ''}${font.italic ? 'i' : ''}`;
}

/**
 * 把 FontResource 转成宿主 FontProvider 的请求。
 *
 * @param font 字体资源。
 * @returns 字体匹配请求。
 */
export function fontResourceRequest(font: FontResource): FontMatchRequest {
  return {
    fontName: font.fontName,
    familyName: font.familyName,
    charset: font.charset,
    bold: font.bold,
    italic: font.italic,
    serif: font.serif,
    fixedSize: font.fixedSize,
  };
}

/**
 * 计算字体面与字体资源的匹配分。
 *
 * @param face 字体面。
 * @param font 字体资源。
 * @param aliases 别名表。
 * @returns 分值；越高越匹配。
 */
function scoreFace(face: FontFace, font: FontResource, aliases?: FontAliasTable): number {
  const wanted = new Set(expandFontNames([font.fontName, font.familyName], aliases));
  const names = expandFontNames([face.family, face.postscriptName], aliases);
  let score = names.some((name) => wanted.has(name)) ? 100 : 0;
  if (face.bold === font.bold) score += 10;
  if (face.italic === font.italic) score += 5;
  return score;
}

/**
 * 判断一个 FontInput 是否为内存字节来源。
 *
 * @param input 字体来源。
 * @returns 是 data 来源时返回 true。
 */
function hasInlineData(input: FontInput): input is { data: ArrayBuffer | Uint8Array; family?: string } {
  return 'data' in input;
}

/**
 * 字体库：负责内嵌/宿主/补充字体解析、缓存与逐字形回退。
 *
 * 一个文档实例使用一个 FontLibrary；`clear()`/`dispose()` 释放字形与字体缓存。
 */
export class FontLibrary {
  private readonly embedded = new Map<string, FontFace>();
  private readonly resolved = new Map<string, Promise<FontFaceSet | null>>();
  private readonly supplementary: FontInput[];
  private readonly maxFontBytes: number;
  private readonly warned = new Set<string>();
  private supplementaryFaces?: Promise<FontFace[]>;
  private disposed = false;

  /**
   * @param options 宿主 provider、补充字体、字节读取器与 warning 回调。
   */
  constructor(private readonly options: FontLibraryOptions = {}) {
    this.supplementary = [...(options.supplementaryFonts ?? [])];
    this.maxFontBytes = options.maxFontBytes ?? 64 * 1024 * 1024;
  }

  /**
   * 登记内嵌字体字节；同一 fontFile + 字体名的资源复用同一 FontFace。
   *
   * @param font 字体资源定义。
   * @param data 字体文件字节。
   * @returns 字体面；解析失败时返回 null 并 warning。
   */
  registerEmbedded(font: FontResource, data: Uint8Array): FontFace | null {
    const key = fontCacheKey(font);
    const cached = this.embedded.get(key);
    if (cached) return cached;
    if (data.byteLength > this.maxFontBytes) {
      this.warn(
        'W_FONT_MISSING',
        `字体 ${font.fontFile ?? font.id} 超过 ${this.maxFontBytes} byte 上限，已忽略`,
        { resourceId: font.id },
      );
      return null;
    }
    const face = this.createFace(data, font, `embedded:${key}`, true, false);
    if (face) {
      this.embedded.set(key, face);
      // 先 resolve 后 register 的场景：清掉旧的 null/回退结果，避免吞掉新字体。
      this.resolved.delete(key);
    }
    return face;
  }

  /**
   * 解析字体资源，返回主字体与回退链。
   *
   * @param font 字体资源定义。
   * @returns 字体链；无任何可用字体时返回 null 并 warning。
   */
  resolve(font: FontResource): Promise<FontFaceSet | null> {
    if (this.disposed) return Promise.resolve(null);
    const key = fontCacheKey(font);
    const cached = this.resolved.get(key);
    if (cached) return cached;
    const promise = this.resolveUncached(font, key);
    this.resolved.set(key, promise);
    return promise;
  }

  /** 清空字体/字形解析缓存；已登记的字体字节缓存同时释放。 */
  clear(): void {
    this.embedded.clear();
    this.resolved.clear();
    this.supplementaryFaces = undefined;
    this.warned.clear();
  }

  /** 释放字体库；之后 `resolve` 返回 null。 */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /**
   * 创建字体面并附带统一 warning 回调。
   *
   * @param data 字体字节。
   * @param font 字体资源。
   * @param key 缓存键前缀。
   * @returns 字体面或 null。
   */
  private createFace(
    data: Uint8Array,
    font: FontResource,
    key: string,
    authoritative = false,
    substitute = false,
  ): FontFace | null {
    const createOptions: FontFaceCreateOptions = {
      key,
      fontName: font.fontName,
      familyName: font.familyName,
      aliases: this.options.aliases,
      resourceId: font.id,
      bold: font.bold,
      italic: font.italic,
      authoritative,
      substitute,
      onWarning: this.options.onWarning,
    };
    try {
      return createFontFace(data, createOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn('W_FONT_MISSING', `字体解析失败：${message}`, { resourceId: font.id });
      return null;
    }
  }

  /**
   * 实际执行字体解析（内嵌 → provider → supplementary）。
   *
   * @param font 字体资源。
   * @param key 缓存键。
   * @returns 字体链或 null。
   */
  private async resolveUncached(font: FontResource, key: string): Promise<FontFaceSet | null> {
    const embeddedFace = this.embedded.get(key);
    const providerFaces: FontFace[] = [];
    if (!embeddedFace) {
      providerFaces.push(...(await this.loadProviderFaces(font)));
    }
    const supplementaryFaces = await this.loadSupplementaryFaces();
    // 补充字体可能同时包含无衬线/衬线/等宽多个族；按请求字体名与别名评分选择，
    // 不能固定取第一个，否则 Times/SimSun 等衬线请求会误用 Noto Sans。
    const bestSupplementary = supplementaryFaces.reduce<FontFace | undefined>(
      (best, face) =>
        !best || scoreFace(face, font, this.options.aliases) > scoreFace(best, font, this.options.aliases)
          ? face
          : best,
      undefined,
    );

    const primary =
      embeddedFace ?? this.pickProviderFace(providerFaces, font) ?? bestSupplementary;

    if (!primary) {
      this.warn(
        'W_FONT_MISSING',
        `字体缺失：FontName=${font.fontName}${font.fontFile ? ` FontFile=${font.fontFile}` : ''}`,
        { resourceId: font.id },
      );
      return null;
    }

    const fallbacks: FontFace[] = [];
    const seen = new Set<string>([primary.key]);
    const ordered = embeddedFace
      ? [...supplementaryFaces]
      : [...providerFaces.filter((face) => face !== primary), ...supplementaryFaces];
    for (const face of ordered) {
      if (seen.has(face.key)) continue;
      seen.add(face.key);
      fallbacks.push(face);
    }
    return { primary, fallbacks };
  }

  /**
   * 调用宿主 FontProvider 并加载返回的字体来源。
   *
   * @param font 字体资源。
   * @returns 解析成功的字体面（按 provider 返回顺序）。
   */
  private async loadProviderFaces(font: FontResource): Promise<FontFace[]> {
    const provider: FontProvider | undefined = this.options.fontProvider;
    if (!provider) return [];
    let inputs: FontInput | FontInput[] | null;
    try {
      inputs = await provider.match(fontResourceRequest(font));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn('W_FONT_MISSING', `FontProvider 匹配失败：${message}`, { resourceId: font.id });
      return [];
    }
    if (!inputs) return [];
    const list = Array.isArray(inputs) ? inputs : [inputs];
    const faces: FontFace[] = [];
    for (const [index, input] of list.entries()) {
      const data = await this.readInput(input, font.id);
      if (!data) continue;
      const face = this.createFace(data, font, `provider:${font.id}:${index}`);
      if (face) faces.push(face);
    }
    faces.sort((a, b) => scoreFace(b, font, this.options.aliases) - scoreFace(a, font, this.options.aliases));
    return faces;
  }

  /**
   * 加载 supplementaryFonts；结果按顺序缓存。
   *
   * @returns 解析成功的补充字体面。
   */
  private loadSupplementaryFaces(): Promise<FontFace[]> {
    if (!this.supplementaryFaces) {
      this.supplementaryFaces = (async () => {
        const faces: FontFace[] = [];
        for (const [index, input] of this.supplementary.entries()) {
          const data = await this.readInput(input, `supplementary:${index}`);
          if (!data) continue;
          const family = input.family ?? `supplementary-${index}`;
          const face = this.createFace(
            data,
            {
              id: `supplementary-${index}`,
              fontName: family,
              familyName: family,
              charset: 'unicode',
              serif: false,
              bold: false,
              italic: false,
              fixedSize: false,
            },
            `supplementary:${index}`,
            false,
            true,
          );
          if (face) faces.push(face);
        }
        return faces;
      })();
    }
    return this.supplementaryFaces;
  }

  /**
   * 从 FontInput 读取字体字节。
   *
   * @param input 字体来源。
   * @param resourceId 诊断用资源 ID。
   * @returns 字体字节；无法读取时返回 null 并 warning。
   */
  private async readInput(input: FontInput, resourceId: ResourceId): Promise<Uint8Array | null> {
    if (hasInlineData(input)) {
      const data = input.data;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.byteLength > this.maxFontBytes) {
        this.warn(
          'W_FONT_MISSING',
          `字体字节超过 ${this.maxFontBytes} byte 上限，已忽略`,
          { resourceId },
        );
        return null;
      }
      return bytes;
    }
    const loader = this.options.loadInput;
    if (!loader) {
      this.warn(
        'W_FONT_MISSING',
        'FontProvider 返回了 url/path 来源，但未注入 loadInput，已忽略',
        { resourceId },
      );
      return null;
    }
    try {
      const loaded = await loader(input);
      if (!loaded) return null;
      const bytes = loaded instanceof Uint8Array ? loaded : new Uint8Array(loaded);
      if (bytes.byteLength > this.maxFontBytes) {
        this.warn(
          'W_FONT_MISSING',
          `字体字节超过 ${this.maxFontBytes} byte 上限，已忽略`,
          { resourceId },
        );
        return null;
      }
      return bytes;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn('W_FONT_MISSING', `字体字节读取失败：${message}`, { resourceId });
      return null;
    }
  }

  /**
   * 在 provider 返回的字体面中选择与资源最匹配者。
   *
   * @param faces provider 字体面。
   * @param font 字体资源。
   * @returns 最匹配的字体面；没有候选时为 undefined。
   */
  private pickProviderFace(faces: readonly FontFace[], font: FontResource): FontFace | undefined {
    if (faces.length === 0) return undefined;
    let best = faces[0];
    let bestScore = scoreFace(best, font, this.options.aliases);
    for (const face of faces.slice(1)) {
      const score = scoreFace(face, font, this.options.aliases);
      if (score > bestScore) {
        best = face;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * 发送字体层 warning；同一 (code, resourceId, message) 只发一次。
   *
   * @param code warning 码。
   * @param message 诊断信息。
   * @param context 资源上下文。
   */
  private warn(code: WarningCode, message: string, context?: { resourceId?: string }): void {
    const key = `${code}\u0000${context?.resourceId ?? ''}\u0000${message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.onWarning?.(code, message, context);
  }
}

/**
 * 在字体链中逐字形回退解析。
 *
 * 显式 gid 只对主字体有意义；主字体找不到时再按码点回退。
 *
 * @param codePoint Unicode 码点。
 * @param explicitGlyphId CGTransform 给出的显式 gid；无则为 null/undefined。
 * @param faces 主字体与回退链。
 * @returns 命中的字体面与字形；全部缺失时返回 null。
 */
export function resolveGlyph(
  codePoint: number,
  explicitGlyphId: number | null | undefined,
  faces: FontFaceSet,
): ResolvedGlyph | null {
  if (
    explicitGlyphId !== null &&
    explicitGlyphId !== undefined &&
    faces.primary.explicitGlyphs !== false
  ) {
    const glyph = faces.primary.glyph(explicitGlyphId);
    if (glyph && (glyph.id !== 0 || codePoint === 0)) {
      return { face: faces.primary, glyph, fallback: false, explicit: true };
    }
  }
  if (faces.primary.hasCmap) {
    const glyph = faces.primary.glyphForCodePoint(codePoint);
    if (glyph) return { face: faces.primary, glyph, fallback: false };
  }
  for (const face of faces.fallbacks) {
    if (!face.hasCmap) continue;
    const glyph = face.glyphForCodePoint(codePoint);
    if (glyph) return { face, glyph, fallback: true };
  }
  return null;
}