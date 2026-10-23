/**
 * SM3 密码杂凑（GB/T 32905-2016）。
 *
 * 底层使用 sm-crypto 的 SM3，本层只负责字节/文本归一化与错误封装。
 */

import { CryptoError } from '../errors';
import { fromHex, utf8Encode } from '../util/bytes';
import { sm3 } from './sm-crypto';

/**
 * 计算 SM3 摘要。
 *
 * @param data 输入字节。
 * @returns 32 byte 摘要。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：输入不是 Uint8Array。
 */
export function sm3Digest(data: Uint8Array): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM3 输入必须是 Uint8Array');
  }
  try {
    return fromHex(sm3(Array.from(data)));
  } catch {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM3 摘要计算失败');
  }
}

/**
 * 计算 SM3 摘要并输出小写十六进制。
 *
 * @param data 输入字节。
 * @returns 64 字符小写十六进制。
 */
export function sm3Hex(data: Uint8Array): string {
  const digest = sm3Digest(data);
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * 计算 UTF-8 文本的 SM3 摘要。
 *
 * @param text 文本；按 UTF-8 编码，不做 Unicode 归一化。
 * @returns 32 byte 摘要。
 */
export function sm3OfText(text: string): Uint8Array {
  if (typeof text !== 'string') {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SM3 文本输入必须是字符串');
  }
  return sm3Digest(utf8Encode(text));
}