/**
 * 密钥派生函数 KDF（GB/T 32918.3-2016 §5.4.3）。
 *
 * `KDF(Z, klen) = (Ha1 || Ha2 || ...) 截断到 klen`，其中
 * `Hai = SM3(Z || I2OSP(ct, 4))`，`ct` 从 1 开始、大端 4 byte。
 *
 * OFD 口令加密使用 `KEK = KDF(SM3, passwordBytes, 16)`。
 */

import { CryptoError } from '../errors';
import { concatBytes, utf8Encode } from '../util/bytes';
import { sm3Digest } from './sm3';

/** SM3 摘要长度，单位 byte。 */
const SM3_LENGTH = 32;

/**
 * 按 GB/T 32918.3 派生密钥。
 *
 * 若派生结果全 0，按标准重取下一组计数器重试一次；仍全 0 视为空密钥错误。
 *
 * @param z 共享秘密字节串（口令场景为 UTF-8 口令字节）。
 * @param klen 期望密钥长度，单位 byte；范围 1..4096。
 * @returns 派生密钥。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：参数非法；
 *   `CRYPTO_CREDENTIALS_REQUIRED`：派生结果全 0。
 */
export function kdfSm3(z: Uint8Array, klen: number): Uint8Array {
  if (!(z instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'KDF 输入必须是 Uint8Array');
  }
  if (!Number.isSafeInteger(klen) || klen <= 0 || klen > 4096) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'KDF klen 必须是 1..4096 的整数');
  }

  let counter = 1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const blocks: Uint8Array[] = [];
    let produced = 0;
    while (produced < klen) {
      if (counter > 0xffff_ffff) {
        throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'KDF 计数器溢出');
      }
      blocks.push(sm3Digest(concatBytes(z, i2osp4(counter))));
      counter += 1;
      produced += SM3_LENGTH;
    }
    const key = concatBytes(...blocks).slice(0, klen);
    if (!isAllZero(key)) return key;
  }
  throw new CryptoError('CRYPTO_CREDENTIALS_REQUIRED', 'KDF 派生结果为空密钥');
}

/**
 * 用口令派生 16 byte 密钥（OFD 口令加密）。
 *
 * 口令按 UTF-8 编码，不做 Unicode 归一化；空口令拒绝。
 *
 * @param password 口令。
 * @returns 16 byte KEK。
 * @throws CryptoError `CRYPTO_CREDENTIALS_REQUIRED`：空口令。
 */
export function derivePasswordKey(password: string): Uint8Array {
  if (typeof password !== 'string' || password.length === 0) {
    throw new CryptoError('CRYPTO_CREDENTIALS_REQUIRED', '口令不能为空');
  }
  return kdfSm3(utf8Encode(password), 16);
}

/**
 * 32 位无符号整数转 4 byte 大端。
 *
 * @param value 0..2^32-1。
 * @returns 4 byte 大端字节。
 */
function i2osp4(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

/**
 * 判断字节数组是否全 0。
 *
 * @param bytes 输入。
 * @returns 全 0 返回 true。
 */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}