/**
 * 测试用 X.509 证书构造器（仅测试；私钥来自 fixture test-only 材料）。
 *
 * 用于构造根—中间 CA—签名者链、KeyUsage/pathLen 异常与 DN 编码差异场景。
 */

import {
  OID_SM3_WITH_SM2,
  derBitString,
  derBoolean,
  derContext,
  derInteger,
  derOid,
  derOctetString,
  derSequence,
  derSet,
  derUtcTime,
  derUtf8String,
  encodeDerTlv,
  parseSm2PrivateKey,
  sm2GetPublicKey,
  sm2Sign,
} from '@ofdrw/ofdrw-viewer-crypto';
import { fixtureText } from '../core/fixtures';

/** 证书 KeyUsage 名称（与解析结果一致）。 */
export type KeyUsageName =
  | 'digitalSignature'
  | 'nonRepudiation'
  | 'keyEncipherment'
  | 'dataEncipherment'
  | 'keyAgreement'
  | 'keyCertSign'
  | 'cRLSign';

/** 测试密钥对。 */
export interface TestKeyPair {
  /** 32 byte 私钥标量。 */
  readonly privateKey: Uint8Array;
  /** 65 byte 未压缩公钥。 */
  readonly publicKey: Uint8Array;
}

/** 证书主体/颁发者名称编码。 */
export type NameEncoding = 'utf8' | 'printable';

/** 证书构造选项。 */
export interface CertificateOptions {
  /** 序列号。 */
  readonly serial: bigint;
  /** 主体 CN。 */
  readonly cn: string;
  /** 颁发者 CN；省略表示自签名。 */
  readonly issuerCn?: string;
  /** 主体 DN 编码。 */
  readonly subjectEncoding?: NameEncoding;
  /** 颁发者 DN 编码。 */
  readonly issuerEncoding?: NameEncoding;
  /** 是否 CA。 */
  readonly isCA?: boolean;
  /** pathLenConstraint。 */
  readonly pathLen?: number;
  /** KeyUsage；省略表示不生成扩展。 */
  readonly keyUsage?: readonly KeyUsageName[];
  /** 生效时间。 */
  readonly notBefore?: Date;
  /** 失效时间。 */
  readonly notAfter?: Date;
}

/** 证书生成结果。 */
export interface GeneratedCertificate {
  /** 证书 DER。 */
  readonly der: Uint8Array;
  /** 公钥。 */
  readonly publicKey: Uint8Array;
}

/** 合成证书默认生效时间（与夹具证书一致：2025-01-01）。 */
export const DEFAULT_NOT_BEFORE = new Date('2025-01-01T00:00:00Z');

/** 合成证书默认失效时间（与夹具证书一致：2040-01-01）。 */
export const DEFAULT_NOT_AFTER = new Date('2040-01-01T00:00:00Z');

/**
 * 从 fixture 私钥构造密钥对。
 *
 * @param name 文件名前缀（root-ca/signer/seal/encrypt/tsa）。
 * @returns 密钥对。
 */
export function testKeyPair(name: string): TestKeyPair {
  const privateKey = parseSm2PrivateKey({
    pem: fixtureText('certs', `${name}.key.pem`),
  }).privateKey;
  return { privateKey, publicKey: sm2GetPublicKey(privateKey) };
}

/**
 * 构造 DN（CN/O/C 顺序）。
 *
 * @param cn 通用名。
 * @param encoding 字符串编码。
 * @returns Name DER。
 */
function name(cn: string, encoding: NameEncoding = 'utf8'): Uint8Array {
  const attribute = (oid: string, value: string, asPrintable = false): Uint8Array =>
    derSet(
      derSequence(
        derOid(oid),
        asPrintable
          ? encodeDerTlv({ cls: 0, constructed: false, number: 19 }, new TextEncoder().encode(value))
          : derUtf8String(value),
      ),
    );
  return derSequence(
    attribute('2.5.4.3', cn, encoding === 'printable'),
    attribute('2.5.4.10', 'ofdrw-viewer test'),
    attribute('2.5.4.6', 'CN'),
  );
}

/**
 * 生成 KeyUsage 扩展。
 *
 * @param usage 用途列表。
 * @returns 扩展 DER。
 */
function keyUsageExtension(usage: readonly KeyUsageName[]): Uint8Array {
  const order: readonly KeyUsageName[] = [
    'digitalSignature',
    'nonRepudiation',
    'keyEncipherment',
    'dataEncipherment',
    'keyAgreement',
    'keyCertSign',
    'cRLSign',
  ];
  const indexes = usage.map((item) => order.indexOf(item)).filter((index) => index >= 0);
  const highest = Math.max(...indexes);
  const bytes = new Uint8Array(highest >= 8 ? 2 : 1);
  for (const index of indexes) {
    bytes[Math.floor(index / 8)] |= 0x80 >> index % 8;
  }
  const unused = (highest >= 8 ? 16 : 8) - 1 - highest;
  return derSequence(
    derOid('2.5.29.15'),
    derBoolean(true),
    derOctetString(derBitString(bytes, unused)),
  );
}

/**
 * 构造证书。
 *
 * @param options 证书字段。
 * @param subjectKey 主体密钥对。
 * @param issuerKey 颁发者私钥；自签名时省略。
 * @returns 证书 DER 与公钥。
 */
export function makeCertificate(
  options: CertificateOptions,
  subjectKey: TestKeyPair,
  issuerKey?: TestKeyPair,
): GeneratedCertificate {
  const issuer = issuerKey ?? subjectKey;
  const issuerCn = options.issuerCn ?? options.cn;
  const extensions: Uint8Array[] = [];
  if (options.isCA !== undefined) {
    extensions.push(
      derSequence(
        derOid('2.5.29.19'),
        derBoolean(true),
        derOctetString(
          options.isCA
            ? derSequence(
                derBoolean(true),
                ...(options.pathLen !== undefined ? [derInteger(BigInt(options.pathLen))] : []),
              )
            : derSequence(),
        ),
      ),
    );
  }
  if (options.keyUsage) extensions.push(keyUsageExtension(options.keyUsage));
  const algorithm = derSequence(derOid(OID_SM3_WITH_SM2));
  const spki = derSequence(
    derSequence(derOid('1.2.840.10045.2.1'), derOid('1.2.156.10197.1.301')),
    derBitString(subjectKey.publicKey),
  );
  const tbs = derSequence(
    derContext(0, derInteger(2n)),
    derInteger(options.serial),
    algorithm,
    name(issuerCn, options.issuerEncoding),
    derSequence(
      derUtcTime(options.notBefore ?? DEFAULT_NOT_BEFORE),
      derUtcTime(options.notAfter ?? DEFAULT_NOT_AFTER),
    ),
    name(options.cn, options.subjectEncoding),
    spki,
    ...(extensions.length > 0 ? [derContext(3, derSequence(...extensions))] : []),
  );
  return {
    der: derSequence(tbs, algorithm, derBitString(sm2Sign(tbs, issuer.privateKey))),
    publicKey: subjectKey.publicKey,
  };
}
