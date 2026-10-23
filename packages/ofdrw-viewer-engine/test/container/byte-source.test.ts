import { describe, expect, it, vi } from 'vitest';
import {
  ArrayBufferSource,
  BlobSource,
  HttpRangeSource,
} from '../../src/container/byte-source';
import type { FetchLike, FetchResponseLike } from '../../src/container/byte-source';
import { OFDError } from '../../src/errors';

/** 构造最小 fetch 响应。 */
function makeResponse(
  status: number,
  body: Uint8Array,
  headers: Record<string, string> = {},
): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
        return key === undefined ? null : (headers[key] as string);
      },
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const copy = body.slice();
      return copy.buffer;
    },
  };
}

/** 生成 0..n-1 的字节。 */
function sequence(length: number): Uint8Array {
  return new Uint8Array(Array.from({ length }, (_value, index) => index & 0xff));
}

describe('container/byte-source', () => {
  it('ArrayBufferSource 支持 Uint8Array 视图偏移与越界截断', async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const source = new ArrayBufferSource(backing.subarray(2, 6));
    expect(source.size).toBe(4);
    expect([...(await source.read(1, 100))]).toEqual([3, 4, 5]);
    expect((await source.read(4, 2)).byteLength).toBe(0);
    expect((await source.read(-2, 2)).byteLength).toBe(2);
    expect((await source.read(0, 0)).byteLength).toBe(0);

    const fromBuffer = new ArrayBufferSource(backing.buffer);
    expect(fromBuffer.size).toBe(10);
    expect([...(await fromBuffer.read(8, 5))]).toEqual([8, 9]);
  });

  it('BlobSource 按区间读取', async () => {
    const source = new BlobSource(new Blob([new Uint8Array([10, 11, 12, 13])]));
    expect(source.size).toBe(4);
    expect([...(await source.read(1, 2))]).toEqual([11, 12]);
    expect((await source.read(3, 10)).byteLength).toBe(1);
  });

  it('HttpRangeSource 用 HEAD 获取大小，GET Range 读取区间', async () => {
    const bytes = sequence(100);
    const calls: { method: string; range?: string }[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, range: init?.headers?.Range });
      if (method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), {
          'content-length': '100',
          'accept-ranges': 'bytes',
        });
      }
      expect(init?.headers?.Range).toBe('bytes=10-14');
      return makeResponse(206, bytes.slice(10, 15), { 'content-range': 'bytes 10-14/100' });
    };

    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    expect(source.size).toBe(100);
    expect([...(await source.read(10, 5))]).toEqual([10, 11, 12, 13, 14]);
    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET']);
  });

  it('直接构造且不传 fetch 时，以 globalThis 为 receiver 调用全局 fetch', async () => {
    const originalFetch = globalThis.fetch;
    const receivers: unknown[] = [];
    const payload = sequence(4);
    globalThis.fetch = function (
      this: unknown,
      _input: string,
      init?: { method?: string; headers?: Record<string, string> },
    ): Promise<FetchResponseLike> {
      receivers.push(this);
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      if (init?.method === 'HEAD') {
        return Promise.resolve(makeResponse(200, new Uint8Array(0), { 'content-length': '4' }));
      }
      return Promise.resolve(
        makeResponse(206, payload, { 'content-range': 'bytes 0-3/4' }),
      );
    } as unknown as typeof fetch;

    try {
      const source = new HttpRangeSource('https://example.com/direct.ofd');
      await source.ready();
      expect(source.size).toBe(4);
      expect([...(await source.read(0, 4))]).toEqual([0, 1, 2, 3]);
      expect(receivers).toHaveLength(2);
      expect(receivers.every((receiver) => receiver === globalThis)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('注入 fetch 优先于全局 fetch', async () => {
    const originalFetch = globalThis.fetch;
    const globalFetch = vi.fn<typeof fetch>();
    globalThis.fetch = globalFetch;

    const injected = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), { 'content-length': '2' });
      }
      return makeResponse(206, new Uint8Array([7, 8]), { 'content-range': 'bytes 0-1/2' });
    });
    try {
      const source = await HttpRangeSource.open('https://example.com/injected.ofd', {
        fetch: injected,
      });
      expect(source.size).toBe(2);
      expect([...(await source.read(0, 2))]).toEqual([7, 8]);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(injected).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('HTTP HEAD 不可用时回退 GET Range 0-0 探测', async () => {
    const bytes = sequence(50);
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === 'HEAD') return makeResponse(405, new Uint8Array(0));
      if (init?.headers?.Range === 'bytes=0-0') {
        return makeResponse(206, bytes.slice(0, 1), { 'content-range': 'bytes 0-0/50' });
      }
      return makeResponse(206, bytes.slice(2, 5), { 'content-range': 'bytes 2-4/50' });
    };
    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    expect(source.size).toBe(50);
    expect([...(await source.read(2, 3))]).toEqual([2, 3, 4]);
  });

  it('服务器忽略 Range 时整包缓存，后续读取不再请求', async () => {
    const bytes = sequence(20);
    let fetches = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      fetches += 1;
      if (init?.method === 'HEAD') return makeResponse(200, new Uint8Array(0));
      return makeResponse(200, bytes);
    };
    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    expect(source.size).toBe(20);
    expect([...(await source.read(2, 3))]).toEqual([2, 3, 4]);
    const afterProbe = fetches;
    expect([...(await source.read(10, 2))]).toEqual([10, 11]);
    expect(fetches).toBe(afterProbe);
  });

  it('HEAD 给出大小但 GET 仍忽略 Range 时回退整包', async () => {
    const bytes = sequence(30);
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), { 'content-length': '30' });
      }
      return makeResponse(200, bytes);
    };
    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    expect(source.size).toBe(30);
    expect([...(await source.read(20, 100))]).toEqual([...bytes.slice(20)]);
  });

  it('Content-Range 起点不符时拒绝，避免错位数据', async () => {
    const bytes = sequence(50);
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), { 'content-length': '50' });
      }
      return makeResponse(206, bytes.slice(0, 5), { 'content-range': 'bytes 0-4/50' });
    };
    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    await expect(source.read(10, 5)).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('allowFullDownload=false 时服务器不支持 Range 直接失败', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === 'HEAD') return makeResponse(200, new Uint8Array(0));
      return makeResponse(200, sequence(10));
    };
    await expect(
      HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl, allowFullDownload: false }),
    ).rejects.toBeInstanceOf(OFDError);
  });

  it('探测失败不产生未处理 rejection，ready 时抛出', async () => {
    const fetchImpl: FetchLike = async () => makeResponse(500, new Uint8Array(0));
    const source = new HttpRangeSource('https://example.com/a.ofd', { fetch: fetchImpl });
    await expect(source.ready()).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
    await expect(source.read(0, 1)).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('使用额外请求头', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init?.headers);
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), { 'content-length': '2' });
      }
      return makeResponse(206, new Uint8Array([1, 2]), { 'content-range': 'bytes 0-1/2' });
    };
    const source = await HttpRangeSource.open('https://example.com/a.ofd', {
      fetch: fetchImpl,
      headers: { Authorization: 'Bearer token' },
    });
    expect(source.size).toBe(2);
    expect(seen[0]?.Authorization).toBe('Bearer token');
  });

  it('探测仅使用 HEAD 一次', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), { 'content-length': '1' });
      }
      return makeResponse(206, new Uint8Array([0]), { 'content-range': 'bytes 0-0/1' });
    });
    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    expect(source.size).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HEAD 表明启用内容编码时整包下载，并按解压后长度读取', async () => {
    const bytes = sequence(100);
    const requests: { method: string; range?: string }[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      requests.push({ method: init?.method ?? 'GET', range: init?.headers?.Range });
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), {
          'content-length': '60',
          'content-encoding': 'gzip',
        });
      }
      // 浏览器会自动解压，fetch 拿到的 body 是原始字节。
      return makeResponse(200, bytes, { 'content-encoding': 'gzip' });
    };
    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    expect(source.size).toBe(100);
    expect([...(await source.read(90, 20))]).toEqual([...bytes.slice(90)]);
    expect(requests.some((request) => request.range !== undefined)).toBe(false);
  });

  it('HEAD 未暴露编码但 206 带内容编码时回退整包，避免错位读取', async () => {
    const bytes = sequence(40);
    const ranges: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), { 'content-length': '40' });
      }
      ranges.push(init?.headers?.Range);
      if (init?.headers?.Range !== undefined) {
        return makeResponse(206, bytes.slice(0, 1), {
          'content-range': 'bytes 0-0/40',
          'content-encoding': 'gzip',
        });
      }
      return makeResponse(200, bytes, { 'content-encoding': 'gzip' });
    };
    const source = await HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl });
    expect([...(await source.read(10, 5))]).toEqual([...bytes.slice(10, 15)]);
    expect(ranges).toContain(undefined);
  });

  it('内容编码且禁用整包回退时直接失败', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === 'HEAD') {
        return makeResponse(200, new Uint8Array(0), {
          'content-length': '10',
          'content-encoding': 'gzip',
        });
      }
      return makeResponse(200, sequence(20));
    };
    await expect(
      HttpRangeSource.open('https://example.com/a.ofd', { fetch: fetchImpl, allowFullDownload: false }),
    ).rejects.toBeInstanceOf(OFDError);
  });
});