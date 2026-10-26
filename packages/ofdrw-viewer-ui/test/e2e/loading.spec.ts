/**
 * 加载动画 E2E：真实 Chrome + dist 构建 + 真实 OFD 夹具。
 *
 * 只保留 jsdom 无法覆盖的浏览器行为：真实 canvas 像素保留、千页缩略图不全量动画、
 * 加载态与错误态的 axe 扫描。计时、骨架、取消与重试逻辑由
 * `unit/ui/document-loading`、`unit/core/page-loading`、`integration/loading-events` 覆盖。
 */

import type { Locator } from '@playwright/test';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, openViewer, viewerUrl } from './support';

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: Array<{ target: string[] }>;
}

const SLOW_FIXTURE = '/ofd_pdf_match/helloworld.ofd?e2e=slow';
const FAIL_FIXTURE = '/ofd_pdf_match/helloworld.ofd?e2e=fail';
const SLOW_PATTERN = /\/ofd_pdf_match\/helloworld\.ofd\?e2e=slow/;
const FAIL_PATTERN = /\/ofd_pdf_match\/helloworld\.ofd\?e2e=fail/;

/**
 * 延迟指定毫秒。
 *
 * @param ms 时长，单位毫秒。
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读取 canvas 的像素签名（PNG data URL）。
 *
 * @param canvas canvas 定位器。
 * @returns 像素签名。
 */
async function canvasSignature(canvas: Locator): Promise<string> {
  return canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL('image/png'));
}

/**
 * 过滤 serious/critical 违规。
 *
 * @param violations axe 违规。
 * @returns 严重违规。
 */
function serious(violations: readonly AxeViolation[]): AxeViolation[] {
  return violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

/**
 * 在真实浏览器中执行 axe 扫描。
 *
 * @param page Playwright 页面。
 * @param selector 扫描根选择器。
 * @returns serious/critical 违规。
 */
async function scanAxe(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<AxeViolation[]> {
  const result = await page.evaluate(async (targetSelector) => {
    const axe = window.axe;
    if (!axe) throw new Error('axe 未加载');
    const target = document.querySelector(targetSelector);
    if (!target) throw new Error(`未找到扫描目标 ${targetSelector}`);
    return axe.run(target, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
  }, selector);
  return serious(result.violations);
}

test('真实 page.render 重渲染期间旧 canvas 像素不变，完成后才替换', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { crypto: false, autoVerify: false });
  const main = page.locator('.ofd-page').first();
  await expect(main).toHaveAttribute('data-page-state', 'rendered');
  const canvas = main.locator('canvas');
  await expect(canvas).toHaveCount(1);
  const before = await canvasSignature(canvas);
  expect(before.length).toBeGreaterThan(1000);

  // 真实 page.render 正常绘制，仅把完成 Promise 推迟，便于在渲染期间采样旧画面。
  await page.evaluate(async () => {
    await window.__harness!.delayPageRender(0, 900);
  });
  await page.evaluate(() => window.__viewer!.setScale(2));
  await expect(main).toHaveAttribute('data-page-state', 'rendering', { timeout: 2_000 });

  for (let index = 0; index < 3; index += 1) {
    expect(await canvasSignature(canvas), `渲染中第 ${index} 次采样`).toBe(before);
    await wait(100);
  }

  await expect
    .poll(async () => canvasSignature(canvas), { timeout: 5_000 })
    .not.toBe(before);
  await expect(main.locator('canvas')).toHaveCount(1);
  await expect(main).toHaveAttribute('data-page-state', 'rendered');
  await expect(main.locator('.ofd-page__error')).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('真实 page.render 重渲染 abort 后保留旧画面像素', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { crypto: false, autoVerify: false });
  const main = page.locator('.ofd-page').first();
  const canvas = main.locator('canvas');
  await expect(main).toHaveAttribute('data-page-state', 'rendered');
  const before = await canvasSignature(canvas);

  await page.evaluate(async () => {
    await window.__harness!.delayPageRender(0, 5_000);
  });
  await page.evaluate(() => window.__viewer!.setScale(2));
  await expect(main).toHaveAttribute('data-page-state', 'rendering', { timeout: 2_000 });
  await page.evaluate(() => window.__harness!.cancelDelayedPageRender());

  await expect(main).toHaveAttribute('data-page-state', 'rendered');
  await expect(main).not.toHaveAttribute('aria-busy');
  await expect(main.locator('.ofd-page__loading')).toBeHidden();
  await expect(main.locator('.ofd-page__error')).toBeHidden();
  expect(await canvasSignature(canvas)).toBe(before);
  await expect(main.locator('canvas')).toHaveCount(1);
  await expectNoPageErrors(page, issues);
});

test('缩略图仅窗口内播放骨架；1000 页不批量动画，窗口外为静态页码', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.thousand, { crypto: false, autoVerify: false, waitForRender: false });
  await page.evaluate(() => window.__viewer!.openSidebar('thumbnails'));
  await expect(page.locator('.ofd-thumbnail')).toHaveCount(1000, { timeout: 20_000 });

  const snapshot = await page.evaluate(() => {
    const entries = [...document.querySelectorAll<HTMLElement>('.ofd-thumbnail')];
    const skeletons = [...document.querySelectorAll<HTMLElement>('.ofd-thumbnail__skeleton')];
    const visibleSkeletons = skeletons.filter((skeleton) => !skeleton.hidden);
    const active = entries.filter(
      (entry) => entry.dataset.state === 'queued' || entry.dataset.state === 'rendering',
    );
    const idleFallback = entries.filter((entry) => {
      if (entry.dataset.state !== 'idle') return false;
      const fallback = entry.querySelector<HTMLElement>('.ofd-thumbnail__fallback');
      return fallback !== null && !fallback.hidden;
    });
    const skeletonAnimations = document
      .getAnimations()
      .filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return target instanceof Element && target.classList.contains('ofd-thumbnail__skeleton');
      });
    return {
      total: entries.length,
      active: active.length,
      visibleSkeletons: visibleSkeletons.length,
      skeletonAnimations: skeletonAnimations.length,
      idleFallback: idleFallback.length,
    };
  });

  expect(snapshot.total).toBe(1000);
  // 可见窗口 = 当前页 ±5，最多 11 项；1000 页不能同时播放骨架。
  expect(snapshot.active).toBeLessThanOrEqual(11);
  expect(snapshot.visibleSkeletons).toBeLessThanOrEqual(11);
  expect(snapshot.skeletonAnimations).toBeLessThanOrEqual(11);
  expect(snapshot.idleFallback).toBeGreaterThanOrEqual(900);
  await expectNoPageErrors(page, issues);
});

test('axe 扫描全屏 loading 态 0 serious/critical', async ({ page, issues }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(SLOW_PATTERN, async (route) => {
    try {
      await wait(1200);
      await route.continue();
    } catch {
      // 关闭时忽略。
    }
  });
  await page.goto(viewerUrl(SLOW_FIXTURE, { crypto: false, autoVerify: false }));
  await expect(page.locator('.ofd-viewer__loading')).toBeVisible({ timeout: 5_000 });
  await page.addScriptTag({ path: 'test/e2e/vendor/axe.min.js' });
  const loadingViolations = await scanAxe(page, '.ofd-viewer__loading');
  expect(loadingViolations, JSON.stringify(loadingViolations)).toEqual([]);
  await expectNoPageErrors(page, issues);
});

test('axe 扫描全屏错误态 0 serious/critical', async ({ page, issues }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(FAIL_PATTERN, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/ofd', body: 'not an ofd' });
  });
  await page.goto(viewerUrl(FAIL_FIXTURE, { crypto: false, autoVerify: false }));
  await expect(page.locator('.ofd-viewer__loading-error')).toBeVisible({ timeout: 10_000 });
  await page.addScriptTag({ path: 'test/e2e/vendor/axe.min.js' });
  const errorViolations = await scanAxe(page, '.ofd-viewer__loading-error');
  expect(errorViolations, JSON.stringify(errorViolations)).toEqual([]);
  await expectNoPageErrors(page, issues, {
    windowErrors: [/OFDError/],
    allowedDiagnostics: [/^\[ofd-viewer\] error OFD_INVALID_PACKAGE /],
  });
});
