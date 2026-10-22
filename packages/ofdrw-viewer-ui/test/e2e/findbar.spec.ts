/**
 * 查找栏初始状态与显隐缺陷回归。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, openViewer } from './support';

test('打开文档后查找栏应保持关闭，仅 Ctrl+F 后打开', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.text);
  const findbar = page.locator('.ofd-viewer__findbar');
  await expect(findbar).toBeHidden();

  await page.locator('.ofd-page').first().click();
  await page.keyboard.press('Control+f');
  await expect(findbar).toBeVisible();
  await expect(page.locator('.ofd-findbar__input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(findbar).toBeHidden();
  await expectNoPageErrors(page, issues);
});
