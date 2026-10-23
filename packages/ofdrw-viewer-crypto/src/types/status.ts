/**
 * 验证状态与通用问题条目（对应设计方案 §3.6）。
 *
 * 各子模块（签名/完整性/链/时间戳）的结果类型与实现放在各自目录，
 * 共享的状态枚举与 issue 结构在此冻结。
 */

/** 通用验证状态。 */
export type VerificationStatus =
  | 'valid'
  | 'invalid'
  | 'unknown'
  | 'not-applicable'
  | 'unsupported';

/** 证书链状态。 */
export type ChainStatus =
  | 'valid'
  | 'invalid'
  | 'expired'
  | 'not-yet-valid'
  | 'untrusted'
  | 'incomplete'
  | 'unsupported'
  | 'not-present'
  | 'unknown';

/** 时间戳状态；固定“只解析、不验证”。 */
export type TimestampStatus = 'parsed-not-verified' | 'not-present' | 'parse-error';

/** 验证问题级别。 */
export type VerificationIssueSeverity = 'error' | 'warning';

/** 一条验证问题；用于报告子项，不用于抛错。 */
export interface VerificationIssue {
  /** 机器可读问题码（模块内定义）。 */
  readonly code: string;
  /** 人类可读信息；不得包含口令/私钥。 */
  readonly message: string;
  /** 级别。 */
  readonly severity: VerificationIssueSeverity;
  /** 相关包内路径（可选）。 */
  readonly path?: string;
}