/**
 * t3 独立浏览器验收：验证语义呈现、根证书链/可信 tag、证书下载、
 * 浮层与侧栏详情一致性、侧栏卡片交互、OFD 原文件导出与图片导出回归、门控。
 *
 * 只通过公共阅读器 API、真实 OFD 夹具与浏览器 DOM 断言；不复制产品实现。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import type { Download, Page } from '@playwright/test';
import { parseCertificate } from '../../../ofdrw-viewer-crypto/dist/index.js';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer } from './support';

/** 仓库根目录。 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
/** crypto 夹具目录。 */
const CRYPTO_DIR = join(REPO_ROOT, 'packages/ofdrw-viewer-crypto/test/fixtures/crypto');
/** 4 页明文 OFD 源文件。 */
const MULTI_OFD = join(REPO_ROOT, 'ofd_pdf_match/z.ofd');
/** 生成的文件与证据目录（位于 test 范围内）。 */
const T3_ARTIFACTS = join(REPO_ROOT, 'packages/ofdrw-viewer-ui/test/.artifacts/t3');
/** 根证书 DER。 */
const ROOT_DER = readFileSync(join(CRYPTO_DIR, 'certs/root-ca.crt.der'));
/** 签章者证书 DER。 */
const SIGNER_DER = readFileSync(join(CRYPTO_DIR, 'certs/signer.crt.der'));
/** 与签章链无关的 TSA 证书 DER，作为错误信任根。 */
const WRONG_ROOT_DER = readFileSync(join(CRYPTO_DIR, 'certs/tsa.crt.der'));

/**
 * 读取当前验证总体状态。
 *
 * @param page 页面。
 * @returns overall 或 undefined。
 */
async function overall(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__viewer!.getVerificationReport()?.overall);
}

/**
 * 等待验证完成事件。
 *
 * @param page 页面。
 */
async function waitForReport(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__events?.some((event) => event.type === 'verificationcompleted'),
    null,
    { timeout: 60_000 },
  );
}

/**
 * 等待下载并读取字节。
 *
 * @param download Playwright 下载对象。
 * @returns 文件名与字节。
 */
async function readDownload(download: Download): Promise<{ name: string; bytes: Buffer }> {
  const path = await download.path();
  expect(path).not.toBeNull();
  return { name: download.suggestedFilename(), bytes: readFileSync(path!) };
}

/**
 * 断言证书下载文件名安全、字节为可解析 DER 且不含 PEM/私钥文本。
 *
 * @param name 下载文件名。
 * @param bytes 下载字节。
 * @param expected 夹具中的证书 DER。
 * @param subjectPart 证书主体应包含的片段。
 */
function expectSafeCertificateDer(
  name: string,
  bytes: Buffer,
  expected: Buffer,
  subjectPart: string,
): void {
  expect(name.endsWith('.der')).toBe(true);
  expect(name).not.toMatch(/[\\/:*?"<>|]/);
  expect(name).not.toContain('..');
  expect(name.trim()).toBe(name);
  expect(bytes.equals(expected)).toBe(true);
  expect(bytes[0]).toBe(0x30);
  const text = bytes.toString('utf8');
  expect(text).not.toContain('PRIVATE KEY');
  expect(text).not.toContain('-----BEGIN');
  const certificate = parseCertificate(new Uint8Array(bytes));
  expect(certificate.subject).toContain(subjectPart);
}

/**
 * 打开验证面板。
 *
 * @param page 页面。
 */
async function openPanel(page: Page): Promise<void> {
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  await expect(page.locator('.ofd-verification-panel')).toBeVisible();
}

/**
 * 构造带“禁止导出/打印”权限的 OFD，写入 test 范围内的产物目录。
 *
 * @returns 浏览器可访问的 URL 路径。
 */
function createPermissionDeniedFixture(): string {
  mkdirSync(T3_ARTIFACTS, { recursive: true });
  const zip = unzipSync(readFileSync(MULTI_OFD));
  const documentPath = 'Doc_0/Document.xml';
  const document = new TextDecoder().decode(zip[documentPath]!);
  const permission =
    '<ofd:Permissions><ofd:Export>false</ofd:Export>' +
    '<ofd:Print Printable="false"/></ofd:Permissions>';
  const patched = document.replace(/(<ofd:Document[^>]*>)/, `$1${permission}`);
  expect(patched).not.toBe(document);
  zip[documentPath] = new TextEncoder().encode(patched);
  const output = join(T3_ARTIFACTS, 'permissions-denied.ofd');
  writeFileSync(output, Buffer.from(zipSync(zip)));
  return '/packages/ofdrw-viewer-ui/test/.artifacts/t3/permissions-denied.ofd';
}

/**
 * 读取签章详情的可比较快照（标题、字段、链栏、可信 tag）。
 *
 * @param page 页面。
 * @returns 详情快照。
 */
async function detailSnapshot(page: Page) {
  return page.locator('.ofd-dialog').evaluate((dialog) => {
    const normalized = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    const title = normalized(dialog.querySelector('.ofd-dialog__title')?.textContent);
    const pairs = [...dialog.querySelectorAll('.ofd-signature-detail__pairs dt, .ofd-signature-detail__pairs dd')]
      .map((node) => normalized(node.textContent));
    const chain = dialog.querySelector('[data-ofd-control="signature-chain-section"]');
    const chainLabels = [...(chain?.querySelectorAll('dt') ?? [])].map((node) =>
      normalized(node.textContent),
    );
    const chainText = normalized(chain?.textContent);
    const trust = dialog.querySelector('[data-ofd-control="signature-trust-tag"]');
    return {
      title,
      pairs,
      chainLabels,
      chainText,
      trustText: normalized(trust?.textContent),
      trustData: (trust as HTMLElement | null)?.dataset.trust ?? null,
      signerDownload: dialog.querySelector('[data-ofd-control="signature-signer-cert-download"]') !== null,
    };
  });
}

test.describe('t3-B 验证面板与详情', () => {
  test('链失败时总体仍为绿色有效；无验证时间；签发时间与时间戳文案正确', async ({
    page,
    issues,
  }) => {
    test.setTimeout(120_000);
    await openViewer(page, FIXTURES.cryptoSigned, { waitForRender: false });
    await expect.poll(() => overall(page)).toBe('valid');
    await openPanel(page);

    const panel = page.locator('.ofd-verification-panel');
    const overallBadge = panel.locator('.ofd-verification-badge[data-status="valid"]').first();
    await expect(overallBadge).toContainText('有效');
    // 通过计算色确认是成功绿，而不是仅凭 data-status。
    await expect
      .poll(() => overallBadge.evaluate((element) => getComputedStyle(element).color))
      .toBe('rgb(6, 118, 71)');
    await expect(panel).not.toContainText('验证时间');
    await expect(panel).not.toContainText('耗时');

    const signatureCard = panel.locator('.ofd-verification-signature').first();
    await expect(signatureCard).toContainText('签发时间');
    await expect(signatureCard).toContainText('2026-10-23 01:51:06');
    await expect(signatureCard).toContainText('证书链（不影响总体状态）');
    await expect(signatureCard).toContainText('未知');
    const timestamp = panel.locator('.ofd-verification-timestamp[data-status="parsed-not-verified"]').first();
    await expect(timestamp).toContainText('已解析，未验证');
    await expect(timestamp).toContainText('不参与总体状态');

    // 配置错误根：链变为不完整/不受信，但总体徽标必须仍为绿色有效。
    const rootInput = page.locator('[data-ofd-control="verification-root-input"]');
    await rootInput.setInputFiles({
      name: 'wrong-root.der',
      mimeType: 'application/pkix-cert',
      buffer: WRONG_ROOT_DER,
    });
    await expect(panel.locator('.ofd-verification-root')).toHaveCount(1);
    await expect.poll(() => overall(page)).toBe('valid');
    const afterChainFailure = panel.locator('.ofd-verification-badge[data-status="valid"]').first();
    await expect(afterChainFailure).toContainText('有效');
    await expect
      .poll(() => afterChainFailure.evaluate((element) => getComputedStyle(element).color))
      .toBe('rgb(6, 118, 71)');
    await expect(signatureCard).not.toContainText('证书链（不影响总体状态）：有效');
    await expect(panel).not.toContainText('验证时间');
    await expect(panel).not.toContainText('耗时');
    await expectNoPageErrors(page, issues);
  });

  test('详情：根证书链验证栏字段完整、可信/未知 tag 与 aria、签发时间', async ({
    page,
    issues,
  }) => {
    test.setTimeout(120_000);
    await openViewer(page, FIXTURES.cryptoSigned, {
      rootCertificate: FIXTURES.cryptoRoot,
      sidebar: 'signatures',
      waitForRender: false,
    });
    await waitForReport(page);
    await expect.poll(() => overall(page)).toBe('valid');

    const summary = page.locator('.ofd-signature-summary-item').first();
    await expect(summary).toBeVisible();
    await summary.click();
    const dialog = page.locator('.ofd-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.ofd-dialog__title')).toContainText('签章信息');

    const chain = dialog.locator('[data-ofd-control="signature-chain-section"]');
    await expect(chain).toContainText('根证书链验证');
    for (const label of ['链状态', '是否配置信任根', '签名者证书', '信任锚', '链成员']) {
      await expect(chain).toContainText(label);
    }
    await expect(chain).toContainText('有效');
    await expect(chain).toContainText('是');
    await expect(chain).toContainText('OFDRW Viewer Crypto Fixtures Signer');
    await expect(chain).toContainText('OFDRW Viewer Crypto Fixtures Root CA');
    await expect(chain).toContainText('指纹');
    await expect(chain).toContainText('有效期');
    await expect(dialog).toContainText('签发时间');
    await expect(dialog).toContainText('2026-10-23 01:51:06');

    const trustedTag = dialog.locator('[data-ofd-control="signature-trust-tag"]');
    await expect(trustedTag).toHaveText('可信');
    await expect(trustedTag).toHaveAttribute('data-trust', 'trusted');
    expect(await trustedTag.getAttribute('aria-hidden')).not.toBe('true');
    expect(await trustedTag.ariaSnapshot()).toContain('可信');
    // 可信状态不得泄漏为“证书链通过”式最终结论。
    await expect(dialog).not.toContainText('证书链通过');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // 无根时同一详情显示“可信状态未知”，且总体仍有效。
    await openViewer(page, FIXTURES.cryptoSigned, {
      sidebar: 'signatures',
      waitForRender: false,
    });
    await waitForReport(page);
    await expect.poll(() => overall(page)).toBe('valid');
    await page.locator('.ofd-signature-summary-item').first().click();
    const unknownDialog = page.locator('.ofd-dialog');
    await expect(unknownDialog).toBeVisible();
    const unknownTag = unknownDialog.locator('[data-ofd-control="signature-trust-tag"]');
    await expect(unknownTag).toHaveText('可信状态未知');
    await expect(unknownTag).toHaveAttribute('data-trust', 'unknown');
    await expect(unknownDialog.locator('[data-ofd-control="signature-chain-section"]')).toContainText(
      '未知',
    );
    expect(await unknownTag.ariaSnapshot()).toContain('可信状态未知');
    await expectNoPageErrors(page, issues);
  });

  test('验证面板：签发时间缺失显示“未提供”', async ({ page, issues }) => {
    test.setTimeout(120_000);
    await openViewer(page, FIXTURES.cryptoSigned, { waitForRender: false });
    await waitForReport(page);
    await expect.poll(() => overall(page)).toBe('valid');
    await openPanel(page);

    await page.evaluate(() => {
      const service = (
        window.__viewer as unknown as {
          cryptoService: { getReport(): Record<string, unknown> };
        }
      ).cryptoService;
      const report = service.getReport();
      for (const signature of report.signatures as Array<Record<string, unknown>>) {
        delete signature.signingTime;
        delete signature.signingTimeSource;
      }
    });
    await page.evaluate(() => window.__viewer!.openVerificationPanel());
    const panel = page.locator('.ofd-verification-panel');
    await expect(panel).toBeVisible();
    const card = panel.locator('.ofd-verification-signature').first();
    await expect(card).toContainText('签发时间');
    await expect(card).toContainText('未提供');
    await expectNoPageErrors(page, issues);
  });
});

test.describe('t3-C 证书下载', () => {
  test('签章者与根证书下载为可解析 DER，文件名安全且无 PEM/私钥', async ({ page, issues }) => {
    test.setTimeout(120_000);
    await openViewer(page, FIXTURES.cryptoSigned, {
      rootCertificate: FIXTURES.cryptoRoot,
      waitForRender: false,
    });
    await waitForReport(page);
    await expect.poll(() => overall(page)).toBe('valid');
    await openPanel(page);
    const panel = page.locator('.ofd-verification-panel');

    const signerButton = panel.locator('[data-ofd-control="verification-signer-cert-download"]');
    await expect(signerButton).toBeVisible();
    const [signerDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      signerButton.click(),
    ]);
    const signer = await readDownload(signerDownload);
    expectSafeCertificateDer(signer.name, signer.bytes, SIGNER_DER, 'Signer');

    await expect(panel.locator('.ofd-verification-root')).toHaveCount(1);
    const rootButton = panel.locator('[data-ofd-control="verification-root-download"]');
    await expect(rootButton).toBeVisible();
    const [rootDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      rootButton.click(),
    ]);
    const root = await readDownload(rootDownload);
    expectSafeCertificateDer(root.name, root.bytes, ROOT_DER, 'Root CA');
    await expectNoPageErrors(page, issues);
  });
});

test.describe('t3-D 浮层跳转与侧栏列表', () => {
  test('浮层“查看签章详情”与侧栏打开同一详情（标题/字段/链栏一致）', async ({
    page,
    issues,
  }) => {
    test.setTimeout(120_000);
    await openViewer(page, FIXTURES.cryptoSigned, {
      rootCertificate: FIXTURES.cryptoRoot,
      sidebar: 'signatures',
      waitForRender: false,
    });
    await waitForReport(page);
    await expect.poll(() => overall(page)).toBe('valid');

    const overlay = page.locator('.ofd-signature-box[data-signature-id]').first();
    await expect(overlay).toBeVisible();
    await overlay.click();
    const popover = page.locator('.ofd-signature-popover');
    await expect(popover).toBeVisible();
    const detailsButton = popover.locator('[data-ofd-control="signature-popover-details"]');
    await expect(detailsButton).toHaveText('查看签章详情');
    await detailsButton.click();
    const popoverDialog = page.locator('.ofd-dialog');
    await expect(popoverDialog).toBeVisible();
    await expect(popoverDialog.locator('.ofd-dialog__title')).toContainText('签章信息');
    const fromPopover = await detailSnapshot(page);
    expect(fromPopover.chainLabels).toEqual(
      expect.arrayContaining(['链状态', '是否配置信任根', '签名者证书', '信任锚', '链成员']),
    );
    expect(fromPopover.trustText).toBe('可信');
    expect(fromPopover.signerDownload).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popoverDialog).toBeHidden();

    const summary = page.locator('.ofd-signature-summary-item').first();
    await expect(summary).toHaveAttribute('aria-haspopup', 'dialog');
    await summary.click();
    const sidebarDialog = page.locator('.ofd-dialog');
    await expect(sidebarDialog).toBeVisible();
    const fromSidebar = await detailSnapshot(page);
    expect(fromSidebar).toEqual(fromPopover);
    await expect(summary).toHaveAttribute('data-selected', 'true');
    await expect(summary).toHaveAttribute('aria-current', 'true');
    await expectNoPageErrors(page, issues);
  });

  test('侧栏签章卡片：无图标、卡片样式、hover/focus/selected 与键盘可用', async ({
    page,
    issues,
  }) => {
    test.setTimeout(120_000);
    await openViewer(page, '/ofd_pdf_match/ofd-viewer-ui-showcase.ofd', {
      sidebar: 'signatures',
      waitForRender: false,
    });
    const panel = page.locator('.ofd-sidebar__panel:not([hidden])');
    const items = panel.locator('.ofd-signature-summary-item');
    await expect(items.first()).toBeVisible();
    await expect(panel).not.toContainText('▣');
    await expect(panel).not.toContainText('✎');
    // 验证状态只用图标：不同状态颜色不同，hover 由 title 给出具体含义。
    const status = items.first().locator('.ofd-signature-status');
    await expect(status.locator('svg')).toHaveCount(1);
    await expect(status).toHaveAttribute('title', /.+/);

    const item = items.first();
    await expect(item).toHaveAttribute('aria-haspopup', 'dialog');
    const ariaLabel = await item.getAttribute('aria-label');
    expect(ariaLabel?.length ?? 0).toBeGreaterThan(0);
    await page.mouse.move(0, 0);
    const base = await item.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        display: style.display,
        radius: Number.parseFloat(style.borderTopLeftRadius),
        border: Number.parseFloat(style.borderTopWidth),
        background: style.backgroundColor,
        outline: style.outlineStyle,
      };
    });
    expect(base.tag).toBe('BUTTON');
    expect(base.display).toBe('grid');
    expect(base.radius).toBeGreaterThan(0);
    expect(base.border).toBeGreaterThan(0);
    expect(base.background).not.toBe('rgba(0, 0, 0, 0)');

    await item.hover();
    await page.waitForTimeout(180);
    const hover = await item.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderTopColor };
    });
    expect(hover.background).not.toBe(base.background);

    await item.focus();
    await expect(item).toBeFocused();
    const focus = await item.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focus.outlineStyle).not.toBe('none');
    expect(focus.outlineWidth).toBeGreaterThan(0);

    await page.keyboard.press('Enter');
    const dialog = page.locator('.ofd-dialog');
    await expect(dialog).toBeVisible();
    await expect(item).toHaveAttribute('data-selected', 'true');
    await expect(item).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expectNoPageErrors(page, issues);
  });
});

test.describe('t3-E 导出', () => {
  test('导出对话框：OFD 下载与源字节一致；PNG/JPEG/WebP 回归', async ({ page, issues }) => {
    test.setTimeout(180_000);
    await openViewer(page, FIXTURES.multi);
    await dismissFindbar(page);
    const source = readFileSync(MULTI_OFD);

    await page.locator('[data-ofd-control="export"]').click();
    let dialog = page.locator('.ofd-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('导出选项');
    let format = dialog.locator('[data-ofd-control="output-format"]');
    await expect
      .poll(() => format.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
      .toEqual(['png', 'jpeg', 'webp', 'ofd']);
    await format.selectOption('ofd');
    await expect(dialog.locator('[data-ofd-control="output-ofd-note"]')).toBeVisible();
    await expect(dialog.locator('[data-ofd-control="output-ofd-note"]')).toContainText('OFD 原文件');
    const imageOptions = await dialog.evaluate((element) => {
      const images = [...element.querySelectorAll<HTMLElement>('.ofd-output-field')].filter(
        (field) => field.querySelector('[data-ofd-control="output-format"]') === null,
      );
      const controls = [...element.querySelectorAll<HTMLSelectElement | HTMLInputElement>(
        '.ofd-output-field select, .ofd-output-field input',
      )].filter((control) => control.dataset.ofdControl !== 'output-format');
      return {
        hidden: images.every((field) => field.hidden),
        disabled: controls.every((control) => control.disabled),
      };
    });
    expect(imageOptions.hidden).toBe(true);
    expect(imageOptions.disabled).toBe(true);

    const [ofdDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      dialog.locator('.ofd-dialog__action--primary').click(),
    ]);
    const ofd = await readDownload(ofdDownload);
    expect(ofd.name.endsWith('.ofd')).toBe(true);
    expect(ofd.name).not.toMatch(/[\\/:*?"<>|]/);
    expect(ofd.bytes.equals(source)).toBe(true);

    const imageCases = [
      { format: 'png', extension: '.png', magic: [0x89, 0x50, 0x4e, 0x47] },
      { format: 'jpeg', extension: '.jpg', magic: [0xff, 0xd8] },
      { format: 'webp', extension: '.webp', magic: [0x52, 0x49, 0x46, 0x46] },
    ] as const;
    for (const imageCase of imageCases) {
      await page.locator('[data-ofd-control="export"]').click();
      dialog = page.locator('.ofd-dialog');
      await expect(dialog).toBeVisible();
      format = dialog.locator('[data-ofd-control="output-format"]');
      await format.selectOption(imageCase.format);
      await expect(dialog.locator('input[type="range"]')).toBeVisible();
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        dialog.locator('.ofd-dialog__action--primary').click(),
      ]);
      const image = await readDownload(download);
      expect(image.name.endsWith(imageCase.extension)).toBe(true);
      for (const [index, value] of imageCase.magic.entries()) {
        expect(image.bytes[index]).toBe(value);
      }
      if (imageCase.format === 'webp') {
        expect(image.bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
      }
    }
    await expectNoPageErrors(page, issues);
  });

  test('exportOfd：ArrayBuffer 与 base64 解码来源均逐字节一致', async ({ page, issues }) => {
    test.setTimeout(180_000);
    await openViewer(page, FIXTURES.multi);
    const sourceBase64 = readFileSync(MULTI_OFD).toString('base64');
    const result = await page.evaluate(async (base64) => {
      const stage = document.querySelector<HTMLElement>('#stage');
      if (!stage) throw new Error('缺少 #stage');
      const original = new Uint8Array(await (await fetch('/ofd_pdf_match/z.ofd')).arrayBuffer());
      const decoded = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const viewer = window.__viewer!;
      const Ctor = viewer.constructor as new (options: {
        container: HTMLElement;
        source: ArrayBuffer | Uint8Array;
        initialScale: number;
      }) => typeof viewer;

      const run = async (
        source: ArrayBuffer | Uint8Array,
        filename: string,
      ): Promise<{ filename: string; size: number; bytes: number[] }> => {
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:0;top:0;width:480px;height:360px;';
        const container = document.createElement('div');
        host.appendChild(container);
        stage.appendChild(host);
        const instance = new Ctor({ container, source, initialScale: 1 });
        try {
          await instance.ready;
          const exported = await instance.exportOfd({ filename });
          const bytes = new Uint8Array(await exported.blob.arrayBuffer());
          return { filename: exported.filename, size: exported.size, bytes: [...bytes] };
        } finally {
          instance.destroy();
          host.remove();
        }
      };

      const arraybuffer = await run(original.buffer as ArrayBuffer, 'arraybuffer-original');
      const base64Result = await run(decoded, 'base64-original');
      return { original: [...original], arraybuffer, base64: base64Result };
    }, sourceBase64);

    expect(result.arraybuffer.filename).toBe('arraybuffer-original.ofd');
    expect(result.base64.filename).toBe('base64-original.ofd');
    expect(result.arraybuffer.size).toBe(result.original.length);
    expect(result.base64.size).toBe(result.original.length);
    expect(result.arraybuffer.bytes).toEqual(result.original);
    expect(result.base64.bytes).toEqual(result.original);
    await expectNoPageErrors(page, issues);
  });

  test('门控：功能关闭与文档权限禁止导出均拒绝', async ({ page, issues }) => {
    test.setTimeout(120_000);
    await openViewer(page, FIXTURES.multi, {
      features: { export: false },
      display: 'disable',
    });
    await expect
      .poll(() => page.evaluate(() => window.__viewer!.getFeatureState('export')))
      .toMatchObject({ enabled: false, reason: 'host' });
    const disabledButton = page.locator('[data-ofd-control="export"]');
    await expect(disabledButton).toBeVisible();
    await expect(disabledButton).toBeDisabled();
    const hostCode = await page.evaluate(async () => {
      try {
        await window.__viewer!.exportOfd();
        return 'no-error';
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    });
    expect(hostCode).toBe('OFD_FEATURE_DISABLED');

    const permissionFixture = createPermissionDeniedFixture();
    await openViewer(page, permissionFixture);
    await expect
      .poll(() => page.evaluate(() => window.__viewer!.getFeatureState('export')))
      .toMatchObject({ enabled: false, reason: 'document' });
    const documentCode = await page.evaluate(async () => {
      try {
        await window.__viewer!.exportOfd();
        return 'no-error';
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    });
    expect(documentCode).toBe('OFD_FEATURE_DISABLED');
    await expectNoPageErrors(page, issues);
  });
});