/**
 * 取消信号与参数校验工具。
 */

import { CryptoError } from '../errors';

/**
 * 若取消信号已中止则抛 `CRYPTO_ABORTED`。
 *
 * @param signal 取消信号（可选）。
 * @throws CryptoError `CRYPTO_ABORTED`。
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CryptoError('CRYPTO_ABORTED', '操作已取消');
  }
}

/**
 * 断言值为非空字符串。
 *
 * @param value 值。
 * @param name 参数名，用于错误信息。
 * @returns 原字符串。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`。
 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `${name} 必须是非空字符串`);
  }
  return value;
}

/**
 * 断言值为正整数。
 *
 * @param value 值。
 * @param name 参数名。
 * @param max 允许的最大值（可选）。
 * @returns 原数值。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`。
 */
export function requirePositiveInteger(value: unknown, name: string, max?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `${name} 必须是正整数`);
  }
  if (max !== undefined && value > max) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `${name} 不能大于 ${max}`);
  }
  return value;
}

/**
 * 断言值不超过字节上限。
 *
 * @param length 实际字节数，单位 byte。
 * @param maxBytes 上限，单位 byte。
 * @param what 描述，用于错误信息。
 * @throws CryptoError `CRYPTO_LIMIT_EXCEEDED`。
 */
export function requireWithinBytes(length: number, maxBytes: number, what: string): void {
  if (length > maxBytes) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `${what} 大小 ${length} byte 超过上限 ${maxBytes} byte`,
    );
  }
}