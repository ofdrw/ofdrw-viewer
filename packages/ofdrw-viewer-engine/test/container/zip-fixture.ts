/**
 * 测试用合成 ZIP 构造器。
 *
 * 只使用 `fflate.deflateSync` 与手写头部，便于覆盖 stored/deflate、ZIP64、
 * data descriptor、注释、UTF-8 文件名、CRC 错误与恶意路径等场景。
 */

import { deflateSync } from 'fflate';

/** 合成 ZIP 条目。 */
export interface ZipFixtureEntry {
  /** 原始条目名（可包含重复斜杠/`..`，用于测试规范化与安全校验）。 */
  name: string;
  /** 原始数据；字符串按 UTF-8 编码。 */
  data?: Uint8Array | string;
  /** 压缩方法，默认 8（deflate）；0 为 stored。 */
  method?: 0 | 8 | number;
  /** 通用标志位；默认自动设置 UTF-8 bit 11。 */
  flags?: number;
  /** 覆盖中央目录 CRC，用于构造 CRC 错误。 */
  crcOverride?: number;
  /** 覆盖中央目录压缩大小。 */
  compressedSizeOverride?: number;
  /** 覆盖中央目录解压大小。 */
  uncompressedSizeOverride?: number;
  /** 使用 data descriptor：局部头中的 CRC/大小写 0，flag bit 3 置位。 */
  useDataDescriptor?: boolean;
  /** 外部属性（高 16 位目录位 0x10）。 */
  externalAttributes?: number;
}

/** 合成 ZIP 选项。 */
export interface BuildZipOptions {
  /** EOCD 注释；用于验证 64KB 回退扫描。 */
  comment?: string;
  /** 生成 ZIP64 EOCD/中央目录 extra。 */
  zip64?: boolean;
}

/** 32 位无符号整数转小端字节。 */
function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

/** 32 位无符号整数转小端字节。 */
function u32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

/** 64 位无符号整数转小端字节（测试数据均远小于 2^53）。 */
function u64(value: number): Uint8Array {
  return new Uint8Array([...u32(value % 0x1_0000_0000), ...u32(Math.floor(value / 0x1_0000_0000))]);
}

/** 拼接字节块。 */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** CRC32 查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32。
 *
 * @param data 输入字节。
 * @returns 无符号 32 位 CRC。
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ (data[index] as number)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 编码字符串。 */
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 构造 ZIP64 extra field。 */
function zip64Extra(uncompressedSize: number, compressedSize: number, offset: number): Uint8Array {
  return concat([u16(0x0001), u16(24), u64(uncompressedSize), u64(compressedSize), u64(offset)]);
}

/**
 * 构造合成 ZIP。
 *
 * @param entries 条目列表。
 * @param options 注释/ZIP64 选项。
 * @returns ZIP 字节。
 */
export function buildZip(
  entries: readonly ZipFixtureEntry[],
  options: BuildZipOptions = {},
): Uint8Array {
  const prepared = entries.map((entry) => {
    const raw =
      typeof entry.data === 'string' ? encode(entry.data) : (entry.data ?? new Uint8Array(0));
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateSync(raw) : raw;
    const baseFlags = entry.flags ?? 0x0800;
    const flags = entry.useDataDescriptor ? baseFlags | 0x0008 : baseFlags;
    return {
      entry,
      nameBytes: encode(entry.name),
      raw,
      compressed,
      method,
      flags,
      crc: entry.crcOverride ?? crc32(raw),
      compressedSize: entry.compressedSizeOverride ?? compressed.byteLength,
      uncompressedSize: entry.uncompressedSizeOverride ?? raw.byteLength,
    };
  });

  const zip64 = options.zip64 === true;
  const localOffsets: number[] = [];
  let offset = 0;
  for (const item of prepared) {
    localOffsets.push(offset);
    offset += 30 + item.nameBytes.byteLength + item.compressed.byteLength + (item.entry.useDataDescriptor === true ? 16 : 0);
  }
  const cdOffset = offset;

  const localParts: Uint8Array[] = [];
  for (const item of prepared) {
    const descriptor = item.entry.useDataDescriptor === true;
    localParts.push(
      concat([
        u32(0x04034b50),
        u16(zip64 ? 45 : 20),
        u16(item.flags),
        u16(item.method),
        u16(0),
        u16(0),
        u32(descriptor ? 0 : item.crc),
        u32(descriptor ? 0 : item.compressedSize),
        u32(descriptor ? 0 : item.uncompressedSize),
        u16(item.nameBytes.byteLength),
        u16(0),
        item.nameBytes,
        item.compressed,
        ...(descriptor ? [u32(0x08074b50), u32(item.crc), u32(item.compressedSize), u32(item.uncompressedSize)] : []),
      ]),
    );
  }

  const centralParts: Uint8Array[] = [];
  prepared.forEach((item, index) => {
    const extra = zip64
      ? zip64Extra(item.uncompressedSize, item.compressedSize, localOffsets[index] as number)
      : new Uint8Array(0);
    centralParts.push(
      concat([
        u32(0x02014b50),
        u16(zip64 ? 45 : 20),
        u16(zip64 ? 45 : 20),
        u16(item.flags),
        u16(item.method),
        u16(0),
        u16(0),
        u32(item.crc),
        u32(zip64 ? 0xffffffff : item.compressedSize),
        u32(zip64 ? 0xffffffff : item.uncompressedSize),
        u16(item.nameBytes.byteLength),
        u16(extra.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u32(item.entry.externalAttributes ?? 0),
        u32(zip64 ? 0xffffffff : (localOffsets[index] as number)),
        item.nameBytes,
        extra,
      ]),
    );
  });
  const cdBytes = concat(centralParts);
  const commentBytes = encode(options.comment ?? '');
  const count = prepared.length;

  const zip64Parts: Uint8Array[] = [];
  if (zip64) {
    zip64Parts.push(
      concat([
        u32(0x06064b50),
        u64(44),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(count),
        u64(count),
        u64(cdBytes.byteLength),
        u64(cdOffset),
      ]),
    );
    zip64Parts.push(
      concat([
        u32(0x07064b50),
        u32(0),
        u64(cdOffset + cdBytes.byteLength),
        u32(1),
      ]),
    );
  }

  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(zip64 ? 0xffff : count),
    u16(zip64 ? 0xffff : count),
    u32(zip64 ? 0xffffffff : cdBytes.byteLength),
    u32(zip64 ? 0xffffffff : cdOffset),
    u16(commentBytes.byteLength),
    commentBytes,
  ]);

  return concat([...localParts, cdBytes, ...zip64Parts, eocd]);
}

/** 简单字节源包装，用于统计读取次数与区间。 */
export class CountingSource {
  /** 读取调用次数。 */
  readCalls = 0;
  /** 累计读取字节数。 */
  bytesRead = 0;
  /** 读取区间列表。 */
  readonly ranges: { offset: number; length: number }[] = [];
  readonly size: number;
  private readonly bytes: Uint8Array;

  /**
   * @param bytes 完整字节。
   */
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.byteLength;
  }

  /**
   * 读取区间并记录统计。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取字节。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.readCalls += 1;
    this.bytesRead += length;
    this.ranges.push({ offset, length });
    return this.bytes.slice(offset, offset + length);
  }
}