/**
 * DocumentController 字体接入测试：引擎入参片段、失败只 warning、缓存与 dispose。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FontInput, OFDOpenOptions } from '@ofdrw/ofdrw-viewer-engine';
import {
  DocumentController,
  type EngineDocument,
} from '../../../src/document-controller';
import { DEFAULT_FONT_ALIASES } from '@ofdrw/ofdrw-viewer-engine';
import type { ViewerWarning } from '../../../src/state';

/** 构造可手动兑现的 Promise。 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

/** 构造最小引擎文档替身。 */
function makeDocument(pageCount = 2): EngineDocument {
  return {
    pageCount,
    getPageInfos: async () => [],
    getPage: async (index: number) => ({ index }) as never,
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount }),
    getPermissions: async () => ({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    }),
    getSignatureEntries: async () => [],
    getSignedValue: async () => undefined,
    close: async () => undefined,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DocumentController 字体透传', () => {
  it('openDocument 入参包含 defaultFonts/supplementaryFonts 与追加后的别名', async () => {
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument();
      },
      font: {
        default: [{ data: new Uint8Array([1, 2]), family: 'Serif' }],
        supplementary: [{ data: new Uint8Array([3]) }],
        aliases: [['宋体', 'notoserifscextralight']],
      },
    });
    await controller.open(new Uint8Array([9, 9]));
    expect(calls).toHaveLength(1);
    const options = calls[0] as OFDOpenOptions;
    expect(options.defaultFonts).toEqual([{ data: new Uint8Array([1, 2]), family: 'Serif' }]);
    expect(options.supplementaryFonts).toEqual([{ data: new Uint8Array([3]) }]);
    // 追加语义：内置组完整保留在宿主组之前。
    expect(options.aliases).toHaveLength(DEFAULT_FONT_ALIASES.length + 1);
    expect(options.aliases?.slice(0, DEFAULT_FONT_ALIASES.length)).toEqual(
      DEFAULT_FONT_ALIASES.map((group) => [...group]),
    );
  });

  it('来源全部失败时不传字体字段，且只产生 W_FONT_MISSING warning', async () => {
    const warnings: ViewerWarning[] = [];
    const calls: OFDOpenOptions[] = [];
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DocumentController({
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument();
      },
      onWarning: (warning) => warnings.push(warning),
      font: {
        default: [{ url: 'https://cdn.example.com/a.woff2' }],
        supplementary: [{ path: '/fonts/b.ttf' }],
      },
    });
    const info = await controller.open(new Uint8Array([1]));
    expect(info.pageCount).toBe(2);
    const options = calls[0] as OFDOpenOptions;
    expect('defaultFonts' in options).toBe(false);
    expect('supplementaryFonts' in options).toBe(false);
    expect('aliases' in options).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((warning) => warning.code === 'W_FONT_MISSING')).toBe(true);
    // 文案只含来源地址与错误摘要，不含字体字节。
    const messages = warnings.map((warning) => warning.message).join('\n');
    expect(messages).toContain('https://cdn.example.com/a.woff2');
    expect(messages).toContain('/fonts/b.ttf');
    expect(messages).toContain('HTTP 500');
  });

  it('未配置 font 时行为不变：无字体字段、无请求', async () => {
    const calls: OFDOpenOptions[] = [];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DocumentController({
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument();
      },
    });
    await controller.open(new Uint8Array([1]));
    const options = calls[0] as OFDOpenOptions;
    expect('defaultFonts' in options).toBe(false);
    expect('supplementaryFonts' in options).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('close() 保留字体缓存，二次打开不再请求', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([5, 6]).buffer,
        }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument();
      },
      font: { default: [{ url: 'https://cdn.example.com/a.woff2' }] },
    });
    await controller.open(new Uint8Array([1]));
    await controller.close();
    await controller.open(new Uint8Array([2]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[1]?.defaultFonts).toHaveLength(1);
  });

  it('dispose() 中止进行中的字体请求，打开不得到字体', async () => {
    const fetchStarted = createDeferred<void>();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchStarted.resolve();
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const warnings: ViewerWarning[] = [];
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument();
      },
      onWarning: (warning) => warnings.push(warning),
      font: { default: [{ url: 'https://cdn.example.com/slow.woff2' }] },
    });
    const opening = controller.open(new Uint8Array([1]));
    await fetchStarted.promise;
    controller.dispose();
    const info = await opening;
    expect(info.pageCount).toBe(2);
    expect('defaultFonts' in (calls[0] as OFDOpenOptions)).toBe(false);
    // 取消不上报 W_FONT_MISSING。
    expect(warnings).toHaveLength(0);
  });

  it('loader 读取成功时把字节交给引擎', async () => {
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument();
      },
      font: {
        supplementary: [{ filePath: 'D:/fonts/a.ttf', family: '仿宋' }],
        loader: () => new Uint8Array([7]),
      },
    });
    await controller.open(new Uint8Array([1]));
    const input = calls[0]?.supplementaryFonts?.[0] as FontInput;
    expect(input.data).toEqual(new Uint8Array([7]));
    expect(input.family).toBe('仿宋');
  });
});
