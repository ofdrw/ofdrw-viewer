/**
 * V-CORE 独立验证：SM2 签名/验签、SM2Cipher ASN.1 与加解密。
 *
 * 交叉来源：OpenSSL 3 `genpkey`/`pkeyutl`。注意 OpenSSL `pkeyutl` 未显式
 * `distid` 时使用空 ID，而 GB/T 32918 与本包默认 ID 为 `1234567812345678`，
 * 因此所有默认 ID 互操作命令都显式传 `-pkeyopt distid:1234567812345678`。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SM2_USER_ID,
  c1c3c2ToSm2Cipher,
  derInteger,
  derOctetString,
  derSequence,
  encodeSm2Cipher,
  isValidSm2PublicKey,
  parseSm2Cipher,
  parseSm2PrivateKey,
  sm2CipherToC1C3C2,
  sm2Decrypt,
  sm2Encrypt,
  sm2GetPublicKey,
  sm2Sign,
  sm2Verify,
  toHex,
  type Sm2PrivateKey,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  OPENSSL_AVAILABLE,
  bytesToHex,
  hexToBytes,
  makeTempDir,
  opensslBytes,
  opensslStatus,
  opensslText,
  removeTempDir,
  syncErrorCode,
  utf8,
  writeTemp,
  fixtureText,
} from './support';

/** 测试消息（含中文）。 */
const MESSAGE = utf8('OFD V-CORE SM2 OpenSSL 互操作消息');
/** 自定义 userId。 */
const CUSTOM_USER_ID = 'ofdrw-user-vcore';

/** OpenSSL 生成的测试密钥环境。 */
interface KeyEnv {
  readonly dir: string;
  readonly keyPem: string;
  readonly publicPem: string;
  readonly publicDer: Uint8Array;
  readonly privateKey: Sm2PrivateKey;
}

let keyEnv: KeyEnv | undefined;

beforeAll(() => {
  if (!OPENSSL_AVAILABLE) return;
  const dir = makeTempDir('ofdrw-crypto-sm2-');
  const keyPath = join(dir, 'sm2-key.pem');
  const publicPath = join(dir, 'sm2-public.pem');
  opensslText(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:sm2', '-out', keyPath]);
  opensslText(['pkey', '-in', keyPath, '-pubout', '-out', publicPath]);
  const keyPem = readFileSync(keyPath, 'utf8');
  const publicPem = readFileSync(publicPath, 'utf8');
  const publicDer = opensslBytes(['pkey', '-pubin', '-outform', 'DER'], utf8(publicPem));
  keyEnv = {
    dir,
    keyPem,
    publicPem,
    publicDer,
    privateKey: parseSm2PrivateKey({ pem: keyPem }),
  };
});

afterAll(() => {
  if (keyEnv) removeTempDir(keyEnv.dir);
});

/**
 * 用 OpenSSL 生成 SM2 签名。
 *
 * @param env 密钥环境。
 * @param message 消息。
 * @param userId 可选 userId；省略时不传 distid（OpenSSL 空 ID）。
 * @returns DER 签名。
 */
function opensslSign(env: KeyEnv, message: Uint8Array, userId?: string): Uint8Array {
  return opensslBytes(
    [
      'pkeyutl',
      '-sign',
      '-inkey',
      join(env.dir, 'sm2-key.pem'),
      '-rawin',
      '-digest',
      'sm3',
      ...(userId === undefined ? [] : ['-pkeyopt', `distid:${userId}`]),
    ],
    message,
  );
}

/**
 * 用 OpenSSL 验签。
 *
 * @param env 密钥环境。
 * @param message 消息。
 * @param signature DER 签名。
 * @param userId 可选 userId；省略时不传 distid。
 * @returns 退出码，0 表示验签成功。
 */
function opensslVerifySignature(
  env: KeyEnv,
  message: Uint8Array,
  signature: Uint8Array,
  userId?: string,
): number {
  const signaturePath = writeTemp(env.dir, `sig-${Date.now()}-${Math.random()}.der`, signature);
  return opensslStatus(
    [
      'pkeyutl',
      '-verify',
      '-pubin',
      '-inkey',
      join(env.dir, 'sm2-public.pem'),
      '-rawin',
      '-digest',
      'sm3',
      '-sigfile',
      signaturePath,
      ...(userId === undefined ? [] : ['-pkeyopt', `distid:${userId}`]),
    ],
    message,
  );
}

/**
 * 用 OpenSSL 加密。
 *
 * @param env 密钥环境。
 * @param plaintext 明文。
 * @returns SM2Cipher DER。
 */
function opensslEncrypt(env: KeyEnv, plaintext: Uint8Array): Uint8Array {
  return opensslBytes(
    [
      'pkeyutl',
      '-encrypt',
      '-pubin',
      '-inkey',
      join(env.dir, 'sm2-public.pem'),
    ],
    plaintext,
  );
}

describe('SM2 密钥与默认 userId', () => {
  it.skipIf(!OPENSSL_AVAILABLE)('OpenSSL 生成的 PKCS#8 私钥/公钥可解析且一致', () => {
    const env = keyEnv!;
    expect(env.privateKey.format).toBe('pkcs8');
    expect(env.privateKey.privateKey).toHaveLength(32);
    expect(env.privateKey.publicKey).toHaveLength(65);
    expect(env.privateKey.publicKey[0]).toBe(0x04);
    expect(bytesToHex(env.privateKey.publicKey)).toBe(bytesToHex(env.publicDer.slice(-65)));
    expect(toHex(sm2GetPublicKey(env.privateKey.privateKey))).toBe(
      bytesToHex(env.privateKey.publicKey),
    );
    expect(isValidSm2PublicKey(env.privateKey.publicKey)).toBe(true);
  });

  it('默认 userId 常量为 GB/T 标准值', () => {
    expect(DEFAULT_SM2_USER_ID).toBe('1234567812345678');
  });

  it.skipIf(!OPENSSL_AVAILABLE)('OpenSSL 签名 → 包验签（默认 userId）', () => {
    const env = keyEnv!;
    const signature = opensslSign(env, MESSAGE, DEFAULT_SM2_USER_ID);
    expect(sm2Verify(MESSAGE, signature, env.privateKey.publicKey)).toBe(true);
    expect(
      sm2Verify(MESSAGE, signature, env.privateKey.publicKey, {
        userId: DEFAULT_SM2_USER_ID,
      }),
    ).toBe(true);
    expect(
      sm2Verify(MESSAGE, signature, env.privateKey.publicKey, { userId: 'other-user' }),
    ).toBe(false);
  });

  it.skipIf(!OPENSSL_AVAILABLE)('包签名 → OpenSSL 验签（默认 userId）', () => {
    const env = keyEnv!;
    const signature = sm2Sign(MESSAGE, env.privateKey.privateKey);
    expect(sm2Verify(MESSAGE, signature, env.privateKey.publicKey)).toBe(true);
    expect(opensslVerifySignature(env, MESSAGE, signature, DEFAULT_SM2_USER_ID)).toBe(0);
    expect(opensslVerifySignature(env, MESSAGE, signature, 'other-user')).not.toBe(0);
  });

  it.skipIf(!OPENSSL_AVAILABLE)('自定义 userId 双向互操作，ID 不匹配必须失败', () => {
    const env = keyEnv!;
    const opensslSignature = opensslSign(env, MESSAGE, CUSTOM_USER_ID);
    expect(
      sm2Verify(MESSAGE, opensslSignature, env.privateKey.publicKey, {
        userId: CUSTOM_USER_ID,
      }),
    ).toBe(true);
    expect(sm2Verify(MESSAGE, opensslSignature, env.privateKey.publicKey)).toBe(false);

    const packageSignature = sm2Sign(MESSAGE, env.privateKey.privateKey, {
      userId: CUSTOM_USER_ID,
    });
    expect(opensslVerifySignature(env, MESSAGE, packageSignature, CUSTOM_USER_ID)).toBe(0);
    expect(opensslVerifySignature(env, MESSAGE, packageSignature, DEFAULT_SM2_USER_ID)).not.toBe(
      0,
    );
  });

  it.skipIf(!OPENSSL_AVAILABLE)('OpenSSL 未指定 distid 时使用空 ID，不能冒充标准默认 ID', () => {
    const env = keyEnv!;
    const emptyIdSignature = opensslSign(env, MESSAGE);
    expect(sm2Verify(MESSAGE, emptyIdSignature, env.privateKey.publicKey)).toBe(false);
    expect(
      opensslVerifySignature(env, MESSAGE, emptyIdSignature, DEFAULT_SM2_USER_ID),
    ).not.toBe(0);
  });

  it('签名可自校验；篡改消息/签名返回 false', () => {
    const { privateKey, publicKey } = parseSm2PrivateKey({
      pem: fixtureText('certs', 'signer.key.pem'),
    });
    const signature = sm2Sign(MESSAGE, privateKey);
    expect(sm2Verify(MESSAGE, signature, publicKey)).toBe(true);

    const tamperedMessage = MESSAGE.slice();
    tamperedMessage[0] ^= 0x01;
    expect(sm2Verify(tamperedMessage, signature, publicKey)).toBe(false);

    const tamperedSignature = signature.slice();
    tamperedSignature[tamperedSignature.length - 1] ^= 0x01;
    expect(sm2Verify(MESSAGE, tamperedSignature, publicKey)).toBe(false);
    expect(sm2Verify(MESSAGE, new Uint8Array(0), publicKey)).toBe(false);
    expect(sm2Verify(MESSAGE, Uint8Array.of(0x30, 0x00), publicKey)).toBe(false);
  });

  it('空消息可签名/验签，非法输入返回明确错误码', () => {
    const { privateKey, publicKey } = parseSm2PrivateKey({
      pem: fixtureText('certs', 'signer.key.pem'),
    });
    const signature = sm2Sign(new Uint8Array(0), privateKey);
    expect(sm2Verify(new Uint8Array(0), signature, publicKey)).toBe(true);
    expect(syncErrorCode(() => sm2Sign('x' as unknown as Uint8Array, privateKey))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(
      syncErrorCode(() => sm2Sign(MESSAGE, new Uint8Array(33))),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => sm2Verify('x' as unknown as Uint8Array, signature, publicKey))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(
      syncErrorCode(() => sm2Verify(MESSAGE, signature, hexToBytes('04'.padEnd(132, '0')))),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
  });

  it('私钥标量边界 0/n 与非曲线公钥被拒绝', () => {
    // 曲线阶 n（GB/T 32918.5 / sm2p256v1），独立硬编码。
    const order = hexToBytes('fffffffeffffffffffffffffffffffff7203df6b21c6052b53bbf40939d54123');
    expect(syncErrorCode(() => sm2GetPublicKey(new Uint8Array(32)))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm2GetPublicKey(toHex(order)))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm2GetPublicKey('00'.padStart(64, '0')))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(
      syncErrorCode(() => sm2Encrypt(MESSAGE, hexToBytes('04'.padEnd(130, '0')))),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
  });
});

describe('SM2 加解密与 SM2Cipher ASN.1', () => {
  it.skipIf(!OPENSSL_AVAILABLE)('OpenSSL 加密 → 包解析 ASN.1/C1C3C2 并解密', () => {
    const env = keyEnv!;
    const plaintext = utf8('SM2 加解密互操作：OpenSSL → 包');
    const der = opensslEncrypt(env, plaintext);
    const cipher = parseSm2Cipher(der);
    expect(cipher.x).toHaveLength(32);
    expect(cipher.y).toHaveLength(32);
    expect(cipher.c3).toHaveLength(32);
    expect(cipher.c2.length).toBe(plaintext.length);

    const c1c3c2 = sm2CipherToC1C3C2(cipher);
    expect(c1c3c2[0]).toBe(0x04);
    expect(sm2Decrypt(c1c3c2, env.privateKey.privateKey, { c1Prefix: 'present' })).toEqual(
      plaintext,
    );
    expect(sm2Decrypt(c1c3c2, env.privateKey.privateKey)).toEqual(plaintext);

    const reencoded = encodeSm2Cipher(cipher);
    expect(bytesToHex(reencoded)).toBe(bytesToHex(der));
    const derFile = writeTemp(env.dir, 'openssl-cipher.der', reencoded);
    const decrypted = opensslBytes([
      'pkeyutl',
      '-decrypt',
      '-inkey',
      join(env.dir, 'sm2-key.pem'),
      '-in',
      derFile,
    ]);
    expect(bytesToHex(decrypted)).toBe(bytesToHex(plaintext));
  });

  it.skipIf(!OPENSSL_AVAILABLE)('包加密 → 编码 SM2Cipher DER → OpenSSL 解密', () => {
    const env = keyEnv!;
    const plaintext = utf8('SM2 加解密互操作：包 → OpenSSL');
    const c1c3c2 = sm2Encrypt(plaintext, env.privateKey.publicKey);
    expect(c1c3c2.length).toBe(96 + plaintext.length);
    const cipher = c1c3c2ToSm2Cipher(c1c3c2);
    const der = encodeSm2Cipher(cipher);
    const derFile = writeTemp(env.dir, 'package-cipher.der', der);
    const decrypted = opensslBytes([
      'pkeyutl',
      '-decrypt',
      '-inkey',
      join(env.dir, 'sm2-key.pem'),
      '-in',
      derFile,
    ]);
    expect(bytesToHex(decrypted)).toBe(bytesToHex(plaintext));
  });

  it('C1C3C2 带/不带 04 前缀往返，且与 ASN.1 字段一致', () => {
    const publicKey = parseSm2PrivateKey({
      pem: fixtureText('certs', 'signer.key.pem'),
    });
    const plaintext = utf8('prefix roundtrip');
    const c1c3c2 = sm2Encrypt(plaintext, publicKey.publicKey);
    const cipher = c1c3c2ToSm2Cipher(c1c3c2);
    expect(bytesToHex(sm2CipherToC1C3C2(cipher))).toBe(`04${bytesToHex(c1c3c2)}`);
    expect(bytesToHex(parseSm2Cipher(encodeSm2Cipher(cipher)).x)).toBe(bytesToHex(cipher.x));
    expect(sm2Decrypt(sm2CipherToC1C3C2(cipher), publicKey.privateKey)).toEqual(plaintext);
    expect(sm2Decrypt(c1c3c2, publicKey.privateKey, { c1Prefix: 'absent' })).toEqual(plaintext);
  });

  it('错误密钥/非法密文返回明确错误码', () => {
    const signer = parseSm2PrivateKey({
      pem: fixtureText('certs', 'signer.key.pem'),
    });
    const otherKey = parseSm2PrivateKey({
      pem: fixtureText('certs', 'seal.key.pem'),
    });
    const ciphertext = sm2Encrypt(utf8('wrong key'), signer.publicKey);
    expect(syncErrorCode(() => sm2Decrypt(ciphertext, otherKey.privateKey))).toBe(
      'CRYPTO_DECRYPT_FAILED',
    );
    expect(syncErrorCode(() => sm2Decrypt(new Uint8Array(0), signer.privateKey))).toBe(
      'CRYPTO_DECRYPT_FAILED',
    );
    expect(syncErrorCode(() => sm2Decrypt(new Uint8Array(95), signer.privateKey))).toBe(
      'CRYPTO_DECRYPT_FAILED',
    );
    expect(
      syncErrorCode(() => sm2Decrypt(ciphertext, signer.privateKey, { c1Prefix: 'present' })),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => sm2Encrypt('x' as unknown as Uint8Array, signer.publicKey))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm2Encrypt(utf8('x'), 'zz'))).toBe('CRYPTO_INVALID_ARGUMENT');
  });

  it('SM2Cipher DER/C1C3C2 基础结构非法时拒绝且不崩溃', () => {
    expect(syncErrorCode(() => parseSm2Cipher(new Uint8Array(0)))).toBe('CRYPTO_ASN1_INVALID');
    expect(syncErrorCode(() => parseSm2Cipher(Uint8Array.of(0x30, 0x00)))).toBe(
      'CRYPTO_ASN1_INVALID',
    );
    expect(syncErrorCode(() => parseSm2Cipher(hexToBytes('3003020100')))).toBe(
      'CRYPTO_ASN1_INVALID',
    );
    expect(syncErrorCode(() => c1c3c2ToSm2Cipher(new Uint8Array(10)))).toBe(
      'CRYPTO_ASN1_INVALID',
    );
    expect(
      syncErrorCode(() => c1c3c2ToSm2Cipher(new Uint8Array(1 + 64 + 32 + 1))),
    ).toBe('CRYPTO_ASN1_INVALID');
    expect(
      syncErrorCode(() =>
        c1c3c2ToSm2Cipher(
          Uint8Array.from([0x04, ...new Uint8Array(64), ...new Uint8Array(32), 1]),
        ),
      ),
    ).toBe('CRYPTO_ASN1_INVALID');
  });

  it.skipIf(!OPENSSL_AVAILABLE)('以 OpenSSL 密文为基准的字段/曲线非法时拒绝', () => {
    const env = keyEnv!;
    const der = opensslEncrypt(env, utf8('asn1 bounds'));
    const cipher = parseSm2Cipher(der);

    const badC3 = derSequence(
      derInteger(cipher.x),
      derInteger(cipher.y),
      derOctetString(new Uint8Array(31)),
      derOctetString(cipher.c2),
    );
    expect(syncErrorCode(() => parseSm2Cipher(badC3))).toBe('CRYPTO_ASN1_INVALID');

    const emptyC2 = derSequence(
      derInteger(cipher.x),
      derInteger(cipher.y),
      derOctetString(cipher.c3),
      derOctetString(new Uint8Array(0)),
    );
    expect(syncErrorCode(() => parseSm2Cipher(emptyC2))).toBe('CRYPTO_ASN1_INVALID');

    const negativeX = derSequence(
      Uint8Array.of(0x02, 0x01, 0x80),
      derInteger(cipher.y),
      derOctetString(cipher.c3),
      derOctetString(cipher.c2),
    );
    expect(syncErrorCode(() => parseSm2Cipher(negativeX))).toBe('CRYPTO_ASN1_INVALID');

    const zeroX = derSequence(
      derInteger(new Uint8Array(32)),
      derInteger(cipher.y),
      derOctetString(cipher.c3),
      derOctetString(cipher.c2),
    );
    expect(syncErrorCode(() => parseSm2Cipher(zeroX))).toBe('CRYPTO_ASN1_INVALID');

    const nonMinimalX = derSequence(
      Uint8Array.of(0x02, 0x21, 0x00, ...new Uint8Array(32).fill(1)),
      derInteger(cipher.y),
      derOctetString(cipher.c3),
      derOctetString(cipher.c2),
    );
    expect(syncErrorCode(() => parseSm2Cipher(nonMinimalX))).toBe('CRYPTO_ASN1_INVALID');

    expect(
      syncErrorCode(() => encodeSm2Cipher({ ...cipher, c3: new Uint8Array(31) })),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => encodeSm2Cipher({ ...cipher, c2: new Uint8Array(0) }))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });

  it('自定义 C1C3C2 手工构造可被 ASN.1 解码并校验曲线', () => {
    const env = keyEnv;
    if (!env) return;
    const der = opensslEncrypt(env, utf8('manual'));
    const cipher = parseSm2Cipher(der);
    const manual = c1c3c2ToSm2Cipher(
      new Uint8Array([
        0x04,
        ...cipher.x,
        ...cipher.y,
        ...cipher.c3,
        ...cipher.c2,
      ]),
    );
    expect(bytesToHex(manual.x)).toBe(bytesToHex(cipher.x));
    expect(bytesToHex(manual.y)).toBe(bytesToHex(cipher.y));
    expect(bytesToHex(manual.c3)).toBe(bytesToHex(cipher.c3));
    expect(bytesToHex(manual.c2)).toBe(bytesToHex(cipher.c2));
  });

  it('非法公钥长度/前缀与私钥字符串被拒绝', () => {
    expect(syncErrorCode(() => sm2Encrypt(utf8('x'), hexToBytes('04'.padEnd(128, '0'))))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm2Encrypt(utf8('x'), hexToBytes('03'.padEnd(130, '0'))))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm2Encrypt(utf8('x'), ''))).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => sm2Decrypt(hexToBytes('00'.repeat(98)), ''))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });
});