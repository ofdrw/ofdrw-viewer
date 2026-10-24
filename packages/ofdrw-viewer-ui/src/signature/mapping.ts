/**
 * crypto 解析结果 → UI 展示模型。
 *
 * UI 不再解析 ASN.1；这里只做字段改名与 DN/算法友好名映射，证书摘要为主。
 * 签名者证书 DER 仅随详情透传用于下载，不写入阅读器持久状态。
 */

import type {
  CertificateSummary,
  ParsedSeal,
  ParsedSignedValue,
} from '@ofdrw/ofdrw-viewer-crypto';
import type {
  AlgorithmInfo,
  CertificateAttributes,
  CertificateInfo,
  SealInfo,
  SignerInfo,
} from '../types';

/** 常见签名/公钥算法：crypto 名称 → UI OID 与展示名。 */
const ALGORITHMS: Readonly<
  Record<string, { readonly oid: string; readonly name: string }>
> = Object.freeze({
  SM3withSM2: { oid: '1.2.156.10197.1.501', name: 'SM2-with-SM3' },
  'SM2-with-SM3': { oid: '1.2.156.10197.1.501', name: 'SM2-with-SM3' },
  SM2: { oid: '1.2.156.10197.1.301', name: 'SM2' },
  SM3: { oid: '1.2.156.10197.1.401', name: 'SM3' },
  EC: { oid: '1.2.840.10045.2.1', name: 'EC' },
  ECDSAwithSHA256: { oid: '1.2.840.10045.4.3.2', name: 'ECDSA-with-SHA256' },
  ECDSAwithSHA384: { oid: '1.2.840.10045.4.3.3', name: 'ECDSA-with-SHA384' },
  RSA: { oid: '1.2.840.113549.1.1.1', name: 'RSA' },
  SHA1withRSA: { oid: '1.2.840.113549.1.1.5', name: 'SHA1-with-RSA' },
  SHA256withRSA: { oid: '1.2.840.113549.1.1.11', name: 'SHA256-with-RSA' },
  SHA384withRSA: { oid: '1.2.840.113549.1.1.12', name: 'SHA384-with-RSA' },
});

/** DN 属性短名 → UI 字段。 */
const DN_KEYS: Readonly<Record<string, keyof CertificateAttributes>> = Object.freeze({
  CN: 'cn',
  O: 'o',
  OU: 'ou',
  C: 'c',
  ST: 'st',
  L: 'l',
  E: 'email',
  EMAILADDRESS: 'email',
  SERIALNUMBER: 'serialNumber',
});

/**
 * 证书摘要 → UI 证书信息。
 *
 * @param summary crypto 证书摘要。
 * @returns UI 证书信息；未提供时 undefined。
 */
export function toCertificateInfo(
  summary: CertificateSummary | undefined,
): CertificateInfo | undefined {
  if (!summary) return undefined;
  const attributes = parseSubject(summary.subject);
  const signatureAlgorithm = toAlgorithm(summary.signatureAlgorithm);
  const publicKeyAlgorithm = toAlgorithm(summary.publicKeyAlgorithm);
  return {
    subject: summary.subject,
    issuer: summary.issuer,
    serialNumber: summary.serialNumber,
    notBefore: summary.notBefore,
    notAfter: summary.notAfter,
    ...(Object.keys(attributes).length > 0 ? { subjectAttributes: attributes } : {}),
    ...(signatureAlgorithm ? { signatureAlgorithm } : {}),
    ...(publicKeyAlgorithm ? { publicKeyAlgorithm } : {}),
  };
}

/**
 * 解析 SignedValue → UI 签章者信息。
 *
 * @param parsed crypto 解析结果。
 * @param fallbackTime 引擎 `signatureDateTime` 回退值。
 * @returns UI 签章者信息；字段缺失时省略。
 */
export function toSignerInfo(
  parsed: ParsedSignedValue,
  fallbackTime: string | undefined,
): SignerInfo {
  const certificate = toCertificateInfo(parsed.certificate);
  const algorithm = toAlgorithm(parsed.signatureAlgorithm);
  const signedAt = parsed.signedAt ?? fallbackTime;
  const signedAtSource = parsed.signedAt
    ? 'timeInfo'
    : fallbackTime
      ? 'signatureDateTime'
      : undefined;
  return {
    ...(certificate ? { certificate } : {}),
    ...(parsed.certificateDer ? { certificateDer: parsed.certificateDer } : {}),
    ...(signedAt ? { signedAt } : {}),
    ...(signedAtSource ? { signedAtSource } : {}),
    ...(algorithm ? { algorithm } : {}),
    dataHash: parsed.dataHash,
    timestampPresent: parsed.timestamp.status === 'parsed-not-verified',
  };
}

/**
 * 解析电子印章 → UI 印章信息。
 *
 * @param parsed crypto 印章解析结果。
 * @returns UI 印章信息。
 */
export function toSealInfo(parsed: ParsedSeal | undefined): SealInfo | undefined {
  if (!parsed) return undefined;
  const certificate = toCertificateInfo(
    parsed.certificates?.[0] ?? parsed.makerCertificate,
  );
  const typeLabel = sealTypeLabel(parsed.typeCode);
  return {
    version: parsed.version,
    ...(parsed.esId ? { esId: parsed.esId } : {}),
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.typeCode !== undefined ? { typeCode: parsed.typeCode } : {}),
    ...(typeLabel ? { typeLabel } : {}),
    ...(parsed.createDate ? { createDate: parsed.createDate } : {}),
    ...(parsed.validStart ? { validStart: parsed.validStart } : {}),
    ...(parsed.validEnd ? { validEnd: parsed.validEnd } : {}),
    ...(certificate ? { certificate } : {}),
    ...(parsed.picture
      ? {
          image: {
            format: parsed.picture.type,
            widthMm: parsed.picture.widthMm,
            heightMm: parsed.picture.heightMm,
            data: parsed.picture.data,
          },
        }
      : {}),
  };
}

/**
 * 算法名 → UI 算法信息。
 *
 * @param name crypto 算法名。
 * @returns OID/名称；未知算法仅保留名称，无名称时 undefined。
 */
export function toAlgorithm(name: string | undefined): AlgorithmInfo | undefined {
  if (!name) return undefined;
  const known = ALGORITHMS[name];
  if (known) return { oid: known.oid, name: known.name };
  return { oid: '', name };
}

/**
 * 解析 DN 文本中的常用属性。
 *
 * @param subject `CN=a,O=b` 形式文本。
 * @returns 属性集合；无法解析时为空对象。
 */
export function parseSubject(subject: string): CertificateAttributes {
  const attributes: Record<string, string> = {};
  for (const part of splitDn(subject)) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toUpperCase();
    const value = part.slice(index + 1).trim();
    if (!key || !value) continue;
    const mapped = DN_KEYS[key];
    if (!mapped || attributes[mapped]) continue;
    attributes[mapped] = value;
  }
  return attributes as CertificateAttributes;
}

/** 取 DN 的 CN；用于印章签名者展示。 */
export function subjectCN(subject: string | undefined): string | undefined {
  if (!subject) return undefined;
  return parseSubject(subject).cn;
}

/** 按未转义逗号切分 DN。 */
function splitDn(subject: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of subject) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/** 印章类型文案。 */
function sealTypeLabel(typeCode: number | undefined): string | undefined {
  if (typeCode === 1) return '单位印章';
  if (typeCode === 2) return '个人印章';
  return typeCode === undefined ? undefined : '未知';
}