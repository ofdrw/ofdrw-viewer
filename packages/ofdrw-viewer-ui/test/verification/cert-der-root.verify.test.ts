/**
 * V-CERT 独立验证（UI）：四种根证书来源（data/url/path/filePath）都先读取原始
 * 字节，再经真实的 crypto `certificatesToDer` 转成逐张 DER，最后只把 DER 交给
 * `verifyOfd`。
 *
 * 说明：jsdom 与 Node 内置/外部依赖存在 `Uint8Array` realm 差异，真实
 * `verifyOfd` 的 XML 读取在 jsdom 下会误报“XML 输入必须是 Uint8Array”，这是
 * 测试环境 artifact。因此本文件只替换 `inspect`/`verifyOfd` 两个加密入口，
 * `certificatesToDer`、`loadCertificates`、`toCertificateSummary` 等证书转换
 * 链路使用真实实现；真实验签/解密结果由 crypto 的 V-CERT 回归用例覆盖。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { ...actual.OFDDocument, open: engineMocks.open },
  };
});

const cryptoMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  verifyOfd: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-crypto')>();
  return {
    ...actual,
    inspect: cryptoMocks.inspect,
    verifyOfd: cryptoMocks.verifyOfd,
  };
});

import {
  certificatesToDer,
  concatBytes,
  parseCertificate,
  toCertificateSummary,
  toHex,
  type CertificateDer,
  type CertificateSummary,
  type OfdInspection,
  type VerificationReport,
  type VerificationStatus,
} from '@ofdrw/ofdrw-viewer-crypto';
import { OFDViewer } from '../../src/index';
import type { CertificateSource, CryptoViewerOptions } from '../../src/options';
import { installDomEnvironment } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';

/** 当前测试目录（jsdom 的 URL 不支持 file: 方案，改用字符串路径解析）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** crypto 夹具目录。 */
const FIXTURES = join(HERE, '../../../ofdrw-viewer-crypto/test/fixtures/crypto');
/** 根证书 PEM/DER。 */
const ROOT_PEM_PATH = join(FIXTURES, 'certs/root-ca.crt.pem');
const ROOT_DER_PATH = join(FIXTURES, 'certs/root-ca.crt.der');
const ROOT_PEM = readFileSync(ROOT_PEM_PATH, 'utf8');
/**
 * jsdom 测试里 Node Buffer/TextEncoder 与 crypto 模块可能属于不同 realm，
 * 二进制证书输入统一由 crypto 自身的转换函数创建，保证 `instanceof Uint8Array`。
 */
const ROOT_DER = certificatesToDer(ROOT_PEM)[0]!;
const ROOT_PEM_BYTES = concatBytes(Buffer.from(ROOT_PEM, 'utf8'));
/** 签名证书 PEM 与私钥 PEM（多证书/非证书块测试）。 */
const SIGNER_PEM = readFileSync(join(FIXTURES, 'certs/signer.crt.pem'), 'utf8');
const SIGNER_KEY_PEM = readFileSync(join(FIXTURES, 'certs/signer.key.pem'), 'utf8');
const SIGNER_KEY_BYTES = concatBytes(Buffer.from(SIGNER_KEY_PEM, 'utf8'));
/** 签名夹具字节。 */
const SIGNED_OFD = readFileSync(join(FIXTURES, 'signed-sesv4.ofd'));

/** 根证书摘要期望值（由 DER 独立解析）。 */
const ROOT_FINGERPRINT = parseCertificate(ROOT_DER).fingerprintSha256;
/** 签名证书摘要。 */
const SIGNER_SUMMARY = toCertificateSummary(
  parseCertificate(certificatesToDer(SIGNER_PEM)[0]!),
);
/** 根证书摘要。 */
const ROOT_SUMMARY = toCertificateSummary(parseCertificate(ROOT_DER));

/**
 * 把字节复制为精确的 ArrayBuffer；Buffer 复用池时避免越界。
 *
 * @param bytes 字节。
 * @returns 独立 ArrayBuffer。
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

/** 只声明本测试读取的 CryptoService 内部观测面。 */
interface CryptoServiceProbe {
  getRootItems(): readonly {
    readonly ders: readonly CertificateDer[];
    readonly summaries: readonly CertificateSummary[];
    readonly input: CertificateSource;
  }[];
}

/**
 * 读取 UI 内部保存的根证书条目，用于证明“进入 crypto 的是 DER 而不是 PEM”。
 *
 * @param viewer 阅读器实例。
 * @returns 根证书条目。
 */
function rootItemsOf(viewer: OFDViewer): ReturnType<CryptoServiceProbe['getRootItems']> {
  const probe = (
    viewer as unknown as {
      readonly cryptoService: CryptoServiceProbe;
    }
  ).cryptoService;
  return probe.getRootItems();
}

/**
 * 构造明文签名包的检测结果。
 *
 * @returns inspect 替身结果。
 */
function signedInspection(): OfdInspection {
  return {
    encrypted: false,
    packageSize: SIGNED_OFD.length,
    ofdVersion: '1.0',
    users: [],
    layers: [],
    signatures: [
      { id: 's001', type: 'Seal', version: 'v4', baseLoc: 'Doc_0/Signs/Signature.xml' },
    ],
    integrityPresent: false,
    warnings: [],
  } as unknown as OfdInspection;
}

/**
 * 构造验证报告；根配置时 valid，否则 unknown。
 *
 * @param roots 收到的根证书 DER。
 * @returns 验证报告。
 */
function reportFor(roots: readonly CertificateDer[]): VerificationReport {
  const overall: VerificationStatus = roots.length > 0 ? 'valid' : 'unknown';
  return {
    overall,
    package: {
      ofdVersion: '1.0',
      encrypted: false,
      decrypted: false,
      packageSize: SIGNED_OFD.length,
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
        baseLoc: 'Doc_0/Signs/Signature.xml',
        status: overall,
        signature: { status: overall },
        dataHash: { status: overall },
        references: { status: overall, total: 1, checked: 1, failures: [] },
        certificate: {
          status: overall,
          trustRootConfigured: roots.length > 0,
          signer: SIGNER_SUMMARY,
          ...(roots.length === 0
            ? {}
            : { trustAnchor: toCertificateSummary(parseCertificate(roots[0]!)) }),
          chain: roots.length === 0 ? [SIGNER_SUMMARY] : [SIGNER_SUMMARY, ROOT_SUMMARY],
          currentTime: '2026-01-01T00:00:00.000Z',
          revocation: 'not-checked',
          issues: [],
        },
        seal: {
          status: overall,
          version: 'v4',
          matchesSignedValue: true,
          math: { status: overall },
          certificate: {
            status: overall,
            trustRootConfigured: roots.length > 0,
            chain: [],
            currentTime: '2026-01-01T00:00:00.000Z',
            revocation: 'not-checked',
            issues: [],
          },
          timestamp: {
            status: 'parsed-not-verified',
            tokenPresent: false,
            tokenLength: 0,
            note: '已解析，未验证',
          },
          issues: [],
        },
        timestamp: {
          status: 'parsed-not-verified',
          tokenPresent: true,
          tokenLength: 64,
          genTime: '2026-01-01T00:00:00.000Z',
          note: '已解析，未验证',
        },
        issues: [],
      },
    ],
    rootsConfigured: roots.length > 0,
    warnings: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
  } as unknown as VerificationReport;
}

/**
 * 创建阅读器；engine 打开替换为内存文档，crypto 只替换 inspect/verifyOfd。
 *
 * @param options crypto 选项。
 * @returns 已 ready 的阅读器。
 */
async function createViewer(options: CryptoViewerOptions = {}): Promise<OFDViewer> {
  engineMocks.open.mockResolvedValue(createMockDocument({ pageCount: 1 }));
  const viewer = new OFDViewer({
    container: document.body,
    source: bufferOf(SIGNED_OFD),
    crypto: { autoVerify: false, ...options },
  });
  await viewer.ready;
  return viewer;
}

/**
 * 断言 UI 根证书摘要与 DER 解析一致。
 *
 * @param summaries UI 返回的摘要。
 */
function expectRootSummary(summaries: readonly CertificateSummary[]): void {
  expect(summaries).toHaveLength(1);
  expect(summaries[0]?.fingerprintSha256).toBe(ROOT_FINGERPRINT);
  expect(summaries[0]?.subject).toContain('Root CA');
}

/**
 * 断言内部条目保存的是逐张证书 DER。
 *
 * @param viewer 阅读器。
 * @param expected 期望 DER 列表。
 */
function expectDers(viewer: OFDViewer, expected: readonly Uint8Array[]): void {
  const items = rootItemsOf(viewer);
  expect(items).toHaveLength(1);
  expect(items[0]!.ders).toHaveLength(expected.length);
  for (const [index, der] of items[0]!.ders.entries()) {
    expect(der).toBeInstanceOf(Uint8Array);
    expect(toHex(der), `ders[${index}]`).toBe(toHex(expected[index]!));
  }
}

/**
 * 断言 verifyOfd 收到的 roots 是逐张 DER（不是 PEM/路径），并与预期一致。
 *
 * @param expected 期望 DER 列表。
 */
function expectVerifyRoots(expected: readonly Uint8Array[]): void {
  const options = cryptoMocks.verifyOfd.mock.calls.at(-1)?.[0] as {
    roots?: readonly CertificateDer[];
  };
  expect(options.roots).toBeDefined();
  expect(options.roots).toHaveLength(expected.length);
  for (const [index, root] of options.roots!.entries()) {
    expect(root).toBeInstanceOf(Uint8Array);
    expect(toHex(root), `roots[${index}]`).toBe(toHex(expected[index]!));
  }
}

/**
 * 断言验证报告使用 DER 根得到 valid，且链锚等于根证书。
 *
 * @param report UI 验证报告。
 */
function expectTrustedReport(report: VerificationReport | undefined): void {
  expect(report).toBeDefined();
  expect(report!.overall).toBe('valid');
  expect(report!.rootsConfigured).toBe(true);
  expect(report!.signatures[0]?.certificate.status).toBe('valid');
  expect(report!.signatures[0]?.certificate.trustAnchor?.fingerprintSha256).toBe(ROOT_FINGERPRINT);
}

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
  engineMocks.open.mockReset();
  cryptoMocks.inspect.mockReset();
  cryptoMocks.verifyOfd.mockReset();
  cryptoMocks.inspect.mockResolvedValue(signedInspection());
  cryptoMocks.verifyOfd.mockImplementation(
    async (options: { roots?: readonly CertificateDer[] }) => reportFor(options.roots ?? []),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('UI 四种根证书来源都经 certificatesToDer 转 DER', () => {
  it('data：Uint8Array PEM → 真实 DER 转换 → verifyOfd 收到 DER 且 valid', async () => {
    const viewer = await createViewer();
    const summaries = await viewer.setRootCertificates([{ data: ROOT_PEM_BYTES }]);
    expectRootSummary(summaries);
    expectDers(viewer, certificatesToDer(ROOT_PEM));
    expectTrustedReport(await viewer.verify());
    expectVerifyRoots(certificatesToDer(ROOT_PEM));
  });

  it('data：多证书 PEM bundle 逐张转换并按输入顺序交给 verify', async () => {
    const viewer = await createViewer();
    const bundle = `${ROOT_PEM}\n${SIGNER_PEM}`;
    const summaries = await viewer.setRootCertificates([{ data: concatBytes(Buffer.from(bundle, 'utf8')) }]);
    expect(summaries.map((item) => item.serialNumber)).toEqual(['3e8', '3e9']);
    expectDers(viewer, certificatesToDer(bundle));
    const report = await viewer.verify();
    expect(report.overall).toBe('valid');
    expectVerifyRoots(certificatesToDer(bundle));
  });

  it('url：fetch 得到的 PEM 文本经转换后生效，且请求头参数保留', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bufferOf(ROOT_PEM_BYTES),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await createViewer();
    const summaries = await viewer.setRootCertificates([
      { url: 'https://example.test/root.pem', headers: { authorization: 'test-token' } },
    ]);
    expectRootSummary(summaries);
    expectDers(viewer, certificatesToDer(ROOT_PEM));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/root.pem',
      expect.objectContaining({ headers: { authorization: 'test-token' } }),
    );
    expectTrustedReport(await viewer.verify());
    expectVerifyRoots(certificatesToDer(ROOT_PEM));
  });

  it('path：宿主 certificateLoader 返回 PEM 原始字节，UI 负责转 DER', async () => {
    const loader = vi.fn((source: CertificateSource) => {
      expect('path' in source).toBe(true);
      return ROOT_PEM_BYTES;
    });
    const viewer = await createViewer({ certificateLoader: loader });
    const root: CertificateSource = { path: ROOT_PEM_PATH, name: 'root.pem' };
    const summaries = await viewer.setRootCertificates([root]);
    expectRootSummary(summaries);
    expect(loader).toHaveBeenCalledWith(root);
    expectDers(viewer, certificatesToDer(ROOT_PEM));
    expectTrustedReport(await viewer.verify());
    expectVerifyRoots(certificatesToDer(ROOT_PEM));
  });

  it('filePath：加载器返回 DER 或 PEM 都能转换，最终只有 DER 进入 verify', async () => {
    const loader = vi.fn((source: CertificateSource) => {
      expect('filePath' in source).toBe(true);
      return ROOT_DER;
    });
    const viewer = await createViewer({ certificateLoader: loader });
    const summaries = await viewer.setRootCertificates([{ filePath: ROOT_DER_PATH }]);
    expectRootSummary(summaries);
    expectDers(viewer, [ROOT_DER]);
    expectTrustedReport(await viewer.verify());
    expectVerifyRoots([ROOT_DER]);

    const pemLoader = vi.fn(() => ROOT_PEM_BYTES);
    const pemViewer = await createViewer({ certificateLoader: pemLoader });
    const pemSummaries = await pemViewer.setRootCertificates([
      { filePath: '/virtual/root.pem' },
    ]);
    expectRootSummary(pemSummaries);
    expectDers(pemViewer, certificatesToDer(ROOT_PEM));
    expectTrustedReport(await pemViewer.verify());
    expectVerifyRoots(certificatesToDer(ROOT_PEM));
  });

  it('constructor rootCertificates 的 data 在自动验证前完成 DER 转换', async () => {
    engineMocks.open.mockResolvedValue(createMockDocument({ pageCount: 1 }));
    const viewer = new OFDViewer({
      container: document.body,
      source: bufferOf(SIGNED_OFD),
      crypto: { rootCertificates: [{ data: ROOT_PEM_BYTES }] },
    });
    const verified = new Promise<VerificationReport>((resolve) => {
      viewer.on('verificationcompleted', resolve);
    });
    await viewer.ready;
    const report = await verified;
    expectTrustedReport(report);
    expectRootSummary(viewer.getRootCertificates());
    expectDers(viewer, certificatesToDer(ROOT_PEM));
    expectVerifyRoots(certificatesToDer(ROOT_PEM));
  });
});

describe('UI 根证书错误语义不回归', () => {
  it('非法 PEM/data 只产生 W_CRYPTO_CERT_SOURCE_UNSUPPORTED，验证保持 unknown', async () => {
    const viewer = await createViewer();
    const summaries = await viewer.setRootCertificates([
      { data: concatBytes(Buffer.from('-----BEGIN CERTIFICATE-----\n****\n-----END CERTIFICATE-----', 'utf8')) },
    ]);
    expect(summaries).toEqual([]);
    expect(viewer.getState().ui.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    );
    const report = await viewer.verify();
    expect(report.overall).toBe('unknown');
    expect(report.rootsConfigured).toBe(false);
    expectVerifyRoots([]);
  });

  it('URL 非 2xx 只 warning，不阻塞后续合法根', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        arrayBuffer: async () => new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => bufferOf(ROOT_PEM_BYTES),
      });
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await createViewer();
    const summaries = await viewer.setRootCertificates([
      { url: 'https://example.test/missing.pem' },
      { url: 'https://example.test/root.pem' },
    ]);
    expectRootSummary(summaries);
    expect(viewer.getState().ui.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    );
    expectTrustedReport(await viewer.verify());
  });

  it('path/filePath 加载器抛错映射 OFD_CRYPTO_FAILED 且保留 cause', async () => {
    const cause = new Error('io failed');
    const viewer = await createViewer({
      certificateLoader: () => {
        throw cause;
      },
    });
    await expect(viewer.setRootCertificates([{ path: '/bad.pem' }])).rejects.toMatchObject({
      code: 'OFD_CRYPTO_FAILED',
      cause,
    });
  });

  it('缺少 certificateLoader 时 path 来源只 warning，验证 unknown', async () => {
    const viewer = await createViewer();
    const summaries = await viewer.setRootCertificates([{ path: '/root.pem' }]);
    expect(summaries).toEqual([]);
    expect(viewer.getState().ui.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    );
    expect((await viewer.verify()).overall).toBe('unknown');
  });

  it('私钥 PEM 不能作为根证书，只 warning', async () => {
    const viewer = await createViewer();
    const summaries = await viewer.setRootCertificates([{ data: SIGNER_KEY_BYTES }]);
    expect(summaries).toEqual([]);
    expect(viewer.getState().ui.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
    );
  });
});