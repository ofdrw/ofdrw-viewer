/**
 * 严格 DER 读写工具。
 *
 * 设计目标：
 * - 保留原始 TLV（`node.raw`），签章验签必须对原始字节计算，不能重新序列化；
 * - 严格拒绝 BER 不定长、非最小长度、非最小 tag/OID 编码等非法 DER；
 * - 强制 `maxBytes`/`maxDepth`，防御超大/超深结构；
 * - 浏览器与 Node 22 共用，不依赖 `node:*`。
 */

import { CryptoError } from '../errors';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import { concatBytes, copyBytes } from '../util/bytes';

/** ASN.1 标签类别：0=universal，1=application，2=context-specific，3=private。 */
export type DerClass = 0 | 1 | 2 | 3;

/** ASN.1 标签。 */
export interface DerTag {
  /** 标签类别。 */
  readonly cls: DerClass;
  /** 是否构造类型。 */
  readonly constructed: boolean;
  /** 标签号。 */
  readonly number: number;
}

/** DER 解析选项。 */
export interface DerParseOptions {
  /** 输入字节上限，单位 byte；默认 `maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** 最大嵌套深度，单位层；默认 `maxAsn1Depth`。 */
  readonly maxDepth?: number;
  /** 节点总数上限，单位个；默认按 `maxBytes` 推导（最多 65,536）。 */
  readonly maxNodes?: number;
}

/** 常用 universal 标签号。 */
export const DER_TAG = Object.freeze({
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OBJECT_IDENTIFIER: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x10,
  SET: 0x11,
  PRINTABLE_STRING: 0x13,
  TELETEX_STRING: 0x14,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  BMP_STRING: 0x1e,
});

/** BIT STRING 内容。 */
export interface DerBitString {
  /** 末字节未使用比特数（0..7）。 */
  readonly unusedBits: number;
  /** 去掉 unused-bits 字节后的内容。 */
  readonly bytes: Uint8Array;
}

/** 解析后的 DER 节点。 */
export class DerNode {
  /** 标签。 */
  readonly tag: DerTag;
  /** 完整 TLV（输入字节的视图）。 */
  readonly raw: Uint8Array;
  /** value 部分（输入字节的视图）。 */
  readonly value: Uint8Array;
  /** 子节点；primitive 节点为空数组。 */
  readonly children: readonly DerNode[];
  /** 在输入中的起始偏移，单位 byte。 */
  readonly offset: number;
  /** TLV 头长度，单位 byte。 */
  readonly headerLength: number;
  /** value 长度，单位 byte。 */
  readonly length: number;
  /** 节点深度，根为 0。 */
  readonly depth: number;

  /**
   * 创建节点；仅供本模块解析器使用。
   *
   * @param init 节点字段。
   */
  constructor(init: {
    tag: DerTag;
    raw: Uint8Array;
    value: Uint8Array;
    children: readonly DerNode[];
    offset: number;
    headerLength: number;
    length: number;
    depth: number;
  }) {
    this.tag = init.tag;
    this.raw = init.raw;
    this.value = init.value;
    this.children = init.children;
    this.offset = init.offset;
    this.headerLength = init.headerLength;
    this.length = init.length;
    this.depth = init.depth;
  }

  /**
   * 是否为指定 universal 标签。
   *
   * @param number universal 标签号。
   * @returns 匹配返回 true。
   */
  isUniversal(number: number): boolean {
    return this.tag.cls === 0 && this.tag.number === number;
  }

  /**
   * 是否为指定 context-specific 标签。
   *
   * @param number context 标签号。
   * @returns 匹配返回 true。
   */
  isContext(number: number): boolean {
    return this.tag.cls === 2 && this.tag.number === number;
  }

  /**
   * 查找第一个 universal 子节点。
   *
   * @param number universal 标签号。
   * @returns 子节点或 undefined。
   */
  findUniversal(number: number): DerNode | undefined {
    return this.children.find((child) => child.isUniversal(number));
  }

  /**
   * 查找第一个 context-specific 子节点。
   *
   * @param number context 标签号。
   * @returns 子节点或 undefined。
   */
  findContext(number: number): DerNode | undefined {
    return this.children.find((child) => child.isContext(number));
  }

  /**
   * 要求当前节点为指定 universal 标签。
   *
   * @param number universal 标签号。
   * @param label 结构名，用于错误信息。
   * @returns 当前节点。
   * @throws CryptoError `CRYPTO_ASN1_INVALID`。
   */
  requireUniversal(number: number, label: string): DerNode {
    if (!this.isUniversal(number)) {
      throw asn1Error(`偏移 ${this.offset}：期望 ${label}（universal ${number}）`, this.offset);
    }
    return this;
  }

  /**
   * 要求当前节点为 SEQUENCE。
   *
   * @param label 结构名。
   * @returns 当前节点。
   */
  requireSequence(label = 'SEQUENCE'): DerNode {
    return this.requireUniversal(DER_TAG.SEQUENCE, label);
  }

  /**
   * 读取 BOOLEAN。
   *
   * @returns true/false。
   * @throws CryptoError `CRYPTO_ASN1_INVALID`：标签/长度/编码非法。
   */
  asBoolean(): boolean {
    this.requireUniversal(DER_TAG.BOOLEAN, 'BOOLEAN');
    if (this.value.length !== 1) {
      throw asn1Error(`偏移 ${this.offset}：BOOLEAN 长度必须为 1`, this.offset);
    }
    if (this.value[0] === 0x00) return false;
    if (this.value[0] === 0xff) return true;
    throw asn1Error(`偏移 ${this.offset}：BOOLEAN 必须编码为 0x00/0xff`, this.offset);
  }

  /**
   * 读取 INTEGER 为 BigInt（支持负数补码）。
   *
   * @returns 整数值。
   * @throws CryptoError `CRYPTO_ASN1_INVALID`。
   */
  asInteger(): bigint {
    this.requireUniversal(DER_TAG.INTEGER, 'INTEGER');
    if (this.value.length === 0) {
      throw asn1Error(`偏移 ${this.offset}：INTEGER 不能为空`, this.offset);
    }
    if (this.value.length > 1) {
      if (this.value[0] === 0x00 && (this.value[1] & 0x80) === 0) {
        throw asn1Error(`偏移 ${this.offset}：INTEGER 存在多余前导零`, this.offset);
      }
      if (this.value[0] === 0xff && (this.value[1] & 0x80) !== 0) {
        throw asn1Error(`偏移 ${this.offset}：INTEGER 存在多余前导 0xff`, this.offset);
      }
    }
    let value = 0n;
    for (const byte of this.value) value = (value << 8n) | BigInt(byte);
    if ((this.value[0] & 0x80) !== 0) {
      value -= 1n << BigInt(this.value.length * 8);
    }
    return value;
  }

  /**
   * 读取非负 INTEGER 的大端字节（去前导零，可按需左侧补零）。
   *
   * @param size 目标字节长度（可选）；不足时左侧补零，超出时报错。
   * @returns 大端无符号字节。
   * @throws CryptoError `CRYPTO_ASN1_INVALID`：负数/超长/空值。
   */
  asUnsignedIntegerBytes(size?: number): Uint8Array {
    this.requireUniversal(DER_TAG.INTEGER, 'INTEGER');
    if (this.value.length === 0) {
      throw asn1Error(`偏移 ${this.offset}：INTEGER 不能为空`, this.offset);
    }
    if ((this.value[0] & 0x80) !== 0) {
      throw asn1Error(`偏移 ${this.offset}：期望非负 INTEGER`, this.offset);
    }
    if (this.value.length > 1 && this.value[0] === 0x00 && (this.value[1] & 0x80) === 0) {
      throw asn1Error(`偏移 ${this.offset}：INTEGER 存在多余前导零`, this.offset);
    }
    let start = 0;
    while (start < this.value.length - 1 && this.value[start] === 0x00) start += 1;
    const body = this.value.subarray(start);
    if (size === undefined) return copyBytes(body);
    if (body.length > size) {
      throw asn1Error(`偏移 ${this.offset}：INTEGER 超过 ${size} byte`, this.offset);
    }
    if (body.length === size) return copyBytes(body);
    const out = new Uint8Array(size);
    out.set(body, size - body.length);
    return out;
  }

  /**
   * 读取 OCTET STRING 内容。
   *
   * @returns 内容字节（输入视图）。
   */
  asOctets(): Uint8Array {
    this.requireUniversal(DER_TAG.OCTET_STRING, 'OCTET STRING');
    return this.value;
  }

  /**
   * 读取 BIT STRING。
   *
   * @returns unused bits 与内容字节。
   * @throws CryptoError `CRYPTO_ASN1_INVALID`：长度/未使用比特非法。
   */
  asBitString(): DerBitString {
    this.requireUniversal(DER_TAG.BIT_STRING, 'BIT STRING');
    if (this.value.length === 0) {
      throw asn1Error(`偏移 ${this.offset}：BIT STRING 缺少 unused-bits 字节`, this.offset);
    }
    const unusedBits = this.value[0];
    if (unusedBits > 7) {
      throw asn1Error(`偏移 ${this.offset}：BIT STRING unused-bits 非法`, this.offset);
    }
    if (this.value.length === 1 && unusedBits !== 0) {
      throw asn1Error(`偏移 ${this.offset}：空 BIT STRING 的 unused-bits 必须为 0`, this.offset);
    }
    if (unusedBits > 0) {
      const last = this.value[this.value.length - 1];
      if ((last & ((1 << unusedBits) - 1)) !== 0) {
        throw asn1Error(`偏移 ${this.offset}：BIT STRING 未使用比特非零`, this.offset);
      }
    }
    return { unusedBits, bytes: this.value.subarray(1) };
  }

  /**
   * 读取 BIT STRING 并要求 unused-bits 为 0（签名/公钥场景）。
   *
   * @returns 内容字节。
   */
  asBitStringOctets(): Uint8Array {
    const bits = this.asBitString();
    if (bits.unusedBits !== 0) {
      throw asn1Error(`偏移 ${this.offset}：BIT STRING 必须按字节对齐`, this.offset);
    }
    return bits.bytes;
  }

  /**
   * 读取 OBJECT IDENTIFIER。
   *
   * @returns 点分 OID。
   */
  asOid(): string {
    this.requireUniversal(DER_TAG.OBJECT_IDENTIFIER, 'OBJECT IDENTIFIER');
    return decodeOid(this.value, this.offset);
  }

  /**
   * 读取可见字符串（UTF8String/PrintableString/IA5String/TeletexString/BMPString）。
   *
   * @returns 文本。
   */
  asString(): string {
    if (this.tag.cls !== 0) {
      throw asn1Error(`偏移 ${this.offset}：期望字符串类型`, this.offset);
    }
    switch (this.tag.number) {
      case DER_TAG.UTF8_STRING:
        return new TextDecoder('utf-8').decode(this.value);
      case DER_TAG.PRINTABLE_STRING:
      case DER_TAG.IA5_STRING:
      case DER_TAG.TELETEX_STRING:
        return latin1(this.value);
      case DER_TAG.BMP_STRING:
        return utf16be(this.value);
      default:
        throw asn1Error(`偏移 ${this.offset}：不支持的字符串标签 ${this.tag.number}`, this.offset);
    }
  }

  /**
   * 读取 UTCTime/GeneralizedTime。
   *
   * @returns UTC 时间。
   */
  asTime(): Date {
    const text = latin1(this.value);
    if (this.isUniversal(DER_TAG.UTC_TIME)) return parseUtcTime(text, this.offset);
    if (this.isUniversal(DER_TAG.GENERALIZED_TIME)) {
      return parseGeneralizedTime(text, this.offset);
    }
    throw asn1Error(`偏移 ${this.offset}：期望时间类型`, this.offset);
  }
}

/**
 * 解析单个 DER TLV，要求输入恰好被一个结构消费完。
 *
 * @param bytes 输入字节。
 * @param options 大小/深度上限。
 * @returns 根节点。
 * @throws CryptoError `CRYPTO_ASN1_INVALID` / `CRYPTO_LIMIT_EXCEEDED`。
 */
export function parseDer(bytes: Uint8Array, options?: DerParseOptions): DerNode {
  const resolved = resolveOptions(bytes, options);
  const budget: NodeBudget = { remaining: resolved.maxNodes };
  const parsed = readNode(bytes, 0, bytes.length, 0, resolved, budget);
  if (parsed.next !== bytes.length) {
    throw asn1Error(`偏移 ${parsed.next}：存在未解析的尾随字节`, parsed.next);
  }
  return parsed.node;
}

/**
 * 连续解析多个 DER TLV（例如拼接的多张 DER 证书）。
 *
 * @param bytes 输入字节。
 * @param options 大小/深度上限。
 * @returns 节点数组。
 */
export function parseDerAll(bytes: Uint8Array, options?: DerParseOptions): readonly DerNode[] {
  const resolved = resolveOptions(bytes, options);
  const budget: NodeBudget = { remaining: resolved.maxNodes };
  const nodes: DerNode[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const parsed = readNode(bytes, offset, bytes.length, 0, resolved, budget);
    nodes.push(parsed.node);
    offset = parsed.next;
  }
  return nodes;
}

/**
/** 解析后生效的 DER 上限。 */
interface ResolvedDerOptions {
  /** 输入字节上限，单位 byte。 */
  readonly maxBytes: number;
  /** 最大嵌套深度，单位层。 */
  readonly maxDepth: number;
  /** 节点总数上限，单位个。 */
  readonly maxNodes: number;
}

/** 单次解析共享的节点预算。 */
interface NodeBudget {
  /** 剩余可用节点数。 */
  remaining: number;
}

/**
 * 解析选项并校验输入大小。
 *
 * @param bytes 输入字节。
 * @param options 调用方选项。
 * @returns 生效上限。
 */
function resolveOptions(
  bytes: Uint8Array,
  options?: DerParseOptions,
): ResolvedDerOptions {
  if (!(bytes instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'DER 输入必须是 Uint8Array');
  }
  if (bytes.length === 0) {
    throw asn1Error('ASN.1 输入为空', 0);
  }
  const maxBytes = options?.maxBytes ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes;
  const maxDepth = options?.maxDepth ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Depth;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxBytes 必须是正整数');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxDepth 必须是正整数');
  }
  if (bytes.length > maxBytes) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `ASN.1 输入大小 ${bytes.length} byte 超过上限 ${maxBytes} byte`,
    );
  }
  const maxNodes =
    options?.maxNodes !== undefined
      ? options.maxNodes
      : Math.min(65_536, Math.max(1_024, Math.floor(maxBytes / 8)));
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxNodes 必须是正整数');
  }
  return { maxBytes, maxDepth, maxNodes };
}

/**
 * 读取一个 TLV 节点。
 *
 * @param bytes 输入。
 * @param offset 起始偏移。
 * @param limit 结束边界。
 * @param depth 当前深度。
 * @param options 解析上限。
 * @param budget 共享节点预算。
 * @returns 节点与下一个偏移。
 */
function readNode(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  depth: number,
  options: ResolvedDerOptions,
  budget: NodeBudget,
): { readonly node: DerNode; readonly next: number } {
  if (depth > options.maxDepth) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `ASN.1 嵌套深度超过上限 ${options.maxDepth}`,
    );
  }
  if (budget.remaining <= 0) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `ASN.1 节点数超过上限 ${options.maxNodes}`,
    );
  }
  budget.remaining -= 1;
  const start = offset;
  if (offset >= limit) throw asn1Error('缺少 ASN.1 标签', start);
  const first = bytes[offset];
  offset += 1;
  const cls = (first >> 6) as DerClass;
  const constructed = (first & 0x20) !== 0;
  let tagNumber = first & 0x1f;

  if (tagNumber === 0x1f) {
    tagNumber = 0;
    let count = 0;
    for (;;) {
      if (offset >= limit) throw asn1Error('高 tag 编号被截断', start);
      const byte = bytes[offset];
      offset += 1;
      if (count === 0 && byte === 0x80) {
        throw asn1Error('高 tag 编号非最小编码', start);
      }
      tagNumber = (tagNumber << 7) | (byte & 0x7f);
      count += 1;
      if ((byte & 0x80) === 0) break;
      if (count > 4) throw asn1Error('高 tag 编号过长', start);
    }
  }

  if (offset >= limit) throw asn1Error('缺少 ASN.1 长度字段', start);
  const lengthByte = bytes[offset];
  offset += 1;
  let length: number;
  if (lengthByte < 0x80) {
    length = lengthByte;
  } else if (lengthByte === 0x80) {
    throw asn1Error('不支持 BER 不定长编码', start);
  } else {
    const count = lengthByte & 0x7f;
    if (count > 4) throw asn1Error('ASN.1 长度编码过长', start);
    if (offset + count > limit) throw asn1Error('ASN.1 长度字段被截断', start);
    if (bytes[offset] === 0x00) throw asn1Error('ASN.1 长度非最小编码', start);
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + bytes[offset];
      offset += 1;
    }
    if (length < 0x80) throw asn1Error('ASN.1 长度非最小编码', start);
  }

  const valueStart = offset;
  const valueEnd = valueStart + length;
  if (valueEnd > limit) throw asn1Error('ASN.1 长度超出输入范围', start);
  const children: DerNode[] = [];
  if (constructed) {
    let childOffset = valueStart;
    while (childOffset < valueEnd) {
      const child = readNode(bytes, childOffset, valueEnd, depth + 1, options, budget);
      children.push(child.node);
      childOffset = child.next;
    }
    if (childOffset !== valueEnd) {
      throw asn1Error(`偏移 ${childOffset}：构造类型子节点未填满长度`, childOffset);
    }
  }

  const node = new DerNode({
    tag: { cls, constructed, number: tagNumber },
    raw: bytes.subarray(start, valueEnd),
    value: bytes.subarray(valueStart, valueEnd),
    children,
    offset: start,
    headerLength: valueStart - start,
    length,
    depth,
  });
  return { node, next: valueEnd };
}

/**
 * 构造 ASN.1 解析错误。
 *
 * @param message 信息。
 * @param offset 输入偏移，单位 byte。
 * @returns CryptoError。
 */
function asn1Error(message: string, offset: number): CryptoError {
  return new CryptoError('CRYPTO_ASN1_INVALID', `ASN.1 解析失败（偏移 ${offset}）：${message}`);
}

/**
 * 解码 OID value。
 *
 * @param value OID value 字节。
 * @param offset 输入偏移（错误信息用）。
 * @returns 点分 OID。
 */
export function decodeOid(value: Uint8Array, offset = 0): string {
  if (value.length === 0) throw asn1Error('OID 不能为空', offset);
  const subIdentifiers: bigint[] = [];
  let accumulator = 0n;
  let inSubIdentifier = false;
  for (const byte of value) {
    if (!inSubIdentifier && byte === 0x80) {
      throw asn1Error('OID 子标识符非最小编码', offset);
    }
    accumulator = (accumulator << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      subIdentifiers.push(accumulator);
      accumulator = 0n;
      inSubIdentifier = false;
    } else {
      inSubIdentifier = true;
    }
  }
  if (inSubIdentifier) throw asn1Error('OID 子标识符被截断', offset);
  const first = subIdentifiers[0];
  const firstArc = first < 40n ? 0n : first < 80n ? 1n : 2n;
  return [firstArc, first - firstArc * 40n, ...subIdentifiers.slice(1)]
    .map((arc) => arc.toString(10))
    .join('.');
}

/**
 * 编码 OID。
 *
 * @param oid 点分 OID。
 * @returns OID value 字节（不含 tag/length）。
 */
function encodeOidValue(oid: string): Uint8Array {
  if (!/^\d+(?:\.\d+)+$/.test(oid)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `OID 格式非法：${oid}`);
  }
  const arcs = oid.split('.').map((part) => BigInt(part));
  if (arcs[0] > 2n) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `OID 首段非法：${oid}`);
  }
  if (arcs[0] < 2n && arcs[1] >= 40n) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', `OID 第二段非法：${oid}`);
  }
  const out: number[] = [];
  const pushSubIdentifier = (value: bigint): void => {
    const stack: number[] = [Number(value & 0x7fn)];
    let rest = value >> 7n;
    while (rest > 0n) {
      stack.unshift(Number((rest & 0x7fn) | 0x80n));
      rest >>= 7n;
    }
    out.push(...stack);
  };
  pushSubIdentifier(arcs[0] * 40n + arcs[1]);
  for (let i = 2; i < arcs.length; i += 1) pushSubIdentifier(arcs[i]);
  return Uint8Array.from(out);
}

/**
 * 编码 DER 长度。
 *
 * @param length 内容长度，单位 byte。
 * @returns 长度字段。
 */
export function encodeDerLength(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'DER 长度必须是非负整数');
  }
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/**
 * 编码任意 TLV。
 *
 * @param tag 标签类别/构造位/标签号。
 * @param value 内容字节。
 * @returns TLV 字节。
 */
export function encodeDerTlv(tag: DerTag, value: Uint8Array): Uint8Array {
  const first = (tag.cls << 6) | (tag.constructed ? 0x20 : 0);
  let identifier: Uint8Array;
  if (tag.number < 0x1f) {
    identifier = Uint8Array.of(first | tag.number);
  } else {
    const parts: number[] = [];
    let rest = tag.number;
    parts.unshift(rest & 0x7f);
    rest = Math.floor(rest / 128);
    while (rest > 0) {
      parts.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    identifier = Uint8Array.of(first | 0x1f, ...parts);
  }
  return concatBytes(identifier, encodeDerLength(value.length), value);
}

/**
 * 编码 SEQUENCE。
 *
 * @param items 已编码的子元素。
 * @returns TLV 字节。
 */
export function derSequence(...items: readonly Uint8Array[]): Uint8Array {
  return encodeDerTlv(
    { cls: 0, constructed: true, number: DER_TAG.SEQUENCE },
    concatBytes(...items),
  );
}

/**
 * 编码 DER SET（按编码字节排序，满足 DER 规范）。
 *
 * @param items 已编码的子元素。
 * @returns TLV 字节。
 */
export function derSet(...items: readonly Uint8Array[]): Uint8Array {
  const sorted = [...items].sort((a, b) => compareBytes(a, b));
  return encodeDerTlv(
    { cls: 0, constructed: true, number: DER_TAG.SET },
    concatBytes(...sorted),
  );
}

/**
 * 编码非负 INTEGER。
 *
 * @param value 非负 BigInt，或已按大端排列的无符号字节。
 * @returns TLV 字节。
 */
export function derInteger(value: bigint | Uint8Array): Uint8Array {
  let body: Uint8Array;
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'derInteger 只支持非负整数');
    }
    if (value === 0n) {
      body = Uint8Array.of(0);
    } else {
      const bytes: number[] = [];
      let rest = value;
      while (rest > 0n) {
        bytes.unshift(Number(rest & 0xffn));
        rest >>= 8n;
      }
      if ((bytes[0] & 0x80) !== 0) bytes.unshift(0);
      body = Uint8Array.from(bytes);
    }
  } else {
    let start = 0;
    while (start < value.length && value[start] === 0x00) start += 1;
    const magnitude = value.subarray(start);
    if (magnitude.length === 0) {
      body = Uint8Array.of(0);
    } else if ((magnitude[0] & 0x80) !== 0) {
      body = concatBytes(Uint8Array.of(0), magnitude);
    } else {
      body = magnitude;
    }
  }
  return encodeDerTlv({ cls: 0, constructed: false, number: DER_TAG.INTEGER }, body);
}

/**
 * 编码 OCTET STRING。
 *
 * @param value 内容字节。
 * @returns TLV 字节。
 */
export function derOctetString(value: Uint8Array): Uint8Array {
  return encodeDerTlv({ cls: 0, constructed: false, number: DER_TAG.OCTET_STRING }, value);
}

/**
 * 编码 BIT STRING。
 *
 * @param value 内容字节。
 * @param unusedBits 末字节未使用比特数（0..7）。
 * @returns TLV 字节。
 */
export function derBitString(value: Uint8Array, unusedBits = 0): Uint8Array {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'BIT STRING unusedBits 必须是 0..7');
  }
  if (value.length === 0 && unusedBits !== 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', '空 BIT STRING 的 unusedBits 必须为 0');
  }
  return encodeDerTlv(
    { cls: 0, constructed: false, number: DER_TAG.BIT_STRING },
    concatBytes(Uint8Array.of(unusedBits), value),
  );
}

/**
 * 编码 OBJECT IDENTIFIER。
 *
 * @param oid 点分 OID。
 * @returns TLV 字节。
 */
export function derOid(oid: string): Uint8Array {
  return encodeDerTlv(
    { cls: 0, constructed: false, number: DER_TAG.OBJECT_IDENTIFIER },
    encodeOidValue(oid),
  );
}

/**
 * 编码 NULL。
 *
 * @returns TLV 字节。
 */
export function derNull(): Uint8Array {
  return Uint8Array.of(0x05, 0x00);
}

/**
 * 编码 BOOLEAN。
 *
 * @param value 布尔值。
 * @returns TLV 字节。
 */
export function derBoolean(value: boolean): Uint8Array {
  return Uint8Array.of(0x01, 0x01, value ? 0xff : 0x00);
}

/**
 * 编码 UTF8String。
 *
 * @param text 文本。
 * @returns TLV 字节。
 */
export function derUtf8String(text: string): Uint8Array {
  return encodeDerTlv(
    { cls: 0, constructed: false, number: DER_TAG.UTF8_STRING },
    new TextEncoder().encode(text),
  );
}

/**
 * 编码 context-specific 标签。
 *
 * @param number 标签号。
 * @param value 内容字节。
 * @param constructed 是否构造类型；默认 true（EXPLICIT）。
 * @returns TLV 字节。
 */
export function derContext(number: number, value: Uint8Array, constructed = true): Uint8Array {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'context 标签号必须是非负整数');
  }
  return encodeDerTlv({ cls: 2, constructed, number }, value);
}

/**
 * 编码 UTC 时间（YYMMDDHHMMSSZ）。
 *
 * @param date 时间；必须在 1950..2049。
 * @returns TLV 字节。
 */
export function derUtcTime(date: Date): Uint8Array {
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'UTCTime 年份必须在 1950..2049');
  }
  const text = `${pad2(year % 100)}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(
    date.getUTCHours(),
  )}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
  return encodeDerTlv(
    { cls: 0, constructed: false, number: DER_TAG.UTC_TIME },
    new TextEncoder().encode(text),
  );
}

/**
 * 编码 GeneralizedTime（YYYYMMDDHHMMSSZ）。
 *
 * @param date 时间。
 * @returns TLV 字节。
 */
export function derGeneralizedTime(date: Date): Uint8Array {
  const text = `${pad4(date.getUTCFullYear())}${pad2(date.getUTCMonth() + 1)}${pad2(
    date.getUTCDate(),
  )}${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
  return encodeDerTlv(
    { cls: 0, constructed: false, number: DER_TAG.GENERALIZED_TIME },
    new TextEncoder().encode(text),
  );
}

/**
 * 两位十进制补零。
 *
 * @param value 0..99。
 * @returns 两位字符串。
 */
function pad2(value: number): string {
  return value.toString(10).padStart(2, '0');
}

/**
 * 四位十进制补零。
 *
 * @param value 0..9999。
 * @returns 四位字符串。
 */
function pad4(value: number): string {
  return value.toString(10).padStart(4, '0');
}

/**
 * 字典序比较两个字节数组（DER SET 排序用）。
 *
 * @param a 字节数组 A。
 * @param b 字节数组 B。
 * @returns 负数/0/正数。
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * 按 Latin-1 解码字节（PrintableString/IA5String/TeletexString）。
 *
 * @param bytes 字节。
 * @returns 文本。
 */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/**
 * 解码 UTF-16BE（BMPString）。
 *
 * @param bytes 字节。
 * @returns 文本。
 */
function utf16be(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) {
    throw new CryptoError('CRYPTO_ASN1_INVALID', 'BMPString 长度必须为偶数');
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return out;
}

/** UTCTime 正则。 */
const UTC_TIME_PATTERN = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})$/;
/** GeneralizedTime 正则（小数秒可选）。 */
const GENERALIZED_TIME_PATTERN =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{4})$/;

/**
 * 解析 UTCTime。
 *
 * @param text 时间文本。
 * @param offset 输入偏移。
 * @returns UTC 时间。
 */
function parseUtcTime(text: string, offset: number): Date {
  const match = UTC_TIME_PATTERN.exec(text);
  if (!match) throw asn1Error(`UTCTime 格式非法：${text}`, offset);
  const yy = Number(match[1]);
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  return buildDate(
    year,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? '0'),
    0,
    match[7],
    offset,
  );
}

/**
 * 解析 GeneralizedTime。
 *
 * @param text 时间文本。
 * @param offset 输入偏移。
 * @returns UTC 时间。
 */
function parseGeneralizedTime(text: string, offset: number): Date {
  const match = GENERALIZED_TIME_PATTERN.exec(text);
  if (!match) throw asn1Error(`GeneralizedTime 格式非法：${text}`, offset);
  const fraction = match[7] ? Number(`0.${match[7]}`) : 0;
  return buildDate(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Math.round(fraction * 1000),
    match[8],
    offset,
  );
}

/**
 * 按 UTC 分量构造时间并校验时区偏移。
 *
 * @param year 年。
 * @param month 月（1..12）。
 * @param day 日。
 * @param hour 时。
 * @param minute 分。
 * @param second 秒。
 * @param millisecond 毫秒。
 * @param zone 时区（Z 或 ±hhmm）。
 * @param offset 输入偏移。
 * @returns UTC 时间。
 */
function buildDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  zone: string,
  offset: number,
): Date {
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millisecond));
  date.setUTCFullYear(year);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw asn1Error('时间字段超出合法范围', offset);
  }
  let zoneMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMins = Number(zone.slice(3, 5));
    if (zoneHours > 23 || zoneMins > 59) throw asn1Error('时区偏移非法', offset);
    zoneMinutes = sign * (zoneHours * 60 + zoneMins);
  }
  return new Date(date.getTime() - zoneMinutes * 60_000);
}