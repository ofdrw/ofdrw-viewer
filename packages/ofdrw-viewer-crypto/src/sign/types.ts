/**
 * 签名验证子结果类型（对应设计方案 §3.6）。
 *
 * 这些类型同时被 `sign`（Reference 校验）、`integrity`（GB/T 35275）与
 * `verify`（统一报告）复用，放在签名模块以避免循环依赖。
 */

import type { VerificationStatus } from '../types/status';

/** Reference 校验失败原因。 */
export type ReferenceFailureReason = 'missing' | 'mismatch' | 'unsupported';

/** 单条 Reference 校验失败。 */
export interface ReferenceFailure {
  /** 引用文件路径（规范化包内路径）。 */
  readonly fileRef: string;
  /** 失败原因：缺失 / 摘要不符 / 算法不支持。 */
  readonly reason: ReferenceFailureReason;
}

/** `Signature.xml` 中 References 的校验结果。 */
export interface ReferenceCheckResult {
  /** 汇总状态。 */
  readonly status: VerificationStatus;
  /** Reference 总数。 */
  readonly total: number;
  /** 已成功校验的数量。 */
  readonly checked: number;
  /** 失败列表（含 unsupported）。 */
  readonly failures: readonly ReferenceFailure[];
}

/** 签名数学验证结果（SM2/SM3）。 */
export interface SignatureMathResult {
  /** 数学验签状态。 */
  readonly status: VerificationStatus;
  /** 签名算法名称/OID。 */
  readonly algorithm?: string;
  /** 验签使用的 SM2 userId。 */
  readonly sm2UserId: string;
}