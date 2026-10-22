/**
 * 最小 ASN.1 DER 读取器。
 *
 * 只覆盖签章 `Seal.esl` 所需的 SEQUENCE/OCTET STRING/IA5String/INTEGER，
 * 不依赖任何第三方库，也不做证书链或签名值验证。
 */

/** DER 节点；构造类型保留子节点，原始类型保留值字节。 */
export interface DerNode {
  /** 标签字节（低 5 位为 tag number，0x20 位表示 constructed）。 */
  tag: number;
  /** 是否为构造类型。 */
  constructed: boolean;
  /** 原始节点的值字节；构造类型为空。 */
  value: Uint8Array;
  /** 子节点；仅构造类型非空。 */
  children: DerNode[];
}

/** DER 解析失败。 */
export class DerParseError extends Error {
  /**
   * @param message 失败原因。
   */
  constructor(message: string) {
    super(message);
    this.name = 'DerParseError';
  }
}

const MAX_DER_DEPTH = 32;
const MAX_DER_NODES = 100_000;

/**
 * 解析一段 DER 数据。
 *
 * @param data DER 字节。
 * @param maxDepth 最大嵌套深度，缺省 32。
 * @returns 顶层节点数组；尾部剩余字节会作为额外节点继续解析。
 * @throws DerParseError 长度/标签/边界非法或超过深度/节点限制。
 */
export function parseDer(data: Uint8Array, maxDepth: number = MAX_DER_DEPTH): DerNode[] {
  const state: ParseState = { data, nodes: 0, maxDepth };
  const nodes: DerNode[] = [];
  let offset = 0;
  while (offset < data.length) {
    const parsed = readNode(state, offset, data.length, 0);
    nodes.push(parsed.node);
    offset = parsed.next;
  }
  return nodes;
}

/** 解析过程中的共享状态。 */
interface ParseState {
  data: Uint8Array;
  nodes: number;
  maxDepth: number;
}

/** 读取一个节点后的游标与节点。 */
interface ParsedNode {
  node: DerNode;
  next: number;
}

/**
 * 读取单个 DER 节点。
 *
 * @param state 解析状态。
 * @param offset 节点起始偏移。
 * @param end 当前容器结束偏移（不含）。
 * @param depth 当前嵌套深度。
 * @returns 节点与下一个偏移。
 */
function readNode(state: ParseState, offset: number, end: number, depth: number): ParsedNode {
  if (depth > state.maxDepth) {
    throw new DerParseError(`DER 嵌套超过 ${state.maxDepth} 层`);
  }
  if (++state.nodes > MAX_DER_NODES) {
    throw new DerParseError(`DER 节点数超过 ${MAX_DER_NODES}`);
  }
  const data = state.data;
  if (offset >= end) throw new DerParseError('DER 节点缺少标签');
  const tag = data[offset] as number;
  if ((tag & 0x1f) === 0x1f) {
    throw new DerParseError('不支持高位标签号');
  }
  offset += 1;
  const lengthInfo = readLength(data, offset, end);
  offset = lengthInfo.next;
  const contentEnd = offset + lengthInfo.length;
  if (contentEnd > end) {
    throw new DerParseError(`DER 长度越界：需要 ${lengthInfo.length} 字节，剩余 ${end - offset}`);
  }
  const constructed = (tag & 0x20) !== 0;
  if (!constructed) {
    return {
      node: { tag, constructed: false, value: data.subarray(offset, contentEnd), children: [] },
      next: contentEnd,
    };
  }
  const children: DerNode[] = [];
  let cursor = offset;
  while (cursor < contentEnd) {
    const parsed = readNode(state, cursor, contentEnd, depth + 1);
    children.push(parsed.node);
    cursor = parsed.next;
  }
  return {
    node: { tag, constructed: true, value: new Uint8Array(0), children },
    next: contentEnd,
  };
}

/** 读取 DER 长度；支持短格式与 1–4 字节长格式。 */
function readLength(data: Uint8Array, offset: number, end: number): { length: number; next: number } {
  if (offset >= end) throw new DerParseError('DER 节点缺少长度');
  const first = data[offset] as number;
  if (first < 0x80) return { length: first, next: offset + 1 };
  if (first === 0x80) throw new DerParseError('不支持 DER 不定长');
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new DerParseError(`DER 长度字节数非法：${count}`);
  if (offset + 1 + count > end) throw new DerParseError('DER 长度字段越界');
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length = length * 256 + (data[offset + 1 + index] as number);
  }
  if (length > 0x7fffffff) throw new DerParseError(`DER 长度过大：${length}`);
  return { length, next: offset + 1 + count };
}

/**
 * 读取 IA5String 文本。
 *
 * @param node DER 节点。
 * @returns ASCII 文本；节点类型不符时返回 undefined。
 */
export function derString(node: DerNode | undefined): string | undefined {
  if (!node || node.tag !== 0x16) return undefined;
  let result = '';
  for (const byte of node.value) result += String.fromCharCode(byte);
  return result;
}

/**
 * 读取小整数；签章尺寸为毫米整数。
 *
 * @param node DER 节点。
 * @returns 整数；节点不是 INTEGER 或超出安全整数范围时返回 undefined。
 */
export function derInteger(node: DerNode | undefined): number | undefined {
  if (!node || node.tag !== 0x02 || node.value.length === 0) return undefined;
  const bytes = node.value;
  // 负整数在签章尺寸中无意义，按非法处理。
  if (((bytes[0] as number) & 0x80) !== 0) return undefined;
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return value;
}