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

/** 基于 `fs.FileHandle` 的只读随机访问字节源。 */
export class NodeFileByteSource implements ByteSource {
  /** 文件总字节数，byte。 */
  readonly size: number;

  readonly #handle: FileHandle;
  #closed = false;

  private constructor(handle: FileHandle, size: number) {
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
    const { bytesRead } = await this.#handle.read(buffer, 0, readable, offset);
    return buffer.subarray(0, bytesRead);
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
