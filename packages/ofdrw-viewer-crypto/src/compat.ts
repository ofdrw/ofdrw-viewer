/**
 * Chrome 67（2018-05 内核）兼容补丁。
 *
 * Chrome 67 已原生支持 BigInt、`DataView.getBigUint64`、`Promise.prototype.finally`、
 * `AbortController`、`ResizeObserver` 与 ESM，但仍缺少 crypto 实际使用的 API：
 *
 * - `globalThis`（Chrome 71）
 * - `Blob.prototype.arrayBuffer`（Chrome 76）
 *
 * BigInt 与 `DataView.getBigUint64` 在 Chrome 67 原生可用，本模块不做任何 polyfill，
 * 也不移除相关调用；crypto 的 `tsconfig` 保持 ES2022（源码含 BigInt 字面量）。
 *
 * 本模块在每个 API 上做特性检测：原生存在时保持原样，缺失时才定义补丁。
 * 补丁不读取 DOM、不依赖 `window`/`document`，可在 Node、Worker、CDN 自检沙箱中导入。
 *
 * 加载方式：`src/index.ts` 的首条 import 是 `import './compat'`，模块顶层自动安装一次；
 * 宿主或 Worker 也可通过子路径 `@ofdrw/ofdrw-viewer-crypto/compat` 提前导入。
 */

/** 补丁的作用域；浏览器中为 `globalThis`/`window`/`self`，Node 中为 `globalThis`。 */
type CompatScope = Record<string, unknown>;

/** 全局安装标记（`Symbol.for`，仅用于诊断，不构成公共 API）。 */
const COMPAT_MARK = Symbol.for('ofdrw.viewer.compat.crypto.v1');

/** 当前模块实例是否已执行过自动安装；保证 `installCompat()` 重复调用幂等。 */
let installed = false;

/** Chrome 67 下 `self` 与 `window` 尚未被 `globalThis` 统一，这里按需声明。 */
declare const self: CompatScope | undefined;
declare const window: CompatScope | undefined;

/**
 * 解析当前全局对象。
 *
 * Chrome 67 没有 `globalThis` 标识符，需要用 `typeof` 守卫逐级回退。
 *
 * @returns 全局对象；无法解析时返回 `undefined`。
 */
function resolveGlobalScope(): CompatScope | undefined {
  if (typeof globalThis !== 'undefined' && globalThis !== null) {
    return globalThis as unknown as CompatScope;
  }
  if (typeof self !== 'undefined') {
    return self;
  }
  if (typeof window !== 'undefined') {
    return window;
  }
  // 极端环境（无 globalThis/self/window 的沙箱）的最后兜底；CSP 禁止 Function 时保持 undefined。
  try {
    return Function('return this')() as CompatScope;
  } catch {
    return undefined;
  }
}

/**
 * 安装 `globalThis`（Chrome 71 才原生提供）。
 *
 * 浏览器中全局对象属性可直接作为全局标识符解析，因此定义 `scope.globalThis = scope`
 * 后，源码中的 `globalThis` 引用即可正常工作。
 *
 * @param scope 目标全局对象，缺省为当前全局对象。
 */
export function installGlobalThis(scope: CompatScope | undefined = resolveGlobalScope()): void {
  if (!scope || typeof scope.globalThis !== 'undefined') return;
  Object.defineProperty(scope, 'globalThis', {
    value: scope,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/** `FileReader` 的最小结构类型，避免依赖 DOM 声明。 */
interface CompatFileReader {
  result: ArrayBuffer | string | null;
  error: unknown;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsArrayBuffer(blob: unknown): void;
}

/** 读取 Blob 字节时的优先实现：`FileReader` → `Response` → 拒绝。 */
function readBlobAsArrayBuffer(scope: CompatScope, blob: unknown): Promise<ArrayBuffer> {
  const FileReaderCtor = scope.FileReader as (new () => CompatFileReader) | undefined;
  if (typeof FileReaderCtor === 'function') {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => {
        resolve(reader.result as ArrayBuffer);
      };
      reader.onerror = () => {
        reject(reader.error instanceof Error ? reader.error : new Error('读取 Blob 失败'));
      };
      reader.readAsArrayBuffer(blob);
    });
  }
  const ResponseCtor = scope.Response as
    | (new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> })
    | undefined;
  if (typeof ResponseCtor === 'function') {
    return new ResponseCtor(blob).arrayBuffer();
  }
  return Promise.reject(new Error('当前环境缺少 FileReader/Response，无法读取 Blob'));
}

/**
 * 安装 `Blob.prototype.arrayBuffer`（Chrome 76 才原生提供，`File` 继承自 `Blob`）。
 *
 * 原生存在时不做任何修改；缺失时优先用 `FileReader.readAsArrayBuffer`，
 * 其次用 `new Response(blob).arrayBuffer()`，两者都没有时返回拒绝的 Promise。
 *
 * @param scope 目标全局对象，缺省为当前全局对象。
 */
export function installBlobArrayBuffer(scope: CompatScope | undefined = resolveGlobalScope()): void {
  const BlobCtor = scope?.Blob as { prototype?: CompatScope } | undefined;
  const proto = BlobCtor?.prototype;
  if (!scope || !proto || typeof proto.arrayBuffer === 'function') return;
  Object.defineProperty(proto, 'arrayBuffer', {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function arrayBuffer(this: unknown): Promise<ArrayBuffer> {
      return readBlobAsArrayBuffer(scope, this);
    },
  });
}

/**
 * 安装 crypto 需要的全部 Chrome 67 兼容补丁。
 *
 * 幂等：同一模块实例内重复调用直接返回；原生 API 存在时不做覆盖。
 * 安装顺序为 `globalThis` → `Blob.prototype.arrayBuffer` → 诊断标记。
 */
export function installCompat(): void {
  if (installed) return;
  installed = true;
  const scope = resolveGlobalScope();
  if (!scope) return;
  installGlobalThis(scope);
  installBlobArrayBuffer(scope);
  if ((scope as Record<symbol, unknown>)[COMPAT_MARK] !== true) {
    Object.defineProperty(scope, COMPAT_MARK, {
      value: true,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  }
}

// 模块顶层自动安装：入口首条 import 即生效，早于其他模块的顶层表达式。
installCompat();