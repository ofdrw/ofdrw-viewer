/**
 * crypto 包资源限制（对应设计方案 §3.1）。
 *
 * 所有字节类字段单位均为 byte；所有计数字段均为非负整数。
 * 上限用于防御 ZIP bomb、超大 ASN.1、证书链膨胀与层数失控。
 */

/** 加密/验证资源上限。 */
export interface CryptoLimits {
  /** 输入包上限，单位 byte。 */
  readonly maxSourceBytes: number;
  /** ZIP 条目数上限。 */
  readonly maxEntries: number;
  /** 单条目明文上限，单位 byte。 */
  readonly maxEntryBytes: number;
  /** 单层解压总量上限，单位 byte。 */
  readonly maxTotalDecryptedBytes: number;
  /** 最大压缩比（解压总量 / 输入字节数）。 */
  readonly maxCompressionRatio: number;
  /** 最大嵌套加密层数。 */
  readonly maxDecryptLayers: number;
  /** 单个 ASN.1 结构上限，单位 byte。 */
  readonly maxAsn1Bytes: number;
  /** ASN.1 最大嵌套深度（层）。 */
  readonly maxAsn1Depth: number;
  /** 单次验证解析的证书总数上限。 */
  readonly maxCertificates: number;
  /** 信任根数量上限。 */
  readonly maxTrustRoots: number;
}

/** 默认资源上限（冻结）。 */
export const DEFAULT_CRYPTO_LIMITS: Readonly<CryptoLimits> = Object.freeze({
  maxSourceBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalDecryptedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxDecryptLayers: 4,
  maxAsn1Bytes: 16 * 1024 * 1024,
  maxAsn1Depth: 64,
  maxCertificates: 32,
  maxTrustRoots: 32,
});