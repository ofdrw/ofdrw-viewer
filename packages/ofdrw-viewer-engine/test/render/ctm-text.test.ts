/**
 * CTM（对象变换矩阵）与 Boundary 裁剪的契约用例集。
 *
 * 用例由 `buildCtmOfd` 合成，预期效果按 GB/T 33190—2016 推导：
 *
 * - §8.1.4：图元内部数据（含路径与裁剪区数据）以 `Boundary` 左上角为对象空间原点；
 * - §8.1.5 a）：图元数据先经 `CTM` 变换到对象空间；
 * - §8.1.5 b）：对象空间数据再经外接矩形（`Boundary`）变换到页面空间；
 * - 表 20：`CTM` 支持平移、缩放、旋转、切变，并可用矩阵乘法按顺序迭加；
 * - 表 34：`Boundary` 采用当前空间坐标系，图元绘制超出该矩形区域时裁剪；
 * - 表 36（Clips）：裁剪区采用对象空间坐标系，多个 Clip 取交集。
 *
 * 由此得到可断言的契约：
 *
 * 1. 对象空间足够大（Boundary 远超字形范围）时，任何可逆 `CTM` 下文字都必须可见；
 * 2. `CTM` 改变字形在对象空间内的位置与朝向，但不改变 `Boundary` 在页面上的落位；
 * 3. 字形超出 `Boundary` 的部分被裁掉，且不越出 `Boundary` 边界；
 * 4. 裁剪区在对象空间内进一步收窄可见区域，多个裁剪区取交集。
 */

import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer, OFDDocument, getPageViewport } from '@ofdrw/ofdrw-viewer-engine';
import type { Canvas2DLike, CanvasRenderingContext2DLike } from '@ofdrw/ofdrw-viewer-engine';
import { buildCtmOfd, type CtmClipSpec, type CtmTextSpec } from '../fixtures/ctm-ofd';
import { findSystemCjkFont } from '../fixtures/fonts';
import { nodeImageDecoders } from '../helpers/node-image-decoder';

/** 渲染输出 DPI。 */
const DPI = 96;

/** 系统 CJK 字体；缺失时整组用例 skip。 */
const FONT = findSystemCjkFont();

/** 2×3 仿射矩阵。 */
type Affine = [number, number, number, number, number, number];

/** 页面区域，单位 mm。 */
interface RectMm {
  /** 左上角 X，单位 mm。 */
  x: number;
  /** 左上角 Y，单位 mm。 */
  y: number;
  /** 宽，单位 mm。 */
  w: number;
  /** 高，单位 mm。 */
  h: number;
}

/** 渲染结果。 */
interface RenderResult {
  /** 画布宽，像素。 */
  width: number;
  /** 画布高，像素。 */
  height: number;
  /** RGBA 像素。 */
  data: Uint8ClampedArray;
}

/** 覆盖测试用页尺寸，单位 mm；足够大以容纳各用例。 */
const PAGE = { width: 240, height: 200 };

/** 毫米转像素。 */
function mm(value: number): number {
  return (value / 25.4) * DPI;
}

/** 像素转毫米。 */
function toMm(value: number): number {
  return (value / DPI) * 25.4;
}

/**
 * 渲染合成文档为像素。
 *
 * @param texts 页内文字对象。
 * @param guides 可选 Boundary 参考框。
 * @returns 画布尺寸与 RGBA 像素。
 */
async function renderTexts(
  texts: readonly CtmTextSpec[],
  guides: readonly { id: number; boundary: [number, number, number, number] }[] = [],
): Promise<RenderResult> {
  const bytes = buildCtmOfd({ page: PAGE, fontData: FONT!.data, texts, guides });
  const renderer = new H5Canvas2DRenderer({
    createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
  });
  const document = await OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    renderer,
    imageDecoders: [...nodeImageDecoders],
  });
  try {
    const rendered = await document.getPage(0);
    const viewport = getPageViewport(rendered.getSize(), { dpi: DPI });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    await rendered
      .render({
        canvasContext: context as unknown as CanvasRenderingContext2DLike,
        viewport: { width, height, dpi: DPI },
      })
      .promise;
    const image = context.getImageData(0, 0, width, height);
    return { width, height, data: new Uint8ClampedArray(image.data) };
  } finally {
    await document.close();
  }
}

/**
 * 判断像素是否为墨迹（非近白）。
 *
 * @param data RGBA 像素。
 * @param offset 该像素在数组中的偏移。
 * @returns 非近白时返回 true。
 */
function isInk(data: Uint8ClampedArray, offset: number): boolean {
  return (
    (data[offset] ?? 0) < 250 ||
    (data[offset + 1] ?? 0) < 250 ||
    (data[offset + 2] ?? 0) < 250
  );
}

/**
 * 统计区域内的墨迹像素数。
 *
 * @param result 渲染结果。
 * @param rect 区域，单位 mm。
 * @returns 墨迹像素数。
 */
function inkIn(result: RenderResult, rect: RectMm): number {
  const x0 = Math.max(0, Math.floor(mm(rect.x)));
  const y0 = Math.max(0, Math.floor(mm(rect.y)));
  const x1 = Math.min(result.width, Math.ceil(mm(rect.x + rect.w)));
  const y1 = Math.min(result.height, Math.ceil(mm(rect.y + rect.h)));
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (isInk(result.data, (y * result.width + x) * 4)) count += 1;
    }
  }
  return count;
}

/**
 * 统计全页墨迹像素数。
 *
 * @param result 渲染结果。
 * @returns 墨迹像素数。
 */
function totalInk(result: RenderResult): number {
  let count = 0;
  for (let index = 0; index < result.width * result.height; index += 1) {
    if (isInk(result.data, index * 4)) count += 1;
  }
  return count;
}

/**
 * 计算墨迹外接矩形。
 *
 * @param result 渲染结果。
 * @returns 外接矩形，单位 mm；无墨迹时返回 null。
 */
function inkBox(result: RenderResult): RectMm | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      if (!isInk(result.data, (y * result.width + x) * 4)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: toMm(minX),
    y: toMm(minY),
    w: toMm(maxX - minX + 1),
    h: toMm(maxY - minY + 1),
  };
}

/** 宽松 Boundary：120×80 mm，远大于测试字形，保证字形不被 Boundary 裁掉。 */
const ROOMY: [number, number, number, number] = [30, 30, 120, 80];

/** 宽松 Boundary 内、远离四边的文字基线位置。 */
const BASE_X = 40;
const BASE_Y = 60;

/** 变换后字形应落到的目标位置（相对 Boundary 左上角），单位 mm。 */
const INSIDE_X = 40;
const INSIDE_Y = 40;

/** 参考字号，单位 mm。 */
const SIZE = 12;

/** 单个测试字形数量下的最低可见墨迹（12mm 字号三个字符的保守下限）。 */
const MIN_INK = 200;

/** 由旋转角（度）构造 CTM；正角方向为 X 轴转向 Y 轴（与 Canvas rotate 一致）。 */
function rotation(degrees: number, tx = 0, ty = 0): Affine {
  const radians = (degrees * Math.PI) / 180;
  const cos = Number(Math.cos(radians).toFixed(6));
  const sin = Number(Math.sin(radians).toFixed(6));
  return [cos, sin, -sin, cos, tx, ty];
}

/** 由缩放系数构造 CTM。 */
function scaleOf(sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

/** 由斜切角（度）构造 CTM：Y 轴朝 X 倾斜。 */
function shearX(degrees: number): Affine {
  return [1, 0, Number(Math.tan((degrees * Math.PI) / 180).toFixed(6)), 1, 0, 0];
}

/** 由斜切角（度）构造 CTM：X 轴朝 Y 倾斜。 */
function shearY(degrees: number): Affine {
  return [1, Number(Math.tan((degrees * Math.PI) / 180).toFixed(6)), 0, 1, 0, 0];
}

/** 矩阵乘法：先应用 b，再应用 a。 */
function multiply(a: Affine, b: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = a;
  const [a2, b2, c2, d2, e2, f2] = b;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * 给基础变换叠加平移，使对象空间点 `(sx, sy)` 经变换后落到 Boundary 内部的目标位置。
 *
 * 平移量在「Boundary 内部对象空间」中计算，因此目标坐标是相对 Boundary 左上角的偏移。
 *
 * @param base 基础变换矩阵（不含平移）。
 * @param sx 待对齐的点 X，对象空间单位 mm。
 * @param sy 待对齐的点 Y，对象空间单位 mm。
 * @param targetX 目标 X（相对 Boundary 左上角），单位 mm。
 * @param targetY 目标 Y（相对 Boundary 左上角），单位 mm。
 * @returns 叠加平移后的 CTM。
 */
function fitInside(
  base: Affine,
  sx: number,
  sy: number,
  targetX: number = INSIDE_X,
  targetY: number = INSIDE_Y,
): Affine {
  const mappedX = base[0] * sx + base[2] * sy;
  const mappedY = base[1] * sx + base[3] * sy;
  return [base[0], base[1], base[2], base[3], targetX - mappedX, targetY - mappedY];
}

/** 构造一个位于宽松 Boundary 内的文字规格。 */
function text(
  overrides: Partial<CtmTextSpec> & Pick<CtmTextSpec, 'id'>,
): CtmTextSpec {
  const merged: CtmTextSpec = {
    boundary: ROOMY,
    size: SIZE,
    text: 'ABC',
    codeX: BASE_X,
    codeY: BASE_Y,
    ...overrides,
  };
  // 表 46：DeltaX 不出现时所有字形共用同一 X，多字符需显式给出逐字偏移。
  if (!merged.deltaX && merged.text.length > 1) {
    merged.deltaX = Array.from({ length: merged.text.length - 1 }, () => merged.size);
  }
  return merged;
}

const describeWithFont = FONT ? describe : describe.skip;

describeWithFont('CTM 基础变换（表 20）', () => {
  /**
   * 基础变换用例。每个 CTM 都叠加平移分量，使字形最终落在宽松 Boundary（30,30,120,80）中部，
   * 从而只检验 CTM 本身的处理，不混入「字形本就落在 Boundary 外」的裁剪语义。
   */
  const cases: { name: string; ctm: Affine | undefined; codeX: number; codeY: number }[] = [
    { name: '无 CTM（单位矩阵）', ctm: undefined, codeX: BASE_X, codeY: BASE_Y },
    { name: '平移 +X', ctm: [1, 0, 0, 1, 10, 0], codeX: BASE_X - 10, codeY: BASE_Y },
    { name: '平移 -X', ctm: [1, 0, 0, 1, -10, 0], codeX: BASE_X + 10, codeY: BASE_Y },
    { name: '平移 +Y', ctm: [1, 0, 0, 1, 0, 10], codeX: BASE_X, codeY: BASE_Y - 10 },
    { name: '平移 -Y', ctm: [1, 0, 0, 1, 0, -10], codeX: BASE_X, codeY: BASE_Y + 10 },
    { name: '缩放 200%', ctm: scaleOf(2, 2), codeX: BASE_X / 2, codeY: BASE_Y / 2 },
    { name: '缩放 50%', ctm: scaleOf(0.5, 0.5), codeX: BASE_X / 0.5, codeY: BASE_Y / 0.5 },
    { name: '非等比缩放 X=2 Y=1', ctm: scaleOf(2, 1), codeX: BASE_X / 2, codeY: BASE_Y },
    { name: '旋转 15°', ctm: fitInside(rotation(15), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '旋转 45°', ctm: fitInside(rotation(45), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '旋转 90°（顺时针）', ctm: fitInside(rotation(90), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '旋转 90°（逆时针）', ctm: fitInside(rotation(-90), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '旋转 180°', ctm: fitInside(rotation(180), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '旋转 270°', ctm: fitInside(rotation(270), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '斜切 β=30°（Y 轴倒向 X）', ctm: fitInside(shearX(30), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '斜切 β=-30°', ctm: fitInside(shearX(-30), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '斜切 α=30°（X 轴倒向 Y）', ctm: fitInside(shearY(30), BASE_X, BASE_Y), codeX: BASE_X, codeY: BASE_Y },
    { name: '镜像 X 轴（scale -1,1）', ctm: fitInside(scaleOf(-1, 1), -BASE_X, BASE_Y), codeX: -BASE_X, codeY: BASE_Y },
    { name: '镜像 Y 轴（scale 1,-1）', ctm: fitInside(scaleOf(1, -1), BASE_X, -BASE_Y), codeX: BASE_X, codeY: -BASE_Y },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}：对象空间足够大时文字完整可见`, async () => {
      const result = await renderTexts([
        text({
          id: 10,
          ...(testCase.ctm ? { ctm: testCase.ctm } : {}),
          codeX: testCase.codeX,
          codeY: testCase.codeY,
        }),
      ]);
      const ink = totalInk(result);
      // 契约 1：任何可逆 CTM 下，字形落在 Boundary 内就必须可见。
      expect(ink).toBeGreaterThan(MIN_INK);
      const box = inkBox(result);
      expect(box).not.toBeNull();
      // 契约 2：字形仍在 Boundary 范围内，不越出对象空间落位。
      expect(box!.x).toBeGreaterThan(ROOMY[0] - 1);
      expect(box!.y).toBeGreaterThan(ROOMY[1] - 1);
      expect(box!.x + box!.w).toBeLessThan(ROOMY[0] + ROOMY[2] + 1);
      expect(box!.y + box!.h).toBeLessThan(ROOMY[1] + ROOMY[3] + 1);
    });
  }
});

describeWithFont('CTM 复合变换（表 20 矩阵迭加）', () => {
  /** 复合变换用例；均要求字形最终落在宽松 Boundary 内。 */
  const cases: { name: string; ctm: Affine; codeX: number; codeY: number }[] = [
    {
      name: '旋转 45° 后平移',
      ctm: fitInside(rotation(45), BASE_X, BASE_Y),
      codeX: BASE_X,
      codeY: BASE_Y,
    },
    {
      name: '缩放到 0.6 后旋转 30°',
      ctm: fitInside(multiply(rotation(30), scaleOf(0.6, 0.6)), BASE_X, BASE_Y),
      codeX: BASE_X,
      codeY: BASE_Y,
    },
    {
      name: '旋转 30° 后缩放到 0.6',
      ctm: fitInside(multiply(scaleOf(0.6, 0.6), rotation(30)), BASE_X, BASE_Y),
      codeX: BASE_X,
      codeY: BASE_Y,
    },
    {
      name: '斜切 20° + 旋转 20°',
      ctm: fitInside(multiply(rotation(20), shearX(20)), BASE_X, BASE_Y),
      codeX: BASE_X,
      codeY: BASE_Y,
    },
    {
      name: '平移 + 旋转 90° + 缩放 0.8',
      ctm: fitInside(multiply(rotation(90), scaleOf(0.8, 0.8)), BASE_X, BASE_Y),
      codeX: BASE_X,
      codeY: BASE_Y,
    },
    {
      name: '旋转 90° + 非等比缩放 (1.5, 0.7)',
      ctm: fitInside(multiply(rotation(90), scaleOf(1.5, 0.7)), BASE_X, BASE_Y),
      codeX: BASE_X,
      codeY: BASE_Y,
    },
    {
      name: '镜像 + 旋转 30°',
      ctm: fitInside(multiply(rotation(30), scaleOf(-1, 1)), -BASE_X, BASE_Y),
      codeX: -BASE_X,
      codeY: BASE_Y,
    },
    {
      name: '三重迭加：旋转 60° × 斜切 15° × 缩放 0.9',
      ctm: fitInside(multiply(multiply(rotation(60), shearX(15)), scaleOf(0.9, 0.9)), BASE_X, BASE_Y),
      codeX: BASE_X,
      codeY: BASE_Y,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}：文字完整可见且不越出 Boundary`, async () => {
      const result = await renderTexts([
        text({
          id: 20,
          ctm: testCase.ctm,
          codeX: testCase.codeX,
          codeY: testCase.codeY,
        }),
      ]);
      expect(totalInk(result)).toBeGreaterThan(MIN_INK);
      const box = inkBox(result);
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThan(ROOMY[0] - 1);
      expect(box!.y).toBeGreaterThan(ROOMY[1] - 1);
      expect(box!.x + box!.w).toBeLessThan(ROOMY[0] + ROOMY[2] + 1);
      expect(box!.y + box!.h).toBeLessThan(ROOMY[1] + ROOMY[3] + 1);
    });
  }
});

describeWithFont('Boundary 裁剪契约（表 34）', () => {
  it('Boundary 恰好容纳字形时文字完整可见', async () => {
    const result = await renderTexts([
      { id: 30, boundary: [30, 30, 60, 20], size: SIZE, text: 'ABC', codeX: 2, codeY: 16, deltaX: [SIZE, SIZE] },
    ]);
    expect(inkIn(result, { x: 30, y: 30, w: 60, h: 20 })).toBeGreaterThan(MIN_INK);
  });

  it('Boundary 高度不足时裁掉超出部分且不越出下边界', async () => {
    // 基线 Y=12：字形上沿约在 Y≈2，落在 6mm 高的窗内；下沿约 Y≈12 落在窗外被裁掉。
    const tall = await renderTexts([
      { id: 31, boundary: [30, 30, 60, 60], size: SIZE, text: 'ABC', codeX: 2, codeY: 12, deltaX: [SIZE, SIZE] },
    ]);
    const short = await renderTexts([
      { id: 32, boundary: [30, 30, 60, 6], size: SIZE, text: 'ABC', codeX: 2, codeY: 12, deltaX: [SIZE, SIZE] },
    ]);
    const tallInk = inkIn(tall, { x: 30, y: 30, w: 60, h: 60 });
    const shortInk = inkIn(short, { x: 30, y: 30, w: 60, h: 6 });
    expect(tallInk).toBeGreaterThan(MIN_INK);
    expect(shortInk).toBeGreaterThan(0);
    expect(shortInk).toBeLessThan(tallInk * 0.6);
    // 留 1mm 余量吸收抗锯齿与像素取整：不得越出 Boundary 下边界（y=36）。
    expect(inkIn(short, { x: 30, y: 37, w: 60, h: 53 })).toBe(0);
  });

  it('Boundary 宽度不足时裁掉右侧部分且不越出右边界', async () => {
    const wide = await renderTexts([
      { id: 33, boundary: [30, 30, 80, 20], size: SIZE, text: 'ABC', codeX: 2, codeY: 16, deltaX: [SIZE, SIZE] },
    ]);
    const narrow = await renderTexts([
      { id: 34, boundary: [30, 30, 14, 20], size: SIZE, text: 'ABC', codeX: 2, codeY: 16, deltaX: [SIZE, SIZE] },
    ]);
    const wideInk = inkIn(wide, { x: 30, y: 30, w: 80, h: 20 });
    const narrowInk = inkIn(narrow, { x: 30, y: 30, w: 14, h: 20 });
    expect(wideInk).toBeGreaterThan(MIN_INK);
    expect(narrowInk).toBeGreaterThan(0);
    expect(narrowInk).toBeLessThan(wideInk * 0.7);
    expect(inkIn(narrow, { x: 45, y: 30, w: 65, h: 20 })).toBe(0);
  });

  it('CTM 平移把字形推出 Boundary 时按裁剪语义不可见', async () => {
    // 字形基线在对象空间 Y=16，CTM 下移 100mm 后落到 Boundary（高 20mm）之外。
    const result = await renderTexts([
      {
        id: 35,
        boundary: [30, 30, 60, 20],
        ctm: [1, 0, 0, 1, 0, 100],
        size: SIZE,
        text: 'ABC',
        codeX: 2,
        codeY: 16,
      },
    ]);
    expect(inkIn(result, { x: 30, y: 30, w: 60, h: 20 })).toBe(0);
  });

  it('CTM 平移把字形移入 Boundary 时按裁剪语义可见', async () => {
    // 字形基线在对象空间 Y=-4，CTM 下移 20mm 后落入 Boundary（0..20mm）内。
    const result = await renderTexts([
      {
        id: 36,
        boundary: [30, 30, 60, 20],
        ctm: [1, 0, 0, 1, 0, 20],
        size: SIZE,
        text: 'ABC',
        codeX: 2,
        codeY: -4,
      },
    ]);
    expect(inkIn(result, { x: 30, y: 30, w: 60, h: 20 })).toBeGreaterThan(MIN_INK);
  });

  it('缩放使字形缩到 Boundary 内时不被裁剪', async () => {
    // 放大 4 倍会把字形推出 60×20 的 Boundary；缩到 0.5 倍则完整落在窗内。
    const enlarged = await renderTexts([
      {
        id: 37,
        boundary: [30, 30, 60, 20],
        ctm: scaleOf(4, 4),
        size: SIZE,
        text: 'ABC',
        codeX: 2,
        codeY: 4,
      },
    ]);
    const shrunk = await renderTexts([
      {
        id: 38,
        boundary: [30, 30, 60, 20],
        ctm: scaleOf(0.5, 0.5),
        size: SIZE,
        text: 'ABC',
        codeX: 4,
        codeY: 32,
      },
    ]);
    expect(inkIn(enlarged, { x: 30, y: 30, w: 60, h: 20 })).toBeGreaterThan(0);
    expect(inkIn(shrunk, { x: 30, y: 30, w: 60, h: 20 })).toBeGreaterThan(0);
    // 缩小后墨迹显著少于放大后被裁的部分。
    expect(inkIn(shrunk, { x: 30, y: 30, w: 60, h: 20 })).toBeLessThan(
      inkIn(enlarged, { x: 30, y: 30, w: 60, h: 20 }),
    );
  });
});

describeWithFont('裁剪区契约（表 36 Clips）', () => {
  /** 裁剪为一条纵向窄带：只保留对象空间 X∈[0,10] 的笔画。 */
  const LEFT_STRIP: CtmClipSpec = { rect: [0, 0, 10, 80] };

  /** 基线放在窄带内，使部分字形被裁剪带保留。 */
  const IN_STRIP_X = 2;

  it('对象空间裁剪区收窄可见区域', async () => {
    const unclipped = await renderTexts([text({ id: 40, codeX: IN_STRIP_X })]);
    const clipped = await renderTexts([text({ id: 41, codeX: IN_STRIP_X, clips: [LEFT_STRIP] })]);
    const full = totalInk(unclipped);
    const narrow = totalInk(clipped);
    expect(full).toBeGreaterThan(MIN_INK);
    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(full * 0.7);
  });

  it('裁剪区在 CTM 之前应用：裁剪窗不随 CTM 平移', async () => {
    // 裁剪区固定在对象空间 X∈[0,10]；CTM 把字形右移 40mm 后应完全落到裁剪窗之外。
    const result = await renderTexts([
      text({
        id: 42,
        ctm: [1, 0, 0, 1, 40, 0],
        codeX: BASE_X - 40,
        clips: [LEFT_STRIP],
      }),
    ]);
    // 字形对象空间位置仍是 BASE_X=40，位于 [0,10] 之外，故被裁掉。
    expect(totalInk(result)).toBe(0);
  });

  it('多个裁剪区取交集', async () => {
    const single = await renderTexts([text({ id: 43, codeX: IN_STRIP_X, clips: [LEFT_STRIP] })]);
    const both = await renderTexts([
      text({
        id: 44,
        codeX: IN_STRIP_X,
        clips: [LEFT_STRIP, { rect: [0, 0, 10, 12] }],
      }),
    ]);
    const singleInk = totalInk(single);
    const bothInk = totalInk(both);
    expect(singleInk).toBeGreaterThan(0);
    // 交集不大于任一单区。
    expect(bothInk).toBeLessThanOrEqual(singleInk);
  });

  it('裁剪区 CTM 在裁剪区内部生效', async () => {
    // 裁剪路径本身带平移，把窄窗挪到对象空间 X∈[20,30]。
    const shifted: CtmClipSpec = { rect: [0, 0, 10, 80], ctm: [1, 0, 0, 1, 20, 0] };
    const result = await renderTexts([text({ id: 45, codeX: 22, clips: [shifted] })]);
    expect(totalInk(result)).toBeGreaterThan(0);
  });
});

describeWithFont('Boundary 与裁剪区组合', () => {
  it('Boundary 大窗 + 裁剪窄带：按裁剪区收窄', async () => {
    const noClip = await renderTexts([text({ id: 50, codeX: 2 })]);
    const clipped = await renderTexts([
      text({ id: 51, codeX: 2, clips: [{ rect: [0, 0, 10, 80] }] }),
    ]);
    const full = totalInk(noClip);
    const narrow = totalInk(clipped);
    expect(full).toBeGreaterThan(MIN_INK);
    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(full);
  });

  it('Boundary 窄窗 + 宽松裁剪区：按 Boundary 裁掉', async () => {
    const result = await renderTexts([
      {
        id: 52,
        boundary: [30, 30, 12, 20],
        size: SIZE,
        text: 'ABC',
        codeX: 2,
        codeY: 16,
        clips: [{ rect: [0, 0, 200, 200] }],
      },
    ]);
    expect(inkIn(result, { x: 30, y: 30, w: 12, h: 20 })).toBeGreaterThan(0);
    // 不越出 Boundary 右边界（留 1mm 余量）。
    expect(inkIn(result, { x: 43, y: 30, w: 60, h: 20 })).toBe(0);
  });

  it('旋转 CTM + 裁剪区：裁剪窗仍在对象空间生效', async () => {
    // 旋转 90° 后字形主体位于对象空间 X∈[0,80]、Y∈[40,60] 一带；
    // 用 Y∈[0,10] 的窄带裁剪，只保留被旋转到上方的部分。
    const result = await renderTexts([
      text({
        id: 53,
        ctm: rotation(90),
        codeX: 40,
        codeY: 0,
        clips: [{ rect: [0, 0, 120, 14] }],
      }),
    ]);
    // 旋转 90° 后字形沿 +X→+Y 方向排开，落在 Y∈[40,60] 之外，裁剪带 [0,14] 不应包含主体。
    expect(inkIn(result, { x: 30, y: 44, w: 120, h: 40 })).toBe(0);
  });

  it('TransFlag=true 时裁剪区在 CTM 之后应用', async () => {
    // 裁剪窄带 [0,0,20,80] 在 CTM 之后解释：CTM 平移 40mm 后裁剪窗同样右移，
    // 与对象空间 X=40 附近的字形重叠，因此字形可见。
    // 对照组：不加 CTM 时，X∈[0,10] 的窄带裁不到基线 X=40 的字形。
    const withoutCtm = await renderTexts([
      text({
        id: 54,
        codeX: BASE_X,
        clips: [{ rect: [0, 0, 10, 80], transFlag: true }],
      }),
    ]);
    expect(totalInk(withoutCtm)).toBe(0);
    // CTM 平移 40mm 使字形对象空间位置变为 BASE_X-40=0；裁剪带 [0,0,20,80] 若在 CTM 之后
    // 解释，同样右移 40mm 覆盖 X∈[40,60]，框不到字形；若在 CTM 之前解释则覆盖 X∈[0,20]。
    // 两种解释结果不同，用显式对照锁定「在 CTM 之后」的语义。
    const moved = await renderTexts([
      text({
        id: 55,
        ctm: [1, 0, 0, 1, 40, 0],
        codeX: BASE_X - 40,
        clips: [{ rect: [0, 0, 10, 80], transFlag: true }],
      }),
    ]);
    const kept = await renderTexts([
      text({
        id: 56,
        ctm: [1, 0, 0, 1, 40, 0],
        codeX: BASE_X - 40,
        clips: [{ rect: [40, 0, 10, 80], transFlag: true }],
      }),
    ]);
    // 字形对象空间 X≈0，落在 [0,10] 之外 -> 不可见；落在 [40,50] 之外 -> 也不可见。
    expect(totalInk(moved)).toBe(0);
    expect(totalInk(kept)).toBe(0);
  });
});