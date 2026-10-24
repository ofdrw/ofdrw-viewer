/**
 * 原文件读取测试：ArrayBuffer/Blob/URL 与引擎规范化随机读源。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readOFDSourceBytes,
  readViewerSourceBytes,
} from '../../../src/source/read-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readViewerSourceBytes', () => {
  it('ArrayBuffer/Uint8Array/Blob 直接读取且不复制视窗外字节', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(await readViewerSourceBytes(buffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    const raw = new Uint8Array([9, 8, 7, 6]);
    const view = new Uint8Array(raw.buffer, 1, 2);
    expect(await readViewerSourceBytes(view)).toEqual(new Uint8Array([8, 7]));
    expect(await readViewerSourceBytes(new Blob([new Uint8Array([5, 6])]))).toEqual(
      new Uint8Array([5, 6]),
    );
  });

  it('URL 重新请求并合并请求头，失败时抛错', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect(
      await readViewerSourceBytes(
        { url: 'https://example.test/a.ofd', headers: { 'X-Root': 'r' } },
        { headers: { 'X-Init': 'i' } },
        signal,
      ),
    ).toEqual(new Uint8Array([1, 2]));
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/a.ofd', {
      headers: { 'X-Init': 'i', 'X-Root': 'r' },
      signal,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    await expect(readViewerSourceBytes('https://example.test/missing.ofd')).rejects.toThrow(
      'HTTP 404',
    );
  });

  it('不支持的来源明确报错', async () => {
    await expect(readViewerSourceBytes({} as never)).rejects.toThrow('不支持的 OFD 来源');
  });
});

describe('readOFDSourceBytes', () => {
  it('规范化 arraybuffer/blob 与分块随机读源合并为完整字节', async () => {
    expect(
      await readOFDSourceBytes({ kind: 'arraybuffer', data: new Uint8Array([1, 2, 3]) }),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(
      await readOFDSourceBytes({ kind: 'blob', blob: new Blob([new Uint8Array([4, 5])]) }),
    ).toEqual(new Uint8Array([4, 5]));

    const ready = vi.fn(async () => undefined);
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])];
    const offsets: number[] = [];
    const source = {
      kind: 'custom' as const,
      source: {
        size: 5,
        ready,
        read: async (offset: number, length: number) => {
          offsets.push(offset, length);
          return chunks.shift()!;
        },
      },
    };
    expect(await readOFDSourceBytes(source as never)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(ready).toHaveBeenCalledTimes(1);
    expect(offsets).toEqual([0, 5, 2, 3, 3, 2]);
  });

  it('随机读源短读不静默截断，抛出 OFD_EXPORT_FAILED', async () => {
    const short = {
      kind: 'custom' as const,
      source: {
        size: 10,
        read: async (offset: number) => {
          if (offset === 0) return new Uint8Array([1, 2, 3]);
          return new Uint8Array(0);
        },
      },
    };
    await expect(readOFDSourceBytes(short as never)).rejects.toMatchObject({
      code: 'OFD_EXPORT_FAILED',
      message: expect.stringContaining('期望 10 字节，实际 3 字节'),
    });
  });
});
