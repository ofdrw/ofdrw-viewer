/**
 * 1000 页性能：打开、首屏、跳页、缩放、查找与缩略图窗口化。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

test('1000 页打开/跳页/缩放/查找/缩略图性能', async ({ page, issues }) => {
  test.setTimeout(240_000);
  await openViewer(page, FIXTURES.thousand, { waitForRender: false });
  await page.waitForFunction(() => window.__events?.some((event) => event.type === 'pagerendered'), null, {
    timeout: 120_000,
  });
  await dismissFindbar(page);

  const openMetrics = await page.evaluate(() => {
    const harness = window.__harness!;
    const first = window.__events?.find((event) => event.type === 'pagerendered');
    return {
      pageCount: window.__viewer!.getPageCount(),
      pageShells: document.querySelectorAll('.ofd-page').length,
      canvases: document.querySelectorAll('.ofd-page canvas').length,
      openMs: (harness.openSettledAt ?? 0) - harness.openStartedAt,
      firstRenderMs: first ? first.at - harness.openStartedAt : null,
      heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
    };
  });
  expect(openMetrics.pageCount).toBe(1000);
  expect(openMetrics.pageShells).toBe(1000);
  expect(openMetrics.canvases).toBeGreaterThan(0);
  expect(openMetrics.canvases).toBeLessThanOrEqual(8);
  expect(openMetrics.openMs).toBeLessThan(30_000);

  // 跳页 500：等待状态与渲染事件。
  const jumpMs = await page.evaluate(async () => {
    const start = performance.now();
    window.__viewer!.goToPage(500);
    await new Promise<void>((resolve) => {
      const check = () => {
        if (window.__viewer!.getPageNumber() === 500) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
    return performance.now() - start;
  });
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(500);
  await expect(page.locator('.ofd-page[data-page-number="500"]')).toHaveAttribute('data-current', 'true');

  // 缩放重渲染当前页。
  const zoomMs = await page.evaluate(async () => {
    const start = performance.now();
    window.__viewer!.setScale(1.5);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return performance.now() - start;
  });
  await expect.poll(async () => (await viewState(page)).scale).toBeCloseTo(1.5, 2);

  // 全文档查找（从当前页开始，至少应覆盖后半本）。
  const find = await page.evaluate(async () => {
    const start = performance.now();
    window.__viewer!.find('OFD', { fromCurrentPage: false });
    await new Promise<void>((resolve) => {
      const check = () => {
        const state = window.__viewer!.getState().view.findState;
        if (!state.searching && state.query === 'OFD' && state.total > 0) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
    const state = window.__viewer!.getState().view.findState;
    return { ms: performance.now() - start, total: state.total, current: state.current };
  });
  expect(find.total).toBeGreaterThan(0);
  expect(find.ms).toBeLessThan(60_000);

  // 1000 页缩略图：只渲染窗口内 canvas。
  await page.evaluate(() => window.__viewer!.openSidebar('thumbnails'));
  await expect(page.locator('.ofd-thumbnail').first()).toBeVisible({ timeout: 30_000 });
  const thumbnails = await page.evaluate(() => ({
    total: document.querySelectorAll('.ofd-thumbnail').length,
    canvases: document.querySelectorAll('.ofd-thumbnail canvas').length,
    heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      ?.usedJSHeapSize ?? null,
  }));
  expect(thumbnails.total).toBeGreaterThan(0);
  expect(thumbnails.canvases).toBeLessThanOrEqual(20);

  const metrics = {
    fixture: 'thousand.ofd',
    pageCount: openMetrics.pageCount,
    pageShells: openMetrics.pageShells,
    openMs: Math.round(openMetrics.openMs),
    firstRenderMs: openMetrics.firstRenderMs === null ? null : Math.round(openMetrics.firstRenderMs),
    jumpTo500Ms: Math.round(jumpMs),
    zoomMs: Math.round(zoomMs),
    findMs: Math.round(find.ms),
    findTotal: find.total,
    canvasesAtOpen: openMetrics.canvases,
    thumbnailTotal: thumbnails.total,
    thumbnailCanvases: thumbnails.canvases,
    heapBefore: openMetrics.heap,
    heapAfter: thumbnails.heap,
    viewport: (await viewState(page)).viewport,
    timestamp: new Date().toISOString(),
  };
  mkdirSync('test/acceptance/artifacts', { recursive: true });
  writeFileSync('test/acceptance/artifacts/performance.json', `${JSON.stringify(metrics, null, 2)}\n`);
  console.log('PERFORMANCE', JSON.stringify(metrics));
  await expectNoPageErrors(page, issues);
});
