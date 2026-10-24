import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installArrayFlatMap,
  installBlobArrayBuffer,
  installCompat,
  installGlobalThis,
  installPromiseAllSettled,
} from '../../src/compat';

/** 可删除属性的 Promise 视图，用于模拟 Chrome 67 缺失 API。 */
type MutablePromise = { allSettled?: unknown };
/** 可删除属性的 Array.prototype 视图。 */
type MutableArrayPrototype = { flatMap?: unknown };
/** 可删除属性的 Blob.prototype 视图。 */
type MutableBlobPrototype = { arrayBuffer?: unknown };
/** 补丁作用域。 */
type CompatScope = Record<string, unknown>;

const NATIVE_ALL_SETTLED = Promise.allSettled;
const NATIVE_FLAT_MAP = Array.prototype.flatMap;
const NATIVE_BLOB_ARRAY_BUFFER = Blob.prototype.arrayBuffer;

const globalScope = globalThis as unknown as CompatScope;

/**
 * 还原测试期间删除/替换的原生 API。
 *
 * 兼容补丁会改写进程级全局对象，必须逐个还原，避免污染同进程内其他测试文件。
 */
function restoreNatives(): void {
  if ((Promise as MutablePromise).allSettled !== NATIVE_ALL_SETTLED) {
    Object.defineProperty(Promise, 'allSettled', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: NATIVE_ALL_SETTLED,
    });
  }
  if ((Array.prototype as MutableArrayPrototype).flatMap !== NATIVE_FLAT_MAP) {
    Object.defineProperty(Array.prototype, 'flatMap', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: NATIVE_FLAT_MAP,
    });
  }
  if ((Blob.prototype as MutableBlobPrototype).arrayBuffer !== NATIVE_BLOB_ARRAY_BUFFER) {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: NATIVE_BLOB_ARRAY_BUFFER,
    });
  }
}

afterEach(() => {
  restoreNatives();
});

describe('compat：原生分支', () => {
  it('原生 API 存在时不覆盖原生实现', () => {
    // 模块导入时已自动安装过一次，此时四种 API 都是 Node 原生实现。
    expect(Promise.allSettled).toBe(NATIVE_ALL_SETTLED);
    expect(Array.prototype.flatMap).toBe(NATIVE_FLAT_MAP);
    expect(Blob.prototype.arrayBuffer).toBe(NATIVE_BLOB_ARRAY_BUFFER);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('ofdrw.viewer.compat.engine.v1')]).toBe(
      true,
    );

    installCompat();
    expect(Promise.allSettled).toBe(NATIVE_ALL_SETTLED);
    expect(Array.prototype.flatMap).toBe(NATIVE_FLAT_MAP);
    expect(Blob.prototype.arrayBuffer).toBe(NATIVE_BLOB_ARRAY_BUFFER);
  });

  it('globalThis 已存在时保持原值', () => {
    const scope: CompatScope = { globalThis: 'sentinel' };
    installGlobalThis(scope);
    expect(scope.globalThis).toBe('sentinel');
  });
});

describe('compat：缺失分支', () => {
  it('入口导入时自动补齐缺失 API', async () => {
    delete (Promise as MutablePromise).allSettled;
    delete (Array.prototype as MutableArrayPrototype).flatMap;
    delete (Blob.prototype as MutableBlobPrototype).arrayBuffer;
    vi.resetModules();
    try {
      await import('../../src/compat');
      expect(typeof Promise.allSettled).toBe('function');
      expect(typeof Array.prototype.flatMap).toBe('function');
      expect(typeof Blob.prototype.arrayBuffer).toBe('function');
    } finally {
      restoreNatives();
      vi.resetModules();
    }
  });

  it('公共入口导入时先安装兼容补丁', async () => {
    delete (Promise as MutablePromise).allSettled;
    delete (Array.prototype as MutableArrayPrototype).flatMap;
    delete (Blob.prototype as MutableBlobPrototype).arrayBuffer;
    vi.resetModules();
    try {
      const entry = await import('../../src/index');
      expect(typeof entry.OFDDocument).toBe('function');
      expect(typeof Promise.allSettled).toBe('function');
      expect(typeof Array.prototype.flatMap).toBe('function');
      expect(typeof Blob.prototype.arrayBuffer).toBe('function');
    } finally {
      restoreNatives();
      vi.resetModules();
    }
  }, 60_000);

  it('缺失 globalThis 时安装为全局对象自身', () => {
    const scope: CompatScope = {};
    installGlobalThis(scope);
    expect(scope.globalThis).toBe(scope);
  });

  it('Promise.allSettled 结果形状、顺序与原生一致', async () => {
    delete (Promise as MutablePromise).allSettled;
    installPromiseAllSettled(globalScope);

    const reason = new Error('boom');
    const settled = await Promise.allSettled([
      Promise.resolve(1),
      Promise.reject(reason),
      { then: (resolve: (value: number) => void) => resolve(2) },
    ]);
    expect(settled).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', reason },
      { status: 'fulfilled', value: 2 },
    ]);
  });

  it('Promise.allSettled 空输入立即完成、非可迭代输入以 TypeError 拒绝', async () => {
    delete (Promise as MutablePromise).allSettled;
    installPromiseAllSettled(globalScope);

    await expect(Promise.allSettled([])).resolves.toEqual([]);
    await expect(Promise.allSettled(1 as unknown as Iterable<unknown>)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      Promise.allSettled({ length: 1, 0: 'x' } as unknown as Iterable<unknown>),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('Array.prototype.flatMap 只展开一层并透传参数', () => {
    delete (Array.prototype as MutableArrayPrototype).flatMap;
    installArrayFlatMap(globalScope);

    expect([1, 2, 3].flatMap((value) => [value, value * 2])).toEqual([1, 2, 2, 4, 3, 6]);
    expect([[1], [2, 3]].flatMap((value) => value)).toEqual([1, 2, 3]);
    expect([1].flatMap(() => [[2]])).toEqual([[2]]);

    const calls: unknown[] = [];
    const source = [7];
    expect(
      source.flatMap((value, index, array) => {
        calls.push([value, index, array]);
        return [];
      }),
    ).toEqual([]);
    expect(calls).toEqual([[7, 0, source]]);
  });

  it('Array.prototype.flatMap 跳过稀疏空位', () => {
    delete (Array.prototype as MutableArrayPrototype).flatMap;
    installArrayFlatMap(globalScope);

    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(sparse.flatMap((value) => [value])).toEqual([1, 3]);
  });

  it('Array.prototype.flatMap 对 null 接收者与非函数回调抛 TypeError', () => {
    delete (Array.prototype as MutableArrayPrototype).flatMap;
    installArrayFlatMap(globalScope);

    const flatMap = Array.prototype.flatMap as (this: unknown, callback: unknown) => unknown;
    expect(() => flatMap.call(null, () => [])).toThrow(TypeError);
    expect(() => flatMap.call(undefined, () => [])).toThrow(TypeError);
    expect(() => flatMap.call([1], null)).toThrow(TypeError);
  });

  it('Blob.prototype.arrayBuffer 缺失时读取真实字节', async () => {
    delete (Blob.prototype as MutableBlobPrototype).arrayBuffer;
    installBlobArrayBuffer(globalScope);

    expect(typeof Blob.prototype.arrayBuffer).toBe('function');
    const buffer = await new Blob(['abc']).arrayBuffer();
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(new Uint8Array(buffer))).toBe('abc');
  });
});