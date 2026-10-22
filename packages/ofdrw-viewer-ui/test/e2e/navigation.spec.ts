/**
 * 缩略图、大纲与书签导航。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, openViewer, viewState } from './support';

test('缩略图与大纲跳转保持当前页高亮', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  // 用工具栏打开侧栏，确保焦点进入侧栏并验证关闭后的焦点恢复。
  await page.locator('[data-ofd-control="sidebar"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  await expect(page.locator('.ofd-sidebar__tab[data-view="thumbnails"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.ofd-thumbnail')).toHaveCount(4);

  await page.locator('.ofd-thumbnail[data-page="4"]').click();
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(4);
  await expect(page.locator('.ofd-page[data-page-number="4"]')).toHaveAttribute('data-current', 'true');
  await expect(page.locator('.ofd-thumbnail[data-page="4"]')).toHaveAttribute('aria-selected', 'true');

  await page.locator('.ofd-sidebar__tab[data-view="outline"]').click();
  const outlineTitles = page.locator('.ofd-outline__title');
  await expect(outlineTitles.first()).toBeVisible();
  expect(await outlineTitles.count()).toBeGreaterThan(0);
  await outlineTitles.filter({ hasText: '3、一对多' }).click();
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(3);
  await expect(page.locator('.ofd-page[data-page-number="3"]')).toHaveAttribute('data-current', 'true');

  // 关闭侧栏后工具栏状态同步；焦点恢复在移动抽屉场景单独验证。
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-viewer__sidebar')).toBeHidden();
  await expect(page.locator('[data-ofd-control="sidebar"]')).toHaveAttribute('aria-expanded', 'false');
  await expectNoPageErrors(page, issues);
});

test('书签跳转回目标页', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.bookmarks);
  await page.evaluate(() => window.__viewer!.goToPage(5));
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(5);

  await page.evaluate(() => window.__viewer!.openSidebar('bookmarks'));
  const bookmark = page.locator('.ofd-bookmark');
  await expect(bookmark).toHaveCount(1);
  await expect(bookmark).toContainText('新建书签');
  await bookmark.click();
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(1);
  await expect(page.locator('.ofd-page[data-page-number="1"]')).toHaveAttribute('data-current', 'true');
  await expectNoPageErrors(page, issues);
});
