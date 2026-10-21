/**
 * 内置 ByteSource 适配器（实现由 T2/dev-foundation 完成）。
 *
 * 所有适配器都只暴露异步随机读取；不预读整包，不依赖 DOM（Blob/HTTP 适配器
 * 只在宿主环境实际提供对应全局对象时使用）。
 */

import type { ByteSource } from '../platform/byte-source';
import { notImplemented } from '../common/not-implemented';

/** 基于内存 ArrayBuffer 的字节源；适用于小文件与测试。 */
export class ArrayBufferSource implements ByteSource {
  readonly size: number;

  /**
   * @param data 完整文件字节。
   */
  constructor(data: ArrayBuffer | Uint8Array) {
    this.size = data.byteLength;
  }

  /**
   * 读取字节区间。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    void offset;
    void length;
    return notImplemented('ArrayBufferSource.read');
  }
}

/** 基于 Blob/File 的字节源；适用于浏览器文件选择与拖拽。 */
export class BlobSource implements ByteSource {
  readonly size: number;

  /**
   * @param blob 浏览器 Blob/File。
   */
  constructor(blob: Blob) {
    this.size = blob.size;
  }

  /**
   * 读取字节区间。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    void offset;
    void length;
    return notImplemented('BlobSource.read');
  }
}

/** HTTP Range 字节源选项。 */
export interface HttpRangeSourceOptions {
  /** 额外请求头（例如鉴权）。 */
  headers?: Record<string, string>;
  /** 是否允许服务器不支持 Range 时整包缓存，默认 true。 */
  allowFullDownload?: boolean;
}

/** 基于 HTTP Range 的字节源；服务器不支持 Range 时回退为整包 ArrayBufferSource。 */
export class HttpRangeSource implements ByteSource {
  readonly size: number;

  /**
   * @param url 文档 URL。
   * @param options 请求选项。
   */
  constructor(url: string, options: HttpRangeSourceOptions = {}) {
    void url;
    void options;
    this.size = 0;
  }

  /**
   * 读取字节区间。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    void offset;
    void length;
    return notImplemented('HttpRangeSource.read');
  }
}

/** 基于 Node `fs.promises.read` 的字节源；本轮不实现 Node 端适配。 */
export class NodeFileSource implements ByteSource {
  readonly size: number;

  /**
   * @param path 本地文件路径。
   */
  constructor(path: string) {
    void path;
    this.size = 0;
  }

  /**
   * 读取字节区间。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    void offset;
    void length;
    return notImplemented('NodeFileSource.read');
  }
}

/** 基于微信 `FileSystemManager.read` 的字节源；本轮不实现小程序适配。 */
export class WechatFileSource implements ByteSource {
  readonly size: number;

  /**
   * @param filePath 小程序文件路径。
   */
  constructor(filePath: string) {
    void filePath;
    this.size = 0;
  }

  /**
   * 读取字节区间。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    void offset;
    void length;
    return notImplemented('WechatFileSource.read');
  }
}