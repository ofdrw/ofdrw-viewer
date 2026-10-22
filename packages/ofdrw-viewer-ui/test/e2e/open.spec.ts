/**
 * 基础打开冒烟：桌面与移动真实 OFD。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, openViewer, viewState } from './support';

test('桌面 1440×900 打开本地 OFD 并完成首屏渲染', async ({ page, issues }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openViewer(page, FIXTURES.basic);
  const state = await viewState(page);
  expect(state.pageCount).toBe(1);
  expect(state.viewport).toBe('desktop');
  await expect(page.locator('.ofd-page')).toHaveCount(1);
  await expect(page.locator('.ofd-page canvas')).toHaveCount(1);
  await expect(page.locator('.ofd-page')).toHaveAttribute('data-page-state', 'rendered');
  await expectNoPageErrors(page, issues);
});

test('移动 390×844 打开本地 OFD 并渲染', async ({ page, issues }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openViewer(page, FIXTURES.multi);
  const state = await viewState(page);
  expect(state.pageCount).toBe(4);
  expect(state.viewport).toBe('narrow');
  expect(state.sidebarLayout).toBe('drawer');
  await expect(page.locator('.ofd-page canvas').first()).toBeVisible();
  await expectNoPageErrors(page, issues);
});
