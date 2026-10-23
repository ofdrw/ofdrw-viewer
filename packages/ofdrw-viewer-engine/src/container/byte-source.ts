/**
 * 内置 ByteSource 适配器。
 *
 * 所有适配器都只暴露异步随机读取；不预读整包，不依赖 DOM（Blob/HTTP 适配器
 * 只在宿主环境实际提供对应全局对象时使用）。
 *
 * HTTP Range 说明：
 * - 服务器应返回 `206 Partial Content` 与 `Content-Range`；
 * - 跨域时需要服务端暴露 `Content-Range`（`Access-Control-Expose-Headers`）；
 * - 服务器忽略 Range 返回 `200` 时，按 `allowFullDownload` 决定是否整包缓存。
 */

import type { ByteSource } from '../platform/byte-source';
import { notImplemented } from '../common/not-implemented';
import { OFDError } from '../errors';

/** 最小 HTTP 响应接口；便于宿主注入 fetch 与测试 mock。 */
export interface FetchResponseLike {
  /** HTTP 状态码。 */
  readonly status: number;
  /** 是否 2xx。 */
  readonly ok: boolean;
  /** 响应头读取。 */
  readonly headers: { get(name: string): string | null };
  /** 读取完整响应体。 */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** 最小 fetch 函数接口。 */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

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

/** HTTP Range 字节源选项。 */
export interface HttpRangeSourceOptions {
  /** 额外请求头（例如鉴权）。 */
  headers?: Record<string, string>;
  /** 是否允许服务器不支持 Range 时整包缓存，默认 true。 */
  allowFullDownload?: boolean;
  /** 自定义 fetch（测试/宿主注入）；缺省使用全局 fetch。 */
  fetch?: FetchLike;
}

/**
 * 基于 HTTP Range 的字节源；服务器不支持 Range 时回退为整包缓存。
 *
 * 构造时立即开始 HEAD/Range 探测。使用 `ZipReader.open` 时会自动等待
 * `ready()`；若直接使用，请先 `await source.ready()` 再读取 `size`。
 */
export class HttpRangeSource implements ByteSource {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly allowFullDownload: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly initPromise: Promise<void>;
  private initError: unknown;
  private memory: Uint8Array | null = null;
  private sizeValue = 0;

  /**
   * @param url 文档 URL。
   * @param options 请求选项。
   */
  constructor(url: string, options: HttpRangeSourceOptions = {}) {
    this.url = url;
    this.headers = { ...(options.headers ?? {}) };
    this.allowFullDownload = options.allowFullDownload ?? true;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    // 浏览器原生 fetch 必须绑定 globalThis；直接保存后在实例上以方法调用会触发
    // Illegal invocation。注入的 fetch 优先且保持原样，便于测试/宿主自定义。
    const fetchImpl =
      options.fetch ??
      (globalFetch
        ? (input: string, init?: { method?: string; headers?: Record<string, string> }) =>
            globalFetch.call(globalThis, input, init)
        : undefined);
    if (!fetchImpl) {
      throw new OFDError('OFD_INVALID_PACKAGE', '当前环境没有 fetch，无法使用 HttpRangeSource');
    }
    this.fetchImpl = fetchImpl;
    this.initPromise = this.probe().then(
      () => undefined,
      (error: unknown) => {
        this.initError = error;
      },
    );
  }

  /** 总字节数，单位 byte；探测完成前为 0。 */
  get size(): number {
    return this.sizeValue;
  }

  /**
   * 等待探测完成。
   *
   * @returns 探测完成。
   * @throws 探测失败时的错误。
   */
  async ready(): Promise<void> {
    await this.initPromise;
    if (this.initError !== undefined) throw this.initError;
  }

  /**
   * 创建并等待探测完成的字节源。
   *
   * @param url 文档 URL。
   * @param options 请求选项。
   * @returns 已就绪的字节源。
   */
  static async open(url: string, options: HttpRangeSourceOptions = {}): Promise<HttpRangeSource> {
    const source = new HttpRangeSource(url, options);
    await source.ready();
    return source;
  }

  /**
   * 读取字节区间；越界部分截断。
   *
   * @param offset 起始偏移，byte。
   * @param length 长度，byte。
   * @returns 读取结果。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    await this.ready();
    const start = Math.max(0, Math.floor(offset));
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0 || start >= this.sizeValue) {
      return new Uint8Array(0);
    }
    const wantedEnd = Math.min(this.sizeValue, start + Math.floor(length));
    if (this.memory) return this.memory.slice(start, wantedEnd);

    const response = await this.fetchImpl(this.url, {
      method: 'GET',
      headers: { ...this.headers, Range: `bytes=${start}-${wantedEnd - 1}` },
    });
    if (response.status === 206) {
      // 服务器对实体启用 gzip/br 等传输编码时，Range 会切在编码后的字节流上，
      // 浏览器解压出的片段与请求偏移不对应（甚至解码失败），长度也不再可信；
      // 此时放弃区间读取，改用整包下载后按偏移切片。
      if (hasContentEncoding(response.headers) || this.hasRangeTotalMismatch(response.headers)) {
        const whole = await this.downloadWhole();
        return whole.slice(start, wantedEnd);
      }
      this.assertContentRangeStart(response.headers.get('content-range'), start);
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > wantedEnd - start) return body.slice(0, wantedEnd - start);
      return body;
    }
    if (response.status === 200) {
      // 服务器忽略 Range：缓存整包，后续读取走内存。
      if (!this.allowFullDownload) {
        throw new OFDError('OFD_INVALID_PACKAGE', '服务器不支持 HTTP Range，且已禁用整包回退');
      }
      const body = new Uint8Array(await response.arrayBuffer());
      this.memory = body;
      this.sizeValue = body.byteLength;
      return body.slice(start, Math.min(body.byteLength, wantedEnd));
    }
    if (response.status === 416) {
      // 起点越界时返回空；真实文件长度以已探测的 size 为准。
      return new Uint8Array(0);
    }
    throw new OFDError('OFD_INVALID_PACKAGE', `HTTP Range 读取失败：status=${response.status}`);
  }

  /**
   * 探测文件大小与 Range 支持情况。
   */
  private async probe(): Promise<void> {
    let head: FetchResponseLike | null = null;
    try {
      head = await this.fetchImpl(this.url, { method: 'HEAD', headers: this.headers });
    } catch {
      // 部分服务器不支持 HEAD；继续用 Range GET 探测。
    }

    if (head?.ok) {
      const contentLength = parseContentLength(head.headers.get('content-length'));
      if (hasContentEncoding(head.headers)) {
        // GitHub Pages 等 CDN 会对文档启用 gzip 传输编码：Content-Length 是编码后长度，
        // 且 Range 会切在编码后的字节流上，浏览器解压出的数据与偏移不对应。
        // 此时整包下载（由浏览器透明解压）并改用真实字节长度。
        await this.downloadWhole();
        return;
      }
      if (contentLength !== undefined) {
        this.sizeValue = contentLength;
        return;
      }
    }

    const response = await this.fetchImpl(this.url, {
      method: 'GET',
      headers: { ...this.headers, Range: 'bytes=0-0' },
    });
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (hasContentEncoding(response.headers)) {
        await this.downloadWhole();
        return;
      }
      if (!range || range.total === undefined) {
        // 极少数服务器只给 `bytes 0-0/*`；此时用 HEAD 的 Content-Length 兜底。
        const fallback = head?.ok ? parseContentLength(head.headers.get('content-length')) : undefined;
        if (fallback === undefined) {
          throw new OFDError('OFD_INVALID_PACKAGE', 'HTTP Range 响应缺少 Content-Range 总长度');
        }
        this.sizeValue = fallback;
      } else {
        this.sizeValue = range.total;
      }
      return;
    }
    if (response.status === 200) {
      if (!this.allowFullDownload) {
        throw new OFDError('OFD_INVALID_PACKAGE', '服务器不支持 HTTP Range，且已禁用整包回退');
      }
      const body = new Uint8Array(await response.arrayBuffer());
      this.memory = body;
      this.sizeValue = body.byteLength;
      return;
    }
    if (response.status === 416) {
      this.sizeValue = 0;
      return;
    }
    throw new OFDError('OFD_INVALID_PACKAGE', `HTTP 探测失败：status=${response.status}`);
  }

  /**
   * 判断 206 响应的 Content-Range 总长度是否与已探测大小不一致。
   *
   * @param headers 响应头。
   * @returns 不一致时为 true。
   */
  private hasRangeTotalMismatch(headers: { get(name: string): string | null }): boolean {
    if (this.sizeValue <= 0) return false;
    const range = parseContentRange(headers.get('content-range'));
    return range !== null && range.total !== undefined && range.total !== this.sizeValue;
  }

  /**
   * 整包下载并缓存到内存；浏览器会自动解压传输编码，因此长度按解压后字节计算。
   *
   * @returns 解压后的完整字节。
   * @throws OFDError 禁用整包回退或 HTTP 状态异常时。
   */
  private async downloadWhole(): Promise<Uint8Array> {
    if (this.memory) return this.memory;
    if (!this.allowFullDownload) {
      throw new OFDError(
        'OFD_INVALID_PACKAGE',
        '服务器对响应体启用了内容编码，无法按 Range 读取，且已禁用整包回退',
      );
    }
    const response = await this.fetchImpl(this.url, { headers: this.headers });
    if (!response.ok) {
      throw new OFDError('OFD_INVALID_PACKAGE', `文档整包下载失败：status=${response.status}`);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    this.memory = body;
    this.sizeValue = body.byteLength;
    return body;
  }

  /**
   * 校验 206 响应的起始位置，避免服务器返回错误区间导致数据错位。
   *
   * @param header Content-Range 头。
   * @param expectedStart 期望起点，byte。
   */
  private assertContentRangeStart(header: string | null, expectedStart: number): void {
    const range = parseContentRange(header);
    if (range && range.start !== expectedStart) {
      throw new OFDError(
        'OFD_INVALID_PACKAGE',
        `HTTP Content-Range 起点不符：期望 ${expectedStart}，实际 ${range.start}`,
      );
    }
  }
}

/** 基于 Node `fs.promises.read` 的字节源；本轮 Web 优先，不实现 Node 端适配。 */
export class NodeFileSource implements ByteSource {
  readonly size: number;

  /**
   * @param path 本地文件路径。
   */
  constructor(private readonly path: string) {
    void this.path;
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
  constructor(private readonly filePath: string) {
    void this.filePath;
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

/**
 * 解析 Content-Length；缺失/非法时返回 undefined。
 *
 * @param header 响应头值。
 * @returns 字节数或 undefined。
 */
function parseContentLength(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = Number(header.trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 判断响应是否对实体做了内容编码（gzip/br 等）。
 *
 * 浏览器会自动解压 GET 响应体，但 HEAD 的 Content-Length 与 206 的 Range
 * 都基于编码后的实体计算，按偏移读取会得到错误字节。
 *
 * @param headers 响应头。
 * @returns 存在非 identity 的 Content-Encoding 时为 true。
 */
function hasContentEncoding(headers: { get(name: string): string | null }): boolean {
  const encoding = headers.get('content-encoding');
  if (encoding === null) return false;
  const normalized = encoding.trim().toLowerCase();
  return normalized !== '' && normalized !== 'identity';
}

/** Content-Range 解析结果；`total` 为 undefined 表示 `*`。 */
interface ParsedContentRange {
  start: number;
  end: number;
  total?: number;
}

/**
 * 解析 `Content-Range: bytes start-end/total`。
 *
 * @param header 响应头值。
 * @returns 解析结果；格式不符时返回 null。
 */
function parseContentRange(header: string | null): ParsedContentRange | null {
  if (header === null) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalText = match[3];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const result: ParsedContentRange = { start, end };
  if (totalText !== '*' && totalText !== undefined) {
    const total = Number(totalText);
    if (Number.isFinite(total) && total >= 0) result.total = total;
  }
  return result;
}