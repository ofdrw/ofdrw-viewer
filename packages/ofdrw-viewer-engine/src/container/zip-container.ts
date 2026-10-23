/**
 * 默认 ZIP 容器（raw package container，对应设计方案 2.3）。
 *
 * 包装现有 `ByteSource` + `ZipReader`，复用 ZIP 解析、资源限制、CRC 校验与
 * warning 语义。`read()` 返回 ZIP 解压后的包内条目字节：明文包
 * （`encrypted=false`）即明文，可直接注入 `OFDDocument`；含 `Encryptions.xml`
 * 的加密包（`encrypted=true`）返回存仓密文，只能用于检查/解密，不得注入 engine。
 * 容器拥有 `ByteSource`，`close()` 同时关闭 ZIP 读取器与字节源。
 */

import type { ByteSource } from '../platform/byte-source';
import type {
  VirtualContainer,
  VirtualFileMeta,
  VirtualReadOptions,
} from '../platform/virtual-container';
import { OFDError } from '../errors';
import { ZipReader } from './zip-reader';
import type { ZipEntryMeta, ZipLimits } from './zip-reader';

/**
 * 关闭字节源（若实现提供 close），关闭失败不抛出。
 *
 * @param source 字节源。
 */
async function closeByteSource(source: ByteSource): Promise<void> {
  const close = (source as ByteSource & { close?: () => Promise<void> | void }).close;
  if (typeof close !== 'function') return;
  try {
    await close.call(source);
  } catch {
    // 关闭失败不影响容器关闭结论。
  }
}

/**
 * 把 ZIP 中央目录元数据映射为虚拟文件元数据。
 *
 * @param entry ZIP 条目元数据。
 * @returns 虚拟文件元数据；大小单位 byte。
 */
function toFileMeta(entry: ZipEntryMeta): VirtualFileMeta {
  return {
    path: entry.name,
    size: entry.uncompressedSize,
    compressedSize: entry.compressedSize,
    compression: entry.method === 0 ? 'stored' : 'deflate',
    origin: 'package',
  };
}

/**
 * 按包内路径升序比较（UTF-16 代码单元，结果确定）。
 *
 * @param left 左侧路径。
 * @param right 右侧路径。
 * @returns 负数/0/正数。
 */
function comparePath(left: VirtualFileMeta, right: VirtualFileMeta): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/**
 * 默认 ZIP raw package container。
 *
 * `encrypted` 表示包内存在未解密的 `Encryptions.xml`；此时 `read()` 返回存仓
 * 密文，解密由 crypto 层完成。`encrypted=false` 的明文包可直接注入 engine。
 * ZIP 级条目加密在 `ZipReader.open` 阶段直接抛 `OFD_ENCRYPTED`。
 */
export class ZipVirtualContainer implements VirtualContainer {
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
  /** 包内是否存在 OFD 加密元数据。 */
  readonly encrypted: boolean;

  private closed = false;

  /**
   * 仅由 {@link ZipVirtualContainer.open} 使用。
   *
   * @param source 字节源；成功后归容器所有。
   * @param zip 已打开的 ZIP 读取器。
   */
  private constructor(
    private readonly source: ByteSource,
    private readonly zip: ZipReader,
  ) {
    this.packageSize = source.size;
    this.encrypted = zip.hasEntry('Encryptions.xml');
  }

  /**
   * 打开 ZIP 容器。
   *
   * 成功后 `source` 归容器所有；失败时容器未建立，`source` 仍归调用方。
   *
   * @param source 随机可读字节源。
   * @param limits ZIP 限制覆盖；未提供字段使用默认值。
   * @returns ZIP 容器。
   */
  static async open(source: ByteSource, limits?: Partial<ZipLimits>): Promise<ZipVirtualContainer> {
    const zip = await ZipReader.open(source, limits);
    return new ZipVirtualContainer(source, zip);
  }

  /**
   * 列出全部文件条目（不含目录），按 path 升序。
   *
   * @returns 文件元数据。
   * @throws OFDError 容器已关闭时。
   */
  list(): readonly VirtualFileMeta[] {
    this.assertOpen();
    return this.zip.listEntries().map(toFileMeta).sort(comparePath);
  }

  /**
   * 判断路径是否存在；非法/已关闭时返回 false。
   *
   * @param path 包内路径。
   * @returns 是否存在。
   */
  has(path: string): boolean {
    if (this.closed) return false;
    return this.zip.hasEntry(path);
  }

  /**
   * 读取元数据；非法/不存在/已关闭时返回 undefined。
   *
   * @param path 包内路径。
   * @returns 文件元数据或 undefined。
   */
  stat(path: string): VirtualFileMeta | undefined {
    if (this.closed) return undefined;
    const entry = this.zip.getEntry(path);
    return entry ? toFileMeta(entry) : undefined;
  }

  /**
   * 读取 ZIP 解压后的条目字节。
   *
   * 明文包（`encrypted=false`）返回明文；加密包（`encrypted=true`）返回存仓
   * 密文，需由 crypto 层解密后使用。
   *
   * @param path 包内路径。
   * @param options 读取选项；maxBytes 单位为 byte。
   * @returns 条目字节；明文包为明文，raw 包可能为密文；归调用方所有。
   * @throws OFDError 条目缺失/超限/已关闭/取消/CRC 之外的读取错误时。
   */
  async read(path: string, options: VirtualReadOptions = {}): Promise<Uint8Array> {
    this.assertOpen();
    if (options.signal?.aborted) throw new OFDError('OFD_ABORTED', '容器读取已取消');
    const bytes = await this.zip.readEntry(path, {
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(options.onWarning !== undefined ? { onWarning: options.onWarning } : {}),
      ...(options.verifyChecksum !== undefined ? { verifyCrc: options.verifyChecksum } : {}),
    });
    if (options.signal?.aborted) throw new OFDError('OFD_ABORTED', '容器读取已取消');
    return bytes;
  }

  /**
   * 幂等关闭容器并释放字节源；重复调用不抛错。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.zip.close();
    } finally {
      await closeByteSource(this.source);
    }
  }

  /**
   * 断言容器仍可用。
   *
   * @throws OFDError code=OFD_CLOSED。
   */
  private assertOpen(): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '虚拟容器已关闭');
  }
}