/**
 * 密码能力浏览器验收：加密文档打开、验证面板、印章浮层与时间戳文案。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, openViewer, viewerUrl } from './support';

test('签名条目缺 Type 的明文文档正常打开，且不出现解密/凭据文案', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.signatureNoType, { waitForRender: false });
  const state = await page.evaluate(() => ({
    status: window.__viewer!.getState().document.status,
    pageCount: window.__viewer!.getState().document.pageCount,
    signatures: window.__viewer!.getSignatures().map((entry) => ({
      id: entry.id,
      type: entry.type,
      baseLoc: entry.baseLoc,
    })),
  }));
  expect(state.status).toBe('ready');
  expect(state.pageCount).toBeGreaterThan(0);
  expect(state.signatures).toEqual([
    { id: '2', type: '', baseLoc: 'Doc_0/Signs/Sign_0/Signature.xml' },
  ]);
  const body = await page.locator('body').textContent();
  expect(body).not.toContain('解密失败');
  expect(body).not.toContain('请检查凭据');
  expect(body).not.toContain('读取文档加密信息失败');
  await expectNoPageErrors(page, issues);
});

test('口令加密文档：预置凭据打开后状态就绪', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.cryptoPassword, {
    password: 'FixturePass123',
    userName: 'fixture-password-user',
    waitForRender: false,
  });
  const state = await page.evaluate(() => ({
    status: window.__viewer!.getState().document.status,
    pageCount: window.__viewer!.getState().document.pageCount,
    warnings: window.__viewer!.getState().ui.warnings,
  }));
  expect(state.status).toBe('ready');
  expect(state.pageCount).toBe(2);
  expect(state.warnings.map((warning) => warning.code)).not.toContain('OFD_CRYPTO_FAILED');
  await expectNoPageErrors(page, issues);
});

test('口令加密文档：内置凭据弹窗收集口令后打开', async ({ page, issues }) => {
  await page.goto(viewerUrl(FIXTURES.cryptoPassword, { autoPrompt: true }));
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  await page
    .locator('[data-ofd-control="crypto-credential-password"]')
    .fill('FixturePass123');
  await page.locator('.ofd-dialog__action--primary').click();
  await expect(page.locator('html')).toHaveAttribute('data-e2e-ready', 'true', {
    timeout: 45_000,
  });
  expect(await page.evaluate(() => window.__viewer!.getState().document.status)).toBe('ready');
  await expect(dialog).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('验证面板：配置根证书后有效，时间戳固定为已解析未验证', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    waitForRender: false,
  });
  await page.waitForFunction(
    () => window.__events?.some((event) => event.type === 'verificationcompleted'),
    null,
    { timeout: 45_000 },
  );
  const overall = await page.evaluate(
    () => window.__viewer!.getVerificationReport()?.overall,
  );
  expect(overall).toBe('valid');

  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const panel = page.locator('.ofd-verification-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('有效');
  await expect(panel).toContainText('已解析，未验证');
  const text = await panel.textContent();
  expect(text).not.toMatch(/时间戳验证通过|时间戳有效/);
  await expectNoPageErrors(page, issues);
});

test('印章点击：先验证再展示浮层，可进入签章详情', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    waitForRender: false,
  });
  await page.waitForFunction(
    () => window.__events?.some((event) => event.type === 'verificationcompleted'),
    null,
    { timeout: 45_000 },
  );
  const overlay = page.locator('.ofd-signature-box[data-signature-id]');
  await expect(overlay).toBeVisible();
  await overlay.click();
  const popover = page.locator('.ofd-signature-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('有效');
  await expect(popover).toContainText('已解析，未验证');

  await popover.locator('[data-ofd-control="signature-popover-details"]').click();
  const detail = page.locator('.ofd-dialog');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.ofd-dialog__title')).toContainText('签章信息');
  await expectNoPageErrors(page, issues);
});