/**
 * 签章列表、覆盖层、详情与缺失签名值降级。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

test('真实签章：覆盖层、列表、未验证详情与 Esc 关闭', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.signature);
  await dismissFindbar(page);
  const overlay = page.locator('.ofd-signature-box[data-signature-id]');
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toBeVisible();

  // 直接通过 API 校验详情：固定未验证状态，不得出现“有效/通过”措辞。
  const detail = await page.evaluate(async () => {
    const signatures = window.__viewer!.getSignatures();
    if (signatures.length === 0) return null;
    return window.__viewer!.getSignatureDetail(signatures[0]!.id);
  });
  expect(detail).not.toBeNull();
  expect(detail!.validation.status).toBe('not-verified');
  expect(detail!.validation.note).toContain('未');
  expect(detail!.seal?.name ?? '').not.toBe('');
  expect(detail!.warnings ?? []).toEqual([]);

  await page.locator('[data-ofd-control="signatures"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  const summary = page.locator('.ofd-signature-summary-item');
  await expect(summary).toHaveCount(1);
  await expect(summary.locator('.ofd-signature-badge')).toContainText(/未验证|验证未知|验证无效|验证有效|无 效|无效|有效/);
  await expect(summary).toContainText(detail!.seal!.name!);

  await summary.click();
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.ofd-dialog__title')).toContainText('签章信息');
  const dialogText = await dialog.textContent();
  expect(dialogText).toContain(detail!.seal!.name!);
  expect(dialogText).not.toMatch(/验证通过|签名有效|验签成功/);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // 覆盖层点击：默认启用验证，先打开验证浮层而非原详情对话框。
  await page.evaluate(() => window.__viewer!.closeSidebar());
  await overlay.click();
  const popover = page.locator('.ofd-signature-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText(/未验证|验证未知|验证无效|验证有效|有效|无效/);
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('缺失 SignedValue.dat：保留签章列表并降级提示', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.signatureMissing);
  await dismissFindbar(page);
  await page.locator('[data-ofd-control="signatures"]').click();
  const summary = page.locator('.ofd-signature-summary-item');
  await expect(summary).toHaveCount(1);
  await expect(summary.locator('.ofd-signature-badge')).toContainText(/未验证|验证未知|验证无效|验证有效/);

  await summary.click();
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  const text = await dialog.textContent();
  expect(text).toContain('签章信息不完整');
  expect(text).toContain('SignedValue.dat');
  expect(text).not.toMatch(/验证通过|签名有效|验签成功/);

  const state = await viewState(page);
  expect(state.pageCount).toBe(1);
  const warnings = await page.evaluate(() => window.__viewer!.getState().ui.warnings);
  expect(warnings.map((warning) => warning.code)).toContain('W_SIGNATURE_RESOURCE');
  await expectNoPageErrors(page, issues);
});
