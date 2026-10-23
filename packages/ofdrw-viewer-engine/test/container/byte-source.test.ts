import { describe, expect, it } from 'vitest';
import { ArrayBufferSource, BlobSource } from '../../src/container/byte-source';

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
});