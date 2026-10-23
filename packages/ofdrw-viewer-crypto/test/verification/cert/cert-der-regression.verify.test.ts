/**
 * V-CERT 独立验证（二）：12 个受保护夹具在 DER 根证书输入下的验签/解密/完整性
 * 回归，以及 arraybuffer 与 byte-source 结果一致性。
 *
 * 覆盖：
 * - 根证书 PEM 经 `certificatesToDer` 转 DER 后与直接传 DER 的报告逐字段一致；
 * - 12 个夹具的 `inspect` / `verifyOfd` 在 arraybuffer 与 byte-source 下一致；
 * - 3 个加密夹具的明文条目与 Java `java-expected.json` 逐文件 SHA-256 一致；
 * - 证书摘要/信任链结果与 `manifest.json`、Java 基准一致；
 * - 夹具 SHA-256 与 `manifest.sha256` 逐条一致（记录当前字节哈希）。
 *
 * 只使用公开 API、已提交夹具与 Java 基准；不修改实现。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  certificatesToDer,
  inspect,
  openDecryptingContainer,
  parseCertificate,
  toCertificateSummary,
  verifyOfd,
  type ByteSource,
  type CryptoCredential,
  type CryptoSource,
  type OfdInspection,
  type VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  fixtureBytes as coreFixtureBytes,
  fixtureText as coreFixtureText,
} from '../core/support';
import {
  JAVA_EXPECTED_PATH,
  certCredential,
  digestEntries,
  fixtureBytes,
} from '../decrypt/support';

/** 夹具清单结构（只声明本测试使用的字段）。 */
interface Manifest {
  readonly cases: readonly {
    readonly id: string;
    readonly path: string;
    readonly type: string;
    readonly size: number;
    readonly sha256: string;
    readonly credentials: { readonly kind: 'password' | 'certificate' } | null;
    readonly expected: Readonly<Record<string, unknown>>;
  }[];
  readonly certs: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly type: string;
  }[];
}

/** Java 解密基准结构。 */
interface JavaExpected {
  readonly cases: Readonly<
    Record<string, Readonly<Record<string, { readonly size: number; readonly sha256: string }>>>
  >;
}

/** 计算字节 SHA-256。 */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 夹具清单。 */
const MANIFEST = JSON.parse(coreFixtureText('manifest.json')) as Manifest;
/** Java 解密基准。 */
const JAVA = JSON.parse(readFileSync(JAVA_EXPECTED_PATH, 'utf8')) as JavaExpected;
/** 根证书 PEM / DER。 */
const ROOT_PEM = coreFixtureText('certs', 'root-ca.crt.pem');
const ROOT_DER = coreFixtureBytes('certs', 'root-ca.crt.der');
/** 根证书 PEM 经入口工具转换后的 DER。 */
const ROOT_DER_FROM_PEM = certificatesToDer(ROOT_PEM);
/** 固定验证时间，避免报告中的 currentTime 因两次调用而不同。 */
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * 读取夹具为 ArrayBuffer 来源。
 *
 * @param name 夹具文件名。
 * @returns crypto 来源。
 */
function arraySource(name: string): CryptoSource {
  return { kind: 'arraybuffer', data: fixtureBytes(name) };
}

/**
 * 内存字节随机访问源；记录读取次数与字节数。
 */
class CountingByteSource implements ByteSource {
  readonly data: Uint8Array;
  readonly size: number;
  reads = 0;
  bytesRead = 0;

  /**
   * @param data 完整包字节。
   */
  constructor(data: Uint8Array) {
    this.data = data;
    this.size = data.length;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads += 1;
    const start = Math.max(0, Math.min(this.size, Math.floor(offset)));
    const end = Math.min(this.size, start + Math.max(0, Math.floor(length)));
    const bytes = this.data.slice(start, end);
    this.bytesRead += bytes.length;
    return bytes;
  }

  async close(): Promise<void> {
    // 调用方持有；crypto 不应关闭，因此这里保持空实现。
  }
}

/**
 * 给夹具构造 byte-source。
 *
 * @param name 夹具文件名。
 * @returns 随机访问来源。
 */
function byteSource(name: string): { kind: 'byte-source'; source: CountingByteSource } {
  return { kind: 'byte-source', source: new CountingByteSource(fixtureBytes(name)) };
}

/**
 * 根据 manifest 构造解密凭据。
 *
 * @param item 夹具 case。
 * @returns 凭据；非加密 case 返回 undefined。
 */
function credentialOf(item: Manifest['cases'][number]): CryptoCredential | undefined {
  if (item.credentials === null) return undefined;
  if (item.credentials.kind === 'password') {
    return { kind: 'password', userName: 'fixture-password-user', password: 'FixturePass123' };
  }
  return certCredential('encrypt', 'fixture-cert-user');
}

/**
 * 去掉时间字段，得到可比较的报告。
 *
 * @param report 验证报告。
 * @returns 去掉 startedAt/durationMs 的报告。
 */
function stableReport(
  report: VerificationReport,
): Omit<VerificationReport, 'startedAt' | 'durationMs'> {
  const { startedAt: _startedAt, durationMs: _durationMs, ...rest } = report;
  return rest;
}

/**
 * 摘要数组：序列号 + SHA-256 指纹 + 链状态。
 *
 * @param report 验证报告。
 * @returns 可比较摘要。
 */
function chainSnapshot(report: VerificationReport): unknown {
  return report.signatures.map((signature) => ({
    id: signature.id,
    status: signature.status,
    certificateStatus: signature.certificate.status,
    signer: signature.certificate.signer?.serialNumber,
    signerFingerprint: signature.certificate.signer?.fingerprintSha256,
    trustAnchor: signature.certificate.trustAnchor?.fingerprintSha256,
    chainFingerprints: signature.certificate.chain.map((item) => item.fingerprintSha256),
    sealCertificateStatus: signature.seal?.certificate.status,
    sealChainFingerprints: signature.seal?.certificate.chain.map(
      (item) => item.fingerprintSha256,
    ),
    timestampStatus: signature.timestamp.status,
  }));
}

/** 12 个夹具；顺序与 manifest 一致。 */
const CASES = MANIFEST.cases;
/** 加密夹具。 */
const ENCRYPTED_CASES = CASES.filter((item) => item.type === 'encrypted');
/** 含签名/完整性的夹具（负例同样配置根以确认失败原因不是 unknown）。 */
const SIGNED_CASES = CASES.filter(
  (item) => item.type !== 'plain' && item.type !== 'encrypted',
);

describe('夹具字节哈希与证书摘要', () => {
  it('12 个 OFD 与全部证书夹具的 SHA-256/大小与 manifest 一致', () => {
    for (const item of CASES) {
      const bytes = fixtureBytes(item.path);
      expect(bytes.length, item.path).toBe(item.size);
      expect(sha256(bytes), item.path).toBe(item.sha256);
    }
    for (const cert of MANIFEST.certs) {
      const bytes = fixtureBytes(cert.path);
      expect(bytes.length, cert.path).toBe(cert.size);
      expect(sha256(bytes), cert.path).toBe(cert.sha256);
    }
  });

  it('5 张证书 DER 的解析指纹与 manifest/OpenSSL 记录一致，且 PEM 转换不改变摘要', () => {
    for (const name of ['root-ca', 'signer', 'seal', 'encrypt', 'tsa'] as const) {
      const der = fixtureBytes('certs', `${name}.crt.der`);
      const parsed = parseCertificate(der);
      const converted = certificatesToDer(fixtureBytes('certs', `${name}.crt.pem`));
      expect(converted).toHaveLength(1);
      expect(converted[0]).toEqual(der);
      expect(parseCertificate(converted[0]!).fingerprintSha256).toBe(parsed.fingerprintSha256);
      const manifestCert = MANIFEST.certs.find((item) => item.path === `certs/${name}.crt.der`);
      expect(manifestCert?.sha256).toBe(sha256(der));
    }
  });

  it('PEM 转换出的根 DER 与提交的 DER 逐字节一致（含多证书 PEM）', () => {
    expect(ROOT_DER_FROM_PEM).toHaveLength(1);
    expect(ROOT_DER_FROM_PEM[0]).toEqual(ROOT_DER);
    const bundle = certificatesToDer(
      `${coreFixtureText('certs', 'root-ca.crt.pem')}\n${coreFixtureText('certs', 'signer.crt.pem')}`,
    );
    expect(bundle.map((item) => parseCertificate(item).serialNumber)).toEqual(['3e8', '3e9']);
    expect(toCertificateSummary(parseCertificate(bundle[0]!)).fingerprintSha256).toBe(
      parseCertificate(ROOT_DER).fingerprintSha256,
    );
  });
});

describe('12 夹具 inspect / verify 在 arraybuffer 与 byte-source 下一致', () => {
  it('inspect 逐字段一致且读取量不超过整包', async () => {
    for (const item of CASES) {
      const byteInspection: OfdInspection = await inspect(byteSource(item.path));
      const arrayInspection = await inspect(arraySource(item.path));
      expect(byteInspection, item.path).toEqual(arrayInspection);
      expect(byteInspection.packageSize, item.path).toBe(item.size);
    }
  });

  it('verifyOfd（配置 PEM 转换出的根）12 夹具逐字段一致', async () => {
    for (const item of CASES) {
      const credentials = credentialOf(item);
      const options = {
        roots: ROOT_DER_FROM_PEM,
        ...(credentials === undefined ? {} : { credentials }),
      };
      const byteReport = await verifyOfd({ source: byteSource(item.path), now: FIXED_NOW, ...options });
      const arrayReport = await verifyOfd({ source: arraySource(item.path), now: FIXED_NOW, ...options });
      expect(stableReport(byteReport), item.path).toEqual(stableReport(arrayReport));
      expect(byteReport.package.packageSize, item.path).toBe(item.size);
      expect(byteReport.rootsConfigured, item.path).toBe(true);
    }
  });

  it('根证书 PEM 转换 DER 与直接 DER 的链结果一致', async () => {
    for (const item of SIGNED_CASES) {
      const credentials = credentialOf(item);
      const fromPem = await verifyOfd({
        source: arraySource(item.path),
        now: FIXED_NOW,
        roots: ROOT_DER_FROM_PEM,
        ...(credentials === undefined ? {} : { credentials }),
      });
      const fromDer = await verifyOfd({
        source: arraySource(item.path),
        now: FIXED_NOW,
        roots: [ROOT_DER],
        ...(credentials === undefined ? {} : { credentials }),
      });
      expect(stableReport(fromPem), item.path).toEqual(stableReport(fromDer));
      expect(chainSnapshot(fromPem), item.path).toEqual(chainSnapshot(fromDer));
      for (const signature of fromPem.signatures) {
        // 合成 invalid 报告可能没有签名者证书；有签名者时指纹必须是 SHA-256。
        if (signature.certificate.signer !== undefined) {
          expect(signature.certificate.signer.fingerprintSha256, item.path).toMatch(
            /^[0-9a-f]{64}$/,
          );
        }
        if (signature.certificate.status === 'valid') {
          expect(signature.certificate.trustAnchor?.fingerprintSha256, item.path).toBe(
            parseCertificate(ROOT_DER).fingerprintSha256,
          );
        }
      }
    }
  });

  it('无根时签名夹具为 unknown，与 byte-source 一致', async () => {
    for (const item of CASES.filter((entry) => entry.type === 'signed')) {
      const byteReport = await verifyOfd({ source: byteSource(item.path), now: FIXED_NOW });
      const arrayReport = await verifyOfd({ source: arraySource(item.path), now: FIXED_NOW });
      expect(stableReport(byteReport), item.path).toEqual(stableReport(arrayReport));
      expect(arrayReport.rootsConfigured, item.path).toBe(false);
      expect(arrayReport.overall, item.path).toBe('unknown');
      expect(arrayReport.signatures[0]?.certificate.status, item.path).toBe('unknown');
    }
  });
});

describe('12 夹具预期状态与 Java/清单契约一致', () => {
  it('每个 case 的 overall/integrity/签名状态符合 manifest 预期', async () => {
    for (const item of CASES) {
      const credentials = credentialOf(item);
      const report = await verifyOfd({
        source: arraySource(item.path),
        now: FIXED_NOW,
        roots: ROOT_DER_FROM_PEM,
        ...(credentials === undefined ? {} : { credentials }),
      });
      const expected = item.expected;
      if (expected['valid'] === true && item.type !== 'plain') {
        expect(report.overall, item.path).toBe('valid');
        expect(report.integrity?.status ?? 'valid', item.path).toBe('valid');
      }
      if (expected['signature'] === 'valid') {
        expect(report.signatures[0]?.status, item.path).toBe('valid');
      }
      if (expected['signature'] === 'invalid') {
        expect(report.overall, item.path).toBe('invalid');
        expect(
          report.signatures.some((signature) => signature.status === 'invalid'),
          item.path,
        ).toBe(true);
      }
      if (expected['integrity'] === 'valid') {
        expect(report.integrity?.status, item.path).toBe('valid');
      }
      if (expected['integrity'] === 'invalid') {
        expect(report.overall, item.path).toBe('invalid');
        expect(report.integrity?.status, item.path).toBe('invalid');
      }
      if (expected['decrypt'] === 'ok') {
        expect(report.package, item.path).toMatchObject({ encrypted: true, decrypted: true });
        // `decryption.plaintext` 表示“原始来源是否为明文”，加密来源应为 false。
        expect(report.decryption?.plaintext, item.path).toBe(false);
      }
      if (item.type === 'plain') {
        expect(report.overall, item.path).toBe('not-applicable');
        expect(report.integrity, item.path).toBeNull();
        expect(report.signatures, item.path).toEqual([]);
      }
    }
  });

  it('签名/完整性夹具的时间戳固定“已解析，未验证”，不参与 overall', async () => {
    for (const item of CASES.filter(
      (entry) => entry.type === 'signed' || entry.type === 'combined',
    )) {
      const credentials = credentialOf(item);
      const report = await verifyOfd({
        source: arraySource(item.path),
        now: FIXED_NOW,
        roots: ROOT_DER_FROM_PEM,
        ...(credentials === undefined ? {} : { credentials }),
      });
      const timestamps = [
        ...report.signatures.map((signature) => signature.timestamp),
        ...report.signatures.flatMap((signature) =>
          signature.seal === undefined ? [] : [signature.seal.timestamp],
        ),
      ].filter((timestamp) => timestamp.tokenPresent);
      for (const timestamp of timestamps) {
        expect(timestamp.status, item.path).toBe('parsed-not-verified');
        expect(timestamp.note, item.path).toBe('已解析，未验证');
      }
    }
  });
});

describe('加密夹具解密与 Java 基准逐文件一致', () => {
  it('口令/证书/组合加密用凭据解密，条目 SHA-256 与 Java 一致', async () => {
    const expectedCases: Record<string, string> = {
      'password-encrypted': 'password-encrypted.ofd',
      'cert-encrypted': 'cert-encrypted.ofd',
      'combined-password-encrypted': 'combined-password-encrypted.ofd',
    };
    for (const item of ENCRYPTED_CASES) {
      const key = expectedCases[item.id];
      expect(key, item.id).toBeTruthy();
      const credentials = credentialOf(item)!;
      const fromArray = await openDecryptingContainer({
        source: arraySource(item.path),
        credentials,
      });
      const fromByte = await openDecryptingContainer({
        source: byteSource(item.path),
        credentials,
      });
      try {
        expect(fromArray.plaintext, item.id).toBe(false);
        expect(fromByte.plaintext, item.id).toBe(false);
        const arrayDigests = await digestEntries(fromArray.container);
        const byteDigests = await digestEntries(fromByte.container);
        expect(byteDigests, item.id).toEqual(arrayDigests);
        const expectedDigests = JAVA.cases[key];
        expect(expectedDigests, item.id).toBeDefined();
        expect(Object.fromEntries(arrayDigests), item.id).toEqual(expectedDigests);
      } finally {
        await fromArray.container.close();
        await fromByte.container.close();
      }
    }
  });

  it('加密夹具经 verifyOfd 的明文/凭据路径与 arraybuffer 一致', async () => {
    for (const item of ENCRYPTED_CASES) {
      const credentials = credentialOf(item)!;
      const fromArray = await verifyOfd({
        source: arraySource(item.path),
        now: FIXED_NOW,
        credentials,
        roots: ROOT_DER_FROM_PEM,
      });
      const fromByte = await verifyOfd({
        source: byteSource(item.path),
        now: FIXED_NOW,
        credentials,
        roots: ROOT_DER_FROM_PEM,
      });
      expect(stableReport(fromByte), item.id).toEqual(stableReport(fromArray));
      expect(fromArray.overall, item.id).toBe('not-applicable');
      expect(fromArray.package.decrypted, item.id).toBe(true);
    }
  });
});
