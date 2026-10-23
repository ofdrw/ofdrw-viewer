/**
 * 基于 HTTP Range 的字节源（网络获取委托：engine 不联网，由 UI 提供字节）。
 *
 * 该实现负责 URL → `ByteSource` 的适配：
 * - 先探测大小（HEAD；必要时 `Range: bytes=0-0`），探测结果缓存；
 * - 读取时按需发 Range 请求，不缓存整包；
 * - 服务器忽略 Range（200）、响应体启用内容编码（gzip/br）或总长不一致时，
 *   回退为整包下载并缓存；
 * - 所有请求共享取消信号，`close()` 中止进行中的请求且可重复调用。
 *
 * 跨域环境需要服务端允许 `Range` 并暴露 `Content-Range`
 * （`Access-Control-Expose-Headers: Content-Range`）。
 */

import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';

/** HTTP Range 字节源选项。 */
export interface HttpByteSourceOptions {
  /**
   * 额外请求头（例如鉴权）。
   *
   * 与阅读器 `requestInit.headers` 合并时由调用方完成，本类只使用传入值。
   */
  readonly headers?: Record<string, string>;
  /** 是否允许服务器忽略 Range 时整包回退；默认 `true`。 */
  readonly allowFullDownload?: boolean;
  /** 取消信号；与 `close()` 合并生效。 */
  readonly signal?: AbortSignal;
  /**
   * 整包读取进度回调。
   *
   * @param loaded 已读取字节数，单位 byte。
   * @param total 总字节数，单位 byte；无法确定时 undefined。
   */
  readonly onProgress?: (loaded: number, total: number | undefined) => void;
  /** 可注入 fetch，便于测试与宿主定制；缺省使用全局 fetch。 */
  readonly fetch?: typeof fetch;
}

/** 基于 HTTP Range 的随机读取字节源。 */
export class HttpByteSource implements ByteSource {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly allowFullDownload: boolean;
  private readonly onProgress: ((loaded: number, total: number | undefined) => void) | undefined;
  private readonly fetchImpl: typeof fetch | null;
  private readonly externalSignal: AbortSignal | undefined;
  /** 合并外部取消与 close 的请求信号。 */
  private readonly requestAbort = new AbortController();
  private readonly initPromise: Promise<void>;
  /** 外部 signal 转发器；close 时移除，避免泄漏监听。 */
  private readonly forwardExternalAbort = (): void => {
    this.requestAbort.abort();
  };

  private initError: unknown;
  private memory: Uint8Array | null = null;
  private sizeValue = 0;
  private closed = false;

  /**
   * @param url 文档 URL。
   * @param options 请求头、取消信号、进度与 fetch 注入。
   */
  constructor(url: string, options: HttpByteSourceOptions = {}) {
    this.url = url;
    this.headers = { ...(options.headers ?? {}) };
    this.allowFullDownload = options.allowFullDownload ?? true;
    this.onProgress = options.onProgress;
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    // 浏览器原生 fetch 必须绑定 globalThis；注入的 fetch 保持原样，便于测试/宿主定制。
    this.fetchImpl = options.fetch ?? (globalFetch ? globalFetch.bind(globalThis) : null);
    this.externalSignal = options.signal;
    if (options.signal) {
      if (options.signal.aborted) this.requestAbort.abort();
      else options.signal.addEventListener('abort', this.forwardExternalAbort, { once: true });
    }
    // 探测在构造时启动；`initPromise` 永不 reject，错误由 ready() 复现，避免未处理拒绝。
    this.initPromise = this.probe().catch((error: unknown) => {
      this.initError = error;
    });
  }

  /** 总字节数，单位 byte；探测完成前为 0。 */
  get size(): number {
    return this.sizeValue;
  }

  /**
   * 等待大小探测完成；重复调用不会重复请求。
   *
   * @returns 探测完成。
   * @throws {OFDError} 关闭后调用（`OFD_CLOSED`）或探测失败时。
   */
  async ready(): Promise<void> {
    this.assertNotClosed();
    await this.initPromise;
    this.assertNotClosed();
    if (this.initError !== undefined) throw this.initError;
  }

  /**
   * 读取 `[offset, offset + length)`；越界部分截断。
   *
   * @param offset 起始偏移，单位 byte。
   * @param length 读取长度，单位 byte。
   * @returns 读取到的字节；越界、关闭或 416 时返回空数组（关闭时抛错）。
   * @throws {OFDError} 关闭后读取（`OFD_CLOSED`）或 HTTP 失败（`OFD_INVALID_PACKAGE`）。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertNotClosed();
    await this.ready();
    this.assertNotClosed();
    const start = Math.max(0, Math.floor(offset));
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(length) ||
      length <= 0 ||
      start >= this.sizeValue
    ) {
      return new Uint8Array(0);
    }
    const wantedEnd = Math.min(this.sizeValue, start + Math.floor(length));
    if (this.memory) return this.memory.slice(start, wantedEnd);

    let response: Response;
    try {
      response = await this.request({
        method: 'GET',
        headers: { ...this.headers, Range: `bytes=${start}-${wantedEnd - 1}` },
      });
      if (response.status === 206) {
        // 服务器对实体启用 gzip/br 等传输编码时，Range 切在编码后的字节流上，
        // 浏览器解压出的片段与请求偏移不对应，长度也不可信；改为整包读取后切片。
        if (hasContentEncoding(response.headers) || this.hasRangeTotalMismatch(response.headers)) {
          const whole = await this.downloadWhole();
          return whole.slice(start, Math.min(whole.byteLength, start + Math.floor(length)));
        }
        this.assertContentRangeStart(response.headers.get('content-range'), start);
        const body = new Uint8Array(await response.arrayBuffer());
        this.assertNotClosed();
        const slice = body.byteLength > wantedEnd - start ? body.slice(0, wantedEnd - start) : body;
        this.reportProgress(slice.byteLength, undefined);
        return slice;
      }
      if (response.status === 200) {
        // 服务器忽略 Range：整包缓存，后续读取走内存。
        const whole = await this.acceptWhole(response);
        return whole.slice(start, Math.min(whole.byteLength, start + Math.floor(length)));
      }
      if (response.status === 416) {
        // 起点越界：真实长度以已探测的 size 为准，越界返回空。
        return new Uint8Array(0);
      }
      throw new OFDError(
        'OFD_INVALID_PACKAGE',
        `HTTP Range 读取失败：status=${response.status}`,
      );
    } catch (error) {
      this.rethrowIfAborted(error);
      throw error;
    }
  }

  /**
   * 释放资源并中止进行中的请求；可重复调用。
   *
   * @returns 关闭完成。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.externalSignal?.removeEventListener('abort', this.forwardExternalAbort);
    this.requestAbort.abort();
  }

  /** 触发一次请求；缺少 fetch 或已中止时抛错。 */
  private request(init: RequestInit): Promise<Response> {
    if (!this.fetchImpl) {
      throw new OFDError('OFD_INVALID_PACKAGE', '当前环境没有 fetch，无法读取 HTTP 文档');
    }
    return this.fetchImpl(this.url, { ...init, signal: this.requestAbort.signal });
  }

  /**
   * 探测文件大小与 Range 支持情况。
   */
  private async probe(): Promise<void> {
    this.assertNotClosed();
    let head: Response | null = null;
    try {
      head = await this.request({ method: 'HEAD', headers: this.headers });
    } catch (error) {
      // 部分服务器不支持 HEAD；继续用 Range GET 探测。取消/关闭必须立即结束。
      this.rethrowIfAborted(error);
    }

    if (head?.ok) {
      if (hasContentEncoding(head.headers)) {
        // CDN 可能对文档启用 gzip 传输编码：Content-Length 是编码后长度，Range
        // 也会切在编码后的字节流上；整包下载后使用解压后的真实长度。
        await this.downloadWhole();
        return;
      }
      const contentLength = parseContentLength(head.headers.get('content-length'));
      if (contentLength !== undefined) {
        this.sizeValue = contentLength;
        return;
      }
    }

    const response = await this.request({
      method: 'GET',
      headers: { ...this.headers, Range: 'bytes=0-0' },
    });
    if (response.status === 206) {
      if (hasContentEncoding(response.headers)) {
        await this.downloadWhole();
        return;
      }
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.total === undefined) {
        // 极少数服务器只返回 `bytes 0-0/*`；此时用 HEAD 的 Content-Length 兜底。
        const fallback = head?.ok
          ? parseContentLength(head.headers.get('content-length'))
          : undefined;
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
      await this.acceptWhole(response);
      return;
    }
    if (response.status === 416) {
      // 空文件或服务器拒绝 0-0：size=0，由 engine 报包非法。
      this.sizeValue = 0;
      return;
    }
    throw new OFDError('OFD_INVALID_PACKAGE', `HTTP 探测失败：status=${response.status}`);
  }

  /**
   * 接收服务器返回的整包响应并缓存。
   *
   * @param response 状态为 200 的响应。
   * @returns 完整字节。
   * @throws {OFDError} 禁用整包回退时。
   */
  private async acceptWhole(response: Response): Promise<Uint8Array> {
    if (!this.allowFullDownload) {
      throw new OFDError('OFD_INVALID_PACKAGE', '服务器不支持 HTTP Range，且已禁用整包回退');
    }
    const whole = await this.readWhole(response);
    this.assertNotClosed();
    this.memory = whole;
    this.sizeValue = whole.byteLength;
    return whole;
  }

  /**
   * 整包下载并缓存到内存。
   *
   * @returns 完整字节。
   * @throws {OFDError} 禁用整包回退或 HTTP 状态异常时。
   */
  private async downloadWhole(): Promise<Uint8Array> {
    if (this.memory) return this.memory;
    if (!this.allowFullDownload) {
      throw new OFDError(
        'OFD_INVALID_PACKAGE',
        '服务器对响应体启用了内容编码，无法按 Range 读取，且已禁用整包回退',
      );
    }
    const response = await this.request({ headers: this.headers });
    if (!response.ok) {
      throw new OFDError('OFD_INVALID_PACKAGE', `文档整包下载失败：status=${response.status}`);
    }
    const whole = await this.readWhole(response);
    this.assertNotClosed();
    this.memory = whole;
    this.sizeValue = whole.byteLength;
    return whole;
  }

  /**
   * 读取完整响应体；有流式 body 时逐块上报进度。
   *
   * @param response HTTP 响应。
   * @returns 完整字节。
   */
  private async readWhole(response: Response): Promise<Uint8Array> {
    const total = hasContentEncoding(response.headers)
      ? undefined
      : parseContentLength(response.headers.get('content-length'));
    const body = response.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        loaded += value.byteLength;
        this.reportProgress(loaded, total);
      }
      this.assertNotClosed();
      return concatChunks(chunks, loaded);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.reportProgress(bytes.byteLength, total ?? bytes.byteLength);
    return bytes;
  }

  /**
   * 判断 206 响应的 Content-Range 总长度是否与已探测大小不一致。
   *
   * @param headers 响应头。
   * @returns 不一致时为 true。
   */
  private hasRangeTotalMismatch(headers: Headers): boolean {
    if (this.sizeValue <= 0) return false;
    const range = parseContentRange(headers.get('content-range'));
    return range !== null && range.total !== undefined && range.total !== this.sizeValue;
  }

  /**
   * 校验 206 响应的起始位置，避免服务器返回错误区间导致数据错位。
   *
   * @param header Content-Range 头。
   * @param expectedStart 期望起点，单位 byte。
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

  /** 上报进度；无回调时无操作。 */
  private reportProgress(loaded: number, total: number | undefined): void {
    this.onProgress?.(loaded, total);
  }

  /** 关闭标记检查。 */
  private assertNotClosed(): void {
    if (this.closed) throw createClosedError();
  }

  /**
   * 取消/关闭优先于普通请求错误：close() 导致的拒绝统一为 `OFD_CLOSED`。
   *
   * 关闭前的外部取消保留 AbortError 语义，供调用方识别“用户取消”。
   */
  private rethrowIfAborted(error: unknown): void {
    if (!this.requestAbort.signal.aborted) return;
    if (this.closed) throw createClosedError();
    if (isAbortError(error)) throw error;
    const abort = new Error('HTTP 请求已取消');
    abort.name = 'AbortError';
    throw abort;
  }
}

/** 创建关闭错误。 */
function createClosedError(): OFDError {
  return new OFDError('OFD_CLOSED', 'HTTP 字节源已关闭');
}

/** 判断取消错误。 */
function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** 合并分块字节。 */
function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
function hasContentEncoding(headers: Headers): boolean {
  const encoding = headers.get('content-encoding');
  if (encoding === null) return false;
  const normalized = encoding.trim().toLowerCase();
  return normalized !== '' && normalized !== 'identity';
}

/** Content-Range 解析结果；`total` 为 undefined 表示 `*`。 */
interface ParsedContentRange {
  /** 区间起点，单位 byte。 */
  readonly start: number;
  /** 区间终点（含），单位 byte。 */
  readonly end: number;
  /** 完整实体总长度，单位 byte；`*` 时省略。 */
  readonly total?: number;
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
  if (totalText !== '*' && totalText !== undefined) {
    const total = Number(totalText);
    if (Number.isFinite(total) && total >= 0) return { start, end, total };
  }
  return { start, end };
}