/**
 * 内存明文容器（crypto → engine）。
 *
 * 解密结果全部驻留内存；`read()` 返回独立副本，避免 engine 修改缓存。
 * `encrypted=false` 且 `packageSize` 保留原始加密包字节数。
 */

import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import type {
  VirtualContainer,
  VirtualFileMeta,
  VirtualReadOptions,
} from '@ofdrw/ofdrw-viewer-engine';
import { copyBytes } from '../util/bytes';
import { normalizeVirtualPath } from './paths';

/** 容器条目的来源标记。 */
export type MemoryEntryOrigin = 'package' | 'decrypted';

/** 内存条目。 */
interface MemoryEntry {
  /** 明文字节。 */
  readonly bytes: Uint8Array;
  /** 文件来源。 */
  readonly origin: MemoryEntryOrigin;
}

/**
 * 把条目按路径升序比较。
 *
 * @param left 左侧路径。
 * @param right 右侧路径。
 * @returns 负数/0/正数。
 */
function comparePath(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 由内存条目构造的只读明文 VirtualContainer。
 */
export class MemoryVirtualContainer implements VirtualContainer {
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
  /** 解密容器始终为 false。 */
  readonly encrypted = false;

  private closed = false;
  private readonly entries = new Map<string, MemoryEntry>();

  /**
   * 创建容器。
   *
   * @param entries 条目表；key 为规范化包内路径，value 为明文与来源。
   * @param packageSize 原始包字节数，单位 byte；必须为非负安全整数。
   * @throws OFDError 路径重复/非法或 packageSize 非法时。
   */
  constructor(
    entries: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly origin?: MemoryEntryOrigin }>,
    packageSize: number,
  ) {
    if (!Number.isSafeInteger(packageSize) || packageSize < 0) {
      throw new OFDError('OFD_INVALID_PACKAGE', '明文容器 packageSize 必须是非负安全整数');
    }
    this.packageSize = packageSize;
    for (const [path, entry] of entries) {
      const normalized = normalizeVirtualPath(path);
      if (normalized.length === 0) {
        throw new OFDError('OFD_INVALID_PACKAGE', '明文容器不允许根路径条目');
      }
      if (this.entries.has(normalized)) {
        throw new OFDError('OFD_INVALID_PACKAGE', `明文容器路径重复：${normalized}`);
      }
      // 构造时复制一次，隔离调用方对输入字节的后续修改。
      this.entries.set(normalized, {
        bytes: copyBytes(entry.bytes),
        origin: entry.origin ?? 'decrypted',
      });
    }
  }

  /**
   * 列出全部文件元数据。
   *
   * @returns 按 path 升序的元数据。
   * @throws OFDError `OFD_CLOSED`：容器已关闭。
   */
  list(): readonly VirtualFileMeta[] {
    this.assertOpen();
    return [...this.entries.entries()]
      .sort(([left], [right]) => comparePath(left, right))
      .map(([path, entry]) => ({
        path,
        size: entry.bytes.length,
        origin: entry.origin,
      }));
  }

  /**
   * 判断路径是否存在。
   *
   * @param path 包内路径。
   * @returns 存在返回 true；非法/已关闭返回 false。
   */
  has(path: string): boolean {
    if (this.closed) return false;
    try {
      return this.entries.has(normalizeVirtualPath(path));
    } catch {
      return false;
    }
  }

  /**
   * 读取元数据。
   *
   * @param path 包内路径。
   * @returns 元数据；不存在/非法/已关闭返回 undefined。
   */
  stat(path: string): VirtualFileMeta | undefined {
    if (this.closed) return undefined;
    let normalized: string;
    try {
      normalized = normalizeVirtualPath(path);
    } catch {
      return undefined;
    }
    const entry = this.entries.get(normalized);
    if (!entry) return undefined;
    return { path: normalized, size: entry.bytes.length, origin: entry.origin };
  }

  /**
   * 读取明文条目。
   *
   * @param path 包内路径。
   * @param options 读取选项。
   * @returns 明文字节副本。
   * @throws OFDError 已关闭、路径非法/缺失、超限或取消时。
   */
  async read(path: string, options?: VirtualReadOptions): Promise<Uint8Array> {
    this.assertOpen();
    if (options?.signal?.aborted) {
      throw new OFDError('OFD_ABORTED', '读取已取消');
    }
    let normalized: string;
    try {
      normalized = normalizeVirtualPath(path);
    } catch (error) {
      throw error instanceof OFDError
        ? error
        : new OFDError('OFD_INVALID_PACKAGE', '包内路径非法');
    }
    const entry = this.entries.get(normalized);
    if (!entry) {
      throw new OFDError('OFD_ENTRY_NOT_FOUND', `包内条目不存在：${normalized}`);
    }
    if (options?.maxBytes !== undefined && entry.bytes.length > options.maxBytes) {
      throw new OFDError(
        'OFD_LIMIT_EXCEEDED',
        `条目 ${normalized} 大小 ${entry.bytes.length} byte 超过上限 ${options.maxBytes} byte`,
      );
    }
    return copyBytes(entry.bytes);
  }

  /**
   * 幂等关闭；释放条目引用。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.entries.clear();
  }

  /**
   * 断言容器未关闭。
   *
   * @throws OFDError `OFD_CLOSED`。
   */
  private assertOpen(): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '明文容器已关闭');
  }
}
