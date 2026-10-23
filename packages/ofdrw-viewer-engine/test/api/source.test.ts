/**
 * `openByteSource` 纯适配测试：只接受 arraybuffer/blob/custom；
 * 旧来源（url/node-file/wechat-file）在运行期给出带迁移指引的明确错误。
 */

import { describe, expect, it } from 'vitest';
import { openByteSource } from '../../src/api/source';
import type { OFDSource } from '../../src/platform/source';
import type { ByteSource } from '../../src/platform/byte-source';
import { isOFDError } from '../../src/errors';

/**
 * 捕获 promise 拒绝并返回错误。
 *
 * @param promise 待观察的 promise。
 * @returns 拒绝原因。
 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

describe('openByteSource', () => {
  it('arraybuffer 来源支持 ArrayBuffer 与 Uint8Array', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fromView = await openByteSource({ kind: 'arraybuffer', data: bytes });
    expect(fromView.size).toBe(4);
    expect([...(await fromView.read(1, 2))]).toEqual([2, 3]);

    const buffer = bytes.buffer.slice(0) as ArrayBuffer;
    const fromBuffer = await openByteSource({ kind: 'arraybuffer', data: buffer });
    expect(fromBuffer.size).toBe(4);
    expect([...(await fromBuffer.read(0, 4))]).toEqual([1, 2, 3, 4]);
  });

  it('arraybuffer 为空或类型非法时拒绝', async () => {
    await expect(
      openByteSource({ kind: 'arraybuffer', data: new Uint8Array(0) }),
    ).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
    await expect(
      openByteSource({ kind: 'arraybuffer', data: 'nope' as unknown as ArrayBuffer }),
    ).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('blob 来源包装为 BlobSource', async () => {
    const blob = new Blob([new Uint8Array([5, 6, 7])]);
    const source = await openByteSource({ kind: 'blob', blob });
    expect(source.size).toBe(3);
    expect([...(await source.read(1, 2))]).toEqual([6, 7]);
  });

  it('blob 为空或非 Blob 时拒绝', async () => {
    await expect(
      openByteSource({ kind: 'blob', blob: new Blob([]) }),
    ).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
    await expect(
      openByteSource({ kind: 'blob', blob: {} as Blob }),
    ).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('custom 来源原样返回且按需读取', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const custom: ByteSource = {
      size: bytes.byteLength,
      async read(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    };
    const source = await openByteSource({ kind: 'custom', source: custom });
    expect(source).toBe(custom);
    expect([...(await source.read(0, 2))]).toEqual([9, 8]);
  });

  it('custom 来源缺少 read 时拒绝', async () => {
    await expect(
      openByteSource({ kind: 'custom', source: {} as ByteSource }),
    ).rejects.toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
  });

  it('url 来源在运行期提示下载后传 arraybuffer/blob/custom', async () => {
    const legacy = { kind: 'url', url: 'https://example.test/a.ofd' } as unknown as OFDSource;
    const error = await rejectOf(openByteSource(legacy));
    expect(isOFDError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
    expect((error as Error).message).toContain('engine 不再负责网络获取');
    expect((error as Error).message).toContain('custom ByteSource');
  });

  it.each(['node-file', 'wechat-file'])('%s 来源在运行期提示改用 custom', async (kind) => {
    const legacy = {
      kind,
      ...(kind === 'node-file' ? { path: '/tmp/a.ofd' } : { filePath: 'wxfile://tmp/a.ofd' }),
    } as unknown as OFDSource;
    const error = await rejectOf(openByteSource(legacy));
    expect(isOFDError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'OFD_RENDERER_UNSUPPORTED' });
    expect((error as Error).message).toContain("kind: 'custom'");
  });

  it('未知来源类型带实际 kind', async () => {
    const unknown = { kind: 'mystery' } as unknown as OFDSource;
    const error = await rejectOf(openByteSource(unknown));
    expect(error).toMatchObject({ code: 'OFD_INVALID_PACKAGE' });
    expect((error as Error).message).toContain('mystery');
  });
});