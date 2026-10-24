/**
 * t13 独立验证支撑：只读取公开夹具、公开 API 与 Java 基线，不依赖产品实现或 t7 测试辅助。
 */

import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import {
  OID_SM3,
  OID_SM3_WITH_SM2,
  type CryptoError,
  type VerifyOfdOptions,
  derBitString,
  derContext,
  derGeneralizedTime,
  derInteger,
  derOctetString,
  derOid,
  derSequence,
  derUtf8String,
  parseDer,
  parseSignedValue,
  parseSm2PrivateKey,
  parseTimestamp,
  sm2Sign,
  sm3Digest,
  type ParsedSignedValue,
  type TimestampParseResult,
  type VerificationReport,
  verifyOfd,
} from '@ofdrw/ofdrw-viewer-crypto';
import { MemoryVirtualContainer } from '../../../src/container/index';
import type { VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { FIXED_NOW } from '../../core/fixtures';

/** fixture 根目录。 */
const FIXTURE_ROOT = new URL('../../fixtures/crypto/', import.meta.url);

/** fixture 目录绝对路径（供错误信息使用）。 */
export const fixtureDirectory = FIXTURE_ROOT.pathname;

/** 读取 fixture 文件字节。 */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURE_ROOT)));
}

/** 读取 fixture 文本。 */
export function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), 'utf8');
}

/** 读取 fixture ZIP 明文条目（忽略目录项）。 */
export function fixtureEntries(name: string): Map<string, Uint8Array> {
  const raw = unzipSync(fixtureBytes(name));
  const entries = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(raw)) {
    if (!path.endsWith('/')) entries.set(path, bytes);
  }
  return entries;
}

/** 由 ZIP 条目构造内存明文容器。 */
export function memoryContainer(entries: ReadonlyMap<string, Uint8Array>): VirtualContainer {
  const mapped = new Map<string, { bytes: Uint8Array; origin: 'package' }>();
  for (const [path, bytes] of entries) mapped.set(path, { bytes, origin: 'package' });
  return new MemoryVirtualContainer(mapped, [...entries.values()].reduce((sum, bytes) => sum + bytes.length, 0));
}

/** 复制 fixture 为可变容器。 */
export function openFixtureEntries(name: string): Map<string, Uint8Array> {
  return new Map([...fixtureEntries(name)].map(([path, bytes]) => [path, new Uint8Array(bytes)]));
}

/** 读取 fixture 条目。 */
export function entryOf(name: string, path: string): Uint8Array {
  const bytes = fixtureEntries(name).get(path);
  if (!bytes) throw new Error(`${name} 缺少条目 ${path}`);
  return bytes;
}

/** 默认信任根 DER。 */
export const rootDer = fixtureBytes('certs/root-ca.crt.der');

/** 错误根证书 DER（加密证书，不属于签名链）。 */
export const wrongRootDer = fixtureBytes('certs/encrypt.crt.der');

/** 生成 verifyOfd 选项，默认注入根证书与固定当前时间。 */
export function verifyOptions(
  overrides: Partial<Omit<VerifyOfdOptions, 'container' | 'source'>> = {},
): Omit<VerifyOfdOptions, 'container' | 'source'> {
  return { roots: [rootDer], now: FIXED_NOW, ...overrides };
}

/**
 * 打开 fixture 并验证。
 *
 * 默认参数在函数体内合并，保证调用方传 `{}` 或不传时都会注入固定根证书与 {@link FIXED_NOW}。
 *
 * @param name 夹具文件名。
 * @param options 额外验证选项；同名字段覆盖默认值。
 * @returns 验证报告。
 */
export async function verifyFixture(
  name: string,
  options: Omit<VerifyOfdOptions, 'container' | 'source'> = {},
): Promise<VerificationReport> {
  const container = memoryContainer(fixtureEntries(name));
  try {
    return await verifyOfd({ container, ...verifyOptions(options) });
  } finally {
    await container.close();
  }
}

/**
 * 对给定容器验证。
 *
 * @param container 待验证容器。
 * @param options 额外验证选项；同名字段覆盖默认值。
 * @returns 验证报告。
 */
export async function verifyContainer(
  container: VirtualContainer,
  options: Omit<VerifyOfdOptions, 'container' | 'source'> = {},
): Promise<VerificationReport> {
  return verifyOfd({ container, ...verifyOptions(options) });
}

/** 执行异步函数并返回 CryptoError 错误码。 */
export async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const code = (error as CryptoError | undefined)?.code;
    if (typeof code === 'string') return code;
    throw error;
  }
  throw new Error('未按预期抛出 CryptoError');
}

/** 执行同步函数并返回 CryptoError 错误码。 */
export function syncCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const code = (error as CryptoError | undefined)?.code;
    if (typeof code === 'string') return code;
    throw error;
  }
  throw new Error('未按预期抛出 CryptoError');
}

/** 把 ISO 时间统一到 Java 的秒级输出，便于与 ofdrw 基线比较。 */
export function javaIsoTime(value: string | undefined): string | undefined {
  return value?.replace(/\.000Z$/, 'Z');
}

/** Java 基线结构化视图。 */
interface JavaFailure {
  readonly valid: boolean;
  readonly error?: string;
  readonly message?: string;
}

interface JavaSeal {
  readonly version: string;
  readonly esId: string;
  readonly name: string;
  readonly typeCode: number;
  readonly createDate: string;
  readonly validStart: string;
  readonly validEnd: string;
  readonly pictureType: string;
  readonly pictureWidthMm: number;
  readonly pictureHeightMm: number;
  readonly pictureLength: number;
}

interface JavaSignedValue {
  readonly version: string;
  readonly dataHash: string;
  readonly signedAt: string;
  readonly propertyInfo: string;
}

interface JavaExpected {
  readonly generatedBy: string;
  readonly ofdrwVersion: string;
  readonly cases: Readonly<Record<string, { readonly signature?: JavaFailure; readonly integrity?: JavaFailure }>>;
  readonly seals: Readonly<Record<string, JavaSeal>>;
  readonly signedValues: Readonly<Record<string, JavaSignedValue>>;
}

/** 读取 Java 基线。 */
export function javaExpected(): JavaExpected {
  return JSON.parse(
    readFileSync(new URL('./java-expected.json', import.meta.url), 'utf8'),
  ) as JavaExpected;
}

/** 读取 Java 基线中的签名结果；缺失时抛错。 */
export function javaSignature(file: string): JavaFailure {
  const result = javaExpected().cases[file]?.signature;
  if (!result) throw new Error(`Java 基线缺少 ${file} 的签名结果`);
  return result;
}

/** 读取 Java 基线中的完整性结果；缺失时抛错。 */
export function javaIntegrity(file: string): JavaFailure {
  const result = javaExpected().cases[file]?.integrity;
  if (!result) throw new Error(`Java 基线缺少 ${file} 的完整性结果`);
  return result;
}

/** 翻转 SignedValue 的签章签名值首字节，保持 DER 结构合法。 */
export function tamperSignedValueSignature(signedValue: Uint8Array): Uint8Array {
  const root = parseDer(signedValue).requireSequence();
  const signature = root.children[3]?.asBitStringOctets();
  if (!signature) throw new Error('SignedValue 缺少签名值');
  signature[0] ^= 0x01;
  const parts = [root.children[0]!.raw, root.children[1]!.raw, root.children[2]!.raw, derBitString(signature)];
  if (root.children[4]) parts.push(root.children[4].raw);
  return derSequence(...parts);
}

/** 翻转 Seal.esl 制章人签名值首字节，保持 DER 结构合法。 */
export function tamperSealSignature(seal: Uint8Array): Uint8Array {
  const root = parseDer(seal).requireSequence();
  const signature = root.children[3]?.asBitStringOctets();
  if (!signature) throw new Error('Seal 缺少制章人签名值');
  signature[0] ^= 0x01;
  const parts = [root.children[0]!.raw, root.children[1]!.raw, root.children[2]!.raw, derBitString(signature)];
  if (root.children[4]) parts.push(root.children[4].raw);
  return derSequence(...parts);
}

/** 提取 SignedValue 的签章签名值（TBS_Sign 之后的 BIT STRING）。 */
export function signatureValueOf(signedValue: Uint8Array): Uint8Array {
  const root = parseDer(signedValue).requireSequence();
  const signature = root.children[3];
  if (!signature) throw new Error('SignedValue 缺少签名值');
  return signature.asBitStringOctets();
}

/** 提取 SignedValue 外层 [0] 时间戳令牌。 */
export function timestampTokenOf(signedValue: Uint8Array): Uint8Array {
  const root = parseDer(signedValue).requireSequence();
  const context = root.children.find((child) => child.isContext(0));
  if (!context?.children[0]) throw new Error('SignedValue 缺少时间戳令牌');
  return context.children[0].asBitStringOctets();
}

/** 解析 fixture 的 SignedValue、Seal 与时间戳。 */
export function parseFixtureSignature(file: string): {
  readonly signedValue: ParsedSignedValue;
  readonly timestamp: TimestampParseResult;
  readonly sealBytes: Uint8Array;
} {
  const signedValueBytes = entryOf(file, 'Doc_0/Signs/Sign_0/SignedValue.dat');
  const sealBytes = entryOf(file, 'Doc_0/Signs/Sign_0/Seal.esl');
  const signedValue = parseSignedValue(signedValueBytes);
  return {
    signedValue,
    timestamp: parseTimestamp(timestampTokenOf(signedValueBytes), {
      signatureValue: signatureValueOf(signedValueBytes),
    }),
    sealBytes,
  };
}


/**
 * 构造 v1 SignedValue + Signature.xml + Signatures.xml + OFD.xml 的独立明文容器。
 *
 * 结构与 GM/T 0031-2014 v1 一致；只用于验证解析字段，不依赖 t7 的 builders。
 */
export async function buildV1Container(): Promise<VirtualContainer> {
  const signerCert = fixtureBytes('certs/signer.crt.der');
  const sealCert = fixtureBytes('certs/seal.crt.der');
  const signerKey = parseSm2PrivateKey({ pem: fixtureText('certs/signer.key.pem') }).privateKey;
  const sealKey = parseSm2PrivateKey({ pem: fixtureText('certs/seal.key.pem') }).privateKey;

  const ofdXml = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0" DocType="OFD">' +
      '<ofd:DocBody><ofd:DocInfo><ofd:DocID>t13-v1</ofd:DocID></ofd:DocInfo>' +
      '<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>' +
      '<ofd:Signatures>Doc_0/Signs/Signatures.xml</ofd:Signatures>' +
      '</ofd:DocBody></ofd:OFD>',
  );
  const documentXml = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"/>',
  );

  // v1 SESeal：SES_SealInfo + SES_SignInfo。
  const sealCertOctets = derOctetString(sealCert);
  const sealAlg = derOid(OID_SM3_WITH_SM2);
  const sealInfo = derSequence(
    derSequence(derUtf8String('ES'), derInteger(1n), derUtf8String('1.0')),
    derUtf8String('t13-v1-es'),
    derSequence(
      derInteger(1n),
      derUtf8String('t13 合成 v1 印章'),
      derSequence(sealCertOctets),
      derGeneralizedTime(new Date('2026-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2025-01-01T00:00:00Z')),
      derGeneralizedTime(new Date('2040-01-01T00:00:00Z')),
    ),
    derSequence(
      derUtf8String('PNG'),
      derOctetString(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      derInteger(40n),
      derInteger(40n),
    ),
  );
  const seal = derSequence(
    sealInfo,
    derSequence(
      sealCertOctets,
      sealAlg,
      derBitString(sm2Sign(derSequence(sealInfo, sealCertOctets, sealAlg), sealKey)),
    ),
  );

  const signatureXml = (dataHashBase64: string): Uint8Array =>
    new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<ofd:Signature xmlns:ofd="http://www.ofdspec.org/2016">' +
        '<ofd:SignedValue>/Doc_0/Signs/Sign_0/SignedValue.dat</ofd:SignedValue>' +
        '<ofd:SignedInfo>' +
        '<ofd:Provider ProviderName="t13" Company="test" Version="1"/>' +
        `<ofd:SignatureMethod>${OID_SM3_WITH_SM2}</ofd:SignatureMethod>` +
        '<ofd:SignatureDateTime>2026-10-23 10:00:00</ofd:SignatureDateTime>' +
        '<ofd:Seal><ofd:BaseLoc>/Doc_0/Signs/Sign_0/Seal.esl</ofd:BaseLoc></ofd:Seal>' +
        '<ofd:References CheckMethod="SM3">' +
        `<ofd:Reference FileRef="/OFD.xml"><ofd:CheckValue>${hex(sm3Digest(ofdXml))}</ofd:CheckValue></ofd:Reference>` +
        `<ofd:Reference FileRef="/Doc_0/Document.xml"><ofd:CheckValue>${dataHashBase64}</ofd:CheckValue></ofd:Reference>` +
        '</ofd:References>' +
        '</ofd:SignedInfo></ofd:Signature>',
    );

  const signatureBytes = signatureXml(Buffer.from(sm3Digest(documentXml)).toString('base64'));
  const tbs = derSequence(
    derInteger(1n),
    seal,
    derOctetString(new TextEncoder().encode('2026-10-23 10:00:00')),
    derOctetString(sm3Digest(signatureBytes)),
    derUtf8String('/Doc_0/Signs/Sign_0/Signature.xml'),
    derOctetString(signerCert),
    derOid(OID_SM3_WITH_SM2),
  );
  const signedValue = derSequence(tbs, derBitString(sm2Sign(tbs, signerKey)));
  const signaturesXml = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ofd:Signatures xmlns:ofd="http://www.ofdspec.org/2016">' +
      '<ofd:Signature ID="s001" Type="Seal" BaseLoc="/Doc_0/Signs/Sign_0/Signature.xml"/>' +
      '<ofd:MaxSignId>s001</ofd:MaxSignId></ofd:Signatures>',
  );

  const entries = new Map<string, Uint8Array>([
    ['OFD.xml', ofdXml],
    ['Doc_0/Document.xml', documentXml],
    ['Doc_0/Signs/Signatures.xml', signaturesXml],
    ['Doc_0/Signs/Sign_0/Signature.xml', signatureBytes],
    ['Doc_0/Signs/Sign_0/SignedValue.dat', signedValue],
    ['Doc_0/Signs/Sign_0/Seal.esl', seal],
  ]);
  return memoryContainer(entries);
}

/** 构造带 nonce 的最小时间戳令牌（只用于验证解析字段）。 */
export function buildTimestampWithNonce(): Uint8Array {
  const imprint = new Uint8Array(32).fill(0x5a);
  const tstInfo = derSequence(
    derInteger(1n),
    derOid('1.2.156.10197.1.501.1'),
    derSequence(derSequence(derOid(OID_SM3)), derOctetString(imprint)),
    derInteger(0x0102030405n),
    derGeneralizedTime(new Date('2026-10-23T03:00:00Z')),
    derInteger(0xabcdefn),
  );
  const signedData = derSequence(
    derInteger(1n),
    derSequence(derSequence(derOid(OID_SM3))),
    derSequence(derOid('1.2.840.113549.1.9.16.1.4'), derContext(0, derOctetString(tstInfo))),
    derSequence(),
  );
  return derSequence(derOid('1.2.840.113549.1.7.2'), derContext(0, signedData));
}

/** 小写十六进制。 */
export function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
