/**
 * 证书公开摘要转换。
 */

import type { X509Certificate } from '../asn1/x509';
import type { CertificateSummary } from '../types/certificate';

/**
 * 把解析后的证书转为公开摘要（不含 PEM/公钥原文）。
 *
 * @param certificate 证书。
 * @returns 摘要；时间统一 ISO 8601，指纹为小写十六进制。
 */
export function toCertificateSummary(certificate: X509Certificate): CertificateSummary {
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    notBefore: certificate.notBeforeISO,
    notAfter: certificate.notAfterISO,
    fingerprintSha256: certificate.fingerprintSha256,
    publicKeyAlgorithm: certificate.publicKeyAlgorithmName,
    signatureAlgorithm: certificate.signatureAlgorithmName,
    keyUsage: certificate.keyUsage,
    isCA: certificate.isCA,
  };
}