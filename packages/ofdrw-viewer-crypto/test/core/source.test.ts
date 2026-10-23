import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCryptoSource, type CryptoSource } from '@ofdrw/ofdrw-viewer-crypto';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readCryptoSource', () => {
  it('读取 arraybuffer 来源', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    await expect(readCryptoSource({ kind: 'arraybuffer', data: bytes })).resolves.toEqual(bytes);
    await expect(
      readCryptoSource({ kind: 'arraybuffer', data: bytes.buffer }),
    ).resolves.toEqual(bytes);
  });

  it('读取 blob 来源', async () => {
    const blob = new Blob([Uint8Array.of(4, 5, 6)]);
    await expect(readCryptoSource({ kind: 'blob', blob })).resolves.toEqual(
      Uint8Array.of(4, 5, 6),
    );
  });

  it('读取 url 来源并支持取消', async () => {
    const source: CryptoSource = {
      kind: 'url',
      url: 'data:application/octet-stream;base64,AAEC',
    };
    await expect(readCryptoSource(source)).resolves.toEqual(Uint8Array.of(0, 1, 2));

    const controller = new AbortController();
    controller.abort();
    await expect(readCryptoSource(source, { signal: controller.signal })).rejects.toMatchObject({
      code: 'CRYPTO_ABORTED',
    });
  });

  it('HTTP 失败映射为 CRYPTO_SOURCE_UNSUPPORTED', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(
      readCryptoSource({ kind: 'url', url: 'https://example.invalid/cert' }),
    ).rejects.toMatchObject({ code: 'CRYPTO_SOURCE_UNSUPPORTED', message: expect.stringContaining('HTTP 404') });
  });

  it('无 Content-Length 的 URL 响应按流式字节累计拒绝超限', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.enqueue(Uint8Array.of(3, 4));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', async () => new Response(stream));
    await expect(
      readCryptoSource(
        { kind: 'url', url: 'https://example.invalid/big.ofd' },
        { maxBytes: 3 },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
  });

  it('无法流式读取且缺少 Content-Length 的 URL 响应被拒绝', async () => {
    vi.stubGlobal('fetch', async () => new Response(null));
    await expect(
      readCryptoSource({ kind: 'url', url: 'https://example.invalid/unknown.ofd' }),
    ).rejects.toMatchObject({ code: 'CRYPTO_SOURCE_UNSUPPORTED' });
  });

  it('强制 maxBytes 上限', async () => {
    await expect(
      readCryptoSource(
        { kind: 'arraybuffer', data: Uint8Array.of(1, 2, 3, 4) },
        { maxBytes: 3 },
      ),
    ).rejects.toMatchObject({ code: 'CRYPTO_LIMIT_EXCEEDED' });
  });

  it('拒绝未知输入源与非法上限', async () => {
    await expect(
      readCryptoSource({ kind: 'file' } as unknown as CryptoSource),
    ).rejects.toMatchObject({ code: 'CRYPTO_SOURCE_UNSUPPORTED' });
    await expect(
      readCryptoSource({ kind: 'arraybuffer', data: Uint8Array.of(1) }, { maxBytes: 0 }),
    ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
  });
});