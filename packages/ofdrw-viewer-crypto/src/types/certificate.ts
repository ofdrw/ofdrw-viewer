/**
 * 证书输入与公开摘要类型。
 *
 * 公共 API 遵循冻结设计 §3.1：`CertificateInput` 只有 `data`/`pem`/`der`
 * 三种自包含来源。URL/path/filePath 属于宿主层（UI/CLI）的
 * `CertificateSource`，由宿主读取成字节后传成三态输入，crypto 不解析宿主路径。
 */

/**
 * 单个 X.509 证书输入；`data`/`pem`/`der` 三选一。
 */
export interface CertificateInput {
  /** 证书字节（DER/CER 或 PEM 文本字节）；归调用方所有。 */
  readonly data?: ArrayBuffer | Uint8Array;
  /** PEM 文本，可包含多张证书。 */
  readonly pem?: string;
  /** DER/CER 字节（可拼接多张证书）。 */
  readonly der?: Uint8Array;
}

/** 证书 KeyUsage 名称。 */
export type CertificateKeyUsage =
  | 'digitalSignature'
  | 'nonRepudiation'
  | 'keyEncipherment'
  | 'dataEncipherment'
  | 'keyAgreement'
  | 'keyCertSign'
  | 'cRLSign'
  | 'encipherOnly'
  | 'decipherOnly';

/** 证书公开摘要；不含证书 PEM/私钥等敏感内容。 */
export interface CertificateSummary {
  /** 主题 DN 文本，例如 `C=CN,O=ofdrw,CN=Signer`。 */
  readonly subject: string;
  /** 颁发者 DN 文本。 */
  readonly issuer: string;
  /** 序列号小写十六进制（无前导零）。 */
  readonly serialNumber: string;
  /** 生效时间（ISO 8601）。 */
  readonly notBefore: string;
  /** 失效时间（ISO 8601）。 */
  readonly notAfter: string;
  /** 证书 DER 的 SHA-256 指纹，小写十六进制。 */
  readonly fingerprintSha256: string;
  /** 公钥算法名，例如 `SM2`、`EC`。 */
  readonly publicKeyAlgorithm?: string;
  /** 签名算法名，例如 `SM3withSM2`。 */
  readonly signatureAlgorithm?: string;
  /** KeyUsage 名称；扩展不存在时省略。 */
  readonly keyUsage?: readonly CertificateKeyUsage[];
  /** 是否为 CA 证书（BasicConstraints.cA）。 */
  readonly isCA: boolean;
}
