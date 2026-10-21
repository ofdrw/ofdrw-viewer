/**
 * 文字布局测试用的假字体、假渲染器与模型构造器。
 *
 * 这些 helper 不依赖真实字体文件，用于精确断言 pen 位置、字形 run 与绘制调用。
 */

import type { PaintSpec, PathCommand, ResolvedPaint } from '../../src/common/types';
import type { TextCode, TextObject, GraphicUnitBase } from '../../src/model/types';
import type { ResolvedStyle } from '../../src/style/types';
import type { Renderer } from '../../src/renderer/types';
import type { PaintBinder } from '../../src/render/paint';
import type { FontFace, FontFaceSet, Glyph } from '../../src/font/types';

/** 假字形定义。 */
export interface FakeGlyphSpec {
  /** 字形 ID。 */
  gid: number;
  /** 字体单位 advance；缺省为 1000。 */
  advanceWidth?: number;
  /** 字体单位轮廓；缺省为一个小三角形。 */
  path?: PathCommand[];
  /** 映射到的 Unicode 码点。 */
  codePoints?: number[];
}

/** 假字体选项。 */
export interface FakeFaceOptions {
  key?: string;
  family?: string;
  unitsPerEm?: number;
  hasCmap?: boolean;
  bold?: boolean;
  italic?: boolean;
  glyphs: FakeGlyphSpec[];
}

/** 假字体调用计数。 */
export interface FakeFaceCalls {
  glyphForCodePoint: number;
  glyph: number;
}

/** 带调用计数的假字体。 */
export interface FakeFace extends FontFace {
  calls: FakeFaceCalls;
}

/** 自动生成唯一 key 的计数器，避免模块级轮廓缓存串图。 */
let fakeFaceCounter = 0;

/**
 * 创建假字体面。
 *
 * @param options 字形表与字体属性。
 * @returns 假字体面。
 */
export function createFakeFace(options: FakeFaceOptions): FakeFace {
  const unitsPerEm = options.unitsPerEm ?? 1000;
  const byGid = new Map<number, FakeGlyphSpec>();
  const byCodePoint = new Map<number, FakeGlyphSpec>();
  for (const spec of options.glyphs) {
    byGid.set(spec.gid, spec);
    for (const codePoint of spec.codePoints ?? []) byCodePoint.set(codePoint, spec);
  }
  const calls: FakeFaceCalls = { glyphForCodePoint: 0, glyph: 0 };
  const key = options.key ?? `fake-${(fakeFaceCounter += 1)}`;
  const hasCmap = options.hasCmap ?? true;

  const toGlyph = (spec: FakeGlyphSpec): Glyph => ({
    id: spec.gid,
    advanceWidth: spec.advanceWidth ?? 1000,
    path:
      spec.path ??
      ([
        { type: 'moveTo', x: 0, y: 0 },
        { type: 'lineTo', x: 500, y: 0 },
        { type: 'lineTo', x: 500, y: 700 },
        { type: 'closePath' },
      ] satisfies PathCommand[]),
  });

  return {
    key,
    family: options.family ?? 'Fake Sans',
    postscriptName: options.family ?? 'FakeSans',
    unitsPerEm,
    numGlyphs: Math.max(0, ...options.glyphs.map((spec) => spec.gid + 1)),
    hasCmap,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    calls,
    glyphForCodePoint(codePoint: number): Glyph | null {
      calls.glyphForCodePoint += 1;
      if (!hasCmap) return null;
      const spec = byCodePoint.get(codePoint);
      return spec ? toGlyph(spec) : null;
    },
    glyph(glyphId: number): Glyph | null {
      calls.glyph += 1;
      const spec = byGid.get(glyphId);
      return spec ? toGlyph(spec) : null;
    },
  };
}

/**
 * 创建字体链。
 *
 * @param primary 主字体。
 * @param fallbacks 回退字体。
 * @returns 字体链。
 */
export function createFakeFaceSet(primary: FontFace, fallbacks: FontFace[] = []): FontFaceSet {
  return { primary, fallbacks };
}

/**
 * 创建只返回 null 的空字体（模拟无字体/无 cmap 且无回退）。
 *
 * @returns 假字体。
 */
export function createEmptyFace(): FakeFace {
  return createFakeFace({ hasCmap: false, glyphs: [] });
}

/** TextCode 构造选项。 */
export interface TextCodeInput {
  text: string;
  x?: number;
  y?: number;
  deltaX?: number[] | string;
  deltaY?: number[] | string;
  cgTransforms?: TextCode['cgTransforms'];
}

/**
 * 构造 TextCode；测试允许用字符串模拟未经解码的 g 压缩组。
 *
 * @param input 文本与可选布局参数。
 * @returns TextCode。
 */
export function makeTextCode(input: TextCodeInput): TextCode {
  return {
    text: input.text,
    x: input.x,
    y: input.y,
    deltaX: (input.deltaX ?? []) as number[],
    deltaY: (input.deltaY ?? []) as number[],
    cgTransforms: input.cgTransforms ?? [],
  };
}

/** TextObject 覆盖字段。 */
export type TextObjectOverrides = Partial<Omit<TextObject, 'kind'>> & {
  codes?: TextCode[];
};

/**
 * 构造 TextObject；未提供的字段使用合理默认值。
 *
 * @param overrides 覆盖字段。
 * @returns TextObject。
 */
export function makeTextObject(overrides: TextObjectOverrides = {}): TextObject {
  const boundary = overrides.boundary ?? { x: 0, y: 0, w: 100, h: 20 };
  const base: GraphicUnitBase = {
    boundary,
    alpha: 255,
    visible: true,
  };
  return {
    ...base,
    ...overrides,
    kind: 'text',
    font: overrides.font ?? '1',
    size: overrides.size ?? 10,
    hScale: overrides.hScale ?? 1,
    readDirection: overrides.readDirection ?? 0,
    charDirection: overrides.charDirection ?? 0,
    weight: overrides.weight ?? 400,
    italic: overrides.italic ?? false,
    fill: overrides.fill ?? true,
    stroke: overrides.stroke ?? false,
    codes: overrides.codes ?? [],
  };
}

/** 记录的一次渲染器调用。 */
export interface RecordedCall {
  op: string;
  args: unknown[];
}

/** 带调用记录的渲染器。 */
export type RecordingRenderer = Renderer & { calls: RecordedCall[] };

/**
 * 创建记录所有 Renderer 方法调用的假渲染器。
 *
 * @returns 渲染器与调用数组（同一引用）。
 */
export function createRecordingRenderer(): RecordingRenderer {
  const calls: RecordedCall[] = [];
  const target = {
    calls,
  } as unknown as RecordingRenderer;
  return new Proxy(target, {
    get(obj, property: string | symbol): unknown {
      if (property === 'calls') return calls;
      if (typeof property !== 'string') return undefined;
      return (...args: unknown[]): void => {
        calls.push({ op: property, args });
      };
    },
  });
}

/** 测试用 ResolvedStyle 选项。 */
export interface StyleOverrides {
  fill?: boolean;
  stroke?: boolean;
  lineWidth?: number;
  lineCap?: 'Butt' | 'Round' | 'Square';
  lineJoin?: 'Miter' | 'Round' | 'Bevel';
}

/**
 * 创建 ResolvedStyle。
 *
 * @param overrides 覆盖字段。
 * @returns 已结算样式。
 */
export function createStyle(overrides: StyleOverrides = {}): ResolvedStyle {
  return {
    lineWidth: overrides.lineWidth ?? 0.353,
    lineCap: overrides.lineCap ?? 'Butt',
    lineJoin: overrides.lineJoin ?? 'Miter',
    miterLimit: 4.234,
    dashOffset: 0,
    dashPattern: [],
    fillPaint: { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } },
    strokePaint: { kind: 'color', rgba: { r: 255, g: 0, b: 0, a: 255 } },
    fill: overrides.fill ?? true,
    stroke: overrides.stroke ?? false,
    fillRule: 'nonzero',
    alpha: 1,
  };
}

/** 记录绑定请求的 PaintBinder。 */
export type RecordingBinder = PaintBinder & { bound: (PaintSpec | undefined)[] };

/**
 * 创建把任意 PaintSpec 绑定为黑色的假 binder。
 *
 * @returns 假 binder。
 */
export function createRecordingBinder(): RecordingBinder {
  const bound: (PaintSpec | undefined)[] = [];
  return {
    bound,
    bind(spec: PaintSpec | undefined): ResolvedPaint | undefined {
      bound.push(spec);
      if (!spec) return undefined;
      return { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } };
    },
    clear(): void {
      bound.length = 0;
    },
  };
}

/**
 * 读取记录中某个操作的全部参数。
 *
 * @param calls 调用记录。
 * @param op 操作名。
 * @returns 参数数组。
 */
export function callsOf(calls: readonly RecordedCall[], op: string): unknown[][] {
  return calls.filter((call) => call.op === op).map((call) => call.args);
}