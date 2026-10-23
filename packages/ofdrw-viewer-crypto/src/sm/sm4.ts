/**
 * SM4-CBC 加解密（GB/T 32907-2016），默认 PKCS#7 填充。
 *
 * 安全约定：
 * - 所有 API 只接受 `Uint8Array`，禁止把明文/密钥当 UTF-8 字符串传入；
 * - 解密时显式校验密文长度与 PKCS#7 填充，错误统一为 `CRYPTO_DECRYPT_FAILED`；
 * - 密钥/IV 长度非法属于调用方错误，抛 `CRYPTO_INVALID_ARGUMENT`。
 */

import { CryptoError } from '../errors';
import { toHex } from '../util/bytes';
import { sm4 } from './sm-crypto';

/** SM4 分组长度，单位 byte。 */
export const SM4_BLOCK_SIZE = 16;

/** SM4-CBC 填充方式。 */
export type Sm4Padding = 'pkcs7' | 'none';

/** SM4-CBC 选项。 */
export interface Sm4CbcOptions {
  /** 填充方式；默认 `pkcs7`。 */
  readonly padding?: Sm4Padding;
}

/**
 * 校验密钥与 IV 长度。
 *
 * @param key 16 byte 密钥。
 * @param iv 16 byte 初始向量。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`。
 */
function assertKeyAndIv(key: Uint8Array, iv: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== SM4_BLOCK_SIZE) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM4 密钥必须是 16 byte');
  }
  if (!(iv instanceof Uint8Array) || iv.length !== SM4_BLOCK_SIZE) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM4 IV 必须是 16 byte');
  }
}

/**
 * 对输入做 PKCS#7 填充。
 *
 * @param data 明文。
 * @param padding 填充方式。
 * @returns 16 byte 对齐后的字节。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：`none` 模式下长度未对齐。
 */
function pad(data: Uint8Array, padding: Sm4Padding): Uint8Array {
  if (padding === 'none') {
    if (data.length % SM4_BLOCK_SIZE !== 0) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM4 输入长度必须是 16 的倍数');
    }
    return data;
  }
  const padLength = SM4_BLOCK_SIZE - (data.length % SM4_BLOCK_SIZE);
  const out = new Uint8Array(data.length + padLength);
  out.set(data);
  out.fill(padLength, data.length);
  return out;
}

/**
 * 校验并去除 PKCS#7 填充。
 *
 * @param data 解密后的字节。
 * @returns 去填充后的明文。
 * @throws CryptoError `CRYPTO_DECRYPT_FAILED`：填充非法。
 */
function unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % SM4_BLOCK_SIZE !== 0) {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM4 密文长度非法');
  }
  const padLength = data[data.length - 1];
  if (padLength < 1 || padLength > SM4_BLOCK_SIZE) {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM4 PKCS#7 填充非法');
  }
  let diff = 0;
  for (let i = 0; i < padLength; i += 1) {
    diff |= data[data.length - 1 - i] ^ padLength;
  }
  if (diff !== 0) {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM4 PKCS#7 填充非法');
  }
  return data.slice(0, data.length - padLength);
}

/**
 * SM4-CBC 加密。
 *
 * @param plaintext 明文；`none` 模式下长度必须是 16 的倍数。
 * @param key 16 byte 密钥。
 * @param iv 16 byte IV。
 * @param options 填充方式，默认 PKCS#7。
 * @returns 密文。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：参数非法。
 */
export function sm4EncryptCbc(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  options: Sm4CbcOptions = {},
): Uint8Array {
  if (!(plaintext instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM4 明文必须是 Uint8Array');
  }
  assertKeyAndIv(key, iv);
  const padded = pad(plaintext, options.padding ?? 'pkcs7');
  try {
    const result = sm4.encrypt(Array.from(padded), toHex(key), {
      mode: 'cbc',
      iv: toHex(iv),
      padding: 'none',
      output: 'array',
    });
    return Uint8Array.from(result as number[]);
  } catch {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM4 加密失败');
  }
}

/**
 * SM4-CBC 解密。
 *
 * @param ciphertext 密文；长度必须是 16 的倍数。
 * @param key 16 byte 密钥。
 * @param iv 16 byte IV。
 * @param options 填充方式，默认 PKCS#7。
 * @returns 明文。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：参数非法；
 *   `CRYPTO_DECRYPT_FAILED`：密文长度/填充非法。
 */
export function sm4DecryptCbc(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  options: Sm4CbcOptions = {},
): Uint8Array {
  if (!(ciphertext instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM4 密文必须是 Uint8Array');
  }
  assertKeyAndIv(key, iv);
  if (ciphertext.length % SM4_BLOCK_SIZE !== 0) {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM4 密文长度必须是 16 的倍数');
  }
  const padding = options.padding ?? 'pkcs7';
  if (padding === 'pkcs7' && ciphertext.length === 0) {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM4 密文不能为空');
  }
  let result: number[];
  try {
    result = sm4.decrypt(toHex(ciphertext), toHex(key), {
      mode: 'cbc',
      iv: toHex(iv),
      padding: 'none',
      output: 'array',
    }) as number[];
  } catch {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', 'SM4 解密失败');
  }
  const plaintext = Uint8Array.from(result);
  return padding === 'none' ? plaintext : unpad(plaintext);
}