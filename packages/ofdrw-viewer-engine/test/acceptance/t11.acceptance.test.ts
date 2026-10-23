/**
 * T11 最终独立验收：19.6 中可由自动化独立复核的条目。
 *
 * 覆盖 A01 千页懒加载、A04 缺失字体/补充字体、P1/P2/P3/P4 性能门禁；
 * 其余条目在验收报告中映射到 owner 测试与黄金图产物，不修改 src。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import { buildFixtureOfd, createTestRenderer, openTestDocument, renderPage, type TestCanvas } from '../api/helpers';
import { findSystemCjkFont } from '../fixtures/fonts';
import { ZipReader } from '../../src/container/zip-reader';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = `${ROOT}test/.artifacts/t11/19.6`;

/** 读取真实样本。 */
function sample(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${ROOT}ofd_pdf_match/${name}`));
}

/** 读取内置 Web 样本。 */
function webSample(): Uint8Array {
  return new Uint8Array(readFileSync(`${ROOT}examples/web/public/samples/hello.ofd`));
}

/** 统计画布非白像素数。 */
function ink(canvas: TestCanvas): number {
  const context = canvas.context as unknown as { getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } };
  const data = context.getImageData(0, 0, canvas.canvas.width, canvas.canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 245 || (data[i + 1] ?? 255) < 245 || (data[i + 2] ?? 255) < 245) count += 1;
  }
  return count;
}

/** 构造 N 页空页包。 */
function manyPages(count: number): Uint8Array {
  return buildFixtureOfd({
    pages: Array.from({ length: count }, (_, index) => ({ id: index + 1, widthMm: 210, heightMm: 297, objects: [] })),
  });
}

/** 写 JSON 证据。 */
function save(name: string, value: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
}

describe('T11 独立验收 19.6 关键项', () => {
  it('A01/P1：1000 页打开不整包解压且 <100ms', async () => {
    const bytes = manyPages(1000);
    const readEntry = vi.spyOn(ZipReader.prototype, 'readEntry');
    const opens: number[] = [];
    let contentReads = 0;
    try {
      for (let i = 0; i < 5; i += 1) {
        readEntry.mockClear();
        const started = performance.now();
        const doc = await openTestDocument(bytes);
        opens.push(performance.now() - started);
        expect(doc.pageCount).toBe(1000);
        contentReads += readEntry.mock.calls
          .map(([path]) => path)
          .filter((path) => /Pages\/Page_\d+\/Content\.xml$/.test(path))
          .length;
        await doc.close();
      }
    } finally {
      readEntry.mockRestore();
    }
    const sorted = [...opens].sort((a, b) => a - b);
    save('A01-open-1000.json', { opensMs: opens, medianMs: sorted[2], contentReads, pageCount: 1000 });
    expect(contentReads).toBe(0);
    expect(sorted[2]).toBeLessThan(100);
    expect(Math.max(...opens)).toBeLessThan(100);
  });

  it('A04：缺失字体 warning 不崩溃；补充字体可读', async (ctx) => {
    const font = findSystemCjkFont();
    if (!font) {
      ctx.skip();
      return;
    }
    const warnings: string[] = [];
    const plain = await openTestDocument(webSample(), { onWarning: (warning) => warnings.push(warning.code) });
    let plainInk = 0;
    try {
      const page = await plain.getPage(0);
      plainInk = ink((await renderPage(page, { dpi: 96 })).canvas);
    } finally {
      await plain.close();
    }

    const fontWarnings: string[] = [];
    const withFont = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: webSample() },
      supplementaryFonts: [{ data: font.data, family: 'Noto Sans CJK SC' }],
      onWarning: (warning) => fontWarnings.push(warning.code),
      renderer: createTestRenderer(),
    });
    let fontInk = 0;
    try {
      const page = await withFont.getPage(0);
      fontInk = ink((await renderPage(page, { dpi: 96 })).canvas);
    } finally {
      await withFont.close();
    }
    save('A04-missing-font.json', { warnings, fontWarnings, plainInk, fontInk });
    expect(warnings).toContain('W_FONT_MISSING');
    expect(plainInk).toBeGreaterThanOrEqual(0);
    expect(fontInk).toBeGreaterThan(plainInk);
  });

  it('P2/P3：真实中文样本首次渲染 <500ms、二次渲染 <150ms', async () => {
    const bytes = sample('文字横向-数科.ofd');
    const started = performance.now();
    const doc = await openTestDocument(bytes);
    const firstPage = await doc.getPage(0);
    const first = await renderPage(firstPage, { dpi: 96 });
    const firstMs = performance.now() - started;
    const secondStart = performance.now();
    await renderPage(firstPage, { dpi: 96 });
    const secondMs = performance.now() - secondStart;
    await doc.close();
    save('P2-P3-text-horizontal.json', { firstMs, secondMs, width: first.canvas.canvas.width, height: first.canvas.canvas.height });
    expect(firstMs).toBeLessThan(500);
    expect(secondMs).toBeLessThan(150);
  });

  it('P4：hello 两页往返翻页中位 draw <80ms', async () => {
    const doc = await openTestDocument(webSample());
    try {
      const page0 = await doc.getPage(0);
      const page1 = await doc.getPage(1);
      await renderPage(page0, { dpi: 96 });
      await renderPage(page1, { dpi: 96 });
      const draws: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        for (const page of [page0, page1]) {
          const started = performance.now();
          await renderPage(page, { dpi: 96 });
          draws.push(performance.now() - started);
        }
      }
      const sorted = [...draws].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      save('P4-page-turn.json', { drawsMs: draws, medianMs: median, maxMs: Math.max(...draws) });
      expect(median).toBeLessThan(80);
    } finally {
      await doc.close();
    }
  });
  it('P7：manual 89 页 open/首次/翻页性能（样本存在时）', async (ctx) => {
    const path = `${ROOT}ofd_pdf_match/manual.ofd`;
    if (!existsSync(path)) {
      ctx.skip();
      return;
    }
    const bytes = new Uint8Array(readFileSync(path));
    const started = performance.now();
    const doc = await openTestDocument(bytes);
    const openMs = performance.now() - started;
    const firstStart = performance.now();
    await renderPage(await doc.getPage(0), { dpi: 96 });
    const firstMs = performance.now() - firstStart;
    const pages = [44, 22, 66, 88];
    for (const index of pages) await renderPage(await doc.getPage(index), { dpi: 96 });
    const draws: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const index = pages[i % pages.length] ?? 0;
      const drawStart = performance.now();
      await renderPage(await doc.getPage(index), { dpi: 96 });
      draws.push(performance.now() - drawStart);
    }
    const sorted = [...draws].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    await doc.close();
    save('P7-manual.json', { openMs, firstMs, medianTurnMs: median, maxTurnMs: Math.max(...draws) });
    expect(openMs).toBeLessThan(100);
    expect(firstMs).toBeLessThan(500);
    expect(median).toBeLessThan(80);
  }, 120_000);
});
