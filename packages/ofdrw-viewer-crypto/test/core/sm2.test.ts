import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SM2_USER_ID,
  fromHex,
  isValidSm2PublicKey,
  parseCertificate,
  parseSm2PrivateKey,
  sm2Decrypt,
  sm2Encrypt,
  sm2GetPublicKey,
  sm2Sign,
  sm2Verify,
  toHex,
} from '@ofdrw/ofdrw-viewer-crypto';
import { JAVA_SM2, fixtureBytes, fixtureText } from './fixtures';

const JAVA_MESSAGE = fromHex(JAVA_SM2.message);
const JAVA_PUBLIC_KEY = fromHex(JAVA_SM2.publicKey);
const JAVA_SIGNATURE = fromHex(JAVA_SM2.signature);

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

describe('SM2 签名/验签', () => {
  it('验证 Java/BouncyCastle 生成的签名（默认 userId）', () => {
    expect(sm2Verify(JAVA_MESSAGE, JAVA_SIGNATURE, JAVA_PUBLIC_KEY)).toBe(true);
    expect(sm2Verify(JAVA_MESSAGE, JAVA_SIGNATURE, JAVA_SM2.publicKey)).toBe(true);
  });

  it('默认 userId 为 1234567812345678', () => {
    expect(DEFAULT_SM2_USER_ID).toBe('1234567812345678');
    const signature = sm2Sign(JAVA_MESSAGE, JAVA_SM2.privateKey, {
      userId: DEFAULT_SM2_USER_ID,
    });
    expect(sm2Verify(JAVA_MESSAGE, signature, JAVA_PUBLIC_KEY)).toBe(true);
    expect(
      sm2Verify(JAVA_MESSAGE, signature, JAVA_PUBLIC_KEY, { userId: DEFAULT_SM2_USER_ID }),
    ).toBe(true);
  });

  it('签名结果可被自身验证，篡改后失败', () => {
    const signature = sm2Sign(JAVA_MESSAGE, JAVA_SM2.privateKey);
    expect(sm2Verify(JAVA_MESSAGE, signature, JAVA_PUBLIC_KEY)).toBe(true);

    const tamperedMessage = JAVA_MESSAGE.slice();
    tamperedMessage[0] ^= 0x01;
    expect(sm2Verify(tamperedMessage, signature, JAVA_PUBLIC_KEY)).toBe(false);

    const tamperedSignature = signature.slice();
    tamperedSignature[tamperedSignature.length - 1] ^= 0x01;
    expect(sm2Verify(JAVA_MESSAGE, tamperedSignature, JAVA_PUBLIC_KEY)).toBe(false);
  });

  it('userId 不一致导致验签失败', () => {
    expect(sm2Verify(JAVA_MESSAGE, JAVA_SIGNATURE, JAVA_PUBLIC_KEY, { userId: 'other' })).toBe(
      false,
    );
    const signature = sm2Sign(JAVA_MESSAGE, JAVA_SM2.privateKey, { userId: 'ofdrw-user' });
    expect(sm2Verify(JAVA_MESSAGE, signature, JAVA_PUBLIC_KEY, { userId: 'ofdrw-user' })).toBe(
      true,
    );
  });

  it('非法签名格式返回 false，非法公钥/入参抛错', () => {
    expect(sm2Verify(JAVA_MESSAGE, new Uint8Array(0), JAVA_PUBLIC_KEY)).toBe(false);
    expect(sm2Verify(JAVA_MESSAGE, Uint8Array.of(0x30, 0x00), JAVA_PUBLIC_KEY)).toBe(false);
    expect(() => sm2Verify('x' as unknown as Uint8Array, JAVA_SIGNATURE, JAVA_PUBLIC_KEY)).toThrowError(
      /Uint8Array/,
    );
    expect(() => sm2Verify(JAVA_MESSAGE, JAVA_SIGNATURE, 'zz')).toThrowError(/十六进制|公钥/);
  });

  it('私钥派生公钥与 Java 向量一致', () => {
    const publicKey = sm2GetPublicKey(JAVA_SM2.privateKey);
    expect(toHex(publicKey)).toBe(JAVA_SM2.publicKey);
    expect(isValidSm2PublicKey(publicKey)).toBe(true);
    expect(isValidSm2PublicKey(Uint8Array.of(4, 1, 2))).toBe(false);
  });

  it('与证书公钥互通（fixtures signer）', () => {
    const certificate = parseCertificate(fixtureBytes('certs', 'signer.crt.der'));
    const privateKey = parseSm2PrivateKey({ pem: fixtureText('certs', 'signer.key.pem') });
    expect(toHex(privateKey.publicKey)).toBe(toHex(certificate.publicKey));
    const message = new TextEncoder().encode('OFD 签章原文');
    const signature = sm2Sign(message, privateKey.privateKey);
    expect(sm2Verify(message, signature, certificate.publicKey)).toBe(true);
  });
});

describe('SM2 加解密', () => {
  it('解密 Java 生成的 C1C3C2 密文', () => {
    const ciphertext = sm2Encrypt(fromHex(JAVA_SM2.plaintext), JAVA_PUBLIC_KEY);
    expect(sm2Decrypt(ciphertext, JAVA_SM2.privateKey)).toEqual(fromHex(JAVA_SM2.plaintext));
  });

  it('支持 04 前缀 present/absent/auto', () => {
    const plaintext = fromHex(JAVA_SM2.plaintext);
    const withoutPrefix = sm2Encrypt(plaintext, JAVA_PUBLIC_KEY);
    expect(toHex(withoutPrefix.subarray(0, 1))).not.toBe('04');
    const withPrefix = new Uint8Array(withoutPrefix.length + 1);
    withPrefix[0] = 0x04;
    withPrefix.set(withoutPrefix, 1);

    expect(sm2Decrypt(withoutPrefix, JAVA_SM2.privateKey, { c1Prefix: 'absent' })).toEqual(
      plaintext,
    );
    expect(sm2Decrypt(withPrefix, JAVA_SM2.privateKey, { c1Prefix: 'present' })).toEqual(
      plaintext,
    );
    expect(sm2Decrypt(withPrefix, JAVA_SM2.privateKey)).toEqual(plaintext);
    expect(sm2Decrypt(withoutPrefix, JAVA_SM2.privateKey)).toEqual(plaintext);
    expect(() => sm2Decrypt(withoutPrefix, JAVA_SM2.privateKey, { c1Prefix: 'present' })).toThrowError(
      /04 前缀/,
    );
  });

  it('私钥不匹配抛 CRYPTO_DECRYPT_FAILED', () => {
    const ciphertext = sm2Encrypt(fromHex(JAVA_SM2.plaintext), JAVA_PUBLIC_KEY);
    const otherKey = '01'.padStart(64, '0');
    expect(() => sm2Decrypt(ciphertext, otherKey)).toThrowError(/解密失败/);
  });

  it('非法密文/私钥/明文抛 CRYPTO_INVALID_ARGUMENT', () => {
    expect(() => sm2Encrypt('x' as unknown as Uint8Array, JAVA_PUBLIC_KEY)).toThrowError(
      /Uint8Array/,
    );
    expect(() => sm2Encrypt(Uint8Array.of(1), 'zz')).toThrowError(/十六进制|公钥/);
    expect(() => sm2Decrypt(Uint8Array.of(1, 2), JAVA_SM2.privateKey)).toThrowError(
      /解密失败/,
    );
    expect(() => sm2Decrypt(new Uint8Array(0), '00'.padStart(64, '0'))).toThrowError();
    expect(syncErrorCode(() => sm2Encrypt(new Uint8Array(0), JAVA_PUBLIC_KEY))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });
});