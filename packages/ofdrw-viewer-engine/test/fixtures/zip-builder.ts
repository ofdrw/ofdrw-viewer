/**
 * 合成 ZIP 生成器（测试 fixture 专用，不进入引擎运行时）。
 *
 * 支持 stored/deflate、ZIP64 条目与 ZIP64 EOCD、data descriptor、UTF-8 中文名、
 * 重复条目与条目注释，用于覆盖容器层/安全限制的边界条件。
 * 生成结果由 `zip-inspector.ts` 独立解析校验，避免“生成器自证”。
 *
 * 参考：PKWARE APPNOTE 6.3.x（本地文件头 4.3.7、中央目录 4.3.12、EOCD 4.3.16）。
 */

import { deflateRawSync } from 'node:zlib';

/** 条目压缩方式；`store` 表示不压缩。 */
export type ZipCompressionMethod = 'store' | 'deflate';

/** 单个待写入条目。 */
export interface ZipEntryInput {
  /** 包内路径；允许中文与 `../`（用于安全测试，写包时不做规范化）。 */
  name: string;
  /** 条目内容；字符串按 UTF-8 编码。 */
  data: Uint8Array | string;
  /** 压缩方式，默认 `deflate`。 */
  method?: ZipCompressionMethod;
  /** 强制该条目使用 ZIP64 扩展字段（本地/中央目录大小字段写 0xFFFFFFFF）。 */
  zip64?: boolean;
  /** 使用 data descriptor（通用标志位 bit 3）；本地头 CRC/大小写 0。 */
  dataDescriptor?: boolean;
  /** 强制设置 UTF-8 标志位 bit 11；默认名称含非 ASCII 字符时自动设置。 */
  utf8?: boolean;
  /** 条目注释（写入中央目录）。 */
  comment?: string;
}

/** ZIP 归档级选项。 */
export interface CreateZipOptions {
  /** 归档注释（写入 EOCD）。 */
  comment?: string;
  /** 强制写 ZIP64 EOCD + locator（即使条目数/偏移未超限），用于结构测试。 */
  forceZip64Eocd?: boolean;
}

/** 合成结果。 */
export interface ZipBuildResult {
  /** 完整 ZIP 字节。 */
  bytes: Uint8Array;
  /** 实际写入的条目数。 */
  entryCount: number;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

/** 固定 DOS 时间戳：2024-01-01 00:00:00，便于快照与复现。 */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC-32（IEEE 802.3，ZIP 使用的多项式 0xEDB88320）。
 *
 * @param data 原始字节。
 * @returns 无符号 32 位 CRC。
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 数字编码辅助：写入小端序整数。 */
function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function writeU64(view: DataView, offset: number, value: number): void {
  view.setBigUint64(offset, BigInt(value), true);
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/**
 * 构造 ZIP64 扩展字段。
 *
 * @param fields 需要写入 8 字节值的字段，顺序必须符合 APPNOTE（usize、csize、offset）。
 * @returns 扩展字段字节（含 4 字节头），无字段时返回空数组。
 */
function buildZip64Extra(fields: readonly number[]): Uint8Array {
  if (fields.length === 0) return new Uint8Array(0);
  const extra = new Uint8Array(4 + fields.length * 8);
  const view = new DataView(extra.buffer);
  writeU16(view, 0, 0x0001);
  writeU16(view, 2, fields.length * 8);
  fields.forEach((value, index) => writeU64(view, 4 + index * 8, value));
  return extra;
}

/** 单条目在写入过程中的中间状态。 */
interface PreparedEntry {
  input: ZipEntryInput;
  nameBytes: Uint8Array;
  dataBytes: Uint8Array;
  compressed: Uint8Array;
  method: number;
  crc: number;
  flags: number;
  zip64: boolean;
  localOffset: number;
  localChunk: Uint8Array;
}

/**
 * 生成合成 ZIP。
 *
 * @param entries 条目列表；允许重名（用于重复资源测试）。
 * @param options 归档级选项。
 * @returns ZIP 字节与条目数。
 */
export function createZip(
  entries: readonly ZipEntryInput[],
  options: CreateZipOptions = {},
): ZipBuildResult {
  const encoder = new TextEncoder();
  const prepared: PreparedEntry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const input of entries) {
    const nameBytes = encoder.encode(input.name);
    const dataBytes = typeof input.data === 'string' ? encoder.encode(input.data) : input.data;
    const methodName = input.method ?? 'deflate';
    if (methodName !== 'store' && methodName !== 'deflate') {
      throw new Error(`createZip: 不支持的压缩方式 ${String(methodName)}`);
    }
    const compressed = methodName === 'deflate' ? deflateRawSync(dataBytes) : dataBytes;
    const crc = crc32(dataBytes);
    const zip64 = input.zip64 === true;
    const useDescriptor = input.dataDescriptor === true;
    const utf8 = input.utf8 ?? hasNonAscii(input.name);
    let flags = 0;
    if (useDescriptor) flags |= 0x0008;
    if (utf8) flags |= 0x0800;

    const localExtra = zip64 && !useDescriptor ? buildZip64Extra([dataBytes.length, compressed.length]) : new Uint8Array(0);
    const localHeader = new Uint8Array(30 + nameBytes.length + localExtra.length);
    const localView = new DataView(localHeader.buffer);
    writeU32(localView, 0, LOCAL_HEADER_SIGNATURE);
    writeU16(localView, 4, zip64 ? 45 : 20);
    writeU16(localView, 6, flags);
    writeU16(localView, 8, methodName === 'deflate' ? 8 : 0);
    writeU16(localView, 10, FIXED_DOS_TIME);
    writeU16(localView, 12, FIXED_DOS_DATE);
    writeU32(localView, 14, useDescriptor ? 0 : crc);
    writeU32(localView, 18, useDescriptor ? 0 : zip64 ? 0xffffffff : compressed.length);
    writeU32(localView, 22, useDescriptor ? 0 : zip64 ? 0xffffffff : dataBytes.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, localExtra.length);
    localHeader.set(nameBytes, 30);
    localHeader.set(localExtra, 30 + nameBytes.length);

    const descriptor = new Uint8Array(useDescriptor ? (zip64 ? 24 : 16) : 0);
    if (useDescriptor) {
      const descriptorView = new DataView(descriptor.buffer);
      writeU32(descriptorView, 0, DATA_DESCRIPTOR_SIGNATURE);
      writeU32(descriptorView, 4, crc);
      if (zip64) {
        writeU64(descriptorView, 8, compressed.length);
        writeU64(descriptorView, 16, dataBytes.length);
      } else {
        writeU32(descriptorView, 8, compressed.length);
        writeU32(descriptorView, 12, dataBytes.length);
      }
    }

    const record = concatChunks([localHeader, compressed, descriptor]);
    chunks.push(record);
    prepared.push({
      input,
      nameBytes,
      dataBytes,
      compressed,
      method: methodName === 'deflate' ? 8 : 0,
      crc,
      flags,
      zip64,
      localOffset: offset,
      localChunk: record,
    });
    offset += record.length;
  }

  const centralChunks: Uint8Array[] = [];
  const centralStart = offset;
  for (const entry of prepared) {
    const commentBytes = encoder.encode(entry.input.comment ?? '');
    const needsZip64 = entry.zip64;
    const centralExtra = needsZip64
      ? buildZip64Extra([entry.dataBytes.length, entry.compressed.length, entry.localOffset])
      : new Uint8Array(0);
    const header = new Uint8Array(46 + entry.nameBytes.length + centralExtra.length + commentBytes.length);
    const view = new DataView(header.buffer);
    writeU32(view, 0, CENTRAL_HEADER_SIGNATURE);
    writeU16(view, 4, 0x031e);
    writeU16(view, 6, needsZip64 ? 45 : 20);
    writeU16(view, 8, entry.flags);
    writeU16(view, 10, entry.method);
    writeU16(view, 12, FIXED_DOS_TIME);
    writeU16(view, 14, FIXED_DOS_DATE);
    writeU32(view, 16, entry.crc);
    writeU32(view, 20, needsZip64 ? 0xffffffff : entry.compressed.length);
    writeU32(view, 24, needsZip64 ? 0xffffffff : entry.dataBytes.length);
    writeU16(view, 28, entry.nameBytes.length);
    writeU16(view, 30, centralExtra.length);
    writeU16(view, 32, commentBytes.length);
    writeU16(view, 34, 0);
    writeU16(view, 36, 0);
    writeU32(view, 38, 0);
    writeU32(view, 42, needsZip64 ? 0xffffffff : entry.localOffset);
    header.set(entry.nameBytes, 46);
    header.set(centralExtra, 46 + entry.nameBytes.length);
    header.set(commentBytes, 46 + entry.nameBytes.length + centralExtra.length);
    centralChunks.push(header);
    offset += header.length;
  }

  const centralSize = offset - centralStart;
  const count = prepared.length;
  const commentBytes = encoder.encode(options.comment ?? '');

  if (options.forceZip64Eocd) {
    const zip64Eocd = new Uint8Array(56);
    const view = new DataView(zip64Eocd.buffer);
    writeU32(view, 0, ZIP64_EOCD_SIGNATURE);
    writeU64(view, 4, 44);
    writeU16(view, 12, 45);
    writeU16(view, 14, 45);
    writeU32(view, 16, 0);
    writeU32(view, 20, 0);
    writeU64(view, 24, count);
    writeU64(view, 32, count);
    writeU64(view, 40, centralSize);
    writeU64(view, 48, centralStart);
    chunks.push(...centralChunks, zip64Eocd);

    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    writeU32(locatorView, 0, ZIP64_LOCATOR_SIGNATURE);
    writeU32(locatorView, 4, 0);
    writeU64(locatorView, 8, centralStart + centralSize);
    writeU32(locatorView, 16, 1);
    chunks.push(locator);

    const eocd = new Uint8Array(22 + commentBytes.length);
    const eocdView = new DataView(eocd.buffer);
    writeU32(eocdView, 0, EOCD_SIGNATURE);
    writeU16(eocdView, 4, 0);
    writeU16(eocdView, 6, 0);
    writeU16(eocdView, 8, 0xffff);
    writeU16(eocdView, 10, 0xffff);
    writeU32(eocdView, 12, 0xffffffff);
    writeU32(eocdView, 16, 0xffffffff);
    writeU16(eocdView, 20, commentBytes.length);
    eocd.set(commentBytes, 22);
    chunks.push(eocd);

    return { bytes: concatChunks(chunks), entryCount: count };
  }

  chunks.push(...centralChunks);
  const eocd = new Uint8Array(22 + commentBytes.length);
  const eocdView = new DataView(eocd.buffer);
  writeU32(eocdView, 0, EOCD_SIGNATURE);
  writeU16(eocdView, 4, 0);
  writeU16(eocdView, 6, 0);
  writeU16(eocdView, 8, count);
  writeU16(eocdView, 10, count);
  writeU32(eocdView, 12, centralSize);
  writeU32(eocdView, 16, centralStart);
  writeU16(eocdView, 20, commentBytes.length);
  eocd.set(commentBytes, 22);
  chunks.push(eocd);

  return { bytes: concatChunks(chunks), entryCount: count };
}