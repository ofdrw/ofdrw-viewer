/**
 * ReadDirection / CharDirection / HScale / 合成斜体测试（设计方案 12.4/12.5/12.6、图 62–65）。
 */

import { describe, expect, it } from 'vitest';
import type { PathCommand } from '../../src/common/types';
import {
  SYNTHETIC_ITALIC_SKEW,
  buildTextPath,
  layoutText,
} from '../../src/render/text';
import {
  createFakeFace,
  createFakeFaceSet,
  makeTextCode,
  makeTextObject,
} from './fake-font';

/** 每字符 advance=1000、upem=1000，size=10 时单字步进 10。 */
function createAbFace() {
  return createFakeFace({
    unitsPerEm: 1000,
    glyphs: [
      { gid: 1, advanceWidth: 1000, codePoints: [0x41] },
      { gid: 2, advanceWidth: 1000, codePoints: [0x42] },
    ],
  });
}

/** 造一个字形轮廓为水平线段的字体（字体单位 y 向上）。 */
function createLineFace(options: { italic?: boolean } = {}) {
  return createFakeFace({
    unitsPerEm: 1000,
    italic: options.italic ?? false,
    glyphs: [
      {
        gid: 1,
        advanceWidth: 1000,
        codePoints: [0x41],
        path: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 1000, y: 0 },
          { type: 'closePath' },
        ],
      },
    ],
  });
}

/** 取路径中的 lineTo 坐标。 */
function lineTos(path: readonly PathCommand[]): { x: number; y: number }[] {
  return path
    .filter((command): command is Extract<PathCommand, { type: 'lineTo' }> => command.type === 'lineTo')
    .map((command) => ({ x: command.x, y: command.y }));
}

describe('ReadDirection', () => {
  const faces = createFakeFaceSet(createAbFace());

  it('0：向右推进，首个字符在 X/Y 原点', () => {
    const layout = layoutText(
      makeTextObject({ readDirection: 0, codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })] }),
      faces,
    );
    expect(layout.units.map((unit) => unit.x)).toEqual([0, 5]);
    expect(layout.units[0].placements[0]).toMatchObject({ x: 0, y: 0 });
    expect(layout.endX).toBe(10);
    expect(layout.endY).toBe(0);
  });

  it('90：向下推进，不反转字符数组', () => {
    const layout = layoutText(
      makeTextObject({ readDirection: 90, codes: [makeTextCode({ text: 'AB', deltaY: [5, 5] })] }),
      faces,
    );
    expect(layout.units.map((unit) => unit.cpStart)).toEqual([0, 1]);
    expect(layout.units.map((unit) => unit.y)).toEqual([0, 5]);
    expect(layout.units[0].placements[0]).toMatchObject({ x: 0, y: 0 });
    expect(layout.endY).toBe(10);
    expect(layout.endX).toBe(0);
  });

  it('180：向左推进，X/Y 仍是首个逻辑字符原点', () => {
    const layout = layoutText(
      makeTextObject({
        readDirection: 180,
        codes: [makeTextCode({ text: 'AB', x: 20, y: 30, deltaX: [5, 5] })],
      }),
      faces,
    );
    expect(layout.units.map((unit) => unit.x)).toEqual([20, 15]);
    expect(layout.units.map((unit) => unit.cpStart)).toEqual([0, 1]);
    expect(layout.endX).toBe(10);
    expect(layout.endY).toBe(30);
  });

  it('270：向上推进', () => {
    const layout = layoutText(
      makeTextObject({ readDirection: 270, codes: [makeTextCode({ text: 'AB', deltaY: [5, 5] })] }),
      faces,
    );
    expect(layout.units.map((unit) => unit.y)).toEqual([0, -5]);
    expect(layout.endY).toBe(-10);
  });

  it('ReadDirection=90 与 CharDirection=90 组合：向下推进且字形旋转', () => {
    const path = buildTextPath(
      makeTextObject({
        readDirection: 90,
        charDirection: 90,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaY: [10] })],
      }),
      createFakeFaceSet(createLineFace()),
    );
    expect(lineTos(path)[0].x).toBeCloseTo(0, 6);
    expect(lineTos(path)[0].y).toBeCloseTo(10, 6);
  });

  it('ReadDirection=180 与 CharDirection=180 组合：向左推进且字形旋转 180°', () => {
    const path = buildTextPath(
      makeTextObject({
        readDirection: 180,
        charDirection: 180,
        size: 10,
        codes: [makeTextCode({ text: 'A', x: 20, deltaX: [10] })],
      }),
      createFakeFaceSet(createLineFace()),
    );
    expect(lineTos(path)[0].x).toBeCloseTo(10, 6);
    expect(lineTos(path)[0].y).toBeCloseTo(0, 6);
  });

  it('非法 CharDirection 回退 0 并 warning', () => {
    const warnings: string[] = [];
    const path = buildTextPath(
      makeTextObject({
        charDirection: 45 as unknown as 0,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [10] })],
      }),
      createFakeFaceSet(createLineFace()),
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(lineTos(path)[0].x).toBeCloseTo(10, 6);
    expect(warnings.some((warning) => warning.includes('CharDirection'))).toBe(true);
  });

  it('非法方向回退 0 并 warning', () => {
    const warnings: string[] = [];
    const layout = layoutText(
      makeTextObject({
        readDirection: 45 as unknown as 0,
        codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })],
      }),
      faces,
      { onWarning: (code, message) => warnings.push(`${code}:${message}`) },
    );
    expect(layout.endX).toBe(10);
    expect(warnings.some((warning) => warning.includes('ReadDirection'))).toBe(true);
  });
});

describe('CharDirection', () => {
  const face = createLineFace();

  it.each([
    [0, 10, 0],
    [90, 0, 10],
    [180, -10, 0],
    [270, 0, -10],
  ] as const)('CharDirection=%s 只旋转字形', (direction, expectedX, expectedY) => {
    const path = buildTextPath(
      makeTextObject({
        charDirection: direction,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [10] })],
      }),
      createFakeFaceSet(face),
    );
    const [line] = lineTos(path);
    expect(line.x).toBeCloseTo(expectedX, 6);
    expect(line.y).toBeCloseTo(expectedY, 6);
  });

  it('字形绕当前绘制点旋转（pen 参与平移）', () => {
    const path = buildTextPath(
      makeTextObject({
        charDirection: 90,
        size: 10,
        codes: [makeTextCode({ text: 'A', x: 3, y: 4, deltaX: [10] })],
      }),
      createFakeFaceSet(face),
    );
    expect(lineTos(path)[0].x).toBeCloseTo(3, 6);
    expect(lineTos(path)[0].y).toBeCloseTo(14, 6);
  });

  it('ReadDirection=180 不旋转字形，只改变 pen 方向', () => {
    const abLineFace = createFakeFace({
      unitsPerEm: 1000,
      glyphs: [
        {
          gid: 1,
          advanceWidth: 1000,
          codePoints: [0x41],
          path: [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 1000, y: 0 },
            { type: 'closePath' },
          ],
        },
        {
          gid: 2,
          advanceWidth: 1000,
          codePoints: [0x42],
          path: [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 1000, y: 0 },
            { type: 'closePath' },
          ],
        },
      ],
    });
    const path = buildTextPath(
      makeTextObject({
        readDirection: 180,
        charDirection: 0,
        codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })],
      }),
      createFakeFaceSet(abLineFace),
    );
    const lines = lineTos(path);
    // 第一个字形在 x=0，第二个字形在 x=-5；字形本身仍朝 +X，不反转。
    expect(lines[0].x).toBeCloseTo(10, 6);
    expect(lines[1].x).toBeCloseTo(5, 6);
  });
});

describe('HScale', () => {
  it('只缩放字形 x，不改变 DeltaX 步进', () => {
    const glyphFace = createFakeFace({
      unitsPerEm: 1000,
      glyphs: [
        {
          gid: 1,
          advanceWidth: 1000,
          codePoints: [0x41],
          path: [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 1000, y: 0 },
            { type: 'closePath' },
          ],
        },
      ],
    });
    const path = buildTextPath(
      makeTextObject({
        hScale: 2,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [5] })],
      }),
      createFakeFaceSet(glyphFace),
    );
    expect(lineTos(path)[0].x).toBeCloseTo(20, 6);

    const layout = layoutText(
      makeTextObject({
        hScale: 2,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [5] })],
      }),
      createFakeFaceSet(glyphFace),
    );
    expect(layout.endX).toBe(5);
  });

  it('缺少 Delta 时 advance 也乘以 HScale', () => {
    const face = createLineFace();
    const layout = layoutText(
      makeTextObject({ hScale: 2, size: 10, codes: [makeTextCode({ text: 'A' })] }),
      createFakeFaceSet(face),
    );
    // advance 1000 × size 10 / upem 1000 × HScale 2 = 20
    expect(layout.endX).toBe(20);
  });
});

describe('合成斜体', () => {
  it('字面斜体字体不再叠加剪切', () => {
    const path = buildTextPath(
      makeTextObject({
        italic: true,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [10] })],
      }),
      createFakeFaceSet(createLineFace({ italic: true })),
    );
    expect(lineTos(path)[0].x).toBeCloseTo(1000 * (10 / 1000), 6);
  });

  it('非斜体字体在 italic=true 时按 tan(12°) 剪切，顶部右倾', () => {
    const face = createFakeFace({
      unitsPerEm: 1000,
      italic: false,
      glyphs: [
        {
          gid: 1,
          advanceWidth: 1000,
          codePoints: [0x41],
          path: [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 0, y: 1000 },
            { type: 'closePath' },
          ],
        },
      ],
    });
    const path = buildTextPath(
      makeTextObject({
        italic: true,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [10] })],
      }),
      createFakeFaceSet(face),
    );
    const [line] = lineTos(path);
    // 字体坐标 y=1000 → 对象坐标 y=-10；剪切后 x = tan(12°) × 10。
    expect(line.x).toBeCloseTo(SYNTHETIC_ITALIC_SKEW * 10, 6);
    expect(line.y).toBeCloseTo(-10, 6);
  });

  it('syntheticItalic=false 可关闭剪切', () => {
    const face = createFakeFace({
      unitsPerEm: 1000,
      glyphs: [
        {
          gid: 1,
          advanceWidth: 1000,
          codePoints: [0x41],
          path: [
            { type: 'moveTo', x: 0, y: 0 },
            { type: 'lineTo', x: 0, y: 1000 },
            { type: 'closePath' },
          ],
        },
      ],
    });
    const path = buildTextPath(
      makeTextObject({
        italic: true,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [10] })],
      }),
      createFakeFaceSet(face),
      { syntheticItalic: false },
    );
    expect(lineTos(path)[0].x).toBeCloseTo(0, 6);
  });

  it('合成粗体不改变 Delta 推进', () => {
    const faces = createFakeFaceSet(createLineFace());
    const normal = layoutText(
      makeTextObject({ size: 10, codes: [makeTextCode({ text: 'A', deltaX: [5] })] }),
      faces,
    );
    const bold = layoutText(
      makeTextObject({
        weight: 700,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [5] })],
      }),
      faces,
    );
    expect(bold.endX).toBe(normal.endX);
  });

  it('合成斜体不改变 Delta 推进', () => {
    const faces = createFakeFaceSet(createLineFace());
    const normal = layoutText(
      makeTextObject({ size: 10, codes: [makeTextCode({ text: 'A', deltaX: [5] })] }),
      faces,
    );
    const italic = layoutText(
      makeTextObject({
        italic: true,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [5] })],
      }),
      faces,
    );
    expect(italic.endX).toBe(normal.endX);
  });
});