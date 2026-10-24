/**
 * 合成验证夹具：v1 SES_Signature/SESeal 与 GB/T 35275 authenticatedAttributes。
 *
 * 仅测试使用：私钥来自 fixture（testOnly），不写入日志或断言消息。
 */

import {
  OID_GM_DATA,
  OID_GM_SIGNED_DATA,
  OID_PKCS9_MESSAGE_DIGEST,
  OID_SM3,
  OID_SM3_WITH_SM2,
  derBitString,
  derContext,
  derGeneralizedTime,
  derInteger,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derUtf8String,
  encodeDerTlv,
  parseDer,
  parseSm2PrivateKey,
  sm2Sign,
  sm3Digest,
} from '@ofdrw/ofdrw-viewer-crypto';
import { MemoryVirtualContainer } from '../../src/container/index';
import {
  openZipVirtualContainer,
  type VirtualContainer,
} from '@ofdrw/ofdrw-viewer-engine';
import { fixtureBytes, fixtureText } from '../core/fixtures';

/** 规范化包内路径 → 明文字节。 */
export type EntryMap = Map<string, { bytes: Uint8Array; origin?: 'package' | 'decrypted' }>;

/**
 * 读取 fixture ZIP 的全部条目。
 *
 * @param name fixture 文件名。
 * @returns 条目表。
 */
export async function readFixtureEntries(name: string): Promise<EntryMap> {
  const container = await openZipVirtualContainer({
    kind: 'arraybuffer',
    data: fixtureBytes(name),
  });
  try {
    const entries: EntryMap = new Map();
    for (const meta of container.list()) {
      entries.set(meta.path, { bytes: await container.read(meta.path) });
    }
    return entries;
  } finally {
    await container.close();
  }
}

/**
 * 把条目表封装为明文容器。
 *
 * @param entries 条目表。
 * @returns 内存容器。
 */
export function wrapEntries(entries: EntryMap): VirtualContainer {
  return new MemoryVirtualContainer(entries, 4096);
}

/**
 * 解析 fixture 私钥的 32 byte 标量。
 *
 * @param name 私钥文件名（certs 下）。
 * @returns 私钥标量。
 */
function privateScalar(name: string): Uint8Array {
  return parseSm2PrivateKey({ pem: fixtureText('certs', name) }).privateKey;
}

/**
 * 读取证书的 issuer Name 原始 DER。
 *
 * @param certificateDer 证书 DER。
 * @returns issuer TLV。
 */
function issuerRaw(certificateDer: Uint8Array): Uint8Array {
  const root = parseDer(certificateDer).requireSequence();
  const tbs = root.children[0]?.requireSequence();
  if (!tbs) throw new Error('测试证书缺少 TBSCertificate');
  const start = tbs.children[0]?.isContext(0) ? 1 : 0;
  const issuer = tbs.children[start + 2];
  if (!issuer) throw new Error('测试证书缺少 issuer');
  return issuer.raw;
}

/**
 * 读取证书序列号。
 *
 * @param certificateDer 证书 DER。
 * @returns 序列号 BigInt。
 */
function serialOf(certificateDer: Uint8Array): bigint {
  const root = parseDer(certificateDer).requireSequence();
  const tbs = root.children[0]?.requireSequence();
  if (!tbs) throw new Error('测试证书缺少 TBSCertificate');
  const start = tbs.children[0]?.isContext(0) ? 1 : 0;
  return tbs.children[start]?.asInteger() ?? 0n;
}

/** v1 合成容器选项。 */
export interface V1BuildOptions {
  /** TBS_Sign.propertyInfo（默认等于 Signature.xml 包内路径）。 */
  readonly propertyInfo?: string;
  /** TBS_Sign.version（默认 1）。 */
  readonly versionNumber?: number;
  /** 签名算法 OID（默认 SM3withSM2）。 */
  readonly signatureAlgorithm?: string;
  /** References@CheckMethod（默认 SM3）。 */
  readonly checkMethod?: string;
  /** 签章者证书 DER。 */
  readonly signerCert?: Uint8Array;
  /** 签章者私钥标量。 */
  readonly signerKey?: Uint8Array;
  /** TBS_Sign.timeInfo 原始编码；省略时写入默认时间文本。 */
  readonly timeInfo?: Uint8Array;
  /** 是否省略 Signature.xml 的 SignatureDateTime。 */
  readonly omitSignatureDateTime?: boolean;
  /** 印章图片形态。 */
  readonly picture?: 'valid' | 'missing' | 'corrupt';
  /** 是否额外加入一条 BaseLoc 非法的签名记录。 */
  readonly badBaseLocRecord?: boolean;
}

/**
 * 构造 v1 SignedValue + Signature.xml + Signatures.xml + OFD.xml 的明文容器。
 *
 * 其中 OFD.xml 的 CheckValue 使用 64 字符十六进制，Document.xml 使用 Base64，
 * 用于验证 CheckValue 双格式兼容。
 *
 * @param options 覆盖 propertyInfo/算法/证书/图片等字段。
 * @returns 明文容器。
 */
export async function buildV1SignedContainer(
  options: V1BuildOptions = {},
): Promise<VirtualContainer> {
  const signerCert = options.signerCert ?? fixtureBytes('certs', 'signer.crt.der');
  const sealCert = fixtureBytes('certs', 'seal.crt.der');
  const signerKey = options.signerKey ?? privateScalar('signer.key.pem');
  const sealKey = privateScalar('seal.key.pem');

  const ofdXml = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0" DocType="OFD">' +
      '<ofd:DocBody><ofd:DocInfo><ofd:DocID>synthetic-v1</ofd:DocID></ofd:DocInfo>' +
      '<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>' +
      '<ofd:Signatures>Doc_0/Signs/Signatures.xml</ofd:Signatures>' +
      '</ofd:DocBody></ofd:OFD>',
  );
  const documentXml = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"/>',
  );

  // 1) v1 SESeal：SES_SealInfo + SES_SignInfo。
  const picture = options.picture === 'missing'
    ? undefined
    : options.picture === 'corrupt'
      ? derSequence(derInteger(1n))
      : derSequence(
          derUtf8String('PNG'),
          derOctetString(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
          derInteger(40n),
          derInteger(40n),
        );
  const sealInfo = derSequence(
    derSequence(derUtf8String('ES'), derInteger(1n), derUtf8String('1.0')),
    derUtf8String('synthetic-es-v1'),
    derSequence(
      derInteger(1n),
      derUtf8String('合成测试印章'),
      derSequence(derOctetString(sealCert)),
      derGeneralizedTime(new Date('2026-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2025-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2040-01-01T00:00:00Z')),
    ),
    ...(picture ? [picture] : []),
  );
  const sealCertOctets = derOctetString(sealCert);
  const sealAlg = derOid(OID_SM3_WITH_SM2);
  const sealSignature = sm2Sign(
    derSequence(sealInfo, sealCertOctets, sealAlg),
    sealKey,
  );
  const seal = derSequence(
    sealInfo,
    derSequence(sealCertOctets, sealAlg, derBitString(sealSignature)),
  );

  // 2) Signature.xml：先构造正文，再计算 dataHash。
  const signatureXml = (dataHashBase64: string): Uint8Array => {
    const text =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ofd:Signature xmlns:ofd="http://www.ofdspec.org/2016">' +
      '<ofd:SignedValue>/Doc_0/Signs/Sign_0/SignedValue.dat</ofd:SignedValue>' +
      '<ofd:SignedInfo>' +
      '<ofd:Provider ProviderName="synthetic" Company="test" Version="1"/>' +
      `<ofd:SignatureMethod>${OID_SM3_WITH_SM2}</ofd:SignatureMethod>` +
      (options.omitSignatureDateTime
        ? ''
        : '<ofd:SignatureDateTime>2026-10-23 10:00:00</ofd:SignatureDateTime>') +
      '<ofd:Seal><ofd:BaseLoc>/Doc_0/Signs/Sign_0/Seal.esl</ofd:BaseLoc></ofd:Seal>' +
      `<ofd:References CheckMethod="${options.checkMethod ?? 'SM3'}">` +
      `<ofd:Reference FileRef="/OFD.xml"><ofd:CheckValue>${hex(sm3Digest(ofdXml))}</ofd:CheckValue></ofd:Reference>` +
      `<ofd:Reference FileRef="/Doc_0/Document.xml"><ofd:CheckValue>${dataHashBase64}</ofd:CheckValue></ofd:Reference>` +
      '</ofd:References>' +
      '</ofd:SignedInfo></ofd:Signature>';
    return new TextEncoder().encode(text);
  };
  const documentCheck = base64(sm3Digest(documentXml));
  const signatureBytes = signatureXml(documentCheck);
  const dataHash = sm3Digest(signatureBytes);

  // 3) v1 SES_Signature：TBS_Sign + SIGNATURE。
  const tbs = derSequence(
    derInteger(BigInt(options.versionNumber ?? 1)),
    seal,
    options.timeInfo ?? derOctetString(new TextEncoder().encode('2026-10-23 10:00:00')),
    derOctetString(dataHash),
    derUtf8String(options.propertyInfo ?? '/Doc_0/Signs/Sign_0/Signature.xml'),
    derOctetString(signerCert),
    derOid(options.signatureAlgorithm ?? OID_SM3_WITH_SM2),
  );
  const signedValue = derSequence(tbs, derBitString(sm2Sign(tbs, signerKey)));

  const signaturesXml = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
      (options.badBaseLocRecord
        ? '<ofd:Signature ID="bad" Type="Seal" BaseLoc="../escape/Signature.xml"/>'
        : '') +
      '<ofd:Signature ID="s001" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
      '<ofd:MaxSignId>s001</ofd:MaxSignId></ofd:Signatures>',
  );

  return wrapEntries(
    new Map([
      ['OFD.xml', { bytes: ofdXml }],
      ['Doc_0/Document.xml', { bytes: documentXml }],
      ['Doc_0/Signs/Signatures.xml', { bytes: signaturesXml }],
      ['Doc_0/Signs/Sign_0/Signature.xml', { bytes: signatureBytes }],
      ['Doc_0/Signs/Sign_0/SignedValue.dat', { bytes: signedValue }],
      ['Doc_0/Signs/Sign_0/Seal.esl', { bytes: seal }],
    ]),
  );
}

/** authenticatedAttributes 完整性容器选项。 */
export interface AuthAttrsBuildOptions {
  /** 篡改 messageDigest。 */
  readonly tamperDigest?: boolean;
  /** 省略 contentType 属性。 */
  readonly omitContentType?: boolean;
  /** SignerInfo.digestAlgorithm（默认 SM3）。 */
  readonly signerDigestAlgorithm?: string;
  /** SignedData.digestAlgorithms（默认 SM3）。 */
  readonly digestAlgorithmsOid?: string;
  /** encapContentInfo.eContentType（默认 data）。 */
  readonly eContentTypeOid?: string;
  /** 是否写入 eContent（等于 OFDEntries.xml 原文）。 */
  readonly includeEContent?: boolean;
  /** 签章者证书 DER。 */
  readonly signerCert?: Uint8Array;
  /** 签名者私钥标量。 */
  readonly signerKey?: Uint8Array;
  /** SignedData 内嵌的额外证书 DER。 */
  readonly extraCertificates?: readonly Uint8Array[];
  /** 基础条目表；默认 integrity.ofd。 */
  readonly entries?: EntryMap;
}

/**
 * 构造带 authenticatedAttributes 的 GB/T 35275 SignedData 容器。
 *
 * 基于 `integrity.ofd` 明文条目，仅替换根目录 `signedvalue.dat`。
 *
 * @param options 篡改/算法/证书等覆盖项。
 * @returns 明文容器。
 */
export async function buildAuthAttrsIntegrityContainer(
  options: AuthAttrsBuildOptions = {},
): Promise<VirtualContainer> {
  const entries = options.entries ?? (await readFixtureEntries('integrity.ofd'));
  const entriesXml = entries.get('OFDEntries.xml')?.bytes;
  if (!entriesXml) throw new Error('integrity 条目缺少 OFDEntries.xml');
  const signerCert = options.signerCert ?? fixtureBytes('certs', 'signer.crt.der');
  const signerKey = options.signerKey ?? privateScalar('signer.key.pem');
  const eContent = options.includeEContent ? entriesXml : undefined;
  const digest = new Uint8Array(eContent ? sm3Digest(eContent) : sm3Digest(entriesXml));
  if (options.tamperDigest) digest[0] = digest[0] ^ 0xff;

  const attributes: Uint8Array[] = [];
  if (!options.omitContentType) {
    attributes.push(
      derSequence(derOid('1.2.840.113549.1.9.3'), derSet(derOid(OID_GM_DATA))),
    );
  }
  attributes.push(
    derSequence(derOid(OID_PKCS9_MESSAGE_DIGEST), derSet(derOctetString(digest))),
  );
  const signedAttributes = derSet(...attributes);
  const implicitAttributes = new Uint8Array(signedAttributes);
  implicitAttributes[0] = 0xa0;
  const signature = sm2Sign(signedAttributes, signerKey);

  const signerInfo = derSequence(
    derInteger(1n),
    derSequence(issuerRaw(signerCert), derInteger(serialOf(signerCert))),
    derSequence(derOid(options.signerDigestAlgorithm ?? OID_SM3), derNull()),
    implicitAttributes,
    derSequence(derOid(OID_SM3_WITH_SM2)),
    derOctetString(signature),
  );
  const encap = options.includeEContent
    ? derSequence(
        derOid(options.eContentTypeOid ?? OID_GM_DATA),
        derContext(0, derOctetString(eContent!)),
      )
    : derSequence(derOid(options.eContentTypeOid ?? OID_GM_DATA));
  const certificates = [signerCert, ...(options.extraCertificates ?? [])];
  const signedData = derSequence(
    derInteger(1n),
    derSet(derSequence(derOid(options.digestAlgorithmsOid ?? OID_SM3), derNull())),
    encap,
    derContext(0, derSet(...certificates)),
    derSet(signerInfo),
  );
  const contentInfo = derSequence(
    derOid(OID_GM_SIGNED_DATA),
    derContext(0, signedData),
  );

  const replaced: EntryMap = new Map();
  for (const [path, entry] of entries) {
    if (path === 'signedvalue.dat') replaced.set(path, { bytes: contentInfo });
    else replaced.set(path, entry);
  }
  return wrapEntries(replaced);
}

/**
 * 字节转小写十六进制。
 *
 * @param bytes 字节。
 * @returns 十六进制。
 */
function hex(bytes: Uint8Array): string {
  return toHexLocal(bytes);
}

/**
 * 本地十六进制编码。
 *
 * @param bytes 字节。
 * @returns 十六进制。
 */
function toHexLocal(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * 字节转 Base64。
 *
 * @param bytes 字节。
 * @returns Base64。
 */
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * 读取容器的全部条目。
 *
 * @param container 容器。
 * @returns 条目表。
 */
export async function readEntriesOf(container: VirtualContainer): Promise<EntryMap> {
  const entries: EntryMap = new Map();
  for (const meta of container.list()) {
    entries.set(meta.path, { bytes: await container.read(meta.path) });
  }
  return entries;
}

/**
 * 合并两个条目表；`extra` 覆盖同名条目。
 *
 * @param base 基础条目表。
 * @param extra 追加条目表。
 * @returns 合并后的新条目表。
 */
export function mergeEntries(base: EntryMap, extra: EntryMap): EntryMap {
  const merged: EntryMap = new Map(base);
  for (const [path, entry] of extra) merged.set(path, entry);
  return merged;
}

/**
 * 构造带 [0] 时间戳的 v5 SESeal（仅解析测试，签名值不保证有效）。
 *
 * @param token CMS 时间戳令牌字节。
 * @param headerVersion SES_Header.version，默认 5。
 * @returns SESeal DER。
 */
export function buildV5SealWithTimestamp(token: Uint8Array, headerVersion = 5): Uint8Array {
  const sealCert = fixtureBytes('certs', 'seal.crt.der');
  const sealKey = privateScalar('seal.key.pem');
  const sealInfo = derSequence(
    derSequence(derUtf8String('ES'), derInteger(BigInt(headerVersion)), derUtf8String('5.0')),
    derUtf8String('synthetic-es-v5-ts'),
    derSequence(
      derInteger(1n),
      derUtf8String('时间戳测试印章'),
      derInteger(1n),
      derSequence(derOctetString(sealCert)),
      derGeneralizedTime(new Date('2026-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2025-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2040-01-01T00:00:00Z')),
    ),
    derSequence(
      derUtf8String('PNG'),
      derOctetString(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      derInteger(40n),
      derInteger(40n),
    ),
  );
  return derSequence(
    sealInfo,
    derOctetString(sealCert),
    derOid(OID_SM3_WITH_SM2),
    derBitString(sm2Sign(sealInfo, sealKey)),
    derContext(0, derBitString(token)),
  );
}

/**
 * 从 signed-sesv4 读取 v4 时间戳令牌。
 *
 * @returns CMS 时间戳令牌字节。
 */
export async function readV4TimestampToken(): Promise<Uint8Array> {
  const entries = await readFixtureEntries('signed-sesv4.ofd');
  const bytes = entries.get('Doc_0/Signs/Sign_0/SignedValue.dat')?.bytes;
  if (!bytes) throw new Error('夹具缺少 SignedValue.dat');
  const root = parseDer(bytes).requireSequence('SES_Signature');
  const wrapper = root.children[4];
  if (!wrapper) throw new Error('夹具缺少时间戳');
  const inner = wrapper.children[0];
  return inner ? inner.asBitStringOctets() : wrapper.asBitStringOctets();
}


/**
 * 构造 v1 SESeal（仅解析测试；证书数量/header 版本可按需覆盖）。
 *
 * @param headerVersion SES_Header.version，默认 1。
 * @param certificateCount certList 中的证书张数，默认 1。
 * @returns SESeal DER。
 */
export function buildV1Seal(headerVersion = 1, certificateCount = 1): Uint8Array {
  const sealCert = fixtureBytes('certs', 'seal.crt.der');
  const sealKey = privateScalar('seal.key.pem');
  const certOctets = derOctetString(sealCert);
  const alg = derOid(OID_SM3_WITH_SM2);
  const certList = derSequence(
    ...Array.from({ length: certificateCount }, () => derOctetString(sealCert)),
  );
  const sealInfo = derSequence(
    derSequence(derUtf8String('ES'), derInteger(BigInt(headerVersion)), derUtf8String('1.0')),
    derUtf8String('synthetic-es-v1'),
    derSequence(
      derInteger(1n),
      derUtf8String('v1 测试印章'),
      certList,
      derGeneralizedTime(new Date('2026-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2025-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2040-01-01T00:00:00Z')),
    ),
    derSequence(
      derUtf8String('PNG'),
      derOctetString(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      derInteger(40n),
      derInteger(40n),
    ),
  );
  return derSequence(
    sealInfo,
    derSequence(certOctets, alg, derBitString(sm2Sign(derSequence(sealInfo, certOctets, alg), sealKey))),
  );
}
