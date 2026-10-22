/**
 * 响应式断点、侧栏布局、状态保持与容器驱动断点。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import {
  FIXTURES,
  eventCount,
  layoutState,
  openViewer,
  resizeAndWait,
  viewState,
} from './support';

test('1024/768/480 断点切换不重新打开文档且保留状态', async ({ page, issues }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openViewer(page, FIXTURES.multi, { page: 3, scale: 1.25, rotation: 90 });
  const opened = await eventCount(page, 'documentopen');
  const initialState = await viewState(page);
  expect(initialState.pageNumber).toBe(3);
  const anchorScrollTop = initialState.scrollTop;
  expect(anchorScrollTop).toBeGreaterThan(0);

  await page.locator('[data-ofd-control="sidebar"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  let layout = await layoutState(page);
  expect(layout.viewport).toBe('desktop');
  expect(layout.sidebarLayout).toBe('inline');
  expect(layout.maskHidden).toBe(true);
  expect(layout.ariaExpanded).toBe('true');

  const breakpoints = [
    { width: 1024, height: 800, viewport: 'desktop', sidebar: 'inline', mask: true },
    { width: 1023, height: 800, viewport: 'compact', sidebar: 'overlay', mask: false },
    { width: 768, height: 800, viewport: 'compact', sidebar: 'overlay', mask: false },
    { width: 767, height: 800, viewport: 'mobile', sidebar: 'drawer', mask: false },
    { width: 480, height: 800, viewport: 'mobile', sidebar: 'drawer', mask: false },
    { width: 479, height: 800, viewport: 'narrow', sidebar: 'drawer', mask: false },
  ] as const;

  for (const breakpoint of breakpoints) {
    await resizeAndWait(page, breakpoint.width, breakpoint.height, breakpoint.viewport);
    await expect
      .poll(async () => (await layoutState(page)).sidebarLayout, { timeout: 10_000 })
      .toBe(breakpoint.sidebar);
    layout = await layoutState(page);
    expect(layout.maskHidden, `mask @${breakpoint.width}`).toBe(breakpoint.mask);
    expect(layout.sidebarOpen).toBe('true');
    const state = await viewState(page);
    expect(state.pageNumber, `page @${breakpoint.width}`).toBe(3);
    expect(state.scale, `scale @${breakpoint.width}`).toBeCloseTo(1.25, 2);
    expect(state.rotation, `rotation @${breakpoint.width}`).toBe(90);
    expect(Math.abs(state.scrollTop - anchorScrollTop), `scrollTop @${breakpoint.width}`).toBeLessThan(2);
    expect(await eventCount(page, 'documentopen'), `documentopen @${breakpoint.width}`).toBe(opened);
  }

  // 回到桌面仍为内联侧栏，文档不重开。
  await resizeAndWait(page, 1440, 900, 'desktop');
  await expect.poll(async () => (await layoutState(page)).sidebarLayout).toBe('inline');
  await expect(page.locator('.ofd-page[data-page-number="3"]')).toHaveAttribute('data-current', 'true');
  expect(await eventCount(page, 'documentopen')).toBe(opened);
  await expectNoPageErrors(page, issues);
});

test('移动抽屉：遮罩、焦点陷阱、Escape 关闭并恢复焦点', async ({ page, issues }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openViewer(page, FIXTURES.multi);
  expect((await viewState(page)).viewport).toBe('narrow');

  const toggle = page.locator('[data-ofd-control="sidebar"]');
  await toggle.click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  await expect(page.locator('.ofd-viewer__sidebar-mask')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // 焦点应进入抽屉内。
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sidebar = document.querySelector('.ofd-viewer__sidebar')!;
        return sidebar.contains(document.activeElement);
      }),
    )
    .toBe(true);

  // Tab 不应逃出抽屉。
  for (let i = 0; i < 15; i += 1) await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => document.querySelector('.ofd-viewer__sidebar')!.contains(document.activeElement)),
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-viewer__sidebar')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await expectNoPageErrors(page, issues);
});

test('容器宽度驱动断点，窗口尺寸不触发重开', async ({ page, issues }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openViewer(page, FIXTURES.multi, { hostWidth: 600 });
  const opened = await eventCount(page, 'documentopen');
  let layout = await layoutState(page);
  expect(layout.windowWidth).toBe(1440);
  expect(layout.hostWidth).toBe(600);
  expect(layout.viewport).toBe('mobile');
  expect(layout.sidebarLayout).toBe('drawer');

  // 仅改窗口、不改容器：断点保持 mobile，证明按容器宽度计算。
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(200);
  layout = await layoutState(page);
  expect(layout.windowWidth).toBe(1200);
  expect(layout.viewport).toBe('mobile');

  // 动态改容器宽度：触发 ResizeObserver，断点随容器变化。
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#host')!.style.width = '1100px';
  });
  await expect.poll(async () => (await layoutState(page)).viewport).toBe('desktop');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#host')!.style.width = '400px';
  });
  await expect.poll(async () => (await layoutState(page)).viewport).toBe('narrow');
  expect(await eventCount(page, 'documentopen')).toBe(opened);
  await expectNoPageErrors(page, issues);
});

test('竖屏转横屏保持页码/缩放/旋转', async ({ page, issues }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openViewer(page, FIXTURES.text, { page: 2, scale: 1.5, rotation: 180 });
  expect((await viewState(page)).viewport).toBe('narrow');
  const opened = await eventCount(page, 'documentopen');

  await resizeAndWait(page, 844, 390, 'compact');
  const state = await viewState(page);
  expect(state.pageNumber).toBe(2);
  expect(state.scale).toBeCloseTo(1.5, 2);
  expect(state.rotation).toBe(180);
  expect(await eventCount(page, 'documentopen')).toBe(opened);
  await expectNoPageErrors(page, issues);
});
