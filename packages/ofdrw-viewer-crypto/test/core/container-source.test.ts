/**
 * 加密源到 engine 来源的桥接回归：engine 已移除 `OFDSource.url`。
 *
 * `toEngineSource` 不再把 `CryptoSource.url` 映射为 engine 来源；URL 能力保留在
 * crypto 层（`openCryptoContainer` 先读成字节），直接调用桥接函数时给出明确错误。
 */

import { describe, expect, it } from 'vitest';
import { toEngineSource } from '../../src/source/container-source';

describe('toEngineSource', () => {
  it('url 来源抛出 CRYPTO_SOURCE_UNSUPPORTED', () => {
    let error: unknown;
    try {
      toEngineSource({ kind: 'url', url: 'https://example.test/a.ofd' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'CRYPTO_SOURCE_UNSUPPORTED',
      message: expect.stringContaining('engine 不再接受 url 来源'),
    });
  });

  it('arraybuffer/blob/byte-source 仍映射为 engine 支持的来源', () => {
    const data = Uint8Array.of(1, 2);
    expect(toEngineSource({ kind: 'arraybuffer', data })).toEqual({ kind: 'arraybuffer', data });

    const blob = new Blob([data]);
    expect(toEngineSource({ kind: 'blob', blob })).toEqual({ kind: 'blob', blob });

    const source = { size: data.byteLength, read: async () => data };
    expect(toEngineSource({ kind: 'byte-source', source })).toMatchObject({ kind: 'custom' });
  });
});