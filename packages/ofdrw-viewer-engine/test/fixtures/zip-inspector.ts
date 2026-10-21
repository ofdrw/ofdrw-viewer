/**
 * 独立 ZIP 解析器（测试 fixture 专用）。
 *
 * 与 `zip-builder.ts` 不共享解析代码，用于交叉验证合成 ZIP 的结构：
 * EOCD / ZIP64 EOCD+locator / 中央目录 / 本地头 / ZIP64 extra / data descriptor。
 * 只支持 stored(0) 与 deflate(8)，与 v1 容器的支持范围一致。
 */

import { inflateRawSync } from 'node:zlib';
import { crc32 } from './zip-builder';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** 解析后的 ZIP 条目。 */
export interface ParsedZipEntry {
  /** 包内路径（按中央目录原始字节 UTF-8 解码）。 */
  name: string;
  /** 解压后的内容。 */
  data: Uint8Array;
  /** 压缩方式：0=stored，8=deflate。 */
  method: number;
  /** 通用标志位。 */
  flags: number;
  /** 是否设置 UTF-8 标志位（bit 11）。 */
  utf8: boolean;
  /** 是否使用 data descriptor（bit 3）。 */
  dataDescriptor: boolean;
  /** 中央目录记录的 CRC-32。 */
  crc32: number;
  /** 压缩后大小，byte。 */
  compressedSize: number;
  /** 解压后大小，byte。 */
  uncompressedSize: number;
  /** 本地文件头在 ZIP 中的偏移，byte。 */
  localOffset: number;
  /** 条目注释。 */
  comment: string;
  /** 中央目录是否使用 ZIP64 扩展字段。 */
  zip64: boolean;
}

/** 解析选项。 */
export interface ReadZipOptions {
  /** 是否校验 CRC 与解压大小，默认 true。 */
  verifyCrc?: boolean;
}

/**
 * 解析 ZIP 并解压所有条目。
 *
 * @param zip ZIP 字节。
 * @param options 解析选项。
 * @returns 条目列表（保持中央目录顺序）。
 * @throws 当 EOCD/中央目录/本地头/压缩方式/CRC 非法时抛出错误。
 */
export function readZipEntries(zip: Uint8Array, options: ReadZipOptions = {}): ParsedZipEntry[] {
  const verify = options.verifyCrc ?? true;
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdOffset = findEocd(view);
  let entryCount = view.getUint16(eocdOffset + 10, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  let centralSize = view.getUint32(eocdOffset + 12, true);

  const needZip64 =
    entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff;
  if (needZip64) {
    const parsed = readZip64Directory(view, eocdOffset);
    entryCount = parsed.entryCount;
    centralOffset = parsed.centralOffset;
    centralSize = parsed.centralSize;
  }

  const entries: ParsedZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > zip.length) throw new Error(`ZIP 中央目录越界（条目 ${index}）`);
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`ZIP 中央目录签名错误（条目 ${index} @ ${cursor}）`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    let compressedSize = view.getUint32(cursor + 20, true);
    let uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    let localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const commentStart = extraStart + extraLength;
    const commentEnd = commentStart + commentLength;
    if (commentEnd > zip.length) throw new Error(`ZIP 中央目录条目 ${index} 越界`);
    const name = decodeUtf8(zip.subarray(nameStart, nameStart + nameLength));
    const comment = decodeUtf8(zip.subarray(commentStart, commentEnd));

    const extraFields = parseExtraFields(zip.subarray(extraStart, commentStart));
    let zip64 = false;
    const zip64Field = extraFields.get(0x0001);
    if (zip64Field) {
      zip64 = true;
      let fieldCursor = 0;
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = readU64(zip64Field, fieldCursor);
        fieldCursor += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = readU64(zip64Field, fieldCursor);
        fieldCursor += 8;
      }
      if (localOffset === 0xffffffff) {
        localOffset = readU64(zip64Field, fieldCursor);
      }
    }

    const local = readLocalEntry(zip, view, localOffset, method, compressedSize, verify);
    if (verify) {
      const actual = crc32(local.data);
      if (actual !== crc) {
        throw new Error(`ZIP 条目 ${name} CRC 不匹配：期望 ${crc}，实际 ${actual}`);
      }
      if (local.data.length !== uncompressedSize) {
        throw new Error(
          `ZIP 条目 ${name} 解压大小不匹配：期望 ${uncompressedSize}，实际 ${local.data.length}`,
        );
      }
    }
    entries.push({
      name,
      data: local.data,
      method,
      flags,
      utf8: (flags & 0x0800) !== 0,
      dataDescriptor: (flags & 0x0008) !== 0,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      comment,
      zip64,
    });
    cursor = commentEnd;
  }
  return entries;
}

/** 从尾部向前查找 EOCD（允许归档注释，最大 65535 字节）。 */
function findEocd(view: DataView): number {
  const length = view.byteLength;
  const min = Math.max(0, length - 22 - 0xffff);
  for (let offset = length - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === length) return offset;
  }
  throw new Error('ZIP 缺少 EOCD（可能截断或不是 ZIP）');
}

/** 解析 ZIP64 EOCD 与 locator。 */
function readZip64Directory(
  view: DataView,
  eocdOffset: number,
): { entryCount: number; centralOffset: number; centralSize: number } {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0 || view.getUint32(locatorOffset, true) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new Error('ZIP64 缺少 locator');
  }
  const zip64EocdOffset = readU64View(view, locatorOffset + 8);
  if (zip64EocdOffset + 56 > view.byteLength) throw new Error('ZIP64 EOCD 越界');
  if (view.getUint32(zip64EocdOffset, true) !== ZIP64_EOCD_SIGNATURE) {
    throw new Error('ZIP64 EOCD 签名错误');
  }
  return {
    entryCount: readU64View(view, zip64EocdOffset + 32),
    centralSize: readU64View(view, zip64EocdOffset + 40),
    centralOffset: readU64View(view, zip64EocdOffset + 48),
  };
}

/** 读取本地文件头并解压条目数据。 */
function readLocalEntry(
  zip: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
  verify: boolean,
): { data: Uint8Array; descriptor: boolean } {
  if (localOffset + 30 > zip.length) throw new Error('ZIP 本地文件头越界');
  if (view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`ZIP 本地文件头签名错误 @ ${localOffset}`);
  }
  const flags = view.getUint16(localOffset + 6, true);
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > zip.length) throw new Error('ZIP 条目数据越界');
  const payload = zip.subarray(dataStart, dataEnd);

  let data: Uint8Array;
  if (method === 0) {
    data = payload.slice();
  } else if (method === 8) {
    data = new Uint8Array(inflateRawSync(payload));
  } else {
    throw new Error(`ZIP 不支持的压缩方式 ${method}`);
  }

  if (verify && (flags & 0x0008) !== 0) {
    // data descriptor 位于数据之后；签名可选，按 4/8 字节大小字段尝试校验存在性。
    const descriptorOffset = dataEnd;
    const hasSignature =
      descriptorOffset + 4 <= zip.length && view.getUint32(descriptorOffset, true) === 0x08074b50;
    const sizeFieldOffset = descriptorOffset + (hasSignature ? 4 : 0) + 4;
    if (sizeFieldOffset + 8 > zip.length) throw new Error('ZIP data descriptor 缺失');
  }
  return { data, descriptor: true };
}

/** 解析扩展字段（id + 数据）。 */
function parseExtraFields(extra: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra[offset]! | (extra[offset + 1]! << 8);
    const size = extra[offset + 2]! | (extra[offset + 3]! << 8);
    offset += 4;
    if (offset + size > extra.length) throw new Error('ZIP 扩展字段越界');
    fields.set(id, extra.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== extra.length) throw new Error('ZIP 扩展字段长度不匹配');
  return fields;
}

function readU64(bytes: Uint8Array, offset: number): number {
  let value = 0;
  for (let i = 7; i >= 0; i -= 1) value = value * 256 + bytes[offset + i]!;
  if (!Number.isSafeInteger(value)) throw new Error(`ZIP64 数值超出安全整数范围：${value}`);
  return value;
}

function readU64View(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ZIP64 数值超出安全整数范围：${value.toString()}`);
  }
  return Number(value);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}