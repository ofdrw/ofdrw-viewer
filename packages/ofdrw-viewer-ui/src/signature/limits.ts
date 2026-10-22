/**
 * 签章解析安全限制（设计方案 §11.8）。
 *
 * 所有上限都在读取 DER 前/解析后校验，避免恶意或异常 `SignedValue.dat` 拖垮页面。
 * 数值单位：字节、层、节点个数。
 */

import { SignatureParseError } from './errors';

/** 单文件解析上限：16 MB。 */
export const MAX_SIGNED_VALUE_BYTES = 16 * 1024 * 1024;

/** DER 最大嵌套深度。 */
export const MAX_ASN1_DEPTH = 32;

/** ASN.1 节点数上限。 */
export const MAX_ASN1_NODES = 100_000;

/** 解析限制。 */
export interface SignatureParseLimits {
  /** 单文件字节上限。 */
  readonly maxBytes: number;
  /** DER 嵌套深度上限。 */
  readonly maxDepth: number;
  /** ASN.1 节点数上限。 */
  readonly maxNodes: number;
}

/** 默认限制。 */
export const DEFAULT_SIGNATURE_PARSE_LIMITS: SignatureParseLimits = Object.freeze({
  maxBytes: MAX_SIGNED_VALUE_BYTES,
  maxDepth: MAX_ASN1_DEPTH,
  maxNodes: MAX_ASN1_NODES,
});

/** 合并调用方覆盖的限制；非法值回落到默认值。 */
export function resolveParseLimits(
  overrides: Partial<SignatureParseLimits> = {},
): SignatureParseLimits {
  return {
    maxBytes: positive(overrides.maxBytes, DEFAULT_SIGNATURE_PARSE_LIMITS.maxBytes),
    maxDepth: positive(overrides.maxDepth, DEFAULT_SIGNATURE_PARSE_LIMITS.maxDepth),
    maxNodes: positive(overrides.maxNodes, DEFAULT_SIGNATURE_PARSE_LIMITS.maxNodes),
  };
}

/**
 * 校验文件大小；超限抛出解析错误。
 *
 * @param byteLength 文件字节数。
 * @param maxBytes 允许的最大字节数。
 * @throws {SignatureParseError} 超限时抛 `W_SIGNATURE_LIMIT`。
 */
export function assertSignedValueSize(byteLength: number, maxBytes: number): void {
  if (byteLength > maxBytes) {
    throw new SignatureParseError(
      'W_SIGNATURE_LIMIT',
      `签名值文件 ${formatMb(byteLength)} 超出解析上限 ${formatMb(maxBytes)}`,
    );
  }
}

/** 把字节数格式化为 MB，保留 1 位小数。 */
function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** 读取正整数；非有限/非正数时使用默认值。 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}