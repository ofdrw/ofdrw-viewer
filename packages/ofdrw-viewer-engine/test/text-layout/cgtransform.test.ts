/**
 * CGTransform run-based 布局测试（设计方案 12.3、图 67–70）。
 */

import { describe, expect, it } from 'vitest';
import type { CgTransform } from '../../src/model/types';
import { buildUnits, layoutText } from '../../src/render/text';
import {
  createFakeFace,
  createFakeFaceSet,
  makeTextCode,
  makeTextObject,
} from './fake-font';

/** 构造覆盖 1:1/N:1/1:N/N:M 的假字体。 */
function createTransformFace() {
  return createFakeFace({
    unitsPerEm: 1000,
    glyphs: [
      { gid: 1, advanceWidth: 500, codePoints: [0x41] },
      { gid: 2, advanceWidth: 700, codePoints: [0x42] },
      { gid: 3, advanceWidth: 300, codePoints: [0x66] },
      { gid: 4, advanceWidth: 400, codePoints: [0x6c] },
      { gid: 10, advanceWidth: 800 },
      { gid: 11, advanceWidth: 300 },
      { gid: 12, advanceWidth: 400 },
      { gid: 21, advanceWidth: 100 },
      { gid: 22, advanceWidth: 200 },
      { gid: 23, advanceWidth: 300 },
    ],
  });
}

/** 构造 CGTransform。 */
function transform(
  codePosition: number,
  codeCount: number,
  glyphs: number[],
): CgTransform {
  return { codePosition, codeCount, glyphCount: glyphs.length, glyphs };
}

/** 收集 warning。 */
function collectWarnings(): string[] {
  return [];
}

describe('CGTransform 1:1', () => {
  it('每个字符一个变换，分别按 delta 推进', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: [4, 6],
            cgTransforms: [transform(0, 1, [1]), transform(1, 1, [2])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(2);
    expect(layout.units[0]).toMatchObject({ cpStart: 0, codeCount: 1, deltaX: 4 });
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([1]);
    expect(layout.units[1]).toMatchObject({ cpStart: 1, codeCount: 1, deltaX: 6 });
    expect(layout.units[1].glyphs.map((glyph) => glyph.gid)).toEqual([2]);
    expect(layout.endX).toBe(10);
  });
});

describe('CGTransform N:1（连字）', () => {
  it('一个字形串覆盖多个字符，整串后按字符 delta 之和推进', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'fl',
            deltaX: [4, 6],
            cgTransforms: [transform(0, 2, [10])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0]).toMatchObject({ cpStart: 0, codeCount: 2, deltaX: 10 });
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([10]);
    expect(layout.units[0].placements).toHaveLength(1);
    // 字符格决定步进 4+6=10，而不是连字自身的 advance 8。
    expect(layout.endX).toBe(10);
  });
});

describe('CGTransform 1:N（一个字符多个字形）', () => {
  it('多个字形按字体 advance 连续排布，整串后按该字符 delta 推进', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'A',
            deltaX: [9],
            cgTransforms: [transform(0, 1, [11, 12])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([11, 12]);
    expect(layout.units[0].placements.map((placement) => placement.x)).toEqual([0, 3]);
    expect(layout.units[0].deltaX).toBe(9);
    expect(layout.endX).toBe(9);
  });
});

describe('CGTransform N:M（多字符多字形）', () => {
  it('字形整体连续绘制，字符格只决定整串总步进', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: [5, 6],
            cgTransforms: [transform(0, 2, [21, 22, 23])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0].codeCount).toBe(2);
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([21, 22, 23]);
    expect(layout.units[0].placements.map((placement) => placement.x)).toEqual([0, 1, 3]);
    expect(layout.endX).toBe(11);
  });
});

describe('逐字形回退', () => {
  it('主字体缺字时在布局中改用回退字体，且不报缺字 warning', () => {
    const primary = createFakeFace({
      key: 'primary',
      glyphs: [{ gid: 1, advanceWidth: 500, codePoints: [0x41] }],
    });
    const fallback = createFakeFace({
      key: 'fallback',
      glyphs: [{ gid: 9, advanceWidth: 700, codePoints: [0x4e2d] }],
    });
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: '中', deltaX: [7] })] }),
      createFakeFaceSet(primary, [fallback]),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([9]);
    expect(layout.units[0].glyphs[0].face.key).toBe('fallback');
    expect(warnings).toHaveLength(0);
  });

  it('回退字形按自身 upem 缩放 advance，而不是主字体 upem', () => {
    const primary = createFakeFace({
      key: 'primary-upem',
      unitsPerEm: 2048,
      glyphs: [{ gid: 1, advanceWidth: 2048, codePoints: [0x41] }],
    });
    const fallback = createFakeFace({
      key: 'fallback-upem',
      unitsPerEm: 500,
      glyphs: [{ gid: 9, advanceWidth: 500, codePoints: [0x4e2d] }],
    });
    const layout = layoutText(
      makeTextObject({ size: 10, codes: [makeTextCode({ text: '中' })] }),
      createFakeFaceSet(primary, [fallback]),
    );
    // 回退字体 1 em = 500 单位、advance=500 → size 10 时前进 10。
    expect(layout.units[0].placements[0].advance).toBeCloseTo(10, 6);
    expect(layout.endX).toBeCloseTo(10, 6);
  });
});

describe('CGTransform 容错', () => {
  it('CodePosition 越界/空 Glyphs/CodeCount<1 跳过并 warning', () => {
    const face = createTransformFace();
    const warnings: string[] = [];
    const faces = createFakeFaceSet(face);
    const cps = Array.from('AB', (char) => char.codePointAt(0) as number);
    const units = buildUnits(
      cps,
      [transform(99, 1, [1]), transform(0, 0, [1]), transform(1, 1, [])],
      faces,
      undefined,
      undefined,
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.codeCount)).toEqual([1, 1]);
    expect(warnings.some((warning) => warning.includes('CGTransform 参数非法'))).toBe(true);
  });

  it('CodeCount 超出剩余字符时截断并 warning', () => {
    const face = createTransformFace();
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'A',
            deltaX: [7],
            cgTransforms: [transform(0, 3, [11, 12])],
          }),
        ],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0].codeCount).toBe(1);
    expect(layout.endX).toBe(7);
    expect(warnings.some((warning) => warning.includes('超出剩余字符数'))).toBe(true);
  });

  it('重复 CodePosition 保留先出现者并 warning', () => {
    const face = createTransformFace();
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'A',
            deltaX: [7],
            cgTransforms: [transform(0, 1, [1]), transform(0, 1, [2])],
          }),
        ],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([1]);
    expect(warnings.some((warning) => warning.includes('重复'))).toBe(true);
  });

  it('GlyphCount 与实际 Glyphs 不一致时以数组为准并 warning', () => {
    const face = createTransformFace();
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'A',
            deltaX: [5],
            cgTransforms: [{ codePosition: 0, codeCount: 1, glyphCount: 3, glyphs: [11] }],
          }),
        ],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([11]);
    expect(warnings.some((warning) => warning.includes('GlyphCount'))).toBe(true);
  });

  it('重叠的 CGTransform 被忽略并 warning', () => {
    const face = createTransformFace();
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: [5, 6],
            cgTransforms: [transform(0, 2, [21, 22]), transform(1, 1, [2])],
          }),
        ],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([21, 22]);
    expect(warnings.some((warning) => warning.includes('重叠'))).toBe(true);
  });

  it('CGTransform 与 g 压缩 Delta 组合时按字符 run 处理，不把 g 当字符', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: '0 g 2 7',
            cgTransforms: [transform(0, 1, [1]), transform(1, 1, [2])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(2);
    expect(layout.units.map((unit) => unit.deltaX)).toEqual([0, 7]);
    expect(layout.endX).toBe(7);
  });

  it('无 cmap 剥离子集只能通过 CGTransform 显式 gid 出字', () => {
    const face = createFakeFace({
      hasCmap: false,
      glyphs: [{ gid: 11, advanceWidth: 500 }],
    });
    const warnings: string[] = [];
    const faces = createFakeFaceSet(face);
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'A',
            deltaX: [5],
            cgTransforms: [transform(0, 1, [11])],
          }),
        ],
      }),
      faces,
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([11]);

    const missingWarnings: string[] = [];
    layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'A', deltaX: [5] })] }),
      faces,
      { onWarning: (code, message) => missingWarnings.push(`${code}:${message}`) },
    );
    expect(missingWarnings.some((warning) => warning.startsWith('W_GLYPH_MISSING'))).toBe(true);
  });
});