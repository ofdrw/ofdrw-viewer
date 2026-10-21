import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/common/lru';
import { hashBytes, hashParts, hashString } from '../../src/common/hash';
import { assertFinite, assertNonNegative, clamp, clamp01, invariant } from '../../src/common/assert';

describe('common/lru', () => {
  it('按条目数淘汰最久未使用项，get 会刷新顺序', () => {
    const cache = new LruCache<string, number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
    const stats = cache.stats();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(0);
    expect(stats.evictions).toBe(1);
  });

  it('按字节预算淘汰，并统计当前字节数', () => {
    const cache = new LruCache<string, string>({
      maxBytes: 5,
      sizeOf: (value) => value.length,
    });
    cache.set('a', 'aa');
    cache.set('b', 'bb');
    cache.set('c', 'cc');
    expect(cache.bytes).toBe(4);
    expect(cache.has('a')).toBe(false);
    cache.set('d', 'dddd');
    expect(cache.has('d')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.bytes).toBe(4);
  });

  it('单条超过字节预算时不缓存', () => {
    const cache = new LruCache<string, string>({ maxBytes: 2, sizeOf: (value) => value.length });
    cache.set('big', 'abc');
    expect(cache.has('big')).toBe(false);
    expect(cache.stats().evictions).toBe(1);
  });

  it('delete/clear/peek 行为正确', () => {
    const cache = new LruCache<string, number>({ maxEntries: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.peek('a')).toBe(1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('common/hash', () => {
  it('相同输入哈希稳定，不同输入哈希不同', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(hashBytes(bytes)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashBytes(bytes)).toBe(hashBytes(new Uint8Array([1, 2, 3])));
    expect(hashBytes(bytes)).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
    expect(hashString('中文')).toBe(hashString('中文'));
    expect(hashString('中文')).not.toBe(hashString('中'));
  });

  it('hashParts 区分分隔位置与 undefined/null', () => {
    expect(hashParts(['a', 1])).toBe(hashParts(['a', 1]));
    expect(hashParts(['ab', 1])).not.toBe(hashParts(['a', 'b1']));
    expect(hashParts([undefined])).toBe(hashParts([null]));
  });
});

describe('common/assert', () => {
  it('断言与夹紧', () => {
    expect(() => invariant(false, 'boom')).toThrow('boom');
    expect(() => assertFinite(Number.NaN, 'x')).toThrow('x');
    expect(() => assertNonNegative(-1, 'y')).toThrow('y');
    expect(assertFinite(1.5, 'x')).toBe(1.5);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(Number.NaN, 0, 3)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
});