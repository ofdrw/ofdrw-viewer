/**
 * DeltaX/DeltaY 解析与 pen 推进测试（设计方案 3 裁决表、12.4、19.1 文字）。
 */

import { describe, expect, it } from 'vitest';
import { layoutText, parseDeltaTokens } from '../../src/render/text';
import {
  createFakeFace,
  createFakeFaceSet,
  makeTextCode,
  makeTextObject,
} from './fake-font';

/** 造一个 3 字符、每字符 advance=1000/upem=1000 的假字体。 */
function createAbcFace() {
  return createFakeFace({
    unitsPerEm: 1000,
    glyphs: [
      { gid: 1, advanceWidth: 1000, codePoints: [0x41] },
      { gid: 2, advanceWidth: 1000, codePoints: [0x42] },
      { gid: 3, advanceWidth: 1000, codePoints: [0x43] },
    ],
  });
}

/** 创建 warning 收集器。 */
function collectWarnings(): string[] {
  const warnings: string[] = [];
  return warnings;
}

describe('parseDeltaTokens', () => {
  it('解析普通数组与字符串', () => {
    expect(parseDeltaTokens([1, 2, 3])).toEqual({ values: [1, 2, 3], invalidTokens: [] });
    expect(parseDeltaTokens('1.5 2 3')).toEqual({ values: [1.5, 2, 3], invalidTokens: [] });
    expect(parseDeltaTokens(undefined)).toEqual({ values: [], invalidTokens: [] });
  });

  it('展开 g 压缩组', () => {
    expect(parseDeltaTokens('g 3 3.1305')).toEqual({
      values: [3.1305, 3.1305, 3.1305],
      invalidTokens: [],
    });
    expect(parseDeltaTokens('1 g 2 2.5 3')).toEqual({
      values: [1, 2.5, 2.5, 3],
      invalidTokens: [],
    });
    // 用户补充的 ST_Array 示例：g 只重复紧随其后的数值，前后的 0/2 保留。
    expect(parseDeltaTokens('0 g 3 5 2')).toEqual({
      values: [0, 5, 5, 5, 2],
      invalidTokens: [],
    });
    expect(parseDeltaTokens(['0', 'g', '3', '5', '2'])).toEqual({
      values: [0, 5, 5, 5, 2],
      invalidTokens: [],
    });
    expect(parseDeltaTokens('0, g 3 5, 2')).toEqual({
      values: [0, 5, 5, 5, 2],
      invalidTokens: [],
    });
  });

  it('收集非法 token 与非法 g 组', () => {
    expect(parseDeltaTokens('4 x 6')).toEqual({ values: [4, 6], invalidTokens: ['x'] });
    expect(parseDeltaTokens('g 0 1')).toEqual({
      values: [],
      invalidTokens: ['g 0 1'],
    });
    expect(parseDeltaTokens('g 2')).toEqual({ values: [], invalidTokens: ['g 2'] });
    expect(parseDeltaTokens([1, Number.NaN, 3])).toEqual({
      values: [1, 3],
      invalidTokens: ['NaN'],
    });
  });

  it('显式 0 保留', () => {
    expect(parseDeltaTokens('0 0 0')).toEqual({ values: [0, 0, 0], invalidTokens: [] });
  });
});

describe('layoutText DeltaX', () => {
  const faces = createFakeFaceSet(createAbcFace());

  it('缺失 DeltaX 时按字体 advance 推进', () => {
    const layout = layoutText(makeTextObject({ codes: [makeTextCode({ text: 'ABC' })] }), faces);
    expect(layout.units).toHaveLength(3);
    expect(layout.units.map((unit) => unit.deltaX)).toEqual([10, 10, 10]);
    expect(layout.units.map((unit) => unit.x)).toEqual([0, 10, 20]);
    expect(layout.endX).toBe(30);
  });

  it('DeltaX 数量不足时后面的字符回退 advance', () => {
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'ABC', deltaX: [5] })] }),
      faces,
    );
    expect(layout.units.map((unit) => unit.deltaX)).toEqual([5, 10, 10]);
    expect(layout.endX).toBe(25);
  });

  it('DeltaX 数量过多时忽略多余值且不 warning', () => {
    const warnings = collectWarnings();
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'ABC', deltaX: [5, 5, 5, 100] })] }),
      faces,
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.endX).toBe(15);
    expect(warnings).toHaveLength(0);
  });

  it('显式 0 被尊重，字符重叠', () => {
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'ABC', deltaX: [0, 0, 0] })] }),
      faces,
    );
    expect(layout.units.map((unit) => unit.x)).toEqual([0, 0, 0]);
    expect(layout.endX).toBe(0);
  });

  it('最后一个值只描述最后一个字位，不再推进字符', () => {
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })] }),
      faces,
    );
    expect(layout.endX).toBe(10);
    expect(layout.units.map((unit) => unit.x)).toEqual([0, 5]);
  });

  it('g 压缩组参与布局', () => {
    const layout = layoutText(
      makeTextObject({
        codes: [makeTextCode({ text: 'ABC', deltaX: 'g 3 3.1305' })],
      }),
      faces,
    );
    expect(layout.endX).toBeCloseTo(9.3915, 6);
  });

  it('DeltaX = 0 g 3 5 2 逐字符消费，g 不占字符位', () => {
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'ABCDE', deltaX: '0 g 3 5 2' })] }),
      faces,
    );
    expect(layout.units).toHaveLength(5);
    expect(layout.units.map((unit) => unit.deltaX)).toEqual([0, 5, 5, 5, 2]);
    expect(layout.units.map((unit) => unit.x)).toEqual([0, 0, 5, 10, 15]);
    expect(layout.endX).toBe(17);
  });

  it('非法 token 跳过并 warning，缺失位置回退 advance', () => {
    const warnings = collectWarnings();
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'ABC', deltaX: '4 x 6' })] }),
      faces,
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units.map((unit) => unit.deltaX)).toEqual([4, 6, 10]);
    expect(layout.endX).toBe(20);
    expect(warnings.some((warning) => warning.includes('非法 token'))).toBe(true);
  });

  it('DeltaY 数量过多时同样静默忽略多余值', () => {
    const warnings = collectWarnings();
    layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'A', deltaY: [1, 2, 3] })] }),
      faces,
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(warnings).toHaveLength(0);
  });

  it('横向文字的 DeltaY 作为软换行偏移消费', () => {
    const layout = layoutText(
      makeTextObject({ codes: [makeTextCode({ text: 'AB', deltaX: [5, 5], deltaY: [3, 0] })] }),
      faces,
    );
    expect(layout.endX).toBe(10);
    expect(layout.endY).toBe(3);
    expect(layout.units.map((unit) => unit.placements[0].y)).toEqual([0, 3]);
  });
});

describe('layoutText DeltaY 与 TextCode 起点', () => {
  const faces = createFakeFaceSet(createAbcFace());

  it('ReadDirection=90 时使用 DeltaY 向下推进', () => {
    const layout = layoutText(
      makeTextObject({
        readDirection: 90,
        codes: [makeTextCode({ text: 'ABC', deltaY: [5] })],
      }),
      faces,
    );
    expect(layout.endX).toBe(0);
    expect(layout.endY).toBe(25);
    expect(layout.units.map((unit) => unit.y)).toEqual([0, 5, 15]);
  });

  it('竖排缺失 DeltaY 时按字体 advance 推进', () => {
    const layout = layoutText(
      makeTextObject({ readDirection: 90, codes: [makeTextCode({ text: 'ABC' })] }),
      faces,
    );
    expect(layout.units.map((unit) => unit.deltaY)).toEqual([10, 10, 10]);
    expect(layout.units.map((unit) => unit.y)).toEqual([0, 10, 20]);
    expect(layout.endY).toBe(30);
  });

  it('竖排显式 DeltaY=0 被尊重', () => {
    const layout = layoutText(
      makeTextObject({
        readDirection: 90,
        codes: [makeTextCode({ text: 'ABC', deltaY: [0, 0, 0] })],
      }),
      faces,
    );
    expect(layout.units.map((unit) => unit.y)).toEqual([0, 0, 0]);
    expect(layout.endY).toBe(0);
  });

  it('竖排 DeltaY 的 g 压缩组参与布局', () => {
    const layout = layoutText(
      makeTextObject({
        readDirection: 270,
        codes: [makeTextCode({ text: 'ABC', deltaY: 'g 3 2.5' })],
      }),
      faces,
    );
    expect(layout.endY).toBeCloseTo(-7.5, 6);
    expect(layout.units.map((unit) => unit.y)).toEqual([0, -2.5, -5]);
  });

  it('DeltaY = 0 g 3 5 2 逐字符消费', () => {
    const layout = layoutText(
      makeTextObject({
        readDirection: 90,
        codes: [makeTextCode({ text: 'ABCDE', deltaY: '0 g 3 5 2' })],
      }),
      faces,
    );
    expect(layout.units.map((unit) => unit.deltaY)).toEqual([0, 5, 5, 5, 2]);
    expect(layout.units.map((unit) => unit.y)).toEqual([0, 0, 5, 10, 15]);
    expect(layout.endY).toBe(17);
  });

  it('竖排 DeltaY 非法 token 跳过并 warning', () => {
    const warnings = collectWarnings();
    const layout = layoutText(
      makeTextObject({
        readDirection: 90,
        codes: [makeTextCode({ text: 'ABC', deltaY: '4 x 6' })],
      }),
      faces,
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.units.map((unit) => unit.deltaY)).toEqual([4, 6, 10]);
    expect(warnings.some((warning) => warning.includes('非法 token'))).toBe(true);
  });

  it('TextCode 缺省 X/Y 采用上一个 TextCode 的 X/Y，而不是 pen 终点', () => {
    const layout = layoutText(
      makeTextObject({
        codes: [
          makeTextCode({ text: 'AB', x: 10, y: 20, deltaX: [5, 5] }),
          makeTextCode({ text: 'C' }),
        ],
      }),
      faces,
    );
    expect(layout.units[0]).toMatchObject({ x: 10, y: 20 });
    expect(layout.units[2]).toMatchObject({ x: 10, y: 20 });
    // code2 从 (10,20) 重新开始，而不是接着上一段 pen 的 x=20。
    expect(layout.endX).toBe(20);
  });

  it('首个 TextCode 缺省起点为 (0,0)', () => {
    const layout = layoutText(makeTextObject({ codes: [makeTextCode({ text: 'A' })] }), faces);
    expect(layout.units[0]).toMatchObject({ x: 0, y: 0 });
  });
});