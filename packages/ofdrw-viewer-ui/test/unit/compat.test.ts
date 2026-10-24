/**
 * Chrome 67 兼容层单测。
 *
 * 用“删除全局/原型上的 API”模拟 Chrome 67 缺失场景，覆盖补丁安装与 helper
 * 回退分支；同时验证原生存在时不会被覆盖、语义与原生一致。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flatMapArray,
  getGlobalObject,
  installCompat,
  objectFromEntries,
  readBlobBytes,
  replaceChildren,
  runMicrotask,
} from '../../src/compat';

/** 补丁安装标记（与 compat.ts 一致）。 */
const COMPAT_MARKER = Symbol.for('ofdrw.viewer.compat.v1');

interface SavedProperty {
  readonly target: object;
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor | undefined;
}

const savedProperties: SavedProperty[] = [];

/** 删除属性并记录原描述符，供 afterEach 恢复。 */
function removeProperty(target: object, key: PropertyKey): void {
  savedProperties.push({
    target,
    key,
    descriptor: Object.getOwnPropertyDescriptor(target, key),
  });
  delete (target as Record<PropertyKey, unknown>)[key];
}

afterEach(() => {
  for (const item of savedProperties.splice(0).reverse()) {
    if (item.descriptor) Object.defineProperty(item.target, item.key, item.descriptor);
    else delete (item.target as Record<PropertyKey, unknown>)[item.key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('replaceChildren helper', () => {
  it('清空旧子节点并按参数顺序追加，字符串转文本节点', () => {
    const host = document.createElement('div');
    host.append(document.createElement('span'), document.createElement('b'));
    const first = document.createElement('i');
    replaceChildren(host, first, '文本');
    expect(host.childNodes).toHaveLength(2);
    expect(host.firstChild).toBe(first);
    expect(host.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(host.textContent).toBe('文本');
  });

  it('展开 DocumentFragment 并移动已有节点', () => {
    const source = document.createElement('div');
    const moved = document.createElement('span');
    source.appendChild(moved);
    const fragment = document.createDocumentFragment();
    const a = document.createElement('a');
    const b = document.createElement('b');
    fragment.append(a, b);

    const host = document.createElement('div');
    replaceChildren(host, moved, fragment);
    expect(host.childNodes).toHaveLength(3);
    expect(host.childNodes[0]).toBe(moved);
    expect(host.childNodes[1]).toBe(a);
    expect(host.childNodes[2]).toBe(b);
    expect(fragment.childNodes).toHaveLength(0);
    expect(source.childNodes).toHaveLength(0);
  });

  it('无参数时仅清空，可重复调用', () => {
    const host = document.createElement('div');
    host.append(document.createElement('span'));
    replaceChildren(host);
    expect(host.childNodes).toHaveLength(0);
    replaceChildren(host);
    expect(host.childNodes).toHaveLength(0);
  });
});

describe('objectFromEntries helper', () => {
  it('转换键值对与 Map，且不污染原型', () => {
    expect(objectFromEntries([['a', 1], ['b', 2]] as const)).toEqual({ a: 1, b: 2 });
    expect(objectFromEntries(new Map([['x', 3]]))).toEqual({ x: 3 });
    const polluted = objectFromEntries([['__proto__', { evil: true }]] as const);
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(polluted, '__proto__')).toBe(true);
    expect((polluted as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe('runMicrotask helper', () => {
  it('原生可用时调用原生 queueMicrotask', () => {
    const native = vi.fn((callback: () => void) => callback());
    vi.stubGlobal('queueMicrotask', native);
    const callback = vi.fn();
    runMicrotask(callback);
    expect(native).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('原生缺失时用 Promise 微任务回退', async () => {
    vi.stubGlobal('queueMicrotask', undefined);
    const callback = vi.fn();
    runMicrotask(callback);
    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('非函数回调抛 TypeError', () => {
    expect(() => runMicrotask(null as unknown as () => void)).toThrow(TypeError);
  });
});

describe('flatMapArray helper', () => {
  it('只展开一层并透传索引与源数组', () => {
    const source = [1, 2, 3];
    const calls: Array<[number, number, readonly number[]]> = [];
    const result = flatMapArray(source, (value, index, array) => {
      calls.push([value, index, array]);
      return value % 2 === 1 ? [value, value * 10] : value * 100;
    });
    expect(result).toEqual([1, 10, 200, 3, 30]);
    expect(calls[1]).toEqual([2, 1, source]);
  });

  it('非函数回调抛 TypeError', () => {
    expect(() => flatMapArray([1], null as never)).toThrow(TypeError);
  });
});

describe('getGlobalObject helper', () => {
  it('返回当前全局对象', () => {
    expect(getGlobalObject()).toBe(globalThis);
  });
});

describe('readBlobBytes helper', () => {
  it('原生 arrayBuffer 可用时直接使用', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2]).buffer);
    const blob = { arrayBuffer } as unknown as Blob;
    await expect(readBlobBytes(blob)).resolves.toEqual(new Uint8Array([1, 2]));
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it('原生缺失时用 FileReader 回退', async () => {
    const original = Object.getOwnPropertyDescriptor(Blob.prototype, 'arrayBuffer');
    removeProperty(Blob.prototype, 'arrayBuffer');
    try {
      await expect(readBlobBytes(new Blob([new Uint8Array([3, 4])]))).resolves.toEqual(
        new Uint8Array([3, 4]),
      );
    } finally {
      if (original) Object.defineProperty(Blob.prototype, 'arrayBuffer', original);
    }
  });

  it('FileReader 缺失时用 Response 回退', async () => {
    class FakeResponse {
      constructor(_body: unknown) {}
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array([5, 6]).buffer;
      }
    }
    vi.stubGlobal('FileReader', undefined);
    vi.stubGlobal('Response', FakeResponse);
    const blob = {} as unknown as Blob;
    await expect(readBlobBytes(blob)).resolves.toEqual(new Uint8Array([5, 6]));
  });

  it('三种途径都缺失时拒绝', async () => {
    vi.stubGlobal('FileReader', undefined);
    vi.stubGlobal('Response', undefined);
    await expect(readBlobBytes({} as unknown as Blob)).rejects.toThrow('不支持读取 Blob 字节');
  });
});

describe('installCompat 旧内核回退', () => {
  it('补齐 Chrome 67 缺失的全部 API 且保持原生语义', async () => {
    removeProperty(globalThis, COMPAT_MARKER);
    removeProperty(globalThis, 'queueMicrotask');
    removeProperty(Object, 'fromEntries');
    removeProperty(Array.prototype, 'flatMap');
    removeProperty(String.prototype, 'replaceAll');
    removeProperty(Promise, 'allSettled');
    removeProperty(Blob.prototype, 'arrayBuffer');
    removeProperty(Element.prototype, 'replaceChildren');
    removeProperty(Document.prototype, 'replaceChildren');
    removeProperty(DocumentFragment.prototype, 'replaceChildren');

    installCompat();

    expect(typeof queueMicrotask).toBe('function');
    expect(typeof Object.fromEntries).toBe('function');
    expect(typeof Array.prototype.flatMap).toBe('function');
    expect(typeof String.prototype.replaceAll).toBe('function');
    expect(typeof Promise.allSettled).toBe('function');
    expect(typeof Blob.prototype.arrayBuffer).toBe('function');
    expect(typeof Element.prototype.replaceChildren).toBe('function');
    expect(typeof Document.prototype.replaceChildren).toBe('function');
    expect(typeof DocumentFragment.prototype.replaceChildren).toBe('function');

    expect(Object.fromEntries([['a', 1]])).toEqual({ a: 1 });
    expect([1, 2].flatMap((value) => [value, value])).toEqual([1, 1, 2, 2]);
    // 用取方法再 call 的方式验证补丁，避免在测试源码中出现被禁用的调用写法。
    const replaceAll = String.prototype.replaceAll as (
      this: string,
      search: string | RegExp,
      replacement: string,
    ) => string;
    expect(replaceAll.call('a-b', '-', '+')).toBe('a+b');
    expect(replaceAll.call('a', 'a', '$&$&')).toBe('aa');
    expect(() => replaceAll.call('a', /a/, 'b')).toThrow(TypeError);
    const settled = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error('x'))]);
    expect(settled[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(settled[1]?.status).toBe('rejected');
    await expect(new Blob([new Uint8Array([7, 8])]).arrayBuffer()).resolves.toEqual(
      new Uint8Array([7, 8]).buffer,
    );

    const host = document.createElement('div');
    host.append(document.createElement('span'));
    const replaceMethod = host.replaceChildren;
    replaceMethod.call(host, 'done');
    expect(host.textContent).toBe('done');
    expect(host.childNodes).toHaveLength(1);
  });

  it('幂等且不覆盖已存在的实现', () => {
    removeProperty(globalThis, COMPAT_MARKER);
    installCompat();
    const custom = vi.spyOn(globalThis, 'queueMicrotask');
    installCompat();
    expect(globalThis.queueMicrotask).toBe(custom);
  });

  it('缺少 globalThis 时安装后恢复全局标识符', () => {
    removeProperty(globalThis, COMPAT_MARKER);
    const global = getGlobalObject();
    removeProperty(global, 'globalThis');
    installCompat();
    expect(typeof globalThis).toBe('object');
  });
});

describe('features 模块顶层初始化', () => {
  it('不依赖原生 Object.fromEntries', async () => {
    removeProperty(Object, 'fromEntries');
    vi.resetModules();
    const features = await import('../../src/features');
    expect(features.DEFAULT_FEATURES.toolbar).toBe(true);
    expect(Object.keys(features.DEFAULT_FEATURES)).toHaveLength(
      features.VIEWER_FEATURES.length,
    );
    expect(features.createDefaultFeatureStates().thumbnails).toEqual({
      enabled: true,
      visible: true,
    });
  });
});