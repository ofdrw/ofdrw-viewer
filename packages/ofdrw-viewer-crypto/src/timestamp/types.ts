/**
 * 时间戳解析结果类型（对应设计方案 §3.6、§5.6）。
 *
 * 时间戳只解析、不验证：`status` 固定为 `parsed-not-verified` / `not-present` /
 * `parse-error`，不提供“验证通过”状态；`note` 文案由 UI 原样展示。
 */

import type { CertificateSummary } from '../types/certificate';
import type { VerificationIssue } from '../types/status';

/** 时间戳解析结果。 */
export interface TimestampParseResult {
  /** 状态：已解析未验证 / 不存在 / 解析失败。 */
  readonly status: 'parsed-not-verified' | 'not-present' | 'parse-error';
  /** 是否存在时间戳令牌。 */
  readonly tokenPresent: boolean;
  /** 时间戳令牌字节长度，单位 byte。 */
  readonly tokenLength: number;
  /** TSTInfo.version。 */
  readonly version?: number;
  /** TSTInfo.policy OID。 */
  readonly policy?: string;
  /** TSTInfo.serialNumber（小写十六进制）。 */
  readonly serialNumber?: string;
  /** TSTInfo.genTime（ISO 8601）。 */
  readonly genTime?: string;
  /** messageImprint 摘要算法名称（例如 `SM3`）。 */
  readonly hashAlgorithm?: string;
  /** messageImprint.hashedMessage（小写十六进制）。 */
  readonly messageImprint?: string;
  /** TSTInfo.nonce（小写十六进制，可选）。 */
  readonly nonce?: string;
  /** TSA 证书摘要（仅展示，不校验证书链）。 */
  readonly tsa?: CertificateSummary;
  /** 仅比较 messageImprint 与签章签名值；不验证 TSA 签名。 */
  readonly messageImprintMatchesSignature?: boolean;
  /** 解析失败详情。 */
  readonly parseError?: VerificationIssue;
  /** 固定文案，UI 必须原样展示。 */
  readonly note: '已解析，未验证';
}