/**
 * group 合成测试：AABB、嵌套、alpha 只乘一次、父状态/裁剪恢复、异常路径。
 */

import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import { isOFDError } from '../../src/errors';
import type { DrawStyle, ResolvedPaint, Viewport } from '../../src/common/types';
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

/** 红色纯色 Paint。 */
const RED: ResolvedPaint = { kind: 'color', rgba: { r: 255, g: 0, b: 0, a: 255 } };

/** 蓝色纯色 Paint。 */
const BLUE: ResolvedPaint = { kind: 'color', rgba: { r: 0, g: 0, b: 255, a: 255 } };

/** 20×20、96 DPI 的 viewport。 */
const VIEWPORT: Viewport = { width: 20, height: 20, dpi: 96 };

/**
 * 创建渲染器与 20×20 Node 画布。
 *
 * @returns 渲染器、上下文与计数工厂。
 */
function setup(): {
  renderer: H5Canvas2DRenderer;
  context: ReturnType<typeof createNodeCanvas>['context'];
  factory: ReturnType<typeof createCountingFactory>;
} {
  const { context } = createNodeCanvas(20, 20);
  const factory = createCountingFactory();
  const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
  renderer.beginPage(context, VIEWPORT);
  return { renderer, context, factory };
}

/**
 * 在当前位置填充一个矩形。
 *
 * @param renderer 渲染器。
 * @param x 左上角 X。
 * @param y 左上角 Y。
 * @param w 宽。
 * @param h 高。
 * @param paint 填充色。
 */
function fillRect(
  renderer: H5Canvas2DRenderer,
  x: number,
  y: number,
  w: number,
  h: number,
  paint: ResolvedPaint,
): void {
  renderer.beginPath();
  renderer.rect(x, y, w, h);
  renderer.fill(STYLE, paint, 'nonzero');
}

describe('H5Canvas2DRenderer group', () => {
  it('组 alpha 只在 endGroup 乘一次：重叠区域不加深', () => {
    const { renderer, context } = setup();
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 20, h: 20 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 0.5,
    });
    fillRect(renderer, 0, 0, 12, 10, RED);
    fillRect(renderer, 6, 0, 12, 10, RED);
    renderer.endGroup();

    const overlap = readPixel(context, 8, 5);
    expect(overlap[0]).toBe(255);
    expect(overlap[3]).toBeGreaterThanOrEqual(120);
    expect(overlap[3]).toBeLessThanOrEqual(136);
    // 若逐子对象乘 alpha，重叠区会达到约 191；这里明确排除。
    expect(overlap[3]).toBeLessThan(180);

    const single = readPixel(context, 2, 5);
    expect(single[3]).toBeGreaterThanOrEqual(120);
    expect(single[3]).toBeLessThanOrEqual(136);
    renderer.endPage();
    renderer.close();
  });

  it('嵌套 group 的 alpha 逐层相乘', () => {
    const { renderer, context } = setup();
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 20, h: 20 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 0.5,
    });
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 20, h: 20 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 0.5,
    });
    fillRect(renderer, 2, 2, 10, 10, RED);
    renderer.endGroup();
    renderer.endGroup();

    const pixel = readPixel(context, 5, 5);
    expect(pixel[0]).toBe(255);
    expect(pixel[3]).toBeGreaterThanOrEqual(56);
    expect(pixel[3]).toBeLessThanOrEqual(72);
    renderer.endPage();
    renderer.close();
  });

  it('endGroup 恢复父级变换、裁剪与合成模式', () => {
    const { renderer, context } = setup();
    renderer.setTransform([1, 0, 0, 1, 0, 0]);
    renderer.translate(5, 5);
    renderer.beginPath();
    renderer.rect(0, 0, 5, 10);
    renderer.clip('nonzero');

    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      matrix: [1, 0, 0, 1, 5, 5],
      alpha: 1,
    });
    fillRect(renderer, 0, 0, 10, 10, RED);
    renderer.endGroup();

    // 父级 clip 在设备 x∈[5,10]、y∈[5,15]，group 内容被它裁掉右侧。
    expect(readPixel(context, 6, 6)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 11, 6)).toEqual([0, 0, 0, 0]);

    // 父级 CTM 仍为 translate(5,5)，蓝色小矩形落到 (5,5) 附近。
    fillRect(renderer, 0, 0, 2, 2, BLUE);
    expect(readPixel(context, 6, 6)).toEqual([0, 0, 255, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('group matrix 的 AABB 与旋转落位正确', () => {
    const { renderer, context } = setup();
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 5, h: 5 },
      matrix: [0, 1, -1, 0, 10, 0],
      alpha: 1,
    });
    fillRect(renderer, 0, 0, 5, 5, RED);
    renderer.endGroup();

    // 旋转 90°：group 的 (0,0)-(5,5) 映射到设备 x∈[5,10]、y∈[0,5]。
    expect(readPixel(context, 6, 2)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 2, 2)).toEqual([0, 0, 0, 0]);
    renderer.endPage();
    renderer.close();
  });

  it('group 内未配对的 save 不破坏父状态栈', () => {
    const { renderer, context } = setup();
    renderer.translate(5, 5);
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 5, h: 5 },
      matrix: [1, 0, 0, 1, 5, 5],
      alpha: 1,
    });
    renderer.save();
    renderer.translate(2, 2);
    fillRect(renderer, 0, 0, 2, 2, RED);
    renderer.endGroup();

    // 父 CTM 仍为 translate(5,5)。
    fillRect(renderer, 0, 0, 2, 2, BLUE);
    expect(readPixel(context, 6, 6)).toEqual([0, 0, 255, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('alpha=0 的 group 不提交内容', () => {
    const { renderer, context } = setup();
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 0,
    });
    fillRect(renderer, 0, 0, 10, 10, RED);
    renderer.endGroup();
    expect(readPixel(context, 5, 5)).toEqual([0, 0, 0, 0]);
    renderer.endPage();
    renderer.close();
  });

  it('group scratch 在 endGroup 后销毁；close 清理所有临时画布', () => {
    const { renderer, factory } = setup();
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 5, h: 5 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 0.5,
      composite: 'multiply',
      isolated: true,
    });
    fillRect(renderer, 0, 0, 5, 5, RED);
    renderer.endGroup();
    expect(factory.created.length).toBeGreaterThan(0);
    expect(factory.created.every((canvas) => canvas.width === 0)).toBe(true);
    renderer.endPage();
    renderer.close();
  });

  it('嵌套 group 使用绝对设备矩阵，子组按父 offset 正确落位', () => {
    const { renderer, context } = setup();
    renderer.beginGroup({
      bounds: { x: 10, y: 10, w: 10, h: 10 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 1,
    });
    renderer.beginGroup({
      bounds: { x: 10, y: 10, w: 5, h: 5 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 1,
    });
    fillRect(renderer, 10, 10, 5, 5, RED);
    renderer.endGroup();
    renderer.endGroup();

    // 父 scratch 原点在 (10,10)，子组绝对坐标 (10,10) 应落在父原点。
    expect(readPixel(context, 12, 12)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 2, 2)).toEqual([0, 0, 0, 0]);
    renderer.endPage();
    renderer.close();
  });

  it('group matrix 是 group→device，不叠加当前父 CTM', () => {
    const { renderer, context } = setup();
    renderer.translate(5, 5);
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 5, h: 5 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 1,
    });
    fillRect(renderer, 0, 0, 5, 5, RED);
    renderer.endGroup();

    expect(readPixel(context, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 7, 7)).toEqual([0, 0, 0, 0]);
    renderer.endPage();
    renderer.close();
  });

  it('endGroup 没有 beginGroup 时抛 OFD_RENDERER_UNSUPPORTED', () => {
    const { renderer } = setup();
    try {
      renderer.endGroup();
      throw new Error('expected endGroup to throw');
    } catch (error) {
      expect(isOFDError(error)).toBe(true);
      if (isOFDError(error)) expect(error.code).toBe('OFD_RENDERER_UNSUPPORTED');
    }
    renderer.endPage();
    renderer.close();
  });
});