/**
 * Chrome 67 兼容层（UI）。
 *
 * 目标内核（Chrome 67，2018-05）缺少以下本项目会用到的 API：
 * `Blob.prototype.arrayBuffer`（76）、`Promise.allSettled`（76）、
 * `Object.fromEntries`（73）、`globalThis`（71）、`queueMicrotask`（71）、
 * `Array.prototype.flatMap`（69）、`String.prototype.replaceAll`（85）、
 * `Element.prototype.replaceChildren`（86）。
 *
 * 本模块是 UI 包唯一安装补丁的地方：
 * - 模块顶层自动调用一次 `installCompat()`（副作用），四个入口的第一条 import
 *   必须是 `import './compat'`，保证 `features.ts` 的模块顶层表达式求值前补丁已就位；
 * - 补丁只在原生缺失时定义，不覆盖原生实现，且安装幂等；
 * - 不在模块顶层直接访问 DOM，Node/Worker 中导入不会抛错；
 * - 同时导出若干调用点统一使用的 helper（替换调用点避免依赖加载顺序，
 *   也便于缺失 API 的分支测试）。
 *
 * 公共 API 不变：`./compat` 是附加子路径，helper 不进入包主入口。
 */

/** 全局安装标记；仅用于幂等与诊断，不作为公共 API。 */
const COMPAT_MARKER = Symbol.for('ofdrw.viewer.compat.v1');

/** flex `gap` 能力属性名（`data-ofd-flex-gap`）。 */
const FLEX_GAP_ATTR = 'data-ofd-flex-gap';

/** 可替换子节点的父节点类型。 */
export type ReplaceableParent = Element | Document | DocumentFragment;

/** `Promise.allSettled` 的单条结果。 */
export type AllSettledResult<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown };

/**
 * 读取全局对象。
 *
 * Chrome 67 没有 `globalThis`，因此按 `globalThis → self → window → Function`
 * 的顺序回退；正常环境只走第一个分支。
 *
 * @returns 当前运行环境的全局对象。
 */
export function getGlobalObject(): typeof globalThis {
  if (typeof globalThis !== 'undefined') return globalThis;
  if (typeof self !== 'undefined') return self as unknown as typeof globalThis;
  if (typeof window !== 'undefined') return window as unknown as typeof globalThis;
  return Function('return this')() as typeof globalThis;
}

/**
 * 替换父节点的全部子节点（`Element.prototype.replaceChildren` 的等价 helper）。
 *
 * 语义与 Chrome 86+ 原生实现一致：先清空全部子节点，再按参数顺序追加；
 * 字符串转文本节点，`DocumentFragment` 展开为子节点，已存在的节点被移动。
 *
 * @param target 目标父节点（Element / Document / DocumentFragment）。
 * @param nodes 新子节点或文本。
 */
export function replaceChildren(
  target: ReplaceableParent,
  ...nodes: readonly (Node | string)[]
): void {
  while (target.firstChild) target.removeChild(target.firstChild);
  if (nodes.length > 0) target.append(...(nodes as (Node | string)[]));
}

/**
 * 把键值对列表转换为对象（不依赖原生 `Object.fromEntries`）。
 *
 * 用 `Object.defineProperty` 写入，避免 `__proto__` 污染原型。
 *
 * @param entries 键值对可迭代对象。
 * @returns 新对象。
 */
export function objectFromEntries<K extends PropertyKey, V>(
  entries: Iterable<readonly [K, V]>,
): Record<K, V> {
  const result = {} as Record<K, V>;
  for (const entry of entries) {
    const [key, value] = entry;
    Object.defineProperty(result, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * 调度微任务（`queueMicrotask` 的等价 helper）。
 *
 * 原生可用时直接调用；缺失时用 `Promise.resolve().then()` 回退。回调抛错会
 * 与原生一致地变成未处理拒绝。
 *
 * @param callback 微任务回调。
 * @throws {TypeError} `callback` 不是函数时抛出。
 */
export function runMicrotask(callback: () => void): void {
  if (typeof callback !== 'function') {
    throw new TypeError('queueMicrotask 的回调必须是函数');
  }
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  Promise.resolve().then(callback);
}

/**
 * 映射并扁平化一层（`Array.prototype.flatMap` 的等价 helper）。
 *
 * @param items 源数组。
 * @param callback 映射回调；返回值是数组时展开一层，否则原样追加。
 * @returns 新数组。
 * @throws {TypeError} `callback` 不是函数时抛出。
 */
export function flatMapArray<T, U>(
  items: readonly T[],
  callback: (value: T, index: number, array: readonly T[]) => U | readonly U[],
): U[] {
  if (typeof callback !== 'function') {
    throw new TypeError('flatMap 的回调必须是函数');
  }
  const result: U[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const mapped = callback(items[index]!, index, items);
    if (Array.isArray(mapped)) {
      for (const value of mapped) result.push(value as U);
    } else {
      result.push(mapped as U);
    }
  }
  return result;
}

/**
 * 读取 Blob/File 的字节。
 *
 * 优先 `Blob.prototype.arrayBuffer`；缺失时用 `FileReader`；再缺失时用
 * `new Response(blob).arrayBuffer()`；三者都不可用时返回拒绝的 Promise。
 *
 * @param blob Blob 或 File。
 * @returns 字节副本。
 */
export function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  const withArrayBuffer = blob as Blob & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof withArrayBuffer.arrayBuffer === 'function') {
    return withArrayBuffer.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
          return;
        }
        reject(new Error('读取 Blob 失败：FileReader 未返回 ArrayBuffer'));
      };
      reader.onerror = () => {
        reject(reader.error ?? new Error('读取 Blob 失败'));
      };
      reader.onabort = () => {
        reject(new Error('读取 Blob 已取消'));
      };
      reader.readAsArrayBuffer(blob);
    });
  }
  if (typeof Response !== 'undefined') {
    return new Response(blob).arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return Promise.reject(new Error('当前环境不支持读取 Blob 字节'));
}

/**
 * 判断当前文档的 flex `gap` 是否真正生效。
 *
 * Chrome 67 接受 `gap` 声明但不参与 flex 布局，`CSS.supports('gap', ...)`
 * 会误报 true，因此必须实测：两个固定宽子元素的第二个起始位置应比无 gap 时
 * 右移 `gap` 距离。无法测量时按“不支持”处理（走 CSS 回退，现代内核的
 * 测量值为 true）。
 *
 * @param doc 目标文档。
 * @returns 支持时 true。
 */
export function detectFlexGap(doc: Document): boolean {
  if (!doc || !doc.documentElement) return false;
  const parent = doc.body ?? doc.documentElement;
  const container = doc.createElement('div');
  container.style.cssText =
    'position:absolute;visibility:hidden;display:flex;gap:4px;padding:0;margin:0;';
  const first = doc.createElement('div');
  first.style.cssText = 'width:10px;height:2px;flex:0 0 auto;';
  const second = doc.createElement('div');
  second.style.cssText = 'width:10px;height:2px;flex:0 0 auto;';
  container.append(first, second);
  parent.appendChild(container);
  try {
    const distance = second.getBoundingClientRect().left - first.getBoundingClientRect().left;
    return distance >= 13;
  } catch {
    return false;
  } finally {
    container.remove();
  }
}

/**
 * 安装当前包所需的 Chrome 67 兼容补丁。
 *
 * 幂等：重复调用直接返回。只在原生缺失时定义，不覆盖原生实现。
 */
export function installCompat(): void {
  const global = getGlobalObject();
  if ((global as Record<PropertyKey, unknown>)[COMPAT_MARKER]) return;

  defineIfMissing(global, 'globalThis', global);
  defineIfMissing(global, 'queueMicrotask', function queueMicrotaskPolyfill(
    this: unknown,
    callback: () => void,
  ): void {
    if (typeof callback !== 'function') {
      throw new TypeError('queueMicrotask 的回调必须是函数');
    }
    Promise.resolve().then(callback);
  } satisfies typeof queueMicrotask);

  defineIfMissing(Promise, 'allSettled', function allSettledPolyfill<T>(
    iterable: Iterable<T | PromiseLike<T>>,
  ): Promise<AllSettledResult<T>[]> {
    return new Promise<AllSettledResult<T>[]>((resolve, reject) => {
      let items: Array<T | PromiseLike<T>>;
      try {
        items = Array.from(iterable);
      } catch (error) {
        reject(error);
        return;
      }
      const results = new Array<AllSettledResult<T>>(items.length);
      let remaining = items.length;
      if (remaining === 0) {
        resolve(results);
        return;
      }
      items.forEach((item, index) => {
        Promise.resolve(item).then(
          (value) => {
            results[index] = { status: 'fulfilled', value };
            remaining -= 1;
            if (remaining === 0) resolve(results);
          },
          (reason) => {
            results[index] = { status: 'rejected', reason };
            remaining -= 1;
            if (remaining === 0) resolve(results);
          },
        );
      });
    });
  });

  defineIfMissing(Object, 'fromEntries', function fromEntriesPolyfill(
    entries: Iterable<readonly [PropertyKey, unknown]>,
  ): Record<PropertyKey, unknown> {
    if (entries === null || entries === undefined) {
      throw new TypeError('Object.fromEntries 需要可迭代的键值对列表');
    }
    return objectFromEntries(entries);
  });

  defineIfMissing(Array.prototype, 'flatMap', function flatMapPolyfill<T, U>(
    this: readonly T[],
    callback: (value: T, index: number, array: readonly T[]) => U | readonly U[],
    thisArg?: unknown,
  ): U[] {
    if (this === null || this === undefined) {
      throw new TypeError('Array.prototype.flatMap 的 this 不能为空');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('Array.prototype.flatMap 的回调必须是函数');
    }
    const items = Object(this) as readonly T[];
    const bound = thisArg === undefined ? callback : callback.bind(thisArg);
    return flatMapArray(items, bound as typeof callback);
  });

  defineIfMissing(String.prototype, 'replaceAll', function replaceAllPolyfill(
    this: string,
    search: string | RegExp,
    replacement: string,
  ): string {
    if (this === null || this === undefined) {
      throw new TypeError('String.prototype.replaceAll 的 this 不能为空');
    }
    const source = String(this);
    if (search instanceof RegExp) {
      if (!search.global) {
        throw new TypeError('String.prototype.replaceAll 的正则必须带 g 标志');
      }
      return source.replace(search, replacement);
    }
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.replace(new RegExp(escaped, 'g'), replacement);
  });

  if (typeof Blob !== 'undefined') {
    defineIfMissing(Blob.prototype, 'arrayBuffer', function blobArrayBufferPolyfill(
      this: Blob,
    ): Promise<ArrayBuffer> {
      return readBlobBytesViaFileReader(this);
    });
  }

  // 逐个 typeof 守卫：Node/Worker 中没有 DOM 构造器，不能直接写进数组字面量。
  const replaceablePrototypes: object[] = [];
  if (typeof Element !== 'undefined') replaceablePrototypes.push(Element.prototype);
  if (typeof Document !== 'undefined') replaceablePrototypes.push(Document.prototype);
  if (typeof DocumentFragment !== 'undefined') {
    replaceablePrototypes.push(DocumentFragment.prototype);
  }
  for (const prototype of replaceablePrototypes) {
    defineIfMissing(prototype, 'replaceChildren', function replaceChildrenPolyfill(
      this: ReplaceableParent,
      ...nodes: Array<Node | string>
    ): void {
      replaceChildren(this, ...nodes);
    });
  }

  installFlexGapProbe(global);
  defineIfMissing(global, COMPAT_MARKER, true);
}

/**
 * 仅在目标缺少该属性时定义；已存在（包括原生实现）时保持不动。
 *
 * @param target 目标对象。
 * @param name 属性名。
 * @param value 属性值。
 */
function defineIfMissing(target: object, name: PropertyKey, value: unknown): void {
  if (name in target) return;
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/**
 * 把 flex gap 探测结果写到 `<html data-ofd-flex-gap="yes|none">`。
 *
 * 只在存在 `document.documentElement` 时执行；重复调用幂等。
 *
 * @param global 全局对象。
 */
function installFlexGapProbe(global: typeof globalThis): void {
  const doc = (global as { document?: Document }).document;
  if (!doc || !doc.documentElement) return;
  doc.documentElement.setAttribute(FLEX_GAP_ATTR, detectFlexGap(doc) ? 'yes' : 'none');
}

/**
 * 用 `FileReader` 读取 Blob 字节（`Blob.prototype.arrayBuffer` 补丁实现）。
 *
 * @param blob Blob 或 File。
 * @returns 字节副本。
 */
function readBlobBytesViaFileReader(blob: Blob): Promise<ArrayBuffer> {
  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('当前环境不支持读取 Blob 字节'));
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('读取 Blob 失败：FileReader 未返回 ArrayBuffer'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'));
    reader.onabort = () => reject(new Error('读取 Blob 已取消'));
    reader.readAsArrayBuffer(blob);
  });
}

// 入口第一行 import 即安装；测试可通过删除全局标记后重新调用 `installCompat()`。
installCompat();