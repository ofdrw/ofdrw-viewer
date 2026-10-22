/**
 * Node 文件字节源。
 *
 * engine 的 `node-file` 来源在 Web 优先版本中尚未实现，错误信息明确允许宿主
 * 注入 `custom ByteSource`。本实现用 `fs.FileHandle` 做随机读，供 CLI 打开
 * 本地 OFD 文件；文档关闭时 engine 会调用 `close()` 释放文件句柄。
 */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { OFDError } from 'ofdrw-viewer-engine';
import type { ByteSource } from 'ofdrw-viewer-engine';
import { CliError, EXIT_CODES, isCliError, isErrnoError } from './errors.js';

/** 随机读取句柄的最小接口；`fs.FileHandle` 满足该接口。 */
export interface FileReadHandle {
  /**
   * 读取指定位置。
   *
   * @param buffer 目标缓冲
   * @param offset buffer 内写入偏移，byte
   * @param length 期望读取长度，byte
   * @param position 文件内读取位置，byte
   * @returns 实际读取字节数
   */
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;

  /** 关闭底层文件句柄。 */
  close(): Promise<void>;
}

/** 基于 `fs.FileHandle` 的只读随机访问字节源。 */
export class NodeFileByteSource implements ByteSource {
  /** 文件总字节数，byte。 */
  readonly size: number;

  readonly #handle: FileReadHandle;
  #closed = false;

  /**
   * 从已打开的读取句柄构造；通常应使用 `open()`。
   *
   * 公开构造器便于单测注入模拟短读的 `FileReadHandle`。
   *
   * @param handle 读取句柄，`fs.FileHandle` 或测试替身
   * @param size 文件总字节数，byte
   */
  constructor(handle: FileReadHandle, size: number) {
    this.#handle = handle;
    this.size = size;
  }

  /**
   * 打开本地文件并读取大小。
   *
   * @param filePath 文件路径
   * @returns 字节源；调用方负责在文档关闭时释放
   */
  static async open(filePath: string): Promise<NodeFileByteSource> {
    let handle: FileHandle;
    try {
      handle = await open(filePath, 'r');
    } catch (error) {
      throw toPathError(filePath, error);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new CliError(
          'CLI_INPUT_NOT_FILE',
          `输入路径不是文件：${filePath}`,
          EXIT_CODES.USAGE,
        );
      }
      return new NodeFileByteSource(handle, info.size);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw isCliError(error) ? error : toPathError(filePath, error);
    }
  }

  /**
   * 读取指定区间；越界部分截断。
   *
   * @param offset 起始偏移，byte
   * @param length 期望读取长度，byte
   * @returns 实际读到的字节
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.#closed) throw new OFDError('OFD_CLOSED', 'OFD 字节源已关闭');
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(`offset 非法：${offset}`);
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`length 非法：${length}`);
    }
    if (offset >= this.size || length === 0) return new Uint8Array(0);

    const readable = Math.min(length, this.size - offset);
    const buffer = new Uint8Array(readable);
    let filled = 0;
    // FileHandle.read 允许短读；必须循环到请求长度或 EOF，满足 ZipReader.readExact。
    while (filled < readable) {
      const { bytesRead } = await this.#handle.read(
        buffer,
        filled,
        readable - filled,
        offset + filled,
      );
      const next = Math.min(bytesRead, readable - filled);
      if (next <= 0) break;
      filled += next;
    }
    return buffer.subarray(0, filled);
  }

  /** 关闭文件句柄；重复调用安全。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

/** 把文件打开/读取错误映射为 CLI 路径错误（退出码 1）。 */
function toPathError(filePath: string, error: unknown): CliError {
  if (isCliError(error)) return error;
  if (isErrnoError(error, 'ENOENT') || isErrnoError(error, 'ENOTDIR')) {
    return new CliError(
      'CLI_INPUT_NOT_FOUND',
      `输入文件不存在：${filePath}`,
      EXIT_CODES.USAGE,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new CliError(
    'CLI_INPUT_UNREADABLE',
    `无法读取输入文件：${filePath}（${detail}）`,
    EXIT_CODES.USAGE,
  );
}
