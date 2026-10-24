/**
 * 字体来源解析测试：data 透传、URL 去重与失败跳过、loader、取消与别名追加语义。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FONT_ALIASES } from '@ofdrw/ofdrw-viewer-engine';
import {
  composeFontAliases,
  FontSourceResolver,
  type FontSource,
} from '../../../src/font';
import { resolveViewerOptions } from '../../../src/options';

/** 构造字体字节响应替身。 */
function fontResponse(bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FontSourceResolver.resolve', () => {
  it('data 直接透传，不复制字节并保留 family', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const resolver = new FontSourceResolver();
    const inputs = await resolver.resolve(
      [{ data: bytes, family: 'Noto Serif SC' }],
      undefined,
      () => undefined,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.data).toBe(bytes);
    expect(inputs[0]?.family).toBe('Noto Serif SC');
  });

  it('data 非法或为空时跳过并回调 onError', async () => {
    const resolver = new FontSourceResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve(
      [
        { data: new Uint8Array(0) },
        { data: 'not-bytes' as unknown as Uint8Array },
        { data: new Uint8Array([9]) },
      ],
      undefined,
      (_source, error) => errors.push(error),
    );
    expect(inputs).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });

  it('default 与 supplementary 共用同一 URL 时只请求一次', async () => {
    const fetchMock = vi.fn(async () => fontResponse(new Uint8Array([1, 2])));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new FontSourceResolver();
    const shared: FontSource = { url: 'https://cdn.example.com/font.woff2', family: 'Serif' };
    const [defaults, supplementary] = await Promise.all([
      resolver.resolve([shared], undefined, () => undefined),
      resolver.resolve(
        [{ ...shared }, { url: 'https://cdn.example.com/font.woff2?x=1' }],
        undefined,
        () => undefined,
      ),
    ]);
    // 完整 URL（含 query）参与去重：`?x=1` 是不同来源。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(defaults).toHaveLength(1);
    expect(supplementary).toHaveLength(2);
    // 同一 URL 命中缓存：两次解析拿到同一份字节对象。
    expect(defaults[0]?.data).toBe(supplementary[0]?.data);
  });

  it('url 请求头合并 requestInit.headers 与来源 headers，来源优先', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => fontResponse(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new FontSourceResolver({
      requestInit: { headers: { authorization: 'global', 'x-base': 'base' } },
    });
    await resolver.resolve(
      [{ url: 'https://cdn.example.com/a.woff2', headers: { authorization: 'source' } }],
      undefined,
      () => undefined,
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'source', 'x-base': 'base' });
    // 只复用 headers；取消信号来自本次 open，不沿用 requestInit.signal。
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('url 非 2xx 被跳过并回调 onError；失败结果不缓存', async () => {
    const fetchMock = vi.fn(async () => fontResponse(new Uint8Array(0), false, 404));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new FontSourceResolver();
    const errors: unknown[] = [];
    const source: FontSource = { url: 'https://cdn.example.com/missing.woff2' };
    const inputs = await resolver.resolve([source], undefined, (_s, error) => errors.push(error));
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);
    // 下次 open 重新尝试。
    await resolver.resolve([source], undefined, () => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('path/filePath 无 loader 时跳过并回调 onError', async () => {
    const resolver = new FontSourceResolver();
    const errors: unknown[] = [];
    const inputs = await resolver.resolve(
      [{ path: '/fonts/a.ttf' }, { filePath: 'D:/fonts/b.ttf' }],
      undefined,
      (_s, error) => errors.push(error),
    );
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it('loader 抛错或返回 null 时跳过，正常返回时透传字节', async () => {
    const loader = vi.fn((source: { path: string } | { filePath: string }) => {
      const path = 'path' in source ? source.path : source.filePath;
      if (path === 'throw') throw new Error('磁盘错误');
      if (path === 'null') return null;
      return new Uint8Array([7, 8]);
    });
    const resolver = new FontSourceResolver({ loader });
    const errors: unknown[] = [];
    const inputs = await resolver.resolve(
      [{ path: 'throw' }, { path: 'null' }, { path: 'ok', family: '楷体' }],
      undefined,
      (_s, error) => errors.push(error),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.family).toBe('楷体');
    expect(errors).toHaveLength(2);
  });

  it('loader 读取成功的结果按路径缓存，重复 resolve 不再调用 loader', async () => {
    const loader = vi.fn(() => new Uint8Array([1]));
    const resolver = new FontSourceResolver({ loader });
    const source: FontSource = { path: '/fonts/a.ttf' };
    await resolver.resolve([source], undefined, () => undefined);
    await resolver.resolve([source], undefined, () => undefined);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('signal 中止后进行中的来源不返回结果，且已中止的 signal 不再发起读取', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new FontSourceResolver();
    const controller = new AbortController();
    const errors: unknown[] = [];
    const pending = resolver.resolve(
      [{ url: 'https://cdn.example.com/slow.woff2' }],
      controller.signal,
      (_s, error) => errors.push(error),
    );
    controller.abort();
    resolveFetch?.(fontResponse(new Uint8Array([1, 2])));
    const inputs = await pending;
    expect(inputs).toEqual([]);
    expect(errors).toHaveLength(1);

    const aborted = new AbortController();
    aborted.abort();
    const after = await resolver.resolve(
      [{ url: 'https://cdn.example.com/other.woff2' }],
      aborted.signal,
      () => undefined,
    );
    expect(after).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('相同 Promise 在进行中被复用（path 来源并发读取一次）', async () => {
    let resolveLoader: ((value: Uint8Array) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveLoader = resolve;
        }),
    );
    const resolver = new FontSourceResolver({ loader });
    const source: FontSource = { path: '/fonts/a.ttf' };
    const first = resolver.resolve([source], undefined, () => undefined);
    const second = resolver.resolve([source], undefined, () => undefined);
    resolveLoader?.(new Uint8Array([3]));
    expect(await first).toHaveLength(1);
    expect(await second).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('dispose() 中止进行中的请求，之后 resolve 返回空数组', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new FontSourceResolver();
    const errors: unknown[] = [];
    const pending = resolver.resolve(
      [{ url: 'https://cdn.example.com/slow.woff2' }],
      undefined,
      (_s, error) => errors.push(error),
    );
    resolver.dispose();
    expect(await pending).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).name).toBe('AbortError');
    expect(await resolver.resolve([{ url: 'https://cdn.example.com/x.woff2' }], undefined, () => undefined)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('composeFontAliases', () => {
  it('追加宿主别名组且保留全部内置组', () => {
    const merged = composeFontAliases([['宋体', 'notoserifscextralight']]);
    expect(merged).toHaveLength(DEFAULT_FONT_ALIASES.length + 1);
    // 内置的 宋体→simsun 组仍在内置段中，未被替换。
    const simsun = merged.find((group) => group.includes('宋体'));
    expect(simsun).toEqual(expect.arrayContaining(['宋体', 'simsun']));
    expect(merged.slice(0, DEFAULT_FONT_ALIASES.length)).toEqual(
      DEFAULT_FONT_ALIASES.map((group) => [...group]),
    );
    expect(merged[DEFAULT_FONT_ALIASES.length]).toEqual(['宋体', 'notoserifscextralight']);
  });

  it('未提供宿主组时返回内置别名表本身', () => {
    expect(composeFontAliases(undefined)).toBe(DEFAULT_FONT_ALIASES);
    expect(composeFontAliases([])).toBe(DEFAULT_FONT_ALIASES);
  });
});

describe('resolveViewerOptions fonts', () => {
  it('fonts 原样透传，未提供时为 undefined', () => {
    const fonts = { default: [{ data: new Uint8Array([1]) }] };
    const resolved = resolveViewerOptions({ container: '#viewer', fonts });
    expect(resolved.fonts).toBe(fonts);
    expect(resolveViewerOptions({ container: '#viewer' }).fonts).toBeUndefined();
  });
});
