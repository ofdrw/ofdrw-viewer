/**
 * 默认 ZIP 虚拟容器：条目元数据、读取限制、warning 与关闭语义。
 */

import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../src/platform/byte-source';
import { ZipVirtualContainer } from '../../src/container/zip-container';
import { ArrayBufferSource } from '../../src/container/byte-source';
import { OFDError } from '../../src/errors';
import type { OFDWarning } from '../../src/warnings';
import { buildZip } from './zip-fixture';

/** 读取错误码。 */
function codeOf(error: unknown): string | undefined {
  return error instanceof OFDError ? error.code : undefined;
}

/** 捕获拒绝并返回错误。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** UTF-8 编码。 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 带 close 计数的字节源。 */
class ClosableSource implements ByteSource {
  /** close 调用次数。 */
  closeCalls = 0;
  readonly size: number;

  private readonly inner: ArrayBufferSource;

  /**
   * @param bytes 完整字节。
   */
  constructor(bytes: Uint8Array) {
    this.inner = new ArrayBufferSource(bytes);
    this.size = this.inner.size;
  }

  /**
   * 读取区间。
   *
   * @param offset 起始偏移，byte。
   * @param length 读取长度，byte。
   * @returns 字节。
   */
  read(offset: number, length: number): Promise<Uint8Array> {
    return this.inner.read(offset, length);
  }

  /** 记录并完成关闭。 */
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** 构造一个默认 ZIP 容器。 */
async function openContainer(
  entries: Parameters<typeof buildZip>[0],
): Promise<ZipVirtualContainer> {
  return ZipVirtualContainer.open(new ArrayBufferSource(buildZip(entries)));
}

describe('container/zip-container', () => {
  it('list 返回按 path 升序的文件元数据，不含目录项', async () => {
    const container = await openContainer([
      { name: 'Doc_0/stored.txt', data: 'hello', method: 0 },
      { name: 'Doc_0/', data: new Uint8Array(0), externalAttributes: 0x10 },
      { name: 'OFD.xml', data: '<OFD/>' },
      { name: 'Doc_0/Res/image.png', data: utf8('PNG') },
    ]);
    try {
      const list = container.list();
      expect(list.map((meta) => meta.path)).toEqual([
        'Doc_0/Res/image.png',
        'Doc_0/stored.txt',
        'OFD.xml',
      ]);
      const stored = list.find((meta) => meta.path === 'Doc_0/stored.txt');
      expect(stored).toMatchObject({
        size: 5,
        compression: 'stored',
        origin: 'package',
      });
      expect(stored?.compressedSize).toBe(5);
      expect(list.find((meta) => meta.path === 'OFD.xml')?.compression).toBe('deflate');
      expect(container.packageSize).toBeGreaterThan(0);
      expect(container.encrypted).toBe(false);
    } finally {
      await container.close();
    }
  });

  it('has/stat 先规范化路径，非法路径返回 false/undefined 而不抛错', async () => {
    const container = await openContainer([
      { name: 'Doc_0/Res/image.png', data: utf8('PNG') },
    ]);
    try {
      expect(container.has('/Doc_0/Res/image.png')).toBe(true);
      expect(container.has('Doc_0//Res/./image.png')).toBe(true);
      expect(container.has('Doc_0/Res/missing.png')).toBe(false);
      expect(container.has('../escape.png')).toBe(false);
      expect(container.stat('Doc_0/Res/image.png')?.size).toBe(3);
      expect(container.stat('Doc_0/Res/missing.png')).toBeUndefined();
      expect(container.stat('../escape.png')).toBeUndefined();
    } finally {
      await container.close();
    }
  });

  it('read 返回明文并支持 maxBytes/缺失条目/取消信号语义', async () => {
    const payload = new Uint8Array(200);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 37) % 251;
    const container = await openContainer([{ name: 'Doc_0/data.bin', data: payload }]);
    try {
      const bytes = await container.read('Doc_0/data.bin');
      expect(bytes).toEqual(payload);

      const limitError = await rejectOf(container.read('Doc_0/data.bin', { maxBytes: 10 }));
      expect(codeOf(limitError)).toBe('OFD_LIMIT_EXCEEDED');

      const missing = await rejectOf(container.read('Doc_0/missing.bin'));
      expect(codeOf(missing)).toBe('OFD_ENTRY_NOT_FOUND');

      const controller = new AbortController();
      controller.abort();
      const aborted = await rejectOf(
        container.read('Doc_0/data.bin', { signal: controller.signal }),
      );
      expect(codeOf(aborted)).toBe('OFD_ABORTED');
    } finally {
      await container.close();
    }
  });

  it('read 转发 CRC warning，verifyChecksum=false 可关闭校验', async () => {
    const warnings: OFDWarning[] = [];
    const container = await openContainer([
      { name: 'Doc_0/bad.txt', data: 'hello', crcOverride: 0xdeadbeef },
    ]);
    try {
      const bytes = await container.read('Doc_0/bad.txt', {
        onWarning: (warning) => warnings.push(warning),
      });
      expect(new TextDecoder().decode(bytes)).toBe('hello');
      expect(warnings.map((warning) => warning.code)).toEqual(['W_BAD_NUMBER']);

      warnings.length = 0;
      await container.read('Doc_0/bad.txt', {
        verifyChecksum: false,
        onWarning: (warning) => warnings.push(warning),
      });
      expect(warnings).toEqual([]);
    } finally {
      await container.close();
    }
  });

  it('存在 Encryptions.xml 时 encrypted=true，read 返回存仓原始字节（raw 容器）', async () => {
    const cipher = Uint8Array.from([0x9a, 0x01, 0x02, 0x03]);
    const container = await openContainer([
      { name: 'OFD.xml', data: '<OFD/>' },
      { name: 'Doc_0/Res/payload.dat', data: cipher },
      { name: 'Encryptions.xml', data: '<Encryptions/>' },
    ]);
    try {
      expect(container.encrypted).toBe(true);
      // raw package container：不做解密，按存仓字节返回；crypto 负责解密后再注入 engine。
      expect(await container.read('Doc_0/Res/payload.dat')).toEqual(cipher);
    } finally {
      await container.close();
    }
  });

  it('close 幂等、关闭字节源，关闭后 list/read 抛 OFD_CLOSED、has/stat 降级', async () => {
    const source = new ClosableSource(
      buildZip([{ name: 'Doc_0/Document.xml', data: '<Document/>' }]),
    );
    const container = await ZipVirtualContainer.open(source);
    expect(source.closeCalls).toBe(0);

    await container.close();
    await container.close();
    expect(source.closeCalls).toBe(1);

    const listError = await rejectOf(Promise.resolve().then(() => container.list()));
    expect(codeOf(listError)).toBe('OFD_CLOSED');
    const readError = await rejectOf(container.read('Doc_0/Document.xml'));
    expect(codeOf(readError)).toBe('OFD_CLOSED');
    expect(container.has('Doc_0/Document.xml')).toBe(false);
    expect(container.stat('Doc_0/Document.xml')).toBeUndefined();
  });
});