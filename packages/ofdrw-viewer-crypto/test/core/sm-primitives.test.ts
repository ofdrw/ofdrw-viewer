import { describe, expect, it } from 'vitest';
import {
  derivePasswordKey,
  fromHex,
  kdfSm3,
  sm3Digest,
  sm3Hex,
  sm3OfText,
  sm4DecryptCbc,
  sm4EncryptCbc,
  toHex,
  utf8Encode,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  KDF_DERIVED_HEX,
  KDF_PASSWORD_HEX,
  SM3_ABC,
  SM3_EMPTY,
  SM4_BLOCK_CIPHER,
  SM4_BLOCK_KEY,
  SM4_CBC_CIPHER,
  SM4_CBC_IV,
  SM4_CBC_PLAIN,
} from './fixtures';

const ZERO_IV = new Uint8Array(16);

describe('SM3', () => {
  it('匹配标准向量', () => {
    expect(sm3Hex(utf8Encode('abc'))).toBe(SM3_ABC);
    expect(sm3Hex(new Uint8Array(0))).toBe(SM3_EMPTY);
    expect(toHex(sm3Digest(utf8Encode('abc')))).toBe(SM3_ABC);
  });

  it('sm3OfText 与字节输入等价，支持中文', () => {
    expect(toHex(sm3OfText('OFD 加密文档'))).toBe(sm3Hex(utf8Encode('OFD 加密文档')));
    expect(sm3Digest(utf8Encode('abc'))).toHaveLength(32);
  });

  it('拒绝非字节输入', () => {
    expect(() => sm3Digest('abc' as unknown as Uint8Array)).toThrowError(/Uint8Array/);
  });
});

describe('SM4-CBC', () => {
  it('单分组结果匹配 GB/T 32907 标准向量', () => {
    const key = fromHex(SM4_BLOCK_KEY);
    const cipher = sm4EncryptCbc(key, key, ZERO_IV, { padding: 'none' });
    expect(toHex(cipher)).toBe(SM4_BLOCK_CIPHER);
    expect(toHex(sm4DecryptCbc(cipher, key, ZERO_IV, { padding: 'none' }))).toBe(SM4_BLOCK_KEY);
  });

  it('PKCS#7 往返并匹配 Java PoC 密文', () => {
    const key = fromHex(SM4_BLOCK_KEY);
    const iv = fromHex(SM4_CBC_IV);
    const plaintext = fromHex(SM4_CBC_PLAIN);
    const cipher = sm4EncryptCbc(plaintext, key, iv);
    expect(toHex(cipher)).toBe(SM4_CBC_CIPHER);
    expect(toHex(sm4DecryptCbc(cipher, key, iv))).toBe(SM4_CBC_PLAIN);
  });

  it('覆盖空明文与非整块长度', () => {
    const key = fromHex(SM4_BLOCK_KEY);
    for (const length of [0, 1, 15, 16, 17, 31, 32]) {
      const plaintext = Uint8Array.from({ length }, (_, index) => index & 0xff);
      const cipher = sm4EncryptCbc(plaintext, key, ZERO_IV);
      expect(cipher.length % 16).toBe(0);
      expect(sm4DecryptCbc(cipher, key, ZERO_IV)).toEqual(plaintext);
    }
  });

  it('拒绝非法长度、非法填充与非法密钥', () => {
    const key = fromHex(SM4_BLOCK_KEY);
    const cipher = sm4EncryptCbc(utf8Encode('padding'), key, ZERO_IV);
    expect(() => sm4DecryptCbc(cipher.subarray(0, 15), key, ZERO_IV)).toThrowError(
      /16 的倍数/,
    );
    const tampered = cipher.slice();
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => sm4DecryptCbc(tampered, key, ZERO_IV)).toThrowError(/PKCS#7/);
    expect(() => sm4EncryptCbc(Uint8Array.of(1), key.subarray(1), ZERO_IV)).toThrowError(
      /16 byte/,
    );
    expect(() => sm4EncryptCbc(Uint8Array.of(1), key, new Uint8Array(12))).toThrowError(
      /IV/,
    );
    expect(() => sm4EncryptCbc(Uint8Array.of(1), key, ZERO_IV, { padding: 'none' })).toThrowError(
      /16 的倍数/,
    );
  });
});

describe('KDF (GB/T 32918.3)', () => {
  it('复现 Java PoC 派生结果', () => {
    const derived = kdfSm3(fromHex(KDF_PASSWORD_HEX), 16);
    expect(toHex(derived)).toBe(KDF_DERIVED_HEX);
    expect(toHex(derivePasswordKey('PocPass123'))).toBe(KDF_DERIVED_HEX);
  });

  it('多分块长度按 Ha1||Ha2 截断', () => {
    const z = fromHex(KDF_PASSWORD_HEX);
    const ha1 = sm3Digest(Uint8Array.of(...z, 0x00, 0x00, 0x00, 0x01));
    const ha2 = sm3Digest(Uint8Array.of(...z, 0x00, 0x00, 0x00, 0x02));
    const key48 = kdfSm3(z, 48);
    expect(toHex(key48.subarray(0, 32))).toBe(toHex(ha1));
    expect(toHex(key48.subarray(32))).toBe(toHex(ha2.subarray(0, 16)));
  });

  it('拒绝空口令与非法 klen', () => {
    expect(() => derivePasswordKey('')).toThrowError(/口令/);
    expect(() => kdfSm3(new Uint8Array(0), 0)).toThrowError(/klen/);
    expect(() => kdfSm3(new Uint8Array(0), 4097)).toThrowError(/klen/);
    expect(() => kdfSm3('x' as unknown as Uint8Array, 16)).toThrowError(/Uint8Array/);
  });
});