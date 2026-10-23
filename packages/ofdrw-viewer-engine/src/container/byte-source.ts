/**
 * 内置 ByteSource 适配器。
 *
 * 所有适配器都只暴露异步随机读取；不预读整包，不依赖 DOM。engine 不内置
 * HTTP/文件读取：需要 Range、鉴权或进度控制时，由宿主实现 `ByteSource` 并通过
 * `{ kind: 'custom', source }` 传入。
 */

import type { ByteSource } from '../platform/byte-source';

/** 基于内存 ArrayBuffer 的字节源；适用于小文件与测试。 */
export class ArrayBufferSource implements ByteSource {
  readonly size: number;
  private readonly bytes: Uint8Array;

  /**
   * @param data 完整文件字节。
   */
  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
    }
    this.size = this.bytes.byteLength;
  }

  /**
   * 读取字节区间；越界部分截断。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.floor(offset));
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0 || start >= this.size) {
      return new Uint8Array(0);
    }
    const end = Math.min(this.size, start + Math.floor(length));
    return this.bytes.slice(start, end);
  }
}

/** 基于 Blob/File 的字节源；适用于浏览器文件选择与拖拽。 */
export class BlobSource implements ByteSource {
  readonly size: number;

  /**
   * @param blob 浏览器 Blob/File。
   */
  constructor(private readonly blob: Blob) {
    this.size = blob.size;
  }

  /**
   * 读取字节区间；越界部分截断。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.floor(offset));
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0 || start >= this.size) {
      return new Uint8Array(0);
    }
    const end = Math.min(this.size, start + Math.floor(length));
    const buffer = await this.blob.slice(start, end).arrayBuffer();
    return new Uint8Array(buffer);
  }
}