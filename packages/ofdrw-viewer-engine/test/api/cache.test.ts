/**
 * T7 公共 API 缓存：LRU 淘汰、字节预算与释放回调。
 */

import { describe, expect, it } from 'vitest';
import { DisposableLruCache } from '../../src/api/cache';

describe('DisposableLruCache', () => {
  it('按最近使用顺序淘汰并释放值', () => {
    const disposed: string[] = [];
    const cache = new DisposableLruCache<string, string>({
      maxEntries: 2,
      sizeOf: () => 1,
      dispose: (value) => disposed.push(value),
    });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a');
    cache.set('c', 'C');
    expect(cache.has('b')).toBe(false);
    expect(disposed).toEqual(['B']);
    expect(cache.stats()).toEqual({ entries: 2, bytes: 2 });
  });

  it('按字节预算淘汰，delete/clear 触发释放', () => {
    const disposed: string[] = [];
    const cache = new DisposableLruCache<string, string>({
      maxBytes: 6,
      sizeOf: (value) => value.length,
      dispose: (value) => disposed.push(value),
    });
    cache.set('a', 'aaa');
    cache.set('b', 'bbb');
    // a+b 正好 6 字节；写入 c 后超预算，淘汰最久未使用的 a。
    cache.set('c', 'ccc');
    expect(cache.has('a')).toBe(false);
    expect(cache.stats().bytes).toBe(6);
    cache.delete('b');
    cache.clear();
    expect(disposed).toEqual(['aaa', 'bbb', 'ccc']);
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('重新写入同键先释放旧值', () => {
    const disposed: string[] = [];
    const cache = new DisposableLruCache<string, string>({
      maxEntries: 1,
      sizeOf: () => 1,
      dispose: (value) => disposed.push(value),
    });
    cache.set('a', 'old');
    cache.set('a', 'new');
    expect(disposed).toEqual(['old']);
    expect(cache.get('a')).toBe('new');
  });
});
