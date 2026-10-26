/**
 * UI 密码能力独立验收：加密打开、验证面板、印章浮层、根证书与无障碍。
 *
 * 本文件只使用公共阅读器 API 与真实 crypto 夹具，不复制产品实现；所有断言
 * 都落在浏览器 DOM/状态/验证报告上。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, expectNoPageErrors, test } from './fixtures';
import {
  eventCount,
  expectOpeningMotion,
  FIXTURES,
  openViewer,
  viewerUrl,
} from './support';

const PASSWORD = 'FixturePass123';
const CERT_USER = 'fixture-cert-user';
const ROOT_SUBJECT = 'CN=OFDRW Viewer Crypto Fixtures Root CA';
/** showcase 样本：外部测试根签发，仓库根不匹配。 */
const SHOWCASE = '/ofd_pdf_match/ofd-viewer-ui-showcase.ofd';
/** 验收产物目录。 */
const ARTIFACTS = resolve(process.cwd(), '../../test/.artifacts/ui-bugfix-20261023/t5');

const CRYPTO_DIR = fileURLToPath(
  new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/', import.meta.url),
);
const ROOT_PEM = readFileSync(`${CRYPTO_DIR}certs/root-ca.crt.pem`, 'utf8');
const ROOT_DER = readFileSync(`${CRYPTO_DIR}certs/root-ca.crt.der`);
const ENCRYPT_KEY_PATH = `${CRYPTO_DIR}certs/encrypt.key.pem`;
const ENCRYPT_KEY_DER_PATH = `${CRYPTO_DIR}certs/encrypt.key.der`;
const SIGNER_KEY_PATH = `${CRYPTO_DIR}certs/signer.key.pem`;
const ENCRYPT_KEY_PEM = readFileSync(ENCRYPT_KEY_PATH, 'utf8');

/** 读取当前验证总体状态。 */
async function overall(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__viewer!.getVerificationReport()?.overall);
}

/** 等待验证完成并返回报告。 */
async function waitForReport(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__events?.some((event) => event.type === 'verificationcompleted'),
    null,
    { timeout: 45_000 },
  );
}

/** 解析 `rgb()`/`rgba()` 颜色。 */
function parseCssColor(value: string): [number, number, number] {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (!match) throw new Error(`无法解析颜色：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG 相对亮度。 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** 两色对比度。 */
function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseCssColor(foreground));
  const b = relativeLuminance(parseCssColor(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 读取状态徽标的计算色与有效背景色。 */
async function badgeColors(
  page: Page,
  status: string,
): Promise<{ foreground: string; background: string }> {
  return page.evaluate((targetStatus) => {
    const badge = document.querySelector<HTMLElement>(
      `.ofd-verification-badge[data-status="${targetStatus}"]`,
    );
    if (!badge) throw new Error(`找不到状态徽标：${targetStatus}`);
    let node: HTMLElement | null = badge;
    let background = 'rgba(0, 0, 0, 0)';
    while (node && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return { foreground: getComputedStyle(badge).color, background };
  }, status);
}

/** 读取签章浮层状态徽标的计算色；背景取浮层自身表面色。 */
async function popoverBadgeColors(
  page: Page,
  status: string,
): Promise<{ text: string; foreground: string; borderColor: string; background: string }> {
  return page.evaluate((targetStatus) => {
    const popover = document.querySelector<HTMLElement>('.ofd-signature-popover');
    if (!popover) throw new Error('找不到签章浮层');
    const badge = popover.querySelector<HTMLElement>(
      `.ofd-signature-badge[data-status="${targetStatus}"]`,
    );
    if (!badge) throw new Error(`找不到浮层状态徽标：${targetStatus}`);
    const style = getComputedStyle(badge);
    return {
      text: (badge.textContent ?? '').trim(),
      foreground: style.color,
      borderColor: style.borderColor,
      background: getComputedStyle(popover).backgroundColor,
    };
  }, status);
}

/** 断言页面、storage 与状态快照里没有凭据。 */
async function expectNoSecrets(page: Page, secrets: readonly string[]): Promise<void> {
  const snapshot = await page.evaluate(() => ({
    url: location.href,
    html: document.documentElement.outerHTML,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookie: document.cookie,
    state: JSON.stringify(window.__viewer!.getState()),
    errors: JSON.stringify(window.__errors ?? []),
  }));
  for (const secret of secrets) {
    expect(snapshot.url).not.toContain(secret);
    expect(snapshot.html).not.toContain(secret);
    expect(snapshot.local).not.toContain(secret);
    expect(snapshot.session).not.toContain(secret);
    expect(snapshot.cookie).not.toContain(secret);
    expect(snapshot.state).not.toContain(secret);
    expect(snapshot.errors).not.toContain(secret);
  }
}

test('口令凭据弹窗：错误重试后成功打开并渲染，凭据不落日志/URL/DOM', async ({
  page,
  issues,
}) => {
  await page.goto(viewerUrl(FIXTURES.cryptoPassword, { autoPrompt: true }));
  const dialog = page.locator('.ofd-dialog');
  const passwordInput = page.locator('[data-ofd-control="crypto-credential-password"]');
  await expect(dialog).toBeVisible();
  await expectOpeningMotion(dialog, 'ofd-dialog-in');
  await expectOpeningMotion(page.locator('.ofd-dialog__backdrop'), 'ofd-fade-in');
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);
  await expect(dialog).toHaveAttribute('aria-describedby', /.+/);
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await expect(passwordInput).toBeFocused();

  await passwordInput.fill('wrong-password');
  await expect(page.locator('.ofd-dialog__action--primary')).toBeEnabled();
  await page.locator('.ofd-dialog__action--primary').click();
  const error = page.locator('[data-ofd-control="crypto-credential-error"]');
  await expect(error).toBeVisible();
  await expect(error).toHaveText('口令错误或用户不匹配');
  await expect(dialog).toBeVisible();
  // 重试保留用户输入；口令不能反射到属性、URL 或日志。
  await expect(passwordInput).toHaveValue('wrong-password');
  expect(page.url()).not.toContain('wrong-password');
  expect(await dialog.evaluate((element) => element.outerHTML)).not.toContain('wrong-password');

  await passwordInput.fill(PASSWORD);
  await page.locator('.ofd-dialog__action--primary').click();
  await expect(page.locator('html')).toHaveAttribute('data-e2e-ready', 'true', {
    timeout: 45_000,
  });
  await page.waitForFunction(
    () => window.__events?.some((event) => event.type === 'pagerendered'),
    null,
    { timeout: 60_000 },
  );
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.__viewer!.getState().document.status)).toBe('ready');
  expect(await page.evaluate(() => window.__viewer!.getState().document.pageCount)).toBe(2);
  await expectNoSecrets(page, [PASSWORD, 'wrong-password']);
  expect(JSON.stringify(issues)).not.toContain(PASSWORD);
  await expectNoPageErrors(page, issues);
});

test('证书加密：私钥错误可重试，PEM 私钥打开并渲染，不泄漏私钥内容', async ({
  page,
  issues,
}) => {
  await page.goto(viewerUrl(FIXTURES.cryptoCert, { autoPrompt: true }));
  const dialog = page.locator('.ofd-dialog');
  const keyInput = page.locator('[data-ofd-control="crypto-credential-key"]');
  const passphrase = page.locator('[data-ofd-control="crypto-credential-passphrase"]');
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-ofd-control="crypto-credential-user-name"]')).toHaveText(
    CERT_USER,
  );
  await expect(keyInput).toHaveAttribute('type', 'file');
  await expect(keyInput).toHaveAttribute('accept', /\.pem/);
  await expect(passphrase).toHaveAttribute('type', 'password');
  await expect(dialog).toContainText('私钥口令（可选）');

  await keyInput.setInputFiles(SIGNER_KEY_PATH);
  await expect(page.locator('.ofd-dialog__action--primary')).toBeEnabled();
  await page.locator('.ofd-dialog__action--primary').click();
  const error = page.locator('[data-ofd-control="crypto-credential-error"]');
  await expect(error).toBeVisible();
  await expect(error).toHaveText('解密失败，请检查凭据后重试');
  await expect(dialog).toBeVisible();

  await keyInput.setInputFiles(ENCRYPT_KEY_PATH);
  await page.locator('.ofd-dialog__action--primary').click();
  await expect(page.locator('html')).toHaveAttribute('data-e2e-ready', 'true', {
    timeout: 45_000,
  });
  await page.waitForFunction(
    () => window.__events?.some((event) => event.type === 'pagerendered'),
    null,
    { timeout: 60_000 },
  );
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.__viewer!.getState().document.pageCount)).toBe(2);
  await expectNoSecrets(page, [
    'BEGIN PRIVATE KEY',
    ENCRYPT_KEY_PEM.split('\n')[1]?.slice(0, 24) ?? 'BEGIN PRIVATE KEY',
  ]);
  await expectNoPageErrors(page, issues);
});

test('证书加密：DER 私钥文件同样可打开', async ({ page, issues }) => {
  await page.goto(viewerUrl(FIXTURES.cryptoCert, { autoPrompt: true }));
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await page.locator('[data-ofd-control="crypto-credential-key"]').setInputFiles(
    ENCRYPT_KEY_DER_PATH,
  );
  await page.locator('.ofd-dialog__action--primary').click();
  await expect(page.locator('html')).toHaveAttribute('data-e2e-ready', 'true', {
    timeout: 45_000,
  });
  await expect(page.locator('.ofd-dialog')).toBeHidden();
  expect(await page.evaluate(() => window.__viewer!.getState().document.status)).toBe('ready');
  await expectNoPageErrors(page, issues);
});

test('取消加密打开：保留原文档并恢复可用，Esc 可取消', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.basic, { autoPrompt: true, waitForRender: false });
  const before = await page.evaluate(() => ({
    status: window.__viewer!.getState().document.status,
    pageCount: window.__viewer!.getState().document.pageCount,
  }));
  await page.evaluate((url) => {
    void window.__viewer!.open(url).catch((error: unknown) => {
      const typed = error as { code?: string; message?: string };
      (window as unknown as { __openError?: { code?: string; message?: string } }).__openError = {
        code: typed.code,
        message: typed.message,
      };
    });
  }, FIXTURES.cryptoPassword);

  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __openError?: { code?: string } }).__openError?.code ?? null,
      ),
    )
    .toBe('OFD_CRYPTO_CANCELLED');
  await expect
    .poll(() => page.evaluate(() => window.__viewer!.getState().document.status))
    .toBe(before.status);
  expect(await page.evaluate(() => window.__viewer!.getState().document.pageCount)).toBe(
    before.pageCount,
  );
  expect(await page.evaluate(() => (window.__errors ?? []).join('\n'))).not.toContain(PASSWORD);

  // 取消不破坏阅读器，重新打开明文文档仍可恢复。
  await page.evaluate(async () => {
    await window.__viewer!.open('/ofd_pdf_match/helloworld.ofd');
  });
  await expect
    .poll(() => page.evaluate(() => window.__viewer!.getState().document.status))
    .toBe('ready');
  await expectNoPageErrors(page, issues);
});

test('验证面板：无根时签名/完整性仍通过，链独立显示未知；PEM/DER/CER 根均可配置', async ({
  page,
  issues,
}) => {
  await openViewer(page, FIXTURES.cryptoSigned, { waitForRender: false });
  await expect.poll(() => overall(page)).toBe('valid');
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const panel = page.locator('.ofd-verification-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('总体状态：有效');
  await expect(panel).toContainText('未配置根证书');
  const signatureCard = panel.locator('.ofd-verification-signature').first();
  await expect(signatureCard).toContainText('证书链（不影响总体状态）');
  await expect(signatureCard).toContainText('未知');
  await expect(panel).not.toContainText('验证时间');
  await expect(panel).not.toContainText('耗时');
  await expect(signatureCard).toContainText('签发时间');
  const rootInput = page.locator('[data-ofd-control="verification-root-input"]');
  await expect(rootInput).toHaveAttribute('aria-label', '配置根证书');

  // 错误证书：只记录 warning，面板/阅读器不崩溃。
  await rootInput.setInputFiles({
    name: 'bad.pem',
    mimeType: 'application/x-pem-file',
    buffer: Buffer.from('this is not an X.509 certificate'),
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__viewer!.getState().ui.warnings.some(
          (warning) => warning.code === 'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
        ),
      ),
    )
    .toBe(true);
  await expect(panel).toBeVisible();
  await expect.poll(() => overall(page)).toBe('valid');
  await expect(panel.locator('.ofd-verification-root')).toHaveCount(0);

  // PEM（文件名与内容均为 PEM）。
  await rootInput.setInputFiles({
    name: 'root-ca.pem',
    mimeType: 'application/x-pem-file',
    buffer: Buffer.from(ROOT_PEM, 'utf8'),
  });
  await expect.poll(() => overall(page)).toBe('valid');
  await expect(panel.locator('.ofd-verification-root')).toHaveCount(1);
  await expect(panel).toContainText(ROOT_SUBJECT);
  await panel.locator('[data-ofd-control="verification-root-remove"]').click();
  await expect.poll(() => overall(page)).toBe('valid');
  await expect(panel.locator('.ofd-verification-root')).toHaveCount(0);

  // DER（PKIX DER 字节）。
  await rootInput.setInputFiles({
    name: 'root-ca.der',
    mimeType: 'application/pkix-cert',
    buffer: ROOT_DER,
  });
  await expect.poll(() => overall(page)).toBe('valid');
  await expect(panel.locator('.ofd-verification-root')).toHaveCount(1);
  await panel.locator('[data-ofd-control="verification-root-remove"]').click();
  await expect.poll(() => overall(page)).toBe('valid');

  // CER（DER 编码，文件名为 .cer；UI 只处理字节，不依赖扩展名）。
  await rootInput.setInputFiles({
    name: 'root-ca.cer',
    mimeType: 'application/pkix-cert',
    buffer: ROOT_DER,
  });
  await expect.poll(() => overall(page)).toBe('valid');
  await expect(panel.locator('.ofd-verification-root')).toHaveCount(1);
  await expectNoPageErrors(page, issues);
});

test('验证面板与印章浮层：完整性/签名/链/时间戳信息完整，键盘可操作且与侧栏一致', async ({
  page,
  issues,
}) => {
  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    sidebar: 'signatures',
    waitForRender: false,
  });
  await waitForReport(page);
  await expect.poll(() => overall(page)).toBe('valid');
  const report = await page.evaluate(() => window.__viewer!.getVerificationReport()!);
  expect(report.signatures).toHaveLength(1);
  expect(report.integrity).toBeNull();
  expect(report.signatures[0]!.timestamp.status).toBe('parsed-not-verified');

  // 顶部不再有“验证”按钮：验证结果入口统一为签章列表点击/印章详情。
  await expect(page.locator('[data-ofd-control="verification"]')).toHaveCount(0);
  const summary = page.locator('.ofd-signature-summary-item').first();
  await expect(summary).toBeVisible();
  const statusIcon = summary.locator('.ofd-signature-status');
  await expect(statusIcon).toHaveAttribute('data-status', 'valid');
  await expect(statusIcon).toHaveAttribute('title', /验证有效/);
  await expect(statusIcon).not.toHaveText(/./);
  const overlay = page.locator('.ofd-signature-box[data-signature-id]').first();
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('aria-label', /验证有效/);

  // 统计浮层 animationstart，验证内部字段更新不会重播入场动画。
  await page.evaluate(() => {
    (window as unknown as { __popoverAnimStarts: number }).__popoverAnimStarts = 0;
    document.addEventListener(
      'animationstart',
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.classList.contains('ofd-signature-popover')
        ) {
          (window as unknown as { __popoverAnimStarts: number }).__popoverAnimStarts += 1;
        }
      },
      true,
    );
  });
  await overlay.focus();
  await page.keyboard.press('Enter');
  const popover = page.locator('.ofd-signature-popover');
  await expect(popover).toBeVisible();
  const popoverOrigin = await expectOpeningMotion(popover, 'ofd-popover-in');
  expect(popoverOrigin).toContain('0px');
  expect(
    await popover.evaluate((element) => element.contains(document.activeElement)),
  ).toBe(true);
  // 动画结束后位置仍与脚本写入的锚点坐标一致，transform 回到 none。
  const settled = await popover.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    const rect = element.getBoundingClientRect();
    return {
      leftDelta: Math.abs(rect.left - Number.parseFloat(element.style.left)),
      topDelta: Math.abs(rect.top - Number.parseFloat(element.style.top)),
      transform: getComputedStyle(element).transform,
    };
  });
  expect(settled.leftDelta).toBeLessThanOrEqual(1);
  expect(settled.topDelta).toBeLessThanOrEqual(1);
  expect(settled.transform).toBe('none');
  await popover.locator('dt').first().evaluate((element) => {
    element.textContent = `${element.textContent} `;
  });
  await page.waitForTimeout(60);
  expect(
    await page.evaluate(
      () => (window as unknown as { __popoverAnimStarts: number }).__popoverAnimStarts,
    ),
  ).toBe(1);
  await expect(popover).toContainText('有效');
  await expect(popover).toContainText('已解析，未验证');
  await expect(popover).toContainText('生成时间（UTC+8）');
  await expect(popover.locator('dt', { hasText: 'TSA' })).toBeVisible();
  await expect(popover.locator('dt', { hasText: '序列号' })).toBeVisible();
  await expect(popover).not.toContainText('genTime');
  const popoverSeal = popover.locator('.ofd-signature-popover__seal img');
  await expect(popoverSeal).toBeVisible();
  await expect
    .poll(() => popoverSeal.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  await expect(popover.locator('dt', { hasText: '证书链' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(overlay).toBeFocused();

  // 空格键同样激活；浮层按钮打开与侧栏一致的签章详情。
  await page.keyboard.press(' ');
  await expect(popover).toBeVisible();
  await popover.locator('[data-ofd-control="signature-popover-details"]').click();
  const detail = page.locator('.ofd-dialog');
  await expect(detail).toBeVisible();
  await expectOpeningMotion(detail, 'ofd-dialog-in');
  await expect(detail).toContainText('签章信息');
  await expect(detail).toContainText('签发时间');
  await expect(detail).toContainText('2026-10-23 01:51:06');
  const trustTag = detail.locator('[data-ofd-control="signature-trust-tag"]');
  await expect(trustTag).toHaveText('可信');
  await expect(trustTag).toHaveAttribute('data-trust', 'trusted');
  const chainSection = detail.locator('[data-ofd-control="signature-chain-section"]');
  await expect(chainSection).toContainText('根证书链验证');
  await expect(chainSection).toContainText('链状态');
  await expect(chainSection).toContainText('有效');
  await expect(detail).not.toContainText('证书链通过');
  await expect(detail.locator('[data-ofd-control="signature-signer-cert-download"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  // 侧栏列表点击打开同一个详情面板，并标记当前项。
  await summary.click();
  await expect(summary).toHaveAttribute('data-selected', 'true');
  await expect(detail).toBeVisible();
  await expect(detail.locator('[data-ofd-control="signature-chain-section"]')).toBeVisible();
  // 详情与验证面板合并：总体状态、签名校验项、时间戳与链状态同源同措辞。
  for (const text of ['验证结果', '总体状态', 'SES 版本', 'dataHash', 'Reference', '数学签名']) {
    await expect(detail).toContainText(text);
  }
  await expect(detail.locator('.ofd-dialog__title')).toHaveText('签章信息（有效）');
  await expect(detail.locator('.ofd-signature-badge')).toHaveText('有效');
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  // 验证面板仍由工具栏入口打开，展示签名/完整性与时间戳细节。
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const panel = page.locator('.ofd-verification-panel');
  await expect(panel).toBeVisible();
  for (const text of ['SES 版本', 'dataHash', 'Reference', '数学签名', '证书链', '印章']) {
    await expect(panel).toContainText(text);
  }
  await expect(panel).toContainText('已解析，未验证');
  // 无防夹带完整性（report.integrity===null）：整块隐藏，而不是显示空卡片。
  await expect(panel.locator('.ofd-verification-integrity')).toHaveCount(0);
  await expect(panel).toContainText('生成时间（UTC+8）');
  await expect(panel).toContainText('TSA');
  await expect(panel).toContainText('序列号');
  await expect(panel.locator('.ofd-verification-timestamp')).toHaveAttribute(
    'data-status',
    'parsed-not-verified',
  );
  const timestampText = await panel.locator('.ofd-verification-timestamp').first().textContent();
  expect(timestampText).toMatch(/生成时间（UTC\+8）：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  expect(timestampText).toContain('不参与总体状态');
  expect(timestampText).not.toContain('genTime');
  await expect(panel).not.toContainText('是否加密');
  await expect(panel).not.toContainText('是否已解密');
  const panelText = await panel.textContent();
  expect(panelText).not.toMatch(/时间戳验证通过|时间戳有效/);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // 印章浮层的“验证结果”入口打开同一个验证面板（三处入口统一）。
  await overlay.click();
  await expect(popover).toBeVisible();
  await popover.locator('[data-ofd-control="signature-popover-panel"]').click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('总体状态：有效');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('验证面板：未验证空态、加载态、重复验证', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    autoVerify: false,
    waitForRender: false,
  });
  expect(await page.evaluate(() => window.__viewer!.getVerificationReport())).toBeUndefined();
  expect(await eventCount(page, 'verificationcompleted')).toBe(0);

  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const panel = page.locator('.ofd-verification-panel');
  const reverify = page.locator('[data-ofd-control="verification-reverify"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('尚未验证本文档');
  await expect(panel.locator('.ofd-verification-signature')).toHaveCount(0);
  await expect(reverify).toBeEnabled();

  // 面板按钮经 viewer.verify 转发到 CryptoService.verify；只挂起外层
  // viewer.verify 时内部验证仍会完成并复位 loading，reverify 随即恢复可用。
  // 因此门控 CryptoService.verify 内、verifyOfd 之前的 ensureRoots 等待点：
  // 验证停在加载态，报告保持 undefined，reverify 维持禁用。
  await page.evaluate(() => {
    const service = (
      window.__viewer as unknown as {
        cryptoService: { ensureRoots: () => Promise<void> };
      }
    ).cryptoService;
    const original = service.ensureRoots;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as unknown as { __releaseVerify?: (() => void) | null }).__releaseVerify = null;
    service.ensureRoots = () => {
      (window as unknown as { __releaseVerify: (() => void) | null }).__releaseVerify = release;
      return held.then(() => original.call(service));
    };
    // 恢复原型上的真实实现，供后续再次验证。
    (window as unknown as { __restoreVerify?: () => void }).__restoreVerify = () => {
      delete (service as unknown as { ensureRoots?: () => Promise<void> }).ensureRoots;
    };
  });
  await reverify.click();
  await expect(panel.locator('.ofd-verification-loading')).toBeVisible();
  await expect(reverify).toBeDisabled();
  expect(await page.evaluate(() => window.__viewer!.getVerificationReport())).toBeUndefined();
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __releaseVerify?: unknown }).__releaseVerify === 'function',
  );
  await page.evaluate(() =>
    (window as unknown as { __releaseVerify: () => void }).__releaseVerify(),
  );
  await expect.poll(() => overall(page)).toBe('valid');
  await expect(panel).not.toContainText('正在验证…');
  expect(await eventCount(page, 'verificationcompleted')).toBe(1);

  // 恢复真实入口后再次验证，报告与事件均更新。
  await page.evaluate(() =>
    (window as unknown as { __restoreVerify: () => void }).__restoreVerify(),
  );
  await reverify.click();
  await expect.poll(() => eventCount(page, 'verificationcompleted')).toBe(2);
  await expect(panel).toContainText('总体状态：有效');
  await expectNoPageErrors(page, issues);
});

test('关闭 verification：旧报告立即失效、浮层关闭、按钮禁用且 verify 抛功能关闭', async ({
  page,
  issues,
}) => {
  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    waitForRender: false,
  });
  await waitForReport(page);
  await expect.poll(() => overall(page)).toBe('valid');
  const overlay = page.locator('.ofd-signature-box[data-signature-id]').first();
  await overlay.click();
  await expect(page.locator('.ofd-signature-popover')).toBeVisible();

  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const panel = page.locator('.ofd-verification-panel');
  await expect(panel).toContainText('总体状态：有效');
  await expectOpeningMotion(page.locator('.ofd-dialog'), 'ofd-dialog-in');
  const reverify = page.locator('[data-ofd-control="verification-reverify"]');
  await expect(reverify).toBeEnabled();

  await page.evaluate(() => window.__viewer!.setFeatures({ verification: false }));

  await expect(page.locator('.ofd-signature-popover')).toHaveCount(0);
  expect(await page.evaluate(() => window.__viewer!.getVerificationReport())).toBeUndefined();
  // UI shell 关闭被禁用功能的对话框；旧报告和重新验证按钮不得残留。
  await expect(panel).toHaveCount(0);
  await expect(reverify).toHaveCount(0);
  await expect(overlay).toHaveAttribute('aria-label', /未验证/);
  const code = await page.evaluate(async () => {
    try {
      await window.__viewer!.verify();
      return 'none';
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
  expect(code).toBe('OFD_FEATURE_DISABLED');
  await expectNoPageErrors(page, issues);
});

test('验证面板：入口失败显示 role=alert，恢复后重试验证成功', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    autoVerify: false,
    waitForRender: false,
  });
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const panel = page.locator('.ofd-verification-panel');
  const reverify = page.locator('[data-ofd-control="verification-reverify"]');
  const error = panel.locator('.ofd-verification-error');
  // 使用真实入口的取消错误，确保 CryptoService 记录 error 并渲染 role=alert。
  await page.evaluate(() => {
    const abort = new AbortController();
    abort.abort();
    void window.__viewer!.verify({ signal: abort.signal }).catch(() => undefined);
  });
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('已取消打开加密文档');
  await expect(panel).toContainText('尚未验证本文档');
  expect(await page.evaluate(() => window.__viewer!.getVerificationReport())).toBeUndefined();

  await reverify.click();
  await expect.poll(() => overall(page)).toBe('valid');
  await expect(error).toBeHidden();
  await expect(panel).toContainText('总体状态：有效');
  await expectNoPageErrors(page, issues);
});

test('凭据弹窗：口令与私钥字段必须具有程序化可访问名称', async ({ page }) => {
  const unnamedFields = async (): Promise<unknown[]> =>
    page.locator('.ofd-dialog input').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const input = element as HTMLInputElement;
          const labelledBy = input.getAttribute('aria-labelledby');
          const hasLabelledBy =
            labelledBy !== null &&
            labelledBy
              .split(/\s+/)
              .every((id) => id !== '' && document.getElementById(id)?.textContent?.trim());
          return (
            !(input.labels && input.labels.length > 0) &&
            !input.getAttribute('aria-label')?.trim() &&
            !hasLabelledBy &&
            !input.getAttribute('title')?.trim() &&
            !input.getAttribute('placeholder')?.trim()
          );
        })
        .map((element) => {
          const input = element as HTMLInputElement;
          return {
            type: input.type,
            control: input.dataset.ofdControl ?? '',
          };
        }),
    );

  await page.goto(viewerUrl(FIXTURES.cryptoPassword, { autoPrompt: true }));
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  const passwordFields = await unnamedFields();

  await page.goto(viewerUrl(FIXTURES.cryptoCert, { autoPrompt: true }));
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  const certificateFields = await unnamedFields();

  expect([...passwordFields, ...certificateFields]).toEqual([]);
});

test('showcase：签名/完整性通过为绿色，证书链独立显示未知且不改变总体状态', async ({
  page,
  issues,
}) => {
  test.setTimeout(180_000);
  mkdirSync(ARTIFACTS, { recursive: true });
  await openViewer(page, SHOWCASE, { waitForRender: false });
  await page.waitForFunction(() => window.__viewer!.getVerificationReport() !== undefined, null, {
    timeout: 120_000,
  });
  const report = await page.evaluate(() => window.__viewer!.getVerificationReport()!);
  expect(report.overall).toBe('valid');
  expect(report.rootsConfigured).toBe(false);
  expect(report.package.encrypted).toBe(false);
  expect(report.integrity).not.toBeNull();
  expect(report.integrity?.status).toBe('valid');
  expect(report.integrity?.fileListCount).toBe(18);
  expect(report.signatures.length).toBeGreaterThan(0);
  expect(report.signatures.every((signature) => signature.certificate.status === 'unknown')).toBe(
    true,
  );
  expect(report.signatures.some((signature) => signature.signature.status === 'valid')).toBe(true);
  expect(report.signatures.some((signature) => signature.dataHash.status === 'valid')).toBe(true);

  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const panel = page.locator('.ofd-verification-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('总体状态：有效');
  await expect(panel.locator('.ofd-verification-badge[data-status="valid"]').first()).toContainText(
    '有效',
  );
  await expect(panel).toContainText('未配置与签章链匹配的信任根');
  await expect(panel).toContainText('证书链无法建立信任');
  await expect(panel).toContainText('不改变总体状态');
  await expect(panel).toContainText('数学签名有效');
  await expect(panel).toContainText('dataHash有效');
  await expect(panel).toContainText('签名数学、数据哈希、引用完整性与印章结构/数学可独立判定');
  // 明文：加解密行不渲染；完整性存在（report.integrity 非 null）时保留卡片。
  await expect(panel).not.toContainText('是否加密');
  await expect(panel).not.toContainText('是否已解密');
  const integrity = panel.locator('.ofd-verification-integrity');
  await expect(integrity).toBeVisible();
  await expect(integrity).toHaveAttribute('data-status', 'valid');
  await expect(integrity).toContainText('清单文件数');
  await expect(integrity).toContainText('18');

  const timestamp = panel
    .locator('.ofd-verification-timestamp[data-status="parsed-not-verified"]')
    .first();
  await expect(timestamp).toContainText('生成时间（UTC+8）：2026-10-23 15:59:26');
  await expect(timestamp).toContainText('TSA：');
  await expect(timestamp).toContainText('序列号：01a167c59e2f');
  await expect(timestamp).toContainText('不参与总体状态');
  await expect(timestamp).not.toContainText('genTime');

  const sealImage = panel.locator('.ofd-verification-signature__seal img').first();
  await expect(sealImage).toBeVisible();
  await expect(sealImage).toHaveAttribute('alt', /印章图片：.+/);
  await expect
    .poll(() => sealImage.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  // 等浏览器完成解码，避免截图时只拿到布局占位而没有像素。
  await sealImage.evaluate(async (element) => {
    await (element as HTMLImageElement).decode();
  });
  await expect
    .poll(() => panel.locator('.ofd-verification-signature__seal img').count())
    .toBeGreaterThan(0);

  await page.screenshot({
    path: resolve(ARTIFACTS, 'showcase-verification-unknown.png'),
    fullPage: false,
  });
  // 滚动到时间戳/印章区域，截图同时覆盖具体 UTC+8 时间与真实印章图片。
  await sealImage.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(ARTIFACTS, 'showcase-verification-timestamp-seal.png'),
    fullPage: false,
  });
  await expectNoPageErrors(page, issues);
});

test('验证结果配色：light/dark 的 valid/unknown/invalid 以颜色+文字区分且对比度 ≥4.5', async ({
  page,
  issues,
}) => {
  test.setTimeout(180_000);
  mkdirSync(ARTIFACTS, { recursive: true });

  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    waitForRender: false,
  });
  await expect.poll(() => overall(page)).toBe('valid');
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const validBadge = page.locator('.ofd-verification-badge[data-status="valid"]').first();
  await expect(validBadge).toContainText('有效');
  const lightValid = await badgeColors(page, 'valid');
  await page.screenshot({ path: resolve(ARTIFACTS, 'verification-colors-light-valid.png') });

  // dark：同一状态在暗色主题下重新计算前景/背景对比度。
  await page.evaluate(() => window.__viewer!.setTheme('dark'));
  await expect(page.locator('.ofd-viewer')).toHaveAttribute('data-theme', 'dark');
  const darkValid = await badgeColors(page, 'valid');
  expect(contrastRatio(lightValid.foreground, lightValid.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(darkValid.foreground, darkValid.background)).toBeGreaterThanOrEqual(4.5);
  expect(lightValid.foreground).not.toBe(darkValid.foreground);
  await page.screenshot({ path: resolve(ARTIFACTS, 'verification-colors-dark-valid.png') });

  // unknown：在真实报告上模拟“签名状态未知”，仅用于校验颜色/文字双编码。
  await openViewer(page, FIXTURES.cryptoSigned, {
    rootCertificate: FIXTURES.cryptoRoot,
    waitForRender: false,
  });
  await expect.poll(() => overall(page)).toBe('valid');
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  await page.evaluate(() => {
    const service = (
      window.__viewer as unknown as {
        cryptoService: { getReport(): Record<string, unknown>; openPanel(): void };
      }
    ).cryptoService;
    const report = service.getReport();
    report.overall = 'unknown';
    for (const signature of report.signatures as Array<Record<string, unknown>>) {
      signature.status = 'unknown';
    }
  });
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const unknownBadge = page.locator('.ofd-verification-badge[data-status="unknown"]').first();
  await expect(unknownBadge).toContainText('未知');
  const unknown = await badgeColors(page, 'unknown');
  expect(contrastRatio(unknown.foreground, unknown.background)).toBeGreaterThanOrEqual(4.5);
  expect(unknown.foreground).not.toBe(lightValid.foreground);

  // invalid：签名值被篡改 → 签名数学/摘要失败。
  await openViewer(page, FIXTURES.cryptoTamperedSignature, { waitForRender: false });
  await expect.poll(() => overall(page)).toBe('invalid');
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  const invalidBadge = page.locator('.ofd-verification-badge[data-status="invalid"]').first();
  await expect(invalidBadge).toContainText('无效');
  await expect(page.locator('.ofd-verification-guidance')).toContainText(
    '证书链无法建立信任',
  );
  const invalid = await badgeColors(page, 'invalid');
  expect(contrastRatio(invalid.foreground, invalid.background)).toBeGreaterThanOrEqual(4.5);
  expect(invalid.foreground).not.toBe(unknown.foreground);
  await page.screenshot({ path: resolve(ARTIFACTS, 'verification-colors-invalid-root.png') });
  await expectNoPageErrors(page, issues);
});

test('签章浮层状态徽标：valid/unknown/invalid 在 light/dark 有颜色+文字且对比度 ≥4.5', async ({
  page,
  issues,
}) => {
  test.setTimeout(240_000);
  const artifacts = resolve(
    process.cwd(),
    '../../test/.artifacts/ui-bugfix-20261023/t21',
  );
  mkdirSync(artifacts, { recursive: true });
  const cases = [
    {
      status: 'valid',
      label: '有效',
      open: () =>
        openViewer(page, FIXTURES.cryptoSigned, {
          rootCertificate: FIXTURES.cryptoRoot,
          waitForRender: false,
        }),
    },
    {
      status: 'unknown',
      label: '未知',
      open: async () => {
        await openViewer(page, FIXTURES.cryptoSigned, {
          rootCertificate: FIXTURES.cryptoRoot,
          waitForRender: false,
        });
        await page.waitForFunction(() => window.__viewer!.getVerificationReport() !== undefined);
        await page.evaluate(() => {
          const service = (
            window.__viewer as unknown as {
              cryptoService: { getReport(): Record<string, unknown> };
            }
          ).cryptoService;
          const report = service.getReport();
          report.overall = 'unknown';
          for (const signature of report.signatures as Array<Record<string, unknown>>) {
            signature.status = 'unknown';
          }
        });
      },
    },
    {
      status: 'invalid',
      label: '无效',
      open: () => openViewer(page, FIXTURES.cryptoTamperedSignature, { waitForRender: false }),
    },
  ] as const;
  const lightForegrounds: string[] = [];
  const darkForegrounds: string[] = [];
  const colorRecords: Array<{
    status: string;
    light: Record<string, string>;
    dark: Record<string, string>;
  }> = [];

  for (const item of cases) {
    await item.open();
    await expect.poll(() => overall(page), { timeout: 120_000 }).toBe(item.status);
    const overlay = page.locator('.ofd-signature-box[data-signature-id]').first();
    await expect(overlay).toBeVisible();
    await overlay.click();
    const popover = page.locator('.ofd-signature-popover');
    await expect(popover).toBeVisible();
    const badge = popover.locator('.ofd-signature-badge');
    await expect(badge).toHaveAttribute('data-status', item.status);
    await expect(badge).toHaveText(item.label);

    const light = await popoverBadgeColors(page, item.status);
    expect(light.text).toBe(item.label);
    expect(light.borderColor).toBe(light.foreground);
    expect(contrastRatio(light.foreground, light.background)).toBeGreaterThanOrEqual(4.5);
    lightForegrounds.push(light.foreground);
    await page.screenshot({
      path: resolve(artifacts, `popover-${item.status}-light.png`),
      fullPage: false,
    });

    await page.evaluate(() => window.__viewer!.setTheme('dark'));
    await expect(page.locator('.ofd-viewer')).toHaveAttribute('data-theme', 'dark');
    const dark = await popoverBadgeColors(page, item.status);
    expect(dark.text).toBe(item.label);
    expect(dark.borderColor).toBe(dark.foreground);
    expect(contrastRatio(dark.foreground, dark.background)).toBeGreaterThanOrEqual(4.5);
    expect(dark.foreground).not.toBe(light.foreground);
    darkForegrounds.push(dark.foreground);
    colorRecords.push({ status: item.status, light, dark });
    await page.screenshot({
      path: resolve(artifacts, `popover-${item.status}-dark.png`),
      fullPage: false,
    });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
  }

  expect(new Set(lightForegrounds).size).toBe(3);
  expect(new Set(darkForegrounds).size).toBe(3);
  writeFileSync(
    resolve(artifacts, 'popover-badge-colors.json'),
    JSON.stringify(colorRecords, null, 2),
  );
  await expectNoPageErrors(page, issues);
});