import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/resource/cache';

describe('LruCache', () => {
  it('按条目预算淘汰最久未使用项，get 刷新顺序', () => {
    const cache = new LruCache<string, number>({ maxBytes: 0, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.stats()).toEqual({ entries: 2, bytes: 2 });
  });

  it('按字节预算淘汰，并统计 bytes', () => {
    const cache = new LruCache<string, string>({ maxBytes: 5, maxEntries: 0 }, (value) => value.length);
    cache.set('a', '123');
    cache.set('b', '456');
    expect(cache.stats()).toEqual({ entries: 1, bytes: 3 });
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('456');
  });

  it('delete/clear 正确维护统计', () => {
    const cache = new LruCache<string, string>({ maxBytes: 0, maxEntries: 0 }, (value) => value.length);
    cache.set('a', '12');
    cache.set('b', '345');
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 3 });
    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});