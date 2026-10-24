/**
 * T15b 页面图片导出：整页离屏、背景/透明、浏览器原生编码、钩子、取消与上限。
 */

import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { OFDDocument } from '../../src/api/document';
import type { PageImageExportOptions, PageImageFormat } from '../../src/api/types';
import { OFDError, isOFDError } from '../../src/errors';
import type { OFDWarning } from '../../src/warnings';
import { RecordingRenderer } from '../../src/renderer/recording';
import type { Canvas2DLike, CanvasRenderingContext2DLike } from '../../src/renderer/types';
import { buildXmlDocument } from '../fixtures/xml';
import type { XmlElementSpec } from '../fixtures/xml';
import { buildFixtureOfd, createTestCanvas, createTestRenderer, openTestDocument } from './helpers';

/** 捕获 promise 拒绝并返回错误。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 100×100mm 单页，左上角 10mm 红色矩形。 */
function buildPageOfd(widthMm = 100, heightMm = 100): Uint8Array {
  const red: XmlElementSpec = {
    name: 'ofd:PathObject',
    attrs: { ID: 11, Boundary: '0 0 10 10', Fill: 'true', Stroke: 'false' },
    children: [
      { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'] },
      { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
    ],
  };
  return buildFixtureOfd({ pages: [{ id: 1, widthMm, heightMm, objects: [red] }] });
}

/** @napi-rs Canvas 与页面导出公共画布接口的交叉类型。 */
type NodeCanvas = Canvas & Canvas2DLike & {
  toBuffer(mime: string, quality?: number): Buffer;
};

/** 用 @napi-rs/canvas 编码导出画布。 */
function encodeWithNode(
  canvas: Canvas2DLike,
  format: PageImageFormat,
  quality: number,
): Promise<Uint8Array> {
  const node = canvas as NodeCanvas;
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  return Promise.resolve(new Uint8Array(node.toBuffer(mime, format === 'png' ? undefined : quality)));
}

/** 创建 Node 画布工厂。 */
function nodeCanvas(width: number, height: number): Canvas2DLike {
  return createCanvas(width, height) as unknown as Canvas2DLike;
}

/** 读取 PNG 像素 RGBA。 */
function pixelOf(png: PNG, x: number, y: number): [number, number, number, number] {
  const index = (y * png.width + x) * 4;
  return [
    png.data[index] ?? 0,
    png.data[index + 1] ?? 0,
    png.data[index + 2] ?? 0,
    png.data[index + 3] ?? 0,
  ];
}

/** 在导出画布上挂 convertToBlob。 */
function withConvertToBlob(canvas: Canvas2DLike, calls: Array<{ type?: string; quality?: number }>): Canvas2DLike {
  const node = canvas as NodeCanvas;
  Object.assign(canvas, {
    convertToBlob: async (options?: { type?: string; quality?: number }): Promise<Blob> => {
      calls.push(options ?? {});
      return new Blob([new Uint8Array(node.toBuffer('image/png'))], { type: options?.type ?? 'image/png' });
    },
  });
  return canvas;
}

/** 在导出画布上挂 toBlob。 */
function withToBlob(canvas: Canvas2DLike): Canvas2DLike {
  const node = canvas as NodeCanvas;
  Object.assign(canvas, {
    toBlob: (callback: (blob: Blob | null) => void, type?: string): void => {
      callback(new Blob([new Uint8Array(node.toBuffer('image/png'))], { type: type ?? 'image/png' }));
    },
  });
  return canvas;
}

describe('page.exportImage', () => {
  it('默认 PNG/96 DPI/白底，返回整页尺寸与 MIME', async () => {
    const seen: Array<{ format: PageImageFormat; quality: number }> = [];
    const doc = await openTestDocument(buildPageOfd(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => {
        seen.push({ format, quality });
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const result = await page.exportImage();
      expect(result.mime).toBe('image/png');
      expect(result.dpi).toBe(96);
      expect(result.width).toBe(378);
      expect(result.height).toBe(378);
      expect(Array.from(result.data.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(seen).toEqual([{ format: 'png', quality: 1 }]);
      const png = PNG.sync.read(Buffer.from(result.data));
      expect(png.width).toBe(378);
      expect(png.height).toBe(378);
      expect(pixelOf(png, 300, 300)).toEqual([255, 255, 255, 255]);
      expect(pixelOf(png, 10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('JPEG 使用规范化质量并返回 image/jpeg', async () => {
    const seen: Array<{ format: PageImageFormat; quality: number }> = [];
    const doc = await openTestDocument(buildPageOfd(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => {
        seen.push({ format, quality });
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const result = await page.exportImage({ dpi: 144, format: 'jpeg', quality: 0.5 });
      expect(result.mime).toBe('image/jpeg');
      expect(result.dpi).toBe(144);
      expect(result.width).toBe(Math.ceil((100 * 144) / 25.4));
      expect(seen).toEqual([{ format: 'jpeg', quality: 0.5 }]);
      expect(Array.from(result.data.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    } finally {
      await doc.close();
    }
  });

  it('PNG background:null 透明；JPEG null 回退白底', async () => {
    let jpegCorner: [number, number, number, number] | undefined;
    const doc = await openTestDocument(buildPageOfd(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => {
        if (format === 'jpeg') {
          const context = (canvas as NodeCanvas).getContext('2d');
          const data = context.getImageData(300, 300, 1, 1).data;
          jpegCorner = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
        }
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const transparent = await page.exportImage({ background: null });
      const png = PNG.sync.read(Buffer.from(transparent.data));
      expect(pixelOf(png, 300, 300)[3]).toBe(0);
      expect(pixelOf(png, 10, 10)).toEqual([255, 0, 0, 255]);

      await page.exportImage({ format: 'jpeg', background: null });
      expect(jpegCorner).toEqual([255, 255, 255, 255]);
    } finally {
      await doc.close();
    }
  });

  it('非法背景色回退白底；非法 DPI/质量回退默认值', async () => {
    const seen: Array<{ format: PageImageFormat; quality: number }> = [];
    const doc = await openTestDocument(buildPageOfd(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => {
        seen.push({ format, quality });
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const result = await page.exportImage({
        dpi: 0,
        format: 'jpeg',
        quality: Number.NaN,
        background: 'not-a-color',
      });
      expect(result.dpi).toBe(96);
      expect(seen).toEqual([{ format: 'jpeg', quality: 0.92 }]);
    } finally {
      await doc.close();
    }
  });

  it('浏览器 convertToBlob 优先于 toBlob', async () => {
    const calls: Array<{ type?: string; quality?: number }> = [];
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: (width, height) => withConvertToBlob(nodeCanvas(width, height), calls),
    });
    try {
      const page = await doc.getPage(0);
      const result = await page.exportImage({ format: 'webp', quality: 0.6 });
      expect(result.mime).toBe('image/webp');
      expect(calls).toEqual([{ type: 'image/webp', quality: 0.6 }]);
      expect(result.data.byteLength).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });

  it('无 convertToBlob 时使用 toBlob', async () => {
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: (width, height) => withToBlob(nodeCanvas(width, height)),
    });
    try {
      const page = await doc.getPage(0);
      const result = await page.exportImage();
      expect(result.mime).toBe('image/png');
      expect(result.data.byteLength).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });

  it('显式 renderer 时仍使用 open 的 createCanvas/encodeImage', async () => {
    let encoded = 0;
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => {
        encoded += 1;
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const result = await page.exportImage();
      expect(result.mime).toBe('image/png');
      expect(encoded).toBe(1);
    } finally {
      await doc.close();
    }
  });

  it('缺少编码器时报 OFD_RENDERER_UNSUPPORTED，不静默返回空图', async () => {
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: (width, height) => {
        const canvas = nodeCanvas(width, height) as Canvas2DLike & {
          convertToBlob?: unknown;
          toBlob?: unknown;
        };
        // 模拟既无浏览器原生编码、也无 Node 钩子的最小宿主画布。
        canvas.convertToBlob = undefined;
        canvas.toBlob = undefined;
        return canvas;
      },
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage());
      expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
      expect((error as OFDError).message).toContain('编码器');
    } finally {
      await doc.close();
    }
  });

  it('createCanvas 返回尺寸不符时报 OFD_CANVAS_SIZE_MISMATCH', async () => {
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: (width, height) => {
        const node = createCanvas(width, height);
        return {
          get width() {
            return node.width - 1;
          },
          set width(value: number) {
            node.width = value;
          },
          get height() {
            return node.height;
          },
          set height(value: number) {
            node.height = value;
          },
          getContext: (type: '2d', options?: { alpha?: boolean; willReadFrequently?: boolean }) =>
            node.getContext(type, options) as unknown as CanvasRenderingContext2DLike | null,
        };
      },
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage());
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
    } finally {
      await doc.close();
    }
  });

  it('编码钩子抛错或返回空字节统一为 OFD_RENDERER_UNSUPPORTED 并保留 cause', async () => {
    const boom = new Error('encode boom');
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async () => {
        throw boom;
      },
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage());
      expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
      expect((error as OFDError).cause).toBe(boom);
    } finally {
      await doc.close();
    }

    const emptyDoc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async () => new Uint8Array(),
    });
    try {
      const page = await emptyDoc.getPage(0);
      const error = await rejectOf(page.exportImage());
      expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
      expect((error as OFDError).message).toContain('无效图片');
    } finally {
      await emptyDoc.close();
    }
  });

  it('导出前检查 maxCanvasPixels，超限不创建画布', async () => {
    let created = 0;
    const doc = await openTestDocument(buildPageOfd(), {
      limits: { maxCanvasPixels: 1000 },
      createCanvas: (width, height) => {
        created += 1;
        return nodeCanvas(width, height);
      },
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage());
      expect(errorCode(error)).toBe('OFD_CANVAS_TOO_LARGE');
      expect(created).toBe(0);
    } finally {
      await doc.close();
    }
  });

  it('开始前已取消返回 OFD_ABORTED，不创建画布/不编码', async () => {
    const controller = new AbortController();
    controller.abort();
    let created = 0;
    let encoded = 0;
    const doc = await openTestDocument(buildPageOfd(), {
      createCanvas: (width, height) => {
        created += 1;
        return nodeCanvas(width, height);
      },
      encodeImage: async (canvas, format, quality) => {
        encoded += 1;
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage({ signal: controller.signal }));
      expect(errorCode(error)).toBe('OFD_ABORTED');
      expect(created).toBe(0);
      expect(encoded).toBe(0);
    } finally {
      await doc.close();
    }
  });

  it('render 后取消不进入编码阶段', async () => {
    const controller = new AbortController();
    class AbortOnEndRenderer extends RecordingRenderer {
      override endPage(): void {
        controller.abort();
        super.endPage();
      }
    }
    let encoded = 0;
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new AbortOnEndRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => {
        encoded += 1;
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage({ signal: controller.signal }));
      expect(errorCode(error)).toBe('OFD_ABORTED');
      expect(encoded).toBe(0);
    } finally {
      await doc.close();
    }
  });

  it('编码期间取消不返回字节', async () => {
    const controller = new AbortController();
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async () => {
        controller.abort();
        return Uint8Array.from([1, 2, 3]);
      },
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage({ signal: controller.signal }));
      expect(errorCode(error)).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('编码期间 close 以 OFD_CLOSED 拒绝且 close 可完成', async () => {
    let doc: OFDDocument | undefined;
    doc = await openTestDocument(buildPageOfd(), {
      renderer: new RecordingRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async () => {
        void doc?.close();
        return Uint8Array.from([1, 2, 3]);
      },
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(page.exportImage());
      expect(errorCode(error)).toBe('OFD_CLOSED');
      await doc.close();
      await expect(page.exportImage()).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    } finally {
      await doc.close();
    }
  });

  it('viewport 3 位归一化：228.6mm 导出 864px，864.3px 仍 ceil 到 865', async () => {
    const encodeImage = async (canvas: Canvas2DLike, format: PageImageFormat, quality: number) =>
      encodeWithNode(canvas, format, quality);
    const normal = await openTestDocument(buildPageOfd(228.6, 228.6), {
      createCanvas: nodeCanvas,
      encodeImage,
    });
    try {
      const page = await normal.getPage(0);
      const result = await page.exportImage();
      expect(result.width).toBe(864);
      expect(result.height).toBe(864);
      expect(result.dpi).toBe(96);
    } finally {
      await normal.close();
    }

    const widthMm = 864.3 / (96 / 25.4);
    const fractional = await openTestDocument(buildPageOfd(widthMm, widthMm), {
      createCanvas: nodeCanvas,
      encodeImage,
    });
    try {
      const page = await fractional.getPage(0);
      const result = await page.exportImage();
      expect(result.width).toBe(865);
      expect(result.height).toBe(865);
    } finally {
      await fractional.close();
    }
  });

  it('非法格式报 OFD_RENDERER_UNSUPPORTED', async () => {
    const doc = await openTestDocument(buildPageOfd(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      const error = await rejectOf(
        page.exportImage({ format: 'gif' as unknown as PageImageFormat }),
      );
      expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
    } finally {
      await doc.close();
    }
  });

  it('rotation 支持 0/90/180/270：尺寸/方向/背景正确，编码钩子收到输出画布', async () => {
    const encodedSizes: Array<{ width: number; height: number }> = [];
    const doc = await openTestDocument(buildPageOfd(100, 50), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => {
        encodedSizes.push({ width: canvas.width, height: canvas.height });
        return encodeWithNode(canvas, format, quality);
      },
    });
    try {
      const page = await doc.getPage(0);
      const cases: Array<{
        rotation: PageImageExportOptions['rotation'];
        width: number;
        height: number;
        red: [number, number];
        whiteCorners: Array<[number, number]>;
      }> = [
        {
          rotation: undefined,
          width: 378,
          height: 189,
          red: [10, 10],
          whiteCorners: [[377, 0], [0, 188], [377, 188]],
        },
        {
          rotation: 0,
          width: 378,
          height: 189,
          red: [10, 10],
          whiteCorners: [[377, 0], [0, 188], [377, 188]],
        },
        {
          rotation: 90,
          width: 189,
          height: 378,
          red: [188, 0],
          whiteCorners: [[0, 0], [0, 377], [188, 377]],
        },
        {
          rotation: 180,
          width: 378,
          height: 189,
          red: [377, 188],
          whiteCorners: [[0, 0], [377, 0], [0, 188]],
        },
        {
          rotation: 270,
          width: 189,
          height: 378,
          red: [0, 377],
          whiteCorners: [[0, 0], [188, 0], [188, 377]],
        },
      ];

      for (const item of cases) {
        const result = await page.exportImage(
          item.rotation === undefined ? {} : { rotation: item.rotation },
        );
        expect(result.width).toBe(item.width);
        expect(result.height).toBe(item.height);
        expect(encodedSizes.at(-1)).toEqual({ width: item.width, height: item.height });
        const png = PNG.sync.read(Buffer.from(result.data));
        expect(png.width).toBe(item.width);
        expect(png.height).toBe(item.height);
        expect(pixelOf(png, ...item.red)).toEqual([255, 0, 0, 255]);
        for (const [x, y] of item.whiteCorners) {
          expect(pixelOf(png, x, y)).toEqual([255, 255, 255, 255]);
        }
      }
      expect(encodedSizes).toHaveLength(cases.length);
    } finally {
      await doc.close();
    }
  });

  it('rotation 90 + 透明背景：四角保持透明，不产生黑边', async () => {
    const doc = await openTestDocument(buildPageOfd(100, 50), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      const result = await page.exportImage({ rotation: 90, background: null });
      expect(result.width).toBe(189);
      expect(result.height).toBe(378);
      const png = PNG.sync.read(Buffer.from(result.data));
      for (const [x, y] of [[0, 0], [0, 377], [188, 377]] as const) {
        expect(pixelOf(png, x, y)[3]).toBe(0);
      }
      expect(pixelOf(png, 188, 0)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('非法 rotation warning 并回退 0；不改变页面尺寸/正常渲染参数', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(buildPageOfd(100, 50), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      const page = await doc.getPage(0);
      const before = page.getSize();
      const result = await page.exportImage({ rotation: 45 as unknown as 0 });
      expect(result.width).toBe(378);
      expect(result.height).toBe(189);
      expect(warnings.some((warning) => warning.code === 'W_BAD_NUMBER')).toBe(true);
      expect(page.getSize()).toEqual(before);
      const png = PNG.sync.read(Buffer.from(result.data));
      expect(pixelOf(png, 10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('不改变 page.render 的现有画布行为', async () => {
    const doc = await openTestDocument(buildPageOfd(), {
      renderer: createTestRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      const canvas = createCanvas(400, 400) as unknown as Canvas2DLike;
      canvas.getContext('2d');
      const viewport = page.getViewport();
      const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2DLike;
      await page.render({
        canvasContext: context,
        viewport: { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), dpi: 96 },
      }).promise;
      expect(canvas.width).toBe(400);
      expect(canvas.height).toBe(400);
    } finally {
      await doc.close();
    }
  });
});

describe('page.exportImage contentFilter', () => {
  /** 通过导出结果的 PNG 采样判断正文/注释是否绘制。 */
  function exportedContent(data: Uint8Array): { body: boolean; annotation: boolean } {
    const png = PNG.sync.read(Buffer.from(data));
    return {
      body: pixelOf(png, 10, 10).slice(0, 3).join(',') === '255,0,0',
      annotation: pixelOf(png, 220, 220).slice(0, 3).join(',') === '0,255,0',
    };
  }

  it('contentFilter 透传到内部 renderPage：只导出白名单内容', async () => {
    const doc = await openTestDocument(buildExportFilterOfd(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      // 不传：全画。
      expect(exportedContent((await page.exportImage()).data)).toEqual({
        body: true,
        annotation: true,
      });
      // 只画正文层页面内容。
      expect(exportedContent((await page.exportImage({ contentFilter: { layers: { body: true } } })).data)).toEqual({
        body: true,
        annotation: false,
      });
      // 只画注释类型白名单，正文不画。
      expect(
        exportedContent((await page.exportImage({ contentFilter: { annotationTypes: ['Highlight'] } })).data),
      ).toEqual({ body: false, annotation: true });
      // 空白页。
      expect(exportedContent((await page.exportImage({ contentFilter: {} })).data)).toEqual({
        body: false,
        annotation: false,
      });
    } finally {
      await doc.close();
    }
  });

  it('导出不继承上一次 render 的过滤：不传 contentFilter 时仍全画', async () => {
    const doc = await openTestDocument(buildExportFilterOfd(), {
      renderer: createTestRenderer(),
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(378, 378);
      await page.render({
        canvasContext: canvas.context,
        viewport: { width: 378, height: 378, dpi: 96 },
        contentFilter: {},
      }).promise;
      // 上一次 render 是空白页；导出不传过滤仍应全画。
      expect(exportedContent((await page.exportImage()).data)).toEqual({
        body: true,
        annotation: true,
      });
    } finally {
      await doc.close();
    }
  });

  it('每次导出独立：上一次导出过滤不影响下一次', async () => {
    const doc = await openTestDocument(buildExportFilterOfd(), {
      createCanvas: nodeCanvas,
      encodeImage: async (canvas, format, quality) => encodeWithNode(canvas, format, quality),
    });
    try {
      const page = await doc.getPage(0);
      await page.exportImage({ contentFilter: { layers: { body: true } } });
      expect(exportedContent((await page.exportImage()).data)).toEqual({
        body: true,
        annotation: true,
      });
      expect(exportedContent((await page.exportImage({ contentFilter: { signatures: true } })).data)).toEqual({
        body: false,
        annotation: false,
      });
    } finally {
      await doc.close();
    }
  });
});

/**
 * 合成 100×100mm 单页：正文层红色矩形 + 绿色 Highlight 注释。
 *
 * @returns OFD ZIP 字节。
 */
function buildExportFilterOfd(): Uint8Array {
  const annotationRoot: XmlElementSpec = {
    name: 'ofd:PageAnnot',
    attrs: { 'xmlns:ofd': 'http://www.ofdspec.org/2016' },
    children: [
      {
        name: 'ofd:Annot',
        attrs: { ID: 100, Type: 'Highlight' },
        children: [
          {
            name: 'ofd:Appearance',
            attrs: { Boundary: '50 50 20 20' },
            children: [
              {
                name: 'ofd:PathObject',
                attrs: { ID: 101, Boundary: '0 0 20 20', Fill: 'true', Stroke: 'false' },
                children: [
                  { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 20 0 L 20 20 L 0 20 Z'] },
                  { name: 'ofd:FillColor', attrs: { Value: '0 255 0' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  return buildFixtureOfd({
    pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [
      {
        name: 'ofd:PathObject',
        attrs: { ID: 11, Boundary: '0 0 10 10', Fill: 'true', Stroke: 'false' },
        children: [
          { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'] },
          { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
        ],
      },
    ] }],
    annotations: {
      files: [{ pageId: 1, filePath: 'Annots/Page_1.xml' }],
      entries: [{ name: 'Doc_0/Annots/Page_1.xml', data: buildXmlDocument(annotationRoot) }],
    },
  });
}
