/**
 * H5Canvas2DRenderer 生命周期与全接口测试。
 */

import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import { isOFDError } from '../../src/errors';
import type { Renderer } from '../../src/renderer/types';
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
const RED_PAINT: ResolvedPaint = { kind: 'color', rgba: { r: 255, g: 0, b: 0, a: 255 } };

/** 蓝色纯色 Paint。 */
const BLUE_PAINT: ResolvedPaint = { kind: 'color', rgba: { r: 0, g: 0, b: 255, a: 255 } };

/** 默认 viewport，96 DPI。 */
const VIEWPORT: Viewport = { width: 20, height: 20, dpi: 96 };

/** 创建 20×20 的 Node 画布。 */
function setup(): ReturnType<typeof createNodeCanvas> {
  return createNodeCanvas(20, 20);
}

describe('H5Canvas2DRenderer 生命周期', () => {
  it('beginPage 不设置画布宽高、不清屏；endPage 不改画布内容', () => {
    const { canvas, context } = setup();
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 5, 5);

    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, VIEWPORT);

    expect(canvas.width).toBe(20);
    expect(canvas.height).toBe(20);
    expect(readPixel(context, 1, 1)).toEqual([255, 0, 0, 255]);

    renderer.endPage();
    expect(canvas.width).toBe(20);
    expect(canvas.height).toBe(20);
    expect(readPixel(context, 1, 1)).toEqual([255, 0, 0, 255]);
    renderer.close();
  });

  it('beginPage 后接管状态：重置 alpha/transform/虚线，但保留像素', () => {
    const { context } = setup();
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 5, 5);
    context.globalAlpha = 0.2;
    context.translate(10, 10);

    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, VIEWPORT);
    expect(context.globalAlpha).toBe(1);
    expect(context.getLineDash()).toEqual([]);
    // 恢复为 identity 后，画出的矩形从 (0,0) 开始。
    renderer.beginPath();
    renderer.rect(0, 0, 5, 5);
    renderer.fill(STYLE, BLUE_PAINT, 'nonzero');
    expect(readPixel(context, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(readPixel(context, 15, 15)).toEqual([0, 0, 0, 0]);
    renderer.endPage();
    renderer.close();
  });

  it('未 beginPage 时绘制抛 OFD_RENDERER_UNSUPPORTED；close 后抛 OFD_CLOSED', () => {
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    expect(() => renderer.beginPath()).toThrowError();
    try {
      renderer.beginPath();
    } catch (error) {
      expect(isOFDError(error)).toBe(true);
      if (isOFDError(error)) expect(error.code).toBe('OFD_RENDERER_UNSUPPORTED');
    }

    const { context } = setup();
    renderer.beginPage(context, VIEWPORT);
    renderer.close();
    renderer.close(); // 幂等
    try {
      renderer.beginPath();
      throw new Error('expected beginPath to throw');
    } catch (error) {
      expect(isOFDError(error)).toBe(true);
      if (isOFDError(error)) expect(error.code).toBe('OFD_CLOSED');
    }
  });

  it('Renderer 全接口可调用（路径/状态/填充/描边/图像/裁剪/clear）', () => {
    const { context } = setup();
    const factory = createCountingFactory();
    const renderer: Renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, VIEWPORT);

    renderer.save();
    renderer.setTransform([1, 0, 0, 1, 0, 0]);
    renderer.transform([1, 0, 0, 1, 0, 0]);
    renderer.translate(1, 1);
    renderer.multiplyAlpha(1);
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(4, 0);
    renderer.quadraticCurveTo(4, 2, 2, 2);
    renderer.cubicCurveTo(1, 2, 0, 1, 0, 0);
    renderer.rect(0, 0, 3, 3);
    renderer.closePath();
    renderer.clip('evenodd');
    renderer.fill(STYLE, RED_PAINT, 'evenodd');
    renderer.stroke(STYLE, BLUE_PAINT);
    renderer.clear();
    const image = renderer.createImage({
      width: 1,
      height: 1,
      data: {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([0, 255, 0, 255]),
      },
    });
    renderer.drawImage(image, [2, 0, 0, 2, 0, 0], 1, true);
    renderer.restore();
    renderer.endPage();
    renderer.close();
  });

  it('save/restore 恢复 CTM；clear 不清除主画布', () => {
    const { context } = setup();
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, VIEWPORT);
    renderer.setTransform([1, 0, 0, 1, 0, 0]);
    renderer.translate(5, 5);

    renderer.save();
    renderer.translate(5, 5);
    renderer.beginPath();
    renderer.rect(0, 0, 3, 3);
    renderer.fill(STYLE, RED_PAINT, 'nonzero');
    renderer.restore();

    renderer.beginPath();
    renderer.rect(0, 0, 3, 3);
    renderer.fill(STYLE, BLUE_PAINT, 'nonzero');

    expect(readPixel(context, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 5, 5)).toEqual([0, 0, 255, 255]);

    // clear 只清内部 scratch，主画布保持原样。
    renderer.clear();
    expect(readPixel(context, 5, 5)).toEqual([0, 0, 255, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('重复 beginPage 会先结束上一页，不泄漏 group', () => {
    const { context } = setup();
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, VIEWPORT);
    renderer.beginGroup({
      bounds: { x: 0, y: 0, w: 5, h: 5 },
      matrix: [1, 0, 0, 1, 0, 0],
      alpha: 0.5,
    });
    renderer.beginPage(context, VIEWPORT);
    expect(renderer.compositeMode).toBe('source-over');
    renderer.endPage();
    renderer.close();
    expect(factory.created.every((canvas) => canvas.width === 0)).toBe(true);
  });
});