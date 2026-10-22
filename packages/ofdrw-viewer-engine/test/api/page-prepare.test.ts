/**
 * T17b：page.prepare 预取、幂等/并发去重、无 canvas 副作用与取消/关闭。
 */

import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { ImageDecoderPlugin } from '../../src/platform/image-decoder';
import type { Canvas2DLike } from '../../src/renderer/types';
import type { XmlElementSpec } from '../fixtures/xml';
import { createNodeImageDecoderPlugin } from '../helpers/node-image-decoder';
import {
  buildFixtureOfd,
  buildImageOfd,
  createTestCanvas,
  openTestDocument,
  renderPage,
} from './helpers';
import { isOFDError } from '../../src/errors';

/** 取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 捕获 promise 拒绝。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 100×100mm 单页，左上角 10mm 红色矩形。 */
function buildPageOfd(): Uint8Array {
  const red: XmlElementSpec = {
    name: 'ofd:PathObject',
    attrs: { ID: 11, Boundary: '0 0 10 10', Fill: 'true', Stroke: 'false' },
    children: [
      { name: 'ofd:AbbreviatedData', children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'] },
      { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
    ],
  };
  return buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [red] }] });
}

describe('page.prepare', () => {
  it('预取不创建 canvas，幂等且可重复调用', async () => {
    let canvasCalls = 0;
    const doc = await openTestDocument(buildPageOfd(), {
      createCanvas: (width, height) => {
        canvasCalls += 1;
        return createCanvas(width, height) as unknown as Canvas2DLike;
      },
    });
    try {
      const page = await doc.getPage(0);
      await page.prepare();
      expect(canvasCalls).toBe(0);
      await page.prepare();
      await Promise.all([page.prepare(), page.prepare(), page.prepare()]);
      expect(canvasCalls).toBe(0);
    } finally {
      await doc.close();
    }
  });

  it('prepare 后 render 复用 bundle，图片只解码一次且结果一致', async () => {
    const base = createNodeImageDecoderPlugin('png');
    let decodeCount = 0;
    const pngDecoder: ImageDecoderPlugin = {
      format: 'png',
      async decode(data) {
        decodeCount += 1;
        return base.decode(data);
      },
    };
    const preparedDoc = await openTestDocument(buildImageOfd(), {
      imageDecoders: [pngDecoder],
    });
    const plainDoc = await openTestDocument(buildImageOfd(), {
      imageDecoders: [pngDecoder],
    });
    try {
      const preparedPage = await preparedDoc.getPage(0);
      await preparedPage.prepare();
      expect(decodeCount).toBe(1);
      const prepared = await renderPage(preparedPage);
      expect(decodeCount).toBe(1);

      const plainPage = await plainDoc.getPage(0);
      const plain = await renderPage(plainPage);
      expect(prepared.canvas.pixel(60, 60)).toEqual(plain.canvas.pixel(60, 60));
      expect(prepared.canvas.pixel(10, 10)).toEqual(plain.canvas.pixel(10, 10));
    } finally {
      await preparedDoc.close();
      await plainDoc.close();
    }
  });

  it('并发 prepare 只预取一次', async () => {
    const base = createNodeImageDecoderPlugin('png');
    let decodeCount = 0;
    const pngDecoder: ImageDecoderPlugin = {
      format: 'png',
      async decode(data) {
        decodeCount += 1;
        return base.decode(data);
      },
    };
    const doc = await openTestDocument(buildImageOfd(), { imageDecoders: [pngDecoder] });
    try {
      const page = await doc.getPage(0);
      await Promise.all([page.prepare(), page.prepare(), page.prepare()]);
      expect(decodeCount).toBe(1);
    } finally {
      await doc.close();
    }
  });

  it('abort 与 close 拒绝', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const controller = new AbortController();
      controller.abort();
      expect(errorCode(await rejectOf(page.prepare({ signal: controller.signal })))).toBe(
        'OFD_ABORTED',
      );
      await page.prepare();
      await doc.close();
      expect(errorCode(await rejectOf(page.prepare()))).toBe('OFD_CLOSED');
    } finally {
      await doc.close();
    }
  });

  it('准备过程中 abort 返回 OFD_ABORTED，不污染后续 prepare', async () => {
    const doc = await openTestDocument(buildImageOfd());
    try {
      const page = await doc.getPage(0);
      const controller = new AbortController();
      const pending = page.prepare({ signal: controller.signal });
      controller.abort();
      expect(errorCode(await rejectOf(pending))).toBe('OFD_ABORTED');
      await expect(page.prepare()).resolves.toBeUndefined();
    } finally {
      await doc.close();
    }
  });

  it('关闭中的 prepare 以 OFD_CLOSED 结束', async () => {
    const doc = await openTestDocument(buildImageOfd());
    try {
      const page = await doc.getPage(0);
      const preparing = page.prepare();
      const closing = doc.close();
      const results = await Promise.allSettled([preparing, closing]);
      expect(results[1]?.status).toBe('fulfilled');
      if (results[0]?.status === 'rejected') {
        expect(errorCode(results[0].reason)).toBe('OFD_CLOSED');
      } else {
        // 页面可能已在 close 前完成；无论哪种都不应留下未处理 rejection。
        expect(results[0]?.status).toBe('fulfilled');
      }
    } finally {
      await doc.close();
    }
  });
});
