/**
 * `verifyOfd` 统一验证：签名/证书链/印章/完整性/时间戳/加密源与错误参数。
 */

import { describe, expect, it } from 'vitest';
import {
  openZipVirtualContainer,
  type VirtualContainer,
} from '@ofdrw/ofdrw-viewer-engine';
import {
  CryptoError,
  derBitString,
  derContext,
  derInteger,
  derOctetString,
  derSequence,
  parseDer,
  verifyOfd,
  type CryptoCredential,
  type VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import { FIXED_NOW, fixtureBytes } from '../core/fixtures';
import {
  buildAuthAttrsIntegrityContainer,
  buildV1Seal,
  buildV1SignedContainer,
  buildV5SealWithTimestamp,
  mergeEntries,
  readEntriesOf,
  readFixtureEntries,
  wrapEntries,
} from './builders';
import { makeCertificate, testKeyPair } from './certs';

/** 信任根输入。 */
const ROOTS = [fixtureBytes('certs', 'root-ca.crt.der')];
/** 口令凭据。 */
const PASSWORD: CryptoCredential = {
  kind: 'password',
  userName: 'fixture-password-user',
  password: 'FixturePass123',
};

/**
 * 打开 fixture ZIP 容器。
 *
 * @param file fixture 文件名。
 * @returns 容器。
 */
async function open(file: string): Promise<VirtualContainer> {
  return openZipVirtualContainer({ kind: 'arraybuffer', data: fixtureBytes(file) });
}

/**
 * 验证 fixture 容器并在结束后关闭。
 *
 * `now` 默认注入 {@link FIXED_NOW}，避免断言证书链 `valid` 依赖真实系统时间。
 *
 * @param file fixture 文件名。
 * @param options 额外验证选项。
 * @returns 验证报告。
 */
async function verifyFile(
  file: string,
  options: { roots?: typeof ROOTS; now?: Date } = {},
): Promise<VerificationReport> {
  const container = await open(file);
  try {
    return await verifyOfd({ container, now: FIXED_NOW, ...options });
  } finally {
    await container.close();
  }
}

/**
 * 捕获 CryptoError 错误码。
 *
 * @param promise 待执行 promise。
 * @returns 错误码。
 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  throw new Error('promise 未按预期拒绝');
}

describe('verifyOfd 签名验证', () => {
  for (const [file, version] of [
    ['signed-sesv4.ofd', 'v4'],
    ['signed-sesv5.ofd', 'v5'],
  ] as const) {
    it(`${version} 签名 + 印章 + 时间戳全部通过`, async () => {
      const report = await verifyFile(file, { roots: ROOTS });
      expect(report.overall).toBe('valid');
      expect(report.package).toMatchObject({
        ofdVersion: '1.0',
        encrypted: false,
        decrypted: false,
        signatureCount: 1,
        integrityPresent: false,
      });
      expect(report.integrity).toBeNull();
      expect(report.rootsConfigured).toBe(true);
      expect(report.warnings).toEqual([]);
      const signature = report.signatures[0]!;
      expect(signature).toMatchObject({
        id: 's001',
        type: 'Seal',
        version,
        baseLoc: 'Doc_0/Signs/Sign_0/Signature.xml',
        signedValuePath: 'Doc_0/Signs/Sign_0/SignedValue.dat',
        status: 'valid',
      });
      expect(signature.signature).toMatchObject({
        status: 'valid',
        algorithm: 'SM3withSM2',
        sm2UserId: '1234567812345678',
      });
      expect(signature.dataHash.status).toBe('valid');
      expect(signature.dataHash.expected).toBe(signature.dataHash.actual);
      expect(signature.references).toMatchObject({
        status: 'valid',
        total: 6,
        checked: 6,
        failures: [],
      });
      expect(signature.certificate).toMatchObject({
        status: 'valid',
        trustRootConfigured: true,
        revocation: 'not-checked',
      });
      expect(signature.certificate.trustAnchor?.subject).toContain('Root CA');
      // 签发时间优先取 TBS_Sign.timeInfo（v4/v5 为 ISO 8601）。
      expect(signature.signingTime).toBe('2026-10-22T17:51:06.000Z');
      expect(signature.signingTimeSource).toBe('time-info');
      expect(signature.seal).toMatchObject({
        status: 'valid',
        version,
        esId: version === 'v4' ? 'OFDRWFIXTURESEALV4' : 'OFDRWFIXTURESEALV5',
        matchesSignedValue: true,
      });
      expect(signature.seal?.certificate.status).toBe('valid');
      expect(signature.seal?.timestamp.status).toBe('not-present');
      expect(signature.timestamp).toMatchObject({
        status: 'parsed-not-verified',
        tokenPresent: true,
        note: '已解析，未验证',
        messageImprintMatchesSignature: true,
      });
      expect(signature.issues).toEqual([]);
      expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });
  }

  it('未配置信任根时链为 unknown，但签名与整体仍可 valid', async () => {
    const report = await verifyFile('signed-sesv4.ofd');
    expect(report.overall).toBe('valid');
    expect(report.rootsConfigured).toBe(false);
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('valid');
    expect(signature.signature.status).toBe('valid');
    expect(signature.dataHash.status).toBe('valid');
    expect(signature.references.status).toBe('valid');
    expect(signature.certificate).toMatchObject({
      status: 'unknown',
      trustRootConfigured: false,
      trustAnchor: undefined,
    });
    expect(signature.seal?.status).toBe('valid');
    expect(signature.seal?.certificate.status).toBe('unknown');
    // warning 保留，但不改变 overall。
    expect(report.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_TRUST_UNKNOWN');
  });

  it('证书过期时链为 expired，但签名与整体仍 valid（注入 now）', async () => {
    const report = await verifyFile('signed-sesv4.ofd', {
      roots: ROOTS,
      now: new Date('2041-01-01T00:00:00Z'),
    });
    expect(report.overall).toBe('valid');
    const signature = report.signatures[0]!;
    expect(signature.certificate.status).toBe('expired');
    expect(signature.certificate.currentTime).toBe('2041-01-01T00:00:00.000Z');
    expect(signature.status).toBe('valid');
    expect(signature.signature.status).toBe('valid');
    expect(signature.dataHash.status).toBe('valid');
    expect(signature.references.status).toBe('valid');
    expect(signature.seal?.status).toBe('valid');
    expect(signature.seal?.certificate.status).toBe('expired');
    expect(signature.issues.some((issue) => issue.code === 'CHAIN_EXPIRED')).toBe(true);
  });

  it('验证不关闭调用方容器', async () => {
    const container = await open('signed-sesv5.ofd');
    try {
      await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(container.has('OFD.xml')).toBe(true);
    } finally {
      await container.close();
    }
  });

  it('signatureIds 过滤', async () => {
    const container = await open('combined-signed-integrity.ofd');
    try {
      const only = await verifyOfd({ container, roots: ROOTS, signatureIds: ['s001'], now: FIXED_NOW });
      expect(only.signatures).toHaveLength(1);
      const none = await verifyOfd({ container, roots: ROOTS, signatureIds: ['missing'], now: FIXED_NOW });
      expect(none.signatures).toHaveLength(0);
      // 仍有完整性保护，overall 不因过滤变 not-applicable。
      expect(none.overall).toBe('valid');
    } finally {
      await container.close();
    }
  });

  it('合成 v1 签名端到端通过（含十六进制与 Base64 CheckValue）', async () => {
    const container = await buildV1SignedContainer();
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.version).toBe('v1');
      expect(signature.status).toBe('valid');
      expect(signature.dataHash.status).toBe('valid');
      expect(signature.references).toMatchObject({ status: 'valid', total: 2, checked: 2 });
      expect(signature.seal).toMatchObject({
        status: 'valid',
        version: 'v1',
        esId: 'synthetic-es-v1',
        matchesSignedValue: true,
      });
      expect(signature.certificate.status).toBe('valid');
      expect(signature.timestamp.status).toBe('not-present');
      // v1 的 timeInfo 是自由文本，作为签发时间原样展示。
      expect(signature.signingTime).toBe('2026-10-23 10:00:00');
      expect(signature.signingTimeSource).toBe('time-info');
    } finally {
      await container.close();
    }
  });

  it('timeInfo 为空时回退到 Signature.xml SignatureDateTime', async () => {
    const container = await buildV1SignedContainer({ timeInfo: derOctetString(new Uint8Array()) });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.signingTime).toBe('2026-10-23 10:00:00');
      expect(signature.signingTimeSource).toBe('signature-xml');
    } finally {
      await container.close();
    }
  });

  it('timeInfo 与 SignatureDateTime 都缺失时省略签发时间字段', async () => {
    const container = await buildV1SignedContainer({
      timeInfo: derOctetString(new Uint8Array()),
      omitSignatureDateTime: true,
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.signingTime).toBeUndefined();
      expect(signature.signingTimeSource).toBeUndefined();
      expect('signingTime' in signature).toBe(false);
      expect('signingTimeSource' in signature).toBe(false);
    } finally {
      await container.close();
    }
  });
});

describe('证书链独立于最终判定', () => {
  /** 与 ROOTS 无关的自签名签章者证书。 */
  const untrustedKey = testKeyPair('encrypt');
  const untrustedCert = makeCertificate(
    {
      serial: 301n,
      cn: 'Untrusted Signer',
      isCA: false,
      keyUsage: ['digitalSignature'],
    },
    untrustedKey,
  ).der;

  it('链不受信但签名数学与引用通过 → overall=valid，链明细保留 untrusted', async () => {
    const container = await buildV1SignedContainer({
      signerCert: untrustedCert,
      signerKey: untrustedKey.privateKey,
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('valid');
      expect(signature.signature.status).toBe('valid');
      expect(signature.dataHash.status).toBe('valid');
      expect(signature.references.status).toBe('valid');
      expect(signature.seal?.status).toBe('valid');
      expect(signature.certificate.status).toBe('untrusted');
      expect(signature.certificate.trustRootConfigured).toBe(true);
      expect(signature.certificate.issues.map((item) => item.code)).toContain('CHAIN_UNTRUSTED');
    } finally {
      await container.close();
    }
  });

  it('链不完整（缺中间证书）但签名通过 → overall=valid', async () => {
    const leafKey = testKeyPair('encrypt');
    const leaf = makeCertificate(
      {
        serial: 302n,
        cn: 'Incomplete Chain Leaf',
        issuerCn: 'OFDRW Viewer Crypto Fixtures Intermediate CA',
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      leafKey,
      testKeyPair('signer'),
    ).der;
    const container = await buildV1SignedContainer({
      signerCert: leaf,
      signerKey: leafKey.privateKey,
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('valid');
      expect(signature.certificate.status).toBe('incomplete');
      expect(signature.certificate.issues.map((item) => item.code)).toContain('CHAIN_INCOMPLETE');
    } finally {
      await container.close();
    }
  });

  it('链 invalid（叶证书 KeyUsage 不含 digitalSignature）但签名通过 → overall=valid', async () => {
    // certificate.status=unsupported 需要非 SM3withSM2 的证书签名算法，构造可验签夹具成本高；
    // 链状态与 overall 解耦已由本组 untrusted/incomplete/invalid 用例与 chain.test 覆盖。
    const leafKey = testKeyPair('encrypt');
    const leaf = makeCertificate(
      {
        serial: 303n,
        cn: 'No DigitalSignature Leaf',
        issuerCn: 'OFDRW Viewer Crypto Fixtures Root CA',
        isCA: false,
        keyUsage: ['keyEncipherment'],
      },
      leafKey,
      testKeyPair('root-ca'),
    ).der;
    const container = await buildV1SignedContainer({
      signerCert: leaf,
      signerKey: leafKey.privateKey,
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('valid');
      expect(signature.signature.status).toBe('valid');
      expect(signature.dataHash.status).toBe('valid');
      expect(signature.references.status).toBe('valid');
      expect(signature.certificate.status).toBe('invalid');
      expect(signature.certificate.issues.map((item) => item.code)).toContain(
        'CHAIN_KEY_USAGE_INVALID',
      );
    } finally {
      await container.close();
    }
  });

  it('缺少签章者证书导致数学无法验证 → invalid，不得判 valid', async () => {
    const container = await buildV1SignedContainer({
      signerCert: new Uint8Array(),
      signerKey: testKeyPair('signer').privateKey,
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('invalid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('invalid');
      expect(signature.signature.status).toBe('invalid');
      expect(signature.certificate.status).toBe('not-present');
      expect(signature.issues.map((item) => item.code)).toContain('CRYPTO_CERTIFICATE_INVALID');
    } finally {
      await container.close();
    }
  });

  it('完整性链失败但完整性签名通过 → integrity/overall=valid，链明细保留', async () => {
    const wrongRoot = makeCertificate(
      {
        serial: 401n,
        cn: 'Other Root CA',
        isCA: true,
        keyUsage: ['keyCertSign'],
      },
      testKeyPair('tsa'),
    ).der;
    const report = await verifyFile('integrity.ofd', { roots: [wrongRoot] });
    expect(report.overall).toBe('valid');
    expect(report.integrity?.status).toBe('valid');
    expect(report.integrity?.signature.status).toBe('valid');
    expect(report.integrity?.certificate.status).toBe('incomplete');
    expect(report.integrity?.missingFiles).toEqual([]);
    expect(report.integrity?.extraFiles).toEqual([]);
  });

  it('时间戳解析失败不参与 overall', async () => {
    const entries = await readFixtureEntries('signed-sesv4.ofd');
    const path = 'Doc_0/Signs/Sign_0/SignedValue.dat';
    const signedValue = entries.get(path)!.bytes;
    const root = parseDer(signedValue).requireSequence('SES_Signature');
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
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('valid');
      expect(signature.signature.status).toBe('valid');
      expect(signature.timestamp.status).toBe('parse-error');
      expect(signature.signingTimeSource).toBe('time-info');
      expect(report.warnings.map((warning) => warning.code)).toContain('W_CRYPTO_TIMESTAMP_PARSE');
    } finally {
      await container.close();
    }
  });
});

describe('verifyOfd 完整性验证', () => {
  it('GB/T 35275 防夹带完整性通过', async () => {
    const report = await verifyFile('integrity.ofd', { roots: ROOTS });
    expect(report.overall).toBe('valid');
    expect(report.package.integrityPresent).toBe(true);
    expect(report.package.signatureCount).toBe(0);
    expect(report.integrity).toMatchObject({
      status: 'valid',
      entriesPath: 'OFDEntries.xml',
      signedValuePath: 'signedvalue.dat',
      fileListCount: 5,
      actualFileCount: 5,
      missingFiles: [],
      extraFiles: [],
      authenticatedAttributes: false,
    });
    expect(report.integrity?.signature.status).toBe('valid');
    expect(report.integrity?.certificate.status).toBe('valid');
    expect(report.integrity?.issues).toEqual([]);
  });

  it('签名 + 完整性组合通过', async () => {
    const report = await verifyFile('combined-signed-integrity.ofd', { roots: ROOTS });
    expect(report.overall).toBe('valid');
    expect(report.integrity?.status).toBe('valid');
    expect(report.package.integrityPresent).toBe(true);
    expect(report.signatures[0]?.status).toBe('valid');
  });

  it('夹带未登记文件时完整性 invalid 并列出 extraFiles', async () => {
    const report = await verifyFile('negative-extra-file.ofd', { roots: ROOTS });
    expect(report.overall).toBe('invalid');
    expect(report.integrity?.status).toBe('invalid');
    expect(report.integrity?.extraFiles).toEqual(['evil.txt']);
    expect(report.integrity?.missingFiles).toEqual([]);
    expect(report.integrity?.issues.some((issue) => issue.code === 'INTEGRITY_EXTRA_FILE')).toBe(
      true,
    );
  });

  it('authenticatedAttributes + messageDigest 变体通过', async () => {
    const container = await buildAuthAttrsIntegrityContainer();
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      expect(report.integrity).toMatchObject({
        status: 'valid',
        authenticatedAttributes: true,
        missingFiles: [],
        extraFiles: [],
      });
      expect(report.integrity?.signature.status).toBe('valid');
      expect(report.integrity?.certificate.status).toBe('valid');
    } finally {
      await container.close();
    }
  });

  it('messageDigest 不符时完整性 invalid', async () => {
    const container = await buildAuthAttrsIntegrityContainer({ tamperDigest: true });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('invalid');
      expect(report.integrity?.status).toBe('invalid');
      expect(
        report.integrity?.issues.some((issue) => issue.code === 'INTEGRITY_DIGEST_MISMATCH'),
      ).toBe(true);
    } finally {
      await container.close();
    }
  });

  it('清单登记文件缺失时 invalid 并列出 missingFiles', async () => {
    const entries = await readFixtureEntries('integrity.ofd');
    entries.delete('Doc_0/PublicRes.xml');
    const container = wrapEntries(entries);
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.missingFiles).toEqual(['Doc_0/PublicRes.xml']);
    } finally {
      await container.close();
    }
  });
});

describe('verifyOfd 负例', () => {
  it('引用文件被篡改 → invalid', async () => {
    const report = await verifyFile('negative-tampered-content.ofd', { roots: ROOTS });
    expect(report.overall).toBe('invalid');
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('invalid');
    expect(signature.signature.status).toBe('valid');
    expect(signature.references.status).toBe('invalid');
    expect(signature.references.failures).toHaveLength(1);
    expect(signature.references.failures[0]?.reason).toBe('mismatch');
  });

  it('Signature.xml 被篡改 → dataHash 不符', async () => {
    const report = await verifyFile('negative-tampered-signature.ofd', { roots: ROOTS });
    expect(report.overall).toBe('invalid');
    const signature = report.signatures[0]!;
    expect(signature.dataHash.status).toBe('invalid');
    expect(signature.status).toBe('invalid');
    expect(signature.issues.some((issue) => issue.code === 'SIGNATURE_DATA_HASH_MISMATCH')).toBe(
      true,
    );
  });

  it('SignedValue.dat 被篡改 → 解析失败并 invalid', async () => {
    const report = await verifyFile('negative-tampered-signedvalue.ofd', { roots: ROOTS });
    expect(report.overall).toBe('invalid');
    const signature = report.signatures[0]!;
    expect(signature.status).toBe('invalid');
    expect(signature.signature.status).toBe('invalid');
    expect(signature.version).toBe('unknown');
  });

  it('缺失 SignedValue.dat → signature invalid', async () => {
    const entries = await readFixtureEntries('signed-sesv4.ofd');
    entries.delete('Doc_0/Signs/Sign_0/SignedValue.dat');
    const container = wrapEntries(entries);
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('invalid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('invalid');
      expect(signature.signedValuePath).toBe('Doc_0/Signs/Sign_0/SignedValue.dat');
      expect(
        signature.issues.some((issue) => issue.code === 'SIGNED_VALUE_MISSING'),
      ).toBe(true);
    } finally {
      await container.close();
    }
  });

  it('未签名且无完整性 → not-applicable', async () => {
    const report = await verifyFile('plain.ofd');
    expect(report.overall).toBe('not-applicable');
    expect(report.integrity).toBeNull();
    expect(report.signatures).toEqual([]);
  });
});

describe('verifyOfd 加密源与参数', () => {
  it('加密 source 内部解密并验证', async () => {
    const report = await verifyOfd({
      source: { kind: 'arraybuffer', data: fixtureBytes('combined-password-encrypted.ofd') },
      credentials: PASSWORD,
      roots: ROOTS,
      now: FIXED_NOW,
    });
    expect(report.overall).toBe('valid');
    expect(report.package).toMatchObject({
      encrypted: true,
      decrypted: true,
      integrityPresent: true,
      signatureCount: 1,
    });
    expect(report.decryption?.plaintext).toBe(false);
    expect(report.decryption?.layers).toHaveLength(1);
    expect(report.decryption?.layers[0]).toMatchObject({
      id: '1',
      entriesMapMode: 'encrypted',
      user: { userName: 'fixture-password-user' },
    });
    expect(report.integrity?.status).toBe('valid');
    expect(report.signatures[0]?.status).toBe('valid');
    expect(report.signatures[0]?.seal?.status).toBe('valid');
  });

  it('明文 source 原样验证且标记 encrypted=false', async () => {
    const report = await verifyOfd({
      source: { kind: 'arraybuffer', data: fixtureBytes('signed-sesv4.ofd') },
      roots: ROOTS,
      now: FIXED_NOW,
    });
    expect(report.overall).toBe('valid');
    expect(report.package.encrypted).toBe(false);
    expect(report.package.decrypted).toBe(false);
    expect(report.decryption).toBeUndefined();
  });

  it('明文 source 提供凭据时忽略并产生 warning', async () => {
    const report = await verifyOfd({
      source: { kind: 'arraybuffer', data: fixtureBytes('signed-sesv4.ofd') },
      credentials: PASSWORD,
      roots: ROOTS,
      now: FIXED_NOW,
    });
    expect(report.overall).toBe('valid');
    expect(report.warnings.map((warning) => warning.code)).toContain(
      'W_CRYPTO_CREDENTIAL_IGNORED',
    );
  });

  it('DER 根证书输入可用', async () => {
    const container = await open('signed-sesv4.ofd');
    try {
      const report = await verifyOfd({
        container,
        roots: [fixtureBytes('certs', 'root-ca.crt.der')],
        now: FIXED_NOW,
      });
      expect(report.overall).toBe('valid');
      expect(report.signatures[0]?.certificate.status).toBe('valid');
    } finally {
      await container.close();
    }
  });

  it('加密 source 缺少凭据 → CRYPTO_CREDENTIALS_REQUIRED', async () => {
    expect(
      await codeOf(
        verifyOfd({
          source: { kind: 'arraybuffer', data: fixtureBytes('password-encrypted.ofd') },
        }),
      ),
    ).toBe('CRYPTO_CREDENTIALS_REQUIRED');
  });

  it('加密容器直接拒绝 → CRYPTO_CREDENTIALS_REQUIRED', async () => {
    const container = await open('password-encrypted.ofd');
    try {
      expect(container.encrypted).toBe(true);
      expect(await codeOf(verifyOfd({ container }))).toBe('CRYPTO_CREDENTIALS_REQUIRED');
    } finally {
      await container.close();
    }
  });

  it('source 与 container 同时提供/都省略 → CRYPTO_INVALID_ARGUMENT', async () => {
    const container = await open('plain.ofd');
    try {
      expect(
        await codeOf(
          verifyOfd({
            container,
            source: { kind: 'arraybuffer', data: fixtureBytes('plain.ofd') },
          }),
        ),
      ).toBe('CRYPTO_INVALID_ARGUMENT');
      expect(await codeOf(verifyOfd({}))).toBe('CRYPTO_INVALID_ARGUMENT');
    } finally {
      await container.close();
    }
  });

  it('非法 roots/signatureIds → CRYPTO_INVALID_ARGUMENT', async () => {
    const container = await open('plain.ofd');
    try {
      expect(
        await codeOf(verifyOfd({ container, roots: 'bad' as never })),
      ).toBe('CRYPTO_INVALID_ARGUMENT');
      expect(
        await codeOf(verifyOfd({ container, signatureIds: [1 as never] })),
      ).toBe('CRYPTO_INVALID_ARGUMENT');
    } finally {
      await container.close();
    }
  });

  it('损坏根证书 → CRYPTO_TRUST_ROOT_INVALID', async () => {
    const container = await open('plain.ofd');
    try {
      expect(
        await codeOf(verifyOfd({ container, roots: [new Uint8Array([0x30, 0x01])] })),
      ).toBe('CRYPTO_TRUST_ROOT_INVALID');
    } finally {
      await container.close();
    }
  });
});

describe('t19 修复回归', () => {
  it('不支持的 SES 版本 → 签名 unsupported，不折叠为 invalid', async () => {
    const container = await buildV1SignedContainer({ versionNumber: 9 });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('unsupported');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('unsupported');
      expect(signature.certificate.status).toBe('unsupported');
      expect(signature.issues.map((item) => item.code)).toContain(
        'CRYPTO_UNSUPPORTED_SES_VERSION',
      );
    } finally {
      await container.close();
    }
  });

  it('不支持的签名算法 → unsupported，仍展示已解析证书', async () => {
    const container = await buildV1SignedContainer({
      signatureAlgorithm: '1.2.156.10197.1.502',
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('unsupported');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('unsupported');
      expect(signature.signature.status).toBe('unsupported');
      expect(signature.certificate.status).toBe('valid');
      expect(signature.certificate.signer).toBeDefined();
    } finally {
      await container.close();
    }
  });

  it('propertyInfo 与 BaseLoc 不一致 → invalid', async () => {
    const container = await buildV1SignedContainer({
      propertyInfo: '/Doc_0/Signs/Other/Signature.xml',
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('invalid');
      expect(
        report.signatures[0]!.issues.map((item) => item.code),
      ).toContain('SIGNATURE_PROPERTY_INFO_MISMATCH');
    } finally {
      await container.close();
    }
  });

  it('propertyInfo 路径越界 → invalid 而非中断', async () => {
    const container = await buildV1SignedContainer({ propertyInfo: '../escape.xml' });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('invalid');
      expect(
        report.signatures[0]!.issues.map((item) => item.code),
      ).toContain('SIGNATURE_PROPERTY_INFO_MISMATCH');
    } finally {
      await container.close();
    }
  });

  it('CheckMethod 使用 SM3 OID → 引用仍 valid', async () => {
    const container = await buildV1SignedContainer({ checkMethod: '1.2.156.10197.1.401' });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      expect(report.signatures[0]!.references.status).toBe('valid');
    } finally {
      await container.close();
    }
  });

  it('非法 BaseLoc 只影响该签名，其余签名继续验证', async () => {
    const container = await buildV1SignedContainer({ badBaseLocRecord: true });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('invalid');
      expect(report.signatures).toHaveLength(2);
      const bad = report.signatures.find((item) => item.id === 'bad')!;
      const good = report.signatures.find((item) => item.id === 's001')!;
      expect(bad.status).toBe('invalid');
      expect(bad.issues.map((item) => item.code)).toContain('SIGNATURE_BASELOC_INVALID');
      expect(good.status).toBe('valid');
    } finally {
      await container.close();
    }
  });

  it('Signatures.xml 单条记录缺失 BaseLoc 不影响其他记录', async () => {
    const base = await buildV1SignedContainer();
    try {
      const entries = await readEntriesOf(base);
      const signaturesXml = new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
          '<ofd:Signature ID="s002" Type="Seal"></ofd:Signature>' +
          '<ofd:Signature ID="s001" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
          '<ofd:MaxSignId>s001</ofd:MaxSignId></ofd:Signatures>',
      );
      const container = wrapEntries(
        mergeEntries(
          entries,
          new Map([['Doc_0/Signs/Signatures.xml', { bytes: signaturesXml }]]),
        ),
      );
      try {
        const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
        expect(report.signatures).toHaveLength(2);
        const bad = report.signatures.find((item) => item.id === 's002')!;
        const good = report.signatures.find((item) => item.id === 's001')!;
        expect(bad.status).toBe('invalid');
        expect(bad.issues.map((item) => item.code)).toContain('SIGNATURE_BASELOC_INVALID');
        expect(good.status).toBe('valid');
      } finally {
        await container.close();
      }
    } finally {
      await base.close();
    }
  });

  it('Seal.esl 顶层 3/6 字段 → 印章 unsupported 而非 invalid', async () => {
    for (const fieldCount of [3, 6]) {
      const base = await buildV1SignedContainer();
      try {
        const entries = await readEntriesOf(base);
        const badSeal = derSequence(
          ...Array.from({ length: fieldCount }, (_, index) => derInteger(BigInt(index + 1))),
        );
        const container = wrapEntries(
          mergeEntries(
            entries,
            new Map([['Doc_0/Signs/Sign_0/Seal.esl', { bytes: badSeal }]]),
          ),
        );
        try {
          const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
          expect(report.overall).toBe('unsupported');
          const signature = report.signatures[0]!;
          expect(signature.status).toBe('unsupported');
          const seal = signature.seal!;
          expect(seal.status).toBe('unsupported');
          expect(seal.math.status).toBe('unsupported');
          expect(seal.certificate.status).toBe('unsupported');
          expect(seal.certificate.issues).toEqual([]);
          expect(seal.issues.map((item) => item.code)).toContain(
            'CRYPTO_UNSUPPORTED_SES_VERSION',
          );
        } finally {
          await container.close();
        }
      } finally {
        await base.close();
      }
    }
  });

  it('印章图片缺失/损坏只降级 warning，不中断签名验证', async () => {
    for (const picture of ['missing', 'corrupt'] as const) {
      const container = await buildV1SignedContainer({ picture });
      try {
        const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
        expect(report.overall).toBe('valid');
        expect(report.warnings.map((item) => item.code)).toContain(
          'W_CRYPTO_SEAL_PICTURE_INVALID',
        );
        const seal = report.signatures[0]!.seal!;
        expect(seal.status).toBe('valid');
        expect(seal.issues.map((item) => item.code)).toContain(
          picture === 'missing' ? 'SEAL_PICTURE_MISSING' : 'SEAL_PICTURE_INVALID',
        );
      } finally {
        await container.close();
      }
    }
  });

  it('Signatures.xml 单条记录空 BaseLoc 也不影响其他记录', async () => {
    const base = await buildV1SignedContainer();
    try {
      const entries = await readEntriesOf(base);
      const signaturesXml = new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
          '<ofd:Signature ID="s002" Type="Seal"><ofd:BaseLoc></ofd:BaseLoc></ofd:Signature>' +
          '<ofd:Signature ID="s001" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
          '<ofd:MaxSignId>s001</ofd:MaxSignId></ofd:Signatures>',
      );
      const container = wrapEntries(
        mergeEntries(
          entries,
          new Map([['Doc_0/Signs/Signatures.xml', { bytes: signaturesXml }]]),
        ),
      );
      try {
        const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
        expect(report.signatures).toHaveLength(2);
        const bad = report.signatures.find((item) => item.id === 's002')!;
        const good = report.signatures.find((item) => item.id === 's001')!;
        expect(bad.status).toBe('invalid');
        expect(bad.issues.map((item) => item.code)).toContain('SIGNATURE_BASELOC_INVALID');
        expect(good.status).toBe('valid');
      } finally {
        await container.close();
      }
    } finally {
      await base.close();
    }
  });

  it('Signatures.xml 单条记录 BaseLoc 为空白时不误报 Signature.xml 损坏', async () => {
    const base = await buildV1SignedContainer();
    try {
      const entries = await readEntriesOf(base);
      const signaturesXml = new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
          '<ofd:Signature ID="s002" Type="Seal" BaseLoc=" "/>' +
          '<ofd:Signature ID="s001" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
          '<ofd:MaxSignId>s001</ofd:MaxSignId></ofd:Signatures>',
      );
      const container = wrapEntries(
        mergeEntries(
          entries,
          new Map([['Doc_0/Signs/Signatures.xml', { bytes: signaturesXml }]]),
        ),
      );
      try {
        const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
        expect(report.signatures).toHaveLength(2);
        const bad = report.signatures.find((item) => item.id === 's002')!;
        const good = report.signatures.find((item) => item.id === 's001')!;
        expect(bad.status).toBe('invalid');
        expect(bad.issues.map((item) => item.code)).toEqual(['SIGNATURE_BASELOC_INVALID']);
        expect(good.status).toBe('valid');
      } finally {
        await container.close();
      }
    } finally {
      await base.close();
    }
  });

  it('印章时间戳解析失败 → warning 级 issue + W_CRYPTO_TIMESTAMP_PARSE，无 error 级解析 issue', async () => {
    const entries = await readFixtureEntries('signed-sesv5.ofd');
    // 合成带非法时间戳令牌的 v5 印章；Seal.esl 与 SignedValue 不一致不影响本用例关注的 warning。
    const seal = buildV5SealWithTimestamp(new Uint8Array([0x30, 0x00]));
    const container = wrapEntries(
      mergeEntries(entries, new Map([['Doc_0/Signs/Sign_0/Seal.esl', { bytes: seal }]])),
    );
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.warnings.map((item) => item.code)).toContain('W_CRYPTO_TIMESTAMP_PARSE');
      const sealResult = report.signatures[0]!.seal!;
      const timestampIssues = sealResult.issues.filter(
        (item) => item.code === 'CRYPTO_TIMESTAMP_PARSE',
      );
      expect(timestampIssues).toHaveLength(1);
      expect(timestampIssues[0]!.severity).toBe('warning');
    } finally {
      await container.close();
    }
  });

  it('ASN.1 超限从 verifyOneSignature 重抛 CRYPTO_LIMIT_EXCEEDED', async () => {
    const container = await open('signed-sesv4.ofd');
    try {
      await expect(
        verifyOfd({ container, roots: ROOTS, now: FIXED_NOW, limits: { maxAsn1Bytes: 8 } }),
      ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
    } finally {
      await container.close();
    }
  });

  it('maxCertificates 低于印章证书数时从 verifySeal 重抛 CRYPTO_LIMIT_EXCEEDED', async () => {
    const base = await buildV1SignedContainer();
    try {
      const entries = await readEntriesOf(base);
      const container = wrapEntries(
        mergeEntries(
          entries,
          new Map([['Doc_0/Signs/Sign_0/Seal.esl', { bytes: buildV1Seal(1, 2) }]]),
        ),
      );
      try {
        await expect(
          verifyOfd({ container, roots: ROOTS, now: FIXED_NOW, limits: { maxCertificates: 1 } }),
        ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
      } finally {
        await container.close();
      }
    } finally {
      await base.close();
    }
  });

  it('取消信号在逐签名验证中重抛 CRYPTO_ABORTED', async () => {
    const container = await open('signed-sesv4.ofd');
    try {
      await expect(
        verifyOfd({ container, roots: ROOTS, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: 'CRYPTO_ABORTED' });
    } finally {
      await container.close();
    }
  });

  it('authenticatedAttributes 缺 contentType → integrity invalid', async () => {
    const container = await buildAuthAttrsIntegrityContainer({ omitContentType: true });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.issues.map((item) => item.code)).toContain(
        'INTEGRITY_AUTH_ATTR_INVALID',
      );
    } finally {
      await container.close();
    }
  });

  it('encapContentInfo.eContentType 非 data → integrity invalid', async () => {
    const container = await buildAuthAttrsIntegrityContainer({
      eContentTypeOid: '1.2.840.113549.1.7.2',
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.issues.some((item) => item.message.includes('eContentType'))).toBe(
        true,
      );
    } finally {
      await container.close();
    }
  });

  it('SignerInfo.digestAlgorithm=SHA-256 → integrity unsupported', async () => {
    const container = await buildAuthAttrsIntegrityContainer({
      signerDigestAlgorithm: '2.16.840.1.101.3.4.2.1',
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('unsupported');
      expect(report.integrity?.status).toBe('unsupported');
      expect(report.integrity?.issues.map((item) => item.code)).toContain(
        'INTEGRITY_DIGEST_ALGORITHM_UNSUPPORTED',
      );
    } finally {
      await container.close();
    }
  });

  it('eContent 存在时按 SM3(eContent) 校验 messageDigest', async () => {
    const valid = await buildAuthAttrsIntegrityContainer({ includeEContent: true });
    const tampered = await buildAuthAttrsIntegrityContainer({
      includeEContent: true,
      tamperDigest: true,
    });
    try {
      expect((await verifyOfd({ container: valid, roots: ROOTS, now: FIXED_NOW })).integrity?.status).toBe('valid');
      expect((await verifyOfd({ container: tampered, roots: ROOTS, now: FIXED_NOW })).integrity?.status).toBe(
        'invalid',
      );
    } finally {
      await valid.close();
      await tampered.close();
    }
  });

  it('时间戳 imprint 与签名值不一致 → warning 且状态不变', async () => {
    const entries = await readFixtureEntries('signed-sesv4.ofd');
    const path = 'Doc_0/Signs/Sign_0/SignedValue.dat';
    const original = entries.get(path)!.bytes;
    const copy = new Uint8Array(original);
    const root = parseDer(copy).requireSequence();
    const signatureRaw = root.children[3]!.raw;
    const index = findBytes(copy, signatureRaw);
    expect(index).toBeGreaterThanOrEqual(0);
    copy[index + signatureRaw.length - 1] ^= 0xff;
    entries.set(path, { bytes: copy });
    const container = wrapEntries(entries);
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.warnings.map((item) => item.code)).toContain(
        'W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH',
      );
      const signature = report.signatures[0]!;
      expect(signature.timestamp.status).toBe('parsed-not-verified');
      expect(signature.timestamp.messageImprintMatchesSignature).toBe(false);
      expect(report.overall).toBe('invalid');
    } finally {
      await container.close();
    }
  });

  it('integrity 签名算法不支持且无夹带 → overall unsupported', async () => {
    const container = await buildAuthAttrsIntegrityContainer({
      digestAlgorithmsOid: '2.16.840.1.101.3.4.2.1',
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.integrity?.status).toBe('unsupported');
      expect(report.integrity?.extraFiles).toEqual([]);
      expect(report.integrity?.missingFiles).toEqual([]);
      expect(report.overall).toBe('unsupported');
    } finally {
      await container.close();
    }
  });

  it('integrity unsupported 且合并出未登记文件 → 夹带优先判 invalid', async () => {
    const integrity = await buildAuthAttrsIntegrityContainer({
      digestAlgorithmsOid: '2.16.840.1.101.3.4.2.1',
    });
    const v1 = await buildV1SignedContainer();
    const container = wrapEntries(
      mergeEntries(await readEntriesOf(integrity), await readEntriesOf(v1)),
    );
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.integrity?.status).toBe('invalid');
      expect(report.integrity?.extraFiles.length).toBeGreaterThan(0);
      expect(report.signatures[0]?.status).toBe('valid');
      expect(report.overall).toBe('invalid');
    } finally {
      await container.close();
      await integrity.close();
      await v1.close();
    }
  });

  it('签名者证书缺 KeyUsage → 仅 warning，不阻断 valid', async () => {
    const leafKey = testKeyPair('encrypt');
    const leaf = makeCertificate(
      {
        serial: 201n,
        cn: 'OFDRW Viewer Crypto Fixtures No KeyUsage Signer',
        issuerCn: 'OFDRW Viewer Crypto Fixtures Root CA',
        isCA: false,
        keyUsage: undefined,
      },
      leafKey,
      testKeyPair('root-ca'),
    ).der;
    const container = await buildV1SignedContainer({
      signerCert: leaf,
      signerKey: leafKey.privateKey,
    });
    try {
      const report = await verifyOfd({ container, roots: ROOTS, now: FIXED_NOW });
      expect(report.overall).toBe('valid');
      expect(report.warnings.map((item) => item.code)).toContain(
        'W_CRYPTO_KEY_USAGE_MISSING',
      );
      expect(
        report.signatures[0]!.certificate.issues.map((item) => item.code),
      ).toContain('CHAIN_KEY_USAGE_MISSING');
    } finally {
      await container.close();
    }
  });

  it('完整性 SignedData 的中间证书用于签名链补链', async () => {
    const rootCert = fixtureBytes('certs', 'root-ca.crt.der');
    const keys = {
      root: testKeyPair('root-ca'),
      intermediate: testKeyPair('signer'),
      integrity: testKeyPair('seal'),
      signature: testKeyPair('encrypt'),
    };
    const rootCn = 'OFDRW Viewer Crypto Fixtures Root CA';
    const intermediateCn = 'OFDRW Viewer Crypto Fixtures Intermediate CA';
    const intermediateDer = makeCertificate(
      {
        serial: 101n,
        cn: intermediateCn,
        issuerCn: rootCn,
        isCA: true,
        keyUsage: ['digitalSignature', 'keyCertSign'],
      },
      keys.intermediate,
      keys.root,
    ).der;
    const integrityLeaf = makeCertificate(
      {
        serial: 102n,
        cn: 'OFDRW Viewer Crypto Fixtures Integrity Signer',
        issuerCn: intermediateCn,
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      keys.integrity,
      keys.intermediate,
    ).der;
    const signatureLeaf = makeCertificate(
      {
        serial: 103n,
        cn: 'OFDRW Viewer Crypto Fixtures Signature Signer',
        issuerCn: intermediateCn,
        isCA: false,
        keyUsage: ['digitalSignature', 'nonRepudiation'],
      },
      keys.signature,
      keys.intermediate,
    ).der;

    const integrity = await buildAuthAttrsIntegrityContainer({
      entries: await readFixtureEntries('combined-signed-integrity.ofd'),
      signerCert: integrityLeaf,
      signerKey: keys.integrity.privateKey,
      extraCertificates: [intermediateDer],
    });
    const v1 = await buildV1SignedContainer({
      signerCert: signatureLeaf,
      signerKey: keys.signature.privateKey,
    });
    const container = wrapEntries(
      mergeEntries(await readEntriesOf(integrity), await readEntriesOf(v1)),
    );
    try {
      const report = await verifyOfd({
        container,
        roots: [rootCert],
        now: FIXED_NOW,
      });
      expect(report.overall).toBe('valid');
      expect(report.integrity?.status).toBe('valid');
      const signature = report.signatures[0]!;
      expect(signature.status).toBe('valid');
      expect(signature.certificate.status).toBe('valid');
      expect(signature.certificate.chain).toHaveLength(3);
    } finally {
      await container.close();
      await integrity.close();
      await v1.close();
    }
  });
});

/**
 * 在字节数组中查找子数组。
 *
 * @param haystack 目标数组。
 * @param needle 子数组。
 * @returns 起始下标；不存在返回 -1。
 */
function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}
