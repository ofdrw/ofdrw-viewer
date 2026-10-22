/**
 * drawImage 可选 multiply 合成测试（签章白底）。
 *
 * 覆盖：缺省 source-over 不变、multiply 生效并在绘制后恢复 composite、
 * mask/alpha/transform 语义不变、RecordingRenderer 记录 blendMode。
 */

import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import { RecordingRenderer } from '../../src/renderer/recording';
import type { Renderer } from '../../src/renderer/types';
import type {
  DecodedImage,
  DrawStyle,
  ImageDataLike,
  Matrix,
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

/** 背景色 (100,150,200)，用于观察 multiply 结果。 */
const BACKGROUND: Rgba = { r: 100, g: 150, b: 200, a: 255 };

/** 红色。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 白色（签章白底）。 */
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** 蓝色。 */
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

/** 单位矩阵。 */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** 把 2×2 图像铺到 10×10 区域的矩阵。 */
const SCALE_10: Matrix = [10, 0, 0, 10, 0, 0];

/** 96 DPI viewport。 */
const VIEWPORT: Viewport = { width: 20, height: 10, dpi: 96 };

/**
 * 创建纯色 RGBA 图像数据。
 *
 * @param width 宽，像素。
 * @param height 高，像素。
 * @param color 颜色。
 * @returns ImageDataLike。
 */
function solidImageData(width: number, height: number, color: Rgba): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color.r;
    data[index + 1] = color.g;
    data[index + 2] = color.b;
    data[index + 3] = color.a;
  }
  return { width, height, data };
}

/**
 * 创建 2×2 纯色解码结果。
 *
 * @param color 颜色。
 * @returns DecodedImage。
 */
function image2x2(color: Rgba): DecodedImage {
  return { width: 2, height: 2, data: solidImageData(2, 2, color) };
}

/**
 * 创建渲染器并铺好背景。
 *
 * @returns 渲染器与主上下文。
 */
function setup(): {
  renderer: H5Canvas2DRenderer;
  context: ReturnType<typeof createNodeCanvas>['context'];
} {
  const { context } = createNodeCanvas(20, 10);
  const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
  renderer.beginPage(context, VIEWPORT);
  const backgroundPaint: ResolvedPaint = { kind: 'color', rgba: BACKGROUND };
  renderer.beginPath();
  renderer.rect(0, 0, 20, 10);
  renderer.fill(STYLE, backgroundPaint, 'nonzero');
  return { renderer, context };
}

describe('drawImage 缺省合成', () => {
  it('不传 blendMode 时保持 source-over，图片覆盖背景', () => {
    const { renderer, context } = setup();
    const image = renderer.createImage(image2x2(RED));
    renderer.drawImage(image, SCALE_10, 1, true);

    expect(readPixel(context, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(context.globalCompositeOperation).toBe('source-over');
    renderer.close();
  });

  it('不传 blendMode 时 alpha 语义不变', () => {
    const { renderer, context } = setup();
    const image = renderer.createImage(image2x2(RED));
    renderer.drawImage(image, SCALE_10, 0.5, true);

    // source-over 半透明红叠在背景上：0.5*红 + 0.5*背景。
    expect(readPixel(context, 5, 5)).toEqual([178, 75, 100, 255]);
    renderer.close();
  });
});

describe('drawImage multiply 合成', () => {
  it('白色签章底 multiply 后不覆盖背景', () => {
    const { renderer, context } = setup();
    const image = renderer.createImage(image2x2(WHITE));
    renderer.drawImage(image, SCALE_10, 1, true, undefined, 'multiply');

    expect(readPixel(context, 5, 5)).toEqual([100, 150, 200, 255]);
    renderer.close();
  });

  it('multiply 生效后恢复 globalCompositeOperation，不影响后续图片', () => {
    const { renderer, context } = setup();
    const red = renderer.createImage(image2x2(RED));
    renderer.drawImage(red, SCALE_10, 1, true, undefined, 'multiply');
    expect(readPixel(context, 5, 5)).toEqual([100, 0, 0, 255]);
    expect(context.globalCompositeOperation).toBe('source-over');

    const blue = renderer.createImage(image2x2(BLUE));
    renderer.drawImage(blue, [10, 0, 0, 10, 10, 0], 1, true);
    expect(readPixel(context, 15, 5)).toEqual([0, 0, 255, 255]);
    renderer.close();
  });

  it('multiply 与 alpha 同时生效（alpha 仍按 source-over 混合）', () => {
    const { renderer, context } = setup();
    const image = renderer.createImage(image2x2(RED));
    renderer.drawImage(image, SCALE_10, 0.5, true, undefined, 'multiply');

    // multiply 结果 (100,0,0) 再按 0.5 alpha 与背景混合。
    expect(readPixel(context, 5, 5)).toEqual([100, 75, 100, 255]);
    renderer.close();
  });

  it('multiply 与 mask 同时生效：蒙版外保持背景', () => {
    const { renderer, context } = setup();
    const image = renderer.createImage(image2x2(RED));
    const maskData = solidImageData(2, 2, { r: 0, g: 0, b: 0, a: 255 });
    for (let y = 0; y < 2; y += 1) {
      maskData.data[(y * 2 + 1) * 4 + 3] = 0;
    }
    const mask = renderer.createImage({ width: 2, height: 2, data: maskData });

    renderer.drawImage(image, SCALE_10, 1, true, mask, 'multiply');
    expect(readPixel(context, 2, 5)).toEqual([100, 0, 0, 255]);
    expect(readPixel(context, 7, 5)).toEqual([100, 150, 200, 255]);
    expect(context.globalCompositeOperation).toBe('source-over');
    renderer.close();
  });
});

describe('RecordingRenderer blendMode 记录', () => {
  it('记录 multiply，缺省调用不写 blendMode', () => {
    const renderer: Renderer = new RecordingRenderer();
    const image = renderer.createImage(image2x2(WHITE));
    const mask = renderer.createImage(image2x2(WHITE));

    renderer.drawImage(image, IDENTITY, 1, true);
    renderer.drawImage(image, IDENTITY, 1, true, undefined, 'multiply');
    renderer.drawImage(image, IDENTITY, 1, true, mask, 'multiply');

    const calls = (renderer as RecordingRenderer).calls.filter(
      (call) => call.op === 'drawImage',
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ op: 'drawImage', alpha: 1, smoothing: true });
    expect(calls[0]).not.toHaveProperty('blendMode');
    expect(calls[1]).toMatchObject({ op: 'drawImage', blendMode: 'multiply' });
    expect(calls[1]).toHaveProperty('mask', undefined);
    expect(calls[2]).toMatchObject({ op: 'drawImage', mask, blendMode: 'multiply' });
  });
});