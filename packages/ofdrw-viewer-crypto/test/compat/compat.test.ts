import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBlobArrayBuffer, installCompat, installGlobalThis } from '../../src/compat';

/** 可删除属性的 Blob.prototype 视图，用于模拟 Chrome 67 缺失 API。 */
type MutableBlobPrototype = { arrayBuffer?: unknown };
/** 补丁作用域。 */
type CompatScope = Record<string, unknown>;

const NATIVE_BLOB_ARRAY_BUFFER = Blob.prototype.arrayBuffer;

const globalScope = globalThis as unknown as CompatScope;

/** 还原测试期间删除/替换的原生 API，避免污染同进程内其他测试文件。 */
function restoreNatives(): void {
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

describe('crypto compat：原生分支', () => {
  it('原生 API 存在时不覆盖原生实现', () => {
    // 模块导入时已自动安装过一次，此时 Blob.prototype.arrayBuffer 是 Node 原生实现。
    expect(Blob.prototype.arrayBuffer).toBe(NATIVE_BLOB_ARRAY_BUFFER);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('ofdrw.viewer.compat.crypto.v1')]).toBe(
      true,
    );

    installCompat();
    expect(Blob.prototype.arrayBuffer).toBe(NATIVE_BLOB_ARRAY_BUFFER);
  });

  it('globalThis 已存在时保持原值', () => {
    const scope: CompatScope = { globalThis: 'sentinel' };
    installGlobalThis(scope);
    expect(scope.globalThis).toBe('sentinel');
  });
});

describe('crypto compat：缺失分支', () => {
  it('入口导入时自动补齐缺失 API', async () => {
    delete (Blob.prototype as MutableBlobPrototype).arrayBuffer;
    vi.resetModules();
    try {
      await import('../../src/compat');
      expect(typeof Blob.prototype.arrayBuffer).toBe('function');
    } finally {
      restoreNatives();
      vi.resetModules();
    }
  });

  it('公共入口导入时先安装兼容补丁', async () => {
    delete (Blob.prototype as MutableBlobPrototype).arrayBuffer;
    vi.resetModules();
    try {
      const entry = await import('../../src/index');
      expect(typeof entry.CryptoError).toBe('function');
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

  it('Blob.prototype.arrayBuffer 缺失时读取真实字节', async () => {
    delete (Blob.prototype as MutableBlobPrototype).arrayBuffer;
    installBlobArrayBuffer(globalScope);

    expect(typeof Blob.prototype.arrayBuffer).toBe('function');
    const buffer = await new Blob(['ofd']).arrayBuffer();
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(new Uint8Array(buffer))).toBe('ofd');
  });
});