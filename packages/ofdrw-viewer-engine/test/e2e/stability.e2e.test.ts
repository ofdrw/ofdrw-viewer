/**
 * T9 稳定性/安全回归：500 页循环、重复 close、快速取消/重渲染、恶意包拒绝。
 *
 * 只通过公共 API 驱动；所有样本均为仓库内脱敏样本或内存合成包。
 * 结果写入 `test/.artifacts/t9b/stability.json`，供 T9b 回归报告引用。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import { OFDDocument } from '../../src/api/document';
import type { OFDPage } from '../../src/api/page';
import { isOFDError } from '../../src/errors';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import type { Canvas2DLike, CanvasRenderingContext2DLike } from '../../src/renderer/types';
import { nodeImageDecoders } from '../helpers/node-image-decoder';
import { buildImageOfd } from '../api/helpers';
import { buildMinimalOfd } from '../fixtures/ofd-builder';
import { createZip } from '../fixtures/zip-builder';
import { readZipEntries } from '../fixtures/zip-inspector';

const ARTIFACT_DIR = resolve(process.cwd(), '../../test/.artifacts/t9b');
const SAMPLE_DIR = resolve(process.cwd(), '../../ofd_pdf_match');
const data: Record<string, unknown> = {};

/** 生成 Node canvas 渲染器。 */
function createRenderer(): H5Canvas2DRenderer {
  return new H5Canvas2DRenderer({
    createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
  });
}

/**
 * 打开样本文件。
 *
 * @param name 样本名（不含扩展名）。
 * @returns 文档。
 */
async function openSample(name: string): Promise<OFDDocument> {
  const bytes = new Uint8Array(readFileSync(resolve(SAMPLE_DIR, `${name}.ofd`)));
  return OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    renderer: createRenderer(),
    imageDecoders: [...nodeImageDecoders],
  });
}

/**
 * 渲染一页到新画布。
 *
 * @param page 页面。
 * @returns 渲染耗时，ms。
 */
async function renderPage(page: OFDPage): Promise<number> {
  const viewport = page.getViewport({ dpi: 96 });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const started = performance.now();
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2DLike,
    viewport: { width, height, dpi: 96 },
  }).promise;
  return performance.now() - started;
}

/** 强制 GC（仅当 Node 以 --expose-gc 启动）。 */
function gc(): void {
  const candidate = (globalThis as { gc?: () => void }).gc;
  candidate?.();
}

afterAll(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(resolve(ARTIFACT_DIR, 'stability.json'), JSON.stringify(data, null, 2), 'utf8');
});

describe('稳定性与资源安全', () => {
  it('连续渲染 500 页：无崩溃、内存不持续增长', async () => {
    const doc = await openSample('doc1File');
    const pageCount = doc.pageCount;
    const heapBefore = process.memoryUsage().heapUsed;
    const heapSamples: number[] = [];
    const renderTimes: number[] = [];
    for (let index = 0; index < 500; index += 1) {
      renderTimes.push(await renderPage(await doc.getPage(index % pageCount)));
      if ((index + 1) % 100 === 0) {
        gc();
        heapSamples.push(process.memoryUsage().heapUsed);
      }
    }
    await doc.close();
    gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const peak = Math.max(...heapSamples, heapBefore);
    data.render500 = {
      sample: 'doc1File',
      pages: 500,
      pageCount,
      minMs: Math.min(...renderTimes),
      maxMs: Math.max(...renderTimes),
      avgMs: renderTimes.reduce((sum, value) => sum + value, 0) / renderTimes.length,
      heapBefore,
      heapSamples,
      heapAfter,
      peak,
      gcAvailable: typeof (globalThis as { gc?: unknown }).gc === 'function',
    };
    expect(renderTimes).toHaveLength(500);
    expect(peak - heapBefore).toBeLessThan(512 * 1024 * 1024);
  }, 300_000);

  it('重复 close 幂等，close 后拒绝继续取页', async () => {
    const cycles: Array<{ closeMs: number }> = [];
    let last: OFDDocument | null = null;
    for (let index = 0; index < 20; index += 1) {
      const doc = await openSample('hello');
      const started = performance.now();
      await doc.close();
      cycles.push({ closeMs: performance.now() - started });
      last = doc;
    }
    await last!.close();
    let closedCode: string | undefined;
    try {
      await last!.getPage(0);
    } catch (error) {
      closedCode = isOFDError(error) ? error.code : 'non-OFD-error';
    }
    data.close = {
      cycles: cycles.length,
      maxCloseMs: Math.max(...cycles.map((item) => item.closeMs)),
      closedCode,
      doubleCloseOk: true,
    };
    expect(cycles).toHaveLength(20);
    expect(closedCode).toBe('OFD_CLOSED');
  }, 120_000);

  it('快速取消与同画布重渲染不会留下悬挂任务', async () => {
    const doc = await openSample('dense-text-perf');
    const page = await doc.getPage(0);
    const viewport = page.getViewport({ dpi: 96 });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2DLike;
    const outcomes: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const task = page.render({
        canvasContext: context,
        viewport: { width, height, dpi: 96 },
      });
      task.cancel();
      try {
        await task.promise;
        outcomes.push('completed');
      } catch (error) {
        outcomes.push(isOFDError(error) ? error.code : 'other');
      }
    }
    const successMs = await renderPage(page);
    data.cancel = {
      attempts: outcomes.length,
      outcomes,
      successAfterCancelMs: successMs,
    };
    await doc.close();
    expect(outcomes.filter((value) => value === 'OFD_ABORTED').length).toBeGreaterThan(0);
    expect(successMs).toBeGreaterThan(0);
  }, 120_000);

  it('恶意 ZIP/XML/图片样本在限制内拒绝且不崩溃', async () => {
    const cases: Array<{ name: string; expected: string; actual?: string; ok: boolean }> = [];
    const record = async (name: string, expected: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
        cases.push({ name, expected, actual: 'resolved', ok: false });
      } catch (error) {
        const actual = isOFDError(error) ? error.code : error instanceof Error ? error.message : String(error);
        cases.push({ name, expected, actual, ok: actual === expected });
      }
    };

    await record('随机字节非 ZIP', 'OFD_INVALID_PACKAGE', async () => {
      await OFDDocument.open({ source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3]) } });
    });

    await record('ZIP 路径穿越', 'OFD_INVALID_PACKAGE', async () => {
      const zip = createZip([{ name: '../evil.txt', data: 'x' }]);
      await OFDDocument.open({ source: { kind: 'arraybuffer', data: zip.bytes } });
    });

    await record('ZIP 压缩比超限', 'OFD_LIMIT_EXCEEDED', async () => {
      const zip = createZip([{ name: 'Document.xml', data: new Uint8Array(2 * 1024 * 1024) }]);
      await OFDDocument.open({
        source: { kind: 'arraybuffer', data: zip.bytes },
        limits: { maxCompressionRatio: 10 },
      });
    });

    const base = buildMinimalOfd();
    const entries = readZipEntries(base.bytes).map((entry) => ({ name: entry.name, data: entry.data }));
    const documentEntry = entries.find((entry) => entry.name === 'Doc_0/Document.xml')!;
    documentEntry.data = new TextEncoder().encode(
      '<?xml version="1.0"?><!DOCTYPE ofd:Document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        '<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">&xxe;</ofd:Document>',
    );
    await record('XML DTD/外部实体', 'OFD_XML_PARSE', async () => {
      const zip = createZip(entries);
      await OFDDocument.open({ source: { kind: 'arraybuffer', data: zip.bytes } });
    });

    const imageBomb = buildImageOfd();
    const parsed = readZipEntries(imageBomb);
    const pngEntry = parsed.find((entry) => entry.name === 'Doc_0/Res/image.png')!;
    const png = pngEntry.data.slice();
    png[16] = 0x00; png[17] = 0x01; png[18] = 0x86; png[19] = 0xa0;
    png[20] = 0x00; png[21] = 0x01; png[22] = 0x86; png[23] = 0xa0;
    const imageWarnings: string[] = [];
    const imageDoc = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: createZip(parsed.map((entry) => ({
        name: entry.name,
        data: entry.name === 'Doc_0/Res/image.png' ? png : entry.data,
      }))).bytes },
      renderer: createRenderer(),
      imageDecoders: [...nodeImageDecoders],
      limits: { maxImagePixels: 1000 },
      onWarning: (warning) => imageWarnings.push(`${warning.code}:${warning.message}`),
    });
    const imagePage = await imageDoc.getPage(0);
    let imageOk = true;
    try {
      await renderPage(imagePage);
    } catch {
      imageOk = false;
    }
    await imageDoc.close();
    cases.push({
      name: '图片像素炸弹',
      expected: 'warning/skip',
      actual: imageOk ? `rendered; warnings=${imageWarnings.join('|') || 'none'}` : 'rejected',
      ok: imageOk && imageWarnings.some((warning) => warning.includes('OFD_LIMIT_EXCEEDED') || warning.includes('W_IMAGE_DECODE')),
    });

    data.security = cases;
    expect(cases.every((item) => item.ok)).toBe(true);
  }, 120_000);
});
