/**
 * SES 签名值（SignedValue.dat）解析。
 *
 * 支持三种电子签章数据版本：
 * - v1（GM/T 0031-2014）：`SEQUENCE { TBS_Sign, signature BIT STRING }`；
 * - v4（GB/T 38540-2020）：`SEQUENCE { TBS_Sign, cert OCTET STRING, signAlgID OID,
 *   signature BIT STRING, [0] timeStamp OPTIONAL }`；
 * - v5（GM/T 0031-2025）：与 v4 相同，通过 TBS_Sign.version=5 区分。
 *
 * TBS_Sign 原文（`tbsRaw`）必须保留输入字节用于 SM2 验签，禁止重新序列化。
 * 本模块只解析，不验签；验签/链校验由 `verify` 模块完成。
 */

import { CryptoError, isCryptoError } from '../errors';
import {
  DER_TAG,
  parseDer,
  type DerNode,
  type DerParseOptions,
} from '../asn1/der';
import { oidName } from '../asn1/oid';
import { parseX509Certificate } from '../asn1/x509';
import { toCertificateSummary } from '../cert/summary';
import { parseSeal, readOptionalContextBitString, type ParsedSeal, type SesVersion } from '../seal/parse';
import { parseTimestamp, type TimestampParseResult } from '../timestamp';
import type { CertificateSummary } from '../types/certificate';
import type { ParseOptions } from '../types/options';
import { copyBytes, utf8Decode } from '../util/bytes';
import { resolveParseOptions } from '../util/options';

/** SignedValue.dat 公开解析结果。 */
export interface ParsedSignedValue {
  /** 数据结构版本。 */
  readonly version: SesVersion;
  /** 签章者证书摘要。 */
  readonly certificate?: CertificateSummary;
  /** 签名算法名称（例如 `SM3withSM2`）。 */
  readonly signatureAlgorithm?: string;
  /**
   * 签章时间。
   *
   * v4/v5 为 ISO 8601；v1 的 timeInfo 是自由文本，原样透出。
   */
  readonly signedAt?: string;
  /** TBS_Sign.dataHash（小写十六进制），即 Signature.xml 的 SM3 摘要。 */
  readonly dataHash: string;
  /** 内嵌电子印章解析结果。 */
  readonly seal?: ParsedSeal;
  /** 时间戳解析结果（只解析不验证）。 */
  readonly timestamp: TimestampParseResult;
  /** SignedValue.dat 字节长度，单位 byte。 */
  readonly byteLength: number;
}

/**
 * 内部 SES 签名值详细结构。
 *
 * 保留 TBS/印章/证书/签名原始字节，供验签与证书链校验使用。
 */
export interface SesSignatureDetail {
  /** 版本。 */
  readonly version: 'v1' | 'v4' | 'v5';
  /** 完整 SignedValue.dat DER。 */
  readonly raw: Uint8Array;
  /** TBS_Sign 原始 DER（SM2 验签原文）。 */
  readonly tbsRaw: Uint8Array;
  /** 内嵌 SESeal 原始 DER。 */
  readonly esealRaw: Uint8Array;
  /** dataHash 原始字节。 */
  readonly dataHash: Uint8Array;
  /** 原文属性信息（IA5String）。 */
  readonly propertyInfo: string;
  /** 签章者证书 DER。 */
  readonly certificateDer: Uint8Array;
  /** 签名算法 OID。 */
  readonly signatureAlgorithmOid: string;
  /** 签名值（DER `SEQUENCE { r, s }`）。 */
  readonly signature: Uint8Array;
  /** 签章时间展示文本（见 `ParsedSignedValue.signedAt`）。 */
  readonly signedAt?: string;
  /** v4/v5 可选时间戳原始字节。 */
  readonly timestampRaw?: Uint8Array;
}

/**
 * 解析 SignedValue.dat 为公开结构。
 *
 * @param data SignedValue.dat 字节。
 * @param options 大小/深度上限。
 * @returns 公开解析结果（含印章与时间戳解析）。
 * @throws CryptoError `CRYPTO_ASN1_INVALID` / `CRYPTO_UNSUPPORTED_SES_VERSION` /
 *   `CRYPTO_CERTIFICATE_INVALID`。
 */
export function parseSignedValue(
  data: Uint8Array,
  options?: ParseOptions,
): ParsedSignedValue {
  const detail = parseSesSignature(data, options);
  const resolved = resolveParseOptions(options);
  const certificate = parseSignerCertificate(detail.certificateDer, resolved);
  const seal = parseSeal(detail.esealRaw, options);
  const timestamp = detail.timestampRaw
    ? parseTimestamp(detail.timestampRaw, {
        maxBytes: resolved.maxBytes,
        maxDepth: resolved.maxDepth,
        signatureValue: detail.signature,
      })
    : emptyTimestamp();
  return {
    version: detail.version,
    certificate: toCertificateSummary(certificate),
    signatureAlgorithm: oidName(detail.signatureAlgorithmOid),
    signedAt: detail.signedAt,
    dataHash: hexOf(detail.dataHash),
    seal,
    timestamp,
    byteLength: detail.raw.length,
  };
}

/**
 * 解析 SignedValue.dat 详细结构（内部 API）。
 *
 * @param data SignedValue.dat 字节。
 * @param options 大小/深度上限。
 * @returns 含验签原文/签名值/证书的详细结构。
 * @throws CryptoError `CRYPTO_ASN1_INVALID` / `CRYPTO_UNSUPPORTED_SES_VERSION`。
 */
export function parseSesSignature(
  data: Uint8Array,
  options?: ParseOptions,
): SesSignatureDetail {
  if (!(data instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SignedValue 输入必须是 Uint8Array');
  }
  const resolved = resolveParseOptions(options);
  const derOptions = toDerOptions(resolved);
  const root = parseDer(data, derOptions).requireSequence('SES_Signature');
  const children = root.children;
  if (children.length === 2) return parseV1Signature(root, data, derOptions);
  if (children.length === 4 || children.length === 5) {
    return parseV4V5Signature(root, data, derOptions);
  }
  throw new CryptoError(
    'CRYPTO_UNSUPPORTED_SES_VERSION',
    `不支持的 SignedValue 顶层结构：${children.length} 个字段`,
  );
}

/**
 * 解析 v1 SignedValue。
 *
 * @param root 顶层 SEQUENCE。
 * @param raw 原始字节。
 * @param derOptions DER 解析上限。
 * @returns 详细结构。
 */
function parseV1Signature(
  root: DerNode,
  raw: Uint8Array,
  derOptions: DerParseOptions,
): SesSignatureDetail {
  const tbsNode = requiredChild(root, 0, 'TBS_Sign').requireSequence('TBS_Sign');
  if (tbsNode.children.length < 7) throw asn1Error('v1 TBS_Sign 字段不足');
  const versionNumber = Number(requiredChild(tbsNode, 0, 'version').asInteger());
  if (versionNumber !== 1) {
    throw new CryptoError(
      'CRYPTO_UNSUPPORTED_SES_VERSION',
      `v1 SignedValue 的 TBS_Sign.version 应为 1，实际为 ${versionNumber}`,
    );
  }
  const esealNode = requiredChild(tbsNode, 1, 'eseal');
  const timeInfoNode = requiredChild(tbsNode, 2, 'timeInfo');
  const dataHashNode = requiredChild(tbsNode, 3, 'dataHash');
  const propertyInfoNode = requiredChild(tbsNode, 4, 'propertyInfo');
  const certNode = requiredChild(tbsNode, 5, 'cert');
  const algNode = requiredChild(tbsNode, 6, 'signatureAlgorithm');
  const signatureNode = requiredChild(root, 1, 'signature');

  return {
    version: 'v1',
    raw,
    tbsRaw: tbsNode.raw,
    esealRaw: copyBytes(esealNode.raw),
    dataHash: copyBytes(readBinaryLike(dataHashNode, 'dataHash')),
    propertyInfo: propertyInfoNode.asString(),
    certificateDer: copyBytes(certNode.asOctets()),
    signatureAlgorithmOid: algNode.asOid(),
    signature: copyBytes(signatureNode.asBitStringOctets()),
    signedAt: decodeV1TimeInfo(timeInfoNode),
  };
}

/**
 * 解析 v4/v5 SignedValue。
 *
 * @param root 顶层 SEQUENCE。
 * @param raw 原始字节。
 * @param derOptions DER 解析上限。
 * @returns 详细结构。
 */
function parseV4V5Signature(
  root: DerNode,
  raw: Uint8Array,
  derOptions: DerParseOptions,
): SesSignatureDetail {
  const tbsNode = requiredChild(root, 0, 'TBS_Sign').requireSequence('TBS_Sign');
  if (tbsNode.children.length < 5) throw asn1Error('v4/v5 TBS_Sign 字段不足');
  const versionNumber = Number(requiredChild(tbsNode, 0, 'version').asInteger());
  if (versionNumber !== 4 && versionNumber !== 5) {
    throw new CryptoError(
      'CRYPTO_UNSUPPORTED_SES_VERSION',
      `v4/v5 SignedValue 的 TBS_Sign.version 应为 4/5，实际为 ${versionNumber}`,
    );
  }
  const timeInfoNode = requiredChild(tbsNode, 2, 'timeInfo');
  const signedAt = timeInfoNode.asTime().toISOString();
  const esealNode = requiredChild(tbsNode, 1, 'eseal');
  const dataHashNode = requiredChild(tbsNode, 3, 'dataHash');
  const propertyInfoNode = requiredChild(tbsNode, 4, 'propertyInfo');
  const certNode = requiredChild(root, 1, 'cert');
  const algNode = requiredChild(root, 2, 'signAlgID');
  const signatureNode = requiredChild(root, 3, 'signature');

  return {
    version: versionNumber === 5 ? 'v5' : 'v4',
    raw,
    tbsRaw: tbsNode.raw,
    esealRaw: copyBytes(esealNode.raw),
    dataHash: copyBytes(readBinaryLike(dataHashNode, 'dataHash')),
    propertyInfo: propertyInfoNode.asString(),
    certificateDer: copyBytes(certNode.asOctets()),
    signatureAlgorithmOid: algNode.asOid(),
    signature: copyBytes(signatureNode.asBitStringOctets()),
    signedAt,
    timestampRaw: readOptionalContextBitString(root.children[4]),
  };
}

/**
 * 解析签章者证书。
 *
 * @param der 证书 DER。
 * @param limits 解析上限。
 * @returns 证书结构。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`。
 */
function parseSignerCertificate(
  der: Uint8Array,
  limits: { readonly maxBytes: number; readonly maxDepth: number },
): ReturnType<typeof parseX509Certificate> {
  try {
    return parseX509Certificate(der, toDerOptions(limits));
  } catch (error) {
    if (isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CryptoError('CRYPTO_CERTIFICATE_INVALID', `签章者证书解析失败：${detail}`);
  }
}

/**
 * 读取 BIT STRING / OCTET STRING 的二进制内容。
 *
 * @param node ASN.1 节点。
 * @param label 字段名。
 * @returns 字节。
 */
function readBinaryLike(node: DerNode, label: string): Uint8Array {
  if (node.isUniversal(DER_TAG.BIT_STRING)) return node.asBitStringOctets();
  if (node.isUniversal(DER_TAG.OCTET_STRING)) return node.asOctets();
  throw asn1Error(`${label} 必须是 BIT STRING 或 OCTET STRING`);
}

/**
 * 解码 v1 timeInfo。
 *
 * v1 允许 BIT STRING 包裹 UTF-8 时间文本或 ASN.1 UTC/GeneralizedTime。
 *
 * @param node timeInfo 节点。
 * @returns 展示文本；无法识别时 undefined。
 */
function decodeV1TimeInfo(node: DerNode): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = readBinaryLike(node, 'timeInfo');
  } catch {
    return undefined;
  }
  if (bytes.length === 0) return undefined;
  if (bytes[0] === DER_TAG.UTC_TIME || bytes[0] === DER_TAG.GENERALIZED_TIME) {
    try {
      return parseDer(bytes).asTime().toISOString();
    } catch {
      // 继续按文本解码。
    }
  }
  const text = utf8Decode(bytes).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * 空时间戳结果。
 *
 * @returns not-present 结果。
 */
function emptyTimestamp(): TimestampParseResult {
  return {
    status: 'not-present',
    tokenPresent: false,
    tokenLength: 0,
    note: '已解析，未验证',
  };
}

/**
 * 读取必需子节点。
 *
 * @param parent 父节点。
 * @param index 子节点下标。
 * @param label 字段名，用于错误信息。
 * @returns 子节点。
 */
function requiredChild(parent: DerNode, index: number, label: string): DerNode {
  const child = parent.children[index];
  if (!child) throw asn1Error(`${label} 缺失`);
  return child;
}

/**
 * 转换为 DER 解析选项。
 *
 * @param limits 解析上限。
 * @returns DER 解析选项。
 */
function toDerOptions(limits: {
  readonly maxBytes: number;
  readonly maxDepth: number;
}): DerParseOptions {
  return { maxBytes: limits.maxBytes, maxDepth: limits.maxDepth };
}

/**
 * 构造 ASN.1 结构错误。
 *
 * @param message 诊断信息。
 * @returns CryptoError。
 */
function asn1Error(message: string): CryptoError {
  return new CryptoError('CRYPTO_ASN1_INVALID', `SignedValue 解析失败：${message}`);
}

/**
 * 字节转小写十六进制。
 *
 * @param bytes 字节。
 * @returns 小写十六进制。
 */
function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}