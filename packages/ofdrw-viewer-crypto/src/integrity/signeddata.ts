/**
 * GB/T 35275 SignedData 签名值验证（防夹带完整性签名）。
 *
 * 支持：
 * - `SignedDataBuilder` 生成的无 authenticatedAttributes 形态：
 *   eContent = SM3(OFDEntries.xml)，签名对象为 eContent；
 * - PKCS#9 authenticatedAttributes 形态（GM/T 0099 兼容）：
 *   签名对象为 DER SET OF Attribute，校验 messageDigest/contentType 属性；
 * - eContent 可以是原始摘要，也可以是 Base64 摘要文本（历史实现兼容）。
 *
 * 不变量：签名数学验证使用输入的原始 DER 字节，不重新序列化。
 */

import { CryptoError } from '../errors';
import { DER_TAG, parseDer, type DerNode, type DerParseOptions } from '../asn1/der';
import {
  OID_GM_DATA,
  OID_GM_SIGNED_DATA,
  OID_PKCS7_DATA,
  OID_PKCS7_SIGNED_DATA,
  OID_PKCS9_CONTENT_TYPE,
  OID_PKCS9_MESSAGE_DIGEST,
  OID_SM2_SIGN,
  OID_SM3,
  OID_SM3_WITH_SM2,
  isSignedDataContentType,
  oidName,
} from '../asn1/oid';
import { parseX509Certificate, type X509Certificate } from '../asn1/x509';
import { toCertificateSummary } from '../cert/summary';
import { sm2Verify } from '../sm/sm2';
import { sm3Digest } from '../sm/sm3';
import type { CertificateSummary } from '../types/certificate';
import type { VerificationIssue, VerificationStatus } from '../types/status';
import { bytesEqual, toHex, tryFromBase64, utf8Decode } from '../util/bytes';

/** SignedData 验证选项。 */
export interface Gbt35275VerifyOptions {
  /** ASN.1 字节上限，单位 byte。 */
  readonly maxAsn1Bytes: number;
  /** ASN.1 深度上限，单位层。 */
  readonly maxAsn1Depth: number;
  /** SM2 userId。 */
  readonly sm2UserId: string;
  /** 证书数量上限。 */
  readonly maxCertificates: number;
}

/** SignedData 验证结果（内部）。 */
export interface Gbt35275VerifyResult {
  /** 验签状态。 */
  readonly status: VerificationStatus;
  /** 是否包含 authenticatedAttributes。 */
  readonly authenticatedAttributes: boolean;
  /** 匹配到的签名者证书。 */
  readonly certificate?: X509Certificate;
  /** SignedData 内嵌的全部证书（含中间证书）。 */
  readonly certificates: readonly X509Certificate[];
  /** 证书摘要（报告用）。 */
  readonly certificateSummary?: CertificateSummary;
  /** eContent / messageDigest 摘要（小写十六进制）。 */
  readonly digest?: string;
  /** 问题列表。 */
  readonly issues: readonly VerificationIssue[];
}

/** 可接受的签名算法 OID。 */
const SIGNATURE_ALGORITHMS = new Set([OID_SM3_WITH_SM2, OID_SM2_SIGN]);

/**
 * 验证 GB/T 35275 SignedData。
 *
 * @param data SignedValue.dat（CMS ContentInfo）字节。
 * @param tbsContent 被保护原文（OFDEntries.xml 字节）。
 * @param options 上限与 userId。
 * @returns 验签结果；不抛异常（结构错误写入 issues）。
 */
export function verifyGbt35275SignedData(
  data: Uint8Array,
  tbsContent: Uint8Array,
  options: Gbt35275VerifyOptions,
): Gbt35275VerifyResult {
  const issues: VerificationIssue[] = [];
  const derOptions: DerParseOptions = {
    maxBytes: options.maxAsn1Bytes,
    maxDepth: options.maxAsn1Depth,
  };
  let unsupported = false;

  try {
    const root = parseDer(data, derOptions).requireSequence('ContentInfo');
    const contentType = root.children[0]?.asOid();
    if (!contentType || !isSignedDataContentType(contentType)) {
      return fail(
        `SignedData contentType 不受支持：${contentType ?? '缺失'}`,
        issues,
        'unsupported',
      );
    }
    const contentWrapper = root.children[1];
    if (!contentWrapper || !contentWrapper.isContext(0)) {
      return fail('ContentInfo 缺少 [0] 内容', issues, 'invalid');
    }
    const signedData = contentWrapper.children[0]?.requireSequence('SignedData');
    if (!signedData) return fail('ContentInfo 内容不是 SignedData', issues, 'invalid');

    const expectedDigest = sm3Digest(tbsContent);
    const certificates = readCertificates(
      signedData.findContext(0),
      derOptions,
      options.maxCertificates,
    );
    const digestAlgorithms = signedData.children[1];
    if (!digestAlgorithms || !isSm3Set(digestAlgorithms)) {
      issues.push(
        issue(
          'INTEGRITY_DIGEST_ALGORITHM_UNSUPPORTED',
          'SignedData digestAlgorithms 不是 SM3',
          'error',
        ),
      );
      return fail('SignedData digestAlgorithms 不是 SM3', issues, 'unsupported', certificates);
    }

    const encap = signedData.children[2];
    const eContentType = encap?.children[0]?.asOid();
    if (
      !encap ||
      !eContentType ||
      (eContentType !== OID_GM_DATA && eContentType !== OID_PKCS7_DATA)
    ) {
      return fail(
        `encapContentInfo.eContentType 不是 data：${eContentType ? oidName(eContentType) : '缺失'}`,
        issues,
        'invalid',
        certificates,
      );
    }
    const eContent = readEContent(encap);
    const signerInfos = readSignerInfos(signedData);
    if (signerInfos.length === 0) {
      return fail('SignedData 缺少 SignerInfo', issues, 'invalid', certificates);
    }

    let authenticatedAttributes = false;
    let matchedCertificate: X509Certificate | undefined;
    let signatureValid = true;
    let digestValue: string | undefined;
    let seeInvalid = false;

    for (const signerInfo of signerInfos) {
      const signer = parseSignerInfo(signerInfo, derOptions);
      if (signer.authenticatedAttributes) authenticatedAttributes = true;
      const certificate = matchCertificate(certificates, signer, derOptions);
      if (signer.digestAlgorithm !== OID_SM3) {
        unsupported = true;
        matchedCertificate ??= certificate;
        issues.push(
          issue(
            'INTEGRITY_DIGEST_ALGORITHM_UNSUPPORTED',
            `SignerInfo.digestAlgorithm 不是 SM3：${oidName(signer.digestAlgorithm)}`,
            'error',
          ),
        );
        continue;
      }
      if (!SIGNATURE_ALGORITHMS.has(signer.signatureAlgorithm)) {
        unsupported = true;
        matchedCertificate ??= certificate;
        issues.push(
          issue(
            'INTEGRITY_UNSUPPORTED_ALGORITHM',
            `不支持的完整性签名算法：${oidName(signer.signatureAlgorithm)}`,
            'error',
          ),
        );
        continue;
      }
      if (!certificate) {
        seeInvalid = true;
        issues.push(issue('INTEGRITY_CERT_MISSING', 'SignerInfo 未匹配到证书', 'error'));
        continue;
      }
      matchedCertificate ??= certificate;

      // 摘要一致性：无 authAttrs 时签名对象必须是 SM3(原文)。
      if (!signer.authenticatedAttributes) {
        if (!eContent) {
          seeInvalid = true;
          issues.push(
            issue('INTEGRITY_DIGEST_MISSING', 'SignedData 缺少 eContent 与 authenticatedAttributes', 'error'),
          );
          continue;
        }
        const contentDigest = normalizeEContentDigest(eContent);
        digestValue = toHex(contentDigest ?? eContent);
        if (!contentDigest || !bytesEqual(contentDigest, expectedDigest)) {
          seeInvalid = true;
          issues.push(
            issue('INTEGRITY_DIGEST_MISMATCH', 'eContent 摘要与 OFDEntries.xml 的 SM3 不一致', 'error'),
          );
          continue;
        }
      } else {
        const messageDigest = readAttributeValue(
          signer.authenticatedAttributes,
          OID_PKCS9_MESSAGE_DIGEST,
          derOptions,
        );
        if (!messageDigest || !messageDigest.isUniversal(DER_TAG.OCTET_STRING)) {
          seeInvalid = true;
          issues.push(issue('INTEGRITY_AUTH_ATTR_INVALID', 'authenticatedAttributes 缺少 messageDigest', 'error'));
          continue;
        }
        const digestBytes = messageDigest.asOctets();
        digestValue = toHex(digestBytes);
        // eContent 存在时必须对 eContent 原始字节做 SM3；不存在时才回退到清单摘要。
        const allowed = eContent
          ? bytesEqual(digestBytes, sm3Digest(eContent))
          : bytesEqual(digestBytes, expectedDigest);
        if (!allowed) {
          seeInvalid = true;
          issues.push(
            issue(
              'INTEGRITY_DIGEST_MISMATCH',
              eContent
                ? 'messageDigest 与 eContent 的 SM3 不一致'
                : 'messageDigest 与 OFDEntries.xml 的 SM3 不一致',
              'error',
            ),
          );
          continue;
        }
        if (eContent) {
          const normalized = normalizeEContentDigest(eContent);
          const tied =
            bytesEqual(eContent, tbsContent) ||
            (normalized !== undefined && bytesEqual(normalized, expectedDigest));
          if (!tied) {
            seeInvalid = true;
            issues.push(
              issue(
                'INTEGRITY_CONTENT_MISMATCH',
                'eContent 与 OFDEntries.xml 不一致',
                'error',
              ),
            );
            continue;
          }
        }
        const contentTypeAttribute = readAttributeValue(
          signer.authenticatedAttributes,
          OID_PKCS9_CONTENT_TYPE,
          derOptions,
        );
        if (!contentTypeAttribute) {
          seeInvalid = true;
          issues.push(
            issue('INTEGRITY_AUTH_ATTR_INVALID', 'authenticatedAttributes 缺少 contentType', 'error'),
          );
          continue;
        }
        const attributeOid = contentTypeAttribute.asOid();
        if (attributeOid !== OID_GM_DATA && attributeOid !== OID_PKCS7_DATA) {
          seeInvalid = true;
          issues.push(
            issue(
              'INTEGRITY_AUTH_ATTR_INVALID',
              `contentType 属性不是 data：${oidName(attributeOid)}`,
              'error',
            ),
          );
          continue;
        }
      }

      const signedBytes = signer.authenticatedAttributes
        ? toSignedAttributesSet(signer.authenticatedAttributes)
        : eContent ?? new Uint8Array(0);
      let verified = false;
      try {
        verified = sm2Verify(signedBytes, signer.signature, certificate.publicKey, {
          userId: options.sm2UserId,
        });
      } catch {
        verified = false;
      }
      if (!verified) {
        seeInvalid = true;
        issues.push(issue('INTEGRITY_SIGNATURE_INVALID', '完整性签名值与签名原文不匹配', 'error'));
      }
    }

    if (seeInvalid) signatureValid = false;
    const status: VerificationStatus = signatureValid
      ? unsupported
        ? 'unsupported'
        : 'valid'
      : 'invalid';
    return {
      status,
      authenticatedAttributes,
      certificate: matchedCertificate,
      certificates,
      certificateSummary: matchedCertificate
        ? toCertificateSummary(matchedCertificate)
        : undefined,
      digest: digestValue,
      issues,
    };
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : 'SignedData 结构非法',
      issues,
      'invalid',
    );
  }
}

/** SignerInfo 解析结果。 */
interface ParsedSignerInfo {
  /** 颁发者 DN 原始 DER。 */
  readonly issuerRaw: Uint8Array;
  /** 证书序列号（小写十六进制，无前导零）。 */
  readonly serialNumber: string;
  /** 摘要算法 OID。 */
  readonly digestAlgorithm: string;
  /** 签名算法 OID。 */
  readonly signatureAlgorithm: string;
  /** 签名值。 */
  readonly signature: Uint8Array;
  /** authenticatedAttributes IMPLICIT SET OF Attribute 节点。 */
  readonly authenticatedAttributes?: DerNode;
}

/**
 * 解析 SignerInfo。
 *
 * @param node SignerInfo SEQUENCE。
 * @param derOptions DER 解析上限。
 * @returns 解析结果。
 */
function parseSignerInfo(node: DerNode, derOptions: DerParseOptions): ParsedSignerInfo {
  const sequence = node.requireSequence('SignerInfo');
  const issuerAndSerial = sequence.children[1]?.requireSequence('IssuerAndSerialNumber');
  if (!issuerAndSerial || issuerAndSerial.children.length < 2) {
    throw new CryptoError('CRYPTO_ASN1_INVALID', 'SignerInfo 缺少 IssuerAndSerialNumber');
  }
  const issuerRaw = issuerAndSerial.children[0].raw;
  const serialNumber = issuerAndSerial.children[1].asInteger().toString(16);
  let index = 2;
  const digestAlgorithmNode = sequence.children[index];
  if (!digestAlgorithmNode?.isUniversal(DER_TAG.SEQUENCE)) {
    throw new CryptoError('CRYPTO_ASN1_INVALID', 'SignerInfo 缺少 digestAlgorithm');
  }
  const digestAlgorithm = digestAlgorithmNode.children[0]?.asOid();
  if (!digestAlgorithm) throw new CryptoError('CRYPTO_ASN1_INVALID', 'digestAlgorithm 为空');
  index += 1;
  let authenticatedAttributes: DerNode | undefined;
  if (sequence.children[index]?.isContext(0)) {
    authenticatedAttributes = sequence.children[index];
    index += 1;
  }
  const algorithmNode = sequence.children[index]?.requireSequence('signatureAlgorithm');
  if (!algorithmNode) throw new CryptoError('CRYPTO_ASN1_INVALID', 'SignerInfo 缺少签名算法');
  const signatureAlgorithm = algorithmNode.children[0]?.asOid();
  if (!signatureAlgorithm) throw new CryptoError('CRYPTO_ASN1_INVALID', 'SignerInfo 签名算法为空');
  index += 1;
  const digestNode = sequence.children[index];
  if (!digestNode) throw new CryptoError('CRYPTO_ASN1_INVALID', 'SignerInfo 缺少 encryptedDigest');
  const signature = digestNode.asOctets();
  return {
    issuerRaw,
    serialNumber,
    digestAlgorithm,
    signatureAlgorithm,
    signature,
    authenticatedAttributes,
  };
}

/**
 * 匹配 SignerInfo 对应证书。
 *
 * @param certificates 证书列表。
 * @param signer SignerInfo。
 * @returns 匹配证书；没有时 undefined。
 */
function matchCertificate(
  certificates: readonly X509Certificate[],
  signer: ParsedSignerInfo,
  derOptions: DerParseOptions,
): X509Certificate | undefined {
  return certificates.find(
    (certificate) =>
      certificate.serialNumber.replace(/^0+/, '') === signer.serialNumber.replace(/^0+/, '') &&
      sameBytesRaw(certificateIssuerRaw(certificate, derOptions), signer.issuerRaw),
  );
}

/**
 * 提取证书 issuer Name 的原始 DER。
 *
 * @param certificate 证书。
 * @param derOptions DER 解析上限。
 * @returns issuer 原始 TLV。
 * @throws CryptoError `CRYPTO_ASN1_INVALID`。
 */
function certificateIssuerRaw(
  certificate: X509Certificate,
  derOptions: DerParseOptions,
): Uint8Array {
  const root = parseDer(certificate.der, derOptions).requireSequence('Certificate');
  const tbs = root.children[0]?.requireSequence('TBSCertificate');
  if (!tbs) throw new CryptoError('CRYPTO_ASN1_INVALID', '证书缺少 TBSCertificate');
  const start = tbs.children[0]?.isContext(0) ? 1 : 0;
  const issuer = tbs.children[start + 2];
  if (!issuer) throw new CryptoError('CRYPTO_ASN1_INVALID', '证书缺少 issuer');
  return issuer.raw;
}

/**
 * 读取 eContent。
 *
 * @param encap encapContentInfo 节点。
 * @returns eContent 字节；不存在时 undefined。
 */
function readEContent(encap: DerNode | undefined): Uint8Array | undefined {
  if (!encap || !encap.isUniversal(DER_TAG.SEQUENCE)) return undefined;
  const wrapper = encap.children[1];
  if (!wrapper) return undefined;
  if (wrapper.isContext(0)) {
    const inner = wrapper.children[0];
    return inner?.isUniversal(DER_TAG.OCTET_STRING) ? inner.asOctets() : wrapper.value;
  }
  if (wrapper.isUniversal(DER_TAG.OCTET_STRING)) return wrapper.asOctets();
  return undefined;
}

/**
 * 归一化 eContent 摘要：原始 32 byte 或 Base64 文本。
 *
 * @param eContent eContent 字节。
 * @returns 32 byte 摘要；无法识别时 undefined。
 */
function normalizeEContentDigest(eContent: Uint8Array): Uint8Array | undefined {
  if (eContent.length === 32) return eContent;
  const text = utf8Decode(eContent).trim();
  const base64 = tryFromBase64(text);
  if (base64 && base64.length === 32) return base64;
  return undefined;
}

/**
 * 判断 digestAlgorithms SET 是否包含 SM3。
 *
 * @param set SET 节点。
 * @returns 包含返回 true。
 */
function isSm3Set(set: DerNode): boolean {
  if (!set.isUniversal(DER_TAG.SET)) return false;
  return set.children.some((algorithm) => {
    try {
      return algorithm.children[0]?.asOid() === OID_SM3;
    } catch {
      return false;
    }
  });
}

/**
 * 读取 SignedData.certificates。
 *
 * @param node [0] 节点。
 * @param derOptions DER 解析上限。
 * @param maxCertificates 证书数量上限。
 * @returns 证书列表。
 */
function readCertificates(
  node: DerNode | undefined,
  derOptions: DerParseOptions,
  maxCertificates: number,
): readonly X509Certificate[] {
  if (!node) return [];
  let list: readonly DerNode[] = node.children;
  if (list.length === 1 && list[0].isUniversal(DER_TAG.SET)) list = list[0].children;
  if (list.length > maxCertificates) {
    throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', `SignedData 证书数量超过上限 ${maxCertificates}`);
  }
  const certificates: X509Certificate[] = [];
  for (const item of list) {
    if (!item.isUniversal(DER_TAG.SEQUENCE)) continue;
    try {
      certificates.push(parseX509Certificate(item.raw, derOptions));
    } catch {
      // 单张证书非法不影响其他证书；后续按“未匹配到证书”处理。
    }
  }
  return certificates;
}

/**
 * 读取 signerInfos。
 *
 * @param signedData SignedData 节点。
 * @returns SignerInfo 节点列表。
 */
function readSignerInfos(signedData: DerNode): readonly DerNode[] {
  for (let index = signedData.children.length - 1; index >= 0; index -= 1) {
    const child = signedData.children[index];
    if (child.isUniversal(DER_TAG.SET)) return child.children;
  }
  return [];
}

/**
 * 读取 authenticatedAttributes 中的属性值。
 *
 * @param authenticatedAttributes [0] IMPLICIT SET 节点。
 * @param oid 属性 OID。
 * @param derOptions DER 解析上限。
 * @returns 属性值节点；不存在时 undefined。
 */
function readAttributeValue(
  authenticatedAttributes: DerNode | undefined,
  oid: string,
  derOptions: DerParseOptions,
): DerNode | undefined {
  if (!authenticatedAttributes) return undefined;
  for (const attribute of authenticatedAttributes.children) {
    const sequence = attribute.requireSequence('Attribute');
    if (sequence.children[0]?.asOid() !== oid) continue;
    const values = sequence.children[1];
    if (!values) return undefined;
    return values.children[0];
  }
  return undefined;
}

/**
 * 把 [0] IMPLICIT SET 还原为 DER SET 用于验签。
 *
 * @param node authenticatedAttributes 节点。
 * @returns 以 0x31 开头的 DER 字节。
 */
function toSignedAttributesSet(node: DerNode): Uint8Array {
  const bytes = new Uint8Array(node.raw);
  if (bytes.length > 0 && (bytes[0] & 0xe0) === 0xa0) bytes[0] = 0x31;
  return bytes;
}

/**
 * 比较原始字节。
 *
 * @param a 字节 A。
 * @param b 字节 B。
 * @returns 相同返回 true。
 */
function sameBytesRaw(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 构造失败结果。
 *
 * @param message 诊断信息。
 * @param issues 问题收集器。
 * @param status 状态。
 * @returns 失败结果。
 */
function fail(
  message: string,
  issues: VerificationIssue[],
  status: VerificationStatus,
  certificates: readonly X509Certificate[] = [],
): Gbt35275VerifyResult {
  issues.push(issue('INTEGRITY_SIGNATURE_INVALID', message, 'error'));
  return { status, authenticatedAttributes: false, certificates, issues };
}

/**
 * 构造问题条目。
 *
 * @param code 问题码。
 * @param message 诊断信息。
 * @param severity 级别。
 * @returns 问题。
 */
function issue(
  code: string,
  message: string,
  severity: 'error' | 'warning',
): VerificationIssue {
  return { code, message, severity };
}