/**
 * 明文内存容器：排序、读取副本、路径安全与关闭语义。
 */

import { describe, expect, it } from 'vitest';
import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import { MemoryVirtualContainer } from '../../src/container/index';

/**
 * 构造测试容器。
 *
 * @returns 容器与原始字节。
 */
function createContainer(): { container: MemoryVirtualContainer; bytes: Uint8Array } {
  const bytes = Uint8Array.of(1, 2, 3);
  return {
    container: new MemoryVirtualContainer(
      new Map([
        ['b.txt', { bytes }],
        ['a/c.txt', { bytes: Uint8Array.of(4) }],
      ]),
      100,
    ),
    bytes,
  };
}

describe('MemoryVirtualContainer', () => {
  it('按路径排序并暴露明文元数据', () => {
    const { container } = createContainer();
    expect(container.encrypted).toBe(false);
    expect(container.packageSize).toBe(100);
    expect(container.list().map((meta) => meta.path)).toEqual(['a/c.txt', 'b.txt']);
    expect(container.stat('/b.txt')?.size).toBe(3);
    expect(container.has('/a/c.txt')).toBe(true);
  });

  it('读取返回独立副本，调用方修改不影响缓存', async () => {
    const { container, bytes } = createContainer();
    const read = await container.read('b.txt');
    read[0] = 9;
    expect(bytes[0]).toBe(1);
    expect((await container.read('/b.txt'))[0]).toBe(1);
  });

  it('拒绝路径穿越与非法路径', () => {
    const { container } = createContainer();
    expect(container.has('../b.txt')).toBe(false);
    expect(container.stat('C:/b.txt')).toBeUndefined();
  });

  it('关闭幂等，关闭后 list/read 抛 OFD_CLOSED，has/stat 返回空', async () => {
    const { container } = createContainer();
    await container.close();
    await container.close();
    expect(() => container.list()).toThrowError(OFDError);
    await expect(container.read('b.txt')).rejects.toMatchObject({ code: 'OFD_CLOSED' });
    expect(container.has('b.txt')).toBe(false);
    expect(container.stat('b.txt')).toBeUndefined();
  });

  it('缺失条目按 engine 约定抛 OFD_ENTRY_NOT_FOUND', async () => {
    const { container } = createContainer();
    await expect(container.read('missing.txt')).rejects.toMatchObject({
      code: 'OFD_ENTRY_NOT_FOUND',
    });
  });

  it('读取上限与取消信号生效', async () => {
    const { container } = createContainer();
    await expect(container.read('b.txt', { maxBytes: 2 })).rejects.toMatchObject({
      code: 'OFD_LIMIT_EXCEEDED',
    });
    await expect(
      container.read('b.txt', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'OFD_ABORTED' });
  });

  it('构造时复制条目，外部修改原始字节不影响容器', async () => {
    const source = Uint8Array.of(1, 2, 3);
    const container = new MemoryVirtualContainer(new Map([['a.txt', { bytes: source }]]), 3);
    source[0] = 9;
    expect((await container.read('a.txt'))[0]).toBe(1);
    await container.close();
  });

  it('拒绝负数/非安全整数 packageSize', () => {
    expect(() => new MemoryVirtualContainer(new Map(), -1)).toThrowError(OFDError);
    expect(() => new MemoryVirtualContainer(new Map(), 1.5)).toThrowError(OFDError);
  });

  it('关闭与并发读取边界：关闭后读取一律 OFD_CLOSED', async () => {
    const { container } = createContainer();
    const first = container.read('b.txt');
    await container.close();
    await expect(first).resolves.toBeInstanceOf(Uint8Array);
    await expect(container.read('b.txt')).rejects.toMatchObject({ code: 'OFD_CLOSED' });
  });

  it('构造时拒绝重复路径', () => {
    expect(
      () =>
        new MemoryVirtualContainer(
          new Map([
            ['a.txt', { bytes: Uint8Array.of(1) }],
            ['/a.txt', { bytes: Uint8Array.of(2) }],
          ]),
          10,
        ),
    ).toThrowError(OFDError);
  });
});
