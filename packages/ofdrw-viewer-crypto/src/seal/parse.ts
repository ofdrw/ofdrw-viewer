/**
 * 电子印章（SESeal）解析。
 *
 * 支持 GM/T 0031-2014（v1）与 GB/T 38540-2020 / GM/T 0031-2025（v4/v5）三种
 * `SESeal` 布局：
 * - v1：`SEQUENCE { SES_SealInfo, SES_SignInfo }`，制章人证书/算法/签名在内层；
 * - v4/v5：`SEQUENCE { SES_SealInfo, cert OCTET STRING, signAlgID OID,
 *   signedValue BIT STRING, [0] timeStamp OPTIONAL }`。
 *
 * 本模块只解析结构，不校验证书链；验签与链校验由 sign/verify 模块完成。
 * 解析成功不代表印章有效，公共结果类型不含任何“验证通过”语义。
 */

import { CryptoError, isCryptoError } from '../errors';
import {
  DER_TAG,
  derSequence,
  parseDer,
  type DerNode,
  type DerParseOptions,
} from '../asn1/der';
import { oidName } from '../asn1/oid';
import { parseX509Certificate, type X509Certificate } from '../asn1/x509';
import { toCertificateSummary } from '../cert/summary';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import type { CertificateSummary } from '../types/certificate';
import type { ParseOptions } from '../types/options';
import type { VerificationIssue } from '../types/status';
import { parseTimestamp, type TimestampParseResult } from '../timestamp';
import { copyBytes } from '../util/bytes';
import { resolveParseOptions } from '../util/options';

/** SES 版本；`unknown` 仅用于公共结果兼容，解析失败会抛 typed error。 */
export type SesVersion = 'v1' | 'v4' | 'v5' | 'unknown';

/** SESeal 解析选项：在通用 ASN.1 上限上补充证书数量上限。 */
export interface SealParseOptions extends ParseOptions {
  /** certList 证书数量上限，单位张；默认 `DEFAULT_CRYPTO_LIMITS.maxCertificates`。 */
  readonly maxCertificates?: number;
}

/** SESeal 解析上限（ASN.1 大小/深度 + 证书数量）。 */
interface SealParseLimits {
  /** 输入字节上限，单位 byte。 */
  readonly maxBytes: number;
  /** ASN.1 嵌套深度上限，单位层。 */
  readonly maxDepth: number;
  /** certList 证书数量上限，单位张。 */
  readonly maxCertificates: number;
}

/**
 * 解析 SESeal 专用选项：在通用 ASN.1 上限上补充证书数量上限。
 *
 * @param options 公共解析选项。
 * @returns 完整解析上限。
 * @throws CryptoError `CRYPTO_INVALID_ARGUMENT`：上限非正整数。
 */
function resolveSealParseOptions(options?: SealParseOptions): SealParseLimits {
  const resolved = resolveParseOptions(options);
  const maxCertificates = options?.maxCertificates ?? DEFAULT_CRYPTO_LIMITS.maxCertificates;
  if (!Number.isSafeInteger(maxCertificates) || maxCertificates <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxCertificates 必须是正整数');
  }
  return { ...resolved, maxCertificates };
}

/** 印章图片信息（解析/展示用，不参与验签）。 */
export interface SealPictureInfo {
  /** 图片类型，例如 `PNG`、`GIF`、`SVG`。 */
  readonly type: string;
  /** 显示宽度，单位毫米（mm）。 */
  readonly widthMm: number;
  /** 显示高度，单位毫米（mm）。 */
  readonly heightMm: number;
  /** 图片数据长度，单位 byte。 */
  readonly dataLength: number;
  /** 图片原始数据；调用方只读使用。 */
  readonly data: Uint8Array;
}

/** 电子印章公开解析结果（`parseSeal`）。 */
export interface ParsedSeal {
  /** 数据结构版本。 */
  readonly version: SesVersion;
  /** 电子印章标识符（SES_SealInfo.esID）。 */
  readonly esId?: string;
  /** 印章名称。 */
  readonly name?: string;
  /** 印章类型：1 单位印章、2 个人印章等，原样透出。 */
  readonly typeCode?: number;
  /** 制作日期（ISO 8601）。 */
  readonly createDate?: string;
  /** 有效期起始（ISO 8601）。 */
  readonly validStart?: string;
  /** 有效期截止（ISO 8601）。 */
  readonly validEnd?: string;
  /** 制章者证书摘要。 */
  readonly makerCertificate?: CertificateSummary;
  /** 签章者证书列表摘要（CertListType=1 时可得）。 */
  readonly certificates?: readonly CertificateSummary[];
  /** 签章者证书杂凑值（CertListType=2 时可得，小写十六进制）。 */
  readonly certificateDigests?: readonly string[];
  /** 印章图片信息；无图片节点时省略。 */
  readonly picture?: SealPictureInfo;
  /** 是否包含制章人签名（仅结构判断，不代表验签通过）。 */
  readonly hasSignature: boolean;
  /** 时间戳解析结果（只解析不验证）。 */
  readonly timestamp: TimestampParseResult;
  /** 解析期 warning（例如印章图片缺失/损坏）。 */
  readonly warnings: readonly VerificationIssue[];
  /** 原始结构字节长度，单位 byte。 */
  readonly byteLength: number;
}

/**
 * 内部使用的 SESeal 详细结构。
 *
 * 保留验签所需的原始字节（SES_SealInfo、签名值、制章者证书），不对外暴露。
 */
export interface SesEalDetail {
  /** 版本。 */
  readonly version: 'v1' | 'v4' | 'v5';
  /** 完整 SESeal DER。 */
  readonly raw: Uint8Array;
  /** SES_SealInfo 原始 DER。 */
  readonly sealInfoRaw: Uint8Array;
  /** 制章人签名原文（v1 为 SealInfo+cert+alg 的 SEQUENCE，v4/v5 为 SealInfo）。 */
  readonly signedContent?: Uint8Array;
  /** 制章人签名值（DER `SEQUENCE { r, s }`）。 */
  readonly signature?: Uint8Array;
  /** 签名算法 OID。 */
  readonly signatureAlgorithmOid?: string;
  /** 制章者证书。 */
  readonly makerCertificate?: X509Certificate;
  /** 签章者证书列表。 */
  readonly certificates: readonly X509Certificate[];
  /** 签章者证书杂凑值（小写十六进制）。 */
  readonly certificateDigests: readonly string[];
  /** SES_SealInfo 字段。 */
  readonly esId?: string;
  readonly name?: string;
  readonly typeCode?: number;
  readonly createDate?: string;
  readonly validStart?: string;
  readonly validEnd?: string;
  /** 头信息。 */
  readonly headerId?: string;
  readonly headerVersion?: number;
  readonly headerVid?: string;
  /** 印章图片信息。 */
  readonly picture?: SealPictureInfo;
  /** v5 SESeal 内可选时间戳原始字节。 */
  readonly timestampRaw?: Uint8Array;
  /** 时间戳解析结果（只解析不验证）。 */
  readonly timestamp: TimestampParseResult;
  /** 解析期 warning。 */
  readonly warnings: readonly VerificationIssue[];
}

/**
 * 只解析电子印章；不验签、不查链。
 *
 * @param data SESeal DER（Seal.esl 的原始字节）。
 * @param options ASN.1 大小/深度上限与证书数量上限。
 * @returns 印章公开摘要（名称/编码/有效期/证书/图片元信息等）。
 * @throws CryptoError `CRYPTO_ASN1_INVALID`：结构非法；
 *   `CRYPTO_UNSUPPORTED_SES_VERSION`：版本不在 v1/v4/v5；
 *   `CRYPTO_CERTIFICATE_INVALID`：内嵌证书非法；`CRYPTO_LIMIT_EXCEEDED`：超限。
 */
export function parseSeal(data: Uint8Array, options?: SealParseOptions): ParsedSeal {
  return toParsedSeal(parseSesEal(data, options));
}

/**
 * 把内部印章详细结构转为公开解析结果。
 *
 * 供 `parseSignedValue` 复用，保证两条路径的字段映射一致。
 *
 * @param detail SESeal 详细结构。
 * @returns 印章公开摘要。
 */
export function toParsedSeal(detail: SesEalDetail): ParsedSeal {
  return {
    version: detail.version,
    esId: detail.esId,
    name: detail.name,
    typeCode: detail.typeCode,
    createDate: detail.createDate,
    validStart: detail.validStart,
    validEnd: detail.validEnd,
    makerCertificate: detail.makerCertificate
      ? toCertificateSummary(detail.makerCertificate)
      : undefined,
    certificates:
      detail.certificates.length > 0
        ? detail.certificates.map((certificate) => toCertificateSummary(certificate))
        : undefined,
    certificateDigests:
      detail.certificateDigests.length > 0 ? detail.certificateDigests : undefined,
    picture: detail.picture,
    timestamp: detail.timestamp,
    warnings: detail.warnings,
    hasSignature: detail.signature !== undefined && detail.signature.length > 0,
    byteLength: detail.raw.length,
  };
}

/**
 * 解析 SESeal 详细结构（内部 API）。
 *
 * @param data SESeal DER。
 * @param options ASN.1 大小/深度上限与证书数量上限。
 * @returns 含验签原文/签名值/证书的详细结构。
 * @throws CryptoError 同 `parseSeal`。
 */
export function parseSesEal(data: Uint8Array, options?: SealParseOptions): SesEalDetail {
  if (!(data instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'SESeal 输入必须是 Uint8Array');
  }
  const resolved = resolveSealParseOptions(options);
  const root = parseDer(data, toDerOptions(resolved)).requireSequence('SESeal');
  const children = root.children;
  if (children.length === 2) return parseV1Seal(root, data, resolved);
  if (children.length === 4 || children.length === 5) {
    return parseV4V5Seal(root, data, resolved);
  }
  throw new CryptoError(
    'CRYPTO_UNSUPPORTED_SES_VERSION',
    `不支持的 SESeal 顶层结构：${children.length} 个字段`,
  );
}

/**
 * 解析 v1 SESeal。
 *
 * @param root 顶层 SEQUENCE。
 * @param raw 原始字节。
 * @param limits 解析上限。
 * @returns 详细结构。
 */
function parseV1Seal(
  root: DerNode,
  raw: Uint8Array,
  limits: SealParseLimits,
): SesEalDetail {
  const sealInfoNode = requiredChild(root, 0, 'SES_SealInfo').requireSequence('SES_SealInfo');
  const headerVersion = peekHeaderVersion(sealInfoNode);
  if (headerVersion !== 1) {
    throw new CryptoError(
      'CRYPTO_UNSUPPORTED_SES_VERSION',
      `v1 SESeal 的 SES_Header.version 必须为 1，实际为 ${headerVersion ?? '缺失/非法'}`,
    );
  }
  const signInfoNode = root.children[1];
  const warnings: VerificationIssue[] = [];
  const sealInfo = parseSealInfo(sealInfoNode, 'v1', limits, warnings);

  let signature: Uint8Array | undefined;
  let signatureAlgorithmOid: string | undefined;
  let makerCertificate: X509Certificate | undefined;
  let signedContent: Uint8Array | undefined;

  if (signInfoNode && signInfoNode.isUniversal(DER_TAG.SEQUENCE)) {
    const signInfo = signInfoNode.requireSequence('SES_SignInfo');
    if (signInfo.children.length >= 3) {
      const certNode = requiredChild(signInfo, 0, 'SES_SignInfo.cert');
      const algNode = requiredChild(signInfo, 1, 'SES_SignInfo.signatureAlgorithm');
      const signatureNode = requiredChild(signInfo, 2, 'SES_SignInfo.signData');
      const certDer = certNode.asOctets();
      makerCertificate = parseCertificateDer(certDer, limits);
      signatureAlgorithmOid = algNode.asOid();
      signature = copyBytes(signatureNode.asBitStringOctets());
      // v1 制章人签名原文 = SEQUENCE(SES_SealInfo, cert OCTET STRING, sigAlg OID)。
      signedContent = derSequence(sealInfoNode.raw, certNode.raw, algNode.raw);
    }
  }

  return {
    version: 'v1',
    raw,
    sealInfoRaw: sealInfoNode.raw,
    signedContent,
    signature,
    signatureAlgorithmOid,
    makerCertificate,
    certificates: sealInfo.certificates,
    certificateDigests: sealInfo.certificateDigests,
    esId: sealInfo.esId,
    name: sealInfo.name,
    typeCode: sealInfo.typeCode,
    createDate: sealInfo.createDate,
    validStart: sealInfo.validStart,
    validEnd: sealInfo.validEnd,
    headerId: sealInfo.headerId,
    headerVersion: sealInfo.headerVersion,
    headerVid: sealInfo.headerVid,
    picture: sealInfo.picture,
    timestamp: emptyTimestamp(),
    warnings,
  };
}

/**
 * 解析 v4/v5 SESeal。
 *
 * @param root 顶层 SEQUENCE。
 * @param raw 原始字节。
 * @param limits 解析上限。
 * @returns 详细结构。
 */
function parseV4V5Seal(
  root: DerNode,
  raw: Uint8Array,
  limits: SealParseLimits,
): SesEalDetail {
  const sealInfoNode = requiredChild(root, 0, 'eSealInfo').requireSequence('eSealInfo');
  const headerVersion = peekHeaderVersion(sealInfoNode);
  if (headerVersion !== 4 && headerVersion !== 5) {
    throw new CryptoError(
      'CRYPTO_UNSUPPORTED_SES_VERSION',
      `v4/v5 SESeal 的 SES_Header.version 必须为 4 或 5，实际为 ${headerVersion ?? '缺失/非法'}`,
    );
  }
  const version: 'v4' | 'v5' = headerVersion === 5 ? 'v5' : 'v4';
  const warnings: VerificationIssue[] = [];
  const sealInfo = parseSealInfo(sealInfoNode, version, limits, warnings);

  const certNode = requiredChild(root, 1, 'cert');
  const algNode = requiredChild(root, 2, 'signAlgID');
  const signatureNode = requiredChild(root, 3, 'signedValue');
  const makerCertificate = parseCertificateDer(certNode.asOctets(), limits);
  const signatureAlgorithmOid = algNode.asOid();
  const signature = copyBytes(signatureNode.asBitStringOctets());
  const timestampRaw = readOptionalContextBitString(root.children[4]);
  const timestamp = timestampRaw
    ? parseTimestamp(timestampRaw, {
        maxBytes: limits.maxBytes,
        maxDepth: limits.maxDepth,
      })
    : emptyTimestamp();

  return {
    version,
    raw,
    sealInfoRaw: sealInfoNode.raw,
    // v4/v5 制章人签名的原文就是 SES_SealInfo 的 DER。
    signedContent: sealInfoNode.raw,
    signature,
    signatureAlgorithmOid,
    makerCertificate,
    certificates: sealInfo.certificates,
    certificateDigests: sealInfo.certificateDigests,
    esId: sealInfo.esId,
    name: sealInfo.name,
    typeCode: sealInfo.typeCode,
    createDate: sealInfo.createDate,
    validStart: sealInfo.validStart,
    validEnd: sealInfo.validEnd,
    headerId: sealInfo.headerId,
    headerVersion: sealInfo.headerVersion,
    headerVid: sealInfo.headerVid,
    picture: sealInfo.picture,
    timestampRaw,
    timestamp,
    warnings,
  };
}

/** SES_SealInfo 解析结果。 */
interface SealInfoFields {
  readonly esId?: string;
  readonly name?: string;
  readonly typeCode?: number;
  readonly createDate?: string;
  readonly validStart?: string;
  readonly validEnd?: string;
  readonly headerId?: string;
  readonly headerVersion?: number;
  readonly headerVid?: string;
  readonly certificates: readonly X509Certificate[];
  readonly certificateDigests: readonly string[];
  readonly picture?: SealPictureInfo;
  readonly warnings: readonly VerificationIssue[];
}

/**
 * 解析 SES_SealInfo。
 *
 * @param node SES_SealInfo SEQUENCE。
 * @param version 版本。
 * @param limits 解析上限。
 * @returns 字段集合。
 */
function parseSealInfo(
  node: DerNode,
  version: 'v1' | 'v4' | 'v5',
  limits: SealParseLimits,
  warnings: VerificationIssue[],
): SealInfoFields {
  if (node.children.length < 3) {
    throw asn1Error('SES_SealInfo 字段不足（至少需要 header/esID/property）');
  }
  const headerNode = requiredChild(node, 0, 'header').requireSequence('SES_Header');
  if (headerNode.children.length < 3) throw asn1Error('SES_Header 字段不足');
  const headerId = headerNode.children[0].asString();
  const headerVersion = Number(headerNode.children[1].asInteger());
  const headerVid = headerNode.children[2].asString();
  const expectedVersion = version === 'v1' ? 1 : version === 'v4' ? 4 : 5;
  if (headerVersion !== expectedVersion) {
    throw new CryptoError(
      'CRYPTO_UNSUPPORTED_SES_VERSION',
      `SES_Header.version 与 ${version} 布局不匹配：期望 ${expectedVersion}，实际 ${headerVersion}`,
    );
  }
  if (headerId !== 'ES') {
    throw asn1Error(`SES_Header.id 必须为 ES，实际为 ${headerId}`);
  }
  const esId = requiredChild(node, 1, 'esID').asString();
  const propertyNode = requiredChild(node, 2, 'property').requireSequence('SES_ESPropertyInfo');
  const pictureNode = node.children[3];
  let picture: SealPictureInfo | undefined;
  if (!pictureNode) {
    warnings.push({
      code: 'SEAL_PICTURE_MISSING',
      message: '印章缺少图片信息，已省略 picture',
      severity: 'warning',
    });
  } else {
    try {
      picture = parsePicture(pictureNode.requireSequence('SES_ESPictrueInfo'));
    } catch (error) {
      // 图片损坏不能影响印章签名/证书链解析，只降级为 warning。
      warnings.push({
        code: 'SEAL_PICTURE_INVALID',
        message: `印章图片解析失败：${error instanceof Error ? error.message : '未知错误'}`,
        severity: 'warning',
      });
    }
  }

  const property = parseProperty(propertyNode, version, limits);
  return {
    esId,
    name: property.name,
    typeCode: property.typeCode,
    createDate: property.createDate,
    validStart: property.validStart,
    validEnd: property.validEnd,
    headerId,
    headerVersion,
    headerVid,
    certificates: property.certificates,
    certificateDigests: property.certificateDigests,
    picture,
    warnings,
  };
}

/**
 * 构造空时间戳结果。
 *
 * @returns 固定文案的 not-present 结果。
 */
function emptyTimestamp(): TimestampParseResult {
  return {
    status: 'not-present',
    tokenPresent: false,
    tokenLength: 0,
    note: '已解析，未验证',
  };
}

/** SES_ESPropertyInfo 解析结果。 */
interface PropertyFields {
  readonly typeCode?: number;
  readonly name?: string;
  readonly createDate?: string;
  readonly validStart?: string;
  readonly validEnd?: string;
  readonly certificates: readonly X509Certificate[];
  readonly certificateDigests: readonly string[];
}

/**
 * 解析 SES_ESPropertyInfo。
 *
 * @param node 属性 SEQUENCE。
 * @param version 版本。
 * @param limits 解析上限。
 * @returns 属性字段。
 */
function parseProperty(
  node: DerNode,
  version: 'v1' | 'v4' | 'v5',
  limits: SealParseLimits,
): PropertyFields {
  if (node.children.length < 6) throw asn1Error('SES_ESPropertyInfo 字段不足');
  const typeCode = Number(requiredChild(node, 0, 'type').asInteger());
  const name = requiredChild(node, 1, 'name').asString();

  let certListType = 1;
  let certListIndex = 2;
  if (version !== 'v1') {
    certListType = Number(requiredChild(node, 2, 'certListType').asInteger());
    certListIndex = 3;
  }
  const certListNode = requiredChild(node, certListIndex, 'certList').requireSequence('certList');
  const { certificates, certificateDigests } = parseCertList(certListNode, certListType, limits);

  const dateIndex = certListIndex + 1;
  const createDate = readTimeIso(requiredChild(node, dateIndex, 'createDate'));
  const validStart = readTimeIso(requiredChild(node, dateIndex + 1, 'validStart'));
  const validEnd = readTimeIso(requiredChild(node, dateIndex + 2, 'validEnd'));
  return { typeCode, name, createDate, validStart, validEnd, certificates, certificateDigests };
}

/**
 * 解析签章者证书信息列表。
 *
 * @param node 列表 SEQUENCE。
 * @param certListType 1=证书、2=证书杂凑值。
 * @param limits 解析上限。
 * @returns 证书与摘要列表。
 */
function parseCertList(
  node: DerNode,
  certListType: number,
  limits: SealParseLimits,
): { readonly certificates: readonly X509Certificate[]; readonly certificateDigests: readonly string[] } {
  const maxCertificates = limits.maxCertificates;
  if (node.children.length > maxCertificates) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `印章证书列表 ${node.children.length} 超过上限 ${maxCertificates}`,
    );
  }
  if (certListType === 2) {
    const digests = node.children.map((item) => {
      const entry = item.requireSequence('CertDigest');
      const value = requiredChild(entry, entry.children.length - 1, 'certDigest').asOctets();
      return hexOf(value);
    });
    return { certificates: [], certificateDigests: digests };
  }
  const certificates = node.children.map((item) =>
    parseCertificateDer(item.asOctets(), limits),
  );
  return { certificates, certificateDigests: [] };
}

/**
 * 解析印章图片信息。
 *
 * @param node SES_ESPictrueInfo SEQUENCE。
 * @returns 图片公开信息。
 */
function parsePicture(node: DerNode): SealPictureInfo {
  if (node.children.length < 4) throw asn1Error('SES_ESPictrueInfo 字段不足');
  const type = requiredChild(node, 0, 'picture.type').asString();
  const data = copyBytes(requiredChild(node, 1, 'picture.data').asOctets());
  const widthMm = Number(requiredChild(node, 2, 'picture.width').asInteger());
  const heightMm = Number(requiredChild(node, 3, 'picture.height').asInteger());
  return { type, widthMm, heightMm, dataLength: data.length, data };
}

/**
 * 读取 v5 SESeal 的可选时间戳（[0] BIT STRING）。
 *
 * 兼容 EXPLICIT（[0] 包裹 BIT STRING）与 IMPLICIT 两种编码。
 *
 * @param node context [0] 节点。
 * @returns 时间戳原始字节；不存在时 undefined。
 */
export function readOptionalContextBitString(node: DerNode | undefined): Uint8Array | undefined {
  if (!node || !node.isContext(0)) return undefined;
  if (node.children.length > 0) {
    return copyBytes(node.children[0].asBitStringOctets());
  }
  // IMPLICIT：value 首字节为 unused-bits。
  if (node.value.length === 0) return undefined;
  const unusedBits = node.value[0];
  if (unusedBits > 7) throw asn1Error('时间戳 BIT STRING unused-bits 非法');
  return copyBytes(node.value.subarray(1));
}

/**
 * 读取 SES_Header 中的版本号（无需完整解析）。
 *
 * @param sealInfoNode SES_SealInfo SEQUENCE。
 * @returns 版本号；结构不符时返回 undefined。
 */
function peekHeaderVersion(sealInfoNode: DerNode): number | undefined {
  try {
    const header = sealInfoNode.children[0]?.requireSequence('SES_Header');
    return Number(header.children[1]?.asInteger());
  } catch {
    return undefined;
  }
}

/**
 * 解析证书 DER。
 *
 * @param der 证书字节。
 * @param limits 解析上限。
 * @returns 证书结构。
 * @throws CryptoError `CRYPTO_CERTIFICATE_INVALID`。
 */
function parseCertificateDer(
  der: Uint8Array,
  limits: SealParseLimits,
): X509Certificate {
  try {
    return parseX509Certificate(der, toDerOptions(limits));
  } catch (error) {
    if (isCryptoError(error) && error.code === 'CRYPTO_LIMIT_EXCEEDED') throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CryptoError('CRYPTO_CERTIFICATE_INVALID', `印章内嵌证书解析失败：${detail}`);
  }
}

/**
 * 读取 ASN.1 时间并输出 ISO 8601。
 *
 * @param node 时间节点（UTCTime/GeneralizedTime）。
 * @returns ISO 8601 字符串。
 */
function readTimeIso(node: DerNode): string {
  return node.asTime().toISOString();
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
  return new CryptoError('CRYPTO_ASN1_INVALID', `SESeal 解析失败：${message}`);
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

/**
 * 获取签名算法可读名称（供上层展示）。
 *
 * @param oid 算法 OID。
 * @returns 可读名称或原始 OID。
 */
export function signatureAlgorithmName(oid: string | undefined): string | undefined {
  return oid ? oidName(oid) : undefined;
}