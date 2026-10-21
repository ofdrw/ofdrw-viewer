/**
 * 按需 ZIP 读取器（实现由 T2/dev-foundation 完成）。
 *
 * 打开时只读 EOCD/中央目录，条目内容按需解压；不整包解压。
 */

import type { ByteSource } from '../platform/byte-source';
import { notImplemented } from '../common/not-implemented';

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

/** 读取条目选项。 */
export interface ReadEntryOptions {
  /** 解压后大小上限，byte；缺省使用打开时的限制。 */
  maxBytes?: number;
  /** 是否校验 CRC32，默认 true。 */
  verifyCrc?: boolean;
}

/**
 * ZIP 随机读取器。
 *
 * 构造后中央目录常驻；`readEntry` 才读取局部头并解压。加密条目、非 0/8 压缩方法、
 * 路径穿越与超限条目必须拒绝。
 */
export class ZipReader {
  private constructor(
    private readonly source: ByteSource,
    private readonly entries: ReadonlyMap<string, ZipEntryMeta>,
  ) {
    void this.source;
    void this.entries;
  }

  /**
   * 打开 ZIP 并解析 EOCD/中央目录。
   *
   * @param source 随机可读字节源。
   * @param limits 可覆盖的限制。
   * @returns ZIP 读取器。
   */
  static async open(source: ByteSource, limits?: Partial<ZipLimits>): Promise<ZipReader> {
    void source;
    void limits;
    return notImplemented('ZipReader.open');
  }

  /** 全部中央目录条目，按 ZIP 中出现顺序。 */
  listEntries(): readonly ZipEntryMeta[] {
    return notImplemented('ZipReader.listEntries');
  }

  /**
   * 查找条目元数据。
   *
   * @param path 包内路径。
   * @returns 元数据或 undefined。
   */
  getEntry(path: string): ZipEntryMeta | undefined {
    void path;
    return notImplemented('ZipReader.getEntry');
  }

  /**
   * 判断条目是否存在。
   *
   * @param path 包内路径。
   * @returns 是否存在。
   */
  hasEntry(path: string): boolean {
    void path;
    return notImplemented('ZipReader.hasEntry');
  }

  /**
   * 读取并解压条目。
   *
   * @param path 包内路径。
   * @param options 读取选项。
   * @returns 解压后的字节。
   */
  async readEntry(path: string, options?: ReadEntryOptions): Promise<Uint8Array> {
    void path;
    void options;
    return notImplemented('ZipReader.readEntry');
  }

  /** 关闭读取器并释放中央目录缓存；不关闭底层 ByteSource。 */
  close(): void {
    return notImplemented('ZipReader.close');
  }
}