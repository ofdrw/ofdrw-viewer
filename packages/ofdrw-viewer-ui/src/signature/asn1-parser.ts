/**
 * `SignedValue.dat`（SES_Signature v1/v4/v5）ASN.1 解析器。
 *
 * 本模块由 `asn1.ts` 动态加载：`asn1js` 负责 DER/BER，`@peculiar/asn1-x509`
 * 负责 X.509 证书。只读取展示所需的 subject/issuer/serial/validity/算法，
 * **不验证签名值、证书链、证书有效期、CRL/OCSP、时间戳**。
 *
 * 解析失败/字段缺失统一转换为 warning，尽量保留可读字段。
 */

import * as asn1js from 'asn1js';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import type {
  AlgorithmInfo,
  CertificateAttributes,
  CertificateInfo,
  SealInfo,
  SignedAtSource,
  SignerInfo,
} from '../types';
import type { ViewerWarning } from '../state';
import { SignatureParseError } from './errors';
import type { SignatureParseLimits } from './limits';

/** 解析结果。 */
export interface ParsedSignedValue {
  /** 识别出的版本；无法识别时为 `unknown`。 */
  readonly version: 'v1' | 'v4' | 'v5' | 'unknown';
  /** 印章信息。 */
  readonly seal?: SealInfo;
  /** 签章者信息。 */
  readonly signer?: SignerInfo;
  /** 非致命降级信息。 */
  readonly warnings: readonly ViewerWarning[];
}

/** ASN.1 节点最小结构；只描述本解析器用到的字段，避免依赖 asn1js 内部类型。 */
interface AsnNode {
  readonly constructor: { readonly name: string };
  readonly idBlock?: {
    readonly tagClass?: number;
    readonly tagNumber?: number;
  };
  readonly valueBlock?: {
    readonly value?: unknown;
    readonly valueHexView?: Uint8Array;
    readonly valueDec?: number | bigint;
    readonly unusedBits?: number;
    readonly error?: string;
    toString?: () => string;
  };
  readonly valueBeforeDecodeView?: Uint8Array;
  readonly toString?: () => string;
  readonly toDate?: () => Date;
}

const CLASS_UNIVERSAL = 1;
const CLASS_CONTEXT = 3;
const TAG_INTEGER = 2;
const TAG_BIT_STRING = 3;
const TAG_OCTET_STRING = 4;
const TAG_OID = 6;
const TAG_SEQUENCE = 16;
const TAG_UTC_TIME = 23;
const TAG_GENERALIZED_TIME = 24;

/** 常见算法 OID 友好名。 */
const ALGORITHM_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '1.2.156.10197.1.301': 'SM2',
  '1.2.156.10197.1.401': 'SM3',
  '1.2.156.10197.1.501': 'SM2-with-SM3',
  '1.2.840.10045.2.1': 'EC',
  '1.2.840.10045.4.3.2': 'ECDSA-with-SHA256',
  '1.2.840.10045.4.3.3': 'ECDSA-with-SHA384',
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.5': 'SHA1-with-RSA',
  '1.2.840.113549.1.1.11': 'SHA256-with-RSA',
  '1.2.840.113549.1.1.12': 'SHA384-with-RSA',
});

/** 证书主题 DN 属性 OID → 展示名与字段名。 */
const DN_ATTRIBUTES: Readonly<
  Record<string, { readonly label: string; readonly key: keyof CertificateAttributes }>
> = Object.freeze({
  '2.5.4.3': { label: 'CN', key: 'cn' },
  '2.5.4.10': { label: 'O', key: 'o' },
  '2.5.4.11': { label: 'OU', key: 'ou' },
  '2.5.4.6': { label: 'C', key: 'c' },
  '2.5.4.8': { label: 'ST', key: 'st' },
  '2.5.4.7': { label: 'L', key: 'l' },
  '1.2.840.113549.1.9.1': { label: 'emailAddress', key: 'email' },
  '2.5.4.5': { label: 'serialNumber', key: 'serialNumber' },
});

/**
 * 同步解析 `SignedValue.dat`。
 *
 * @param data 原始字节。
 * @param limits 安全限制。
 * @returns 解析结果；字段缺失通过 warning 表达。
 * @throws {SignatureParseError} DER 损坏、不是 SEQUENCE 或超出限制时抛出。
 */
export function parseSignedValueBytes(
  data: Uint8Array,
  limits: SignatureParseLimits,
): ParsedSignedValue {
  if (data.byteLength > limits.maxBytes) {
    throw new SignatureParseError('W_SIGNATURE_LIMIT', '签名值文件超出解析上限');
  }
  const parsed = asn1js.fromBER(toArrayBuffer(data));
  if (!parsed.result || parsed.offset === -1) {
    throw new SignatureParseError('W_SIGNATURE_ASN1', '签名值文件不是有效的 DER/BER 编码');
  }
  const root = parsed.result as unknown as AsnNode;
  assertTreeLimits(root, limits);
  if (!isSequence(root)) {
    throw new SignatureParseError('W_SIGNATURE_ASN1', '签名值文件顶层不是 SEQUENCE');
  }

  const warnings: ViewerWarning[] = [];
  const outer = children(root);
  const tbsNode = outer[0];
  if (!tbsNode || !isSequence(tbsNode)) {
    throw new SignatureParseError('W_SIGNATURE_ASN1', '签名值文件缺少待签章数据（TBS_Sign）');
  }
  const tbs = children(tbsNode);
  const rawVersion = intValue(tbs[0]);
  /** v1 外层只有 `toSign` + `signature`；v4/v5 至少 4 个字段。 */
  const v1Layout = outer.length <= 2 || tbs.length >= 7;

  let version = versionLabel(rawVersion);
  if (!version) {
    warnings.push({
      code: 'W_SIGNATURE_VERSION',
      message: `未识别的签章数据结构版本（version=${rawVersion ?? '缺失'}）`,
    });
  }

  const seal = parseEseal(tbs[1], warnings);
  if (!seal) {
    warnings.push({
      code: 'W_SIGNATURE_SEAL',
      message: '未获取到印章信息（TBS_Sign.eseal）',
    });
  }
  const detectedVersion: ParsedSignedValue['version'] = version ?? 'unknown';

  const certBytes = v1Layout ? octetBytes(tbs[5]) : octetBytes(outer[1]);
  const algorithmOid = v1Layout ? oidValue(tbs[6]) : oidValue(outer[2]);
  const timeInfo = readTimeInfo(tbs[2], warnings);
  const timestampInOuter = v1Layout
    ? false
    : outer.slice(4).some((node) => node.idBlock?.tagClass === CLASS_CONTEXT);

  let signer: SignerInfo = {};
  if (certBytes && certBytes.byteLength > 0) {
    const certificate = parseCertificate(certBytes, warnings);
    if (certificate) signer = { ...signer, certificate };
  } else {
    warnings.push({
      code: 'W_SIGNATURE_CERT',
      message: '未找到签章者证书，无法展示证书主题',
    });
  }
  if (algorithmOid) {
    signer = { ...signer, algorithm: toAlgorithm(algorithmOid) };
  } else {
    warnings.push({
      code: 'W_SIGNATURE_ALGORITHM',
      message: '未找到签名算法标识',
    });
  }
  if (timeInfo.value) {
    signer = {
      ...signer,
      signedAt: timeInfo.value,
      signedAtSource: timeInfo.source,
    };
  } else if (timeInfo.source === 'timestamp-token') {
    signer = { ...signer, signedAtSource: 'timestamp-token' };
  }
  const dataHash = bitStringHex(tbs[3]);
  if (dataHash) signer = { ...signer, dataHash };
  const propertyInfo = stringValue(tbs[4]);
  if (propertyInfo) signer = { ...signer, propertyInfo };
  if (timestampInOuter || timeInfo.timestampToken) {
    signer = { ...signer, timestampPresent: true };
  }

  return {
    version: detectedVersion,
    ...(seal ? { seal } : {}),
    ...(Object.keys(signer).length > 0 ? { signer } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// TBS_Sign / ESEAL / SES_SealInfo
// ---------------------------------------------------------------------------

/**
 * 解析 `TBS_Sign.eseal`（SESeal v1/v4/v5）。
 *
 * @param node `eseal` 节点。
 * @param warnings warning 收集器。
 * @returns 印章信息；结构不可用时返回 undefined。
 */
function parseEseal(node: AsnNode | undefined, warnings: ViewerWarning[]): SealInfo | undefined {
  if (!node || !isSequence(node)) return undefined;
  const fields = children(node);
  const sealInfoNode = fields[0];
  if (!sealInfoNode || !isSequence(sealInfoNode)) {
    warnings.push({
      code: 'W_SIGNATURE_SEAL',
      message: '印章数据结构缺少 SES_SealInfo',
    });
    return undefined;
  }
  const info = children(sealInfoNode);
  if (info.length < 4) {
    warnings.push({
      code: 'W_SIGNATURE_SEAL',
      message: '印章信息字段不完整，已跳过',
    });
    return undefined;
  }

  const header = isSequence(info[0]) ? children(info[0]) : [];
  const headerVersion = intValue(header[1]);
  const esId = stringValue(info[1]);
  const property = isSequence(info[2]) ? children(info[2]) : [];
  const picture = isSequence(info[3]) ? children(info[3]) : [];

  const typeCode = intValue(property[0]);
  const name = stringValue(property[1]);
  const version = versionLabel(headerVersion) ?? 'unknown';

  let certListType: number | undefined;
  let certListNode: AsnNode | undefined;
  let timeStart = 3;
  if (property.length >= 7 && isInteger(property[2])) {
    certListType = intValue(property[2]);
    certListNode = property[3];
    timeStart = 4;
  } else {
    certListNode = property[2];
  }

  const certificate =
    certListType === 2
      ? undefined
      : certificateFromCertList(certListNode, warnings);
  const pictureInfo = parsePicture(picture);

  return {
    version,
    ...(esId ? { esId } : {}),
    ...(name ? { name } : {}),
    ...(typeCode !== undefined ? { typeCode, typeLabel: sealTypeLabel(typeCode) } : {}),
    ...withDate('createDate', property[timeStart], warnings, '制章日期'),
    ...withDate('validStart', property[timeStart + 1], warnings, '印章有效期开始'),
    ...withDate('validEnd', property[timeStart + 2], warnings, '印章有效期结束'),
    ...(certificate ? { certificate } : {}),
    ...(pictureInfo ? { image: pictureInfo } : {}),
  };
}

/** 读取印章图片元信息；绝不保留图片字节。 */
function parsePicture(picture: readonly AsnNode[]): SealInfo['image'] | undefined {
  const format = stringValue(picture[0]);
  const widthMm = intValue(picture[2]);
  const heightMm = intValue(picture[3]);
  if (!format && widthMm === undefined && heightMm === undefined) return undefined;
  return {
    format: format ?? 'unknown',
    widthMm: widthMm ?? 0,
    heightMm: heightMm ?? 0,
  };
}

/** 从 `certList` 中查找第一张可解析证书。 */
function certificateFromCertList(
  node: AsnNode | undefined,
  warnings: ViewerWarning[],
): CertificateInfo | undefined {
  if (!node) return undefined;
  for (const candidate of findOctetStrings(node)) {
    if (candidate.byteLength === 0) continue;
    const certificate = parseCertificate(candidate, warnings);
    if (certificate) return certificate;
  }
  return undefined;
}

/** 收集 certList 中最多两层的 OCTET STRING。 */
function findOctetStrings(node: AsnNode, depth = 0): Uint8Array[] {
  if (depth > 2) return [];
  const direct = octetBytes(node);
  if (direct) return [direct];
  const result: Uint8Array[] = [];
  for (const child of children(node)) {
    result.push(...findOctetStrings(child, depth + 1));
  }
  return result;
}

/** 印章类型文案。 */
function sealTypeLabel(typeCode: number): string {
  if (typeCode === 1) return '单位印章';
  if (typeCode === 2) return '个人印章';
  return '未知';
}

/** 读取时间字段并转成 ISO 8601；异常时保留原文并 warning。 */
function withDate(
  key: 'createDate' | 'validStart' | 'validEnd',
  node: AsnNode | undefined,
  warnings: ViewerWarning[],
  label: string,
): Partial<SealInfo> {
  if (!node) return {};
  const value = normalizeTimeNode(node, warnings, label);
  return value ? { [key]: value } : {};
}

// ---------------------------------------------------------------------------
// 签章时间
// ---------------------------------------------------------------------------

/** 签章时间读取结果。 */
interface TimeInfoResult {
  /** ISO 8601 或原始文本。 */
  readonly value?: string;
  /** 时间来源。 */
  readonly source: SignedAtSource;
  /** 是否为未解析的时间戳令牌。 */
  readonly timestampToken: boolean;
}

/**
 * 读取 `TBS_Sign.timeInfo`。
 *
 * v4/v5 是 GeneralizedTime；v1 是 BIT STRING，内容可能是 ASCII 时间或时间戳令牌。
 * 无法识别时只保留 warning，不猜测时间。
 */
function readTimeInfo(node: AsnNode | undefined, warnings: ViewerWarning[]): TimeInfoResult {
  if (!node) {
    warnings.push({ code: 'W_SIGNATURE_TIME', message: '签章数据缺少签章时间（timeInfo）' });
    return { source: 'timeInfo', timestampToken: false };
  }
  const tag = tagOf(node);
  if (tag === TAG_GENERALIZED_TIME || tag === TAG_UTC_TIME) {
    const value = normalizeTimeNode(node, warnings, '签章时间');
    return { ...(value ? { value } : {}), source: 'timeInfo', timestampToken: false };
  }
  if (tag === TAG_BIT_STRING || tag === TAG_OCTET_STRING) {
    const bytes = bitStringBytes(node) ?? octetBytes(node) ?? new Uint8Array();
    const text = asciiText(bytes);
    if (text && looksLikeTimeText(text)) {
      const value = normalizeLooseTime(text);
      if (value) return { value, source: 'timeInfo', timestampToken: false };
      warnings.push({
        code: 'W_SIGNATURE_TIME',
        message: `签章时间格式无法识别，保留原文：${text}`,
      });
      return { value: text, source: 'timeInfo', timestampToken: false };
    }
    warnings.push({
      code: 'W_SIGNATURE_TIME',
      message: '签章时间为时间戳令牌，未解析（仅展示存在信息）',
    });
    return { source: 'timestamp-token', timestampToken: true };
  }
  const raw = node.toString?.().trim();
  warnings.push({
    code: 'W_SIGNATURE_TIME',
    message: raw ? `签章时间类型无法识别，保留原文：${raw}` : '签章时间类型无法识别',
  });
  return { ...(raw ? { value: raw } : {}), source: 'timeInfo', timestampToken: false };
}

/** 将 ASN.1 时间节点规范化为 ISO 8601。 */
function normalizeTimeNode(
  node: AsnNode,
  warnings: ViewerWarning[],
  label: string,
): string | undefined {
  if (typeof node.toDate === 'function') {
    const date = node.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  const raw = node.toString?.().trim() ?? '';
  if (!raw) return undefined;
  const parsed = normalizeLooseTime(raw);
  if (parsed) return parsed;
  warnings.push({
    code: 'W_SIGNATURE_TIME',
    message: `${label}格式无法识别，保留原文：${raw}`,
  });
  return raw;
}

/** 尝试把 `YYYYMMDDHHmmssZ` 或带分隔符的时间转为 ISO 8601。 */
function normalizeLooseTime(raw: string): string | undefined {
  const text = raw.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?(Z|[+-]\d{4})?$/.exec(
    text,
  );
  if (compact) {
    const [, year, month, day, hour, minute, second, zone] = compact;
    const offset = zone && zone !== 'Z' ? zone : 'Z';
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return undefined;
  }
  if (!/[-T:]/.test(text)) return undefined;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return undefined;
}

/** 判断文本是否像日期时间。 */
function looksLikeTimeText(text: string): boolean {
  return /^\d{4}[-/]?\d{2}[-/]?\d{2}[T ]?\d{2}:?\d{2}:?\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(
    text.trim(),
  );
}

// ---------------------------------------------------------------------------
// X.509
// ---------------------------------------------------------------------------

/**
 * 解析 DER 证书的展示字段。
 *
 * 只读取 subject/issuer/serial/validity/算法，不校验证书链、有效期、吊销状态。
 */
function parseCertificate(der: Uint8Array, warnings: ViewerWarning[]): CertificateInfo | undefined {
  try {
    const certificate = AsnConvert.parse(toArrayBuffer(der), Certificate);
    const tbs = certificate.tbsCertificate;
    const subject = readName(tbs.subject);
    const issuer = readName(tbs.issuer);
    const validity = tbs.validity;
    const notBefore = validity.notBefore.getTime();
    const notAfter = validity.notAfter.getTime();
    return {
      subject: subject.formatted || '无法解析',
      issuer: issuer.formatted || '无法解析',
      serialNumber: bytesToHex(new Uint8Array(tbs.serialNumber)),
      ...(Number.isNaN(notBefore.getTime()) ? {} : { notBefore: notBefore.toISOString() }),
      ...(Number.isNaN(notAfter.getTime()) ? {} : { notAfter: notAfter.toISOString() }),
      ...(Object.keys(subject.attributes).length > 0
        ? { subjectAttributes: subject.attributes }
        : {}),
      signatureAlgorithm: toAlgorithm(certificate.signatureAlgorithm.algorithm),
      publicKeyAlgorithm: toAlgorithm(tbs.subjectPublicKeyInfo.algorithm.algorithm),
    };
  } catch (error) {
    warnings.push({
      code: 'W_SIGNATURE_CERT',
      message: `签章者证书解析失败：${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}

/** 读取 DN 的常用属性与格式化文本。 */
function readName(name: unknown): {
  readonly attributes: CertificateAttributes;
  readonly formatted: string;
} {
  const attributes: Partial<Record<keyof CertificateAttributes, string>> = {};
  const parts: string[] = [];
  const rdns = Array.isArray(name) ? name : [];
  for (const rdn of rdns) {
    if (!Array.isArray(rdn)) continue;
    const inner: string[] = [];
    for (const item of rdn) {
      const attribute = item as { type?: unknown; value?: unknown };
      if (typeof attribute.type !== 'string') continue;
      const text = attributeText(attribute.value);
      if (text === undefined) continue;
      const known = DN_ATTRIBUTES[attribute.type];
      if (known && attributes[known.key] === undefined) attributes[known.key] = text;
      inner.push(`${known?.label ?? attribute.type}=${text}`);
    }
    if (inner.length > 0) parts.push(inner.join('+'));
  }
  return {
    attributes: attributes as CertificateAttributes,
    formatted: parts.reverse().join(', '),
  };
}

/** 从 `@peculiar/asn1-x509` 的字符串对象中取值。 */
function attributeText(value: unknown): string | undefined {
  if (typeof value === 'string') return sanitizeText(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of [
      'utf8String',
      'printableString',
      'ia5String',
      'bmpString',
      'teletexString',
      'universalString',
      'numericString',
      'visibleString',
    ]) {
      const text = record[key];
      if (typeof text === 'string') return sanitizeText(text);
    }
    if (typeof (value as { toString?: unknown }).toString === 'function') {
      const text = String(value);
      if (text && text !== '[object Object]') return sanitizeText(text);
    }
  }
  return undefined;
}

/** 移除控制字符，避免污染 UI。 */
function sanitizeText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** 构造算法信息。 */
function toAlgorithm(oid: string): AlgorithmInfo {
  const name = ALGORITHM_NAMES[oid];
  return name ? { oid, name } : { oid };
}

// ---------------------------------------------------------------------------
// ASN.1 基础工具
// ---------------------------------------------------------------------------

/** 统计节点数与深度；超限抛解析错误。 */
function assertTreeLimits(root: AsnNode, limits: SignatureParseLimits): void {
  let nodes = 0;
  const stack: Array<{ node: AsnNode; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new SignatureParseError(
        'W_SIGNATURE_LIMIT',
        `签名值 ASN.1 节点数超过上限（${limits.maxNodes}）`,
      );
    }
    if (current.depth > limits.maxDepth) {
      throw new SignatureParseError(
        'W_SIGNATURE_LIMIT',
        `签名值 ASN.1 嵌套深度超过上限（${limits.maxDepth}）`,
      );
    }
    for (const child of children(current.node)) {
      stack.push({ node: child, depth: current.depth + 1 });
    }
  }
}

/** 读取子节点。 */
function children(node: AsnNode): AsnNode[] {
  const value = node.valueBlock?.value;
  return Array.isArray(value) ? (value as AsnNode[]) : [];
}

/** 标签信息。 */
function tagOf(node: AsnNode): number | undefined {
  return node.idBlock?.tagClass === CLASS_UNIVERSAL ? node.idBlock?.tagNumber : undefined;
}

/** 是否为 SEQUENCE。 */
function isSequence(node: AsnNode): boolean {
  return tagOf(node) === TAG_SEQUENCE;
}

/** 是否为 INTEGER。 */
function isInteger(node: AsnNode): boolean {
  return tagOf(node) === TAG_INTEGER;
}

/** 读取整数。 */
function intValue(node: AsnNode | undefined): number | undefined {
  if (!node || !isInteger(node)) return undefined;
  const value = node.valueBlock?.valueDec;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

/** 读取字符串值。 */
function stringValue(node: AsnNode | undefined): string | undefined {
  const value = node?.valueBlock?.value;
  if (typeof value !== 'string') return undefined;
  const text = sanitizeText(value);
  return text.length > 0 ? text : undefined;
}

/** 读取 OID。 */
function oidValue(node: AsnNode | undefined): string | undefined {
  if (!node || tagOf(node) !== TAG_OID) return undefined;
  const value = node.valueBlock?.toString?.();
  return value && /^\d+(?:\.\d+)+$/.test(value) ? value : undefined;
}

/** 读取 OCTET STRING 字节。 */
function octetBytes(node: AsnNode | undefined): Uint8Array | undefined {
  if (!node || tagOf(node) !== TAG_OCTET_STRING) return undefined;
  const view = node.valueBlock?.valueHexView;
  return view ? Uint8Array.from(view) : new Uint8Array();
}

/** 读取 BIT STRING 字节并按 unused bits 掩码。 */
function bitStringBytes(node: AsnNode | undefined): Uint8Array | undefined {
  if (!node || tagOf(node) !== TAG_BIT_STRING) return undefined;
  const view = node.valueBlock?.valueHexView;
  if (!view) return new Uint8Array();
  const bytes = Uint8Array.from(view);
  const unused = node.valueBlock?.unusedBits ?? 0;
  if (unused > 0 && bytes.length > 0) {
    bytes[bytes.length - 1] &= (0xff << unused) & 0xff;
  }
  return bytes;
}

/** 读取 BIT STRING 的十六进制摘要。 */
function bitStringHex(node: AsnNode | undefined): string | undefined {
  const bytes = bitStringBytes(node);
  if (!bytes || bytes.byteLength === 0) return undefined;
  return bytesToHex(bytes);
}

/** 字节转小写十六进制。 */
function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

/** ASCII 解码；含不可打印字符时返回 undefined。 */
function asciiText(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  let text = '';
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) return undefined;
    text += String.fromCharCode(byte);
  }
  return text.trim() || undefined;
}

/** Uint8Array 复制为独立 ArrayBuffer。 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return copy as ArrayBuffer;
}

/** 数字版本转标签。 */
function versionLabel(value: number | undefined): 'v1' | 'v4' | 'v5' | undefined {
  if (value === 1) return 'v1';
  if (value === 4) return 'v4';
  if (value === 5) return 'v5';
  return undefined;
}