/**
 * 时间戳令牌解析（RFC 3161 / GM/T 0033-2014，只解析不验证）。
 *
 * 支持输入：
 * - RFC 3161 `TimeStampToken`（CMS `ContentInfo`，contentType 为 SignedData）；
 * - `TimeStampResp`（`SEQUENCE { PKIStatusInfo, TimeStampToken OPTIONAL }`）；
 * - GM/T 0033-2014 签章时间戳（结构同为 CMS SignedData，内层 eContentType 为 TSTInfo）。
 *
 * 安全边界：
 * - 不验证 TSA 签名、ESSCertID、策略链、TSA 证书有效期；
 * - 不把 messageImprint 匹配表述为“时间戳有效”；
 * - 输入大小、ASN.1 深度受 `ParseOptions` 限制，解析失败返回 `parse-error` 而不抛错。
 */

import { CryptoError, isCryptoError } from '../errors';
import {
  DER_TAG,
  parseDer,
  type DerNode,
  type DerParseOptions,
} from '../asn1/der';
import {
  OID_CT_TST_INFO,
  isSignedDataContentType,
  oidName,
} from '../asn1/oid';
import { parseX509Certificate, type X509Certificate } from '../asn1/x509';
import { toCertificateSummary } from '../cert/summary';
import { sm3Digest } from '../sm/sm3';
import type { ParseOptions } from '../types/options';
import type { VerificationIssue } from '../types/status';
import { bytesEqual } from '../util/bytes';
import { resolveParseOptions } from '../util/options';
import type { TimestampParseResult } from './types';

/** 时间戳解析选项。 */
export interface TimestampParseOptions extends ParseOptions {
  /**
   * 签章签名值字节；提供后用于比较 `messageImprint`。
   *
   * 仅作结构一致性提示，不验证时间戳签名。
   */
  readonly signatureValue?: Uint8Array;
}

/** 固定展示文案。 */
const TIMESTAMP_NOTE = '已解析，未验证' as const;

/**
 * 只解析时间戳；不验证 TSA 签名，固定 `parsed-not-verified`。
 *
 * @param data 时间戳令牌 DER。
 * @param options 大小/深度上限与可选的签章签名值。
 * @returns 时间戳解析结果；解析失败返回 `parse-error`，不抛异常。
 */
export function parseTimestamp(
  data: Uint8Array,
  options: TimestampParseOptions = {},
): TimestampParseResult {
  if (!(data instanceof Uint8Array)) {
    return parseErrorResult(0, '时间戳输入必须是 Uint8Array');
  }
  if (data.length === 0) {
    return {
      status: 'not-present',
      tokenPresent: false,
      tokenLength: 0,
      note: TIMESTAMP_NOTE,
    };
  }
  const resolved = resolveParseOptions(options);
  if (data.length > resolved.maxBytes) {
    return parseErrorResult(
      data.length,
      `时间戳大小 ${data.length} byte 超过上限 ${resolved.maxBytes} byte`,
    );
  }
  try {
    const parsed = parseToken(data, resolved);
    const testSignature = options.signatureValue;
    const messageImprintMatchesSignature =
      testSignature && parsed.messageImprint
        ? bytesEqual(sm3Digest(testSignature), hexToBytes(parsed.messageImprint))
        : undefined;
    return {
      status: 'parsed-not-verified',
      tokenPresent: true,
      tokenLength: data.length,
      version: parsed.version,
      policy: parsed.policy,
      serialNumber: parsed.serialNumber,
      genTime: parsed.genTime,
      hashAlgorithm: parsed.hashAlgorithm,
      messageImprint: parsed.messageImprint,
      nonce: parsed.nonce,
      tsa: parsed.tsa,
      messageImprintMatchesSignature,
      note: TIMESTAMP_NOTE,
    };
  } catch (error) {
    return parseErrorResult(data.length, errorMessageOf(error));
  }
}

/** 内部时间戳解析结果。 */
interface ParsedToken {
  /** TSTInfo.version。 */
  readonly version?: number;
  /** policy OID。 */
  readonly policy?: string;
  /** 序列号（小写十六进制）。 */
  readonly serialNumber?: string;
  /** 生成时间（ISO 8601）。 */
  readonly genTime?: string;
  /** 摘要算法名称。 */
  readonly hashAlgorithm?: string;
  /** messageImprint（小写十六进制）。 */
  readonly messageImprint?: string;
  /** nonce（小写十六进制）。 */
  readonly nonce?: string;
  /** TSA 证书摘要。 */
  readonly tsa?: TimestampParseResult['tsa'];
}

/**
 * 解析令牌结构。
 *
 * @param data 令牌字节。
 * @param limits 解析上限。
 * @returns TSTInfo 字段。
 */
function parseToken(
  data: Uint8Array,
  limits: { readonly maxBytes: number; readonly maxDepth: number },
): ParsedToken {
  const derOptions: DerParseOptions = { maxBytes: limits.maxBytes, maxDepth: limits.maxDepth };
  const root = parseDer(data, derOptions).requireSequence('TimeStampToken');
  const token = locateTimeStampToken(root);
  if (!isSignedDataContentType(token.contentType)) {
    throw new CryptoError(
      'CRYPTO_UNSUPPORTED_ALGORITHM',
      `时间戳 contentType 不是 SignedData：${token.contentType}`,
    );
  }
  const signedData = token.content.requireSequence('SignedData');

  const tstInfoNode = locateTstInfo(signedData, derOptions);
  const fields = parseTstInfo(tstInfoNode, derOptions);
  const certificate = firstSignedDataCertificate(signedData, derOptions);
  return {
    ...fields,
    tsa: certificate ? toCertificateSummary(certificate) : undefined,
  };
}

/** CMS ContentInfo 视图。 */
interface ContentInfoView {
  /** contentType OID。 */
  readonly contentType: string;
  /** 内容节点（EXPLICIT/IMPLICIT 解包后的实际结构）。 */
  readonly content: DerNode;
}

/**
 * 定位 TimeStampToken（兼容 TimeStampResp 包装）。
 *
 * @param root 顶层 SEQUENCE。
 * @returns ContentInfo 视图。
 */
function locateTimeStampToken(root: DerNode): ContentInfoView {
  const first = root.children[0];
  if (first?.isUniversal(DER_TAG.OBJECT_IDENTIFIER)) {
    return readContentInfo(root);
  }
  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken TimeStampToken OPTIONAL }
  const tokenNode = root.children.find(
    (child, index) => index > 0 && child.isUniversal(DER_TAG.SEQUENCE),
  );
  if (tokenNode) return readContentInfo(tokenNode);
  throw asn1Error('时间戳令牌既不是 ContentInfo，也不是 TimeStampResp');
}

/**
 * 读取 CMS ContentInfo。
 *
 * @param node ContentInfo SEQUENCE。
 * @returns contentType 与 content 节点。
 */
function readContentInfo(node: DerNode): ContentInfoView {
  const sequence = node.requireSequence('ContentInfo');
  const oidNode = sequence.children[0];
  if (!oidNode) throw asn1Error('ContentInfo 缺少 contentType');
  const contentType = oidNode.asOid();
  const contentWrapper = sequence.children[1];
  if (!contentWrapper) throw asn1Error('ContentInfo 缺少 content');
  if (!contentWrapper.isContext(0)) {
    throw asn1Error('ContentInfo.content 必须使用 [0] 标签');
  }
  // CMS 使用 EXPLICIT；个别实现使用 IMPLICIT，兼容两种。
  const content = contentWrapper.children[0] ?? contentWrapper;
  return { contentType, content };
}

/**
 * 从 SignedData 定位 TSTInfo 节点。
 *
 * @param signedData SignedData SEQUENCE。
 * @param derOptions DER 解析上限。
 * @returns TSTInfo 节点。
 */
function locateTstInfo(signedData: DerNode, derOptions: DerParseOptions): DerNode {
  if (signedData.children.length < 3) throw asn1Error('SignedData 字段不足');
  const encap = signedData.children[2];
  if (!encap || !encap.isUniversal(DER_TAG.SEQUENCE)) {
    throw asn1Error('SignedData 缺少 encapContentInfo');
  }
  const eContentType = encap.children[0]?.asOid();
  if (eContentType && eContentType !== OID_CT_TST_INFO) {
    throw new CryptoError(
      'CRYPTO_UNSUPPORTED_ALGORITHM',
      `时间戳 eContentType 不是 TSTInfo：${eContentType}`,
    );
  }
  const wrapper = encap.children[1];
  if (!wrapper) throw asn1Error('encapContentInfo 缺少 eContent');
  let eContent: Uint8Array | undefined;
  if (wrapper.isContext(0)) {
    const inner = wrapper.children[0];
    eContent = inner?.isUniversal(DER_TAG.OCTET_STRING) ? inner.asOctets() : wrapper.value;
  } else if (wrapper.isUniversal(DER_TAG.OCTET_STRING)) {
    eContent = wrapper.asOctets();
  }
  if (!eContent || eContent.length === 0) throw asn1Error('eContent 为空');
  return parseDer(eContent, derOptions).requireSequence('TSTInfo');
}

/**
 * 解析 TSTInfo。
 *
 * @param node TSTInfo SEQUENCE。
 * @param derOptions DER 解析上限。
 * @returns 时间戳字段。
 */
function parseTstInfo(node: DerNode, derOptions: DerParseOptions): ParsedToken {
  const children = node.children;
  const version = children[0] ? Number(children[0].asInteger()) : undefined;
  const policy = children[1]?.asOid();
  const imprint = children[2];
  if (!imprint || !imprint.isUniversal(DER_TAG.SEQUENCE)) {
    throw asn1Error('TSTInfo 缺少 messageImprint');
  }
  const imprintChildren = imprint.children;
  if (imprintChildren.length < 2) throw asn1Error('messageImprint 字段不足');
  const algorithmNode = imprintChildren[0].requireSequence('AlgorithmIdentifier');
  const algorithmOid = algorithmNode.children[0]?.asOid();
  const messageImprint = hexOf(imprintChildren[1].asOctets());

  const serialNumber = children[3] ? hexOfUnsignedInteger(children[3]) : undefined;
  const genTime = children[4] ? children[4].asTime().toISOString() : undefined;

  let nonce: string | undefined;
  for (const child of children.slice(5)) {
    if (child.isUniversal(DER_TAG.INTEGER)) nonce = hexOfUnsignedInteger(child);
  }

  return {
    version,
    policy,
    serialNumber,
    genTime,
    hashAlgorithm: algorithmOid ? oidName(algorithmOid) : undefined,
    messageImprint,
    nonce,
  };
}

/**
 * 读取 SignedData.certificates 中第一张证书。
 *
 * @param signedData SignedData SEQUENCE。
 * @param derOptions DER 解析上限。
 * @returns 证书；不存在/非法时 undefined。
 */
function firstSignedDataCertificate(
  signedData: DerNode,
  derOptions: DerParseOptions,
): X509Certificate | undefined {
  const certificates = signedData.findContext(0);
  if (!certificates) return undefined;
  let list: readonly DerNode[] = certificates.children;
  if (list.length === 1 && list[0].isUniversal(DER_TAG.SET)) {
    list = list[0].children;
  }
  for (const item of list) {
    if (!item.isUniversal(DER_TAG.SEQUENCE)) continue;
    try {
      return parseX509Certificate(item.raw, derOptions);
    } catch {
      // 时间戳证书只用于展示；解析失败不影响 TSTInfo。
      return undefined;
    }
  }
  return undefined;
}

/**
 * 读取非负 INTEGER 的十六进制表示。
 *
 * @param node INTEGER 节点。
 * @returns 无前导零的小写十六进制。
 */
function hexOfUnsignedInteger(node: DerNode): string {
  const bytes = node.asUnsignedIntegerBytes();
  return hexOf(bytes);
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
 * 十六进制转字节（内部使用，输入已由本模块生成为合法 hex）。
 *
 * @param hex 小写十六进制。
 * @returns 字节。
 */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 构造解析失败结果。
 *
 * @param tokenLength 令牌字节数，单位 byte。
 * @param message 诊断信息。
 * @returns 解析失败结果。
 */
function parseErrorResult(tokenLength: number, message: string): TimestampParseResult {
  const parseError: VerificationIssue = {
    code: 'CRYPTO_TIMESTAMP_PARSE',
    message: `时间戳解析失败：${message}`,
    severity: 'warning',
  };
  return {
    status: 'parse-error',
    tokenPresent: tokenLength > 0,
    tokenLength,
    parseError,
    note: TIMESTAMP_NOTE,
  };
}

/**
 * 提取可展示的错误信息。
 *
 * @param error 错误。
 * @returns 文本。
 */
function errorMessageOf(error: unknown): string {
  if (isCryptoError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 构造 ASN.1 结构错误。
 *
 * @param message 诊断信息。
 * @returns CryptoError。
 */
function asn1Error(message: string): CryptoError {
  return new CryptoError('CRYPTO_ASN1_INVALID', `时间戳解析失败：${message}`);
}
