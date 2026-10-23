/**
 * crypto 包 warning 类型与 warning 码（对应设计方案 §3.7）。
 *
 * warning 不中断解密/验证；调用方通过 `CryptoOptions.onWarning` 接收。
 * warning 的 message 同样不得包含口令、私钥、PEM 或密文字节。
 */

/** 公共 warning 码（冻结）。 */
export type CryptoWarningCode =
  | 'W_CRYPTO_DUPLICATE_USER'
  | 'W_CRYPTO_CREDENTIAL_IGNORED'
  | 'W_CRYPTO_ENTRIES_MAP_PLAINTEXT'
  | 'W_CRYPTO_ENTRY_MAP_INVALID'
  | 'W_CRYPTO_KEY_USAGE_MISSING'
  | 'W_CRYPTO_MULTI_LAYER'
  | 'W_CRYPTO_TIMESTAMP_PARSE'
  | 'W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH'
  | 'W_CRYPTO_UNKNOWN_SES_VERSION'
  | 'W_CRYPTO_REFERENCE_UNSUPPORTED'
  | 'W_CRYPTO_SEAL_PICTURE_INVALID'
  | 'W_CRYPTO_TRUST_UNKNOWN'
  | 'W_CRYPTO_CERT_SOURCE_UNSUPPORTED';

/** 全部 warning 码索引；顺序与设计文档一致，供文档/测试断言。 */
export const CRYPTO_WARNING_CODES: readonly CryptoWarningCode[] = Object.freeze([
  'W_CRYPTO_DUPLICATE_USER',
  'W_CRYPTO_CREDENTIAL_IGNORED',
  'W_CRYPTO_ENTRIES_MAP_PLAINTEXT',
  'W_CRYPTO_ENTRY_MAP_INVALID',
  'W_CRYPTO_KEY_USAGE_MISSING',
  'W_CRYPTO_MULTI_LAYER',
  'W_CRYPTO_TIMESTAMP_PARSE',
  'W_CRYPTO_TIMESTAMP_IMPRINT_MISMATCH',
  'W_CRYPTO_UNKNOWN_SES_VERSION',
  'W_CRYPTO_REFERENCE_UNSUPPORTED',
  'W_CRYPTO_SEAL_PICTURE_INVALID',
  'W_CRYPTO_TRUST_UNKNOWN',
  'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
]);

/** 一条 warning。 */
export interface CryptoWarning {
  /** warning 码。 */
  readonly code: CryptoWarningCode;
  /** 诊断信息；不得包含敏感数据。 */
  readonly message: string;
  /** 相关包内路径/证书来源（可选）。 */
  readonly path?: string;
}

/** warning 回调。 */
export type CryptoWarningHandler = (warning: CryptoWarning) => void;