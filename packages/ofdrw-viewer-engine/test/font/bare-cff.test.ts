/**
 * 裸 CFF 内嵌字体回归测试。
 *
 * `1_dfd.ofd` 内嵌的 `font_N.otf` 是 OFD 常见但非标准的形态：扩展名为 `.otf`，
 * 内容却是 4 字节私有头 + 裸 CFF（无 sfnt 表目录，无 cmap/head/hmtx 等表）。
 * 本用例锁定字体层对这类字节的解析结果与字形轮廓；样本来源与提取方式见
 * `test/font/fixtures/README.md`。
 *
 * 期望值由 fontTools 独立解析同一份字节得出，不依赖系统字体。
 *
 * 除 `1_dfd` 自身的样本外，另覆盖一份来自 `intro-数科.ofd` 的 CID 裸 CFF
 * （`FXBMIR+HiraginoSansGB-W6`）：它带 2 个 FontDict 与 Supplement=4 的 ROS，
 * 补上单 FontDict 样本覆盖不到的分支。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFDError } from '../../src/errors';
import type { PathCommand } from '../../src/common/types';
import { createFontFace } from '../../src/font/face';
import type { Glyph } from '../../src/font/types';
import { ensureFixtures } from './fixtures';

/** fixture 目录。 */
const FIXTURE_DIR = new URL('./fixtures/', import.meta.url);

/** 由 `fixtures.ts` 在运行时从真实 OFD 解出的字体路径。 */
const sharedFixtures = ensureFixtures();

/**
 * 读取 fixture 字体字节。
 *
 * @param name fixture 文件名。
 * @returns 字体字节。
 */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(name, FIXTURE_DIR))));
}

/**
 * 读取由 `fixtures.ts` 解出的字体字节。
 *
 * @param path fixture 绝对路径；来源缺失时为 null。
 * @returns 字体字节；缺失时返回空数组（调用方须先检查路径）。
 */
function readFixtureFrom(path: string | null): Uint8Array {
  return new Uint8Array(readFileSync(path as string));
}

/** 收集轮廓中的指定命令。 */
function commandsOfType<K extends PathCommand['type']>(
  glyph: Glyph,
  type: K,
): Extract<PathCommand, { type: K }>[] {
  return glyph.path.filter(
    (command): command is Extract<PathCommand, { type: K }> => command.type === type,
  );
}

/** 轮廓坐标包围盒（字体单位）。 */
function boundsOf(path: readonly PathCommand[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const command of path) {
    if (command.type === 'moveTo' || command.type === 'lineTo') {
      xs.push(command.x);
      ys.push(command.y);
    }
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe('裸 CFF 内嵌字体：解析', () => {
  it('font_5：288B 最小样本解析成功且 metrics 正确', () => {
    const face = createFontFace(readFixture('dfd-font-5.otf'), { authoritative: true });

    // .notdef + G21 + G22 + G23，共 4 个字形槽位。
    expect(face.numGlyphs).toBe(4);
    // CFF FontMatrix 为 0.001，换算后每 em 1000 单位。
    expect(face.unitsPerEm).toBe(1000);
    // 裸 CFF 没有 cmap 表，只能走显式 gid。
    expect(face.hasCmap).toBe(false);
    expect(face.explicitGlyphs).toBe(true);
    // 没有 name 表时 family 回退到调用方给出的名称。
    expect(face.glyphForCodePoint(0x4e09)).toBeNull();
  });

  it('font_4：13KB 多字形样本解析成功', () => {
    const face = createFontFace(readFixture('dfd-font-4.otf'), { authoritative: true });

    expect(face.numGlyphs).toBe(31);
    expect(face.unitsPerEm).toBe(1000);
    expect(face.hasCmap).toBe(false);
    expect(face.explicitGlyphs).toBe(true);
  });

  it('font_1：CID 裸 CFF 解析成功', () => {
    const face = createFontFace(readFixture('dfd-font-1.otf'), { authoritative: true });

    expect(face.numGlyphs).toBe(2);
    expect(face.unitsPerEm).toBe(1000);
    expect(face.glyph(1)?.path.length).toBe(46);
  });

  it('显式 gid 可信任，替代字体场景下不信任', () => {
    const bytes = readFixture('dfd-font-5.otf');

    expect(createFontFace(bytes, { authoritative: true }).explicitGlyphs).toBe(true);
    expect(createFontFace(bytes, { substitute: true }).explicitGlyphs).toBe(false);
  });
});

describe('裸 CFF 内嵌字体：字形', () => {
  it('font_5 的 glyph(1)/G21 是"三"的三条横画矩形轮廓', () => {
    const face = createFontFace(readFixture('dfd-font-5.otf'), { authoritative: true });
    const glyph = face.glyph(1);

    expect(glyph).not.toBeNull();
    expect(glyph?.id).toBe(1);
    expect(glyph?.advanceWidth).toBe(1000);
    // 两个矩形框：moveTo → 4×lineTo → closePath。
    expect(commandsOfType(glyph as Glyph, 'moveTo')).toHaveLength(2);
    expect(commandsOfType(glyph as Glyph, 'lineTo')).toHaveLength(8);
    expect(commandsOfType(glyph as Glyph, 'closePath')).toHaveLength(2);
    expect(glyph?.path.some((command) => command.type === 'bezierCurveTo')).toBe(false);

    const bounds = boundsOf((glyph as Glyph).path);
    expect(bounds).toEqual({ minX: 0, maxX: 996, minY: 271, maxY: 831 });

    // 第一横（上部矩形）：(0,831)→(0,571)→(996,571)→(996,831)→(0,831)；
    // 第二横（下部矩形）：(0,334)→(0,271)→(996,271)→(996,334)→(0,334)。
    const moves = commandsOfType(glyph as Glyph, 'moveTo');
    expect(moves[0]).toEqual({ type: 'moveTo', x: 0, y: 831 });
    expect(moves[1]).toEqual({ type: 'moveTo', x: 0, y: 334 });
    const lines = commandsOfType(glyph as Glyph, 'lineTo');
    expect(lines.map((line) => [line.x, line.y])).toEqual([
      [0, 571],
      [996, 571],
      [996, 831],
      [0, 831],
      [0, 271],
      [996, 271],
      [996, 334],
      [0, 334],
    ]);
  });

  it('font_5 全部字形可枚举，空字形返回空轮廓而不是 null', () => {
    const face = createFontFace(readFixture('dfd-font-5.otf'), { authoritative: true });
    const lengths: number[] = [];
    for (let gid = 0; gid < face.numGlyphs; gid += 1) {
      const glyph = face.glyph(gid);
      expect(glyph).not.toBeNull();
      expect(glyph?.id).toBe(gid);
      lengths.push((glyph as Glyph).path.length);
    }
    // .notdef 与 G23 无轮廓，G21/G22 各 12 条命令。
    expect(lengths).toEqual([0, 12, 12, 0]);
    // 越界 gid 返回 null。
    expect(face.glyph(face.numGlyphs)).toBeNull();
    expect(face.glyph(-1)).toBeNull();
  });

  it('font_4 的 glyph(1)/G21 曲线命令与源字形一致', () => {
    const face = createFontFace(readFixture('dfd-font-4.otf'), { authoritative: true });
    const glyph = face.glyph(1) as Glyph;

    // fontTools: 2 moveTo + 14 lineTo + 29 curveTo + 2 closePath。
    expect(glyph.path.length).toBe(47);
    expect(commandsOfType(glyph, 'moveTo')).toHaveLength(2);
    expect(commandsOfType(glyph, 'lineTo')).toHaveLength(14);
    expect(commandsOfType(glyph, 'bezierCurveTo')).toHaveLength(29);
    expect(commandsOfType(glyph, 'closePath')).toHaveLength(2);

    // 首个矩形笔画与第一条曲线段的精确坐标（字体单位，y 向上）。
    expect(glyph.path.slice(0, 6)).toEqual([
      { type: 'moveTo', x: 386, y: 360 },
      { type: 'lineTo', x: 738, y: 360 },
      { type: 'lineTo', x: 738, y: 16 },
      { type: 'lineTo', x: 386, y: 16 },
      { type: 'lineTo', x: 386, y: 360 },
      { type: 'closePath' },
    ]);
    expect(glyph.path[7]).toEqual({ type: 'lineTo', x: 957, y: 695 });
    expect(glyph.path[8]).toEqual({
      type: 'bezierCurveTo',
      cp1x: 969,
      cp1y: 697,
      cp2x: 972,
      cp2y: 704,
      x: 964,
      y: 715,
    });
    // 端点包围盒（只计 moveTo/lineTo 端点，不含曲线控制点）。
    expect(boundsOf(glyph.path)).toEqual({ minX: 93, maxX: 957, minY: -82, maxY: 715 });
  });
});

describe('裸 CFF 内嵌字体：多 FontDict 的 CID 字体', () => {
  // 来源 `ofd_pdf_match/intro-数科.ofd` 的 `Doc_0/Res/font_85_85.ttf`。
  // 与 font_1 的区别：FDArray 有 2 个 FontDict（gid0 走 FD0、gid1..13 走 FD1），
  // 且 ROS Supplement=4（font_1 为 0）。
  const load = (): Uint8Array => readFixtureFrom(sharedFixtures.broken);

  it.skipIf(!sharedFixtures.broken)('解析出 14 个字形并给出正确度量', () => {
    const face = createFontFace(load(), { authoritative: true });

    expect(face.numGlyphs).toBe(14);
    expect(face.unitsPerEm).toBe(1000);
    expect(face.hasCmap).toBe(false);
    expect(face.explicitGlyphs).toBe(true);
  });

  it.skipIf(!sharedFixtures.broken)('逐字形轮廓命令数与源字体一致', () => {
    const face = createFontFace(load(), { authoritative: true });
    const lengths: number[] = [];
    for (let gid = 0; gid < face.numGlyphs; gid += 1) {
      lengths.push((face.glyph(gid) as Glyph).path.length);
    }
    // fontTools 逐字形命令数，覆盖 FD0（.notdef）与 FD1（其余 13 个）。
    expect(lengths).toEqual([21, 80, 38, 60, 32, 40, 116, 51, 62, 97, 58, 62, 92, 30]);
    expect(face.glyph(face.numGlyphs)).toBeNull();
  });
});

describe('裸 CFF 内嵌字体：退化输入', () => {
  const bytes = readFixture('dfd-font-5.otf');

  it.each([
    ['截断到 8 字节', bytes.subarray(0, 8)],
    ['空字节', new Uint8Array(0)],
    ['随机垃圾', new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03])],
  ])('%s 仍抛 OFD_FONT_PARSE', (_label, data) => {
    expect(() => createFontFace(data, { authoritative: true })).toThrow(OFDError);
    expect(() => createFontFace(data, { authoritative: true })).toThrow(
      expect.objectContaining({ code: 'OFD_FONT_PARSE' }),
    );
  });
});
