/**
 * 文字布局与绘制（对应设计方案 11.2/12.3/12.4/12.5/12.6）。
 *
 * 文字统一走“字形轮廓 → 路径 → fill/stroke”，渲染器不提供也不使用 Canvas 文字 API。
 * 布局按 CGTransform 的 run-based 语义：字形串整体绘制，字符格只决定整串结束后的 pen 步进。
 */

import type { Matrix, PathCommand } from '../common/types';
import { multiplyMatrix } from '../common/matrix';
import type { TextCode, TextObject } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { FontFace, FontFaceSet, Glyph } from '../font/types';
import { GlyphOutlineCache, transformPathCommands } from '../font/glyph';
import { resolveGlyph } from '../font/provider';
import type { PaintBinder } from './paint';

/** 单个批次最多绘制的字形数；超过后重新 beginPath/fill，降低峰值路径内存。 */
export const MAX_GLYPHS_PER_BATCH = 5000;

/** 合成斜体剪切系数：tan(12°) ≈ 0.2126。 */
export const SYNTHETIC_ITALIC_SKEW = Math.tan((12 * Math.PI) / 180);

/** 合成粗体线宽系数：`Size × 0.02`。 */
export const SYNTHETIC_BOLD_WIDTH_FACTOR = 0.02;

/** 一个字形 run：同一字体/同一轮廓来源的连续字形。 */
export interface GlyphRun {
  face: FontFace;
  gid: number;
  /** 字体单位下的 advance。 */
  advanceWidth: number;
  /** 字体单位下的轮廓，y 向上。 */
  path: PathCommand[];
}

/** 单个字形的放置结果（对象空间，单位通常 mm）。 */
export interface GlyphPlacement {
  /** 提供字形的字体面键。 */
  faceKey: string;
  /** 字形 ID。 */
  gid: number;
  /** 绘制点 X，对象空间单位。 */
  x: number;
  /** 绘制点 Y，对象空间单位。 */
  y: number;
  /** 本次推进量（对象空间单位，未乘阅读方向）。 */
  advance: number;
}

/** 一个 TextCode 内的布局单元（对应 CGTransform 的 run-based 语义）。 */
export interface TextLayoutUnit {
  /** 该单元所属的 TextCode 下标。 */
  codeIndex: number;
  /** 起始字符位置（码点索引）。 */
  cpStart: number;
  /** 覆盖字符数。 */
  codeCount: number;
  /** 单元开始时的 pen X，对象空间单位。 */
  x: number;
  /** 单元开始时的 pen Y，对象空间单位。 */
  y: number;
  /** 该单元的字形序列，按绘制顺序。 */
  glyphs: GlyphRun[];
  /** 字形逐个放置结果；多字形 run 内部按字体 advance 排布。 */
  placements: GlyphPlacement[];
  /** 单元结束后 pen 的 X 步进（已按字符 delta/字体 advance 求和），对象空间单位。 */
  deltaX: number;
  /** 单元结束后 pen 的 Y 步进，对象空间单位。 */
  deltaY: number;
}

/** 一个 TextObject 的布局结果。 */
export interface TextLayout {
  units: TextLayoutUnit[];
  /** 累计 pen 位置，对象空间单位。 */
  endX: number;
  endY: number;
}

/** 文字布局选项。 */
export interface TextLayoutOptions {
  /** warning 回调；缺字与非法 delta 使用稳定 code。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
  /** 对象 ID，仅用于 warning 上下文。 */
  objectId?: string;
  /** 字形轮廓缓存；缺省使用模块级 20,000 条缓存。 */
  outlineCache?: GlyphOutlineCache;
}

/** 文字绘制上下文。 */
export interface TextDrawContext {
  renderer: Renderer;
  binder: PaintBinder;
  /** 主字体与回退链。 */
  faces: FontFaceSet;
  /** warning 回调；缺字使用 `W_GLYPH_MISSING`。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/** 文字绘制选项。 */
export interface TextDrawOptions {
  /** 是否启用合成粗体，默认 true。 */
  syntheticBold?: boolean;
  /** 是否启用合成斜体，默认 true。 */
  syntheticItalic?: boolean;
  /** 字形轮廓缓存；缺省使用模块级缓存。 */
  outlineCache?: GlyphOutlineCache;
}

/** delta 字符串/数组的解析结果。 */
export interface DeltaParseResult {
  /** 解析出的数值序列，对象空间单位。 */
  values: number[];
  /** 无法解析的 token；调用方据此上报 `W_BAD_NUMBER`。 */
  invalidTokens: string[];
}

/** 默认字形轮廓缓存（20,000 条，跨对象复用）。 */
const DEFAULT_OUTLINE_CACHE = new GlyphOutlineCache(20_000);

/** DeltaX/DeltaY 展开后的数值上限，防止恶意 `g` 组耗尽内存。 */
export const MAX_DELTA_VALUES = 100_000;

/** 各阅读方向对应的 pen 步进方向。 */
const READ_DIRECTIONS: Readonly<Record<number, readonly [number, number]>> = Object.freeze({
  0: [1, 0],
  90: [0, 1],
  180: [-1, 0],
  270: [0, -1],
});

/**
 * 解析 DeltaX/DeltaY。
 *
 * 规则（与 XML ST_Array 语义一致）：
 * - 数组或字符串按空白/逗号分词；
 * - `g <count> <value>` 展开为 count 个 value，例如 `0 g 3 5 2` → 0,5,5,5,2；
 * - 无法解析的 token 跳过并记录，由调用方 warning；
 * - 显式 0 保留（表示字符重叠），不当作缺失。
 *
 * @param raw 原始值；可为已展开数组、ST_Array 字符串、token 数组、undefined。
 * @returns 解析结果；单位与输入一致（通常 mm）。
 */
export function parseDeltaTokens(raw: unknown): DeltaParseResult {
  if (raw === null || raw === undefined) return { values: [], invalidTokens: [] };
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { values: [raw], invalidTokens: [] }
      : { values: [], invalidTokens: [String(raw)] };
  }

  let tokens: string[];
  if (Array.isArray(raw)) {
    // 模型层通常已展开；这里兼容宿主传入的原始 ST_Array token 数组。
    tokens = raw.map((item) => String(item)).filter((token) => token.length > 0);
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    tokens = text.length > 0 ? text.split(/[\s,]+/).filter((token) => token.length > 0) : [];
  } else {
    return { values: [], invalidTokens: [String(raw)] };
  }

  const values: number[] = [];
  const invalidTokens: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === 'g' || token === 'G') {
      const countToken = tokens[index + 1];
      const valueToken = tokens[index + 2];
      const count = countToken === undefined ? Number.NaN : Number(countToken);
      const value = valueToken === undefined ? Number.NaN : Number(valueToken);
      if (
        Number.isInteger(count) &&
        count > 0 &&
        Number.isFinite(value)
      ) {
        const remaining = MAX_DELTA_VALUES - values.length;
        const expand = Math.min(count, Math.max(0, remaining));
        for (let repeat = 0; repeat < expand; repeat += 1) values.push(value);
        if (expand < count) {
          invalidTokens.push(`g ${countToken} ${valueToken} 超过上限 ${MAX_DELTA_VALUES}`);
          break;
        }
        index += 2;
      } else {
        invalidTokens.push(`${token} ${countToken ?? ''} ${valueToken ?? ''}`.trim());
        index += 2;
      }
      continue;
    }
    const value = Number(token);
    if (token.length > 0 && Number.isFinite(value)) {
      if (values.length >= MAX_DELTA_VALUES) {
        invalidTokens.push(`数组长度超过上限 ${MAX_DELTA_VALUES}`);
        break;
      }
      values.push(value);
    } else {
      invalidTokens.push(token);
    }
  }
  return { values, invalidTokens };
}

/** 一个待布局单元（尚未计算 delta）。 */
export interface PendingUnit {
  cpStart: number;
  codeCount: number;
  glyphs: GlyphRun[];
  /** 覆盖的 Delta 数量；缺省等于 codeCount，CG 兜底 run 为 1。 */
  deltaCount?: number;
}

/** 每个对象一次的 warning 状态。 */
export interface WarningState {
  warnedGlyph: boolean;
  warnedBadNumber: boolean;
}

/**
 * 发送一次对象级 warning。
 *
 * @param options 布局选项。
 * @param state 去重状态。
 * @param key 去重类别。
 * @param code warning 码。
 * @param message 诊断信息。
 */
function warnOnce(
  options: TextLayoutOptions,
  state: WarningState,
  key: keyof WarningState,
  code: string,
  message: string,
): void {
  if (state[key]) return;
  state[key] = true;
  options.onWarning?.(code, message, options.objectId);
}

/**
 * 取字形轮廓（优先走 LRU 缓存）。
 *
 * @param face 字体面。
 * @param glyph 字形。
 * @param cache 轮廓缓存。
 * @returns 字体单位轮廓；缺失时为空数组。
 */
function glyphPath(face: FontFace, glyph: Glyph, cache: GlyphOutlineCache): PathCommand[] {
  const cached = cache.get(face, glyph.id);
  return cached ?? glyph.path;
}

/** 构建结果；explicit 表示是否真正使用了 CGTransform 的显式 gid。 */
interface BuiltRun {
  /** 字形 run。 */
  run: GlyphRun;
  /** 显式 gid 是否被字体面接受。 */
  explicit: boolean;
}

/**
 * 把一个码点解析成字形 run；缺失时返回 null。
 *
 * @param codePoint Unicode 码点。
 * @param explicitGlyphId 显式 gid；无则为 undefined。
 * @param faces 字体链。
 * @param cache 轮廓缓存。
 * @param state warning 状态。
 * @param options 布局选项。
 * @returns 字形 run 与显式 gid 使用情况；缺失时返回 null。
 */
function buildGlyphRun(
  codePoint: number,
  explicitGlyphId: number | undefined,
  faces: FontFaceSet,
  cache: GlyphOutlineCache,
  state: WarningState,
  options: TextLayoutOptions,
): BuiltRun | null {
  const resolved = resolveGlyph(codePoint, explicitGlyphId, faces);
  if (!resolved) {
    warnOnce(
      options,
      state,
      'warnedGlyph',
      'W_GLYPH_MISSING',
      `字符 U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} 无可用字形`,
    );
    return null;
  }
  return {
    run: {
      face: resolved.face,
      gid: resolved.glyph.id,
      advanceWidth: resolved.glyph.advanceWidth,
      path: glyphPath(resolved.face, resolved.glyph, cache),
    },
    explicit: resolved.explicit === true,
  };
}

/**
 * 按 CGTransform 构建 run-based 单元。
 *
 * 规则（设计方案 12.3）：
 * - 以 `codePosition` 为起点，取 `codeCount` 个字符作为一个字形串；
 * - 字形列表整体绘制，不按字符拆分；
 * - CodePosition 越界、CodeCount<1、空 Glyphs、互相重叠的变换跳过并 warning。
 *
 * @param codePoints 当前 TextCode 的码点序列。
 * @param cgTransforms CGTransform 列表。
 * @param faces 字体链。
 * @param cache 轮廓缓存。
 * @param state warning 状态。
 * @param options 布局选项。
 * @returns 待布局单元。
 */
export function buildUnits(
  codePoints: readonly number[],
  cgTransforms: TextCode['cgTransforms'],
  faces: FontFaceSet,
  cache: GlyphOutlineCache = DEFAULT_OUTLINE_CACHE,
  state: WarningState = { warnedGlyph: false, warnedBadNumber: false },
  options: TextLayoutOptions = {},
): PendingUnit[] {
  // 高频小对象（无 CGTransform，通常 1 个字符）走无 Map/排序的快路径。
  if (!cgTransforms || cgTransforms.length === 0) {
    const simple: PendingUnit[] = [];
    for (let index = 0; index < codePoints.length; index += 1) {
      const built = buildGlyphRun(codePoints[index], undefined, faces, cache, state, options);
      simple.push({ cpStart: index, codeCount: 1, glyphs: built ? [built.run] : [] });
    }
    return simple;
  }
  const byPosition = new Map<number, TextCode['cgTransforms'][number]>();
  const sorted = [...(cgTransforms ?? [])].sort((a, b) => a.codePosition - b.codePosition);
  for (const transform of sorted) {
    const valid =
      Number.isInteger(transform.codePosition) &&
      transform.codePosition >= 0 &&
      transform.codePosition < codePoints.length &&
      Number.isInteger(transform.codeCount) &&
      transform.codeCount >= 1 &&
      Array.isArray(transform.glyphs) &&
      transform.glyphs.length > 0 &&
      transform.glyphs.every((gid) => Number.isInteger(gid) && gid >= 0);
    if (!valid) {
      warnOnce(
        options,
        state,
        'warnedBadNumber',
        'W_BAD_NUMBER',
        `CGTransform 参数非法（CodePosition=${transform.codePosition} CodeCount=${transform.codeCount}），已跳过`,
      );
      continue;
    }
    if (byPosition.has(transform.codePosition)) {
      warnOnce(
        options,
        state,
        'warnedBadNumber',
        'W_BAD_NUMBER',
        `CGTransform CodePosition=${transform.codePosition} 重复，保留先出现者`,
      );
      continue;
    }
    if (transform.glyphCount !== transform.glyphs.length) {
      warnOnce(
        options,
        state,
        'warnedBadNumber',
        'W_BAD_NUMBER',
        `CGTransform GlyphCount=${transform.glyphCount} 与实际 Glyphs=${transform.glyphs.length} 不一致，以实际数组为准`,
      );
    }
    byPosition.set(transform.codePosition, transform);
  }

  // 丢弃被前一个 run 覆盖的变换，避免静默吞掉数据。
  let coveredUntil = -1;
  for (const position of [...byPosition.keys()].sort((a, b) => a - b)) {
    const transform = byPosition.get(position);
    if (!transform) continue;
    if (position < coveredUntil) {
      byPosition.delete(position);
      warnOnce(
        options,
        state,
        'warnedBadNumber',
        'W_BAD_NUMBER',
        `CGTransform CodePosition=${position} 与前一个 run 重叠，已忽略`,
      );
      continue;
    }
    coveredUntil = position + Math.max(1, transform.codeCount);
  }

  const units: PendingUnit[] = [];
  let index = 0;
  while (index < codePoints.length) {
    const transform = byPosition.get(index);
    if (!transform) {
      const built = buildGlyphRun(codePoints[index], undefined, faces, cache, state, options);
      units.push({ cpStart: index, codeCount: 1, glyphs: built ? [built.run] : [] });
      index += 1;
      continue;
    }
    const remaining = codePoints.length - index;
    const span = Math.min(transform.codeCount, remaining);
    if (span !== transform.codeCount) {
      warnOnce(
        options,
        state,
        'warnedBadNumber',
        'W_BAD_NUMBER',
        `CGTransform CodeCount=${transform.codeCount} 超出剩余字符数，已截断为 ${span}`,
      );
    }
    // CodeCount 与 Glyphs 数量相同表示逐字符 1:1 映射；必须拆成 span 个
    // 单字符 unit，才能让每个字符消费自己的 DeltaX/DeltaY。若整串当一个
    // run，run 内只能按字体 advance 排列，字符级 Delta 只在串末结算，长行会
    // 累积偏离并溢出 Boundary。
    if (span === transform.glyphs.length) {
      for (let offset = 0; offset < span; offset += 1) {
        const built = buildGlyphRun(
          codePoints[index + offset],
          transform.glyphs[offset],
          faces,
          cache,
          state,
          options,
        );
        units.push({
          cpStart: index + offset,
          codeCount: 1,
          glyphs: built ? [built.run] : [],
        });
      }
      index += span;
      continue;
    }
    const builtRuns: BuiltRun[] = [];
    let allExplicit = true;
    for (const gid of transform.glyphs) {
      const built = buildGlyphRun(codePoints[index], gid, faces, cache, state, options);
      if (!built) {
        allExplicit = false;
        continue;
      }
      if (!built.explicit) allExplicit = false;
      builtRuns.push(built);
    }
    if (!allExplicit) {
      // 显式 GID/连字字形不可用时，CGTransform 的 N:1/1:N/N:M 映射不能成立；
      // 用被覆盖字符各自的 cmap 轮廓组成一个 run，保留每个字符的可见性，
      // 同时只消费该 CG 单元自己的 Delta，避免把后续字符格整体错位。
      const glyphs: GlyphRun[] = [];
      for (let offset = 0; offset < span; offset += 1) {
        const built = buildGlyphRun(codePoints[index + offset], undefined, faces, cache, state, options);
        if (built) glyphs.push(built.run);
      }
      units.push({ cpStart: index, codeCount: span, deltaCount: 1, glyphs });
    } else {
      units.push({ cpStart: index, codeCount: span, glyphs: builtRuns.map((built) => built.run) });
    }
    index += span;
  }
  return units;
}

/**
 * 取字符在字体链中的 advance（对象空间单位）。
 *
 * 仅在缺少 delta 时使用；不做 warning，避免重复刷屏。
 *
 * @param codePoint Unicode 码点。
 * @param faces 字体链。
 * @param size 字号，对象空间单位。
 * @param hScale 水平缩放。
 * @returns advance，对象空间单位；无字形时为 0。
 */
function fallbackAdvance(
  codePoint: number,
  faces: FontFaceSet,
  size: number,
  hScale: number,
): number {
  const resolved = resolveGlyph(codePoint, undefined, faces);
  if (!resolved) return 0;
  return scaleAdvance(resolved.glyph.advanceWidth, size, hScale, resolved.face.unitsPerEm);
}

/**
 * 把字体单位 advance 转为对象空间长度。
 *
 * @param advanceWidth 字体单位 advance。
 * @param size 字号，对象空间单位。
 * @param hScale 水平缩放。
 * @param unitsPerEm 每 em 字体单位。
 * @returns 对象空间长度（通常 mm）。
 */
function scaleAdvance(
  advanceWidth: number,
  size: number,
  hScale: number,
  unitsPerEm: number,
): number {
  if (!Number.isFinite(advanceWidth)) return 0;
  return (advanceWidth * size * hScale) / unitsPerEm;
}

/**
 * 计算一个单元结束后沿指定轴的步进。
 *
 * 逐字符取值：有合法 delta 用 delta（显式 0 保留）；缺失时仅当该轴是阅读方向轴才回退字体 advance。
 *
 * @param values 已解析的 delta 数组。
 * @param cpStart 单元起始码点索引。
 * @param codeCount 覆盖字符数。
 * @param codePoints 全部码点。
 * @param faces 字体链。
 * @param size 字号，对象空间单位。
 * @param hScale 水平缩放。
 * @param fallbackToAdvance 缺失值是否回退该字符的字体 advance。
 * @returns 步进，对象空间单位。
 */
function computeDelta(
  values: readonly number[],
  cpStart: number,
  codeCount: number,
  codePoints: readonly number[],
  faces: FontFaceSet,
  size: number,
  hScale: number,
  fallbackToAdvance: boolean,
): number {
  let total = 0;
  for (let offset = 0; offset < codeCount; offset += 1) {
    const position = cpStart + offset;
    const value = values[position];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
    } else if (fallbackToAdvance) {
      total += fallbackAdvance(codePoints[position], faces, size, hScale);
    }
  }
  return total;
}

/**
 * 把方向值收窄为合法角度；非法值按 0 处理，不 warning。
 *
 * @param value 方向角度。
 * @returns 0/90/180/270。
 */
function directionAngle(value: number): 0 | 90 | 180 | 270 {
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

/**
 * 校验方向值；非法时回退 0 并 warning。
 *
 * @param value 方向角度。
 * @param name 字段名。
 * @param options 布局选项。
 * @param state warning 状态。
 * @returns 合法方向。
 */
function normalizeDirection(
  value: number,
  name: string,
  options: TextLayoutOptions,
  state: WarningState,
): 0 | 90 | 180 | 270 {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  warnOnce(
    options,
    state,
    'warnedBadNumber',
    'W_BAD_NUMBER',
    `${name}=${value} 非法，已按 0 处理`,
  );
  return 0;
}

/**
 * 用当前 TextCode 的 DeltaX/DeltaY 值计算单元步进。
 *
 * @param code TextCode。
 * @param state warning 状态。
 * @param options 布局选项。
 * @returns 解析后的 X/Y 数值数组。
 */
function parseCodeDeltas(
  code: TextCode,
  state: WarningState,
  options: TextLayoutOptions,
): { deltaX: number[]; deltaY: number[] } {
  const x = parseDeltaTokens(code.deltaX as unknown);
  const y = parseDeltaTokens(code.deltaY as unknown);
  if (x.invalidTokens.length > 0 || y.invalidTokens.length > 0) {
    warnOnce(
      options,
      state,
      'warnedBadNumber',
      'W_BAD_NUMBER',
      `DeltaX/DeltaY 含非法 token：${[...x.invalidTokens, ...y.invalidTokens].join(', ')}`,
    );
  }
  return { deltaX: x.values, deltaY: y.values };
}

/**
 * 提取参与布局的码点。
 *
 * OFD 生成器常在 TextCode 内容中带入 XML 美化换行；换行不属于可见字符，
 * 也不应触发字形缺失 warning 或占用 DeltaX 下标。其他码点保持原顺序。
 *
 * @param text TextCode 文本。
 * @returns 过滤 CR/LF 后的码点序列。
 */
function layoutCodePoints(text: string): number[] {
  const result: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0x0a || codePoint === 0x0d) continue;
    result.push(codePoint);
  }
  return result;
}

/**
 * 计算文字布局。
 *
 * 处理 DeltaX/DeltaY、CGTransform、ReadDirection/CharDirection、HScale；
 * 具体算法见设计方案 12.3/12.4。
 *
 * @param object 文字对象。
 * @param faces 主字体与回退链。
 * @param options warning 与轮廓缓存选项。
 * @returns 字形 run 与 pen 结果。
 */
export function layoutText(
  object: TextObject,
  faces: FontFaceSet,
  options: TextLayoutOptions = {},
): TextLayout {
  const cache = options.outlineCache ?? DEFAULT_OUTLINE_CACHE;
  const state: WarningState = {
    warnedGlyph: false,
    warnedBadNumber: false,
  };
  const units: TextLayoutUnit[] = [];
  const size = Number.isFinite(object.size) ? object.size : 0;
  const hScale = Number.isFinite(object.hScale) ? object.hScale : 1;
  const readDirection = normalizeDirection(object.readDirection, 'ReadDirection', options, state);
  // CharDirection 不影响 pen，只控制字形旋转；这里先校验，绘制时复用合法值。
  normalizeDirection(object.charDirection, 'CharDirection', options, state);
  const [dirX, dirY] = READ_DIRECTIONS[readDirection];
  let penX = 0;
  let penY = 0;
  let prevX = 0;
  let prevY = 0;

  for (const [codeIndex, code] of object.codes.entries()) {
    const codePoints = layoutCodePoints(code.text);
    const startX = typeof code.x === 'number' && Number.isFinite(code.x) ? code.x : prevX;
    const startY = typeof code.y === 'number' && Number.isFinite(code.y) ? code.y : prevY;
    if (typeof code.x === 'number' && Number.isFinite(code.x)) prevX = code.x;
    if (typeof code.y === 'number' && Number.isFinite(code.y)) prevY = code.y;
    penX = startX;
    penY = startY;

    const { deltaX, deltaY } = parseCodeDeltas(code, state, options);
    // DeltaX/DeltaY 数量多于字符数时，超出部分不会被任何单元消费，直接忽略，不 warning。
    const pending = buildUnits(codePoints, code.cgTransforms, faces, cache, state, options);
    // 部分 OFD 生成器（如 z.ofd 的连字示例）在 CGTransform 压缩字符后，
    // 也把 DeltaX 压缩成“每个输出字形一项”；此时数组长度等于输出单元数减 1。
    // 若按 CodeCount 求和会跳过后续字形的间距，造成连字后文字挤在一起。
    const perGlyphDeltas =
      deltaX.length > 0 &&
      deltaX.length === pending.length - 1 &&
      deltaX.length < codePoints.length &&
      (deltaY.length === 0 ||
        (deltaY.length === pending.length - 1 && deltaY.length < codePoints.length));
    let deltaIndex = 0;

    for (const unit of pending) {
      const deltaCount =
        perGlyphDeltas && unit.deltaCount === undefined ? 1 : (unit.deltaCount ?? unit.codeCount);
      const unitX = penX;
      const unitY = penY;
      const placements: GlyphPlacement[] = [];
      let runPenX = penX;
      let runPenY = penY;
      for (const glyph of unit.glyphs) {
        const advance = scaleAdvance(glyph.advanceWidth, size, hScale, glyph.face.unitsPerEm);
        placements.push({
          faceKey: glyph.face.key,
          gid: glyph.gid,
          x: runPenX,
          y: runPenY,
          advance,
        });
        runPenX += dirX * advance;
        runPenY += dirY * advance;
      }
      const stepX = computeDelta(
        deltaX,
        deltaIndex,
        deltaCount,
        codePoints,
        faces,
        size,
        hScale,
        dirX !== 0,
      );
      const stepY = computeDelta(
        deltaY,
        deltaIndex,
        deltaCount,
        codePoints,
        faces,
        size,
        hScale,
        dirY !== 0,
      );
      units.push({
        codeIndex,
        cpStart: unit.cpStart,
        codeCount: unit.codeCount,
        x: unitX,
        y: unitY,
        glyphs: unit.glyphs,
        placements,
        deltaX: stepX,
        deltaY: stepY,
      });
      penX += dirX * stepX;
      // 横排文字的 DeltaY 常被用于软换行（本行结束后下移），即使步进方向是 +X
      // 也必须消费；竖排则由 dirY 决定正负。缺失 DeltaY 时 stepY 为 0，不会误推进。
      penY += dirY === 0 ? stepY : dirY * stepY;
      deltaIndex += deltaCount;
    }
  }

  return { units, endX: penX, endY: penY };
}

/**
 * 计算单个字形的对象空间变换。
 *
 * `M = T(pen) × R(charDirection) × K(italicSkew) × S(size/upem × hScale, -size/upem)`。
 *
 * @param placement 字形放置结果。
 * @param object 文字对象。
 * @param unitsPerEm 字体每 em 单位。
 * @param italic 是否应用合成斜体剪切。
 * @returns 2×3 仿射矩阵。
 */
function glyphMatrix(
  placement: GlyphPlacement,
  object: TextObject,
  unitsPerEm: number,
  italic: boolean,
): Matrix {
  const angle = (directionAngle(object.charDirection) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const size = Number.isFinite(object.size) ? object.size : 0;
  const hScale = Number.isFinite(object.hScale) ? object.hScale : 1;
  const upem = unitsPerEm > 0 ? unitsPerEm : 1000;
  const sx = (size / upem) * hScale;
  const sy = -size / upem;
  const translate: Matrix = [1, 0, 0, 1, placement.x, placement.y];
  const rotate: Matrix = [cos, sin, -sin, cos, 0, 0];
  const skew: Matrix = [1, 0, italic ? -SYNTHETIC_ITALIC_SKEW : 0, 1, 0, 0];
  const scale: Matrix = [sx, 0, 0, sy, 0, 0];
  return multiplyMatrix(multiplyMatrix(multiplyMatrix(translate, rotate), skew), scale);
}

/**
 * 把布局结果转换为对象空间路径命令。
 *
 * @param object 文字对象。
 * @param layout 布局结果。
 * @param faces 字体链。
 * @param syntheticItalic 是否应用合成斜体。
 * @returns 合并后的路径命令（对象空间，通常 mm）。
 */
function layoutToPath(
  object: TextObject,
  layout: TextLayout,
  faces: FontFaceSet,
  syntheticItalic: boolean,
): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const unit of layout.units) {
    for (const [index, placement] of unit.placements.entries()) {
      const run = unit.glyphs[index];
      if (!run || run.path.length === 0) continue;
      const italic = syntheticItalic && !run.face.italic;
      const matrix = glyphMatrix(placement, object, run.face.unitsPerEm, italic);
      commands.push(...transformPathCommands(run.path, matrix));
    }
  }
  return commands;
}

/**
 * 构建文字对象的对象空间轮廓（供裁剪/调试使用）。
 *
 * @param object 文字对象。
 * @param faces 字体链。
 * @param options 布局与合成斜体选项。
 * @returns 合并后的路径命令，对象空间单位（通常 mm）。
 */
export function buildTextPath(
  object: TextObject,
  faces: FontFaceSet,
  options: TextDrawOptions & TextLayoutOptions = {},
): PathCommand[] {
  const layout = layoutText(object, faces, options);
  const syntheticItalic = (options.syntheticItalic ?? true) && object.italic;
  return layoutToPath(object, layout, faces, syntheticItalic);
}

/**
 * 直接把字形轮廓变换后送入渲染器。
 *
 * 与 `transformPathCommands` 使用同一仿射公式，但不再分配中间命令对象；
 * 用于高频文字绘制，保持路径命令顺序与坐标完全一致。
 *
 * @param renderer 目标渲染器。
 * @param commands 字体单位路径命令。
 * @param matrix 仿射矩阵（列向量，`x' = a*x + c*y + e`）。
 */
function emitTransformed(
  renderer: Renderer,
  commands: readonly PathCommand[],
  matrix: Matrix,
): void {
  const [a, b, c, d, e, f] = matrix;
  for (const command of commands) {
    switch (command.type) {
      case 'moveTo':
        renderer.moveTo(a * command.x + c * command.y + e, b * command.x + d * command.y + f);
        break;
      case 'lineTo':
        renderer.lineTo(a * command.x + c * command.y + e, b * command.x + d * command.y + f);
        break;
      case 'quadraticCurveTo': {
        const x = a * command.x + c * command.y + e;
        const y = b * command.x + d * command.y + f;
        renderer.quadraticCurveTo(
          a * command.cpx + c * command.cpy + e,
          b * command.cpx + d * command.cpy + f,
          x,
          y,
        );
        break;
      }
      case 'bezierCurveTo': {
        const x = a * command.x + c * command.y + e;
        const y = b * command.x + d * command.y + f;
        renderer.cubicCurveTo(
          a * command.cp1x + c * command.cp1y + e,
          b * command.cp1x + d * command.cp1y + f,
          a * command.cp2x + c * command.cp2y + e,
          b * command.cp2x + d * command.cp2y + f,
          x,
          y,
        );
        break;
      }
      case 'closePath':
        renderer.closePath();
        break;
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }
}

/**
 * 绘制文字对象。
 *
 * 所有字形合并为路径后填充/描边；超过 `MAX_GLYPHS_PER_BATCH` 时按批重新 beginPath，
 * 避免单条路径过大。合成粗体/斜体只影响轮廓，不改变 Delta 推进。
 *
 * @param context 渲染器、PaintBinder 与字体。
 * @param object 文字对象。
 * @param style 已结算样式。
 * @param options 合成粗斜体与缓存选项。
 */
export function drawTextObject(
  context: TextDrawContext,
  object: TextObject,
  style: ResolvedStyle,
  options: TextDrawOptions = {},
): void {
  if (!Number.isFinite(object.size) || object.size <= 0) return;
  const layout = layoutText(object, context.faces, {
    onWarning: context.onWarning,
    objectId: object.id,
    outlineCache: options.outlineCache,
  });
  if (!layout.units.some((unit) => unit.placements.length > 0)) return;

  const fillPaint = style.fill ? context.binder.bind(style.fillPaint) : undefined;
  const strokePaint = style.stroke ? context.binder.bind(style.strokePaint) : undefined;
  const primary = context.faces.primary;
  const syntheticBold =
    (options.syntheticBold ?? true) && object.weight >= 600 && !primary.bold;
  const syntheticItalic = (options.syntheticItalic ?? true) && object.italic;
  const boldPaint = fillPaint ?? strokePaint;
  if (!fillPaint && !strokePaint && !(syntheticBold && boldPaint)) return;

  // 按字形分批复用同一条路径；每个批次独立 beginPath，避免超长路径的峰值内存。
  // 轮廓点直接变换后送渲染器，避免为每个字形分配一份 PathCommand 数组。
  let batchGlyphs = 0;

  const flush = (): void => {
    if (batchGlyphs === 0) return;
    if (style.fill && fillPaint) {
      context.renderer.fill(style, fillPaint, 'nonzero');
    }
    if (syntheticBold && boldPaint) {
      context.renderer.stroke(
        {
          ...style,
          lineWidth: object.size * SYNTHETIC_BOLD_WIDTH_FACTOR,
          lineJoin: 'Round',
        },
        boldPaint,
      );
    }
    if (style.stroke && strokePaint) {
      context.renderer.stroke(style, strokePaint);
    }
    batchGlyphs = 0;
  };

  for (const unit of layout.units) {
    for (const [index, placement] of unit.placements.entries()) {
      const run = unit.glyphs[index];
      if (!run || run.path.length === 0) continue;
      if (batchGlyphs === 0) context.renderer.beginPath();
      const italic = syntheticItalic && !run.face.italic;
      const matrix = glyphMatrix(placement, object, run.face.unitsPerEm, italic);
      emitTransformed(context.renderer, run.path, matrix);
      batchGlyphs += 1;
      if (batchGlyphs >= MAX_GLYPHS_PER_BATCH) flush();
    }
  }
  flush();
}
