/**
 * 加载动画 E2E：真实 Chrome + dist 构建 + 真实 OFD 夹具。
 *
 * 文档打开/失败/取消走真实引擎与网络路径；页面 loading 的超前/滞后通过测试夹具
 * 在引擎事件总线边界注入可控事件，避免依赖 CPU 快慢；缩略图窗口与失败路径使用
 * 真实千页/缺页夹具。
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

declare global {
  interface Window {
    __overlayShown?: boolean;
    __fadingSeen?: boolean;
  }
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
 * 等待阅读器状态变为 ready。
 *
 * @param page Playwright 页面。
 * @param timeout 超时，单位毫秒。
 */
async function waitReady(
  page: import('@playwright/test').Page,
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => window.__viewer?.getState().document.status ?? null),
      { timeout },
    )
    .toBe('ready');
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

test('小文件打开完成后立即出现全屏 loading，把首屏空白期盖住', async ({ page, issues }) => {
  await page.addInitScript(() => {
    window.__overlayShown = false;
    const observe = (): void => {
      const observer = new MutationObserver(() => {
        const status = document.querySelector<HTMLElement>('.ofd-viewer__loading');
        if (status && !status.hidden) window.__overlayShown = true;
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['hidden'],
      });
    };
    if (document.body) observe();
    else document.addEventListener('DOMContentLoaded', observe, { once: true });
  });
  await openViewer(page, FIXTURES.basic, { crypto: false, autoVerify: false });
  await expect(page.locator('.ofd-viewer__loading')).toBeHidden({ timeout: 3_000 });
  // 首次冷启动包含引擎加载/字体探测，不能代表“小文件快路径”；预热后重开同一文件。
  await page.evaluate(() => {
    window.__overlayShown = false;
  });
  const duration = await page.evaluate(async () => {
    const started = performance.now();
    await window.__viewer!.open('/ofd_pdf_match/helloworld.ofd');
    return performance.now() - started;
  });
  expect(duration, `warm open ${duration.toFixed(1)}ms`).toBeLessThan(150);

  // 这次重开后把网络打慢，让「打开完成 → 首屏画完」之间出现可观测的空窗：
  // 遮罩必须在这段空窗里可见，页壳渲染完成后才收起。
  await page.evaluate(() => {
    const target = /\/ofd_pdf_match\/helloworld\.ofd/;
    const original = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!target.test(url)) return original(input, init);
      await new Promise((resolve) => setTimeout(resolve, 600));
      return original(input, init);
    };
  });
  await page.evaluate(() => {
    window.__overlayShown = false;
  });
  await page.evaluate(async () => {
    await window.__viewer!.open('/ofd_pdf_match/helloworld.ofd');
  });
  await expect(page.locator('.ofd-viewer__loading')).toBeVisible({ timeout: 2_000 });
  await expect(page.locator('.ofd-viewer__loading')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('.ofd-viewer__loading-area')).toBeHidden();
  await expect(page.locator('.ofd-page[data-page-state="rendered"]').first()).toBeVisible();
  await expectNoPageErrors(page, issues);
});

test('慢文件 >150ms 显示全屏 loading，完成后最短展示并淡出', async ({ page, issues }) => {
  await page.route(SLOW_PATTERN, async (route) => {
    try {
      await wait(700);
      await route.continue();
    } catch {
      // 测试取消/关闭后请求可能已被中止。
    }
  });
  await page.goto(viewerUrl(SLOW_FIXTURE, { crypto: false, autoVerify: false }));
  const overlay = page.locator('.ofd-viewer__loading');
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await expect(overlay).toHaveAttribute('role', 'status');
  await expect(overlay).toHaveAttribute('aria-busy', 'true');
  await expect(overlay.locator('.ofd-viewer__loading-name')).toHaveText('helloworld.ofd');
  await expect(overlay.locator('.ofd-viewer__loading-ring')).toBeVisible();
  await expect(overlay.locator('.ofd-viewer__loading-button')).toHaveText('取消');

  await waitReady(page, 15_000);
  // 最短展示 300ms + 150ms 淡出：完成后至少还能看到一小段时间。
  await expect(overlay).toBeVisible();
  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expectNoPageErrors(page, issues);
});

test('全屏 loading 背景 inert，Tab 焦点锁在遮罩内且 Enter 不改变背景', async ({ page, issues }) => {
  await page.route(SLOW_PATTERN, async (route) => {
    try {
      await wait(1500);
      await route.continue();
    } catch {
      // 取消/关闭后请求可能已被中止。
    }
  });
  await page.goto(viewerUrl(SLOW_FIXTURE, { crypto: false, autoVerify: false }));
  const overlay = page.locator('.ofd-viewer__loading');
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  const toolbar = page.locator('.ofd-viewer__toolbar');
  const body = page.locator('.ofd-viewer__body');
  await expect(toolbar).toHaveAttribute('inert', '');
  await expect(body).toHaveAttribute('inert', '');

  // 焦点在背景时按 Enter 不得触发工具栏/侧栏。
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.ofd-viewer__sidebar')).toBeHidden();
  expect(await page.evaluate(() => window.__viewer?.getState().document.status)).toBe('opening');

  // Tab/Shift+Tab 只在遮罩按钮间循环。
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.querySelector('.ofd-viewer__loading')?.contains(document.activeElement) ?? false,
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(
      () => document.querySelector('.ofd-viewer__loading')?.contains(document.activeElement) ?? false,
    ),
  ).toBe(true);

  // 通过取消隐藏遮罩，验证背景恢复可交互。
  await overlay.locator('.ofd-viewer__loading-button').click();
  await expect(overlay).toBeHidden();
  await expect(toolbar).not.toHaveAttribute('inert', '');
  await expect(body).not.toHaveAttribute('inert', '');
  await expect
    .poll(() => page.evaluate(() => window.__viewer?.getState().document.status ?? null))
    .toBe('closed');
  await expectNoPageErrors(page, issues);
});

test('取消打开立即回空态，无错误卡/toast，且关闭已打开文档', async ({ page, issues }) => {
  await page.route(SLOW_PATTERN, async (route) => {
    try {
      await wait(1500);
      await route.continue();
    } catch {
      // 取消后请求被中止属于预期。
    }
  });
  await page.goto(viewerUrl(SLOW_FIXTURE, { crypto: false, autoVerify: false }));
  const overlay = page.locator('.ofd-viewer__loading');
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await overlay.locator('.ofd-viewer__loading-button').click();
  await expect(overlay).toBeHidden();
  await expect(page.locator('.ofd-viewer__loading-error')).toBeHidden();
  await expect(page.locator('.ofd-toast')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__viewer?.getState().document.status ?? null))
    .toBe('closed');
  expect(await page.evaluate(() => window.__viewer?.getPageCount() ?? -1)).toBe(0);
  await expectNoPageErrors(page, issues, {
    allowedDiagnostics: [/^\[ofd-viewer\] error OFD_ENTRY_NOT_FOUND /],
  });
});

test('打开失败显示全屏错误卡；重试后成功打开', async ({ page, issues }) => {
  let allowOpen = false;
  await page.route(FAIL_PATTERN, async (route) => {
    if (!allowOpen) {
      // 返回 200 但内容不是合法 OFD，触发解析失败而不是资源 404 控制台噪音。
      await route.fulfill({ status: 200, contentType: 'application/ofd', body: 'not an ofd' });
      return;
    }
    await route.continue();
  });
  await page.goto(viewerUrl(FAIL_FIXTURE, { crypto: false, autoVerify: false }));
  const error = page.locator('.ofd-viewer__loading-error');
  await expect(error).toBeVisible({ timeout: 10_000 });
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error.locator('.ofd-viewer__loading-error-code')).toContainText('OFD_');
  await expect(error.locator('.ofd-viewer__loading-error-message')).not.toHaveText('');
  await expect(page.locator('.ofd-viewer__loading')).toBeHidden();

  allowOpen = true;
  await error.locator('.ofd-viewer__loading-button--primary').click();
  await waitReady(page);
  await expect(error).toBeHidden();
  await expect(page.locator('.ofd-viewer__loading')).toBeHidden();
  expect(await page.evaluate(() => window.__viewer?.getPageCount() ?? 0)).toBeGreaterThan(0);
  await expectNoPageErrors(page, issues, {
    windowErrors: [/OFDError/],
    allowedDiagnostics: [/^\[ofd-viewer\] error OFD_INVALID_PACKAGE /],
  });
});

test('错误卡后公开 open 快速打开新文档：退出模态并恢复工具栏', async ({ page, issues }) => {
  await page.route(FAIL_PATTERN, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/ofd', body: 'not an ofd' });
  });
  await page.goto(viewerUrl(FAIL_FIXTURE, { crypto: false, autoVerify: false }));
  const error = page.locator('.ofd-viewer__loading-error');
  await expect(error).toBeVisible({ timeout: 10_000 });
  const toolbar = page.locator('.ofd-viewer__toolbar');
  const body = page.locator('.ofd-viewer__body');
  await expect(toolbar).toHaveAttribute('inert', '');
  await expect(body).toHaveAttribute('inert', '');

  // 通过公开 API 在错误卡之后打开合法小文件：错误卡模态立即退出，页面不残留阻塞。
  await page.evaluate(async () => {
    const response = await fetch('/ofd_pdf_match/helloworld.ofd');
    const bytes = new Uint8Array(await response.arrayBuffer());
    await window.__viewer!.open(bytes);
  });
  expect(await page.evaluate(() => window.__viewer?.getState().document.status)).toBe('ready');
  // 错误卡与背景 inert 在新文档接管后必须立即退出。
  await expect(error).toBeHidden();
  await expect(page.locator('.ofd-viewer__loading')).toBeHidden({ timeout: 5_000 });
  await expect(toolbar).not.toHaveAttribute('inert', '');
  await expect(body).not.toHaveAttribute('inert', '');

  // 工具栏恢复可点击：打开侧栏。
  await page.locator('[data-ofd-control="sidebar"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  await expectNoPageErrors(page, issues, {
    windowErrors: [/OFDError/],
    allowedDiagnostics: [/^\[ofd-viewer\] error OFD_INVALID_PACKAGE /],
  });
});

test('全屏错误卡背景 inert，Tab 焦点锁在重试/关闭，Enter 不改变背景', async ({ page, issues }) => {
  await page.route(FAIL_PATTERN, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/ofd', body: 'not an ofd' });
  });
  await page.goto(viewerUrl(FAIL_FIXTURE, { crypto: false, autoVerify: false }));
  const error = page.locator('.ofd-viewer__loading-error');
  await expect(error).toBeVisible({ timeout: 10_000 });
  const toolbar = page.locator('.ofd-viewer__toolbar');
  const body = page.locator('.ofd-viewer__body');
  await expect(toolbar).toHaveAttribute('inert', '');
  await expect(body).toHaveAttribute('inert', '');

  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.ofd-viewer__sidebar')).toBeHidden();
  await expect(error).toBeVisible();

  const focusedText = async (): Promise<string> =>
    page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  await page.keyboard.press('Tab');
  expect(await focusedText()).toBe('重试');
  await page.keyboard.press('Tab');
  expect(await focusedText()).toBe('关闭');
  await page.keyboard.press('Tab');
  expect(await focusedText()).toBe('重试');

  await error.locator('.ofd-viewer__loading-button').nth(1).click();
  await expect(error).toBeHidden();
  await expect(toolbar).not.toHaveAttribute('inert', '');
  await expect(body).not.toHaveAttribute('inert', '');
  await expectNoPageErrors(page, issues, {
    windowErrors: [/OFDError/],
    allowedDiagnostics: [/^\[ofd-viewer\] error OFD_INVALID_PACKAGE /],
  });
});

test('首次页面渲染 >150ms 显示骨架 + spinner，结束后静默隐藏', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { crypto: false, autoVerify: false });
  const page4 = page.locator('.ofd-page').nth(3);
  await expect(page4).toHaveAttribute('data-page-state', 'empty');

  await page.evaluate(() => {
    window.__harness!.trackPageRender(3, 'main');
    window.__harness!.emitEngineEvent('page:render:start', {
      operationId: 8101,
      pageIndex: 3,
      dpi: 96,
      width: 800,
      height: 600,
    });
  });
  const loading = page4.locator('.ofd-page__loading');
  await expect(loading).toBeVisible({ timeout: 2_000 });
  await expect(loading).toHaveAttribute('data-variant', 'skeleton');
  await expect(page4).toHaveAttribute('aria-busy', 'true');
  await expect(loading.locator('.ofd-page__loading-spinner')).toBeVisible();
  await expect(loading.locator('.ofd-page__loading-skeleton')).toBeVisible();

  await page.evaluate(() => {
    window.__harness!.emitEngineEvent('page:render:end', {
      operationId: 8101,
      pageIndex: 3,
      durationMs: 220,
    });
  });
  await expect(loading).toBeHidden({ timeout: 2_000 });
  await expect(page4).not.toHaveAttribute('aria-busy');
  await expect(page4.locator('.ofd-page__error')).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('重渲染保留旧 canvas 并显示遮罩；abort 静默不显示错误', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { crypto: false, autoVerify: false });
  const main = page.locator('.ofd-page').first();
  await expect(main).toHaveAttribute('data-page-state', 'rendered');
  await expect(main.locator('canvas')).toHaveCount(1);

  await page.evaluate(() => {
    window.__harness!.trackPageRender(0, 'main');
    window.__harness!.emitEngineEvent('page:render:start', {
      operationId: 8102,
      pageIndex: 0,
      dpi: 96,
      width: 800,
      height: 600,
    });
  });
  const loading = main.locator('.ofd-page__loading');
  await expect(loading).toBeVisible({ timeout: 2_000 });
  await expect(loading).toHaveAttribute('data-variant', 'overlay');
  await expect(main.locator('canvas')).toBeVisible();

  await page.evaluate(() => {
    window.__harness!.emitEngineEvent('page:render:abort', {
      operationId: 8102,
      pageIndex: 0,
      cause: 'caller',
      reason: new Error('滚动离开'),
      durationMs: 180,
    });
  });
  await expect(loading).toBeHidden();
  await expect(main.locator('.ofd-page__error')).toBeHidden();
  await expect(main).not.toHaveAttribute('aria-busy');
  await expectNoPageErrors(page, issues);
});

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

test('页面渲染失败显示错误卡；点击重试后真实渲染成功', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { crypto: false, autoVerify: false });
  await expect(page.locator('.ofd-viewer__loading')).toBeHidden({ timeout: 3_000 });
  const page4 = page.locator('.ofd-page').nth(3);
  await expect(page4).toHaveAttribute('data-page-state', 'empty');

  await page.evaluate(() => {
    window.__harness!.trackPageRender(3, 'main');
    window.__harness!.emitEngineEvent('page:render:start', {
      operationId: 8103,
      pageIndex: 3,
      dpi: 96,
      width: 800,
      height: 600,
    });
    const error = Object.assign(new Error('模拟页面渲染失败'), { code: 'OFD_RENDER_FAILED' });
    window.__harness!.emitEngineEvent('page:render:error', {
      operationId: 8103,
      pageIndex: 3,
      error,
      durationMs: 40,
    });
  });
  const errorLayer = page4.locator('.ofd-page__error');
  await expect(errorLayer).toBeVisible();
  await expect(errorLayer).toHaveAttribute('role', 'alert');
  await expect(errorLayer.locator('.ofd-page__error-code')).toHaveText('OFD_RENDER_FAILED');
  await expect(errorLayer.locator('.ofd-page__error-message')).toHaveText('模拟页面渲染失败');
  await expect(page4.locator('.ofd-page__loading')).toBeHidden();

  await errorLayer.locator('.ofd-page__retry').click();
  await expect(page4).toHaveAttribute('data-page-state', 'rendered', { timeout: 20_000 });
  await expect(errorLayer).toBeHidden();
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

test('缩略图渲染失败显示灰色占位，点击重试再次触发失败', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.brokenPage, { crypto: false, autoVerify: false });
  await page.evaluate(() => window.__viewer!.openSidebar('thumbnails'));
  const target = page.locator('.ofd-thumbnail[data-page="3"]');
  await expect(target).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
  await expect(target.locator('.ofd-thumbnail__fallback')).toBeVisible();
  await expect(target.locator('.ofd-thumbnail__skeleton')).toBeHidden();
  await expect(target.locator('canvas')).toHaveCount(0);
  await expect(target).toHaveAttribute('aria-label', /第 3 页/);

  const warnings = () =>
    issues.consoleWarnings.filter((text) => text.includes('W_THUMBNAIL')).length;
  const before = warnings();
  await target.click();
  await expect.poll(warnings, { timeout: 20_000 }).toBeGreaterThan(before);
  await expect(target).toHaveAttribute('data-state', 'failed');
  // 该夹具的第 3 页内容缺失：打开时只报 OFD_ENTRY_NOT_FOUND；
  // 缩略图重试会为同一页上报 OFD_RENDER_FAILED（故意触发），两者显式放行。
  await expectNoPageErrors(page, issues, {
    allowedDiagnostics: [
      /^\[ofd-viewer\] error OFD_ENTRY_NOT_FOUND /,
      /^\[ofd-viewer\] error OFD_RENDER_FAILED /,
    ],
  });
});

test('主页面与缩略图事件归属隔离', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { crypto: false, autoVerify: false });
  await page.evaluate(() => window.__viewer!.openSidebar('thumbnails'));
  await expect(page.locator('.ofd-thumbnail')).toHaveCount(4);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.ofd-thumbnail')].every(
            (entry) => entry.dataset.state === 'rendered' || entry.dataset.state === 'failed',
          ),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);

  const main = page.locator('.ofd-page').first();
  expect(await main.getAttribute('aria-busy')).toBeNull();

  // 缩略图 operation：不触发主页面骨架。
  await page.evaluate(() => {
    window.__harness!.trackPageRender(0, 'thumbnail');
    window.__harness!.emitEngineEvent('page:render:start', {
      operationId: 8201,
      pageIndex: 0,
      dpi: 96,
      width: 200,
      height: 280,
    });
  });
  await wait(200);
  await expect(main.locator('.ofd-page__loading')).toBeHidden();
  expect(await main.getAttribute('aria-busy')).toBeNull();

  // 主页面 operation：主页面进入 loading，但不把缩略图改为骨架。
  await page.evaluate(() => {
    window.__harness!.emitEngineEvent('page:render:end', {
      operationId: 8201,
      pageIndex: 0,
      durationMs: 200,
    });
    window.__harness!.trackPageRender(0, 'main');
    window.__harness!.emitEngineEvent('page:render:start', {
      operationId: 8202,
      pageIndex: 0,
      dpi: 96,
      width: 800,
      height: 1100,
    });
  });
  await expect(main).toHaveAttribute('aria-busy', 'true');
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.ofd-thumbnail')].every(
          (entry) => entry.dataset.state !== 'queued' && entry.dataset.state !== 'rendering',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.__harness!.emitEngineEvent('page:render:abort', {
      operationId: 8202,
      pageIndex: 0,
      cause: 'caller',
      reason: new Error('取消'),
      durationMs: 100,
    });
  });
  await expect(main).not.toHaveAttribute('aria-busy');
  await expectNoPageErrors(page, issues);
});

test('prefers-reduced-motion 下无脉冲/旋转/淡出', async ({ page, issues }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.__fadingSeen = false;
    const observe = (): void => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.ofd-page__loading[data-fading="true"]')) {
          window.__fadingSeen = true;
        }
      });
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-fading'],
      });
    };
    if (document.body) observe();
    else document.addEventListener('DOMContentLoaded', observe, { once: true });
  });
  await openViewer(page, FIXTURES.multi, { crypto: false, autoVerify: false });

  const styles = await page.evaluate(() => {
    const ring = document.querySelector<HTMLElement>('.ofd-viewer__loading-ring');
    const spinner = document.querySelector<HTMLElement>('.ofd-page__loading-spinner');
    const skeleton = document.querySelector<HTMLElement>('.ofd-page__loading-skeleton');
    const loading = document.querySelector<HTMLElement>('.ofd-page__loading');
    const overlay = document.querySelector<HTMLElement>('.ofd-viewer__loading');
    if (!ring || !spinner || !skeleton || !loading || !overlay) throw new Error('加载层缺失');
    return {
      ringAnimation: getComputedStyle(ring).animationName,
      spinnerAnimation: getComputedStyle(spinner).animationName,
      skeletonAnimation: getComputedStyle(skeleton, '::after').animationName,
      loadingTransition: getComputedStyle(loading).transitionDuration,
      overlayTransition: getComputedStyle(overlay).transitionDuration,
    };
  });
  expect(styles.ringAnimation).toBe('none');
  expect(styles.spinnerAnimation).toBe('none');
  expect(styles.skeletonAnimation).toBe('none');
  expect(styles.loadingTransition).toBe('0s');
  expect(styles.overlayTransition).toBe('0s');

  // 慢打开：reduced-motion 下结束立即隐藏，不产生 fade 标记。
  await page.route(SLOW_PATTERN, async (route) => {
    try {
      await wait(400);
      await route.continue();
    } catch {
      // 页面关闭时忽略。
    }
  });
  await page.goto(viewerUrl(SLOW_FIXTURE, { crypto: false, autoVerify: false }));
  const overlay = page.locator('.ofd-viewer__loading');
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await waitReady(page);
  await expect(overlay).toBeHidden({ timeout: 3_000 });
  expect(await page.evaluate(() => window.__fadingSeen)).toBe(false);
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
