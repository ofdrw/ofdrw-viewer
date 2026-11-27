/**
 * 基于 `fs.FileHandle` 的只读随机访问字节源。
 *
 * engine 与 crypto 只依赖 `ByteSource` 接口，服务器层用它按需读取已落盘的
 * OFD，不把整包读入内存。文档关闭（或被 engine 关闭）时释放文件句柄。
 */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';

/** 带错误码的普通错误；具体语义由服务器层 errors 模块映射。 */
export type CodedError<E extends string = string> = Error & { readonly code: E };

/**
 * 构造带 `code` 属性的错误。
 *
 * @param code 稳定错误码
 * @param message 面向用户的中文说明
 * @returns 可直接 `throw` 的错误对象
 */
export function codedError<E extends string = string>(code: E, message: string): CodedError<E> {
  return Object.assign(new Error(message), { code });
}

/** 随机读取句柄的最小接口；`fs.FileHandle` 满足该接口。 */
export interface FileReadHandle {
  /**
   * 读取指定位置。
   *
   * @param buffer 目标缓冲
   * @param offset buffer 内写入偏移，单位 byte
   * @param length 期望读取长度，单位 byte
   * @param position 文件内读取位置，单位 byte
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

/**
 * 判断是否为带字符串 `code` 的错误。
 *
 * @param error 任意错误值
 * @returns 含字符串 `code` 字段时为 true
 */
export function isErrnoError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/** 基于 `fs.FileHandle` 的只读随机访问字节源。 */
export class NodeFileByteSource implements ByteSource {
  /** 文件总字节数，单位 byte。 */
  readonly size: number;

  readonly #handle: FileReadHandle;
  #closed = false;

  /**
   * 从已打开的读取句柄构造；通常应使用 `NodeFileByteSource.open()`。
   *
   * @param handle 读取句柄，`fs.FileHandle` 或测试替身
   * @param size 文件总字节数，单位 byte
   */
  constructor(handle: FileReadHandle, size: number) {
    this.#handle = handle;
    this.size = size;
  }

  /**
   * 打开本地文件并读取大小。
   *
   * @param filePath 文件路径
   * @returns 字节源；调用方负责关闭
   * @throws 带 `CLI_INPUT_NOT_FOUND`/`CLI_INPUT_NOT_FILE`/`CLI_INPUT_UNREADABLE` 码的错误
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
        throw codedError('CLI_INPUT_NOT_FILE', `输入路径不是文件：${filePath}`);
      }
      return new NodeFileByteSource(handle, info.size);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw toPathError(filePath, error);
    }
  }

  /**
   * 读取指定区间；越界部分截断。
   *
   * @param offset 起始偏移，单位 byte
   * @param length 期望读取长度，单位 byte
   * @returns 实际读到的字节
   * @throws OFDError `OFD_CLOSED`：字节源已关闭
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
    // FileHandle.read 允许短读，循环到请求长度或 EOF。
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

  /**
   * 关闭文件句柄；重复调用安全。
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

/**
 * 把文件打开错误映射为带 CLI 码的错误。
 *
 * @param filePath 文件路径
 * @param error 原始错误
 * @returns 映射后的错误
 */
function toPathError(filePath: string, error: unknown): CodedError {
  if (typeof (error as { code?: unknown } | null)?.code === 'string' && !isErrnoError(error, 'ENOENT')) {
    const candidate = error as CodedError;
    if (candidate.code.startsWith('CLI_')) return candidate;
  }
  if (isErrnoError(error, 'ENOENT') || isErrnoError(error, 'ENOTDIR')) {
    return codedError('CLI_INPUT_NOT_FOUND', `输入文件不存在：${filePath}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return codedError('CLI_INPUT_UNREADABLE', `无法读取输入文件：${filePath}（${detail}）`);
}