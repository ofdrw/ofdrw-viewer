/**
 * 公共类型聚合入口。
 *
 * 只包含跨模块共享的输入/凭据/限制/状态/摘要类型；具体模块的结果类型
 * （如签名报告）由各模块在自己的 `index.ts` 中导出。
 */

export { DEFAULT_CRYPTO_LIMITS } from './limits';
export type { CryptoLimits } from './limits';

export type { CryptoSource } from './source';
export type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';

export type {
  CryptoCredential,
  PasswordCredential,
  PrivateKeyCredential,
  Sm2PrivateKeyInput,
} from './credentials';

export type {
  CertificateInput,
  CertificateKeyUsage,
  CertificateSummary,
} from './certificate';

export type { CryptoOptions, ParseOptions } from './options';

export { CRYPTO_WARNING_CODES } from './warnings';
export type {
  CryptoWarning,
  CryptoWarningCode,
  CryptoWarningHandler,
} from './warnings';

export type {
  ChainStatus,
  TimestampStatus,
  VerificationIssue,
  VerificationIssueSeverity,
  VerificationStatus,
} from './status';