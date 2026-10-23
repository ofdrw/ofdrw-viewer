/**
 * 签章列表、覆盖层、详情与缺失签名值降级。
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

/** showcase 样本：15 个签章，含真实 PNG 章。 */
const SHOWCASE = '/ofd_pdf_match/ofd-viewer-ui-showcase.ofd';
/** 验收产物目录。 */
const ARTIFACTS = resolve(process.cwd(), '../../test/.artifacts/ui-bugfix-20261023/t5');

test('真实签章：覆盖层、列表、未验证详情与 Esc 关闭', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.signature);
  await dismissFindbar(page);
  const overlay = page.locator('.ofd-signature-box[data-signature-id]');
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toBeVisible();

  // 默认不可见边框；hover/focus 才出现阴影边框，点击命中区域保持不变。
  await page.mouse.move(0, 0);
  await page.waitForTimeout(180);
  const baseStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      hover: element.matches(':hover'),
      focusVisible: element.matches(':focus-visible'),
      active: document.activeElement === element,
    };
  });
  expect(baseStyle).toMatchObject({
    borderColor: expect.stringMatching(/rgba?\(0, 0, 0, 0\)|transparent/),
    boxShadow: 'none',
    hover: false,
    focusVisible: false,
  });
  await overlay.hover();
  await page.waitForTimeout(180);
  const hoverStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(hoverStyle.borderColor).not.toBe(baseStyle.borderColor);
  expect(hoverStyle.boxShadow).not.toBe('none');
  expect(hoverStyle.width).toBeGreaterThan(0);
  expect(hoverStyle.height).toBeGreaterThan(0);
  await page.mouse.move(0, 0);
  await overlay.focus();
  await page.waitForTimeout(180);
  const focusStyle = await overlay.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(focusStyle).not.toBe('none');
  await expect(overlay).toBeFocused();

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

  // 真实 PNG 印章：Blob URL 解码成功，alt 可读，按 mm 比例显示。
  const sealImage = dialog.locator('.ofd-seal-image img');
  await expect(sealImage).toBeVisible();
  await expect(sealImage).toHaveAttribute('alt', /印章图片：.+/);
  await expect
    .poll(() => sealImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  expect(await sealImage.getAttribute('src')).toMatch(/^blob:/);
  await expect(dialog.locator('.ofd-seal-image__caption')).toContainText('mm');

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

test('showcase：真实 PNG 印章在详情中解码显示，覆盖层默认无边框', async ({
  page,
  issues,
}) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  await openViewer(page, SHOWCASE, { sidebar: 'signatures', waitForRender: false });
  const overlay = page.locator('.ofd-signature-box[data-signature-id]').first();
  await expect(overlay).toBeVisible();
  const defaultStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  expect(defaultStyle.borderColor).toMatch(/rgba?\(0, 0, 0, 0\)|transparent/);
  expect(defaultStyle.boxShadow).toBe('none');

  const summary = page.locator('.ofd-signature-summary-item').first();
  await expect(summary).toBeVisible();
  await summary.click();
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  const image = dialog.locator('.ofd-seal-image img').first();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('alt', /印章图片：.+/);
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await expect(dialog.locator('.ofd-seal-image__caption')).toContainText('PNG');
  await page.screenshot({ path: resolve(ARTIFACTS, 'showcase-seal-detail.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expectNoPageErrors(page, issues);
});
