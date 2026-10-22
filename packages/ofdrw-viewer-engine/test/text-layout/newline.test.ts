/**
 * TextCode 换行过滤与 CGTransform/Delta 下标测试（z 样本 p2 修复）。
 *
 * OFD 生成器常在 TextCode 内容中带入 XML 美化换行；换行不属于可见字符，
 * 也不能占用 DeltaX 下标或触发 W_GLYPH_MISSING。
 */

import { describe, expect, it } from 'vitest';
import { layoutText } from '../../src/render/text';
import {
  createFakeFace,
  createFakeFaceSet,
  makeTextCode,
  makeTextObject,
} from './fake-font';

/** 构造 A/B 两个字形。 */
function createLatinFace() {
  return createFakeFace({
    glyphs: [
      { gid: 1, advanceWidth: 500, codePoints: [0x41] },
      { gid: 2, advanceWidth: 700, codePoints: [0x42] },
      { gid: 9, advanceWidth: 300 },
    ],
  });
}

describe('TextCode 换行过滤', () => {
  it('忽略 LF/CRLF，不产生缺字 warning，DeltaX 从第一个可见字符开始', () => {
    const face = createLatinFace();
    const warnings: string[] = [];
    const object = makeTextObject({
      size: 10,
      codes: [makeTextCode({ text: '\r\nAB', deltaX: [10, 20] })],
    });

    const layout = layoutText(object, createFakeFaceSet(face), {
      onWarning: (code) => warnings.push(code),
    });

    expect(warnings).toEqual([]);
    expect(layout.units).toHaveLength(2);
    expect(layout.units.map((unit) => unit.cpStart)).toEqual([0, 1]);
    expect(layout.units[0]?.x).toBe(0);
    expect(layout.units[1]?.x).toBe(10);
    expect(layout.endX).toBe(30);
  });

  it('CGTransform 的 CodePosition 按过滤后的可见字符计数', () => {
    const face = createLatinFace();
    const warnings: string[] = [];
    const object = makeTextObject({
      size: 10,
      codes: [
        makeTextCode({
          text: '\nAB',
          cgTransforms: [{ codePosition: 1, codeCount: 1, glyphCount: 1, glyphs: [9] }],
        }),
      ],
    });

    const layout = layoutText(object, createFakeFaceSet(face), {
      onWarning: (code) => warnings.push(code),
    });

    expect(warnings).toEqual([]);
    expect(layout.units).toHaveLength(2);
    expect(layout.units[0]?.glyphs[0]?.gid).toBe(1);
    // 过滤 LF 后 CodePosition=1 对应 B；未过滤时会错映射到 A。
    expect(layout.units[1]?.glyphs[0]?.gid).toBe(9);
  });

  it('只过滤 CR/LF，不删除普通空格', () => {
    const face = createLatinFace();
    const object = makeTextObject({
      size: 10,
      codes: [makeTextCode({ text: ' A', deltaX: [5, 7] })],
    });

    const layout = layoutText(object, createFakeFaceSet(face));
    expect(layout.units).toHaveLength(2);
    expect(layout.units[0]?.placements).toEqual([]);
    expect(layout.endX).toBe(12);
  });
});