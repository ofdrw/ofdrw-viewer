/**
 * t13 独立验证：签名、证书链、Ref/SignedValue/Seal 篡改与 Java OFDValidator 对照。
 */

import { describe, expect, it } from 'vitest';
import {
  verifyOfd,
  type VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  entryOf,
  fixtureBytes,
  javaSignature,
  memoryContainer,
  openFixtureEntries,
  tamperSealSignature,
  tamperSignedValueSignature,
  verifyContainer,
  verifyFixture,
  verifyOptions,
  wrongRootDer,
} from './support';

/** 允许的状态集合；用于确认状态字段是单值而非“同时 valid+invalid”。 */
const STATUSES = new Set(['valid', 'invalid', 'unknown', 'not-present', 'not-applicable']);

/**
 * 断言一个状态值是互斥的单值。
 *
 * @param status 待检查状态。
 */
function expectSingleStatus(status: string): void {
  expect(STATUSES.has(status)).toBe(true);
}

/**
 * 断言报告结构完整且可 JSON 序列化。
 *
 * @param report 验证报告。
 */
function expectCompleteReport(report: VerificationReport): void {
  expectSingleStatus(report.overall);
  expect(report.package).toBeDefined();
  expectSingleStatus(report.package.encrypted ? 'valid' : 'not-applicable');
  expect(report.package.entryCount).toBeGreaterThan(0);
  expect(report.package.packageSize).toBeGreaterThan(0);
  expect(Array.isArray(report.signatures)).toBe(true);
  expect(Array.isArray(report.warnings)).toBe(true);
  for (const signature of report.signatures) {
    expectSingleStatus(signature.status);
    expectSingleStatus(signature.signature.status);
    expectSingleStatus(signature.dataHash.status);
    expectSingleStatus(signature.references.status);
    expectSingleStatus(signature.certificate.status);
    expect(signature.certificate.revocation).toBe('not-checked');
    expect(signature.timestamp.status).toMatch(/^(not-present|parsed-not-verified|parse-error)$/);
    if (signature.seal) {
      expectSingleStatus(signature.seal.status);
      expectSingleStatus(signature.seal.math.status);
      expectSingleStatus(signature.seal.certificate.status);
    }
  }
  if (report.integrity) {
    expectSingleStatus(report.integrity.status);
    expectSingleStatus(report.integrity.signature.status);
    expectSingleStatus(report.integrity.certificate.status);
    expect(report.integrity.certificate.revocation).toBe('not-checked');
  }
  const roundTrip = JSON.parse(JSON.stringify(report)) as VerificationReport;
  expect(roundTrip.overall).toBe(report.overall);
  expect(roundTrip.package.signatureCount).toBe(report.package.signatureCount);
  expect(roundTrip.signatures).toHaveLength(report.signatures.length);
}

describe('签名/证书链：有效、unknown 与错误根', () => {
  for (const version of ['v4', 'v5'] as const) {
    it(`SES ${version} + 信任根 → valid 且字段完整`, async () => {
      const file = `signed-ses${version}.ofd`;
      const report = await verifyFixture(file);
      expect(report.overall).toBe('valid');
      expect(javaSignature(file).valid).toBe(true);
      expectCompleteReport(report);

      const signature = report.signatures[0]!;
      expect(signature.status).toBe('valid');
      expect(signature.version).toBe(version);
      expect(signature.signature.status).toBe('valid');
      expect(signature.dataHash.status).toBe('valid');
      expect(signature.dataHash.expected).toBe(signature.dataHash.actual);
      expect(signature.references).toMatchObject({ status: 'valid', total: 6, checked: 6 });
      expect(signature.references.failures).toEqual([]);
      expect(signature.certificate.status).toBe('valid');
      expect(signature.certificate.trustRootConfigured).toBe(true);
      expect(signature.certificate.signer?.subject).toContain('Signer');
      expect(signature.certificate.trustAnchor?.subject).toContain('Root CA');
      expect(signature.certificate.chain).toHaveLength(2);
      expect(signature.seal).toMatchObject({ status: 'valid', matchesSignedValue: true });
      expect(signature.seal?.math.status).toBe('valid');
      expect(signature.seal?.certificate.status).toBe('valid');
      expect(signature.timestamp.status).toBe('parsed-not-verified');
      expect(report.package.signatureCount).toBe(1);
      expect(report.package.integrityPresent).toBe(false);
      expect(report.integrity).toBeNull();
      expect(report.warnings).toEqual([]);
    });
  }

  it('未配置信任根 → overall/signature/cert 均为 unknown，而不是失败', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', {});
    expect(report.overall).toBe('unknown');
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('unknown');
    expect(signature.signature.status).toBe('valid');
    expect(signature.dataHash.status).toBe('valid');
    expect(signature.references.status).toBe('valid');
    expect(signature.certificate.status).toBe('unknown');
    expect(signature.certificate.trustRootConfigured).toBe(false);
    expect(signature.certificate.trustAnchor).toBeUndefined();
    // 未配置根不是“验签失败”，不能把数学/引用校验的 valid 降级为 invalid。
    expect(signature.seal?.status).not.toBe('invalid');
  });

  it('错误根证书 → incomplete/invalid', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', {
      roots: [wrongRootDer],
    });
    expect(report.overall).toBe('invalid');
    expect(javaSignature('negative-tampered-content.ofd').valid).toBe(false);
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('invalid');
    expect(signature.certificate.status).toBe('incomplete');
    expect(signature.certificate.issues.some((issue) => issue.code === 'CHAIN_INCOMPLETE')).toBe(
      true,
    );
    expect(signature.signature.status).toBe('valid');
    expect(signature.references.status).toBe('valid');
  });

  it('证书过期 → expired/invalid', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', {
      now: new Date('2041-01-01T00:00:00.000Z'),
    });
    expect(report.overall).toBe('invalid');
    const signature = report.signatures[0]!;
    expect(signature.certificate.status).toBe('expired');
    expect(signature.certificate.issues.some((issue) => issue.code === 'CHAIN_EXPIRED')).toBe(true);
  });

  it('未配置根时发现过期也不能降级为 unknown', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', {
      now: new Date('2041-01-01T00:00:00.000Z'),
    });
    // verifyFixture 默认注入根；显式覆盖为空才能验证“未配置根 + 过期”语义。
    const noRoot = await verifyFixture('signed-sesv4.ofd', {
      roots: [],
      now: new Date('2041-01-01T00:00:00.000Z'),
    });
    expect(report.overall).toBe('invalid');
    expect(noRoot.overall).toBe('invalid');
    expect(noRoot.signatures[0]?.certificate.status).toBe('expired');
  });

  it('证书尚未生效 → not-yet-valid/invalid', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', {
      now: new Date('2019-01-01T00:00:00.000Z'),
    });
    expect(report.overall).toBe('invalid');
    expect(report.signatures[0]?.certificate.status).toBe('not-yet-valid');
  });

  it('DERRoot（DER 输入）同样通过', async () => {
    const report = await verifyFixture('signed-sesv4.ofd', {
      roots: [fixtureBytes('certs/root-ca.crt.der')],
    });
    expect(report.overall).toBe('valid');
    expect(report.signatures[0]?.certificate.status).toBe('valid');
  });
});

describe('签名负例：Ref、SignedValue、Seal、Signature.xml', () => {
  it('引用文件被篡改 → references invalid，原因 mismatch', async () => {
    const file = 'negative-tampered-content.ofd';
    const report = await verifyFixture(file);
    expect(javaSignature(file).valid).toBe(false);
    expect(report.overall).toBe('invalid');
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('invalid');
    expect(signature.references.status).toBe('invalid');
    expect(signature.references.failures).toEqual([
      { fileRef: 'Doc_0/Pages/Page_0/Content.xml', reason: 'mismatch' },
    ]);
    expect(
      signature.issues.some(
        (issue) =>
          issue.code === 'REFERENCE_MISMATCH' &&
          issue.path === 'Doc_0/Pages/Page_0/Content.xml',
      ),
    ).toBe(true);
    expect(signature.signature.status).toBe('valid');
    expect(signature.dataHash.status).toBe('valid');
  });

  it('SignedValue.dat 被篡改 → 签名解析失败但报告不抛异常', async () => {
    const file = 'negative-tampered-signedvalue.ofd';
    const report = await verifyFixture(file);
    expect(javaSignature(file).valid).toBe(false);
    expect(report.overall).toBe('invalid');
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('invalid');
    expect(signature.version).toBe('unknown');
    expect(signature.signature.status).toBe('invalid');
    expect(
      signature.issues.some(
        (issue) => issue.code === 'CRYPTO_ASN1_INVALID' && issue.path === 'Doc_0/Signs/Sign_0/SignedValue.dat',
      ),
    ).toBe(true);
  });

  it('SignedValue 签名值被篡改（结构仍合法）→ 数学验签失败，与 Java 一致', async () => {
    const entries = openFixtureEntries('signed-sesv4.ofd');
    const signedValue = entries.get('Doc_0/Signs/Sign_0/SignedValue.dat');
    if (!signedValue) throw new Error('缺少 SignedValue.dat');
    entries.set('Doc_0/Signs/Sign_0/SignedValue.dat', tamperSignedValueSignature(signedValue));
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(javaSignature('security-tampered-signature-value.ofd').valid).toBe(false);
      expect(report.overall).toBe('invalid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('invalid');
      expect(signature.version).toBe('v4');
      expect(signature.signature.status).toBe('invalid');
      expect(signature.issues.some((issue) => issue.code.includes('SIGNATURE'))).toBe(true);
    } finally {
      await container.close();
    }
  });

  it('Seal 制章人签名值被篡改（结构仍合法）→ Seal 数学验签失败，与 Java 一致', async () => {
    const entries = openFixtureEntries('signed-sesv4.ofd');
    const seal = entries.get('Doc_0/Signs/Sign_0/Seal.esl');
    if (!seal) throw new Error('缺少 Seal.esl');
    entries.set('Doc_0/Signs/Sign_0/Seal.esl', tamperSealSignature(seal));
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(javaSignature('security-tampered-seal-signature.ofd').valid).toBe(false);
      expect(report.overall).toBe('invalid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('invalid');
      expect(signature.seal?.matchesSignedValue).toBe(false);
      expect(signature.seal?.math.status).toBe('invalid');
      expect(signature.seal?.issues.length).toBeGreaterThan(0);
      expect(signature.references.status).toBe('invalid');
    } finally {
      await container.close();
    }
  });

  it('Signature.xml 被篡改 → dataHash invalid，原因明确', async () => {
    const file = 'negative-tampered-signature.ofd';
    const report = await verifyFixture(file);
    expect(javaSignature(file).valid).toBe(false);
    expect(report.overall).toBe('invalid');
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('invalid');
    expect(signature.dataHash.status).toBe('invalid');
    expect(signature.dataHash.expected).not.toBe(signature.dataHash.actual);
    expect(
      signature.issues.some((issue) => issue.code === 'SIGNATURE_DATA_HASH_MISMATCH'),
    ).toBe(true);
  });

  it('Seal.esl 被篡改 → seal/reference 同时检出，与 Java 一致', async () => {
    const entries = openFixtureEntries('signed-sesv4.ofd');
    const seal = entries.get('Doc_0/Signs/Sign_0/Seal.esl');
    if (!seal) throw new Error('缺少 Seal.esl');
    entries.set('Doc_0/Signs/Sign_0/Seal.esl', seal.subarray(0, seal.length - 1));
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(javaSignature('security-tampered-seal.ofd').valid).toBe(false);
      expect(report.overall).toBe('invalid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('invalid');
      expect(signature.seal?.matchesSignedValue).toBe(false);
      expect(signature.seal?.issues.some((issue) => issue.code === 'SEAL_PARSE_FAILED')).toBe(true);
      expect(signature.references.status).toBe('invalid');
      expect(signature.references.failures[0]?.fileRef).toBe('Doc_0/Signs/Sign_0/Seal.esl');
    } finally {
      await container.close();
    }
  });

  it('缺失 SignedValue.dat → SIGNED_VALUE_MISSING', async () => {
    const entries = openFixtureEntries('signed-sesv4.ofd');
    entries.delete('Doc_0/Signs/Sign_0/SignedValue.dat');
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('invalid');
      expect(report.signatures[0]?.status).toBe('invalid');
      expect(
        report.signatures[0]?.issues.some((issue) => issue.code === 'SIGNED_VALUE_MISSING'),
      ).toBe(true);
    } finally {
      await container.close();
    }
  });

  it('损坏 Signature.xml → 报告 invalid 且不抛异常', async () => {
    const entries = openFixtureEntries('signed-sesv4.ofd');
    entries.set('Doc_0/Signs/Sign_0/Signature.xml', new Uint8Array([0x00, 0x01, 0x02]));
    const container = memoryContainer(entries);
    try {
      const report = await verifyContainer(container);
      expect(report.overall).toBe('invalid');
      expect(report.signatures[0]?.status).toBe('invalid');
      expect(report.signatures[0]?.issues.length).toBeGreaterThan(0);
    } finally {
      await container.close();
    }
  });
});

describe('报告聚合、参数与容器注入', () => {
  it('签名 + 完整性组合 → overall valid，两块都完整', async () => {
    const report = await verifyFixture('combined-signed-integrity.ofd');
    expect(report.overall).toBe('valid');
    expect(report.package.encrypted).toBe(false);
    expect(report.package.integrityPresent).toBe(true);
    expect(report.signatures[0]?.status).toBe('valid');
    expect(report.integrity?.status).toBe('valid');
    expectCompleteReport(report);
  });

  it('无签名且无完整性 → not-applicable，integrity=null', async () => {
    const report = await verifyFixture('plain.ofd');
    expect(report.overall).toBe('not-applicable');
    expect(report.signatures).toEqual([]);
    expect(report.integrity).toBeNull();
    expect(report.package.integrityPresent).toBe(false);
    expectCompleteReport(report);
  });

  it('加密 source 自动解密后验证，原始凭据不进入报告', async () => {
    const source = fixtureBytes('combined-password-encrypted.ofd');
    const report = await verifyOfd({
      source: { kind: 'arraybuffer', data: source },
      credentials: { kind: 'password', userName: 'fixture-password-user', password: 'FixturePass123' },
      ...verifyOptions(),
    });
    expect(report.overall).toBe('valid');
    expect(report.package.encrypted).toBe(true);
    expect(report.package.decrypted).toBe(true);
    expect(report.package.integrityPresent).toBe(true);
    expect(report.decryption?.plaintext).toBe(false);
    expect(report.decryption?.layers[0]?.user?.userName).toBe('fixture-password-user');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('FixturePass123');
        expectCompleteReport(report);
  });

  it('加密 container 直接传入 → CRYPTO_CREDENTIALS_REQUIRED', async () => {
    const container = await import('@ofdrw/ofdrw-viewer-engine').then((engine) =>
      engine.openZipVirtualContainer({
        kind: 'arraybuffer',
        data: fixtureBytes('password-encrypted.ofd'),
      }),
    );
    try {
      await expect(verifyOfd({ container })).rejects.toMatchObject({
        code: 'CRYPTO_CREDENTIALS_REQUIRED',
      });
    } finally {
      await container.close();
    }
  });

  it('source/container 同时或缺失、非法 roots、损坏根证书 → typed errors', async () => {
    const container = memoryContainer(new Map([['OFD.xml', entryOf('plain.ofd', 'OFD.xml')]]));
    try {
      await expect(
        verifyOfd({ container, source: { kind: 'arraybuffer', data: fixtureBytes('plain.ofd') } }),
      ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
      await expect(verifyOfd({})).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
      await expect(
        verifyOfd({ container, roots: 'bad' as never }),
      ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
      await expect(
        verifyOfd({ container, roots: [new Uint8Array([0x30, 0x01])] }),
      ).rejects.toMatchObject({ code: 'CRYPTO_TRUST_ROOT_INVALID' });
    } finally {
      await container.close();
    }
  });
});
