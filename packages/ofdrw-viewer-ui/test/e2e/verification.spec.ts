/**
 * UI 密码能力独立验收：加密打开、验证面板、印章浮层、根证书与无障碍。
 *
 * 本文件只使用公共阅读器 API 与真实 crypto 夹具，不复制产品实现；所有断言
 * 都落在浏览器 DOM/状态/验证报告上。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, expectNoPageErrors, test } from './fixtures';
import { eventCount, FIXTURES, openViewer, viewerUrl } from './support';

const PASSWORD = 'FixturePass123';
const CERT_USER = 'fixture-cert-user';
const ROOT_SUBJECT = 'CN=OFDRW Viewer Crypto Fixtures Root CA';

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

test('验证面板：无根 unknown，PEM/DER/CER 根均可配置，错误证书只 warning 不崩溃', async ({
  page,
  issues,
}) => {
  await openViewer(page, FIXTURES.cryptoSigned, { waitForRender: false });
  await expect.poll(() => overall(page)).toBe('unknown');
  await page.locator('[data-ofd-control="verification"]').click();
  const panel = page.locator('.ofd-verification-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('总体状态：未知');
  await expect(panel).toContainText('未配置根证书');
  await expect(panel).toContainText('证书链状态 unknown');
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
  await expect.poll(() => overall(page)).toBe('unknown');
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
  await expect.poll(() => overall(page)).toBe('unknown');
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
  await expect.poll(() => overall(page)).toBe('unknown');

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
  expect(report.signatures[0]!.timestamp.status).toBe('parsed-not-verified');

  const summary = page.locator('.ofd-signature-summary-item').first();
  await expect(summary).toBeVisible();
  await expect(summary.locator('.ofd-signature-badge')).toHaveText('验证有效');
  const overlay = page.locator('.ofd-signature-box[data-signature-id]').first();
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('aria-label', /验证有效/);

  await overlay.focus();
  await page.keyboard.press('Enter');
  const popover = page.locator('.ofd-signature-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('有效');
  await expect(popover).toContainText('已解析，未验证');
  await expect(popover.locator('dt', { hasText: '证书链' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(overlay).toBeFocused();

  // 空格键同样激活，随后进入完整面板。
  await page.keyboard.press(' ');
  await expect(popover).toBeVisible();
  await popover.locator('[data-ofd-control="signature-popover-full"]').click();
  const panel = page.locator('.ofd-verification-panel');
  await expect(panel).toBeVisible();
  for (const text of ['SES 版本', 'dataHash', 'Reference', '数学签名', '证书链', '印章']) {
    await expect(panel).toContainText(text);
  }
  await expect(panel).toContainText('已解析，未验证');
  await expect(panel).toContainText('genTime');
  await expect(panel).toContainText('TSA');
  await expect(panel.locator('.ofd-verification-timestamp')).toHaveAttribute(
    'data-status',
    'parsed-not-verified',
  );
  const panelText = await panel.textContent();
  expect(panelText).not.toMatch(/时间戳验证通过|时间戳有效/);
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

  await page.locator('[data-ofd-control="verification"]').click();
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
  await page.locator('[data-ofd-control="verification"]').click();
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