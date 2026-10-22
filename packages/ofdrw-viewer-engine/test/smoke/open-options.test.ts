/**
 * T14m smoke：OFDOpenOptions.createCanvas 的兼容入口。
 *
 * 验证默认 H5 渲染器能通过公共 open 参数拿到画布，并验证未注入时仍可
 * 使用 document fallback 打开/渲染；这里只覆盖兼容路径，不实现矢量章。
 */

import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  OFDDocument,
  type Canvas2DLike,
  type CanvasRenderingContext2DLike,
  type OFDPage,
} from 'ofdrw-viewer-engine';
import { buildFixtureOfd } from '../api/helpers';

/** 最小合成 OFD；红矩形位于 (20,20)-(120,70) mm。 */
const FIXTURE = buildFixtureOfd({
  pages: [
    {
      id: 1,
      widthMm: 210,
      heightMm: 297,
      objects: [
        {
          name: 'ofd:PathObject',
          attrs: { ID: 11, Boundary: '20 20 100 50', Fill: 'true', Stroke: 'false' },
          children: [
            {
              name: 'ofd:AbbreviatedData',
              children: ['M 0 0 L 100 0 L 100 50 L 0 50 Z'],
            },
            { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
          ],
        },
      ],
    },
  ],
});

/** 创建测试画布并读取像素。 */
function createTarget(width: number, height: number): {
  context: CanvasRenderingContext2DLike;
  pixel(x: number, y: number): [number, number, number, number];
} {
  const canvas = createCanvas(width, height);
  const raw = canvas.getContext('2d');
  const context = raw as unknown as CanvasRenderingContext2DLike;
  return {
    context,
    pixel(x, y) {
      const data = raw.getImageData(x, y, 1, 1).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
    },
  };
}

/** 按页 viewport 创建目标画布并渲染。 */
async function renderPage(page: OFDPage): Promise<ReturnType<typeof createTarget>> {
  const viewport = page.getViewport();
  const target = createTarget(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: target.context, viewport }).promise;
  return target;
}

describe('OFDOpenOptions.createCanvas', () => {
  it('未提供 createCanvas 时不改变默认 open/render 行为', async () => {
    // Node 没有 document/OffscreenCanvas。模拟浏览器默认工厂，验证缺省路径仍走
    // document.createElement('canvas')，而不是被 r7 新字段改变。
    const globalWithDocument = globalThis as unknown as {
      document?: { createElement(tag: string): Canvas2DLike };
    };
    const previous = globalWithDocument.document;
    globalWithDocument.document = {
      createElement: () => createCanvas(1, 1) as unknown as Canvas2DLike,
    };
    try {
      const doc = await OFDDocument.open({
        source: { kind: 'arraybuffer', data: FIXTURE },
      });
      try {
        const page = await doc.getPage(0);
        const target = await renderPage(page);
        expect(target.pixel(100, 100)).toEqual([255, 0, 0, 255]);
      } finally {
        await doc.close();
      }
    } finally {
      if (previous === undefined) delete globalWithDocument.document;
      else globalWithDocument.document = previous;
    }
  });

  it('提供 createCanvas 时默认 H5 渲染器可用且渲染成功', async () => {
    const calls: Array<{ width: number; height: number }> = [];
    const doc = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: FIXTURE },
      createCanvas: (width, height) => {
        calls.push({ width, height });
        return createCanvas(width, height) as unknown as Canvas2DLike;
      },
    });
    try {
      const page = await doc.getPage(0);
      const target = await renderPage(page);
      expect(target.pixel(100, 100)).toEqual([255, 0, 0, 255]);
      // 简单页可能不需要临时画布；有调用时必须是正整数像素。
      for (const call of calls) {
        expect(call.width).toBeGreaterThan(0);
        expect(call.height).toBeGreaterThan(0);
      }
    } finally {
      await doc.close();
    }
  });
});
