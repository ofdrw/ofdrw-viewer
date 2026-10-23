/**
 * 签名模块公共入口。
 *
 * 对外暴露 `parseSignedValue`（纯解析）与验签结果类型；签名验证入口统一为
 * `verifyOfd`（`verify` 模块），不提供独立的 `verifyContainer` 公共入口。
 */

export { parseSignedValue } from './ses';
export type { ParsedSignedValue } from './ses';
export { parseSignatureXml, parseSignaturesXml } from './signature-xml';
export type {
  SignatureRecord,
  SignatureReferenceXml,
  SignatureXml,
  SignaturesXml,
  StampAnnotInfo,
} from './signature-xml';
export type {
  ReferenceCheckResult,
  ReferenceFailure,
  ReferenceFailureReason,
  SignatureMathResult,
} from './types';