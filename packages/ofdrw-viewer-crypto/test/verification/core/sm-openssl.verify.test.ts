/**
 * V-CORE 独立验证：SM3 / SM4-CBC / KDF。
 *
 * 期望值来源：
 * - GB/T 32905（SM3）与 GB/T 32907（SM4）标准向量；
 * - OpenSSL 3 的 `dgst -sm3` / `enc -sm4-cbc`（固定 key/IV，实时复算）；
 * - ofdrw 2.4.0 Java PoC 的 KDF 派生结果（PoC 脚本已随 `scripts/` 移除）。
 */

import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  derivePasswordKey,
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
  OPENSSL_AVAILABLE,
  bytesToHex,
  concatBytes,
  hexToBytes,
  opensslBytes,
  syncErrorCode,
  utf8,
} from './support';

/** SM3 标准向量（GB/T 32905 示例与 100 万字节 'a' 附录向量）。 */
const SM3_VECTORS: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array; readonly hex: string }> = [
  {
    name: '空串',
    bytes: new Uint8Array(0),
    hex: '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b',
  },
  {
    name: '"abc"',
    bytes: utf8('abc'),
    hex: '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
  },
  {
    name: '"abcd" × 16',
    bytes: utf8('abcd'.repeat(16)),
    hex: 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732',
  },
  {
    name: '100 万字节 "a"',
    bytes: new Uint8Array(1_000_000).fill(0x61),
    hex: 'c8aaf89429554029e231941a2acc0ad61ff2a5acd8fadd25847a3a732b3b02c3',
  },
];

/** SM4 标准单分组 key（GB/T 32907 示例）。 */
const SM4_KEY = hexToBytes('0123456789abcdeffedcba9876543210');
/** SM4 标准单分组密文。 */
const SM4_CIPHER = '681edf34d206965e86b3e94f536e4246';

/** OpenSSL SM4-CBC 使用的 IV。 */
const SM4_IV = hexToBytes('0f0e0d0c0b0a09080706050403020100');

/** KDF 测试口令（UTF-8 "PocPass123"）。 */
const KDF_PASSWORD = 'PocPass123';
/** ofdrw Java PoC 的 KDF 派生结果。 */
const KDF_JAVA_DERIVED = 'b5d32da4c15e9b9dcc960d91d9c69e6c';

/**
 * 用 OpenSSL 计算 SM3。
 *
 * @param data 输入字节。
 * @returns 32 byte 摘要。
 */
function opensslSm3(data: Uint8Array): Uint8Array {
  return opensslBytes(['dgst', '-sm3', '-binary'], data);
}

/**
 * 按 GB/T 32918.3 用 OpenSSL SM3 独立构造 KDF 输出。
 *
 * @param z 共享秘密。
 * @param klen 期望长度，单位 byte。
 * @returns 派生密钥。
 */
function opensslKdf(z: Uint8Array, klen: number): Uint8Array {
  const blocks: Uint8Array[] = [];
  let produced = 0;
  for (let counter = 1; produced < klen; counter += 1) {
    const index = Uint8Array.of(
      (counter >>> 24) & 0xff,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff,
    );
    blocks.push(opensslSm3(concatBytes(z, index)));
    produced += 32;
  }
  return concatBytes(...blocks).slice(0, klen);
}

/**
 * 用 OpenSSL 做 SM4-CBC 加密。
 *
 * @param plaintext 明文。
 * @param key 16 byte 密钥。
 * @param iv 16 byte IV。
 * @param padding 是否 PKCS#7。
 * @returns 密文。
 */
function opensslSm4Encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  padding: boolean,
): Uint8Array {
  return opensslBytes(
    [
      'enc',
      '-sm4-cbc',
      '-K',
      bytesToHex(key),
      '-iv',
      bytesToHex(iv),
      '-nosalt',
      ...(padding ? [] : ['-nopad']),
    ],
    plaintext,
  );
}

/**
 * 用 OpenSSL 做 SM4-CBC 解密。
 *
 * @param ciphertext 密文。
 * @param key 16 byte 密钥。
 * @param iv 16 byte IV。
 * @param padding 是否 PKCS#7。
 * @returns 明文。
 */
function opensslSm4Decrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  padding: boolean,
): Uint8Array {
  return opensslBytes(
    [
      'enc',
      '-d',
      '-sm4-cbc',
      '-K',
      bytesToHex(key),
      '-iv',
      bytesToHex(iv),
      '-nosalt',
      ...(padding ? [] : ['-nopad']),
    ],
    ciphertext,
  );
}

describe('SM3 标准向量与 OpenSSL 交叉验证', () => {
  it('复现 GB/T 32905 标准向量（含 100 万字节）', () => {
    for (const vector of SM3_VECTORS) {
      expect(sm3Hex(vector.bytes), vector.name).toBe(vector.hex);
      expect(bytesToHex(sm3Digest(vector.bytes)), vector.name).toBe(vector.hex);
    }
  });

  it('字符串入口与字节入口等价，覆盖中文与二进制', () => {
    expect(sm3Hex(utf8Encode('OFD 加密文档'))).toBe(sm3Hex(utf8('OFD 加密文档')));
    expect(toHex(sm3OfText('OFD 加密文档'))).toBe(sm3Hex(utf8('OFD 加密文档')));
    expect(sm3Digest(new Uint8Array(0))).toHaveLength(32);
    expect(sm3Digest(Uint8Array.from({ length: 256 }, (_, index) => index))).toHaveLength(32);
  });

  it.skipIf(!OPENSSL_AVAILABLE)('与 OpenSSL dgst -sm3 对多组输入一致', () => {
    const inputs = [
      new Uint8Array(0),
      utf8('abc'),
      utf8('abcd'.repeat(16)),
      utf8('OFDRW-CRYPTO-VERIFY-中文-😀'),
      Uint8Array.from({ length: 1024 }, (_, index) => (index * 131 + 17) & 0xff),
      new Uint8Array(1_000_000).fill(0x61),
    ];
    for (const input of inputs) {
      expect(sm3Hex(input), `OpenSSL SM3 len=${input.length}`).toBe(
        bytesToHex(opensslSm3(input)),
      );
    }
  });

  it('空输入与超长输入不改变摘要长度，且摘要为 32 byte', () => {
    expect(sm3Digest(new Uint8Array(0))).toHaveLength(32);
    expect(sm3Digest(utf8('a'.repeat(65_537)))).toHaveLength(32);
  });
});

describe('SM4-CBC/PKCS#7 标准向量与 OpenSSL 交叉验证', () => {
  it('复现 GB/T 32907 单分组标准向量（CBC + 零 IV）', () => {
    const zeroIv = new Uint8Array(16);
    const cipher = sm4EncryptCbc(SM4_KEY, SM4_KEY, zeroIv, { padding: 'none' });
    expect(toHex(cipher)).toBe(SM4_CIPHER);
    expect(toHex(sm4DecryptCbc(cipher, SM4_KEY, zeroIv, { padding: 'none' }))).toBe(
      toHex(SM4_KEY),
    );
  });

  it.skipIf(!OPENSSL_AVAILABLE)('PKCS#7 加密与 OpenSSL enc -sm4-cbc 逐字节一致（长度 0..1024）', () => {
    for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 100, 255, 256, 1024]) {
      const plaintext = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);
      const ours = sm4EncryptCbc(plaintext, SM4_KEY, SM4_IV);
      const expected = opensslSm4Encrypt(plaintext, SM4_KEY, SM4_IV, true);
      expect(toHex(ours), `encrypt len=${length}`).toBe(bytesToHex(expected));
      expect(ours.length % 16).toBe(0);
      expect(toHex(sm4DecryptCbc(expected, SM4_KEY, SM4_IV))).toBe(toHex(plaintext));
    }
  });

  it.skipIf(!OPENSSL_AVAILABLE)('no-padding 模式与 OpenSSL -nopad 一致，并双向互操作', () => {
    for (const length of [0, 16, 32, 64]) {
      const plaintext = Uint8Array.from({ length }, (_, index) => (index * 19 + 3) & 0xff);
      const ours = sm4EncryptCbc(plaintext, SM4_KEY, SM4_IV, { padding: 'none' });
      expect(toHex(ours), `nopad len=${length}`).toBe(
        bytesToHex(opensslSm4Encrypt(plaintext, SM4_KEY, SM4_IV, false)),
      );
      expect(toHex(sm4DecryptCbc(ours, SM4_KEY, SM4_IV, { padding: 'none' }))).toBe(
        toHex(plaintext),
      );
    }
  });

  it.skipIf(!OPENSSL_AVAILABLE)('OpenSSL 解密包输出，包解密 OpenSSL 输出', () => {
    const plaintext = utf8('OFD crypto V-CORE OpenSSL interop 中文');
    const ours = sm4EncryptCbc(plaintext, SM4_KEY, SM4_IV);
    expect(bytesToHex(opensslSm4Decrypt(ours, SM4_KEY, SM4_IV, true))).toBe(toHex(plaintext));

    const external = opensslSm4Encrypt(plaintext, SM4_KEY, SM4_IV, true);
    expect(toHex(sm4DecryptCbc(external, SM4_KEY, SM4_IV))).toBe(toHex(plaintext));
  });

  it.skipIf(!OPENSSL_AVAILABLE)('不同 IV 产生不同密文，且均与 OpenSSL 一致', () => {
    const plaintext = utf8('same plaintext different iv');
    const iv2 = hexToBytes('ffffffffffffffffffffffffffffffff');
    const cipher1 = sm4EncryptCbc(plaintext, SM4_KEY, SM4_IV);
    const cipher2 = sm4EncryptCbc(plaintext, SM4_KEY, iv2);
    expect(toHex(cipher1)).not.toBe(toHex(cipher2));
    expect(toHex(cipher2)).toBe(bytesToHex(opensslSm4Encrypt(plaintext, SM4_KEY, iv2, true)));
  });

  it('非法密钥/IV/长度/填充返回明确错误码', () => {
    const plaintext = utf8('boundary');
    expect(syncErrorCode(() => sm4EncryptCbc(plaintext, SM4_KEY.subarray(1), SM4_IV))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm4EncryptCbc(plaintext, SM4_KEY, new Uint8Array(15)))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm4EncryptCbc(plaintext, SM4_KEY, SM4_IV, { padding: 'none' }))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(syncErrorCode(() => sm4DecryptCbc(new Uint8Array(0), SM4_KEY, SM4_IV))).toBe(
      'CRYPTO_DECRYPT_FAILED',
    );
    expect(syncErrorCode(() => sm4DecryptCbc(new Uint8Array(15), SM4_KEY, SM4_IV))).toBe(
      'CRYPTO_DECRYPT_FAILED',
    );

    const cipher = sm4EncryptCbc(plaintext, SM4_KEY, SM4_IV);
    const badPadding = cipher.slice();
    badPadding[badPadding.length - 1] ^= 0xff;
    expect(syncErrorCode(() => sm4DecryptCbc(badPadding, SM4_KEY, SM4_IV))).toBe(
      'CRYPTO_DECRYPT_FAILED',
    );
    expect(
      syncErrorCode(() => sm4DecryptCbc(cipher, hexToBytes('ff'.repeat(16)), SM4_IV)),
    ).toBe('CRYPTO_DECRYPT_FAILED');
    expect(
      syncErrorCode(() => sm4DecryptCbc(cipher, SM4_KEY, hexToBytes('00'.repeat(16)))),
    ).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('错误以 CryptoError 抛出且不泄漏密钥/明文', () => {
    try {
      sm4DecryptCbc(new Uint8Array(15), SM4_KEY, SM4_IV);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
      expect((error as Error).message).not.toContain(toHex(SM4_KEY));
      expect((error as Error).message).not.toContain('boundary');
    }
  });
});

describe('KDF（GB/T 32918.3）独立复算', () => {
  it('复现 ofdrw Java PoC 的 KDF 向量', () => {
    expect(toHex(kdfSm3(utf8(KDF_PASSWORD), 16))).toBe(KDF_JAVA_DERIVED);
    expect(toHex(derivePasswordKey(KDF_PASSWORD))).toBe(KDF_JAVA_DERIVED);
  });

  it.skipIf(!OPENSSL_AVAILABLE)('用 OpenSSL SM3 独立构造 KDF，多长度一致', () => {
    const z = utf8('OFD-V-CORE-KDF-共享秘密-中文');
    for (const klen of [1, 15, 16, 31, 32, 33, 47, 48, 100, 255]) {
      expect(toHex(kdfSm3(z, klen)), `klen=${klen}`).toBe(bytesToHex(opensslKdf(z, klen)));
    }

    const passwordKey = utf8('P@ssw0rd-中文');
    expect(toHex(derivePasswordKey('P@ssw0rd-中文'))).toBe(
      bytesToHex(opensslKdf(passwordKey, 16)),
    );
  });

  it('4096 byte 上限按 Ha1||Ha2... 截断，输出严格等于独立块拼接', () => {
    const z = utf8('max-kdf');
    const block = (counter: number): Uint8Array =>
      sm3Digest(
        concatBytes(
          z,
          Uint8Array.of(
            (counter >>> 24) & 0xff,
            (counter >>> 16) & 0xff,
            (counter >>> 8) & 0xff,
            counter & 0xff,
          ),
        ),
      );
    const blocks = Array.from({ length: 128 }, (_, index) => block(index + 1));
    expect(toHex(kdfSm3(z, 4096))).toBe(toHex(concatBytes(...blocks)));
  });

  it('空字符串/非法长度/非法输入返回明确错误码', () => {
    expect(syncErrorCode(() => derivePasswordKey(''))).toBe('CRYPTO_CREDENTIALS_REQUIRED');
    expect(syncErrorCode(() => kdfSm3(new Uint8Array(0), 0))).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => kdfSm3(new Uint8Array(0), -1))).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => kdfSm3(new Uint8Array(0), 4097))).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => kdfSm3(new Uint8Array(0), 1.5))).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => kdfSm3(new Uint8Array(0), Number.NaN))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
    expect(
      syncErrorCode(() => kdfSm3(new Uint8Array(0), Number.POSITIVE_INFINITY)),
    ).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(syncErrorCode(() => kdfSm3('x' as unknown as Uint8Array, 16))).toBe(
      'CRYPTO_INVALID_ARGUMENT',
    );
  });

  it('口令按 UTF-8 编码且不做 Unicode 归一化', () => {
    const composed = '\u00e9'; // é
    const decomposed = 'e\u0301'; // e + 组合重音
    expect(toHex(derivePasswordKey(composed))).not.toBe(toHex(derivePasswordKey(decomposed)));
    expect(toHex(derivePasswordKey(composed))).toBe(
      toHex(kdfSm3(utf8(composed), 16)),
    );
  });
});