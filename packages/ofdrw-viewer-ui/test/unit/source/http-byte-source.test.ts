/**
 * HttpByteSource 单元测试：HEAD/Range 探测、206/200/416 分支、内容编码回退、
 * 取消与关闭、进度与错误语义。
 *
 * 全部 HTTP 交互由可编程 fetch 替身完成，不访问网络。
 */

import { describe, expect, it, vi } from 'vitest';
import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import {
  HttpByteSource,
  type HttpByteSourceOptions,
} from '../../../src/source/http-byte-source';

/** 响应替身选项。 */
interface FakeResponseInit {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** 完整响应体；省略时为空。 */
  readonly body?: Uint8Array;
  /** 流式分块；提供时 `body.getReader()` 可读。 */
  readonly chunks?: readonly Uint8Array[];
}

/**
 * 创建最小 HTTP 响应替身。
 *
 * @param init 状态、响应头与响应体。
 * @returns 结构兼容 `Response` 的对象。
 */
function fakeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headerMap = { ...(init.headers ?? {}) };
  const body = init.body ?? new Uint8Array(0);
  const chunks = init.chunks;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        const key = Object.keys(headerMap).find((item) => item.toLowerCase() === name.toLowerCase());
        return key === undefined ? null : headerMap[key]!;
      },
    },
    body: chunks
      ? {
          getReader: () => {
            let index = 0;
            return {
              read: async () => {
                if (index >= chunks.length) return { done: true, value: undefined };
                const value = chunks[index]!;
                index += 1;
                return { done: false, value };
              },
            };
          },
        }
      : null,
    arrayBuffer: async () => body.slice().buffer,
  } as unknown as Response;
}

/** 请求记录。 */
interface RequestRecord {
  /** 请求方法。 */
  readonly method: string;
  /** Range 头。 */
  readonly range: string | undefined;
  /** 请求是否携带取消信号。 */
  readonly signal: AbortSignal | undefined;
}

/**
 * 创建按方法/序号返回响应的 fetch 替身。
 *
 * @param handler 按请求与序号生成响应。
 * @returns fetch 方法与请求记录。
 */
function createFetch(
  handler: (record: RequestRecord, index: number) => Response | Promise<Response>,
): { readonly fetch: typeof fetch; readonly calls: RequestRecord[] } {
  const calls: RequestRecord[] = [];
  const impl = async (_input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const record: RequestRecord = {
      method: init?.method ?? 'GET',
      range: headers.get('range') ?? undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(record);
    const signal = record.signal;
    if (signal?.aborted) throw createAbortError();
    const result = handler(record, calls.length - 1);
    if (!signal || !(result instanceof Promise)) return result;
    return Promise.race([result, rejectOnAbort(signal)]);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

/** 创建随取消信号拒绝的 promise。 */
function rejectOnAbort(signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const onAbort = (): void => reject(createAbortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 创建取消错误。 */
function createAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** 方便构造选项。 */
function options(fetchImpl: typeof fetch, extra: Partial<HttpByteSourceOptions> = {}) {
  return { fetch: fetchImpl, ...extra } satisfies HttpByteSourceOptions;
}

const URL_WITH_TOKEN = 'https://example.com/docs/a.ofd?token=super-secret';

describe('HttpByteSource 探测', () => {
  it('HEAD 成功时使用 Content-Length，重复 ready 不重复探测', async () => {
    const { fetch, calls } = createFetch((record) => {
      if (record.method === 'HEAD') return fakeResponse({ headers: { 'content-length': '4096' } });
      return fakeResponse({
        status: 206,
        headers: { 'content-range': 'bytes 0-9/4096' },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    await source.ready();
    expect(source.size).toBe(4096);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('HEAD');
    expect(calls[0]!.signal).toBeDefined();

    const bytes = await source.read(0, 4);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(calls[1]!.range).toBe('bytes=0-3');
  });

  it('HEAD 失败时回退 Range 探测并使用 Content-Range 总长', async () => {
    const { fetch, calls } = createFetch((record) => {
      if (record.method === 'HEAD') throw new Error('HEAD not allowed');
      return fakeResponse({
        status: 206,
        headers: { 'content-range': 'bytes 0-0/1234' },
        body: new Uint8Array([0]),
      });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    expect(source.size).toBe(1234);
    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET']);
    expect(calls[1]!.range).toBe('bytes=0-0');
  });

  it('HEAD 带内容编码时整包下载并缓存', async () => {
    const progress: Array<[number, number | undefined]> = [];
    const body = new TextEncoder().encode('decoded-bytes');
    const { fetch, calls } = createFetch((record) => {
      if (record.method === 'HEAD') {
        return fakeResponse({ headers: { 'content-encoding': 'gzip', 'content-length': '8' } });
      }
      return fakeResponse({ headers: { 'content-length': String(body.byteLength) }, body });
    });
    const source = new HttpByteSource(
      URL_WITH_TOKEN,
      options(fetch, { onProgress: (loaded, total) => progress.push([loaded, total]) }),
    );
    await source.ready();
    expect(source.size).toBe(body.byteLength);
    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET']);
    expect(progress.at(-1)?.[0]).toBe(body.byteLength);
    // 整包缓存后读取不再发请求。
    const bytes = await source.read(0, 7);
    expect(new TextDecoder().decode(bytes)).toBe('decoded');
    expect(calls).toHaveLength(2);
  });

  it('Content-Range 总长为 * 且无 HEAD 长度时抛 INVALID_PACKAGE', async () => {
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') return fakeResponse({ headers: {} });
      return fakeResponse({ status: 206, headers: { 'content-range': 'bytes 0-0/*' } });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await expect(source.ready()).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('探测 416 时 size 为 0', async () => {
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') throw new Error('HEAD not allowed');
      return fakeResponse({ status: 416 });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    expect(source.size).toBe(0);
    await expect(source.read(0, 1)).resolves.toEqual(new Uint8Array(0));
  });

  it('探测遇到未知状态码时抛 INVALID_PACKAGE 且不回显完整 URL', async () => {
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') throw new Error('HEAD not allowed');
      return fakeResponse({ status: 500 });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    const error = await source.ready().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OFDError);
    expect((error as OFDError).code).toBe('OFD_INVALID_PACKAGE');
    expect((error as Error).message).not.toContain('super-secret');
  });
});

describe('HttpByteSource 读取', () => {
  it('服务器忽略 Range（200）时整包缓存并切片，禁用回退时报错', async () => {
    const body = new TextEncoder().encode('0123456789');
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') {
        return fakeResponse({ headers: { 'content-length': String(body.byteLength) } });
      }
      return fakeResponse({ body });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    const bytes = await source.read(2, 3);
    expect(new TextDecoder().decode(bytes)).toBe('234');
    expect(source.size).toBe(body.byteLength);

    const denied = new HttpByteSource(
      URL_WITH_TOKEN,
      options(fetch, { allowFullDownload: false }),
    );
    await denied.ready();
    await expect(denied.read(0, 1)).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('Content-Range 起点与请求不符时抛错', async () => {
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') return fakeResponse({ headers: { 'content-length': '100' } });
      return fakeResponse({
        status: 206,
        headers: { 'content-range': 'bytes 10-13/100' },
        body: new Uint8Array([1, 2, 3, 4]),
      });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    await expect(source.read(0, 4)).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('206 响应带内容编码时整包下载后切片', async () => {
    const whole = new TextEncoder().encode('abcdefghij');
    const { fetch, calls } = createFetch((record) => {
      if (record.method === 'HEAD') {
        return fakeResponse({ headers: { 'content-length': String(whole.byteLength) } });
      }
      if (record.range) {
        return fakeResponse({
          status: 206,
          headers: { 'content-range': 'bytes 0-0/10', 'content-encoding': 'gzip' },
          body: new Uint8Array([0]),
        });
      }
      return fakeResponse({ body: whole });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    const bytes = await source.read(3, 4);
    expect(new TextDecoder().decode(bytes)).toBe('defg');
    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET', 'GET']);
  });

  it('读取 416 返回空数组', async () => {
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') return fakeResponse({ headers: { 'content-length': '10' } });
      return fakeResponse({ status: 416 });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    await expect(source.read(0, 5)).resolves.toEqual(new Uint8Array(0));
  });

  it('整包流式读取逐块上报进度', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const progress: Array<[number, number | undefined]> = [];
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') return fakeResponse({ headers: {} });
      return fakeResponse({ chunks });
    });
    const source = new HttpByteSource(
      URL_WITH_TOKEN,
      options(fetch, { onProgress: (loaded, total) => progress.push([loaded, total]) }),
    );
    await source.ready();
    expect(source.size).toBe(5);
    expect(progress).toEqual([
      [3, undefined],
      [5, undefined],
    ]);
  });
});

describe('HttpByteSource 生命周期', () => {
  it('外部取消后 ready 抛 AbortError', async () => {
    const controller = new AbortController();
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') {
        controller.abort();
        throw createAbortError();
      }
      return fakeResponse({ status: 206, headers: { 'content-range': 'bytes 0-0/1' } });
    });
    const source = new HttpByteSource(
      URL_WITH_TOKEN,
      options(fetch, { signal: controller.signal }),
    );
    await expect(source.ready()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('读取过程中取消抛 AbortError', async () => {
    const controller = new AbortController();
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') return fakeResponse({ headers: { 'content-length': '10' } });
      controller.abort();
      throw createAbortError();
    });
    const source = new HttpByteSource(
      URL_WITH_TOKEN,
      options(fetch, { signal: controller.signal }),
    );
    await source.ready();
    await expect(source.read(0, 5)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('close 幂等，关闭后读取抛 OFD_CLOSED，并中止进行中的请求', async () => {
    let release!: (response: Response) => void;
    const { fetch } = createFetch((record) => {
      if (record.method === 'HEAD') return fakeResponse({ headers: { 'content-length': '10' } });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const source = new HttpByteSource(URL_WITH_TOKEN, options(fetch));
    await source.ready();
    const read = source.read(0, 5);
    // 等待 read 越过 ready() 的微任务并发起请求。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(typeof release).toBe('function');
    await source.close();
    await source.close();
    await expect(read).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    await expect(source.read(0, 1)).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    await expect(source.ready()).rejects.toMatchObject({ code: 'OFD_CLOSED' });
  });

  it('没有 fetch 时报明确错误', async () => {
    vi.stubGlobal('fetch', undefined);
    try {
      const source = new HttpByteSource(URL_WITH_TOKEN);
      await expect(source.ready()).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});