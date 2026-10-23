/**
 * X.509 证书解析（DER）。
 *
 * 只解析 OFD 密码能力需要的字段：主体/颁发者 DN、序列号、有效期、公钥、
 * 签名算法、BasicConstraints、KeyUsage、SKI/AKI、扩展原始 TLV。
 * 不在此层校验证书签名/链，由验证模块消费本结构。
 */

import { CryptoError } from '../errors';
import type { CertificateKeyUsage } from '../types/certificate';
import { copyBytes, toHex } from '../util/bytes';
import { sha256Hex } from '../util/hash';
import {
  DER_TAG,
  parseDer,
  type DerNode,
  type DerParseOptions,
} from './der';
import {
  dnLabel,
  oidName,
  OID_AUTHORITY_KEY_IDENTIFIER,
  OID_BASIC_CONSTRAINTS,
  OID_EC_PUBLIC_KEY,
  OID_EXTENDED_KEY_USAGE,
  OID_KEY_USAGE,
  OID_SM2_CURVE,
  OID_SUBJECT_KEY_IDENTIFIER,
} from './oid';

/** 一个 DN 属性。 */
export interface DistinguishedNameAttribute {
  /** 属性 OID。 */
  readonly oid: string;
  /** 短标签（未知 OID 为点分字符串）。 */
  readonly label: string;
  /** 属性值文本。 */
  readonly value: string;
}

/** 一个 X.509 扩展。 */
export interface X509Extension {
  /** 扩展 OID。 */
  readonly oid: string;
  /** 是否 critical。 */
  readonly critical: boolean;
  /** extnValue 内容（未再解析的 DER）。 */
  readonly value: Uint8Array;
  /** 扩展原始 TLV。 */
  readonly raw: Uint8Array;
}

/** 解析后的 X.509 证书。 */
export interface X509Certificate {
  /** 完整证书 DER。 */
  readonly der: Uint8Array;
  /** TBSCertificate 原始 TLV（验签原文）。 */
  readonly tbsDer: Uint8Array;
  /** X.509 版本（1..3）。 */
  readonly version: number;
  /** 序列号小写十六进制。 */
  readonly serialNumber: string;
  /** 主体 DN 文本。 */
  readonly subject: string;
  /** 颁发者 DN 文本。 */
  readonly issuer: string;
  /** 主体 DN 属性。 */
  readonly subjectAttributes: readonly DistinguishedNameAttribute[];
  /** 颁发者 DN 属性。 */
  readonly issuerAttributes: readonly DistinguishedNameAttribute[];
  /** 主体 Name 的原始 DER TLV。 */
  readonly subjectDer: Uint8Array;
  /** 颁发者 Name 的原始 DER TLV。 */
  readonly issuerDer: Uint8Array;
  /** 生效时间。 */
  readonly notBefore: Date;
  /** 失效时间。 */
  readonly notAfter: Date;
  /** 生效时间（ISO 8601）。 */
  readonly notBeforeISO: string;
  /** 失效时间（ISO 8601）。 */
  readonly notAfterISO: string;
  /** 公钥算法 OID。 */
  readonly publicKeyAlgorithm: string;
  /** 公钥算法可读名（SM2/EC/...）。 */
  readonly publicKeyAlgorithmName: string;
  /** EC 曲线 OID（若有）。 */
  readonly curveOid?: string;
  /** 公钥未压缩点字节（通常 65 byte，`04||X||Y`）。 */
  readonly publicKey: Uint8Array;
  /** 签名算法 OID。 */
  readonly signatureAlgorithm: string;
  /** 签名算法可读名（SM3withSM2/...）。 */
  readonly signatureAlgorithmName: string;
  /** 签名值（BIT STRING 内容，SM2 场景为 DER `SEQUENCE { r, s }`）。 */
  readonly signature: Uint8Array;
  /** 是否 CA（BasicConstraints.cA）。 */
  readonly isCA: boolean;
  /** BasicConstraints.pathLenConstraint（若存在）。 */
  readonly pathLenConstraint?: number;
  /** KeyUsage 名称（扩展不存在时为 undefined）。 */
  readonly keyUsage?: readonly CertificateKeyUsage[];
  /** ExtendedKeyUsage OID 列表（扩展不存在时为 undefined）。 */
  readonly extendedKeyUsage?: readonly string[];
  /** SubjectKeyIdentifier 小写十六进制。 */
  readonly subjectKeyIdentifier?: string;
  /** AuthorityKeyIdentifier 小写十六进制。 */
  readonly authorityKeyIdentifier?: string;
  /** 全部扩展。 */
  readonly extensions: readonly X509Extension[];
  /** 证书 DER 的 SHA-256 指纹，小写十六进制。 */
  readonly fingerprintSha256: string;
}

/** 证书有效期状态。 */
export type CertificateValidity = 'valid' | 'expired' | 'not-yet-valid';

/**
 * 解析 X.509 证书 DER。
 *
 * @param der 证书 DER（不接收 PEM；PEM 由 `certificatesToDer` 前置转换为 DER）。
 * @param options DER 解析上限。
 * @returns 证书结构；原始 DER/TBS 均为输入视图或副本，保留原始字节。
 * @throws CryptoError `CRYPTO_ASN1_INVALID` / `CRYPTO_CERTIFICATE_INVALID`。
 */
export function parseX509Certificate(
  der: Uint8Array,
  options?: DerParseOptions,
): X509Certificate {
  const root = parseDer(der, options).requireSequence('Certificate');
  if (root.children.length !== 3) {
    throw certificateError('Certificate 必须包含 tbsCertificate/signatureAlgorithm/signatureValue');
  }
  const tbs = root.children[0].requireSequence('TBSCertificate');
  if (tbs.children.length < 6) {
    throw certificateError('TBSCertificate 字段不足');
  }

  let index = 0;
  let version = 1;
  if (tbs.children[0].isContext(0)) {
    const versionNode = parseDer(tbs.children[0].value, options).requireUniversal(
      DER_TAG.INTEGER,
      'Version',
    );
    version = Number(versionNode.asInteger()) + 1;
    if (version < 1 || version > 3) {
      throw certificateError(`不支持的 X.509 版本 ${version}`);
    }
    index = 1;
  }

  const serialNode = tbs.children[index];
  if (!serialNode) throw certificateError('缺少 serialNumber');
  index += 1;
  const serialNumber = serialNode.asInteger().toString(16);

  const tbsSignatureAlgorithm = readAlgorithmIdentifier(tbs.children[index], 'tbs.signature');
  index += 1;

  const issuerNode = tbs.children[index];
  if (!issuerNode) throw certificateError('缺少 issuer');
  const issuer = readName(issuerNode, options);
  index += 1;

  const validityNode = tbs.children[index];
  if (!validityNode) throw certificateError('缺少 validity');
  index += 1;
  const validity = validityNode.requireSequence('Validity');
  if (validity.children.length !== 2) throw certificateError('Validity 必须包含两个时间');
  const notBefore = validity.children[0].asTime();
  const notAfter = validity.children[1].asTime();

  const subjectNode = tbs.children[index];
  if (!subjectNode) throw certificateError('缺少 subject');
  const subject = readName(subjectNode, options);
  index += 1;

  const spkiNode = tbs.children[index];
  if (!spkiNode) throw certificateError('缺少 subjectPublicKeyInfo');
  index += 1;
  const spki = spkiNode.requireSequence('SubjectPublicKeyInfo');
  if (spki.children.length < 2) throw certificateError('SubjectPublicKeyInfo 字段不足');
  const publicKeyAlgorithm = readAlgorithmIdentifier(spki.children[0], 'publicKeyAlgorithm');
  const publicKey = copyBytes(spki.children[1].asBitStringOctets());

  let curveOid: string | undefined;
  if (publicKeyAlgorithm.parameters) {
    try {
      curveOid = parseDer(publicKeyAlgorithm.parameters, options).asOid();
    } catch {
      // 非 OID 参数（例如 RSA NULL）不视为错误，按算法名展示即可。
      curveOid = undefined;
    }
  }
  const publicKeyAlgorithmName = publicKeyAlgorithmNameOf(
    publicKeyAlgorithm.oid,
    curveOid,
  );

  const signatureAlgorithm = readAlgorithmIdentifier(root.children[1], 'signatureAlgorithm');
  const signature = copyBytes(root.children[2].asBitStringOctets());

  let isCA = false;
  let pathLenConstraint: number | undefined;
  let keyUsage: CertificateKeyUsage[] | undefined;
  let extendedKeyUsage: string[] | undefined;
  let subjectKeyIdentifier: string | undefined;
  let authorityKeyIdentifier: string | undefined;

  const extensionsNode = tbs.findContext(3);
  const extensions = extensionsNode ? readExtensions(extensionsNode, options) : [];
  for (const extension of extensions) {
    switch (extension.oid) {
      case OID_BASIC_CONSTRAINTS: {
        const constraints = parseDer(extension.value, options).requireSequence('BasicConstraints');
        let position = 0;
        if (constraints.children[position]?.isUniversal(DER_TAG.BOOLEAN)) {
          isCA = constraints.children[position].asBoolean();
          position += 1;
        }
        const pathLenNode = constraints.children[position];
        if (pathLenNode) {
          const pathLen = pathLenNode.asInteger();
          if (pathLen < 0n || pathLen > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw certificateError('BasicConstraints.pathLenConstraint 非法');
          }
          pathLenConstraint = Number(pathLen);
        }
        break;
      }
      case OID_KEY_USAGE:
        keyUsage = readKeyUsage(extension.value, options);
        break;
      case OID_EXTENDED_KEY_USAGE: {
        const sequence = parseDer(extension.value, options).requireSequence('ExtKeyUsageSyntax');
        extendedKeyUsage = sequence.children.map((child) => child.asOid());
        break;
      }
      case OID_SUBJECT_KEY_IDENTIFIER:
        subjectKeyIdentifier = toHex(parseDer(extension.value, options).asOctets());
        break;
      case OID_AUTHORITY_KEY_IDENTIFIER:
        authorityKeyIdentifier = readAuthorityKeyIdentifier(extension.value, options);
        break;
      default:
        break;
    }
  }

  // tbs.signature 与 Certificate.signatureAlgorithm 必须一致（X.509 结构约束）。
  if (tbsSignatureAlgorithm.oid !== signatureAlgorithm.oid) {
    throw certificateError('tbsCertificate 与 Certificate 的签名算法不一致');
  }

  return {
    der,
    tbsDer: tbs.raw,
    version,
    serialNumber,
    subject: subject.text,
    issuer: issuer.text,
    subjectAttributes: subject.attributes,
    issuerAttributes: issuer.attributes,
    subjectDer: copyBytes(subject.raw),
    issuerDer: copyBytes(issuer.raw),
    notBefore,
    notAfter,
    notBeforeISO: notBefore.toISOString(),
    notAfterISO: notAfter.toISOString(),
    publicKeyAlgorithm: publicKeyAlgorithm.oid,
    publicKeyAlgorithmName,
    curveOid,
    publicKey,
    signatureAlgorithm: signatureAlgorithm.oid,
    signatureAlgorithmName: oidName(signatureAlgorithm.oid),
    signature,
    isCA,
    pathLenConstraint,
    keyUsage,
    extendedKeyUsage,
    subjectKeyIdentifier,
    authorityKeyIdentifier,
    extensions,
    fingerprintSha256: sha256Hex(der),
  };
}

/**
 * 判断证书在给定时间是否有效（边界包含 notBefore/notAfter）。
 *
 * @param certificate 证书。
 * @param now 当前时间，默认 `new Date()`。
 * @returns `valid` / `expired` / `not-yet-valid`。
 */
export function checkCertificateValidity(
  certificate: X509Certificate,
  now: Date = new Date(),
): CertificateValidity {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'now 必须是有效 Date');
  }
  const time = now.getTime();
  if (time < certificate.notBefore.getTime()) return 'not-yet-valid';
  if (time > certificate.notAfter.getTime()) return 'expired';
  return 'valid';
}

/** 算法标识。 */
interface AlgorithmIdentifier {
  /** 算法 OID。 */
  readonly oid: string;
  /** 参数原始 TLV（不含 tag/length 的 value 不保留）；无参数为 undefined。 */
  readonly parameters?: Uint8Array;
}

/**
 * 读取 AlgorithmIdentifier。
 *
 * @param node 节点。
 * @param label 结构名。
 * @returns 算法 OID 与参数原始 TLV。
 */
function readAlgorithmIdentifier(node: DerNode | undefined, label: string): AlgorithmIdentifier {
  if (!node) throw certificateError(`缺少 ${label}`);
  const sequence = node.requireSequence(label);
  if (sequence.children.length === 0) throw certificateError(`${label} 缺少 algorithm OID`);
  const oid = sequence.children[0].asOid();
  const parameters = sequence.children[1]?.raw;
  return { oid, parameters };
}

/**
 * 计算公钥算法可读名。
 *
 * @param algorithmOid 公钥算法 OID。
 * @param curveOid 曲线 OID。
 * @returns 可读名。
 */
function publicKeyAlgorithmNameOf(algorithmOid: string, curveOid?: string): string {
  if (algorithmOid === OID_EC_PUBLIC_KEY) {
    return curveOid === OID_SM2_CURVE ? 'SM2' : 'EC';
  }
  return oidName(algorithmOid);
}

/**
 * 读取 Name。
 *
 * @param node Name 节点。
 * @param options DER 解析上限。
 * @returns DN 文本与属性。
 */
function readName(
  node: DerNode,
  options?: DerParseOptions,
): {
  readonly text: string;
  readonly attributes: readonly DistinguishedNameAttribute[];
  readonly raw: Uint8Array;
} {
  const sequence = node.requireSequence('Name');
  const raw = copyBytes(node.raw);
  const attributes: DistinguishedNameAttribute[] = [];
  for (const rdn of sequence.children) {
    rdn.requireUniversal(DER_TAG.SET, 'RelativeDistinguishedName');
    for (const attribute of rdn.children) {
      const pair = attribute.requireSequence('AttributeTypeAndValue');
      if (pair.children.length < 2) throw certificateError('AttributeTypeAndValue 字段不足');
      const oid = pair.children[0].asOid();
      const value = readAttributeValue(pair.children[1]);
      attributes.push({ oid, label: dnLabel(oid), value });
    }
  }
  return {
    text: attributes.map((item) => `${item.label}=${escapeDnValue(item.value)}`).join(','),
    attributes,
    raw,
  };
}

/**
 * 读取 DN 属性值。
 *
 * @param node 属性值节点。
 * @returns 文本；无法识别的类型用 `#` + 十六进制。
 */
function readAttributeValue(node: DerNode): string {
  try {
    return node.asString();
  } catch {
    return `#${toHex(node.raw)}`;
  }
}

/**
 * 按 RFC 4514 转义 DN 属性值。
 *
 * @param value 原值。
 * @returns 转义后的文本。
 */
function escapeDnValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (',+"\\<>;='.includes(char)) {
      out += `\\${char}`;
    } else if (char === '#' && i === 0) {
      out += '\\#';
    } else if (char === ' ' && (i === 0 || i === value.length - 1)) {
      out += '\\ ';
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * 读取扩展列表。
 *
 * @param node `[3] EXPLICIT Extensions` 节点。
 * @param options DER 解析上限。
 * @returns 扩展数组。
 */
function readExtensions(node: DerNode, options?: DerParseOptions): X509Extension[] {
  const sequence = parseDer(node.value, options).requireSequence('Extensions');
  const extensions: X509Extension[] = [];
  for (const item of sequence.children) {
    const extension = item.requireSequence('Extension');
    if (extension.children.length < 2) throw certificateError('Extension 字段不足');
    const oid = extension.children[0].asOid();
    let index = 1;
    let critical = false;
    if (extension.children[index]?.isUniversal(DER_TAG.BOOLEAN)) {
      critical = extension.children[index].asBoolean();
      index += 1;
    }
    const valueNode = extension.children[index];
    if (!valueNode) throw certificateError('Extension 缺少 extnValue');
    extensions.push({
      oid,
      critical,
      value: valueNode.asOctets(),
      raw: extension.raw,
    });
  }
  return extensions;
}

/** KeyUsage 比特位顺序（X.509 §4.2.1.3）。 */
const KEY_USAGE_BITS: readonly CertificateKeyUsage[] = Object.freeze([
  'digitalSignature',
  'nonRepudiation',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
]);

/**
 * 解析 KeyUsage 扩展。
 *
 * @param value extnValue 内容。
 * @param options DER 解析上限。
 * @returns KeyUsage 名称数组。
 */
function readKeyUsage(value: Uint8Array, options?: DerParseOptions): CertificateKeyUsage[] {
  const bits = parseDer(value, options).asBitString();
  const usage: CertificateKeyUsage[] = [];
  for (let bit = 0; bit < KEY_USAGE_BITS.length; bit += 1) {
    const byteIndex = Math.floor(bit / 8);
    if (byteIndex >= bits.bytes.length) break;
    if ((bits.bytes[byteIndex] & (0x80 >> bit % 8)) !== 0) {
      usage.push(KEY_USAGE_BITS[bit]);
    }
  }
  return usage;
}

/**
 * 解析 AuthorityKeyIdentifier 扩展。
 *
 * @param value extnValue 内容。
 * @param options DER 解析上限。
 * @returns keyIdentifier 小写十六进制；不存在时返回 undefined。
 */
function readAuthorityKeyIdentifier(
  value: Uint8Array,
  options?: DerParseOptions,
): string | undefined {
  const sequence = parseDer(value, options).requireSequence('AuthorityKeyIdentifier');
  const keyIdentifier = sequence.findContext(0);
  if (!keyIdentifier) return undefined;
  const bytes = keyIdentifier.tag.constructed
    ? parseDer(keyIdentifier.value, options).asOctets()
    : keyIdentifier.value;
  return toHex(bytes);
}

/**
 * 构造证书结构错误。
 *
 * @param message 信息。
 * @returns CryptoError。
 */
function certificateError(message: string): CryptoError {
  return new CryptoError('CRYPTO_CERTIFICATE_INVALID', `证书结构非法：${message}`);
}