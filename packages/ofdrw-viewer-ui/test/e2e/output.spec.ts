/**
 * 打印预览 DOM 与图片/ZIP 导出下载。
 */
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer } from './support';

interface PrintSnapshot {
  readonly calls: number;
  readonly pages: number;
  readonly pageNumbers: number[];
  readonly imageCount: number;
  readonly css: string;
  readonly rootConnected: boolean;
  readonly revoked: number;
}

test('打印当前页/全部页：生成打印 DOM、调用 window.print 并清理', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  await dismissFindbar(page);

  await page.evaluate(() => {
    const globals = window as unknown as {
      __printCalls: number;
      __printSnapshot: PrintSnapshot | null;
      __revoked: number;
    };
    globals.__printCalls = 0;
    globals.__printSnapshot = null;
    globals.__revoked = 0;
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      globals.__revoked += 1;
      originalRevoke(url);
    };
    window.print = () => {
      globals.__printCalls += 1;
      const root = document.querySelector<HTMLElement>('.ofd-print-root');
      const style = document.querySelector<HTMLStyleElement>('style[data-ofd-print-style]');
      const pages = [...document.querySelectorAll<HTMLElement>('.ofd-print-page')];
      globals.__printSnapshot = {
        calls: globals.__printCalls,
        pages: pages.length,
        pageNumbers: pages.map((element) => Number(element.dataset.pageNumber)),
        imageCount: root?.querySelectorAll('img.ofd-print-page__image').length ?? 0,
        css: style?.textContent ?? '',
        rootConnected: root?.isConnected ?? false,
        revoked: globals.__revoked,
      };
      window.dispatchEvent(new Event('afterprint'));
    };
  });

  // 全部 4 页。
  await page.evaluate(() => window.__viewer!.print({ pages: 'all', dpi: 72 }));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)).toBe(1);
  let snapshot = await page.evaluate(
    () => (window as unknown as { __printSnapshot: PrintSnapshot | null }).__printSnapshot,
  );
  expect(snapshot).not.toBeNull();
  expect(snapshot!.pages).toBe(4);
  expect(snapshot!.pageNumbers).toEqual([1, 2, 3, 4]);
  expect(snapshot!.imageCount).toBe(4);
  expect(snapshot!.rootConnected).toBe(true);
  expect(snapshot!.css).toContain('@page');
  expect(snapshot!.css).toContain('210mm');
  await expect(page.locator('.ofd-print-root')).toHaveCount(0);
  await expect(page.locator('style[data-ofd-print-style]')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __revoked: number }).__revoked),
  ).toBeGreaterThanOrEqual(4);

  // 工具栏打印按钮：默认当前页（当前仍为第 1 页）。
  await page.locator('[data-ofd-control="print"]').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)).toBe(2);
  snapshot = await page.evaluate(
    () => (window as unknown as { __printSnapshot: PrintSnapshot | null }).__printSnapshot,
  );
  expect(snapshot!.pages).toBe(1);
  expect(snapshot!.pageNumbers).toEqual([1]);
  await expect(page.locator('.ofd-print-root')).toHaveCount(0);
  await expectNoPageErrors(page, issues);
});

test('单页 JPEG 与多页 ZIP 导出下载', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  await dismissFindbar(page);

  const [single] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.evaluate(() =>
      window.__viewer!.exportImage({ page: 1, format: 'jpeg', dpi: 72, filename: 'e2e-cover' }),
    ),
  ]);
  expect(single.suggestedFilename()).toBe('e2e-cover.jpg');
  const singlePath = await single.path();
  expect(singlePath).not.toBeNull();
  const bytes = readFileSync(singlePath!);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  const [zipDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.evaluate(() =>
      window.__viewer!.exportImages({
        pages: [1, 2, 3],
        format: 'png',
        filename: 'e2e-pack',
        dpi: 72,
        zipFilename: 'e2e-pack',
      }),
    ),
  ]);
  expect(zipDownload.suggestedFilename()).toBe('e2e-pack.zip');
  const zipPath = await zipDownload.path();
  expect(zipPath).not.toBeNull();
  const zip = unzipSync(readFileSync(zipPath!));
  const names = Object.keys(zip).sort();
  expect(names).toEqual(['e2e-pack-p1.png', 'e2e-pack-p2.png', 'e2e-pack-p3.png']);
  for (const name of names) {
    const entry = zip[name]!;
    expect(entry.length).toBeGreaterThan(1000);
    expect([...entry.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  await expectNoPageErrors(page, issues);
});
