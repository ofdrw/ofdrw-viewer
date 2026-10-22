/**
 * 签章模块公共出口（模块内部使用）。
 *
 * `src/views/signatures.ts` 只负责在模块顶层注册扩展；测试可直接引用这里的
 * `SignatureService` 与解析入口。
 */

export {
  DEFAULT_SIGNATURE_PARSE_LIMITS,
  MAX_ASN1_DEPTH,
  MAX_ASN1_NODES,
  MAX_SIGNED_VALUE_BYTES,
  isSignatureParseError,
  parseSignedValue,
  SignatureParseError,
} from './asn1';
export type {
  SignatureParseErrorCode,
  SignatureParseLimits,
  SignedValueParseOptions,
  SignedValueParseResult,
} from './asn1';
export { groupEntries, SIGNATURE_NOT_VERIFIED_NOTE, SignatureService } from './service';
