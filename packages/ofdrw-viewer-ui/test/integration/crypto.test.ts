/**
 * 密码能力 UI 集成测试：加密打开、凭据弹窗、验证面板、印章浮层与信任根。
 *
 * crypto 公共 API 用可编程替身隔离 UI 行为；真实算法、夹具与信封解析由
 * crypto 包测试和浏览器 E2E 覆盖。这里重点验证 UI 不绕过 crypto 边界、
 * 不把 URL/路径直接交给 crypto，以及解密容器的生命周期。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  open: vi.fn(),
  verify: vi.fn(),
  certificatesToDer: vi.fn(),
  loadCertificates: vi.fn(),
  toCertificateSummary: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-crypto')>();
  return {
    ...actual,
    inspect: cryptoMocks.inspect,
    openDecryptingContainer: cryptoMocks.open,
    verifyOfd: cryptoMocks.verify,
    certificatesToDer: cryptoMocks.certificatesToDer,
    loadCertificates: cryptoMocks.loadCertificates,
    toCertificateSummary: cryptoMocks.toCertificateSummary,
  };
});

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { ...actual.OFDDocument, open: engineMocks.open },
  };
});

import { CryptoError } from '@ofdrw/ofdrw-viewer-crypto';
import type {
  CertificateSummary,
  OfdInspection,
  VerificationReport,
  VerificationStatus,
} from '@ofdrw/ofdrw-viewer-crypto';
import { OFDViewer } from '../../src/index';
import { OFDViewerError } from '../../src/errors';
import { captureDownloads, installDomEnvironment } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';
import { createSignatureEntry } from '../helpers/signature';

const USER = 'fixture-password-user';
const PASSWORD = 'FixturePass123';

/** 假证书摘要。 */
const ROOT_SUMMARY: CertificateSummary = {
  subject: 'C=CN,O=ofdrw,CN=Test Root',
  issuer: 'C=CN,O=ofdrw,CN=Test Root',
  serialNumber: '01',
  notBefore: '2020-01-01T00:00:00Z',
  notAfter: '2040-01-01T00:00:00Z',
  fingerprintSha256: 'a'.repeat(64),
  isCA: true,
};

/** 标准加密包检测结果。 */
function encryptedInspection(): OfdInspection {
  return {
    encrypted: true,
    packageSize: 128,
    ofdVersion: '1.0',
    users: [{ userName: USER, method: 'password' }],
    layers: [],
    signatures: [],
    integrityPresent: false,
    warnings: [],
  } as unknown as OfdInspection;
}

/** 明文签名包检测结果。 */
function signedInspection(): OfdInspection {
  return {
    encrypted: false,
    packageSize: 128,
    ofdVersion: '1.0',
    users: [],
    layers: [],
    signatures: [
      {
        id: 's001',
        type: 'Seal',
        version: 'v4',
        baseLoc: 'Doc_0/Signs/Signatures.xml',
      },
    ],
    integrityPresent: false,
    warnings: [],
  } as unknown as OfdInspection;
}

/** 构造验证报告；时间戳固定“已解析，未验证”。 */
function report(overall: VerificationStatus): VerificationReport {
  const valid = overall === 'valid';
  return {
    overall,
    package: {
      ofdVersion: '1.0',
      encrypted: true,
      decrypted: true,
      packageSize: 128,
      entryCount: 9,
      signatureCount: 1,
      integrityPresent: false,
    },
    integrity: null,
    signatures: [
      {
        id: 's001',
        type: 'Seal',
        version: 'v4',
        baseLoc: 'Doc_0/Signs/Signatures.xml',
        status: overall,
        signature: { status: overall },
        dataHash: { status: overall },
        references: { status: overall, total: 1, checked: 1, failures: [] },
        certificate: {
          status: valid ? 'valid' : 'unknown',
          trustRootConfigured: valid,
          chain: [],
          currentTime: '2026-01-01T00:00:00Z',
          revocation: 'not-checked',
          issues: [],
        },
        seal: { status: overall, esId: 'seal-1', name: '测试印章' },
        timestamp: {
          status: 'parsed-not-verified',
          tokenPresent: true,
          tokenLength: 64,
          genTime: '2026-01-01T00:00:00Z',
          note: '已解析，未验证',
        },
        issues: [],
      },
    ],
    rootsConfigured: valid,
    warnings: [],
    startedAt: '2026-01-01T00:00:00Z',
    durationMs: 12,
  } as unknown as VerificationReport;
}

/** 手动控制完成时机的 promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 构造明文容器替身。 */
function makeContainer(close: () => Promise<void>) {
  return {
    encrypted: false,
    list: async () => ['OFD.xml'],
    has: async () => true,
    stat: async () => ({ size: 8, isDirectory: false }),
    read: async () => new TextEncoder().encode('<?xml version="1.0"?><ofd:OFD/>'),
    close,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
  engineMocks.open.mockReset();
  engineMocks.open.mockResolvedValue(createMockDocument({ pageCount: 1 }));
  cryptoMocks.inspect.mockReset();
  cryptoMocks.open.mockReset();
  cryptoMocks.verify.mockReset();
  cryptoMocks.certificatesToDer.mockReset();
  cryptoMocks.loadCertificates.mockReset();
  cryptoMocks.toCertificateSummary.mockReset();
  cryptoMocks.certificatesToDer.mockImplementation(() => [new Uint8Array([1, 2, 3])]);
  cryptoMocks.loadCertificates.mockResolvedValue([{ fake: true }]);
  cryptoMocks.toCertificateSummary.mockReturnValue(ROOT_SUMMARY);
  cryptoMocks.verify.mockImplementation(
    async (options: { roots?: readonly unknown[] }) =>
      report(options.roots && options.roots.length > 0 ? 'valid' : 'unknown'),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('加密文档打开', () => {
  it('预置口令解密，engine 收到明文容器并在关闭后释放', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    const close = vi.fn(async () => undefined);
    const container = makeContainer(close);
    cryptoMocks.open.mockResolvedValue({
      container,
      inspection: encryptedInspection(),
      plaintext: true,
      layers: [],
      warnings: [],
    });
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        credentials: { kind: 'password', userName: USER, password: PASSWORD },
      },
    });
    await viewer.ready;
    expect(viewer.getState().document.status).toBe('ready');
    expect(cryptoMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { kind: 'password', userName: USER, password: PASSWORD },
      }),
    );
    const options = engineMocks.open.mock.calls[0]?.[0] as { container?: unknown };
    expect(options.container).toBe(container);

    await viewer.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('autoPrompt=false 且无预置凭据时拒绝并给出凭据错误码', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoPrompt: false },
    });
    await expect(viewer.ready).rejects.toMatchObject({
      code: 'OFD_CRYPTO_CREDENTIAL_REQUIRED',
    });
    expect(engineMocks.open).not.toHaveBeenCalled();
    expect(cryptoMocks.open).not.toHaveBeenCalled();
  });

  it('内置弹窗先显示错误再允许重试，成功后打开文档', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    cryptoMocks.open.mockRejectedValueOnce(
      new CryptoError('CRYPTO_WRONG_PASSWORD', 'wrong password'),
    );
    const container = makeContainer(async () => undefined);
    cryptoMocks.open.mockResolvedValueOnce({
      container,
      inspection: encryptedInspection(),
      plaintext: true,
      layers: [],
      warnings: [],
    });
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
    });
    const password = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-ofd-control="crypto-credential-password"]',
      );
      expect(input).not.toBeNull();
      return input!;
    });
    const submit = document.querySelector<HTMLButtonElement>(
      '.ofd-dialog__action--primary',
    )!;
    password.value = 'wrong-password';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();

    await vi.waitFor(() => {
      const error = document.querySelector<HTMLElement>(
        '[data-ofd-control="crypto-credential-error"]',
      );
      expect(error?.hidden).toBe(false);
      expect(error?.textContent).toContain('口令错误');
    });

    password.value = PASSWORD;
    password.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    await viewer.ready;
    expect(viewer.getState().document.status).toBe('ready');
    expect(
      document.querySelector('[data-ofd-control="crypto-credential-password"]'),
    ).toBeNull();
  });

  it('首次打开取消时以 OFD_CRYPTO_CANCELLED 拒绝且不打开文档', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
    });
    const cancel = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.ofd-dialog__action')]
        .find((item) => item.textContent === '取消');
      expect(button).toBeDefined();
      return button!;
    });
    cancel.click();
    await expect(viewer.ready).rejects.toMatchObject({ code: 'OFD_CRYPTO_CANCELLED' });
    expect(viewer.getState().document.status).toBe('closed');
    expect(engineMocks.open).not.toHaveBeenCalled();
  });

  it('crypto.enabled=false 时加密包映射为 OFD_CRYPTO_UNSUPPORTED', async () => {
    engineMocks.open.mockRejectedValueOnce(
      Object.assign(new Error('encrypted'), { code: 'OFD_ENCRYPTED' }),
    );
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { enabled: false },
    });
    await expect(viewer.ready).rejects.toMatchObject({ code: 'OFD_CRYPTO_UNSUPPORTED' });
    expect(cryptoMocks.inspect).not.toHaveBeenCalled();
    expect(viewer.isFeatureEnabled('verification')).toBe(false);
  });

  it('多用户弹窗选择用户名后只用该用户解密', async () => {
    cryptoMocks.inspect.mockResolvedValue({
      ...encryptedInspection(),
      users: [
        { userName: 'alice', method: 'password' },
        { userName: 'bob', method: 'password' },
      ],
    } as unknown as OfdInspection);
    cryptoMocks.open.mockResolvedValue({
      container: makeContainer(async () => undefined),
      inspection: encryptedInspection(),
      plaintext: true,
      layers: [],
      warnings: [],
    });
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
    });
    const select = await vi.waitFor(() => {
      const element = document.querySelector<HTMLSelectElement>(
        '[data-ofd-control="crypto-credential-user"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    expect([...select.options].map((option) => option.value)).toEqual(['', 'alice', 'bob']);
    select.value = 'bob';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const password = document.querySelector<HTMLInputElement>(
      '[data-ofd-control="crypto-credential-password"]',
    )!;
    password.value = PASSWORD;
    password.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('.ofd-dialog__action--primary')!.click();
    await viewer.ready;
    expect(cryptoMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { kind: 'password', userName: 'bob', password: PASSWORD },
      }),
    );
  });

  it('onCredentialRequired 返回 null 时按取消处理', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    const handler = vi.fn(async () => null);
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { onCredentialRequired: handler },
    });
    await expect(viewer.ready).rejects.toMatchObject({ code: 'OFD_CRYPTO_CANCELLED' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(cryptoMocks.open).not.toHaveBeenCalled();
  });

  it('已有文档时取消切换保留原文档与 ready 状态', async () => {
    cryptoMocks.inspect
      .mockResolvedValueOnce({
        ...signedInspection(),
        signatures: [],
      } as unknown as OfdInspection)
      .mockResolvedValueOnce(encryptedInspection());
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await viewer.ready;
    const pending = viewer.open(new ArrayBuffer(16));
    const cancel = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.ofd-dialog__action')]
        .find((item) => item.textContent === '取消');
      expect(button).toBeDefined();
      return button!;
    });
    cancel.click();
    await expect(pending).rejects.toMatchObject({ code: 'OFD_CRYPTO_CANCELLED' });
    expect(viewer.getState().document.status).toBe('ready');
    expect(viewer.getState().document.pageCount).toBe(1);
  });
});

describe('验证面板与信任根', () => {
  it('自动验证未知→配置根证书后有效，且只把证书字节交给 crypto', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        certificateLoader: () => new Uint8Array([1, 2, 3]),
      },
    });
    const first = await new Promise<VerificationReport>((resolveReport) => {
      viewer.on('verificationcompleted', resolveReport);
    });
    expect(first.overall).toBe('unknown');

    const summaries = await viewer.setRootCertificates([
      { filePath: '/virtual/root-ca.pem' },
    ]);
    expect(summaries).toEqual([ROOT_SUMMARY]);
    expect(viewer.getVerificationReport()?.overall).toBe('valid');

    const converted = cryptoMocks.certificatesToDer.mock.calls[0]?.[0];
    expect(converted).toBeInstanceOf(Uint8Array);
    const loadInput = cryptoMocks.loadCertificates.mock.calls[0]?.[0] as unknown[];
    expect(loadInput).toEqual([new Uint8Array([1, 2, 3])]);
    const verifyInput = cryptoMocks.verify.mock.calls.at(-1)?.[0] as {
      roots?: readonly unknown[];
    };
    expect(verifyInput.roots?.[0]).toBeInstanceOf(Uint8Array);

    viewer.openVerificationPanel();
    const panel = document.querySelector<HTMLElement>('.ofd-verification-panel')!;
    expect(panel.textContent).toContain('有效');
    expect(panel.textContent).toContain('已解析，未验证');
    expect(panel.textContent).toContain(ROOT_SUMMARY.fingerprintSha256);
  });

  it('根证书加载失败只产生 warning，验证保持未知', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    cryptoMocks.loadCertificates.mockRejectedValue(new Error('bad pem'));
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { rootCertificates: [{ path: '/missing.pem' }] },
    });
    const summaries = await viewer.setRootCertificates([{ path: '/missing.pem' }]);
    expect(summaries).toEqual([]);
    expect(viewer.getVerificationReport()).toBeUndefined();
    expect(
      viewer.getState().ui.warnings.map((warning) => warning.code),
    ).toContain('W_CRYPTO_CERT_SOURCE_UNSUPPORTED');
  });

  it('印章点击先验证再打开浮层，可跳转完整面板', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    engineMocks.open.mockResolvedValue(
      createMockDocument({
        pageCount: 1,
        signatures: [
          createSignatureEntry({
            id: 's001',
            stamps: [
              {
                id: 'stamp-1',
                pageId: 'page-1',
                pageIndex: 0,
                boundary: { x: 10, y: 12, w: 40, h: 30 },
              },
            ],
          }),
        ],
      }),
    );
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        autoVerify: false,
        rootCertificates: [{ data: new Uint8Array([1, 2, 3]) }],
      },
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.signatureLayer.querySelectorAll('.ofd-signature-box').length,
      ).toBe(1);
    });
    const overlay = viewer
      .getPageView(1)!
      .signatureLayer.querySelector<HTMLButtonElement>('.ofd-signature-box')!;
    overlay.click();
    const popover = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('.ofd-signature-popover');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(popover.textContent).toContain('有效');
    expect(popover.textContent).toContain('已解析，未验证');
    expect(cryptoMocks.verify).toHaveBeenLastCalledWith(
      expect.objectContaining({ signatureIds: ['s001'] }),
    );

    popover
      .querySelector<HTMLButtonElement>('[data-ofd-control="signature-popover-details"]')!
      .click();
    await vi.waitFor(() => {
      expect(document.querySelector('.ofd-dialog')).not.toBeNull();
    });
    expect(document.querySelector('.ofd-verification-panel')).toBeNull();
  });
});
describe('t45 修复回归', () => {
  it('迟到的解密结果在取消后关闭容器且打开被拒绝', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    const close = vi.fn(async () => undefined);
    const pending = deferred<{
      container: ReturnType<typeof makeContainer>;
      inspection: OfdInspection;
      plaintext: boolean;
      layers: never[];
      warnings: never[];
    }>();
    cryptoMocks.open.mockReturnValue(pending.promise);
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
    });
    const ready = viewer.ready.catch((error: unknown) => error as { code?: string });
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-ofd-control="crypto-credential-password"]'),
      ).not.toBeNull();
    });
    const password = document.querySelector<HTMLInputElement>(
      '[data-ofd-control="crypto-credential-password"]',
    )!;
    password.value = PASSWORD;
    password.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('.ofd-dialog__action--primary')!.click();
    await vi.waitFor(() => expect(cryptoMocks.open).toHaveBeenCalledTimes(1));
    // 直接中止打开 signal，避免 close() 改变 openToken 后吞掉拒绝。
    (viewer as unknown as { openAbort?: AbortController }).openAbort?.abort();
    pending.resolve({
      container: makeContainer(close),
      inspection: encryptedInspection(),
      plaintext: true,
      layers: [],
      warnings: [],
    });
    await expect(ready).resolves.toMatchObject({ code: 'OFD_CRYPTO_CANCELLED' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(engineMocks.open).not.toHaveBeenCalled();
  });

  it('更换根证书后旧 verify 结果不能回写', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    const first = deferred<VerificationReport>();
    cryptoMocks.verify
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(report('valid'));
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await viewer.ready;
    const stale = viewer.verify().catch((error: unknown) => error as { code?: string });
    await vi.waitFor(() => expect(cryptoMocks.verify).toHaveBeenCalledTimes(1));
    await viewer.setRootCertificates([{ data: new Uint8Array([1, 2, 3]) }]);
    first.resolve(report('invalid'));
    await expect(stale).resolves.toMatchObject({ code: 'OFD_CRYPTO_CANCELLED' });
    expect(viewer.getVerificationReport()?.overall).toBe('valid');
  });

  it.each([
    ['CRYPTO_INVALID_PACKAGE', 'Encryptions.xml 根元素非法'],
    ['CRYPTO_LIMIT_EXCEEDED', '条目解压后超过限制'],
  ])('inspect 结构错误 %s 映射 OFD_CRYPTO_FAILED 且保留 cause', async (code, message) => {
    const cause = new CryptoError(code as never, message);
    cryptoMocks.inspect.mockRejectedValue(cause);
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    const error = await viewer.ready.catch((value: unknown) => value as { code?: string; cause?: unknown });
    expect(error).toMatchObject({ code: 'OFD_CRYPTO_FAILED', cause });
  });

  it('path loader 抛错传播 OFD_CRYPTO_FAILED 并保留 cause', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    const loadError = new Error('io failed');
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        autoVerify: false,
        certificateLoader: () => {
          throw loadError;
        },
      },
    });
    await viewer.ready;
    await expect(viewer.setRootCertificates([{ path: '/bad.pem' }])).rejects.toMatchObject({
      code: 'OFD_CRYPTO_FAILED',
      cause: loadError,
    });
  });

  it('面板 id 唯一、overall aria-live、签名类型可见', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    cryptoMocks.verify.mockResolvedValue(report('valid'));
    const one = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await one.ready;
    await one.verify();
    one.openVerificationPanel();
    await vi.waitFor(() => expect(document.querySelector('.ofd-verification-panel')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>(
      '[data-ofd-control="verification-root-input"]',
    )!;
    const label = document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)!;
    expect(input.id).not.toBe('');
    expect(label).not.toBeNull();
    const live = document.querySelector('[data-ofd-control="verification-live"]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('有效');
    const type = document.querySelector('[data-ofd-control="verification-signature-type"]')!;
    expect(type.textContent).toBe('印章');
    expect(type.closest('.ofd-verification-signature')?.getAttribute('data-signature-type')).toBe(
      'Seal',
    );
    // 焦点放在对话框底部“关闭”按钮（不在面板重绘区域内），验证 live 更新不抢焦点。
    const closeAction = document.querySelector<HTMLButtonElement>('.ofd-dialog__action')!;
    closeAction.focus();
    await one.verify();
    expect(document.activeElement).toBe(closeAction);
    expect(document.querySelector('[data-ofd-control="verification-live"]')?.textContent).toContain(
      '有效',
    );

  });

  it.each([
    [
      'id.key',
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
      'pem',
    ],
    [
      'id.pk8',
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
      'pem',
    ],
    ['id.der', new Uint8Array([0x30, 0x82, 0x01, 0x00]), 'der'],
  ])('私钥 %s 按内容识别为 %s', async (name, content, expected) => {
    const certificateInspection = {
      ...encryptedInspection(),
      users: [{ userName: USER, method: 'certificate' }],
    } as unknown as OfdInspection;
    cryptoMocks.inspect.mockResolvedValue(certificateInspection);
    const close = vi.fn(async () => undefined);
    cryptoMocks.open.mockResolvedValue({
      container: makeContainer(close),
      inspection: certificateInspection,
      plaintext: true,
      layers: [],
      warnings: [],
    });
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-ofd-control="crypto-credential-key"]')).not.toBeNull(),
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-ofd-control="crypto-credential-key"]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File([content], name)],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>('.ofd-dialog__action--primary')!.disabled,
      ).toBe(false),
    );
    document.querySelector<HTMLButtonElement>('.ofd-dialog__action--primary')!.click();
    await vi.waitFor(() => expect(cryptoMocks.open).toHaveBeenCalledTimes(1));
    const options = cryptoMocks.open.mock.calls[0]?.[0] as {
      credentials?: { privateKey?: Record<string, unknown> };
    };
    expect(options.credentials?.privateKey).toHaveProperty(expected);
    await viewer.ready;
    await viewer.close();
  });

  it('根证书变化时关闭依赖旧报告的印章浮层', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await viewer.ready;
    await viewer.verify();
    const popover = document.createElement('div');
    popover.className = 'ofd-signature-popover';
    const close = document.createElement('button');
    close.dataset.ofdControl = 'signature-popover-close';
    close.addEventListener('click', () => popover.remove());
    popover.appendChild(close);
    document.querySelector('.ofd-viewer')!.appendChild(popover);
    await viewer.setRootCertificates([{ data: new Uint8Array([1, 2, 3]) }]);
    expect(document.querySelector('.ofd-signature-popover')).toBeNull();
  });

  it('URL 根证书失败仍只告警，不阻塞后续根证书', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await viewer.ready;
    const summaries = await viewer.setRootCertificates([
      { url: 'https://example.test/root.pem' },
      { data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(summaries).toEqual([ROOT_SUMMARY]);
    expect(viewer.getState().ui.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    );
  });

  it('等待凭据时外部 abort 关闭弹窗并拒绝取消', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    const ready = viewer.ready.catch((error: unknown) => error as { code?: string });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-ofd-control="crypto-credential-password"]')).not.toBeNull(),
    );
    (viewer as unknown as { openAbort?: AbortController }).openAbort?.abort();
    await expect(ready).resolves.toMatchObject({ code: 'OFD_CRYPTO_CANCELLED' });
    expect(document.querySelector('[data-ofd-control="crypto-credential-password"]')).toBeNull();
  });
});

describe('t47 修复回归', () => {
  /** 创建带单个印章覆盖层的阅读器。 */
  async function createSignedViewer(autoVerify = false): Promise<OFDViewer> {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    engineMocks.open.mockResolvedValue(
      createMockDocument({
        pageCount: 1,
        signatures: [
          createSignatureEntry({
            id: 's001',
            stamps: [
              {
                id: 'stamp-1',
                pageId: 'page-1',
                pageIndex: 0,
                boundary: { x: 10, y: 12, w: 40, h: 30 },
              },
            ],
          }),
        ],
      }),
    );
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        autoVerify,
        rootCertificates: [{ data: new Uint8Array([1, 2, 3]) }],
      },
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.signatureLayer.querySelectorAll('.ofd-signature-box').length,
      ).toBe(1);
    });
    return viewer;
  }

  /** 当前覆盖层的可访问名称。 */
  function overlayLabel(viewer: OFDViewer): string {
    return (
      viewer
        .getPageView(1)!
        .signatureLayer.querySelector<HTMLElement>('.ofd-signature-box')
        ?.getAttribute('aria-label') ?? ''
    );
  }

  it('验证失败后缓存详情剥离 verification，打开中的详情重渲染为未验证', async () => {
    const viewer = await createSignedViewer();
    await viewer.verify();
    expect((await viewer.getSignatureDetail('s001')).verification?.status).toBe('valid');
    await viewer.showSignature('s001');
    await vi.waitFor(() =>
      expect(document.querySelector('.ofd-signature-detail')?.textContent).toContain('验证有效'),
    );
    cryptoMocks.verify.mockRejectedValueOnce(new Error('verify failed'));
    await expect(viewer.verify()).rejects.toBeTruthy();
    const detail = await viewer.getSignatureDetail('s001');
    expect(detail.verification).toBeUndefined();
    expect(document.querySelector('.ofd-signature-detail')?.textContent).not.toContain('验证有效');
    expect(overlayLabel(viewer)).toContain('未验证');
    expect(viewer.getVerificationReport()).toBeUndefined();
  });

  it('根证书变更立即剥离详情 verification 与覆盖层状态', async () => {
    const viewer = await createSignedViewer();
    await viewer.verify();
    const detail = await viewer.getSignatureDetail('s001');
    expect(detail.verification).toBeDefined();
    const pending = deferred<VerificationReport>();
    cryptoMocks.verify.mockReturnValueOnce(pending.promise);
    const changing = viewer.setRootCertificates([{ data: new Uint8Array([9, 9]) }]);
    await vi.waitFor(() => expect(cryptoMocks.verify).toHaveBeenCalledTimes(2));
    expect((await viewer.getSignatureDetail('s001')).verification).toBeUndefined();
    expect(overlayLabel(viewer)).toContain('未验证');
    pending.resolve(report('valid'));
    await changing;
    expect((await viewer.getSignatureDetail('s001')).verification?.status).toBe('valid');
  });

  it('关闭 verification 功能后印章点击强制未验证且不读取旧报告', async () => {
    const viewer = await createSignedViewer();
    await viewer.verify();
    expect((await viewer.getSignatureDetail('s001')).verification).toBeDefined();
    viewer.setFeatures({ verification: false });
    const before = cryptoMocks.verify.mock.calls.length;
    await viewer.showSignature('s001');
    const detail = await viewer.getSignatureDetail('s001');
    expect(detail.verification).toBeUndefined();
    expect(document.querySelector('.ofd-signature-detail')?.textContent).toContain('未验证');
    expect(document.querySelector('.ofd-signature-detail')?.textContent).not.toContain('验证有效');
    expect(overlayLabel(viewer)).toContain('未验证');
    expect(cryptoMocks.verify).toHaveBeenCalledTimes(before);
  });

  it('延迟初始根加载不会被并发 setRoots 覆盖', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    cryptoMocks.toCertificateSummary.mockImplementation((certificate: { fake?: string }) => ({
      ...ROOT_SUMMARY,
      subject: certificate.fake ?? 'unknown',
      fingerprintSha256: (certificate.fake ?? 'unknown').padEnd(64, '0').slice(0, 64),
    }));
    const initial = deferred<Array<{ fake: string }>>();
    cryptoMocks.loadCertificates
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce([{ fake: 'new' }]);
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        autoVerify: false,
        rootCertificates: [{ data: new Uint8Array([1]) }],
      },
    });
    await vi.waitFor(() => expect(cryptoMocks.loadCertificates).toHaveBeenCalledTimes(1));
    const replacing = viewer.setRootCertificates([{ data: new Uint8Array([2]) }]);
    await vi.waitFor(() => expect(cryptoMocks.loadCertificates).toHaveBeenCalledTimes(2));
    initial.resolve([{ fake: 'initial' }]);
    await replacing;
    await viewer.ready;
    expect(viewer.getRootCertificates().map((item) => item.subject)).toEqual(['new']);
  });

  it('延迟初始根加载不会被并发 addRoots 覆盖', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    cryptoMocks.toCertificateSummary.mockImplementation((certificate: { fake?: string }) => ({
      ...ROOT_SUMMARY,
      subject: certificate.fake ?? 'unknown',
      fingerprintSha256: (certificate.fake ?? 'unknown').padEnd(64, '0').slice(0, 64),
    }));
    const initial = deferred<Array<{ fake: string }>>();
    cryptoMocks.loadCertificates
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce([{ fake: 'initial' }])
      .mockResolvedValueOnce([{ fake: 'added' }]);
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        autoVerify: false,
        rootCertificates: [{ data: new Uint8Array([1]) }],
      },
    });
    await vi.waitFor(() => expect(cryptoMocks.loadCertificates).toHaveBeenCalledTimes(1));
    const service = (
      viewer as unknown as {
        cryptoService: {
          addRoots: (roots: readonly { data: Uint8Array }[]) => Promise<unknown>;
          ensureRoots: () => Promise<void>;
        };
      }
    ).cryptoService;
    const adding = service.addRoots([{ data: new Uint8Array([3]) }]);
    await Promise.resolve();
    expect(cryptoMocks.loadCertificates).toHaveBeenCalledTimes(1);
    initial.resolve([{ fake: 'initial' }]);
    await vi.waitFor(() => expect(cryptoMocks.loadCertificates).toHaveBeenCalledTimes(3));
    await adding;
    await viewer.ready;
    expect(viewer.getRootCertificates().map((item) => item.subject)).toEqual([
      'initial',
      'added',
    ]);
    // 状态机修复后再次 ensureRoots 不得用初始配置覆盖新增根。
    await service.ensureRoots();
    expect(viewer.getRootCertificates().map((item) => item.subject)).toEqual([
      'initial',
      'added',
    ]);
  });

  it('inspect 非 ZIP 与缺失 OFD.xml 均映射 OFD_CRYPTO_FAILED 并保留 cause', async () => {
    for (const message of ['未找到 ZIP EOCD', '缺少 OFD.xml']) {
      const cause = new CryptoError('CRYPTO_INVALID_PACKAGE', message);
      cryptoMocks.inspect.mockRejectedValueOnce(cause);
      const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
      const error = await viewer.ready.catch((value: unknown) => value as { code?: string; cause?: unknown });
      expect(error).toMatchObject({ code: 'OFD_CRYPTO_FAILED', cause });
    }
  });

  it('文件读取失败显示面板错误且不产生未处理 rejection', async () => {
    const viewer = await createSignedViewer();
    viewer.openVerificationPanel();
    const input = document.querySelector<HTMLInputElement>(
      '[data-ofd-control="verification-root-input"]',
    )!;
    const file = new File(['cert'], 'root.pem');
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: vi.fn(async () => {
        throw new Error('read failed');
      }),
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.ofd-verification-error')?.textContent).toContain('根证书');
    });
  });

  it('addRoots 失败通过面板错误展示（保留 OFD_CRYPTO_FAILED）', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await viewer.ready;
    const service = (
      viewer as unknown as {
        cryptoService: { addRoots: (roots: unknown) => Promise<unknown> };
      }
    ).cryptoService;
    vi.spyOn(service, 'addRoots').mockRejectedValue(
      new OFDViewerError('OFD_CRYPTO_FAILED', '根证书加载失败'),
    );
    viewer.openVerificationPanel();
    const input = document.querySelector<HTMLInputElement>(
      '[data-ofd-control="verification-root-input"]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['cert'], 'root.pem')],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.ofd-verification-error')?.textContent).toContain('根证书加载失败');
    });
    expect(viewer.getRootCertificates()).toEqual([]);
  });

  it('状态徽标含 aria-hidden 图标且保留文字', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    cryptoMocks.verify.mockResolvedValue(report('valid'));
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await viewer.ready;
    await viewer.verify();
    viewer.openVerificationPanel();
    const badge = document.querySelector<HTMLElement>('.ofd-verification-badge')!;
    const icon = badge.querySelector<HTMLElement>('[data-ofd-control="verification-status-icon"]')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.textContent).not.toBe('');
    expect(badge.textContent).toContain('有效');
  });
});


describe('t51 修复回归', () => {
  /** 创建带单个印章覆盖层的阅读器。 */
  async function createSignedViewer(
    autoVerify = false,
    onVerification?: (report: VerificationReport) => void,
  ): Promise<OFDViewer> {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    engineMocks.open.mockResolvedValue(
      createMockDocument({
        pageCount: 1,
        signatures: [
          createSignatureEntry({
            id: 's001',
            stamps: [
              {
                id: 'stamp-1',
                pageId: 'page-1',
                pageIndex: 0,
                boundary: { x: 10, y: 12, w: 40, h: 30 },
              },
            ],
          }),
        ],
      }),
    );
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        autoVerify,
        rootCertificates: [{ data: new Uint8Array([1, 2, 3]) }],
        ...(onVerification ? { onVerification } : {}),
      },
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.signatureLayer.querySelectorAll('.ofd-signature-box').length,
      ).toBe(1);
    });
    return viewer;
  }

  /** 当前覆盖层的可访问名称。 */
  function overlayLabel(viewer: OFDViewer): string {
    return (
      viewer
        .getPageView(1)!
        .signatureLayer.querySelector<HTMLElement>('.ofd-signature-box')
        ?.getAttribute('aria-label') ?? ''
    );
  }

  it('关闭 verification 立即失效报告、关闭浮层并禁用重新验证', async () => {
    const viewer = await createSignedViewer();
    await viewer.verify();
    viewer.openVerificationPanel();
    const panel = document.querySelector<HTMLElement>('.ofd-verification-panel')!;
    expect(panel.textContent).toContain('总体状态：有效');
    const overlay = viewer
      .getPageView(1)!
      .signatureLayer.querySelector<HTMLButtonElement>('.ofd-signature-box')!;
    overlay.click();
    await vi.waitFor(() =>
      expect(document.querySelector('.ofd-signature-popover')).not.toBeNull(),
    );
    expect(cryptoMocks.verify).toHaveBeenCalledTimes(1);

    viewer.setFeatures({ verification: false });

    expect(viewer.getVerificationReport()).toBeUndefined();
    expect(document.querySelector('.ofd-signature-popover')).toBeNull();
    // UI shell 会关闭被禁用功能的对话框；旧报告/按钮不得残留。
    expect(document.querySelector('.ofd-verification-panel')).toBeNull();
    expect(panel.isConnected).toBe(false);
    expect(overlayLabel(viewer)).toContain('未验证');
    expect(() => viewer.openVerificationPanel()).toThrowError('已被关闭');
    await expect(viewer.verify()).rejects.toMatchObject({ code: 'OFD_FEATURE_DISABLED' });
  });

  it('feature 关闭期间在途 verify 完成不得回写报告', async () => {
    const viewer = await createSignedViewer();
    const pending = deferred<VerificationReport>();
    cryptoMocks.verify.mockReturnValueOnce(pending.promise);
    viewer.openVerificationPanel();
    const verification = viewer.verify();
    await vi.waitFor(() => expect(cryptoMocks.verify).toHaveBeenCalledTimes(1));
    const panel = document.querySelector<HTMLElement>('.ofd-verification-panel')!;
    expect(panel.querySelector('.ofd-verification-loading')).not.toBeNull();

    viewer.setFeatures({ verification: false });
    pending.resolve(report('valid'));
    await expect(verification).rejects.toMatchObject({ code: 'OFD_CRYPTO_CANCELLED' });

    expect(viewer.getVerificationReport()).toBeUndefined();
    expect(document.querySelector('.ofd-verification-panel')).toBeNull();
    expect(panel.isConnected).toBe(false);
    expect(overlayLabel(viewer)).toContain('未验证');
  });

  it('verificationcompleted 内关闭 feature：印章点击回退未验证，重新启用后需重新验证', async () => {
    const viewer = await createSignedViewer();
    let closed = false;
    const off = viewer.on('verificationcompleted', () => {
      if (closed) return;
      closed = true;
      viewer.setFeatures({ verification: false });
      off();
    });
    const overlay = viewer
      .getPageView(1)!
      .signatureLayer.querySelector<HTMLButtonElement>('.ofd-signature-box')!;

    overlay.click();
    await vi.waitFor(() =>
      expect(document.querySelector('.ofd-signature-detail')?.textContent).toContain('未验证'),
    );
    expect(document.querySelector('.ofd-signature-popover')).toBeNull();
    expect(
      document.querySelector('.ofd-signature-detail')?.textContent,
    ).not.toContain('验证有效');
    expect(document.body.textContent).not.toContain('验证有效');
    expect(viewer.getVerificationReport()).toBeUndefined();
    expect((await viewer.getSignatureDetail('s001')).verification).toBeUndefined();
    expect(overlayLabel(viewer)).toContain('未验证');

    // 重新启用只恢复能力；旧的本地 report 不得复用，必须重新 verify。
    viewer.setFeatures({ verification: true });
    expect(overlayLabel(viewer)).toContain('未验证');
    const calls = cryptoMocks.verify.mock.calls.length;
    overlay.click();
    const popover = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('.ofd-signature-popover');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(cryptoMocks.verify).toHaveBeenCalledTimes(calls + 1);
    expect(popover.textContent).toContain('有效');
    expect(popover.textContent).toContain('已解析，未验证');
    // 入场动画只在浮层首次挂载时启用；内部字段更新不重新加类/重播。
    expect(popover.classList.contains('ofd-signature-popover--in')).toBe(true);
    popover.querySelector('dd')!.textContent = '重渲染';
    expect(popover.classList.contains('ofd-signature-popover--in')).toBe(true);
  });

  it('onVerification 内关闭 feature：印章点击回退未验证，重新启用后需重新验证', async () => {
    let closed = false;
    const viewer = await createSignedViewer(false, () => {
      if (closed) return;
      closed = true;
      viewer.setFeatures({ verification: false });
    });
    const overlay = viewer
      .getPageView(1)!
      .signatureLayer.querySelector<HTMLButtonElement>('.ofd-signature-box')!;

    overlay.click();
    await vi.waitFor(() =>
      expect(document.querySelector('.ofd-signature-detail')?.textContent).toContain('未验证'),
    );
    expect(document.querySelector('.ofd-signature-popover')).toBeNull();
    expect(
      document.querySelector('.ofd-signature-detail')?.textContent,
    ).not.toContain('验证有效');
    expect(document.body.textContent).not.toContain('验证有效');
    expect(viewer.getVerificationReport()).toBeUndefined();
    expect((await viewer.getSignatureDetail('s001')).verification).toBeUndefined();
    expect(overlayLabel(viewer)).toContain('未验证');

    viewer.setFeatures({ verification: true });
    expect(overlayLabel(viewer)).toContain('未验证');
    const calls = cryptoMocks.verify.mock.calls.length;
    overlay.click();
    const popover = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('.ofd-signature-popover');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(cryptoMocks.verify).toHaveBeenCalledTimes(calls + 1);
    expect(popover.textContent).toContain('有效');
  });

  it('时间戳 parse-error 在面板与浮层显示“不可解析”', async () => {
    const viewer = await createSignedViewer();
    const parsed = report('valid');
    const timestamp = parsed.signatures[0]!.timestamp as unknown as {
      status: string;
      tokenPresent: boolean;
      note: string;
    };
    timestamp.status = 'parse-error';
    timestamp.tokenPresent = false;
    timestamp.note = '不可解析';
    cryptoMocks.verify.mockResolvedValue(parsed);
    await viewer.verify();
    viewer.openVerificationPanel();
    await vi.waitFor(() => {
      const panelTimestamp = document.querySelector<HTMLElement>('.ofd-verification-timestamp');
      expect(panelTimestamp?.textContent).toBe('时间戳：不可解析');
      expect(panelTimestamp?.dataset.status).toBe('parse-error');
    });

    const overlay = viewer
      .getPageView(1)!
      .signatureLayer.querySelector<HTMLButtonElement>('.ofd-signature-box')!;
    overlay.click();
    const popover = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('.ofd-signature-popover');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(popover.textContent).toContain('不可解析');
    expect(popover.textContent).not.toContain('时间戳：无');
  });
});

describe('t5 签章/验证 UI 修复', () => {
  /** 打开一个明文签章文档，返回已就绪的阅读器。 */
  async function plainSignedViewer(): Promise<OFDViewer> {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    engineMocks.open.mockResolvedValue(
      createMockDocument({
        pageCount: 1,
        signatures: [
          createSignatureEntry({
            id: 's001',
            stamps: [
              {
                id: 'stamp-1',
                pageId: 'page-1',
                pageIndex: 0,
                boundary: { x: 10, y: 12, w: 40, h: 30 },
              },
            ],
          }),
        ],
      }),
    );
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { autoVerify: false },
    });
    await viewer.ready;
    return viewer;
  }

  it('明文文档隐藏加解密行；无完整性整块隐藏；时间戳显示 UTC+8 具体时间与 TSA/序列号', async () => {
    const viewer = await plainSignedViewer();
    const parsed = report('unknown');
    const timestamp = parsed.signatures[0]!.timestamp as unknown as {
      genTime: string;
      serialNumber: string;
      tsa: CertificateSummary;
    };
    timestamp.genTime = '2026-10-23T07:59:26.000Z';
    (parsed.signatures[0] as { signingTime?: string }).signingTime = '2026-10-23T07:59:26.000Z';
    timestamp.serialNumber = '01a167c59e2f';
    timestamp.tsa = {
      ...ROOT_SUMMARY,
      subject: 'CN=OFD Test TSA,O=ofdrw,C=CN',
    };
    cryptoMocks.verify.mockResolvedValue(parsed);
    await viewer.verify();
    viewer.openVerificationPanel();
    const panel = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('.ofd-verification-panel');
      expect(element).not.toBeNull();
      return element!;
    });

    // 明文打开：打开阶段 openInfo 覆盖容器报告，不显示恒为否的加解密行。
    expect(panel.textContent).not.toContain('是否加密');
    expect(panel.textContent).not.toContain('是否已解密');
    expect(document.querySelector('.ofd-verification-integrity')).toBeNull();
    expect(panel.textContent).toContain('页数');
    expect(panel.textContent).toContain('签名数');
    expect(panel.textContent).not.toContain('验证时间');
    expect(panel.textContent).not.toContain('耗时');
    const signatureCard = panel.querySelector<HTMLElement>('.ofd-verification-signature')!;
    expect(signatureCard.textContent).toContain('签发时间');
    expect(signatureCard.textContent).toContain('2026-10-23 15:59:26');
    expect(signatureCard.textContent).toContain('证书链（不影响总体状态）');

    const timestampBox = panel.querySelector<HTMLElement>('.ofd-verification-timestamp')!;
    expect(timestampBox.textContent).toContain('已解析，未验证（不参与总体状态）');
    expect(timestampBox.textContent).toContain('生成时间（UTC+8）：2026-10-23 15:59:26');
    expect(timestampBox.textContent).toContain('TSA：CN=OFD Test TSA,O=ofdrw,C=CN');
    expect(timestampBox.textContent).toContain('序列号：01a167c59e2f');
    expect(timestampBox.textContent).not.toContain('genTime');

    const guidance = document.querySelector<HTMLElement>('.ofd-verification-guidance')!;
    expect(guidance.dataset.status).toBe('unknown');
    expect(guidance.textContent).toContain('未配置与签章链匹配的信任根');
    expect(guidance.textContent).toContain('不改变总体状态');
    expect(viewer.getVerificationReport()?.overall).toBe('unknown');
  });

  it('加密且含完整性时仍显示加解密行与完整性卡片', async () => {
    cryptoMocks.inspect.mockResolvedValue(encryptedInspection());
    cryptoMocks.open.mockResolvedValue({
      container: makeContainer(async () => undefined),
      inspection: encryptedInspection(),
      plaintext: true,
      layers: [],
      warnings: [],
    });
    const base = report('valid');
    const integrity: NonNullable<VerificationReport['integrity']> = {
      status: 'valid',
      entriesPath: 'OFDEntries.xml',
      signedValuePath: 'signedvalue.dat',
      fileListCount: 3,
      actualFileCount: 3,
      missingFiles: [],
      extraFiles: [],
      authenticatedAttributes: true,
      signature: { status: 'valid', sm2UserId: '1234567812345678' },
      certificate: base.signatures[0]!.certificate,
      issues: [],
    };
    const parsed: VerificationReport = { ...base, integrity };
    cryptoMocks.verify.mockResolvedValue(parsed);
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        credentials: { kind: 'password', userName: USER, password: PASSWORD },
        autoVerify: false,
      },
    });
    await viewer.ready;
    await viewer.verify();
    viewer.openVerificationPanel();
    const panel = document.querySelector<HTMLElement>('.ofd-verification-panel')!;
    expect(panel.textContent).toContain('是否加密');
    expect(panel.textContent).toContain('是否已解密');
    expect(panel.textContent).toContain('防夹带完整性');
    expect(panel.textContent).toContain('清单文件数');
    expect(document.querySelector('.ofd-verification-integrity')?.textContent).toContain(
      '清单文件数',
    );
  });

  it('验证面板从签章详情渲染真实印章图片，关闭对话框后释放 Blob URL', async () => {
    const viewer = await plainSignedViewer();
    cryptoMocks.verify.mockResolvedValue(report('valid'));
    await viewer.verify();
    vi.spyOn(viewer, 'getSignatureDetail').mockResolvedValue({
      entry: createSignatureEntry({ id: 's001' }),
      seal: {
        version: 'v4',
        name: '图片测试章',
        esId: 'seal-image-1',
        image: {
          format: 'PNG',
          widthMm: 40,
          heightMm: 40,
          data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      },
      validation: { status: 'not-verified', note: '未验证' },
    });
    const capture = captureDownloads();
    try {
      viewer.openVerificationPanel();
      const image = await vi.waitFor(() => {
        const img = document.querySelector<HTMLImageElement>(
          '[data-ofd-control="verification-signature-seal-image"] img',
        );
        expect(img).not.toBeNull();
        return img!;
      });
      expect(image.alt).toBe('印章图片：测试印章');
      expect(image.getAttribute('src')).toMatch(/^blob:/);
      expect(
        document.querySelector('[data-ofd-control="verification-signature-seal-image"] figcaption')
          ?.textContent,
      ).toContain('40 × 40 mm');

      document.querySelector<HTMLButtonElement>('.ofd-dialog__close')!.click();
      await vi.waitFor(() => expect(capture.revoked.length).toBeGreaterThan(0));
    } finally {
      capture.restore();
    }
  });

  it('验证面板根证书可下载为 .der，且不把链失败写进总体状态', async () => {
    cryptoMocks.inspect.mockResolvedValue(signedInspection());
    engineMocks.open.mockResolvedValue(createMockDocument({ pageCount: 1 }));
    cryptoMocks.verify.mockResolvedValue(report('valid'));
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: {
        autoVerify: false,
        rootCertificates: [{ data: new Uint8Array([1, 2, 3]) }],
      },
    });
    await viewer.ready;
    await viewer.verify();
    viewer.openVerificationPanel();
    const button = await vi.waitFor(() => {
      const element = document.querySelector<HTMLButtonElement>(
        '[data-ofd-control="verification-root-download"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    const capture = captureDownloads();
    try {
      button.click();
      await vi.waitFor(() => expect(capture.downloads).toHaveLength(1));
      expect(capture.downloads[0]!.filename).toMatch(/\.der$/);
      expect(capture.downloads[0]!.blob?.type).toBe('application/pkix-cert');
      expect(new Uint8Array(await capture.downloads[0]!.blob!.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    } finally {
      capture.restore();
    }
  });
});
