/**
 * 签章测试夹具。
 *
 * v4/v5 使用 `references/ofdrw/ofdrw-gm/src/test/resources` 中的真实
 * SignedValue.dat；v1 用真实 v4 证书重建（仓库内没有 v1 SignedValue 样本），
 * 并额外提供缺证书、坏证书、时间戳、未知版本等变体。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as asn1js from 'asn1js';

/** 仓库根：vitest 可能从仓库根或包目录启动。 */
const REPO_ROOT = existsSync(resolve(process.cwd(), 'references'))
  ? process.cwd()
  : resolve(process.cwd(), '../..');
const RESOURCE_DIR = resolve(
  REPO_ROOT,
  'references/ofdrw/ofdrw-gm/src/test/resources',
);

/** v1 构造选项。 */
export interface V1Options {
  /** TBS_Sign.version；默认 1。 */
  readonly version?: number;
  /** 印章名称。 */
  readonly sealName?: string;
  /** 印章类型。 */
  readonly sealType?: number;
  /** 签章时间 ASCII 文本；默认 `2020-01-25T08:07:31Z`。 */
  readonly timeText?: string;
  /** 为 true 时把 timeInfo 写成不可读的时间戳令牌。 */
  readonly timestampToken?: boolean;
}

/** 读取真实 SignedValue 夹具。 */
export function readSignedValueFixture(name: 'SignedValueV4.dat' | 'SignedValueV5.dat'): Uint8Array {
  return new Uint8Array(readFileSync(resolve(RESOURCE_DIR, name)));
}

/** 读取 v4 夹具中真实的签章者证书 DER。 */
export function readV4Certificate(): Uint8Array {
  const children = outerChildren(readSignedValueFixture('SignedValueV4.dat'));
  const cert = children[1] as { valueBlock?: { valueHexView?: Uint8Array } };
  const view = cert.valueBlock?.valueHexView;
  if (!view) throw new Error('v4 夹具缺少签章者证书');
  return Uint8Array.from(view);
}

/** 构造 v1 SignedValue（SES_Signature v1）。 */
export function buildV1SignedValue(options: V1Options = {}): Uint8Array {
  const version = options.version ?? 1;
  const certificate = readV4Certificate();
  const certOctet = new asn1js.OctetString({ valueHex: toArrayBuffer(certificate) });
  const sealInfo = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [
          new asn1js.IA5String({ value: 'ES' }),
          new asn1js.Integer({ value: 1 }),
          new asn1js.IA5String({ value: 'TEST' }),
        ],
      }),
      new asn1js.IA5String({ value: 'V1SEALID' }),
      new asn1js.Sequence({
        value: [
          new asn1js.Integer({ value: options.sealType ?? 2 }),
          new asn1js.Utf8String({ value: options.sealName ?? '测试个人印章' }),
          new asn1js.Sequence({ value: [] }),
          new asn1js.UTCTime({ valueDate: new Date('2020-01-01T00:00:00Z') }),
          new asn1js.UTCTime({ valueDate: new Date('2020-01-01T00:00:00Z') }),
          new asn1js.UTCTime({ valueDate: new Date('2022-01-01T00:00:00Z') }),
        ],
      }),
      new asn1js.Sequence({
        value: [
          new asn1js.IA5String({ value: 'PNG' }),
          new asn1js.OctetString({ valueHex: new Uint8Array([1, 2, 3]).buffer }),
          new asn1js.Integer({ value: 20 }),
          new asn1js.Integer({ value: 20 }),
        ],
      }),
    ],
  });
  const signInfo = new asn1js.Sequence({
    value: [
      certOctet,
      new asn1js.ObjectIdentifier({ value: '1.2.156.10197.1.501' }),
      new asn1js.BitString({ valueHex: new Uint8Array([1, 2, 3]).buffer }),
    ],
  });
  const eseal = new asn1js.Sequence({ value: [sealInfo, signInfo] });
  const timeBytes = options.timestampToken
    ? new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    : new TextEncoder().encode(options.timeText ?? '2020-01-25T08:07:31Z');
  const tbs = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: version }),
      eseal,
      new asn1js.BitString({ valueHex: toArrayBuffer(timeBytes) }),
      new asn1js.BitString({ valueHex: new Uint8Array([0xaa, 0xbb, 0xcc]).buffer }),
      new asn1js.IA5String({ value: '/Doc_0/Document.xml' }),
      certOctet,
      new asn1js.ObjectIdentifier({ value: '1.2.156.10197.1.501' }),
    ],
  });
  const outer = new asn1js.Sequence({
    value: [tbs, new asn1js.BitString({ valueHex: new Uint8Array([9, 9, 9]).buffer })],
  });
  return new Uint8Array(outer.toBER());
}

/** 替换 v4 外层第 2 个字段（签章者证书）。 */
export function v4WithCert(cert: Uint8Array): Uint8Array {
  const children = outerChildren(readSignedValueFixture('SignedValueV4.dat'));
  children[1] = new asn1js.OctetString({ valueHex: toArrayBuffer(cert) });
  return encodeSequence(children);
}

/** 缺证书：空 OCTET STRING。 */
export function v4WithoutCert(): Uint8Array {
  return v4WithCert(new Uint8Array());
}

/** 坏证书：非 DER 内容。 */
export function v4WithBadCert(): Uint8Array {
  return v4WithCert(new Uint8Array([0x01, 0x02, 0x03]));
}

/** 在 v4 外层追加 [0] 时间戳字段。 */
export function v4WithTimestamp(): Uint8Array {
  const children = outerChildren(readSignedValueFixture('SignedValueV4.dat'));
  children.push(
    new asn1js.Constructed({
      idBlock: { tagClass: 3, tagNumber: 0 },
      value: [new asn1js.BitString({ valueHex: new Uint8Array([1, 2, 3, 4]).buffer })],
    }),
  );
  return encodeSequence(children);
}

/** 把 v4 的 TBS_Sign.version 改成未知值。 */
export function v4WithUnknownVersion(version = 9): Uint8Array {
  const children = outerChildren(readSignedValueFixture('SignedValueV4.dat'));
  const tbs = children[0] as { valueBlock?: { value?: unknown[] } };
  const tbsChildren = tbs.valueBlock?.value;
  if (!Array.isArray(tbsChildren)) throw new Error('v4 夹具 TBS 结构异常');
  tbsChildren[0] = new asn1js.Integer({ value: version });
  return encodeSequence(children);
}

/** 损坏的 DER。 */
export function corruptSignedValue(): Uint8Array {
  return new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x00]);
}

/** 构造深层嵌套 SEQUENCE，用于深度限制测试。 */
export function deepNestedSequence(depth = 40): Uint8Array {
  let node: asn1js.Sequence = new asn1js.Sequence({ value: [] });
  for (let index = 0; index < depth; index += 1) {
    node = new asn1js.Sequence({ value: [node] });
  }
  return new Uint8Array(node.toBER());
}

/** 读取顶层 SEQUENCE 的子节点。 */
function outerChildren(data: Uint8Array): unknown[] {
  const parsed = asn1js.fromBER(toArrayBuffer(data));
  const root = parsed.result as unknown as { valueBlock?: { value?: unknown[] } };
  const children = root.valueBlock?.value;
  if (!Array.isArray(children)) throw new Error('SignedValue 夹具顶层不是 SEQUENCE');
  return [...children];
}

/** 重新编码顶层 SEQUENCE。 */
function encodeSequence(children: readonly unknown[]): Uint8Array {
  return new Uint8Array(new asn1js.Sequence({ value: children as never }).toBER());
}

/** Uint8Array 转独立 ArrayBuffer。 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}