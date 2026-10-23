/**
 * 公共选项解析：限制、SM2 userId、当前时间与解析上限。
 */

import { CryptoError } from '../errors';
import {
  DEFAULT_CRYPTO_LIMITS,
  type CryptoLimits,
} from '../types/limits';
import type { CryptoOptions, ParseOptions } from '../types/options';
import type { CryptoWarningHandler } from '../types/warnings';

/** SM2 标准用户 ID（GB/T 32918）。 */
export const DEFAULT_SM2_USER_ID = '1234567812345678';

/** 解析后的公共选项。 */
export interface ResolvedCryptoOptions {
  /** 完整资源限制。 */
  readonly limits: CryptoLimits;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
  /** warning 回调。 */
  readonly onWarning?: CryptoWarningHandler;
  /** SM2 签名 userId。 */
  readonly sm2UserId: string;
  /** 校验证书有效期使用的当前时间。 */
  readonly now: Date;
}

/**
 * 合并并校验资源限制。
 *
 * @param partial 部分限制；省略字段取默认值。
 * @returns 完整限制。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：字段非正整数。
 */
export function resolveCryptoLimits(partial?: Partial<CryptoLimits>): CryptoLimits {
  const limits: CryptoLimits = { ...DEFAULT_CRYPTO_LIMITS, ...partial };
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `limits.${name} 必须是正整数`);
    }
  }
  return limits;
}

/**
 * 解析 SM2 用户 ID。
 *
 * SM2 的 ENTL 字段为 2 byte 比特长度，因此 userId 的 UTF-8 字节数不得超过 8191。
 *
 * @param userId 调用方传入值；省略使用标准值 `1234567812345678`。
 * @returns 有效 userId。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：空值或超长。
 */
export function resolveSm2UserId(userId?: string): string {
  if (userId === undefined) return DEFAULT_SM2_USER_ID;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'sm2UserId 必须是非空字符串');
  }
  const byteLength = new TextEncoder().encode(userId).length;
  if (byteLength > 8191) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'sm2UserId 的 UTF-8 长度不能超过 8191 byte');
  }
  return userId;
}

/**
 * 解析 ASN.1/解析类上限。
 *
 * @param options 解析选项。
 * @param limits 资源限制（用于默认值）。
 * @returns 解析上限；`maxBytes` 单位 byte，`maxDepth` 单位层。
 */
export function resolveParseOptions(
  options?: ParseOptions,
  limits: CryptoLimits = DEFAULT_CRYPTO_LIMITS,
): { readonly maxBytes: number; readonly maxDepth: number } {
  const maxBytes = options?.maxBytes ?? limits.maxAsn1Bytes;
  const maxDepth = options?.maxDepth ?? limits.maxAsn1Depth;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxBytes 必须是正整数');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxDepth 必须是正整数');
  }
  return { maxBytes, maxDepth };
}

/**
 * 解析公共选项。
 *
 * @param options 公共选项。
 * @returns 完整限制、userId、当前时间与回调。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：限制/时间非法。
 */
export function resolveCryptoOptions(options?: CryptoOptions): ResolvedCryptoOptions {
  const now = options?.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'now 必须是有效 Date');
  }
  return {
    limits: resolveCryptoLimits(options?.limits),
    signal: options?.signal,
    onWarning: options?.onWarning,
    sm2UserId: resolveSm2UserId(options?.sm2UserId),
    now,
  };
}