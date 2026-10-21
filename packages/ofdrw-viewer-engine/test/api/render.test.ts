/**
 * T7 渲染任务：像素输出、尺寸校验、取消、同 Canvas 串行与关闭语义。
 */

import { describe, expect, it } from 'vitest';
import { OFDError, isOFDError } from '../../src/errors';
import {
  buildFixtureOfd,
  createTestCanvas,
  openTestDocument,
  renderPage,
  trackRenderer,
  createTestRenderer,
} from './helpers';
import type { XmlElementSpec } from '../fixtures/xml';

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
function buildPageOfd(): Uint8Array {
  const red: XmlElementSpec = {
    name: 'ofd:PathObject',
    attrs: {
      ID: 11,
      Boundary: '0 0 10 10',
      Fill: 'true',
      Stroke: 'false',
    },
    children: [
      {
        name: 'ofd:AbbreviatedData',
        children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'],
      },
      { name: 'ofd:FillColor', attrs: { Value: '255 0 0' } },
    ],
  };
  return buildFixtureOfd({ pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [red] }] });
}

describe('页面渲染', () => {
  it('按 viewport 绘制且不改变 canvas 尺寸/背景', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      expect(page.getSize()).toEqual({ width: 100, height: 100 });
      const { canvas, viewport } = await renderPage(page, { dpi: 300 });
      expect(canvas.canvas.width).toBe(Math.ceil(viewport.width));
      expect(canvas.canvas.height).toBe(Math.ceil(viewport.height));
      // 10mm ≈ 118px；取左上角内部像素。
      expect(canvas.pixel(10, 10)).toEqual([255, 0, 0, 255]);
      // 矩形外保持宿主预置的白底。
      expect(canvas.pixel(400, 400)).toEqual([255, 255, 255, 255]);
    } finally {
      await doc.close();
    }
  });

  it('canvas 小于 viewport 返回 OFD_CANVAS_SIZE_MISMATCH', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport();
      const small = createTestCanvas(100, 100);
      const task = page.render({
        canvasContext: small.context,
        viewport: { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), dpi: 96 },
      });
      const error = await rejectOf(task.promise);
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
    } finally {
      await doc.close();
    }
  });

  it('viewport 超过 maxCanvasPixels 返回 OFD_CANVAS_TOO_LARGE', async () => {
    const doc = await openTestDocument(buildPageOfd(), {
      limits: { maxCanvasPixels: 1000 },
    });
    try {
      const page = await doc.getPage(0);
      const viewport = page.getViewport();
      const canvas = createTestCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const error = await rejectOf(
        page.render({
          canvasContext: canvas.context,
          viewport: { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), dpi: 96 },
        }).promise,
      );
      expect(errorCode(error)).toBe('OFD_CANVAS_TOO_LARGE');
    } finally {
      await doc.close();
    }
  });

  it('非法 viewport 返回 OFD_CANVAS_SIZE_MISMATCH', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(400, 400);
      const error = await rejectOf(
        page.render({
          canvasContext: canvas.context,
          viewport: { width: 0, height: Number.NaN, dpi: 96 },
        }).promise,
      );
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
    } finally {
      await doc.close();
    }
  });

  it('task.cancel() 以 OFD_ABORTED 结束', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(378, 378);
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      });
      task.cancel();
      const error = await rejectOf(task.promise);
      expect(error).toBeInstanceOf(OFDError);
      expect(errorCode(error)).toBe('OFD_ABORTED');
      // 重复取消无副作用。
      task.cancel();
    } finally {
      await doc.close();
    }
  });

  it('宿主 AbortSignal 预先中止时以 OFD_ABORTED 结束', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(378, 378);
      const controller = new AbortController();
      controller.abort();
      const error = await rejectOf(
        page.render({
          canvasContext: canvas.context,
          viewport: { width: 378, height: 378, dpi: 96 },
          signal: controller.signal,
        }).promise,
      );
      expect(errorCode(error)).toBe('OFD_ABORTED');
    } finally {
      await doc.close();
    }
  });

  it('同一 Canvas 的并发渲染串行执行', async () => {
    const tracked = trackRenderer(createTestRenderer());
    const doc = await openTestDocument(buildPageOfd(), { renderer: tracked.renderer });
    try {
      const page = await doc.getPage(0);
      const canvas = createTestCanvas(378, 378);
      const viewport = { width: 378, height: 378, dpi: 96 };
      const first = page.render({ canvasContext: canvas.context, viewport });
      const second = page.render({ canvasContext: canvas.context, viewport });
      await Promise.all([first.promise, second.promise]);
      expect(tracked.stats.begin).toBe(2);
      expect(tracked.stats.end).toBe(2);
      expect(tracked.stats.maxConcurrent).toBe(1);
      expect(canvas.pixel(10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('不同 Canvas 的渲染互不影响', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const a = createTestCanvas(378, 378);
      const b = createTestCanvas(378, 378);
      const viewport = { width: 378, height: 378, dpi: 96 };
      await Promise.all([
        page.render({ canvasContext: a.context, viewport }).promise,
        page.render({ canvasContext: b.context, viewport }).promise,
      ]);
      expect(a.pixel(10, 10)).toEqual([255, 0, 0, 255]);
      expect(b.pixel(10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });

  it('close() 幂等，关闭后 getPage/render 返回 OFD_CLOSED', async () => {
    const doc = await openTestDocument(buildPageOfd());
    const page = await doc.getPage(0);
    await doc.close();
    await doc.close();
    const pageError = await rejectOf(doc.getPage(0));
    expect(errorCode(pageError)).toBe('OFD_CLOSED');
    const canvas = createTestCanvas(378, 378);
    const renderError = await rejectOf(
      page.render({
        canvasContext: canvas.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      }).promise,
    );
    expect(errorCode(renderError)).toBe('OFD_CLOSED');
  });

  it('close() 中止进行中的渲染', async () => {
    const doc = await openTestDocument(buildPageOfd());
    const page = await doc.getPage(0);
    const canvas = createTestCanvas(378, 378);
    const task = page.render({
      canvasContext: canvas.context,
      viewport: { width: 378, height: 378, dpi: 96 },
    });
    await doc.close();
    const error = await rejectOf(task.promise);
    // close 与 render 的竞态：未开始校验时为 OFD_CLOSED，已进入准备/绘制时为 OFD_ABORTED。
    expect(['OFD_ABORTED', 'OFD_CLOSED']).toContain(errorCode(error));
  });

  it('渲染失败后可继续渲染（串行链不会卡死）', async () => {
    const doc = await openTestDocument(buildPageOfd());
    try {
      const page = await doc.getPage(0);
      const small = createTestCanvas(50, 50);
      const failed = page.render({
        canvasContext: small.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      });
      await rejectOf(failed.promise);
      const ok = createTestCanvas(378, 378);
      await page.render({
        canvasContext: ok.context,
        viewport: { width: 378, height: 378, dpi: 96 },
      }).promise;
      expect(ok.pixel(10, 10)).toEqual([255, 0, 0, 255]);
    } finally {
      await doc.close();
    }
  });
});