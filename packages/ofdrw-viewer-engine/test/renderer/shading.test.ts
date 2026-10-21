/**
 * H5 渲染器 shading 集成测试：软件光栅化、Extend/BackColor、像素能力缺失降级。
 */

import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import type {
  DrawStyle,
  MeshShadingPoint,
  MeshShadingSpec,
  ResolvedPaint,
  Rgba,
  Viewport,
} from '../../src/common/types';
import { createCountingFactory, createNodeCanvas, readPixel } from './helpers';

/** 测试用线型。 */
const STYLE: DrawStyle = {
  lineWidth: 1,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 10,
  dashOffset: 0,
  dashPattern: [],
};

/** 红。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 绿。 */
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };

/** 蓝。 */
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

/** 黄。 */
const YELLOW: Rgba = { r: 255, g: 255, b: 0, a: 255 };

/** 96 DPI viewport。 */
function viewport(width: number, height: number): Viewport {
  return { width, height, dpi: 96 };
}

/**
 * 构造三角形网格。
 *
 * @param extend 延伸方式。
 * @param backColor 背景色。
 * @returns MeshShadingSpec。
 */
function triangleMesh(extend: 0 | 1 = 0, backColor?: Rgba): MeshShadingSpec {
  return {
    kind: 'gouraud',
    points: [
      { x: 0, y: 0, color: RED },
      { x: 10, y: 0, color: GREEN },
      { x: 0, y: 10, color: BLUE },
    ],
    extend,
    backColor,
  };
}

/**
 * 创建 shading Paint。
 *
 * @param spec 网格描述。
 * @returns ResolvedPaint。
 */
function shadingPaint(spec: MeshShadingSpec): ResolvedPaint {
  return { kind: 'shading', spec };
}

describe('H5Canvas2DRenderer shading', () => {
  it('三角形在设备空间重心插值；Extend=0 三角形外透明', () => {
    const { context } = createNodeCanvas(12, 12);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(12, 12));
    renderer.beginPath();
    renderer.rect(0, 0, 10, 10);
    renderer.fill(STYLE, shadingPaint(triangleMesh(0)), 'nonzero');

    const nearA = readPixel(context, 1, 1);
    expect(nearA[3]).toBe(255);
    expect(nearA[0]).toBeGreaterThan(150);
    expect(nearA[1]).toBeLessThan(90);

    expect(readPixel(context, 8, 8)[3]).toBe(0);
    // 光栅化 scratch 在填充后销毁。
    expect(factory.created.every((canvas) => canvas.width === 0)).toBe(true);
    renderer.endPage();
    renderer.close();
  });

  it('Extend=1 用 BackColor 填充三角形外、路径内区域', () => {
    const { context } = createNodeCanvas(12, 12);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(12, 12));
    renderer.beginPath();
    renderer.rect(0, 0, 10, 10);
    renderer.fill(STYLE, shadingPaint(triangleMesh(1, YELLOW)), 'nonzero');

    expect(readPixel(context, 8, 8)).toEqual([255, 255, 0, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('像素能力缺失时用平均色降级并上报 W_GOURAUD_APPROX', () => {
    const { context } = createNodeCanvas(12, 12);
    const warnings: string[] = [];
    // 用 own property 屏蔽像素读写能力，其他方法仍是真实上下文。
    Object.defineProperty(context, 'createImageData', { value: undefined, configurable: true });
    Object.defineProperty(context, 'putImageData', { value: undefined, configurable: true });

    const renderer = new H5Canvas2DRenderer();
    renderer.onWarning = (code) => warnings.push(code);
    renderer.beginPage(context, viewport(12, 12));
    renderer.beginPath();
    renderer.rect(0, 0, 10, 10);
    renderer.fill(STYLE, shadingPaint(triangleMesh(0)), 'nonzero');

    expect(warnings).toContain('W_GOURAUD_APPROX');
    const pixel = readPixel(context, 5, 5);
    expect(pixel[3]).toBe(255);
    expect(pixel[0]).toBeGreaterThan(70);
    expect(pixel[0]).toBeLessThan(100);
    expect(pixel[1]).toBeGreaterThan(70);
    expect(pixel[1]).toBeLessThan(100);
    expect(pixel[2]).toBeGreaterThan(70);
    expect(pixel[2]).toBeLessThan(100);
    renderer.endPage();
    renderer.close();
  });

  it('LaGouraud 网格填充完整矩形区域', () => {
    const { context } = createNodeCanvas(12, 12);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(12, 12));
    const points: MeshShadingPoint[] = [];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        points.push({
          x: column * 5,
          y: row * 5,
          color: row === 0 ? RED : row === 1 ? GREEN : BLUE,
        });
      }
    }
    renderer.beginPath();
    renderer.rect(0, 0, 10, 10);
    renderer.fill(
      STYLE,
      shadingPaint({ kind: 'lagouraud', points, verticesPerRow: 3, extend: 0 }),
      'nonzero',
    );

    expect(readPixel(context, 2, 2)[3]).toBe(255);
    expect(readPixel(context, 8, 8)[3]).toBe(255);
    expect(readPixel(context, 2, 8)[3]).toBe(255);
    renderer.endPage();
    renderer.close();
  });

  it('点数不足 3 时不着色，不崩溃', () => {
    const { context } = createNodeCanvas(10, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(10, 10));
    renderer.beginPath();
    renderer.rect(0, 0, 10, 10);
    renderer.fill(
      STYLE,
      shadingPaint({
        kind: 'gouraud',
        points: [
          { x: 0, y: 0, color: RED },
          { x: 1, y: 1, color: GREEN },
        ],
        extend: 0,
      }),
      'nonzero',
    );
    expect(readPixel(context, 5, 5)[3]).toBe(0);
    renderer.endPage();
    renderer.close();
  });
});