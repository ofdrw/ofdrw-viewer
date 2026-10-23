import { describe, expect, it } from 'vitest';
import {
  c1c3c2ToSm2Cipher,
  derInteger,
  derOctetString,
  derSequence,
  encodeSm2Cipher,
  fromBase64,
  fromHex,
  parseSm2Cipher,
  sm2CipherToC1C3C2,
  sm2Decrypt,
  sm2GetPublicKey,
  toHex,
} from '@ofdrw/ofdrw-viewer-crypto';
import { JAVA_SM2 } from './fixtures';

const JAVA_DER = fromBase64(JAVA_SM2.cipherDerBase64);

describe('SM2Cipher ASN.1', () => {
  it('解析 Java PoC 密文并可解出明文', () => {
    const cipher = parseSm2Cipher(JAVA_DER);
    expect(cipher.x).toHaveLength(32);
    expect(cipher.y).toHaveLength(32);
    expect(cipher.c3).toHaveLength(32);
    expect(cipher.c2).toHaveLength(16);
    const c1c3c2 = sm2CipherToC1C3C2(cipher);
    expect(c1c3c2[0]).toBe(0x04);
    expect(sm2Decrypt(c1c3c2, JAVA_SM2.privateKey, { c1Prefix: 'present' })).toEqual(
      fromHex(JAVA_SM2.plaintext),
    );
  });

  it('重新编码与原 DER 完全一致', () => {
    const cipher = parseSm2Cipher(JAVA_DER);
    expect(toHex(encodeSm2Cipher(cipher))).toBe(toHex(JAVA_DER));
  });

  it('C1C3C2 带/不带前缀均可解析', () => {
    const cipher = parseSm2Cipher(JAVA_DER);
    const withPrefix = sm2CipherToC1C3C2(cipher);
    const withoutPrefix = withPrefix.subarray(1);
    expect(toHex(c1c3c2ToSm2Cipher(withPrefix).x)).toBe(toHex(cipher.x));
    expect(toHex(c1c3c2ToSm2Cipher(withoutPrefix).x)).toBe(toHex(cipher.x));
    expect(toHex(c1c3c2ToSm2Cipher(withoutPrefix).c2)).toBe(toHex(cipher.c2));
  });

  it('无前缀 C1C3C2 的 X 首字节为 04 时仍按结构识别', () => {
    let point: Uint8Array | undefined;
    for (let scalar = 1n; scalar < 10_000n; scalar += 1n) {
      const candidate = sm2GetPublicKey(scalar.toString(16).padStart(64, '0'));
      if (candidate[1] === 0x04) {
        point = candidate;
        break;
      }
    }
    expect(point).toBeDefined();
    const publicKey = point as Uint8Array;
    const body = new Uint8Array(98);
    body.set(publicKey.subarray(1, 65), 0);
    body.fill(0x11, 64, 96);
    body.set([0x7f, 0x80], 96);

    const cipher = c1c3c2ToSm2Cipher(body);
    expect(toHex(cipher.x)).toBe(toHex(publicKey.subarray(1, 33)));
    expect(toHex(cipher.y)).toBe(toHex(publicKey.subarray(33, 65)));
    expect(toHex(cipher.c3)).toBe('11'.repeat(32));
    expect(cipher.c2).toEqual(Uint8Array.of(0x7f, 0x80));
    expect(toHex(c1c3c2ToSm2Cipher(body, { c1Prefix: 'absent' }).x)).toBe(toHex(cipher.x));
  });

  it('显式前缀声明与空 C2 边界', () => {
    const cipher = parseSm2Cipher(JAVA_DER);
    const withPrefix = sm2CipherToC1C3C2(cipher);
    expect(toHex(c1c3c2ToSm2Cipher(withPrefix, { c1Prefix: 'present' }).x)).toBe(
      toHex(cipher.x),
    );
    expect(() => c1c3c2ToSm2Cipher(withPrefix, { c1Prefix: 'absent' })).toThrowError(/曲线/);
    expect(() => c1c3c2ToSm2Cipher(new Uint8Array(96))).toThrowError(/C2 为空|长度不足/);
    expect(() =>
      c1c3c2ToSm2Cipher(new Uint8Array(97).fill(0x04), { c1Prefix: 'absent' }),
    ).toThrowError(/曲线/);
  });

  it('拒绝结构/长度/曲线非法', () => {
    expect(() => parseSm2Cipher(fromHex('3000'))).toThrowError(/四个字段/);
    expect(() => parseSm2Cipher(new Uint8Array(0))).toThrowError(/为空/);
    expect(() => c1c3c2ToSm2Cipher(new Uint8Array(10))).toThrowError(/长度不足/);
    expect(() => c1c3c2ToSm2Cipher('x' as unknown as Uint8Array)).toThrowError(/Uint8Array/);
    expect(() =>
      encodeSm2Cipher({ ...parseSm2Cipher(JAVA_DER), c3: new Uint8Array(31) }),
    ).toThrowError(/32 byte/);
    expect(() =>
      encodeSm2Cipher({ ...parseSm2Cipher(JAVA_DER), c2: new Uint8Array(0) }),
    ).toThrowError(/不能为空/);
  });

  it('拒绝不在曲线上的点、负数与非最小整数', () => {
    expect(() => c1c3c2ToSm2Cipher(new Uint8Array(1 + 64 + 32 + 1))).toThrowError(/曲线/);

    const cipher = parseSm2Cipher(JAVA_DER);
    const negativeX = derSequence(
      Uint8Array.of(0x02, 0x01, 0x80),
      derInteger(cipher.y),
      derOctetString(cipher.c3),
      derOctetString(cipher.c2),
    );
    expect(() => parseSm2Cipher(negativeX)).toThrowError(/非负/);

    const nonMinimalX = derSequence(
      Uint8Array.of(0x02, 0x21, 0x00, ...new Uint8Array(32).fill(1)),
      derInteger(cipher.y),
      derOctetString(cipher.c3),
      derOctetString(cipher.c2),
    );
    expect(() => parseSm2Cipher(nonMinimalX)).toThrowError(/前导零/);
  });
});