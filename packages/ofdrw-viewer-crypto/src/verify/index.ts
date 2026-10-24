/**
 * 统一验证模块公共入口。
 *
 * 只暴露 `verifyOfd` 与报告类型；证书链等内部实现不直接导出。
 */

export { verifyOfd } from './verify';
export type {
  CertificateChainVerification,
  DataHashVerification,
  DecryptionReportInfo,
  IntegrityVerification,
  PackageVerificationInfo,
  SealVerification,
  SignatureVerification,
  SigningTimeSource,
  VerificationReport,
  VerifyOfdOptions,
} from './types';