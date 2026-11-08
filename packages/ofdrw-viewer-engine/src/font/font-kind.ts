/**
 * 字体类型推断。
 *
 * 在进入 fontkit 之前先判定字体的实际封装类型，产出显式枚举；
 * 每类格式由 `adapters/` 下对应适配器负责转换为 fontkit 可解析的形式。
 */

/** 字体封装类型。 */
export type FontKind =
  /** 标准 sfnt（TrueType `\0\1\0\0` / CFF `OTTO` / Apple `true`）。 */
  | 'sfnt'
  /** 字体集合（ttcf）。 */
  | 'ttcf'
  /** WOFF 压缩封装。 */
  | 'woff'
  /** WOFF2 压缩封装。 */
  | 'woff2'
  /** 无 sfnt 包装的裸 CFF。 */
  | 'bare-cff'
  /** 无法识别的类型。 */
  | 'unknown';

/** CFF header 的固定长度。 */
const CFF_HEADER_SIZE = 4;

/** CFF minor version（CFF1 恒为 0）。 */
const CFF_MINOR_VERSION = 0;

/**
 * 判断字节前缀是否等于给定 4 字符标签。
 *
 * @param bytes 字体字节。
 * @param tag 4 字符标签。
 * @returns 匹配时返回 true。
 */
function startsWithTag(bytes: Uint8Array, tag: string): boolean {
  if (bytes.length < 4) return false;
  for (let index = 0; index < 4; index += 1) {
    if (bytes[index] !== tag.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * 按 CFF INDEX 结构读取条目数。
 *
 * @param bytes 字节数组。
 * @param offset INDEX 起点。
 * @returns INDEX 条目数；结构非法时返回 -1。
 */
function readIndexCount(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) return -1;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/**
 * 判断一个 CFF INDEX 结构是否自洽。
 *
 * 校验项：条目数为正、offSize 在 1..4、偏移表完整、偏移单调递增、首偏移为 1、末尾不越界。
 *
 * @param bytes 字节数组。
 * @param offset INDEX 起点。
 * @returns 自洽的 INDEX 结束位置；不自洽返回 -1。
 */
function measureIndex(bytes: Uint8Array, offset: number): number {
  const count = readIndexCount(bytes, offset);
  if (count <= 0) return -1;
  if (offset + 3 > bytes.length) return -1;
  const offSize = bytes[offset + 2];
  if (offSize < 1 || offSize > 4) return -1;
  const tableStart = offset + 3;
  const tableLength = offSize * (count + 1);
  if (tableStart + tableLength > bytes.length) return -1;
  let previous = -1;
  let first = -1;
  let last = -1;
  for (let index = 0; index <= count; index += 1) {
    const at = tableStart + index * offSize;
    let value = 0;
    for (let byte = 0; byte < offSize; byte += 1) value = value * 256 + bytes[at + byte];
    if (index === 0) {
      first = value;
    } else if (value < previous) {
      return -1;
    }
    previous = value;
    last = value;
  }
  if (first !== 1) return -1;
  const base = tableStart + tableLength - 1;
  const end = base + last;
  return end <= bytes.length ? end : -1;
}

/**
 * 结构化判定字节是否为裸 CFF。
 *
 * 裸 CFF 没有 magic 值，仅凭首字节可能误判（损坏的 sfnt 也可能以 `01 00 04 0x` 开头），
 * 因此这里逐项校验 header 与紧随其后的 Name INDEX、TopDICT INDEX 是否自洽。
 *
 * @param bytes 字体字节。
 * @returns 是裸 CFF 时返回 true。
 */
export function detectBareCff(bytes: Uint8Array): boolean {
  if (bytes.length < CFF_HEADER_SIZE + 2) return false;
  // header：major=1、minor=0、hdrSize=4、offSize 在 1..4
  if (bytes[0] !== 1 || bytes[1] !== CFF_MINOR_VERSION) return false;
  if (bytes[2] !== CFF_HEADER_SIZE) return false;
  const offSize = bytes[3];
  if (offSize < 1 || offSize > 4) return false;

  const nameEnd = measureIndex(bytes, CFF_HEADER_SIZE);
  if (nameEnd < 0) return false;
  // CFF 规范要求 Name INDEX 恰有一个字体名。
  if (readIndexCount(bytes, CFF_HEADER_SIZE) !== 1) return false;

  const topEnd = measureIndex(bytes, nameEnd);
  if (topEnd < 0) return false;
  // CFF1 的 TopDICT INDEX 恰有一个条目。
  if (readIndexCount(bytes, nameEnd) !== 1) return false;
  // TopDICT 之后必须还有数据（至少 String INDEX / CharStrings）。
  return topEnd < bytes.length;
}

/**
 * 判定字体封装类型。
 *
 * 判定顺序为：TT 集合 → WOFF2 → WOFF → sfnt → 裸 CFF → 未知。
 *
 * @param bytes 字体字节。
 * @returns 字体类型。
 */
export function detectFontKind(bytes: Uint8Array): FontKind {
  if (startsWithTag(bytes, 'ttcf')) return 'ttcf';
  if (startsWithTag(bytes, 'wOF2')) return 'woff2';
  if (startsWithTag(bytes, 'wOFF')) return 'woff';
  if (
    startsWithTag(bytes, 'OTTO') ||
    startsWithTag(bytes, 'true') ||
    startsWithTag(bytes, '\u0000\u0001\u0000\u0000')
  ) {
    return 'sfnt';
  }
  if (detectBareCff(bytes)) return 'bare-cff';
  return 'unknown';
}
