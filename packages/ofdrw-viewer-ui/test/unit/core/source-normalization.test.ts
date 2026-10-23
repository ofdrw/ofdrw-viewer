/**
 * 来源规范化单元测试：URL → HttpByteSource、origin 保留、请求头合并优先级。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeViewerSource,
  normalizeViewerSourceDetailed,
} from '../../../src/document-controller';
import { HttpByteSource } from '../../../src/source/http-byte-source';

/** 构造最小 HEAD 响应替身。 */
function headResponse(contentLength: number): Response {
  return {
    status: 200,
    ok: true,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-length' ? String(contentLength) : null),
    },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeViewerSourceDetailed', () => {
  it('URL 字符串转为 custom 字节源并保留 origin', () => {
    const normalized = normalizeViewerSourceDetailed('https://example.com/合同.ofd?x=1');
    expect(normalized.source.kind).toBe('custom');
    expect(normalized.httpSource).toBeInstanceOf(HttpByteSource);
    expect(normalized.source).toEqual({ kind: 'custom', source: normalized.httpSource });
    expect(normalized.origin).toEqual({
      kind: 'url',
      url: 'https://example.com/合同.ofd?x=1',
    });
    // 不再产生 engine 已删除的 url 来源。
    expect(normalized.source.kind).not.toBe('url');
  });

  it('{ url, headers } 转为 custom，来源 headers 覆盖 requestInit.headers', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => headResponse(64));
    vi.stubGlobal('fetch', fetchMock);
    const normalized = normalizeViewerSourceDetailed(
      { url: 'https://example.com/a.ofd', headers: { authorization: 'source-token' } },
      { headers: { authorization: 'global-token', 'x-base': 'base' } },
    );
    await normalized.httpSource?.ready();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({
      authorization: 'source-token',
      'x-base': 'base',
    });
    expect(normalized.origin).toEqual({ kind: 'url', url: 'https://example.com/a.ofd' });
  });

  it('ArrayBuffer/Uint8Array 原样返回且无 origin', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const normalized = normalizeViewerSourceDetailed(bytes);
    expect(normalized.source).toEqual({ kind: 'arraybuffer', data: bytes });
    expect(normalized.origin).toBeUndefined();
  });

  it('Blob 保留 blob origin，File 保留文件名 origin', () => {
    const blob = new Blob([new Uint8Array([1])]);
    expect(normalizeViewerSourceDetailed(blob).origin).toEqual({ kind: 'blob' });

    const file = new File([new Uint8Array([1])], '合同.ofd');
    expect(normalizeViewerSourceDetailed(file).origin).toEqual({
      kind: 'file',
      name: '合同.ofd',
    });
  });

  it('空来源与非支持类型抛 OFD_INVALID_OPTION', () => {
    expect(() => normalizeViewerSourceDetailed('   ')).toThrowError(/不能为空/);
    expect(() => normalizeViewerSourceDetailed({} as never)).toThrowError(
      /source 必须是/,
    );
  });

  it('normalizeViewerSource 返回 custom 来源', () => {
    const source = normalizeViewerSource('https://example.com/a.ofd');
    expect(source.kind).toBe('custom');
    expect(source.kind).not.toBe('url');
  });
});