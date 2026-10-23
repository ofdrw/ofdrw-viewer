/**
 * SES 签名值数学验签（SM3withSM2）。
 *
 * 只验证：
 * - 签名算法 OID 是否为 `1.2.156.10197.1.501`（SM3withSM2）；
 * - TBS_Sign 原始 DER 的 SM2 签名是否由签章者证书公钥产生。
 *
 * 证书链、有效期、印章匹配与 Reference 校验由上层组合；本函数不抛异常，
 * 所有失败转换为 `SignatureMathResult` + issues。
 */

import { CryptoError, isCryptoError } from '../errors';
import { OID_SM3_WITH_SM2, oidName } from '../asn1/oid';
import { parseX509Certificate, type X509Certificate } from '../asn1/x509';
import { sm2Verify } from '../sm/sm2';
import type { VerificationIssue } from '../types/status';
import type { SignatureMathResult } from './types';
import type { SesSignatureDetail } from './ses';

/** 签名验签选项。 */
export interface VerifySesSignatureOptions {
  /** SM2 userId。 */
  readonly sm2UserId: string;
  /** ASN.1 大小/深度上限，单位 byte/层。 */
  readonly maxAsn1Bytes: number;
  readonly maxAsn1Depth: number;
}

/** 内部验签结果。 */
export interface SesSignatureCheck {
  /** 数学验签结果。 */
  readonly math: SignatureMathResult;
  /** 签章者证书；解析失败时 undefined。 */
  readonly signerCertificate?: X509Certificate;
  /** 问题列表。 */
  readonly issues: readonly VerificationIssue[];
}

/**
 * 校验 SES 签名值的 SM2 签名。
 *
 * @param detail SignedValue 详细结构。
 * @param options userId 与 ASN.1 上限。
 * @returns 验签结果与证书。
 */
export function verifySesSignatureMath(
  detail: SesSignatureDetail,
  options: VerifySesSignatureOptions,
): SesSignatureCheck {
  const algorithmName = oidName(detail.signatureAlgorithmOid);
  let certificate: X509Certificate;
  try {
    certificate = parseX509Certificate(detail.certificateDer, {
      maxBytes: options.maxAsn1Bytes,
      maxDepth: options.maxAsn1Depth,
    });
  } catch (error) {
    const message = isCryptoError(error) ? error.message : '签章者证书结构非法';
    return {
      math: {
        status: 'invalid',
        algorithm: algorithmName,
        sm2UserId: options.sm2UserId,
      },
      issues: [
        {
          code: 'CRYPTO_CERTIFICATE_INVALID',
          message: `签章者证书解析失败：${message}`,
          severity: 'error',
        },
      ],
    };
  }

  if (detail.signatureAlgorithmOid !== OID_SM3_WITH_SM2) {
    return {
      math: {
        status: 'unsupported',
        algorithm: algorithmName,
        sm2UserId: options.sm2UserId,
      },
      signerCertificate: certificate,
      issues: [
        {
          code: 'CRYPTO_UNSUPPORTED_ALGORITHM',
          message: `不支持的签章签名算法：${algorithmName}`,
          severity: 'error',
        },
      ],
    };
  }

  let verified = false;
  try {
    verified = sm2Verify(detail.tbsRaw, detail.signature, certificate.publicKey, {
      userId: options.sm2UserId,
    });
  } catch (error) {
    const message = error instanceof CryptoError ? error.message : 'SM2 验签异常';
    return {
      math: {
        status: 'invalid',
        algorithm: algorithmName,
        sm2UserId: options.sm2UserId,
      },
      signerCertificate: certificate,
      issues: [
        {
          code: 'CRYPTO_SIGNATURE_INVALID',
          message: `签章签名值校验失败：${message}`,
          severity: 'error',
        },
      ],
    };
  }

  return {
    math: {
      status: verified ? 'valid' : 'invalid',
      algorithm: algorithmName,
      sm2UserId: options.sm2UserId,
    },
    signerCertificate: certificate,
    issues: verified
      ? []
      : [
          {
            code: 'CRYPTO_SIGNATURE_INVALID',
            message: '签章签名值与 TBS_Sign 原文不匹配',
            severity: 'error',
          },
        ],
  };
}