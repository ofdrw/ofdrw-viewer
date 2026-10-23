/**
 * crypto 包统一错误类型与错误码（对应设计方案 §3.7）。
 *
 * 错误码是公共契约，冻结后不得增删/改名；warning 见 `types/warnings.ts`。
 *
 * 安全约束：`message` 只允许出现路径/用户名/算法/OID 等诊断信息，
 * 不得包含口令、私钥、PEM、`EncryptedWK` 或任何密钥字节。
 */

/** 公共错误码（冻结）。 */
export type CryptoErrorCode =
  // 输入/API
  | 'CRYPTO_INVALID_ARGUMENT'
  | 'CRYPTO_CREDENTIALS_REQUIRED'
  | 'CRYPTO_SOURCE_UNSUPPORTED'
  | 'CRYPTO_LIMIT_EXCEEDED'
  | 'CRYPTO_ABORTED'
  // 包/加密结构
  | 'CRYPTO_INVALID_PACKAGE'
  | 'CRYPTO_NOT_ENCRYPTED'
  | 'CRYPTO_UNSUPPORTED_ENCRYPTION'
  | 'CRYPTO_ENTRY_MAP_INVALID'
  | 'CRYPTO_DECRYPT_FAILED'
  | 'CRYPTO_DECRYPT_LAYER_LIMIT'
  | 'CRYPTO_LAYER_LOOP'
  // 凭据
  | 'CRYPTO_USER_NOT_FOUND'
  | 'CRYPTO_USER_AMBIGUOUS'
  | 'CRYPTO_WRONG_PASSWORD'
  | 'CRYPTO_PRIVATE_KEY_INVALID'
  | 'CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED'
  | 'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION'
  | 'CRYPTO_PRIVATE_KEY_MISMATCH'
  // ASN.1/验证
  | 'CRYPTO_ASN1_INVALID'
  | 'CRYPTO_UNSUPPORTED_SES_VERSION'
  | 'CRYPTO_UNSUPPORTED_ALGORITHM'
  | 'CRYPTO_CERTIFICATE_INVALID'
  | 'CRYPTO_TRUST_ROOT_INVALID'
  | 'CRYPTO_INTEGRITY_INVALID'
  | 'CRYPTO_SIGNATURE_INVALID'
  | 'CRYPTO_TIMESTAMP_PARSE';

/** 全部错误码索引；顺序与设计文档一致，供文档/测试断言。 */
export const CRYPTO_ERROR_CODES: readonly CryptoErrorCode[] = Object.freeze([
  'CRYPTO_INVALID_ARGUMENT',
  'CRYPTO_CREDENTIALS_REQUIRED',
  'CRYPTO_SOURCE_UNSUPPORTED',
  'CRYPTO_LIMIT_EXCEEDED',
  'CRYPTO_ABORTED',
  'CRYPTO_INVALID_PACKAGE',
  'CRYPTO_NOT_ENCRYPTED',
  'CRYPTO_UNSUPPORTED_ENCRYPTION',
  'CRYPTO_ENTRY_MAP_INVALID',
  'CRYPTO_DECRYPT_FAILED',
  'CRYPTO_DECRYPT_LAYER_LIMIT',
  'CRYPTO_LAYER_LOOP',
  'CRYPTO_USER_NOT_FOUND',
  'CRYPTO_USER_AMBIGUOUS',
  'CRYPTO_WRONG_PASSWORD',
  'CRYPTO_PRIVATE_KEY_INVALID',
  'CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED',
  'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
  'CRYPTO_PRIVATE_KEY_MISMATCH',
  'CRYPTO_ASN1_INVALID',
  'CRYPTO_UNSUPPORTED_SES_VERSION',
  'CRYPTO_UNSUPPORTED_ALGORITHM',
  'CRYPTO_CERTIFICATE_INVALID',
  'CRYPTO_TRUST_ROOT_INVALID',
  'CRYPTO_INTEGRITY_INVALID',
  'CRYPTO_SIGNATURE_INVALID',
  'CRYPTO_TIMESTAMP_PARSE',
]);

/** 创建 CryptoError 时的可选信息。 */
export interface CryptoErrorOptions {
  /**
   * 原始错误。
   *
   * 只允许包装不含密钥/口令的底层错误（例如 `RangeError`、ASN.1 偏移错误）；
   * 不得把 PEM/口令/`EncryptedWK` 等敏感对象挂到 cause 上。
   */
  cause?: unknown;
}

/**
 * crypto 包统一错误。
 *
 * 所有公共 API 的失败都应抛该类型；`code` 用于程序分支，`message` 用于诊断。
 */
export class CryptoError extends Error {
  /** 机器可读错误码。 */
  readonly code: CryptoErrorCode;
  /** 原始错误（若存在）。 */
  override readonly cause?: unknown;

  /**
   * 创建错误。
   *
   * @param code 错误码。
   * @param message 人类可读信息；不得包含密钥/口令。
   * @param options 可选原始错误。
   */
  constructor(code: CryptoErrorCode, message: string, options?: CryptoErrorOptions) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
    this.cause = options?.cause;
  }
}

/**
 * 判断一个值是否为 CryptoError。
 *
 * @param value 待判断值。
 * @returns 是 CryptoError 时返回 true。
 */
export function isCryptoError(value: unknown): value is CryptoError {
  return value instanceof CryptoError;
}

/**
 * 把任意错误包装成 CryptoError；已是 CryptoError 时原样返回。
 *
 * @param error 原始错误/值。
 * @param code 包装时使用的错误码；默认 `CRYPTO_INVALID_ARGUMENT`。
 * @param message 包装时使用的信息；省略时取原始错误的 message。
 * @returns CryptoError 实例；输入已是 CryptoError 时原样返回。
 */
export function toCryptoError(
  error: unknown,
  code: CryptoErrorCode = 'CRYPTO_INVALID_ARGUMENT',
  message?: string,
): CryptoError {
  if (error instanceof CryptoError) return error;
  const text = message ?? (error instanceof Error ? error.message : String(error));
  return new CryptoError(code, text, { cause: error });
}