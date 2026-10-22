/**
 * 按需 ZIP 读取器。
 *
 * 打开时只读 EOCD（含 ZIP64 locator/record）与中央目录，条目内容按需解压；
 * 不整包解压、不预读图片/字体。安全策略见设计方案第 7、17 节：
 * - 拒绝加密条目、非 stored/deflate 压缩方法、路径穿越、重复规范化路径；
 * - 校验包大小/条目数/单条目/总解压/压缩比，超限抛 `OFD_LIMIT_EXCEEDED`；
 * - data descriptor（flag bit 3）以中央目录大小为准；
 * - CRC32 默认校验，失败只 warning，不丢弃数据。
 */

import type { ByteSource } from '../platform/byte-source';
import type { OFDWarning } from '../warnings';
import { OFDError } from '../errors';
import { normalizePackagePath } from './path';

/** EOCD 签名（`PK\x05\x06`）。 */
const EOCD_SIGNATURE = 0x06054b50;
/** ZIP64 EOCD locator 签名（`PK\x06\x07`）。 */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
/** ZIP64 EOCD record 签名（`PK\x06\x06`）。 */
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
/** 中央目录项签名（`PK\x01\x02`）。 */
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
/** 局部文件头签名（`PK\x03\x04`）。 */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** EOCD 固定长度，byte。 */
const EOCD_SIZE = 22;
/** ZIP 注释最大长度，byte。 */
const MAX_ZIP_COMMENT = 0xffff;
/** 局部文件头固定长度，byte。 */
const LOCAL_HEADER_SIZE = 30;
/** 中央目录项固定长度，byte。 */
const CENTRAL_HEADER_SIZE = 46;
/** ZIP64 EOCD record 固定长度，byte。 */
const ZIP64_EOCD_SIZE = 56;
/** ZIP64 locator 长度，byte。 */
const ZIP64_LOCATOR_SIZE = 20;
/** 32 位哨兵值。 */
const UINT32_MAX = 0xffffffff;
/** 16 位哨兵值。 */
const UINT16_MAX = 0xffff;

/** 解压方式：0=stored，8=deflate。 */
export type ZipCompressionMethod = 0 | 8;

/** ZIP 条目元数据；大小单位 byte。 */
export interface ZipEntryMeta {
  /** 规范化后的包内路径（无前导 `/`，无 `..`）。 */
  name: string;
  /** 压缩后大小，byte。 */
  compressedSize: number;
  /** 解压后大小，byte。 */
  uncompressedSize: number;
  /** 压缩方法。 */
  method: ZipCompressionMethod;
  /** 局部文件头偏移，byte。 */
  localHeaderOffset: number;
  /** CRC32。 */
  crc32: number;
  /** 通用标志位；bit 3 表示 data descriptor。 */
  flags: number;
}

/** ZIP 读取限制；除特别说明外单位 byte。 */
export interface ZipLimits {
  /** 压缩包大小上限，byte。 */
  maxPackageBytes: number;
  /** 条目数上限。 */
  maxEntries: number;
  /** 单条目解压大小上限，byte。 */
  maxEntryBytes: number;
  /** 总解压大小上限，byte。 */
  maxTotalUncompressedBytes: number;
  /** 单条目最大压缩比。 */
  maxCompressionRatio: number;
}

/** 默认限制，与设计方案 7.4 一致；0 表示不限制。 */
export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxPackageBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
});

/** 读取条目选项。 */
export interface ReadEntryOptions {
  /** 解压后大小上限，byte；缺省使用打开时的限制。 */
  maxBytes?: number;
  /** 是否校验 CRC32，默认 true。 */
  verifyCrc?: boolean;
  /** warning 回调；CRC 失败/大小不一致时上报，不影响返回数据。 */
  onWarning?: (warning: OFDWarning) => void;
}

/** 打开 ZIP 时解析出的目录信息。 */
interface DirectoryInfo {
  entriesTotal: number;
  cdOffset: number;
  cdSize: number;
}

/**
 * ZIP 随机读取器。
 *
 * 构造后中央目录常驻；`readEntry` 才读取局部头并解压。加密条目、非 0/8 压缩方法、
 * 路径穿越与超限条目必须拒绝。
 */
export class ZipReader {
  private readonly entries: Map<string, ZipEntryMeta>;
  /**
   * 小写路径索引，仅用于精确查找失败后的兼容回退。
   *
   * 值 `null` 表示存在多个仅大小写不同的条目，回退有歧义，必须继续失败。
   */
  private readonly entriesByLower = new Map<string, ZipEntryMeta | null>();
  private readonly limits: ZipLimits;
  private closed = false;

  private constructor(
    private readonly source: ByteSource,
    entries: Map<string, ZipEntryMeta>,
    limits: ZipLimits,
  ) {
    this.entries = entries;
    this.limits = limits;
  }

  /**
   * 打开 ZIP 并解析 EOCD/中央目录。
   *
   * @param source 随机可读字节源；若实现提供 `ready()` 会先等待其完成。
   * @param limits 可覆盖的限制；未提供字段使用设计默认值。
   * @returns ZIP 读取器。
   */
  static async open(source: ByteSource, limits?: Partial<ZipLimits>): Promise<ZipReader> {
    const ready = (source as ByteSource & { ready?: () => Promise<void> }).ready;
    if (typeof ready === 'function') await ready.call(source);

    const mergedLimits = mergeLimits(limits);
    if (source.size <= 0) {
      throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP 为空或字节源不可读');
    }
    if (isOverLimit(source.size, mergedLimits.maxPackageBytes)) {
      throw new OFDError(
        'OFD_LIMIT_EXCEEDED',
        `压缩包大小 ${source.size} 超过限制 ${mergedLimits.maxPackageBytes}`,
      );
    }

    const reader = new ZipReader(source, new Map<string, ZipEntryMeta>(), mergedLimits);
    const directory = await reader.readDirectoryInfo();
    await reader.readCentralDirectory(directory);
    return reader;
  }

  /** 全部中央目录条目，按 ZIP 中出现顺序。 */
  listEntries(): readonly ZipEntryMeta[] {
    return [...this.entries.values()];
  }

  /**
   * 查找条目元数据。
   *
   * @param path 包内路径。
   * @returns 元数据或 undefined。
   */
  getEntry(path: string): ZipEntryMeta | undefined {
    if (this.closed) return undefined;
    try {
      const normalized = normalizePackagePath(path);
      const exact = this.entries.get(normalized);
      if (exact) return exact;
      // OFD 生产工具常见 Doc_0/DOC_0、Res/res 大小写漂移；仅在唯一匹配时回退，
      // 避免全局 lowercase 或歧义条目改变精确路径语义。
      return this.entriesByLower.get(normalized.toLowerCase()) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 判断条目是否存在。
   *
   * @param path 包内路径。
   * @returns 是否存在。
   */
  hasEntry(path: string): boolean {
    return this.getEntry(path) !== undefined;
  }

  /**
   * 读取并解压条目。
   *
   * @param path 包内路径。
   * @param options 读取选项。
   * @returns 解压后的字节。
   * @throws OFDError 条目不存在、数据损坏或超限时。
   */
  async readEntry(path: string, options: ReadEntryOptions = {}): Promise<Uint8Array> {
    if (this.closed) throw new OFDError('OFD_CLOSED', 'ZipReader 已关闭');
    const entry = this.getEntry(path);
    if (!entry) throw new OFDError('OFD_ENTRY_NOT_FOUND', `ZIP 条目不存在：${path}`);

    const maxBytes = effectiveMaxBytes(options.maxBytes, this.limits.maxEntryBytes);
    if (isOverLimit(entry.uncompressedSize, maxBytes)) {
      throw new OFDError(
        'OFD_LIMIT_EXCEEDED',
        `条目 ${entry.name} 解压大小 ${entry.uncompressedSize} 超过限制 ${maxBytes ?? 0}`,
      );
    }

    const localHeader = await this.readExact(entry.localHeaderOffset, LOCAL_HEADER_SIZE, `局部头：${entry.name}`);
    const view = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
    if (view.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
      throw new OFDError('OFD_INVALID_PACKAGE', `条目 ${entry.name} 局部文件头签名非法`);
    }
    const flags = view.getUint16(6, true);
    const localMethod = view.getUint16(8, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw new OFDError('OFD_ENCRYPTED', `条目 ${entry.name} 已加密`);
    }
    if (localMethod !== entry.method) {
      throw new OFDError(
        'OFD_INVALID_PACKAGE',
        `条目 ${entry.name} 局部头压缩方法与中央目录不一致`,
      );
    }

    const dataOffset = entry.localHeaderOffset + LOCAL_HEADER_SIZE + nameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > this.source.size) {
      throw new OFDError('OFD_INVALID_PACKAGE', `条目 ${entry.name} 数据区间越界`);
    }
    const compressed = await this.readExact(dataOffset, entry.compressedSize, `条目数据：${entry.name}`);

    let output: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new OFDError('OFD_INVALID_PACKAGE', `stored 条目 ${entry.name} 压缩/解压大小不一致`);
      }
      output = compressed;
    } else {
      output = await inflateRaw(compressed, maxBytes, entry.name);
      if (output.byteLength !== entry.uncompressedSize) {
        warn(
          options.onWarning,
          'W_BAD_NUMBER',
          `条目 ${entry.name} 解压后大小 ${output.byteLength} 与目录记录 ${entry.uncompressedSize} 不一致`,
          entry.name,
        );
      }
    }

    if (options.verifyCrc !== false) {
      const actualCrc = crc32(output);
      if (actualCrc !== (entry.crc32 >>> 0)) {
        warn(
          options.onWarning,
          'W_BAD_NUMBER',
          `条目 ${entry.name} CRC32 校验失败：期望 ${toHex(entry.crc32 >>> 0)}，实际 ${toHex(actualCrc)}`,
          entry.name,
        );
      }
    }
    return output;
  }

  /** 关闭读取器并释放中央目录缓存；不关闭底层 ByteSource。 */
  close(): void {
    this.entries.clear();
    this.closed = true;
  }

  /**
   * 读取 EOCD（必要时 ZIP64 EOCD），返回中央目录位置与条目数。
   *
   * @returns 中央目录信息。
   */
  private async readDirectoryInfo(): Promise<DirectoryInfo> {
    const tailLength = Math.min(this.source.size, EOCD_SIZE + MAX_ZIP_COMMENT);
    const tailStart = this.source.size - tailLength;
    const tail = await this.readExact(tailStart, tailLength, 'ZIP 尾部');
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let eocdIndex = -1;
    for (let index = tail.length - EOCD_SIZE; index >= 0; index -= 1) {
      if (tailView.getUint32(index, true) !== EOCD_SIGNATURE) continue;
      const commentLength = tailView.getUint16(index + 20, true);
      if (index + EOCD_SIZE + commentLength === tail.length) {
        eocdIndex = index;
        break;
      }
    }
    if (eocdIndex < 0) {
      throw new OFDError('OFD_INVALID_PACKAGE', '未找到 ZIP EOCD');
    }

    const diskNumber = tailView.getUint16(eocdIndex + 4, true);
    const cdStartDisk = tailView.getUint16(eocdIndex + 6, true);
    const entriesOnDisk = tailView.getUint16(eocdIndex + 8, true);
    const entriesTotal = tailView.getUint16(eocdIndex + 10, true);
    const cdSize = tailView.getUint32(eocdIndex + 12, true);
    const cdOffset = tailView.getUint32(eocdIndex + 16, true);

    const needsZip64 =
      entriesTotal === UINT16_MAX ||
      entriesOnDisk === UINT16_MAX ||
      cdSize === UINT32_MAX ||
      cdOffset === UINT32_MAX;

    let resolved: DirectoryInfo = { entriesTotal, cdOffset, cdSize };
    if (needsZip64) {
      resolved = await this.readZip64DirectoryInfo(tailStart + eocdIndex);
    }

    if (diskNumber !== 0 || cdStartDisk !== 0) {
      throw new OFDError('OFD_INVALID_PACKAGE', '不支持分卷 ZIP');
    }
    if (isOverLimit(resolved.entriesTotal, this.limits.maxEntries)) {
      throw new OFDError(
        'OFD_LIMIT_EXCEEDED',
        `ZIP 条目数 ${resolved.entriesTotal} 超过限制 ${this.limits.maxEntries}`,
      );
    }
    if (
      resolved.cdOffset < 0 ||
      resolved.cdSize < 0 ||
      resolved.cdOffset + resolved.cdSize > this.source.size
    ) {
      throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP 中央目录区间越界');
    }
    return resolved;
  }

  /**
   * 解析 ZIP64 EOCD locator/record。
   *
   * @param eocdAbsoluteOffset EOCD 在文件中的绝对偏移，byte。
   * @returns 中央目录信息。
   */
  private async readZip64DirectoryInfo(eocdAbsoluteOffset: number): Promise<DirectoryInfo> {
    if (eocdAbsoluteOffset < ZIP64_LOCATOR_SIZE) {
      throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 locator 缺失');
    }
    const locator = await this.readExact(
      eocdAbsoluteOffset - ZIP64_LOCATOR_SIZE,
      ZIP64_LOCATOR_SIZE,
      'ZIP64 locator',
    );
    const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
    if (locatorView.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 locator 签名非法');
    }
    const locatorDisk = locatorView.getUint32(4, true);
    const totalDisks = locatorView.getUint32(16, true);
    if (locatorDisk !== 0 || totalDisks > 1) {
      throw new OFDError('OFD_INVALID_PACKAGE', '不支持分卷 ZIP64');
    }
    const recordOffset = readUint64(locatorView, 8, 'ZIP64 EOCD 偏移');
    if (recordOffset + ZIP64_EOCD_SIZE > this.source.size) {
      throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 EOCD 区间越界');
    }
    const record = await this.readExact(recordOffset, ZIP64_EOCD_SIZE, 'ZIP64 EOCD');
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (view.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 EOCD 签名非法');
    }
    const recordSize = readUint64(view, 4, 'ZIP64 EOCD 记录长度');
    if (recordSize < ZIP64_EOCD_SIZE - 12) {
      throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 EOCD 记录长度非法');
    }
    const disk = view.getUint32(16, true);
    const cdDisk = view.getUint32(20, true);
    if (disk !== 0 || cdDisk !== 0) {
      throw new OFDError('OFD_INVALID_PACKAGE', '不支持分卷 ZIP64');
    }
    const entriesTotal = readUint64(view, 32, 'ZIP64 条目数');
    const cdSize = readUint64(view, 40, 'ZIP64 中央目录大小');
    const cdOffset = readUint64(view, 48, 'ZIP64 中央目录偏移');
    return { entriesTotal, cdOffset, cdSize };
  }

  /**
   * 读取并解析中央目录。
   *
   * @param directory 中央目录位置与条目数。
   */
  private async readCentralDirectory(directory: DirectoryInfo): Promise<void> {
    if (directory.cdSize === 0 || directory.entriesTotal === 0) return;
    const directoryBytes = await this.readExact(
      directory.cdOffset,
      directory.cdSize,
      '中央目录',
    );
    const view = new DataView(
      directoryBytes.buffer,
      directoryBytes.byteOffset,
      directoryBytes.byteLength,
    );

    let offset = 0;
    let totalUncompressed = 0;
    for (let index = 0; index < directory.entriesTotal; index += 1) {
      if (offset + CENTRAL_HEADER_SIZE > directoryBytes.length) {
        throw new OFDError('OFD_INVALID_PACKAGE', '中央目录项数量与记录不一致');
      }
      if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw new OFDError('OFD_INVALID_PACKAGE', `中央目录项 #${index} 签名非法`);
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const crc = view.getUint32(offset + 16, true);
      let compressedSize = view.getUint32(offset + 20, true);
      let uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      let localHeaderOffset = view.getUint32(offset + 42, true);
      const externalAttributes = view.getUint32(offset + 38, true);
      const entryEnd = offset + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
      if (entryEnd > directoryBytes.length) {
        throw new OFDError('OFD_INVALID_PACKAGE', '中央目录项越界');
      }

      const nameBytes = directoryBytes.subarray(
        offset + CENTRAL_HEADER_SIZE,
        offset + CENTRAL_HEADER_SIZE + nameLength,
      );
      const extraBytes = directoryBytes.subarray(
        offset + CENTRAL_HEADER_SIZE + nameLength,
        offset + CENTRAL_HEADER_SIZE + nameLength + extraLength,
      );
      const zip64 = parseZip64Extra(extraBytes, {
        uncompressedSize,
        compressedSize,
        localHeaderOffset,
      });
      uncompressedSize = zip64.uncompressedSize;
      compressedSize = zip64.compressedSize;
      localHeaderOffset = zip64.localHeaderOffset;

      if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
        throw new OFDError('OFD_ENCRYPTED', `ZIP 条目已加密：${decodeEntryName(nameBytes, flags)}`);
      }
      if (method !== 0 && method !== 8) {
        throw new OFDError(
          'OFD_UNSUPPORTED_COMPRESSION',
          `不支持的 ZIP 压缩方法 ${method}：${decodeEntryName(nameBytes, flags)}`,
        );
      }

      const rawName = decodeEntryName(nameBytes, flags);
      const isDirectory =
        rawName.endsWith('/') ||
        rawName.endsWith('\\') ||
        (externalAttributes & 0x10) !== 0;
      // 目录项也要先做安全校验，避免用 `../` 目录项绕过路径检查。
      const name = normalizePackagePath(rawName);
      if (isDirectory) {
        offset = entryEnd;
        continue;
      }
      if (name.length === 0) {
        throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP 条目名规范化为空');
      }
      if (this.entries.has(name)) {
        throw new OFDError('OFD_INVALID_PACKAGE', `ZIP 条目规范化路径重复：${name}`);
      }
      if (isOverLimit(uncompressedSize, this.limits.maxEntryBytes)) {
        throw new OFDError(
          'OFD_LIMIT_EXCEEDED',
          `条目 ${name} 解压大小 ${uncompressedSize} 超过限制 ${this.limits.maxEntryBytes}`,
        );
      }
      if (this.limits.maxCompressionRatio > 0 && uncompressedSize > 0) {
        if (compressedSize === 0) {
          throw new OFDError('OFD_LIMIT_EXCEEDED', `条目 ${name} 压缩大小非法为 0`);
        }
        if (uncompressedSize / compressedSize > this.limits.maxCompressionRatio) {
          throw new OFDError(
            'OFD_LIMIT_EXCEEDED',
            `条目 ${name} 压缩比 ${(uncompressedSize / compressedSize).toFixed(1)} 超过限制 ${this.limits.maxCompressionRatio}`,
          );
        }
      }
      totalUncompressed += uncompressedSize;
      if (isOverLimit(totalUncompressed, this.limits.maxTotalUncompressedBytes)) {
        throw new OFDError(
          'OFD_LIMIT_EXCEEDED',
          `ZIP 总解压大小 ${totalUncompressed} 超过限制 ${this.limits.maxTotalUncompressedBytes}`,
        );
      }
      if (localHeaderOffset + LOCAL_HEADER_SIZE > this.source.size) {
        throw new OFDError('OFD_INVALID_PACKAGE', `条目 ${name} 局部头偏移越界`);
      }

      const meta: ZipEntryMeta = {
        name,
        compressedSize,
        uncompressedSize,
        method,
        localHeaderOffset,
        crc32: crc,
        flags,
      };
      this.entries.set(name, meta);
      const lower = name.toLowerCase();
      // 首次出现建立索引；仅大小写不同的第二个条目把索引标为歧义。
      this.entriesByLower.set(lower, this.entriesByLower.has(lower) ? null : meta);
      offset = entryEnd;
    }
  }

  /**
   * 读取固定长度区间；不足时抛结构错误。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @param what 诊断名称。
   * @returns 字节。
   */
  private async readExact(offset: number, length: number, what: string): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.source.size) {
      throw new OFDError('OFD_INVALID_PACKAGE', `${what} 区间越界`);
    }
    const data = await this.source.read(offset, length);
    if (data.byteLength !== length) {
      throw new OFDError(
        'OFD_INVALID_PACKAGE',
        `${what} 读取长度不足：期望 ${length}，实际 ${data.byteLength}`,
      );
    }
    return data;
  }
}

/**
 * 上报 warning；未配置回调时静默。
 *
 * @param handler warning 回调。
 * @param code warning 码。
 * @param message 诊断信息。
 * @param resourceId 资源/条目路径。
 */
function warn(
  handler: ((warning: OFDWarning) => void) | undefined,
  code: string,
  message: string,
  resourceId?: string,
): void {
  if (!handler) return;
  const warning: OFDWarning = { code, message };
  if (resourceId !== undefined) warning.resourceId = resourceId;
  handler(warning);
}

/**
 * 合并默认限制。
 *
 * @param limits 覆盖值。
 * @returns 完整限制。
 */
function mergeLimits(limits?: Partial<ZipLimits>): ZipLimits {
  return {
    maxPackageBytes: normalizeLimit(limits?.maxPackageBytes, DEFAULT_ZIP_LIMITS.maxPackageBytes),
    maxEntries: normalizeLimit(limits?.maxEntries, DEFAULT_ZIP_LIMITS.maxEntries),
    maxEntryBytes: normalizeLimit(limits?.maxEntryBytes, DEFAULT_ZIP_LIMITS.maxEntryBytes),
    maxTotalUncompressedBytes: normalizeLimit(
      limits?.maxTotalUncompressedBytes,
      DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes,
    ),
    maxCompressionRatio: normalizeLimit(
      limits?.maxCompressionRatio,
      DEFAULT_ZIP_LIMITS.maxCompressionRatio,
    ),
  };
}

/**
 * 归一化限制值；负数/非有限值回退默认，0 表示不限制。
 *
 * @param value 覆盖值。
 * @param fallback 默认值。
 * @returns 非负限制。
 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * 判断是否超过限制。
 *
 * @param value 当前值。
 * @param limit 限制；0/undefined 表示不限制。
 * @returns 是否超限。
 */
function isOverLimit(value: number, limit: number | undefined): boolean {
  return limit !== undefined && limit > 0 && value > limit;
}

/**
 * 计算实际生效的单条目上限；调用方覆盖不能突破打开时的全局上限。
 *
 * @param requested 调用方上限，byte。
 * @param global 全局上限，byte。
 * @returns 生效上限；undefined 表示不限制。
 */
function effectiveMaxBytes(requested: number | undefined, global: number): number | undefined {
  const candidate =
    requested !== undefined && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : undefined;
  if (global <= 0) return candidate;
  if (candidate === undefined) return global;
  return Math.min(candidate, global);
}

/**
 * 解析 ZIP64 extra field 中的大小/偏移。
 *
 * @param extra 中央目录 extra 字段。
 * @param base 32 位基础值。
 * @returns 解析后的字段。
 */
function parseZip64Extra(
  extra: Uint8Array,
  base: { uncompressedSize: number; compressedSize: number; localHeaderOffset: number },
): { uncompressedSize: number; compressedSize: number; localHeaderOffset: number } {
  let uncompressedSize = base.uncompressedSize;
  let compressedSize = base.compressedSize;
  let localHeaderOffset = base.localHeaderOffset;
  const needs =
    uncompressedSize === UINT32_MAX ||
    compressedSize === UINT32_MAX ||
    localHeaderOffset === UINT32_MAX;
  if (!needs) return { uncompressedSize, compressedSize, localHeaderOffset };

  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const dataStart = offset + 4;
    if (dataStart + size > extra.length) break;
    if (id === 0x0001) {
      let cursor = dataStart;
      const end = dataStart + size;
      if (uncompressedSize === UINT32_MAX) {
        if (cursor + 8 > end) throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 extra 缺少解压大小');
        uncompressedSize = readUint64(view, cursor, 'ZIP64 解压大小');
        cursor += 8;
      }
      if (compressedSize === UINT32_MAX) {
        if (cursor + 8 > end) throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 extra 缺少压缩大小');
        compressedSize = readUint64(view, cursor, 'ZIP64 压缩大小');
        cursor += 8;
      }
      if (localHeaderOffset === UINT32_MAX) {
        if (cursor + 8 > end) throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 extra 缺少局部头偏移');
        localHeaderOffset = readUint64(view, cursor, 'ZIP64 局部头偏移');
      }
      return { uncompressedSize, compressedSize, localHeaderOffset };
    }
    offset = dataStart + size;
  }
  throw new OFDError('OFD_INVALID_PACKAGE', 'ZIP64 条目缺少 0x0001 extra 字段');
}

/**
 * 读取 64 位无符号整数；超过安全整数范围时拒绝。
 *
 * @param view DataView。
 * @param offset 偏移，byte。
 * @param what 诊断名称。
 * @returns 数值。
 */
function readUint64(view: DataView, offset: number, what: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OFDError('OFD_LIMIT_EXCEEDED', `${what} 超出安全整数范围`);
  }
  return Number(value);
}

/**
 * 解码 ZIP 条目名。
 *
 * flag bit 11 表示 UTF-8；未置位时先尝试严格 UTF-8，再尝试 GBK，最后 latin1。
 *
 * @param bytes 原始文件名字节。
 * @param flags 通用标志位。
 * @returns 文件名字符串。
 */
function decodeEntryName(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x0800) !== 0) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
}

/**
 * 解压 raw deflate；优先 DecompressionStream，回退 fflate。
 *
 * @param compressed 压缩数据。
 * @param maxBytes 解压上限，byte；undefined 表示不限制。
 * @param name 条目名，用于错误信息。
 * @returns 解压后的数据。
 */
async function inflateRaw(
  compressed: Uint8Array,
  maxBytes: number | undefined,
  name: string,
): Promise<Uint8Array> {
  const streamConstructor = (
    globalThis as unknown as {
      DecompressionStream?: new (format: string) => {
        readable: {
          getReader(): {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(reason?: unknown): Promise<void>;
          };
        };
        writable: {
          getWriter(): {
            write(chunk: Uint8Array): Promise<void>;
            close(): Promise<void>;
          };
        };
      };
    }
  ).DecompressionStream;

  if (streamConstructor) {
    try {
      const stream = new streamConstructor('deflate-raw');
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      // 写端与读端必须并发：大条目写入超过可读队列高水位时会等待背压，
      // 若先 await write 再读会死锁。
      const readPromise = (async (): Promise<Uint8Array> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (maxBytes !== undefined && total > maxBytes) {
            await reader.cancel();
            throw new OFDError(
              'OFD_LIMIT_EXCEEDED',
              `条目 ${name} 解压输出超过限制 ${maxBytes}`,
            );
          }
          chunks.push(value);
        }
        return concatChunks(chunks, total);
      })();

      const writePromise = (async (): Promise<void> => {
        await writer.write(compressed);
        await writer.close();
      })();
      // 写端失败时主动取消读端，避免读循环永久等待。
      writePromise.catch(() => {
        void reader.cancel().catch(() => undefined);
      });

      const output = await readPromise;
      await writePromise;
      return output;
    } catch (error) {
      if (error instanceof OFDError) throw error;
      // 某些运行时存在 DecompressionStream 但不支持 'deflate-raw'；仅此时回退。
      if (!(error instanceof TypeError)) {
        throw new OFDError('OFD_INVALID_PACKAGE', `条目 ${name} deflate 解压失败`, { cause: error });
      }
    }
  }

  try {
    const { Inflate } = await import('fflate');
    const chunks: Uint8Array[] = [];
    let total = 0;
    // 流式解压并在回调中计数，避免恶意中央目录声明导致一次性分配过大。
    const inflater = new Inflate((chunk) => {
      total += chunk.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        throw new OFDError('OFD_LIMIT_EXCEEDED', `条目 ${name} 解压输出超过限制 ${maxBytes}`);
      }
      chunks.push(chunk);
    });
    inflater.push(compressed, true);
    return concatChunks(chunks, total);
  } catch (error) {
    if (error instanceof OFDError) throw error;
    throw new OFDError('OFD_INVALID_PACKAGE', `条目 ${name} deflate 解压失败`, { cause: error });
  }
}

/**
 * 拼接解压分块。
 *
 * @param chunks 分块。
 * @param total 总长度，byte。
 * @returns 连续字节。
 */
function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.byteLength === total) return chunks[0]!;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** CRC32 查表（多项式 0xEDB88320）。 */
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
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ (data[index] as number)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 无符号 32 位整数转 8 位十六进制。
 *
 * @param value 数值。
 * @returns 十六进制字符串。
 */
function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}