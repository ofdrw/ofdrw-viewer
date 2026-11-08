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

describe('CGTransform 等量 1:1 串', () => {
  it('CodeCount 与 Glyphs 数量相同时逐字符拆分并按各自 delta 推进', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: [4, 6],
            cgTransforms: [transform(0, 2, [1, 2])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(2);
    expect(layout.units.map((unit) => unit.glyphs[0].gid)).toEqual([1, 2]);
    expect(layout.units.map((unit) => unit.deltaX)).toEqual([4, 6]);
    expect(layout.units.map((unit) => unit.placements[0].x)).toEqual([0, 4]);
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

describe('CGTransform N:1（连字）DeltaX 压缩兼容', () => {
  it('DeltaX 已压缩为每个输出字形一项时，每个单元只消费一项', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'ABlA',
            // 3 个输出单元（AB 连字、l、A），DeltaX 只有 2 项。
            deltaX: [4, 6],
            cgTransforms: [transform(0, 2, [10])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(3);
    expect(layout.units.map((unit) => unit.deltaX)).toEqual([4, 6, 4]);
    expect(layout.endX).toBe(14);
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
    expect(layout.units).toHaveLength(2);
    expect(layout.units.map((unit) => unit.glyphs[0].gid)).toEqual([21, 22]);
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

  it('多对多：2 个字符映射 3 个字形时按一个 run 连续排布', () => {
    const face = createTransformFace();
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: [10, 20],
            cgTransforms: [transform(0, 2, [21, 22, 23])],
          }),
        ],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([21, 22, 23]);
    // 100/200/300 字体单位，Size=10 → 1/2/3 对象空间单位；字符 delta 之和 30。
    expect(layout.units[0].placements.map((placement) => placement.advance)).toEqual([1, 2, 3]);
    expect(layout.endX).toBe(30);
  });

  it('显式 GID 在主字体中缺失时用被覆盖字符的 cmap 解析', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      glyphs: [{ gid: 1, advanceWidth: 500, codePoints: [0x41] }],
    });
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'A',
            deltaX: [5],
            cgTransforms: [transform(0, 1, [21])],
          }),
        ],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([1]);
    expect(warnings).toEqual([]);
  });

  it('N:1 的显式 gid 不可用时回退为逐字符轮廓，保留两字符 Delta', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      glyphs: [
        { gid: 1, advanceWidth: 500, codePoints: [0x41] },
        { gid: 2, advanceWidth: 700, codePoints: [0x42] },
      ],
    });
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: [10, 20],
            cgTransforms: [transform(0, 2, [10])],
          }),
        ],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([1, 2]);
    expect(layout.units[0].cpStart).toBe(0);
    expect(layout.units[0].codeCount).toBe(2);
    // 两个字符的轮廓都保留，按字体 advance 连续排；整串只消费该 CG 单元 1 个 Delta。
    expect(layout.units[0].placements.map((placement) => placement.x)).toEqual([0, 5]);
    expect(layout.endX).toBe(10);
    expect(warnings).toEqual([]);
  });

  it('N:M 的显式 gid 不可用时保留全部字符轮廓，只消费该 CG 单元 Delta', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      glyphs: [
        { gid: 1, advanceWidth: 500, codePoints: [0x41] },
        { gid: 2, advanceWidth: 700, codePoints: [0x42] },
      ],
    });
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: 'AB',
            deltaX: [10, 20],
            cgTransforms: [transform(0, 2, [10, 11, 12])],
          }),
        ],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units).toHaveLength(1);
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([1, 2]);
    expect(layout.units[0].placements.map((placement) => placement.x)).toEqual([0, 5]);
    expect(layout.endX).toBe(10);
    expect(warnings).toEqual([]);
  });
});
describe('显式 GID 信任语义', () => {
  /** 收集 warning 的文本 code 串。 */
  function warningsOf(run: (push: (code: string, message: string) => void) => void): string[] {
    const warnings: string[] = [];
    run((code, message) => warnings.push(`${code}:${message}`));
    return warnings;
  }

  it('原始字体：1:1 CGTransform 使用文档 GID 而不是 cmap', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      glyphs: [
        { gid: 1, advanceWidth: 500, codePoints: [0xa4] },
        { gid: 21, advanceWidth: 900 },
      ],
    });
    const layout = layoutText(
      makeTextObject({
        codes: [makeTextCode({ text: '¤', deltaX: [5], cgTransforms: [transform(0, 1, [21])] })],
      }),
      createFakeFaceSet(face),
    );
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([21]);
  });

  it('原始字体：GID 越界回落 cmap，不计为 GID 不可信任', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      glyphs: [{ gid: 1, advanceWidth: 500, codePoints: [0xa4] }],
    });
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [makeTextCode({ text: '¤', deltaX: [5], cgTransforms: [transform(0, 1, [99])] })],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    // 回落到 cmap，仍有字形可画，且不能报告"缺少原始字体"。
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([1]);
    expect(warnings.some((warning) => warning.includes('缺少原始字体'))).toBe(false);
  });

  it('替代字体 + 纯 GID 占位符文本：跳过该文字对象并报 W_FONT_MISSING', () => {
    const face = createFakeFace({
      explicitGlyphs: false,
      glyphs: [
        { gid: 1, advanceWidth: 500, codePoints: [0xa4] },
        { gid: 21, advanceWidth: 900 },
      ],
    });
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        codes: [makeTextCode({ text: '¤', deltaX: [5], cgTransforms: [transform(0, 1, [21])] })],
      }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    // 整对象跳过：既没有 GID 字形，也没有回落到 cmap 画 .notdef。
    expect(layout.units).toEqual([]);
    expect(warnings.some((warning) => warning.startsWith('W_FONT_MISSING'))).toBe(true);
    expect(warnings.some((warning) => warning.startsWith('W_GLYPH_MISSING'))).toBe(false);
  });

  it('替代字体 + 纯 GID 多字符：整段跳过；相邻正常 Unicode 文本仍走 cmap', () => {
    const face = createFakeFace({
      explicitGlyphs: false,
      glyphs: [
        { gid: 1, advanceWidth: 500, codePoints: [0x41] },
        { gid: 2, advanceWidth: 700, codePoints: [0x42] },
        { gid: 21, advanceWidth: 900 },
        { gid: 22, advanceWidth: 900 },
      ],
    });
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({
            text: '¤¤',
            deltaX: [5, 5],
            cgTransforms: [transform(0, 2, [21, 22])],
          }),
          makeTextCode({ text: 'AB', deltaX: [5, 5] }),
        ],
      }),
      createFakeFaceSet(face),
    );
    // 纯 GID 段落不绘制任何字形，第二段正常文本照常渲染。
    const drawn = layout.units
      .map((unit) => unit.glyphs.map((glyph) => glyph.gid))
      .filter((glyphs) => glyphs.length > 0);
    expect(drawn).toEqual([[1], [2]]);
  });

  it('无 CGTransform 的正常文本在替代字体下仍走 cmap', () => {
    const face = createFakeFace({
      explicitGlyphs: false,
      glyphs: [{ gid: 1, advanceWidth: 500, codePoints: [0x41] }],
    });
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'A', deltaX: [5] })] }),
      createFakeFaceSet(face),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units[0].glyphs.map((glyph) => glyph.gid)).toEqual([1]);
    expect(warnings).toEqual([]);
  });

  it('N:M 全部 GID 不可信任：整段丢弃，不回落占位符的 cmap', () => {
    const face = createFakeFace({
      explicitGlyphs: false,
      glyphs: [
        { gid: 1, advanceWidth: 500, codePoints: [0x41] },
        { gid: 2, advanceWidth: 700, codePoints: [0x42] },
      ],
    });
    const units = buildUnits(
      [0x41, 0x42],
      [transform(0, 2, [21, 22, 23])],
      createFakeFaceSet(face),
    );
    expect(units).toHaveLength(1);
    expect(units[0].untrustedGid).toBe(true);
    expect(units[0].glyphs).toEqual([]);
  });

  it('N:M 混合场景（原字体 GID 部分可用、部分越界）：用可用的 GID，不整段丢弃', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      glyphs: [{ gid: 21, advanceWidth: 100 }],
    });
    const units = buildUnits(
      [0x41, 0x42],
      [transform(0, 2, [21, 99])],
      createFakeFaceSet(face),
    );
    // gid 21 可用、gid 99 越界：段内仍有可用字形，不整段丢弃。
    expect(units.every((unit) => unit.untrustedGid !== true)).toBe(true);
    const drawn = units.flatMap((unit) => unit.glyphs.map((glyph) => glyph.gid));
    expect(drawn).toEqual([21]);
  });

  it('N:M 部分 GID 可用时使用可用 GID，不整段丢弃', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      glyphs: [
        { gid: 21, advanceWidth: 100 },
        { gid: 22, advanceWidth: 200 },
      ],
    });
    const units = buildUnits(
      [0x41],
      [transform(0, 1, [21, 22])],
      createFakeFaceSet(face),
    );
    expect(units[0].glyphs.map((glyph) => glyph.gid)).toEqual([21, 22]);
    expect(units[0].untrustedGid).toBeUndefined();
  });

  it('buildUnits 对 GID 越界（原始字体）不标记 untrustedGid', () => {
    const face = createFakeFace({
      explicitGlyphs: true,
      hasCmap: false,
      glyphs: [{ gid: 1, advanceWidth: 500 }],
    });
    const units = buildUnits(
      [0x41],
      [transform(0, 1, [99])],
      createFakeFaceSet(face),
    );
    expect(units).toHaveLength(1);
    expect(units[0].untrustedGid).toBeUndefined();
    expect(units[0].glyphs).toEqual([]);
  });

  it('buildUnits 对替代字体 + 合法 GID 标记 untrustedGid', () => {
    const face = createFakeFace({
      explicitGlyphs: false,
      glyphs: [{ gid: 21, advanceWidth: 900 }],
    });
    const units = buildUnits(
      [0xa4],
      [transform(0, 1, [21])],
      createFakeFaceSet(face),
    );
    expect(units).toHaveLength(1);
    expect(units[0].untrustedGid).toBe(true);
  });
});
