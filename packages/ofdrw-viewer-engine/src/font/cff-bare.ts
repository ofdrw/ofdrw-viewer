/**
 * 裸 CFF 内嵌字体适配器。
 *
 * OFD 中常见一类内嵌字体：扩展名为 `.otf`，内容却是**没有 sfnt 包装的裸 CFF**，
 * 且通常还省略了 CFF 规范要求的空 String INDEX 与 GlobalSubr INDEX。
 * fontkit 只按 `OTTO`/`true`/`\0\1\0\0` 探测格式，这类字节会被直接拒收为
 * `Unknown font format`，导致整页文字退化为替代字体。
 *
 * 本模块负责把裸 CFF 重排为 fontkit 可解析的标准形式：
 * 1. 补 sfnt（`OTTO`）表目录，只包含字体解析所必需的表；
 * 2. 重建 CFF 表为 `HDR | Name INDEX | TopDICT INDEX | String INDEX | GlobalSubr INDEX |
 *    charset | Encoding | CharStrings | [FDSelect] | Private | [Subrs] | FDArray`；
 * 3. 重写 TopDICT / FontDict 内所有"相对 CFF 起点"的偏移。
 *
 * 字体度量（`head`/`maxp`/`hhea`/`hmtx`）由 CFF 的 FontMatrix / CharStrings 推出，
 * 不依赖 missing 的 sfnt 表；`name`/`cmap`/`OS/2`/`post` 不合成，缺失时由调用方兜底。
 */

/** sfnt 表目录项。 */
interface SfntTable {
  /** 4 字节表标签。 */
  tag: string;
  /** 表字节。 */
  data: Uint8Array;
}

/** TopDICT / FontDict 中"相对 CFF 起点"的偏移型操作符 → 参数下标。 */
const OFFSET_OPERATORS: ReadonlyMap<number, number> = new Map([
  [15, 0], // charset
  [16, 0], // Encoding
  [17, 0], // CharStrings
  [18, 1], // Private = [size, offset]
  [1236, 0], // FDArray
  [1237, 0], // FDSelect
]);

/** Private DICT 中 Subrs 偏移的操作符。 */
const SUBRS_OPERATOR = 19;

/**
 * fontkit FontDict 支持的操作符集合。
 *
 * fontkit 的 CFFFontDict 字段表只定义了 Private(18)、FontName(1238)、FontMatrix(1207)、
 * PaintType(1205)，其余操作符（如 CharstringType 1206、StrokeWidth 1208）会触发
 * `Unknown operator` 而中断整份 CFF 解码。这些被剔除的字段都是可省略的排版提示。
 */
/**
 * fontkit CFFTopDict 支持的操作符集合。
 *
 * 与 fontkit 的 TopDICT 字段表一致；保留绘制与偏移所需的全部操作符，
 * 排除 fontkit 未定义、会导致整份 CFF 解码中断的保留操作符。
 */
const FONTKIT_TOP_DICT_OPERATORS: ReadonlySet<number> = new Set([
  0, 1, 2, 3, 4, 5, 13, 14, 15, 16, 17, 18,
  1200, 1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208,
  1220, 1221, 1222, 1223, 1230, 1231, 1232, 1233, 1234, 1235, 1236, 1237, 1238,
]);

/** fontkit FontDict 支持的操作符集合。 */
const FONTKIT_FONT_DICT_OPERATORS: ReadonlySet<number> = new Set([18, 1205, 1207, 1238]);

/**
 * fontkit Private DICT 支持的操作符集合。
 *
 * fontkit 的私有字典字段表缺少规范保留操作符 `[12,15]`/`[12,16]` 等，
 * 遇到即抛 `Unknown operator` 中断整份 CFF 解码；这些字段只是渲染提示，
 * 剔除后不影响字形轮廓。
 */
const FONTKIT_PRIVATE_DICT_OPERATORS: ReadonlySet<number> = new Set([
  6, 7, 8, 9, 10, 11, 19, 20, 21, 22, 23,
  1209, 1210, 1211, 1212, 1213, 1214, 1217, 1218, 1219,
]);

/** 预定义 charset 标识（0=ISOAdobe，1=Expert，2=ExpertSubset）。 */
const PREDEFINED_CHARSET_MAX = 2;

/** 预定义 Encoding 标识（0=Standard，1=Expert）。 */
const PREDEFINED_ENCODING_MAX = 1;

/** 基准字号：CFF FontMatrix 为 0.001 时对应 1000 单位 em。 */
const DEFAULT_UNITS_PER_EM = 1000;

/** Subrs 条目数相对字形数的合理倍数上限；超过则视为偏移误判。 */
const SUBRS_PER_GLYPH_RATIO = 64;

/** Subrs 条目数的最小宽容值，保证小字体（如单字形子集）也能容纳常规子程序库。 */
const MIN_SUBRS_ALLOWANCE = 256;


/** 解析后的 CFF INDEX。 */
interface CffIndex {
  /** INDEX 携带的字节块（已切出，不含偏移表）。 */
  items: Uint8Array[];
  /** INDEX 结束位置（下一个结构的起始偏移）。 */
  end: number;
}

/** CFF DICT 中一个操作符及其参数。 */
interface DictOperator {
  /** 操作符编码；双字节操作符为 `1200 + 次字节`。 */
  op: number;
  /** 数值操作数。 */
  args: number[];
  /** 每个操作数的原始字节，用于原样回写非偏移参数。 */
  raw: Uint8Array[];
}

/** 单个 FontDict（CID）的重排信息。 */
interface FontDictPlan {
  /** FontDict 的操作符。 */
  operators: DictOperator[];
  /** Private DICT 字节。 */
  privateBytes: Uint8Array | null;
  /** Subrs INDEX 字节。 */
  subrsBytes: Uint8Array | null;
}

/** 裸 CFF 解析结果。 */
interface BareCff {
  /** CFF header 的 hdrSize。 */
  headerSize: number;
  /** Name INDEX 的条目。 */
  nameItems: Uint8Array[];
  /** TopDICT 的操作符。 */
  topOperators: DictOperator[];
  /** String INDEX 的条目。 */
  stringItems: Uint8Array[];
  /** GlobalSubr INDEX 的条目。 */
  globalSubrItems: Uint8Array[];
  /** CharStrings INDEX 的条目数，即字形数（含 .notdef）。 */
  numGlyphs: number;
  /** CharStrings INDEX 的条目。 */
  charStrings: Uint8Array[];
  /** charset 字节；使用预定义 charset 时为 null。 */
  charsetBytes: Uint8Array | null;
  /** Encoding 字节；使用预定义 Encoding 时为 null。 */
  encodingBytes: Uint8Array | null;
  /** TopDICT 级 Private DICT 字节（非 CID 字体）。 */
  privateBytes: Uint8Array | null;
  /** TopDICT 级 Subrs INDEX 字节。 */
  subrsBytes: Uint8Array | null;
  /** CID 的 FontDict 列表。 */
  fontDicts: FontDictPlan[];
  /** CID 的 FDArray 字节；非 CID 为 null。 */
  fdArrayBytes: Uint8Array | null;
  /** CID 的 FDSelect 字节。 */
  fdSelectBytes: Uint8Array | null;
  /** 从 FontMatrix 推出的每 em 单位数。 */
  unitsPerEm: number;
  /** 字体包围盒（FontBBox），缺失时为 null。 */
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 首字形（.notdef）的 advanceWidth。 */
  advanceWidth: number;
}

/**
 * 读取一个 CFF INDEX 结构。
 *
 * @param bytes 字节数组。
 * @param offset 相对字节数组起点的偏移。
 * @returns INDEX 条目与其结束位置。
 * @throws 偏移越界或偏移表非法时抛错。
 */
function readIndex(bytes: Uint8Array, offset: number): CffIndex {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error('CFF INDEX 越界');
  const count = (bytes[offset] << 8) | bytes[offset + 1];
  if (count === 0) return { items: [], end: offset + 2 };
  const offSize = bytes[offset + 2];
  if (offSize < 1 || offSize > 4) throw new Error('CFF INDEX offsetSize 非法');
  const tableStart = offset + 3;
  if (tableStart + offSize * (count + 1) > bytes.length) throw new Error('CFF INDEX 偏移表越界');
  const offsets: number[] = [];
  let cursor = tableStart;
  for (let index = 0; index <= count; index += 1) {
    let value = 0;
    for (let byte = 0; byte < offSize; byte += 1) value = value * 256 + bytes[cursor + byte];
    offsets.push(value);
    cursor += offSize;
  }
  if (offsets[0] < 1) throw new Error('CFF INDEX 首偏移非法');
  const base = cursor - 1;
  const items: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offsets[index + 1] < offsets[index]) throw new Error('CFF INDEX 偏移递减');
    items.push(bytes.slice(base + offsets[index], base + offsets[index + 1]));
  }
  const end = base + offsets[count];
  if (end > bytes.length) throw new Error('CFF INDEX 长度越界');
  return { items, end };
}

/**
 * 编码一个 CFF INDEX 结构。
 *
 * @param items 条目字节。
 * @returns INDEX 字节。
 */
function encodeIndex(items: readonly Uint8Array[]): Uint8Array {
  const count = items.length;
  if (count === 0) return Uint8Array.of(0, 0);
  let total = 1;
  for (const item of items) total += item.length;
  const offSize = total <= 0xff ? 1 : total <= 0xffff ? 2 : total <= 0xffffff ? 3 : 4;
  const out = new Uint8Array(2 + 1 + offSize * (count + 1) + (total - 1));
  out[0] = (count >> 8) & 0xff;
  out[1] = count & 0xff;
  out[2] = offSize;
  let cursor = 3;
  let offset = 1;
  const writeOffset = (value: number): void => {
    for (let byte = offSize - 1; byte >= 0; byte -= 1) {
      out[cursor] = (value >>> (byte * 8)) & 0xff;
      cursor += 1;
    }
  };
  writeOffset(offset);
  for (const item of items) {
    offset += item.length;
    writeOffset(offset);
  }
  for (const item of items) {
    out.set(item, cursor);
    cursor += item.length;
  }
  return out;
}

/**
 * 解码 CFF DICT。
 *
 * @param bytes DICT 字节。
 * @returns 按出现顺序排列的操作符。
 * @throws 遇到非法字典字节或未终止实数时抛错。
 */
function parseDict(bytes: Uint8Array): DictOperator[] {
  const operators: DictOperator[] = [];
  let args: number[] = [];
  let raw: Uint8Array[] = [];
  let index = 0;
  while (index < bytes.length) {
    const start = index;
    const byte = bytes[index];
    if (byte <= 21) {
      const op = byte === 12 ? 1200 + bytes[index + 1] : byte;
      index += byte === 12 ? 2 : 1;
      operators.push({ op, args, raw });
      args = [];
      raw = [];
      continue;
    }
    if (byte === 28) {
      if (index + 3 > bytes.length) throw new Error('CFF DICT 越界');
      const value = (((bytes[index + 1] << 8) | bytes[index + 2]) << 16) >> 16;
      index += 3;
      args.push(value);
    } else if (byte === 29) {
      if (index + 5 > bytes.length) throw new Error('CFF DICT 越界');
      const value = (bytes[index + 1] << 24) | (bytes[index + 2] << 16) | (bytes[index + 3] << 8) | bytes[index + 4];
      index += 5;
      args.push(value);
    } else if (byte === 30) {
      index += 1;
      let digits = '';
      let terminated = false;
      while (index < bytes.length) {
        const current = bytes[index];
        index += 1;
        const high = current >> 4;
        const low = current & 0x0f;
        if (high === 0x0f) {
          terminated = true;
          break;
        }
        digits += high <= 9 ? String(high) : high === 0x0a ? '.' : high === 0x0b ? 'E' : high === 0x0c ? 'E-' : '-';
        // 低半字节为 0xf 表示实数结束，其后半字节不再参与数值。
        if (low === 0x0f) {
          terminated = true;
          break;
        }
        digits += low <= 9 ? String(low) : low === 0x0a ? '.' : low === 0x0b ? 'E' : low === 0x0c ? 'E-' : '-';
      }
      if (!terminated) throw new Error('CFF DICT 实数未终止');
      // 空实数（立即终止）按 0 处理；否则 Number('') 会得到 0，但 '-' 或 '.' 之类的残缺值需显式归零。
      const value = digits.length === 0 ? 0 : Number(digits);
      args.push(Number.isFinite(value) ? value : 0);
    } else if (byte >= 32 && byte <= 246) {
      index += 1;
      args.push(byte - 139);
    } else if (byte >= 247 && byte <= 250) {
      if (index + 2 > bytes.length) throw new Error('CFF DICT 越界');
      index += 2;
      args.push((byte - 247) * 256 + bytes[index - 1] + 108);
    } else if (byte >= 251 && byte <= 254) {
      if (index + 2 > bytes.length) throw new Error('CFF DICT 越界');
      index += 2;
      args.push(-(byte - 251) * 256 - bytes[index - 1] - 108);
    } else {
      throw new Error('CFF DICT 非法字节');
    }
    raw.push(bytes.slice(start, index));
  }
  return operators;
}

/**
 * 按 DICT 规范编码一个数值（整数或实数）。
 *
 * @param value 数值。
 * @returns DICT 编码字节。
 */
function encodeNumber(value: number): number[] {
  if (!Number.isFinite(value)) return [139]; // 0
  if (Number.isInteger(value)) {
    const v = value;
    if (v >= -107 && v <= 107) return [v + 139];
    if (v >= 108 && v <= 1131) {
      const n = v - 108;
      return [(n >> 8) + 247, n & 0xff];
    }
    if (v >= -1131 && v <= -108) {
      const n = -v - 108;
      return [(n >> 8) + 251, n & 0xff];
    }
    if (v >= -32768 && v <= 32767) return [28, (v >> 8) & 0xff, v & 0xff];
    return encodeInt32(v);
  }
  // 实数：拆成若干位整数 + 小数点 nibble，按规范以 0x1e 开头、0xf 结尾。
  const text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const nibbles: number[] = [];
  let negative = false;
  for (const char of text) {
    if (char === '-') {
      negative = true;
      continue;
    }
    if (char === '.') {
      if (negative) {
        nibbles.unshift(0xe);
        negative = false;
      }
      nibbles.push(0xa);
      continue;
    }
    nibbles.push(char.charCodeAt(0) - 48);
  }
  if (negative) nibbles.unshift(0xe);
  nibbles.push(0xf);
  if (nibbles.length % 2 === 1) nibbles.push(0xf);
  const out = [30];
  for (let i = 0; i < nibbles.length; i += 2) out.push((nibbles[i] << 4) | nibbles[i + 1]);
  return out;
}

/**
 * 以固定 5 字节编码一个 32 位整数，便于两遍计算偏移时不改变字典长度。
 *
 * @param value 非负整数。
 * @returns DICT 编码字节。
 */
function encodeInt32(value: number): number[] {
  return [29, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * 重写一组 DICT 操作符，把偏移型操作数的值替换为布局后的新偏移。
 *
 * 不在 `allowed` 内的操作符会被丢弃：fontkit 的 DICT 解码器遇到未定义操作符会直接抛错
 * （`Unknown operator`），而 fontkit 的 FontDict 字段表只覆盖 CFF 规范的一个子集。
 * 被丢弃的都是可省略的排版提示（如 CharstringType 默认 2、StrokeWidth 默认 0），
 * 不影响字形轮廓解析。
 *
 * @param operators 原操作符。
 * @param resolve 按操作符解析新偏移；返回 null 表示删除该操作符。
 * @param allowed 保留的操作符集合；省略时全部保留。
 * @returns 新的 DICT 字节。
 */
function rewriteDict(
  operators: readonly DictOperator[],
  resolve: (op: number) => number | null,
  allowed?: ReadonlySet<number>,
  resolveSize?: (op: number) => number | null,
): Uint8Array {
  const out: number[] = [];
  for (const operator of operators) {
    if (allowed && !allowed.has(operator.op)) continue;
    const slot = OFFSET_OPERATORS.get(operator.op);
    // 先完整收集参数，确认整条操作符保留后再写入，
    // 避免中途放弃时残留孤立操作数（会被解码器当成未知操作符）。
    let skip = false;
    const operands: number[] = [];
    for (let index = 0; index < operator.args.length; index += 1) {
      if (slot !== undefined && index === slot) {
        const value = resolve(operator.op);
        if (value === null) {
          skip = true;
          break;
        }
        operands.push(...encodeInt32(value));
      } else if (index === 0 && resolveSize) {
        // Private 的 size 会因剔除不支持的操作符而变化，必须回填实际长度。
        const size = resolveSize(operator.op);
        if (size === null) {
          skip = true;
          break;
        }
        operands.push(...encodeInt32(size));
      } else {
        // 非偏移操作数按原始字节原样复制：实数只作为字节序列参与布局，
        // 不做 decode→encode 往返，避免精度或 nibble 解释差异改变字体语义。
        const raw = operator.raw[index];
        // 空实数（30 0f）在部分解码器中会得到 NaN，规范化为整数 0；
        // 其余字节（含正常实数）原样复制，不做数值往返。
        const isEmptyReal = raw && raw.length === 2 && raw[0] === 30 && raw[1] === 0x0f;
        if (isEmptyReal) operands.push(139);
        else if (raw && raw.length > 0) operands.push(...raw);
        else operands.push(...encodeNumber(operator.args[index]));
      }
    }
    if (skip) continue;
    out.push(...operands);
    if (operator.op >= 1200) out.push(12, operator.op - 1200);
    else out.push(operator.op);
  }
  return Uint8Array.from(out);
}

/**
 * 从 FontMatrix 推出每 em 单位数。
 *
 * @param operators TopDICT 操作符。
 * @returns 每 em 单位数（字体单位）；无法推导时返回 1000。
 */
function resolveUnitsPerEm(operators: readonly DictOperator[]): number {
  const matrix = operators.find((operator) => operator.op === 1207);
  const scale = matrix?.args[0];
  if (typeof scale === 'number' && scale > 0 && Number.isFinite(scale)) {
    const units = Math.round(1 / scale);
    if (units > 0 && units <= 16384) return units;
  }
  return DEFAULT_UNITS_PER_EM;
}

/**
 * 从 TopDICT 读取 FontBBox。
 *
 * @param operators TopDICT 操作符。
 * @returns 包围盒；缺失或非法时返回 null。
 */
function resolveBBox(
  operators: readonly DictOperator[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const operator = operators.find((item) => item.op === 5);
  if (!operator || operator.args.length < 4) return null;
  const [minX, minY, maxX, maxY] = operator.args;
  if (![minX, minY, maxX, maxY].every((value) => Number.isFinite(value))) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 读取 Private DICT 及其 Subrs。
 *
 * @param bytes 字体字节。
 * @param size Private DICT 字节数。
 * @param offset Private DICT 起点。
 * @param glyphCount 该 Private 服务范围的字形数。
 * @returns Private/Subrs 字节；偏移越界或结构异常时返回 null。
 */
function readPrivate(
  bytes: Uint8Array,
  size: number,
  offset: number,
  glyphCount: number,
): { privateBytes: Uint8Array | null; subrsBytes: Uint8Array | null } {
  if (offset < 0 || size <= 0 || offset + size > bytes.length) {
    return { privateBytes: null, subrsBytes: null };
  }
  const source = bytes.slice(offset, offset + size);
  const operators = parseDict(source);
  const subrs = operators.find((operator) => operator.op === SUBRS_OPERATOR);

  // Subrs 是供字形 charstring 复用的子程序表，条目数不会远超服务范围的字形数；
  // 超出说明该偏移指向的并非真正的 INDEX（部分私有封装会在其后再接整份字体数据）。
  let subrsBytes: Uint8Array | null = null;
  if (subrs && subrs.args.length === 1) {
    const subrsStart = offset + subrs.args[0];
    if (subrsStart >= 0 && subrsStart < bytes.length) {
      try {
        const index = readIndex(bytes, subrsStart);
        const limit = Math.max(MIN_SUBRS_ALLOWANCE, glyphCount * SUBRS_PER_GLYPH_RATIO);
        if (index.items.length > 0 && index.items.length <= limit && index.end <= bytes.length) {
          subrsBytes = bytes.slice(subrsStart, index.end);
        }
      } catch {
        // 偏移不指向合法 INDEX，按无 Subrs 处理。
      }
    }
  }

  // 剔除 fontkit 不认识的操作符；Subrs 偏移在本模块统一重排，稍后由布局阶段回填。
  const privateBytes = rewriteDict(
    operators.filter((operator) => operator.op !== SUBRS_OPERATOR),
    () => null,
    FONTKIT_PRIVATE_DICT_OPERATORS,
  );
  return { privateBytes, subrsBytes };
}

/**
 * 计算 FDSelect 结构的字节长度。
 *
 * @param bytes 字体字节。
 * @param offset FDSelect 起点。
 * @returns 结束位置；结构非法时返回 null。
 */
function measureFdSelect(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset >= bytes.length) return null;
  const format = bytes[offset];
  if (format === 0) {
    // format(1) + fdArrayIndex[numGlyphs]；字形数由 CharStrings 决定，这里只保证不越界。
    const charStringsGlyphs = bytes.length - offset - 1;
    return Math.min(offset + 1 + charStringsGlyphs, bytes.length);
  }
  if (format === 3) {
    if (offset + 3 > bytes.length) return null;
    const nRanges = (bytes[offset + 1] << 8) | bytes[offset + 2];
    // format(1) + nRanges(2) + nRanges*(first 2 + fd 1) + sentinel(2)
    const end = offset + 3 + nRanges * 3 + 2;
    return end <= bytes.length ? end : null;
  }
  if (format === 4) {
    if (offset + 5 > bytes.length) return null;
    const nRanges = (bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4];
    const end = offset + 5 + nRanges * 6 + 4;
    return end <= bytes.length ? end : null;
  }
  return null;
}

/**
 * 解析裸 CFF 的完整结构。
 *
 * @param bytes 裸 CFF 字节。
 * @returns 解析结果。
 * @throws 结构不符合裸 CFF 布局时抛错。
 */
function parseBareCff(bytes: Uint8Array): BareCff {
  if (bytes.length < 4) throw new Error('CFF 过短');
  // CFF 规范：major=1、minor=0、hdrSize(headerSize) 必须为 4、offSize 在 1..4。
  // 裸 CFF 没有 magic 值，因此必须逐条校验结构，避免把损坏的 sfnt 误判为裸 CFF。
  if (bytes[0] !== 1 || bytes[1] !== 0) throw new Error('CFF 版本非法');
  const headerSize = bytes[2];
  if (headerSize !== 4) throw new Error('CFF headerSize 非 4');
  const headerOffSize = bytes[3];
  if (headerOffSize < 1 || headerOffSize > 4) throw new Error('CFF offSize 非法');

  const nameIndex = readIndex(bytes, headerSize);
  if (nameIndex.items.length !== 1) throw new Error('CFF Name INDEX 数量非 1');
  // PostScript 字体名：ASCII 可打印字符（0x21..0x7e），长度 1..127。
  const nameBytes = nameIndex.items[0];
  if (nameBytes.length === 0 || nameBytes.length > 127) throw new Error('CFF 字体名长度非法');
  for (const byte of nameBytes) {
    if (byte < 0x21 || byte > 0x7e) throw new Error('CFF 字体名非 ASCII');
  }

  const topIndex = readIndex(bytes, nameIndex.end);
  if (topIndex.items.length !== 1) throw new Error('CFF TopDICT 数量非 1');
  const topOperators = parseDict(topIndex.items[0]);
  const findTop = (op: number): DictOperator | undefined =>
    topOperators.find((operator) => operator.op === op);

  const charStringsOp = findTop(17);
  if (!charStringsOp || charStringsOp.args.length !== 1) throw new Error('CFF 缺少 CharStrings');
  const charStringsStart = charStringsOp.args[0];
  if (charStringsStart <= topIndex.end || charStringsStart >= bytes.length) {
    throw new Error('CFF CharStrings 偏移越界');
  }

  // 标准 CFF 在 TopDICT 之后依次是 String INDEX 与 GlobalSubr INDEX。
  // 裸 CFF 可能省略二者；只有完整落在 CharStrings 之前时才采信。
  let cursor = topIndex.end;
  let stringIndex: CffIndex = { items: [], end: cursor };
  let globalSubrIndex: CffIndex = { items: [], end: cursor };
  try {
    const candidate = readIndex(bytes, cursor);
    if (candidate.end <= charStringsStart) {
      stringIndex = candidate;
      const subrCandidate = readIndex(bytes, candidate.end);
      if (subrCandidate.end <= charStringsStart) globalSubrIndex = subrCandidate;
    }
  } catch {
    // 省略了可选的 String/GlobalSubr INDEX，保持空索引。
  }

  const charStrings = readIndex(bytes, charStringsStart);
  if (charStrings.items.length === 0) throw new Error('CFF CharStrings 为空');
  if (charStrings.items.length > 0xffff) throw new Error('CFF 字形数超出上限');

  const charsetOp = findTop(15);
  const encodingOp = findTop(16);
  const fdArrayOp = findTop(1236);
  const fdSelectOp = findTop(1237);
  // charset/Encoding 的预定义值（<= 阈值）不占字节，其后的数据块才是实际内容。
  const charsetAt = charsetOp && charsetOp.args[0] > PREDEFINED_CHARSET_MAX ? charsetOp.args[0] : 0;
  const encodingAt =
    encodingOp && encodingOp.args[0] > PREDEFINED_ENCODING_MAX ? encodingOp.args[0] : 0;
  const fdSelectAt = fdSelectOp ? fdSelectOp.args[0] : 0;
  const fdArrayAt = fdArrayOp ? fdArrayOp.args[0] : 0;

  // 数据块偏移必须落在文件内，且不得落在 CharStrings INDEX 之后（CharStrings 是最后一个结构之一）。
  const requireBlockOffset = (value: number, label: string): void => {
    if (value <= topIndex.end || value >= bytes.length) {
      throw new Error(`CFF ${label} 偏移越界`);
    }
  };
  if (charsetAt > 0) requireBlockOffset(charsetAt, 'charset');
  if (encodingAt > 0) requireBlockOffset(encodingAt, 'Encoding');
  if (fdSelectAt > 0) requireBlockOffset(fdSelectAt, 'FDSelect');
  if (fdArrayAt > 0) requireBlockOffset(fdArrayAt, 'FDArray');
  // 非可选的 charset 必须位于 CharStrings 之前；CharStrings 之后的数据不可再被解释为 charset。
  if (charsetAt > 0 && charsetAt >= charStringsStart) throw new Error('CFF charset 与 CharStrings 重叠');

  /**
   * 计算数据块的结束位置：取所有位于其后的已知块起点中最小者。
   *
   * @param start 块起点。
   * @returns 块结束位置。
   */
  const blockEnd = (start: number): number => {
    const candidates = [charStringsStart, fdSelectAt, fdArrayAt].filter(
      (value) => value > start && value <= bytes.length,
    );
    return candidates.length > 0 ? Math.min(...candidates) : charStringsStart;
  };

  const charsetBytes = charsetAt > 0
    ? bytes.slice(charsetAt, blockEnd(charsetAt))
    : null;
  const encodingBytes = encodingAt > 0
    ? bytes.slice(encodingAt, blockEnd(encodingAt))
    : null;
  // charset 的 format 只能是 0/1/2，且长度必须与字形数匹配（format 0 时 2*(n-1) 字节）。
  if (charsetBytes) {
    const format = charsetBytes[0];
    if (format > 2) throw new Error('CFF charset format 非法');
    if (format === 0 && charsetBytes.length < 2 * (charStrings.items.length - 1)) {
      throw new Error('CFF charset 长度不足');
    }
  }

  const privateOp = findTop(18);
  if (privateOp) {
    const [size, offset] = privateOp.args;
    if (!Number.isInteger(size) || !Number.isInteger(offset) || size <= 0 || offset < 0) {
      throw new Error('CFF Private 参数非法');
    }
    if (offset + size > bytes.length) throw new Error('CFF Private 越界');
  }
  const topPrivate = privateOp
    ? readPrivate(bytes, privateOp.args[0], privateOp.args[1], charStrings.items.length)
    : { privateBytes: null, subrsBytes: null };

  // CID-keyed 字体：ROS 的 Supplement 按 CFF 规范为 0；且 charset 必须是自定义结构
  // （CID 没有预定义 charset，否则 GID→CID 映射无处存放）。
  const rosOp = findTop(1230);
  if (rosOp) {
    // ROS = [Registry SID, Ordering SID, Supplement]。规范只要求三项为整数，
    // Supplement 允许非 0（如 Adobe-GB1 的补充版本号）。
    if (rosOp.args.length !== 3 || !rosOp.args.every((value) => Number.isInteger(value))) {
      throw new Error('CFF ROS 参数非法');
    }
    if (rosOp.args[2] < 0) throw new Error('CFF ROS Supplement 非法');
    if (charsetAt === 0) throw new Error('CID 字体缺少自定义 charset');
  }

  // CID：FontDict 内各带自己的 Private/Subrs，需要逐个重排。
  let fdArrayBytes: Uint8Array | null = null;
  let fdSelectBytes: Uint8Array | null = null;
  const fontDicts: FontDictPlan[] = [];
  if (fdArrayOp) {
    const fdArray = readIndex(bytes, fdArrayAt);
    if (fdArray.items.length === 0) throw new Error('CFF FDArray 为空');
    fdArrayBytes = bytes.slice(fdArrayAt, fdArray.end);
    for (const item of fdArray.items) {
      const operators = parseDict(item);
      const priv = operators.find((operator) => operator.op === 18);
      // CFF 规范要求 CID 字体的每个 FontDict 都带 Private DICT：
      // 缺少它就无法取得 nominalWidthX/defaultWidthX，charstring 宽度无从解释。
      if (!priv) throw new Error('CFF FontDict 缺少 Private');
      if (!Number.isInteger(priv.args[0]) || !Number.isInteger(priv.args[1])) {
        throw new Error('CFF FontDict Private 参数非法');
      }
      if (priv.args[0] <= 0 || priv.args[1] < 0 || priv.args[1] + priv.args[0] > bytes.length) {
        throw new Error('CFF FontDict Private 越界');
      }
      const plan = readPrivate(bytes, priv.args[0], priv.args[1], charStrings.items.length);
      fontDicts.push({ operators, privateBytes: plan.privateBytes, subrsBytes: plan.subrsBytes });
    }
  }
  if (fdSelectAt > 0) {
    // FDSelect 按格式精确计算长度，不依赖相邻块的起点推断（否则会差 1 字节并让后续块整体错位）。
    const end = measureFdSelect(bytes, fdSelectAt);
    if (end !== null) fdSelectBytes = bytes.slice(fdSelectAt, end);
  }

  return {
    headerSize,
    nameItems: nameIndex.items,
    topOperators,
    stringItems: stringIndex.items,
    globalSubrItems: globalSubrIndex.items,
    numGlyphs: charStrings.items.length,
    charStrings: charStrings.items,
    charsetBytes,
    encodingBytes,
    privateBytes: topPrivate.privateBytes,
    subrsBytes: topPrivate.subrsBytes,
    fontDicts,
    fdArrayBytes,
    fdSelectBytes,
    unitsPerEm: resolveUnitsPerEm(topOperators),
    bbox: resolveBBox(topOperators),
    advanceWidth: estimateAdvanceWidth(bytes, charStrings.items[0], charStrings.items.length),
  };
}

/**
 * 估算 .notdef 字形的 advanceWidth。
 *
 * 优先按 Type2 charstring 的 width 计算（首个操作数 + nominalWidthX），
 * 无法确定时回退到 1000（多数 CJK 子集的等宽设定）。
 *
 * @param bytes 字体字节。
 * @param charString .notdef 字形 charstring。
 * @param numGlyphs 字形数。
 * @returns advanceWidth（字体单位）。
 */
function estimateAdvanceWidth(
  bytes: Uint8Array,
  charString: Uint8Array,
  numGlyphs: number,
): number {
  if (numGlyphs === 0) return DEFAULT_UNITS_PER_EM;
  let value = 0;
  let index = 0;
  let leading = 0;
  // Type2 数字编码：只在第一个操作符之前收集数值。
  while (index < charString.length) {
    const byte = charString[index];
    if (byte <= 31 || byte === 255) break;
    if (byte === 28) {
      if (index + 3 > charString.length) break;
      value = (((charString[index + 1] << 8) | charString[index + 2]) << 16) >> 16;
      index += 3;
    } else if (byte >= 32 && byte <= 246) {
      value = byte - 139;
      index += 1;
    } else if (byte >= 247 && byte <= 250) {
      if (index + 2 > charString.length) break;
      value = (byte - 247) * 256 + charString[index + 1] + 108;
      index += 2;
    } else if (byte >= 251 && byte <= 254) {
      if (index + 2 > charString.length) break;
      value = -(byte - 251) * 256 - charString[index + 1] - 108;
      index += 2;
    } else {
      index += 1;
    }
    leading += 1;
  }
  // 首个操作符前恰好一个数值时，它是 width（覆盖 nominalWidthX）。
  if (leading === 1 && value > 0 && value <= 0xffff) return value;
  void bytes;
  return DEFAULT_UNITS_PER_EM;
}

/**
 * 组装 CFF 表：固定前缀 + 数据块，并把所有偏移型操作数指向新位置。
 *
 * @param cff 解析结果。
 * @returns 重建后的 CFF 表字节。
 */
function buildCff(cff: BareCff): Uint8Array {
  const header = Uint8Array.of(1, 0, 4, 3);
  const nameIndex = encodeIndex(cff.nameItems);
  const stringIndex = encodeIndex(cff.stringItems);
  const globalSubrIndex = encodeIndex(cff.globalSubrItems);
  const charStringsIndex = encodeIndex(cff.charStrings);

  const buildTop = (resolve: (op: number) => number | null): Uint8Array =>
    rewriteDict(cff.topOperators, resolve, FONTKIT_TOP_DICT_OPERATORS);
  const buildFontDicts = (resolve: (op: number, index: number) => number | null): Uint8Array =>
    encodeIndex(
      cff.fontDicts.map((dict, dictIndex) =>
        rewriteDict(
          dict.operators,
          (op) => resolve(op, dictIndex),
          FONTKIT_FONT_DICT_OPERATORS,
          // Private 的 size 必须与清理后的实际字节数一致，
          // 否则解码器会越过 Private DICT 读到相邻结构。
          (op) =>
            op === 18 && dict.privateBytes
              ? finalizePrivate(dict.privateBytes, dict.subrsBytes !== null).length
              : null,
        ),
      ),
    );

  /**
   * 构造固定前缀（header/Name/TopDICT/String/GlobalSubr）之后的数据块序列。
   *
   * @param fdArrayData 当前的 FDArray INDEX 字节；null 表示无 FDArray。
   * @returns 按写入顺序排列的 [键名, 字节] 列表。
   */
  const buildBlocks = (fdArrayData: Uint8Array | null): Array<[string, Uint8Array]> => {
    const blocks: Array<[string, Uint8Array]> = [];
    if (cff.charsetBytes) blocks.push(['charset', cff.charsetBytes]);
    if (cff.encodingBytes) blocks.push(['encoding', cff.encodingBytes]);
    blocks.push(['charstrings', charStringsIndex]);
    if (cff.fdSelectBytes) blocks.push(['fdselect', cff.fdSelectBytes]);
    if (cff.privateBytes) {
      blocks.push(['private', finalizePrivate(cff.privateBytes, cff.subrsBytes !== null)]);
      if (cff.subrsBytes) blocks.push(['subrs', cff.subrsBytes]);
    }
    cff.fontDicts.forEach((dict, dictIndex) => {
      if (dict.privateBytes) {
        blocks.push([
          `fdprivate${dictIndex}`,
          finalizePrivate(dict.privateBytes, dict.subrsBytes !== null),
        ]);
        if (dict.subrsBytes) blocks.push([`fdsubrs${dictIndex}`, dict.subrsBytes]);
      }
    });
    if (fdArrayData) blocks.push(['fdarray', fdArrayData]);
    return blocks;
  };

  // 布局定点迭代：TopDICT 与 FontDict 内记录的是相对 CFF 起点的绝对偏移，
  // 而它们的字节长度又取决于这些偏移的编码长度，因此反复求解直到长度稳定。
  let topBytes = buildTop(() => 0x7fffff);
  let fdBytes = buildFontDicts(() => 0x7fffff);
  let positions: Record<string, number> = {};
  let total = 0;
  let converged = false;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const next: Record<string, number> = {};
    let offset = 4;
    next.name = offset;
    offset += nameIndex.length;
    next.top = offset;
    offset += encodeIndex([topBytes]).length;
    next.string = offset;
    offset += stringIndex.length;
    next.gsubr = offset;
    offset += globalSubrIndex.length;
    for (const [key, data] of buildBlocks(cff.fdArrayBytes ? fdBytes : null)) {
      next[key] = offset;
      offset += data.length;
    }
    const nextTotal = offset;

    const nextTop = buildTop((op) => {
      switch (op) {
        case 15:
          return cff.charsetBytes ? next.charset : 0;
        case 16:
          return cff.encodingBytes ? next.encoding : 0;
        case 17:
          return next.charstrings;
        case 18:
          return next.private;
        case 1236:
          return next.fdarray;
        case 1237:
          return next.fdselect;
        default:
          return null;
      }
    });
    const nextFd = cff.fontDicts.length
      ? buildFontDicts((op, dictIndex) => (op === 18 ? next[`fdprivate${dictIndex}`] : null))
      : fdBytes;

    const sameLengths =
      nextTop.length === topBytes.length && nextFd.length === fdBytes.length;
    const samePositions = Object.keys(next).every((key) => positions[key] === next[key]);
    topBytes = nextTop;
    fdBytes = nextFd;
    positions = next;
    total = nextTotal;
    if (sameLengths && samePositions) {
      converged = true;
      break;
    }
  }
  if (!converged) throw new Error('CFF 布局未收敛');

  const parts: Uint8Array[] = [
    header,
    nameIndex,
    encodeIndex([topBytes]),
    stringIndex,
    globalSubrIndex,
    ...buildBlocks(cff.fdArrayBytes ? fdBytes : null).map(([, data]) => data),
  ];

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  if (cursor !== total) throw new Error('CFF 布局长度不一致');
  // 自检：每个数据块的实际写入位置必须与 TopDICT/FontDict 记录的偏移一致，
  // 不一致会让解码器把相邻结构当成另一块读出（如把 FDSelect 当 Private DICT）。
  const written: Record<string, number> = {
    name: 4,
    top: 4 + nameIndex.length,
    string: 4 + nameIndex.length + encodeIndex([topBytes]).length,
    gsubr: 4 + nameIndex.length + encodeIndex([topBytes]).length + stringIndex.length,
  };
  let blockCursor = written.gsubr + globalSubrIndex.length;
  for (const [key, data] of buildBlocks(cff.fdArrayBytes ? fdBytes : null)) {
    written[key] = blockCursor;
    blockCursor += data.length;
  }
  for (const key of Object.keys(written)) {
    if (positions[key] !== undefined && positions[key] !== written[key]) {
      throw new Error(`CFF 布局自检失败：${key} 记录 ${positions[key]} 实际 ${written[key]}`);
    }
  }
  return out;
}

/**
 * 写入 16 位大端整数。
 *
 * @param out 目标字节。
 * @param offset 写入偏移。
 * @param value 数值。
 */
function writeUint16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

/**
 * 写入 32 位大端整数。
 *
 * @param out 目标字节。
 * @param offset 写入偏移。
 * @param value 数值。
 */
function writeUint32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

/**
 * 合成 head 表。
 *
 * @param unitsPerEm 每 em 单位数。
 * @param bbox 字体包围盒。
 * @returns head 表字节（54 字节）。
 */
function buildHead(
  unitsPerEm: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): Uint8Array {
  const out = new Uint8Array(54);
  writeUint32(out, 0, 0x00010000); // version
  writeUint32(out, 4, 0x00010000); // fontRevision
  writeUint32(out, 8, 0); // checkSumAdjustment
  writeUint32(out, 12, 0x5f0f3cf5); // magicNumber
  writeUint16(out, 16, 0); // flags
  writeUint16(out, 18, unitsPerEm);
  // created / modified：LongDateTime（自 1904-01-01 UTC 起的秒数）。
  // 合成字体没有真实时间戳，统一使用 2000-01-01 的固定值（约为 1904 纪元后 30.3 亿秒）。
  const epoch = 3_029_529_600; // 2000-01-01 00:00:00 UTC，单位：秒
  writeUint32(out, 20, epoch);
  writeUint32(out, 24, 0);
  writeUint32(out, 28, epoch);
  writeUint32(out, 32, 0);
  writeUint16(out, 36, bbox.minX & 0xffff);
  writeUint16(out, 38, bbox.minY & 0xffff);
  writeUint16(out, 40, bbox.maxX & 0xffff);
  writeUint16(out, 42, bbox.maxY & 0xffff);
  writeUint16(out, 44, 0); // macStyle
  writeUint16(out, 46, 8); // lowestRecPPEM
  writeUint16(out, 48, 2); // fontDirectionHint
  writeUint16(out, 50, 0); // indexToLocFormat
  writeUint16(out, 52, 0); // glyphDataFormat
  return out;
}

/**
 * 合成 maxp 表。
 *
 * fontkit 的 maxp 是固定结构，会无条件读取 32 字节，因此必须写满。
 *
 * @param numGlyphs 字形数。
 * @returns maxp 表字节（32 字节）。
 */
function buildMaxp(numGlyphs: number): Uint8Array {
  const out = new Uint8Array(32);
  // 使用 1.0 版本：0.5 版只有 numGlyphs 一个字段（6 字节），
  // 而 fontkit 的 maxp 解码器无条件读满 15 个字段（32 字节），两者只能取交集大小。
  writeUint32(out, 0, 0x00010000); // version 1.0
  writeUint16(out, 4, numGlyphs);
  return out;
}

/**
 * 合成 hhea 表。
 *
 * @param ascent 上升高度。
 * @param descent 下降高度。
 * @param numberOfMetrics hmtx 的 advance 条目数。
 * @returns hhea 表字节（36 字节）。
 */
function buildHhea(ascent: number, descent: number, numberOfMetrics: number): Uint8Array {
  const out = new Uint8Array(36);
  writeUint32(out, 0, 0x00010000); // version
  writeUint16(out, 4, ascent & 0xffff);
  writeUint16(out, 6, descent & 0xffff);
  writeUint16(out, 8, 0); // lineGap
  writeUint16(out, 10, 0); // advanceWidthMax
  writeUint16(out, 22, 1); // caretSlopeRise
  writeUint16(out, 34, numberOfMetrics);
  return out;
}

/**
 * 合成 hmtx 表。
 *
 * @param advanceWidths 每个字形的 advanceWidth（字体单位）。
 * @returns hmtx 表字节。
 */
function buildHmtx(advanceWidths: readonly number[]): Uint8Array {
  const out = new Uint8Array(advanceWidths.length * 4);
  advanceWidths.forEach((advance, index) => {
    writeUint16(out, index * 4, Math.max(0, Math.min(0xffff, Math.round(advance))));
    writeUint16(out, index * 4 + 2, 0); // leftSideBearing
  });
  return out;
}

/**
 * 生成最终 Private DICT 字节。
 *
 * Private DICT 后紧跟 Subrs INDEX（若存在），因此 Subrs 偏移等于清理后 Private 字节的长度。
 *
 * @param privateBytes 已清理（不含 Subrs 操作符）的 Private 字节。
 * @param hasSubrs 是否存在 Subrs INDEX。
 * @returns 可直接写入 CFF 的 Private 字节（长度固定，与 hasSubrs 无关）。
 */
function finalizePrivate(privateBytes: Uint8Array, hasSubrs: boolean): Uint8Array {
  if (!hasSubrs) return privateBytes;
  // Subrs 偏移用 5 字节整数编码，长度与取值无关，两遍布局中长度保持稳定。
  const subrsOperand = encodeInt32(privateBytes.length);
  const out = new Uint8Array(privateBytes.length + subrsOperand.length + 1);
  out.set(privateBytes, 0);
  out.set(Uint8Array.from(subrsOperand), privateBytes.length);
  out[out.length - 1] = SUBRS_OPERATOR;
  return out;
}

/**
 * 把若干表包装为 sfnt（`OTTO`）字体。
 *
 * @param tables 表集合。
 * @returns sfnt 字体字节。
 */
function buildSfnt(tables: readonly SfntTable[]): Uint8Array {
  const sorted = [...tables].sort((left, right) => (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0));
  const count = sorted.length;
  let maxPower = 1;
  let entrySelector = 0;
  while (maxPower * 2 <= count) {
    maxPower *= 2;
    entrySelector += 1;
  }
  const searchRange = maxPower * 16;
  const rangeShift = count * 16 - searchRange;

  const headerLength = 12 + count * 16;
  let cursor = (headerLength + 3) & ~3;
  const entries = sorted.map((table) => {
    const offset = cursor;
    cursor = (cursor + table.data.length + 3) & ~3;
    return { tag: table.tag, offset, length: table.data.length };
  });
  const total = cursor;
  const out = new Uint8Array(total);
  out[0] = 0x4f; // O
  out[1] = 0x54; // T
  out[2] = 0x54; // T
  out[3] = 0x4f; // O
  writeUint16(out, 4, count);
  writeUint16(out, 6, searchRange);
  writeUint16(out, 8, entrySelector);
  writeUint16(out, 10, rangeShift);
  entries.forEach((entry, index) => {
    const base = 12 + index * 16;
    for (let byte = 0; byte < 4; byte += 1) out[base + byte] = entry.tag.charCodeAt(byte);
    writeUint32(out, base + 4, 0); // checkSum：fontkit 不校验
    writeUint32(out, base + 8, entry.offset);
    writeUint32(out, base + 12, entry.length);
    out.set(sorted[index].data, entry.offset);
  });
  return out;
}

/**
 * 尝试把裸 CFF 适配为 fontkit 可解析的 sfnt 字体。
 *
 * 字节不是裸 CFF（已是 sfnt/WOFF/TTC、或结构解析失败）时返回 null，
 * 由调用方继续走原有解析与错误路径。
 *
 * @param bytes 字体字节。
 * @returns sfnt 字体字节；不适配时返回 null。
 */
export function adaptBareCff(bytes: Uint8Array): Uint8Array | null {
  try {
    const cff = parseBareCff(bytes);
    if (cff.numGlyphs === 0) return null;

    const cffTable = buildCff(cff);
    const unitsPerEm = cff.unitsPerEm;
    const bbox = cff.bbox ?? {
      minX: 0,
      minY: 0,
      maxX: unitsPerEm,
      maxY: unitsPerEm,
    };
    const advanceWidth = cff.advanceWidth;
    const ascent = Math.max(bbox.maxY, unitsPerEm) | 0;
    const descent = Math.min(bbox.minY, 0) | 0;

    return buildSfnt([
      { tag: 'CFF ', data: cffTable },
      { tag: 'head', data: buildHead(unitsPerEm, bbox) },
      { tag: 'hhea', data: buildHhea(ascent, descent, cff.numGlyphs) },
      {
        tag: 'hmtx',
        data: buildHmtx(Array.from({ length: cff.numGlyphs }, () => advanceWidth)),
      },
      { tag: 'maxp', data: buildMaxp(cff.numGlyphs) },
    ]);
  } catch {
    return null;
  }
}
