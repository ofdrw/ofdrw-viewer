/**
 * 1000 页性能指标记录（P1/延期，非 MVP 门禁）。
 *
 * 只记录实测值与功能可用性；未达设计 §12.6 目标时通过 Playwright annotation 与
 * console 显式标注，不使用 30s/60s 之类的注水阈值冒充达标。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

/** 设计 §12.6 的 P1 目标，单位 ms。 */
const TARGETS = {
  openMs: 2_000,
  jumpMs: 500,
  zoomMs: 500,
  findMs: 5_000,
} as const;

test('1000 页打开/跳页/缩放/查找/缩略图指标记录', async ({ page, issues }) => {
  test.setTimeout(240_000);
  test.info().annotations.push({
    type: 'performance-status',
    description: 'F1 性能目标为 P1/延期（非 MVP 门禁）；本次只记录指标，未达目标将显式标注。',
  });
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
  expect(Number.isFinite(openMetrics.openMs)).toBe(true);
  expect(openMetrics.openMs).toBeGreaterThan(0);

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
    fixtureSizeMb: 0.8,
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
    targets: TARGETS,
    targetMet: {
      openMs: openMetrics.openMs <= TARGETS.openMs,
      jumpTo500Ms: jumpMs <= TARGETS.jumpMs,
      zoomMs: zoomMs <= TARGETS.zoomMs,
      findMs: find.ms <= TARGETS.findMs,
    },
    deferred: true,
    note: 'F1 性能目标按用户决定延期（P1，非 MVP 门禁）；仅在目标信创机型与 50–200MB 夹具可用后重新评估。',
    timestamp: new Date().toISOString(),
  };
  const misses = [
    !metrics.targetMet.openMs &&
      `打开 ${metrics.openMs}ms 未达 ≤${TARGETS.openMs}ms（P1/延期，非 MVP 门禁）`,
    !metrics.targetMet.jumpTo500Ms &&
      `跳页 ${metrics.jumpTo500Ms}ms 未达 ≤${TARGETS.jumpMs}ms（P1/延期，非 MVP 门禁）`,
    !metrics.targetMet.zoomMs &&
      `缩放 ${metrics.zoomMs}ms 未达 ≤${TARGETS.zoomMs}ms（P1/延期，非 MVP 门禁）`,
    !metrics.targetMet.findMs &&
      `全篇查找 ${metrics.findMs}ms 未达 ≤${TARGETS.findMs}ms（P1/延期，非 MVP 门禁）`,
  ].filter((value): value is string => typeof value === 'string');
  for (const miss of misses) {
    test.info().annotations.push({ type: 'performance-target-miss', description: miss });
    console.warn('[performance]', miss);
  }
  mkdirSync('test/acceptance/artifacts', { recursive: true });
  writeFileSync('test/acceptance/artifacts/performance.json', `${JSON.stringify(metrics, null, 2)}\n`);
  console.log('PERFORMANCE', JSON.stringify(metrics));
  await expectNoPageErrors(page, issues);
});
