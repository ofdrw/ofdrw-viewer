/**
 * 渐变勾边（`StrokeColor` 内嵌渐变，GB/T 33190—2016 §8.3.4.1）渲染测试。
 *
 * 覆盖轴向/径向渐变描边的真实绘制、描边宽度、虚线、CTM 缩放/旋转下的位置，
 * 以及径向渐变不再降级。断言对象为渲染器端到端的像素结果。
 */

import { describe, expect, it } from 'vitest';
import type {
  AxialGradientSpec,
  DrawStyle,
  RadialGradientSpec,
  ResolvedPaint,
  Rgba,
  Viewport,
} from '../../../src/common/types';
import type { CanvasRenderingContext2DLike } from '../../../src/renderer/types';
import { H5Canvas2DRenderer } from '../../../src/renderer/canvas2d';
import { createNodeCanvas, readPixel } from '../../renderer/helpers';

/** 红。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 蓝。 */
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

/** 基础线型：实线、斜接拐角。 */
const STYLE: DrawStyle = {
  lineWidth: 4,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 10,
  dashOffset: 0,
  dashPattern: [],
};

/**
 * 创建 96 DPI 视口。
 *
 * @param width 宽，像素。
 * @param height 高，像素。
 * @returns 视口。
 */
function viewport(width: number, height: number): Viewport {
  return { width, height, dpi: 96 };
}

/**
 * 创建轴向渐变 Paint（红 → 蓝）。
 *
 * @param start 渐变起点，当前用户空间单位（通常 mm）。
 * @param end 渐变终点，当前用户空间单位（通常 mm）。
 * @param overrides 覆盖字段。
 * @returns 描边用 Paint。
 */
function axialPaint(
  start: { x: number; y: number },
  end: { x: number; y: number },
  overrides: Partial<AxialGradientSpec> = {},
): ResolvedPaint {
  return {
    kind: 'gradient',
    spec: {
      kind: 'axial',
      start,
      end,
      mapType: 'Direct',
      extend: 3,
      segments: [
        { position: 0, color: RED },
        { position: 1, color: BLUE },
      ],
      ...overrides,
    },
  };
}

/**
 * 创建径向渐变 Paint（红 → 蓝）。
 *
 * @param overrides 覆盖字段。
 * @returns 描边用 Paint。
 */
function radialPaint(overrides: Partial<RadialGradientSpec> = {}): ResolvedPaint {
  return {
    kind: 'gradient',
    spec: {
      kind: 'radial',
      start: { x: 20, y: 20 },
      startRadius: 0,
      end: { x: 20, y: 20 },
      endRadius: 18,
      mapType: 'Direct',
      extend: 0,
      segments: [
        { position: 0, color: RED },
        { position: 1, color: BLUE },
      ],
      ...overrides,
    },
  };
}

/**
 * 统计一行内 alpha 非零的像素数。
 *
 * @param context 目标上下文。
 * @param y 行号，像素。
 * @param width 扫描宽度，像素。
 * @returns 非透明像素数。
 */
function opaqueCount(
  context: CanvasRenderingContext2DLike,
  y: number,
  width: number,
): number {
  let count = 0;
  for (let x = 0; x < width; x += 1) {
    if (readPixel(context, x, y)[3] > 0) count += 1;
  }
  return count;
}

describe('渐变勾边：轴向渐变', () => {
  it('矩形描边用渐变着色，左侧偏红、右侧偏蓝', () => {
    const { context } = createNodeCanvas(40, 40);
    const renderer = new H5Canvas2DRenderer({ createCanvas: (w, h) => createNodeCanvas(w, h).canvas });
    renderer.beginPage(context, viewport(40, 40));
    renderer.beginPath();
    renderer.rect(10, 10, 20, 20);
    renderer.stroke(STYLE, axialPaint({ x: 10, y: 0 }, { x: 30, y: 0 }));

    // 上边框 y=10 处，左端偏红、右端偏蓝。
    const left = readPixel(context, 12, 10);
    const right = readPixel(context, 28, 10);
    expect(left[3]).toBeGreaterThan(240);
    expect(right[3]).toBeGreaterThan(240);
    expect(left[0]).toBeGreaterThan(left[2]);
    expect(right[2]).toBeGreaterThan(right[0]);

    // 矩形内部不参与描边。
    expect(readPixel(context, 20, 20)[3]).toBe(0);
    renderer.endPage();
    renderer.close();
  });

  it('描边宽度跟随 lineWidth（2 与 8 像素）', () => {
    for (const lineWidth of [2, 8]) {
      const { context } = createNodeCanvas(40, 40);
      const renderer = new H5Canvas2DRenderer({
        createCanvas: (w, h) => createNodeCanvas(w, h).canvas,
      });
      renderer.beginPage(context, viewport(40, 40));
      renderer.beginPath();
      renderer.moveTo(5, 20);
      renderer.lineTo(35, 20);
      renderer.stroke({ ...STYLE, lineWidth }, axialPaint({ x: 5, y: 0 }, { x: 35, y: 0 }));

      // 水平线以 y=20 为中心，覆盖 lineWidth 像素高的条带；条带外应为透明。
      const half = Math.ceil(lineWidth / 2);
      for (let y = 20 - half + 1; y <= 20 + half - 1; y += 1) {
        expect(opaqueCount(context, y, 40)).toBeGreaterThan(28);
      }
      expect(opaqueCount(context, 20 - half - 2, 40)).toBe(0);
      expect(opaqueCount(context, 20 + half + 2, 40)).toBe(0);
      renderer.endPage();
      renderer.close();
    }
  });

  it('虚线 + 渐变描边按 DashPattern 产生间隔', () => {
    const { context } = createNodeCanvas(48, 12);
    const renderer = new H5Canvas2DRenderer({ createCanvas: (w, h) => createNodeCanvas(w, h).canvas });
    renderer.beginPage(context, viewport(48, 12));
    renderer.beginPath();
    renderer.moveTo(2, 6);
    renderer.lineTo(46, 6);
    renderer.stroke(
      { ...STYLE, lineWidth: 6, dashPattern: [4, 4] },
      axialPaint({ x: 2, y: 0 }, { x: 46, y: 0 }),
    );

    // 沿虚线方向采样：必然同时存在实线段与空白段。
    let dashes = 0;
    let gaps = 0;
    for (let x = 3; x < 45; x += 1) {
      if (readPixel(context, x, 6)[3] > 200) dashes += 1;
      else gaps += 1;
    }
    expect(dashes).toBeGreaterThan(10);
    expect(gaps).toBeGreaterThan(10);
    renderer.endPage();
    renderer.close();
  });

  it('CTM 缩放后描边位置与宽度跟随对象', () => {
    const { context } = createNodeCanvas(60, 60);
    const renderer = new H5Canvas2DRenderer({ createCanvas: (w, h) => createNodeCanvas(w, h).canvas });
    renderer.beginPage(context, viewport(60, 60));
    // 2 倍缩放：用户空间 (5..25) → 设备 (10..50)，线宽 4 → 8 像素。
    renderer.transform([2, 0, 0, 2, 0, 0]);
    renderer.beginPath();
    renderer.moveTo(5, 15);
    renderer.lineTo(25, 15);
    renderer.stroke(STYLE, axialPaint({ x: 5, y: 0 }, { x: 25, y: 0 }));

    expect(readPixel(context, 30, 30)[3]).toBeGreaterThan(240);
    // 上下边界各留 4 像素余量之外应为透明。
    expect(readPixel(context, 30, 22)[3]).toBe(0);
    expect(readPixel(context, 30, 38)[3]).toBe(0);
    renderer.endPage();
    renderer.close();
  });

  it('CTM 旋转后描边仍覆盖旋转后的线段', () => {
    const { context } = createNodeCanvas(60, 60);
    const renderer = new H5Canvas2DRenderer({ createCanvas: (w, h) => createNodeCanvas(w, h).canvas });
    renderer.beginPage(context, viewport(60, 60));
    renderer.setTransform([1, 0, 0, 1, 30, 30]);
    renderer.transform([Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2, 0, 0]);
    renderer.beginPath();
    renderer.moveTo(-15, 0);
    renderer.lineTo(15, 0);
    renderer.stroke(STYLE, axialPaint({ x: -15, y: 0 }, { x: 15, y: 0 }));

    // 旋转 +45° 后线段沿主对角线。斜线与像素网格不平行，每个像素的覆盖率约 50%，
    // 因此沿对角线只断言「有覆盖」，两侧远离对角线的像素必须透明。
    expect(readPixel(context, 30, 30)[3]).toBeGreaterThan(0);
    expect(readPixel(context, 23, 23)[3]).toBeGreaterThan(0);
    expect(readPixel(context, 37, 37)[3]).toBeGreaterThan(0);
    // 端点之外的延长线与垂直方向两侧应为透明。
    expect(readPixel(context, 13, 13)[3]).toBe(0);
    expect(readPixel(context, 47, 47)[3]).toBe(0);
    expect(readPixel(context, 30, 15)[3]).toBe(0);
    expect(readPixel(context, 15, 30)[3]).toBe(0);
    renderer.endPage();
    renderer.close();
  });

  it('线宽为 0（hairline）时仍绘制 1 像素描边', () => {
    const { context } = createNodeCanvas(40, 40);
    const renderer = new H5Canvas2DRenderer({ createCanvas: (w, h) => createNodeCanvas(w, h).canvas });
    renderer.beginPage(context, viewport(40, 40));
    renderer.beginPath();
    renderer.moveTo(5, 20);
    renderer.lineTo(35, 20);
    renderer.stroke({ ...STYLE, lineWidth: 0 }, axialPaint({ x: 5, y: 0 }, { x: 35, y: 0 }));

    expect(opaqueCount(context, 20, 40)).toBeGreaterThan(25);
    renderer.endPage();
    renderer.close();
  });
});

describe('渐变勾边：径向渐变', () => {
  it('径向渐变描边按椭圆渐变着色，不再降级为平均色', () => {
    const { context } = createNodeCanvas(40, 40);
    const renderer = new H5Canvas2DRenderer({ createCanvas: (w, h) => createNodeCanvas(w, h).canvas });
    renderer.beginPage(context, viewport(40, 40));
    renderer.beginPath();
    renderer.rect(10, 10, 20, 20);
    renderer.stroke({ ...STYLE, lineWidth: 4 }, radialPaint());

    // 同心椭圆渐变（起点=终点，§8.3.4.3）：颜色只随半径变化。
    // 四条边框中点距圆心同为 10px，颜色应彼此接近（描边像素命中不同半径采样，允许小偏差）。
    const corners = [[20, 10], [20, 30], [10, 20], [30, 20]] as const;
    const colors = corners.map(([x, y]) => readPixel(context, x, y));
    for (const pixel of colors) expect(pixel[3]).toBeGreaterThan(240);
    for (const pixel of colors.slice(1)) {
      expect(Math.abs(pixel[0] - colors[0]![0])).toBeLessThanOrEqual(20);
      expect(Math.abs(pixel[2] - colors[0]![2])).toBeLessThanOrEqual(20);
    }
    // 半径不同则颜色不同：角落（半径 ~14.1）应比边中点（半径 10）更接近结束色（蓝）。
    const cornerPixel = readPixel(context, 11, 11);
    expect(cornerPixel[3]).toBeGreaterThan(240);
    expect(cornerPixel[2]).toBeGreaterThan(colors[0]![2]);
    renderer.endPage();
    renderer.close();
  });
});