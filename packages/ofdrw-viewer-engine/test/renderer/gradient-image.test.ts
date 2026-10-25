/**
 * 渐变与图像测试：轴向渐变 Extend/Repeat、径向降级、图像句柄/蒙版/释放。
 */

import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import { isOFDError, OFDError } from '../../src/errors';
import type {
  AxialGradientSpec,
  DecodedImage,
  DrawStyle,
  ImageDataLike,
  ImageHandle,
  RadialGradientSpec,
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

/** 红色。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 蓝色。 */
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

/** 96 DPI viewport。 */
function viewport(width: number, height: number): Viewport {
  return { width, height, dpi: 96 };
}

/**
 * 创建轴向渐变 Paint。
 *
 * @param overrides 覆盖字段。
 * @returns ResolvedPaint。
 */
function axial(overrides: Partial<AxialGradientSpec> = {}): ResolvedPaint {
  return {
    kind: 'gradient',
    spec: {
      kind: 'axial',
      start: { x: 5, y: 5 },
      end: { x: 15, y: 5 },
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
 * 用 Paint 填充整个画布大小的矩形。
 *
 * @param renderer 渲染器。
 * @param paint 填充 Paint。
 * @param canvasWidth 画布宽。
 * @param canvasHeight 画布高。
 */
function fillAll(
  renderer: H5Canvas2DRenderer,
  paint: ResolvedPaint,
  canvasWidth: number,
  canvasHeight: number,
): void {
  renderer.beginPath();
  renderer.rect(0, 0, canvasWidth, canvasHeight);
  renderer.fill(STYLE, paint, 'nonzero');
}

describe('H5Canvas2DRenderer 轴向渐变', () => {
  it('Direct + Extend=0：两端裁剪 band，中间正常插值', () => {
    const { context } = createNodeCanvas(20, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(20, 10));
    fillAll(renderer, axial(), 20, 10);

    expect(readPixel(context, 1, 5)[3]).toBe(0);
    expect(readPixel(context, 18, 5)[3]).toBe(0);
    const middle = readPixel(context, 10, 5);
    expect(middle[3]).toBe(255);
    expect(middle[0]).toBeGreaterThan(100);
    expect(middle[0]).toBeLessThan(160);
    expect(middle[2]).toBeGreaterThan(100);
    expect(middle[2]).toBeLessThan(160);
    renderer.endPage();
    renderer.close();
  });

  it('Extend=3：不裁剪，两端按端点色延伸', () => {
    const { context } = createNodeCanvas(20, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(20, 10));
    fillAll(renderer, axial({ extend: 3 }), 20, 10);

    expect(readPixel(context, 1, 5)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 18, 5)).toEqual([0, 0, 255, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('Extend=1：只裁剪终点侧，起点侧按起始色延伸', () => {
    const { context } = createNodeCanvas(20, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(20, 10));
    fillAll(renderer, axial({ extend: 1 }), 20, 10);

    expect(readPixel(context, 1, 5)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 18, 5)[3]).toBe(0);
    renderer.endPage();
    renderer.close();
  });

  it('Extend=2：只裁剪起点侧，终点侧按结束色延伸', () => {
    const { context } = createNodeCanvas(20, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(20, 10));
    fillAll(renderer, axial({ extend: 2 }), 20, 10);

    expect(readPixel(context, 1, 5)[3]).toBe(0);
    expect(readPixel(context, 18, 5)).toEqual([0, 0, 255, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('MapType=Repeat 按 MapUnit 重复颜色', () => {
    const { context } = createNodeCanvas(20, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(20, 10));
    fillAll(
      renderer,
      axial({
        start: { x: 0, y: 5 },
        end: { x: 8, y: 5 },
        mapType: 'Repeat',
        mapUnit: 2,
        extend: 3,
      }),
      8,
      10,
    );

    // 周期 2：x=1 位于第一周期 75%，x=3 位于第二周期 75%，x=2 位于 25%。
    expect(readPixel(context, 1, 5)[2]).toBeGreaterThan(150);
    expect(readPixel(context, 2, 5)[2]).toBeLessThan(110);
    expect(readPixel(context, 3, 5)[2]).toBeGreaterThan(150);
    renderer.endPage();
    renderer.close();
  });

  it('径向渐变 v1 降级为平均色，不崩溃', () => {
    const { context } = createNodeCanvas(10, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(10, 10));
    const radial: RadialGradientSpec = {
      kind: 'radial',
      start: { x: 5, y: 5 },
      startRadius: 1,
      end: { x: 5, y: 5 },
      endRadius: 4,
      mapType: 'Direct',
      extend: 0,
      segments: [
        { position: 0, color: RED },
        { position: 1, color: BLUE },
      ],
    };
    fillAll(renderer, { kind: 'gradient', spec: radial }, 10, 10);

    const pixel = readPixel(context, 5, 5);
    expect(pixel[3]).toBe(255);
    expect(pixel[0]).toBeGreaterThan(100);
    expect(pixel[0]).toBeLessThan(160);
    expect(pixel[2]).toBeGreaterThan(100);
    expect(pixel[2]).toBeLessThan(160);
    renderer.endPage();
    renderer.close();
  });

  it('轴向渐变可用于描边', () => {
    const { context } = createNodeCanvas(20, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(20, 10));
    renderer.beginPath();
    renderer.moveTo(5, 5);
    renderer.lineTo(15, 5);
    renderer.stroke({ ...STYLE, lineWidth: 4 }, axial({ extend: 3 }));
    expect(readPixel(context, 10, 5)[3]).toBe(255);
    renderer.endPage();
    renderer.close();
  });
});

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

describe('H5Canvas2DRenderer 图像', () => {
  it('createImage/drawImage：单位空间经 transform 落位', () => {
    const { context } = createNodeCanvas(20, 20);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(20, 20));

    const image = renderer.createImage({
      width: 2,
      height: 2,
      data: solidImageData(2, 2, RED),
    });
    renderer.drawImage(image, [10, 0, 0, 10, 0, 0], 1, true);

    expect(readPixel(context, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 15, 5)).toEqual([0, 0, 0, 0]);
    renderer.close();
  });

  it('drawImage 的 alpha 与 smoothing 生效', () => {
    const { context } = createNodeCanvas(20, 20);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(20, 20));
    const image = renderer.createImage({
      width: 2,
      height: 2,
      data: solidImageData(2, 2, RED),
    });
    renderer.drawImage(image, [10, 0, 0, 10, 0, 0], 0.5, false);
    const pixel = readPixel(context, 5, 5);
    expect(pixel[0]).toBe(255);
    expect(pixel[3]).toBeGreaterThanOrEqual(120);
    expect(pixel[3]).toBeLessThanOrEqual(136);
    renderer.close();
  });

  it('ImageMask：destination-in 保留蒙版 alpha 交集', () => {
    const { context } = createNodeCanvas(20, 20);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(20, 20));

    const image = renderer.createImage({
      width: 2,
      height: 2,
      data: solidImageData(2, 2, RED),
    });
    const maskData = solidImageData(2, 2, { r: 0, g: 0, b: 0, a: 255 });
    // 右半透明。
    for (let y = 0; y < 2; y += 1) {
      const offset = (y * 2 + 1) * 4 + 3;
      maskData.data[offset] = 0;
    }
    const mask = renderer.createImage({ width: 2, height: 2, data: maskData });

    renderer.drawImage(image, [10, 0, 0, 10, 0, 0], 1, true, mask);
    // 蒙版边缘按面积采样平滑过渡：左半区不透明区域 alpha 保持 255，右半区完全透明。
    expect(readPixel(context, 0, 5)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 8, 5)[3]).toBe(0);
    // 蒙版合成产生的临时画布在绘制后销毁；图像句柄的 scratch 到 close 才释放。
    const compositeScratch = factory.created[factory.created.length - 1]!;
    expect(compositeScratch.width).toBe(0);
    renderer.close();
    expect(factory.created.every((canvas) => canvas.width === 0)).toBe(true);
  });

  it('createImage 支持平台可绘制 source，并在 close 时释放内部画布', () => {
    const { context } = createNodeCanvas(20, 20);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(20, 20));

    const source = createNodeCanvas(1, 1);
    source.context.fillStyle = '#00ff00';
    source.context.fillRect(0, 0, 1, 1);
    const decoded: DecodedImage = { width: 1, height: 1, data: source.canvas, kind: 'source' };
    const image = renderer.createImage(decoded);
    renderer.drawImage(image, [10, 0, 0, 10, 0, 0], 1, true);
    expect(readPixel(context, 5, 5)).toEqual([0, 255, 0, 255]);

    renderer.close();
    expect(factory.created.every((canvas) => canvas.width === 0)).toBe(true);
    expect(() => renderer.createImage(decoded)).toThrowError();
  });

  it('像素图像在 close 后释放 scratch', () => {
    const { context } = createNodeCanvas(10, 10);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(10, 10));
    renderer.createImage({ width: 2, height: 2, data: solidImageData(2, 2, RED) });
    expect(factory.created.length).toBe(1);
    expect(factory.created[0]!.width).toBe(2);
    renderer.close();
    expect(factory.created[0]!.width).toBe(0);
  });

  it('drawImage 拒绝外部句柄并抛 OFD_RENDERER_UNSUPPORTED', () => {
    const { context } = createNodeCanvas(10, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(10, 10));
    const foreign: ImageHandle = { width: 1, height: 1 };
    try {
      renderer.drawImage(foreign, [1, 0, 0, 1, 0, 0], 1, true);
      throw new Error('expected drawImage to throw');
    } catch (error) {
      expect(isOFDError(error)).toBe(true);
      if (isOFDError(error)) expect(error.code).toBe('OFD_RENDERER_UNSUPPORTED');
    }
    renderer.close();
  });

  it('close 后 createImage 抛 OFD_CLOSED', () => {
    const { context } = createNodeCanvas(10, 10);
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    renderer.beginPage(context, viewport(10, 10));
    renderer.close();
    try {
      renderer.createImage({ width: 2, height: 2, data: solidImageData(2, 2, RED) });
      throw new Error('expected createImage to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OFDError);
      expect(isOFDError(error)).toBe(true);
      if (isOFDError(error)) expect(error.code).toBe('OFD_CLOSED');
    }
  });
});