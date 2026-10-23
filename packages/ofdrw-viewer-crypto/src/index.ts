/**
 * `@ofdrw/ofdrw-viewer-crypto` 公共入口。
 *
 * 公共 API 与公共类型只从本文件导出；内部模块（sm/asn1/cert/util）不得从包根
 * 直接暴露实现细节。后续 container/decrypt/sign/seal/integrity/timestamp/verify
 * 任务只修改各自目录的 `index.ts`，本文件保持稳定。
 */

// ---------------------------------------------------------------------------
// 错误与公共类型
// ---------------------------------------------------------------------------
export { CRYPTO_ERROR_CODES, CryptoError, isCryptoError, toCryptoError } from './errors';
export type { CryptoErrorCode, CryptoErrorOptions } from './errors';

export * from './types/index';

// ---------------------------------------------------------------------------
// 工具（字节/编码/常量时间比较/SHA-256/输入源）
// ---------------------------------------------------------------------------
export * from './util/index';

// ---------------------------------------------------------------------------
// SM 算法（SM2/SM3/SM4/KDF/私钥）
// ---------------------------------------------------------------------------
export * from './sm/index';

// ---------------------------------------------------------------------------
// ASN.1 与 X.509（DER/OID/SM2Cipher/证书结构）
// ---------------------------------------------------------------------------
export * from './asn1/index';

// ---------------------------------------------------------------------------
// 证书加载（CertificateInput 三态/摘要）
// ---------------------------------------------------------------------------
export * from './cert/index';

// ---------------------------------------------------------------------------
// 加密检测与解密
// ---------------------------------------------------------------------------
export { inspect } from './inspect';
export type {
  EncryptionLayerInfo,
  EncryptionUserInfo,
  OfdInspection,
  SignatureEntrySummary,
} from './inspect';

// ---------------------------------------------------------------------------
// 预留模块 barrel（后续实现无需修改本文件）
// ---------------------------------------------------------------------------
export * from './decrypt/index';
export * from './sign/index';
export * from './seal/index';
export * from './integrity/index';
export * from './timestamp/index';
export * from './verify/index';