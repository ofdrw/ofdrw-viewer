import { describe, expect, it } from 'vitest';
import {
  OID_PBES2,
  OID_SM2_CURVE,
  derBitString,
  derContext,
  derInteger,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  parseCertificate,
  parseSm2PrivateKey,
  toBase64,
  toHex,
  type CryptoWarning,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureBytes, fixtureText } from './fixtures';

const PKCS8_PEM = fixtureText('certs', 'signer.key.pem');
const PKCS8_DER = fixtureBytes('certs', 'signer.key.der');

/**
 * 将 PKCS#8 私钥转换为 SEC1 PEM（`EC PRIVATE KEY`）。
 *
 * @param withPublicKey 是否内嵌公钥。
 * @param curveOid 曲线 OID。
 * @param publicKey 覆盖内嵌公钥。
 * @returns SEC1 PEM 文本。
 */
function toSec1Pem(options: {
  withPublicKey?: boolean;
  curveOid?: string;
  publicKey?: Uint8Array;
} = {}): string {
  const parsed = parseSm2PrivateKey({ pem: PKCS8_PEM });
  const publicKey = options.publicKey ?? parsed.publicKey;
  const parts = [
    derInteger(1n),
    derOctetString(parsed.privateKey),
    derContext(0, derOid(options.curveOid ?? OID_SM2_CURVE)),
  ];
  if (options.withPublicKey !== false) {
    parts.push(
      derContext(1, new Uint8Array([0, ...publicKey]), false),
    );
  }
  const der = derSequence(...parts);
  return [
    '-----BEGIN EC PRIVATE KEY-----',
    toBase64(der),
    '-----END EC PRIVATE KEY-----',
  ].join('\n');
}

/**
 * 捕获同步异常码。
 *
 * @param run 待执行函数。
 * @returns 错误码；未抛错时返回 undefined。
 */
function syncErrorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : undefined;
  }
}

describe('SM2 私钥解析', () => {
  it('解析 PKCS#8 PEM/DER 并派生公钥', () => {
    const certificate = parseCertificate(fixtureBytes('certs', 'signer.crt.der'));
    const fromPem = parseSm2PrivateKey({ pem: PKCS8_PEM });
    const fromDer = parseSm2PrivateKey({ der: PKCS8_DER });
    expect(fromPem.format).toBe('pkcs8');
    expect(toHex(fromPem.publicKey)).toBe(toHex(certificate.publicKey));
    expect(toHex(fromDer.privateKey)).toBe(toHex(fromPem.privateKey));
    expect(toHex(fromDer.publicKey)).toBe(toHex(fromPem.publicKey));
  });

  it('解析 SEC1 PEM（含内嵌公钥）', () => {
    const parsed = parseSm2PrivateKey({ pem: toSec1Pem() });
    const reference = parseSm2PrivateKey({ der: PKCS8_DER });
    expect(parsed.format).toBe('sec1');
    expect(toHex(parsed.privateKey)).toBe(toHex(reference.privateKey));
    expect(toHex(parsed.publicKey)).toBe(toHex(reference.publicKey));
    expect(parsed.embeddedPublicKey).toBeDefined();
  });

  it('SEC1 无内嵌公钥也可解析', () => {
    const parsed = parseSm2PrivateKey({ pem: toSec1Pem({ withPublicKey: false }) });
    expect(toHex(parsed.publicKey)).toBe(toHex(parseSm2PrivateKey({ der: PKCS8_DER }).publicKey));
  });

  it('拒绝非 SM2 曲线与不一致的内嵌公钥', () => {
    expect(() =>
      parseSm2PrivateKey({ pem: toSec1Pem({ curveOid: '1.2.840.10045.3.1.7' }) }),
    ).toThrowError(/sm2p256v1/);
    const other = parseCertificate(fixtureBytes('certs', 'encrypt.crt.der'));
    expect(() =>
      parseSm2PrivateKey({ pem: toSec1Pem({ publicKey: other.publicKey }) }),
    ).toThrowError(/不匹配/);
  });

  it('加密 PKCS#8：缺少口令与不支持算法', () => {
    const encryptedInfo = derSequence(
      derSequence(derOid(OID_PBES2), derNull()),
      derOctetString(new Uint8Array(48)),
    );
    const pem = [
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      toBase64(encryptedInfo),
      '-----END ENCRYPTED PRIVATE KEY-----',
    ].join('\n');
    expect(() => parseSm2PrivateKey({ pem })).toThrowError(/口令/);
    expect(() => parseSm2PrivateKey({ pem, passphrase: '' })).toThrowError(/口令/);
    expect(() => parseSm2PrivateKey({ pem, passphrase: 'secret' })).toThrowError(/不支持/);
    expect(() => parseSm2PrivateKey({ der: encryptedInfo })).toThrowError(/口令/);
  });

  it('未加密私钥传 passphrase 时 warning，不静默忽略', () => {
    const warnings: CryptoWarning[] = [];
    parseSm2PrivateKey(
      { pem: PKCS8_PEM, passphrase: 'ignored' },
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('W_CRYPTO_CREDENTIAL_IGNORED');

    const noWarnings: CryptoWarning[] = [];
    parseSm2PrivateKey({ pem: PKCS8_PEM }, { onWarning: (warning) => noWarnings.push(warning) });
    expect(noWarnings).toEqual([]);
  });

  it('EncryptedPrivateKeyInfo 非 PBES2 算法映射 UNSUPPORTED_ENCRYPTION', () => {
    for (const oid of ['1.2.840.113549.1.5.3', '1.2.3.4']) {
      const encryptedInfo = derSequence(
        derSequence(derOid(oid), derNull()),
        derOctetString(new Uint8Array(48)),
      );
      expect(syncErrorCode(() => parseSm2PrivateKey({ der: encryptedInfo }))).toBe(
        'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
      );
      expect(
        syncErrorCode(() => parseSm2PrivateKey({ der: encryptedInfo, passphrase: 'secret' })),
      ).toBe('CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION');
    }
  });

  it('拒绝来源缺失/重复、非法 DER 与截断 PEM', () => {
    expect(() => parseSm2PrivateKey({} as never)).toThrowError(/pem 或 der/);
    expect(() => parseSm2PrivateKey({ pem: PKCS8_PEM, der: PKCS8_DER })).toThrowError(
      /pem 或 der/,
    );
    expect(() => parseSm2PrivateKey({ der: new Uint8Array(0) })).toThrowError(/DER/);
    expect(() => parseSm2PrivateKey({ der: fixtureBytes('certs', 'signer.crt.der') })).toThrowError(
      /私钥/,
    );
    expect(() => parseSm2PrivateKey({ pem: PKCS8_PEM.slice(0, -20) })).toThrowError(/PEM/);
    expect(() => parseSm2PrivateKey({ pem: PKCS8_PEM }, { maxBytes: 10 })).toThrowError(
      /超过上限/,
    );
  });

  it('拒绝零标量', () => {
    const der = derSequence(
      derInteger(1n),
      derOctetString(new Uint8Array(32)),
      derContext(0, derOid(OID_SM2_CURVE)),
    );
    const pem = `-----BEGIN EC PRIVATE KEY-----\n${toBase64(der)}\n-----END EC PRIVATE KEY-----`;
    expect(() => parseSm2PrivateKey({ pem })).toThrowError(/标量/);
  });

  it('BIT STRING 公钥编码与 PKCS#8 一致', () => {
    // 确保 derBitString 的未使用位为 0 时编码稳定（供后续 SEC1 测试复用）。
    expect(toHex(derBitString(Uint8Array.of(1, 2)))).toBe('0303000102');
  });
});