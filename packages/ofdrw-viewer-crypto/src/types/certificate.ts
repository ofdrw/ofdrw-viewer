/**
 * 证书输入与公开摘要类型。
 *
 * 公共 API 只接收单张证书的 DER 字节；PEM/CER/Base64/多证书识别由入口工具
 * `certificatesToDer` 完成，crypto 核心不解析文本、扩展名或宿主路径。
 */

/**
 * 证书 DER 字节。
 *
 * `parseCertificates` 可直接接收拼接的多张证书 DER；`loadCertificates` 的
 * 数组每项必须是一张证书。归调用方所有；crypto 不修改，也不跨调用持有。
 */
export type CertificateDer = Uint8Array;

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
