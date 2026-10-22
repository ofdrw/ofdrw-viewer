import { afterEach, describe, expect, it } from 'vitest';
import { openByteSource } from '../../src/api/source';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('openByteSource url', () => {
  it('调用全局 fetch 时绑定 globalThis（浏览器 Illegal invocation 回归）', async () => {
    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const calls: Array<{ thisArg: unknown; method: string }> = [];

    globalThis.fetch = function (
      this: unknown,
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      calls.push({ thisArg: this, method: init?.method ?? 'GET' });
      if (this !== globalThis) throw new TypeError('Illegal invocation');

      if (init?.method === 'HEAD') {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: {
              'Content-Length': String(payload.length),
              'Accept-Ranges': 'bytes',
            },
          }),
        );
      }

      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (!match) return Promise.resolve(new Response(payload, { status: 200 }));

      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), payload.length - 1);
      return Promise.resolve(
        new Response(payload.slice(start, end + 1), {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${payload.length}` },
        }),
      );
    } as typeof fetch;

    const source = await openByteSource({ kind: 'url', url: 'https://example.test/a.ofd' });
    const bytes = await source.read(1, 2);

    expect(source.size).toBe(payload.length);
    expect(Array.from(bytes)).toEqual([0x4b, 0x03]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.method === 'HEAD')).toBe(true);
    expect(calls.every((call) => call.thisArg === globalThis)).toBe(true);
  });

  it('环境没有 fetch 时给出明确错误', async () => {
    globalThis.fetch = undefined as unknown as typeof fetch;

    await expect(
      openByteSource({ kind: 'url', url: 'https://example.test/a.ofd' }),
    ).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });
});
