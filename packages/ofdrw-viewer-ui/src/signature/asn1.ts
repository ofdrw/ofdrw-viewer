/**
 * `SignedValue.dat` 解析入口（懒加载壳）。
 *
 * 本文件是首屏可见模块，**不得**静态 import `asn1js`/`@peculiar/*`；真正的
 * ASN.1 解析在 `asn1-parser.ts` 中，通过动态 `import()` 在用户打开签章面板或
 * 详情时才加载，避免把约 300 KB 解析器打进首屏包。
 *
 * 解析只读展示信息：不验签、不校验证书链/有效期/CRL/OCSP。
 */

import type { SealInfo, SignerInfo } from '../types';
import type { ViewerWarning } from '../state';
import { assertSignedValueSize, resolveParseLimits } from './limits';
import type { SignatureParseLimits } from './limits';

/** 解析结果；字段缺失时只产生 warning，不抛错。 */
export interface SignedValueParseResult {
  /** 识别出的签章结构版本；无法识别时为 `unknown`。 */
  readonly version: 'v1' | 'v4' | 'v5' | 'unknown';
  /** 印章信息（来自 `TBS_Sign.eseal`）。 */
  readonly seal?: SealInfo;
  /** 签章者/签名信息。 */
  readonly signer?: SignerInfo;
  /** 非致命降级信息。 */
  readonly warnings: readonly ViewerWarning[];
}

/** 解析选项。 */
export interface SignedValueParseOptions {
  /** 覆盖默认安全限制；主要用于测试与宿主定制。 */
  readonly limits?: Partial<SignatureParseLimits>;
}

/**
 * 解析 `SignedValue.dat` 原始字节。
 *
 * 文件在大小上限内才会动态加载 ASN.1 解析器；解析异常通过
 * `SignatureParseError` 抛出，由调用方降级为“签章信息不完整”。
 *
 * @param data `SignedValue.dat` 原始字节。
 * @param options 解析限制。
 * @returns 结构化签章信息与 warning。
 * @throws {SignatureParseError} DER 损坏或超出深度/节点限制时抛出。
 */
export async function parseSignedValue(
  data: Uint8Array,
  options: SignedValueParseOptions = {},
): Promise<SignedValueParseResult> {
  const limits = resolveParseLimits(options.limits);
  assertSignedValueSize(data.byteLength, limits.maxBytes);
  const { parseSignedValueBytes } = await import('./asn1-parser');
  return parseSignedValueBytes(data, limits);
}

export {
  DEFAULT_SIGNATURE_PARSE_LIMITS,
  MAX_ASN1_DEPTH,
  MAX_ASN1_NODES,
  MAX_SIGNED_VALUE_BYTES,
} from './limits';
export type { SignatureParseLimits } from './limits';
export { isSignatureParseError, SignatureParseError } from './errors';
export type { SignatureParseErrorCode } from './errors';