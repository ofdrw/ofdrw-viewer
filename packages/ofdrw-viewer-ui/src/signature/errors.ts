/**
 * 签章解析错误。
 *
 * 与 UI 的错误码分开：解析器属于按需动态加载模块，只需要一个稳定的错误类型
 * 供 `SignatureService` 降级为 warning，不把 ASN.1 细节暴露到公共 API。
 */

/** 解析器错误码。 */
export type SignatureParseErrorCode = 'W_SIGNATURE_ASN1' | 'W_SIGNATURE_LIMIT';

/** 签章值解析失败。 */
export class SignatureParseError extends Error {
  /** 诊断码；对应 `ViewerWarning.code`。 */
  readonly code: SignatureParseErrorCode;

  /**
   * @param code 诊断码。
   * @param message 人类可读信息。
   */
  constructor(code: SignatureParseErrorCode, message: string) {
    super(message);
    this.name = 'SignatureParseError';
    this.code = code;
  }
}

/**
 * 判断是否为签章解析错误。
 *
 * @param value 待判断值。
 * @returns 是 `SignatureParseError` 时返回 true。
 */
export function isSignatureParseError(value: unknown): value is SignatureParseError {
  return value instanceof SignatureParseError;
}