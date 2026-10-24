/**
 * t3 独立验收（crypto）：证书链独立于最终判定、篡改负例、完整性链失败、
 * 时间戳不参与 overall 与签发时间来源优先级。
 *
 * 本文件只使用公开 `verifyOfd` API、已提交夹具与测试专用合成容器；
 * 断言按 t3 契约独立编写，不复用 t1/t7 的断言文本。
 */

import { describe, expect, it } from 'vitest';
import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import {
  derBitString,
  derContext,
  derOctetString,
  derSequence,
  parseDer,
  verifyOfd,
  type VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import { FIXED_NOW, fixtureBytes } from '../core/fixtures';
import {
  buildV1SignedContainer,
  readFixtureEntries,
  wrapEntries,
} from '../verify/builders';
import { makeCertificate, testKeyPair } from '../verify/certs';

/** 受信任根证书 DER。 */
const ROOT = fixtureBytes('certs', 'root-ca.crt.der');
/** 与签章链无关的 TSA 证书；作为错误信任根使用。 */
const WRONG_ROOT = fixtureBytes('certs', 'tsa.crt.der');

/**
 * 打开 fixture 容器并执行验证。
 *
 * `now` 默认注入 {@link FIXED_NOW}，避免断言证书链 `valid` 依赖真实系统时间。
 *
 * @param file `test/fixtures/crypto/` 下的文件名。
 * @param options 额外验证参数。
 * @returns 验证报告。
 */
async function verifyFixture(
  file: string,
  options: { roots?: readonly Uint8Array[]; now?: Date } = {},
): Promise<VerificationReport> {
  const container = await openZipVirtualContainer({
    kind: 'arraybuffer',
    data: fixtureBytes(file),
  });
  try {
    return await verifyOfd({ container, now: FIXED_NOW, ...options });
  } finally {
    await container.close();
  }
}

describe('t3-A 证书链不参与最终判定', () => {
  it('无根：overall=valid，签名/数据哈希/引用通过，链 status=unknown 保留', async () => {
    const report = await verifyFixture('signed-sesv4.ofd');
    const signature = report.signatures[0]!;

    expect(report.overall).toBe('valid');
    expect(report.rootsConfigured).toBe(false);
    expect(signature.signature.status).toBe('valid');
    expect(signature.dataHash.status).toBe('valid');
    expect(signature.references.status).toBe('valid');
    expect(signature.seal?.status).toBe('valid');
    expect(signature.certificate.status).toBe('unknown');
    expect(signature.certificate.trustRootConfigured).toBe(false);
    expect(signature.certificate.trustAnchor).toBeUndefined();
    expect(report.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_TRUST_UNKNOWN');
  });

  it('链过期：overall=valid，链 status=expired 与 CHAIN_EXPIRED 明细保留', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', {
      roots: [ROOT],
      now: new Date('2041-01-01T00:00:00Z'),
    });
    const signature = report.signatures[0]!;

    expect(report.overall).toBe('valid');
    expect(signature.signature.status).toBe('valid');
    expect(signature.dataHash.status).toBe('valid');
    expect(signature.references.status).toBe('valid');
    expect(signature.certificate.status).toBe('expired');
    expect(signature.certificate.trustRootConfigured).toBe(true);
    expect(signature.certificate.issues.map((issue) => issue.code)).toContain('CHAIN_EXPIRED');
  });

  it('链不受信/不完整：overall=valid，链 status 与 issues 保留', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', { roots: [WRONG_ROOT] });
    const signature = report.signatures[0]!;

    expect(report.overall).toBe('valid');
    expect(signature.status).toBe('valid');
    expect(signature.signature.status).toBe('valid');
    expect(signature.dataHash.status).toBe('valid');
    expect(signature.references.status).toBe('valid');
    expect(['untrusted', 'incomplete']).toContain(signature.certificate.status);
    expect(signature.certificate.trustRootConfigured).toBe(true);
    expect(signature.certificate.issues.length).toBeGreaterThan(0);
  });

  it('链不受信（自签叶证书）：overall=valid，链 status=untrusted 与 CHAIN_UNTRUSTED 保留', async () => {
    const untrustedKey = testKeyPair('encrypt');
    const untrustedCert = makeCertificate(
      {
        serial: 1301n,
        cn: 't3 Untrusted Signer',
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      untrustedKey,
    ).der;
    const container = await buildV1SignedContainer({
      signerCert: untrustedCert,
      signerKey: untrustedKey.privateKey,
    });
    try {
      const report = await verifyOfd({ container, roots: [ROOT], now: FIXED_NOW });
      const signature = report.signatures[0]!;

      expect(report.overall).toBe('valid');
      expect(signature.signature.status).toBe('valid');
      expect(signature.dataHash.status).toBe('valid');
      expect(signature.references.status).toBe('valid');
      expect(signature.certificate.status).toBe('untrusted');
      expect(signature.certificate.trustRootConfigured).toBe(true);
      expect(signature.certificate.issues.map((issue) => issue.code)).toContain(
        'CHAIN_UNTRUSTED',
      );
    } finally {
      await container.close();
    }
  });

  it('完整性链失败但完整性签名与清单通过：integrity=valid、overall=valid', async () => {
    const report = await verifyFixture('integrity.ofd', { roots: [WRONG_ROOT] });

    expect(report.overall).toBe('valid');
    expect(report.integrity?.status).toBe('valid');
    expect(report.integrity?.signature.status).toBe('valid');
    expect(report.integrity?.missingFiles).toEqual([]);
    expect(report.integrity?.extraFiles).toEqual([]);
    expect(report.integrity?.certificate.status).not.toBe('valid');
    expect(report.integrity?.certificate.issues.length).toBeGreaterThan(0);
  });
});

describe('t3-A 篡改与缺证书必须 invalid', () => {
  it('篡改 dataHash（Signature.xml）：overall=invalid，数学签名仍通过', async () => {
    const report = await verifyFixture('negative-tampered-signature.ofd', { roots: [ROOT] });

    expect(report.overall).toBe('invalid');
    expect(report.signatures[0]?.status).toBe('invalid');
    expect(report.signatures[0]?.dataHash.status).toBe('invalid');
    expect(report.signatures[0]?.signature.status).toBe('valid');
  });

  it('篡改 Reference（引用内容）：overall=invalid，数学签名仍通过', async () => {
    const report = await verifyFixture('negative-tampered-content.ofd', { roots: [ROOT] });

    expect(report.overall).toBe('invalid');
    expect(report.signatures[0]?.status).toBe('invalid');
    expect(report.signatures[0]?.references.status).toBe('invalid');
    expect(report.signatures[0]?.references.failures.length).toBeGreaterThan(0);
    expect(report.signatures[0]?.signature.status).toBe('valid');
  });

  it('缺少签章者证书：数学无法验证 => overall=invalid，链 not-present', async () => {
    const container = await buildV1SignedContainer({ signerCert: new Uint8Array() });
    try {
      const report = await verifyOfd({ container, roots: [ROOT], now: FIXED_NOW });
      const signature = report.signatures[0]!;

      expect(report.overall).toBe('invalid');
      expect(signature.status).toBe('invalid');
      expect(signature.signature.status).toBe('invalid');
      expect(signature.certificate.status).toBe('not-present');
      expect(signature.issues.map((issue) => issue.code)).toContain(
        'CRYPTO_CERTIFICATE_INVALID',
      );
    } finally {
      await container.close();
    }
  });
});

describe('t3-A 时间戳与签发时间', () => {
  it('时间戳解析失败不参与 overall', async () => {
    const entries = await readFixtureEntries('signed-sesv4.ofd');
    const path = 'Doc_0/Signs/Sign_0/SignedValue.dat';
    const root = parseDer(entries.get(path)!.bytes).requireSequence('SES_Signature');
    // 只替换 [0] 时间戳内容，TBS 与签名值保持不变。
    const rebuilt = derSequence(
      root.children[0]!.raw,
      root.children[1]!.raw,
      root.children[2]!.raw,
      root.children[3]!.raw,
      derContext(0, derBitString(new Uint8Array([0x30, 0x00]))),
    );
    entries.set(path, { bytes: rebuilt });
    const container = wrapEntries(entries);
    try {
      const report = await verifyOfd({ container, roots: [ROOT], now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      expect(report.signatures[0]?.signature.status).toBe('valid');
      expect(report.signatures[0]?.timestamp.status).toBe('parse-error');
      expect(report.signatures[0]?.signingTimeSource).toBe('time-info');
      expect(report.warnings.map((warning) => warning.code)).toContain(
        'W_CRYPTO_TIMESTAMP_PARSE',
      );
    } finally {
      await container.close();
    }
  });

  it('时间戳只解析：parsed-not-verified 且 overall 仍由签名/引用决定', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', { roots: [ROOT] });
    const signature = report.signatures[0]!;

    expect(report.overall).toBe('valid');
    expect(signature.timestamp.status).toBe('parsed-not-verified');
    expect(signature.timestamp.tokenPresent).toBe(true);
    expect(signature.signingTimeSource).toBe('time-info');
    expect(signature.certificate.status).toBe('valid');
  });

  it('签发时间优先 timeInfo，其次 SignatureDateTime，无值则字段省略', async () => {
    const withTimeInfo = await buildV1SignedContainer();
    try {
      const report = await verifyOfd({ container: withTimeInfo, roots: [ROOT], now: FIXED_NOW });
      expect(report.signatures[0]?.signingTime).toBe('2026-10-23 10:00:00');
      expect(report.signatures[0]?.signingTimeSource).toBe('time-info');
    } finally {
      await withTimeInfo.close();
    }

    const fallback = await buildV1SignedContainer({
      timeInfo: derOctetString(new Uint8Array()),
    });
    try {
      const report = await verifyOfd({ container: fallback, roots: [ROOT], now: FIXED_NOW });
      expect(report.signatures[0]?.signingTime).toBe('2026-10-23 10:00:00');
      expect(report.signatures[0]?.signingTimeSource).toBe('signature-xml');
    } finally {
      await fallback.close();
    }

    const missing = await buildV1SignedContainer({
      timeInfo: derOctetString(new Uint8Array()),
      omitSignatureDateTime: true,
    });
    try {
      const report = await verifyOfd({ container: missing, roots: [ROOT], now: FIXED_NOW });
      expect(report.signatures[0]?.signingTime).toBeUndefined();
      expect(report.signatures[0]?.signingTimeSource).toBeUndefined();
      expect('signingTime' in report.signatures[0]!).toBe(false);
    } finally {
      await missing.close();
    }
  });
});