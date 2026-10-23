/**
 * 密码能力 UI 模块。
 *
 * 对外只暴露阅读器集成所需的类型；具体交互由 `CryptoService` 统一调度。
 */

export { CryptoService, describeCredentialError } from './service';
export type {
  CryptoOpenPreparation,
  CryptoServiceHost,
  CryptoVerificationState,
  CryptoVerifyOptions,
  TrustRootItem,
  VerificationTarget,
} from './service';
export { openSignaturePopover } from './popover';
export type { SignaturePopoverHandle, SignaturePopoverOptions } from './popover';
export { VerificationPanel } from './panel';
export { createCryptoText } from './text';
export type { CryptoText } from './text';