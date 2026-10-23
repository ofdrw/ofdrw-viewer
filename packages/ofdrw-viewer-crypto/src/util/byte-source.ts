/**
 * 随机访问字节源校验与读取辅助。
 *
 * `byte-source` 让 Node/CLI 文件入口可以把已有随机读取实现直接交给 crypto，
 * 由 ZIP 容器按需读取；crypto 不 import `node:*`，也不拥有调用方字节源。
 */

import type { ByteSource } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError } from '../errors';
import { throwIfAborted, requireWithinBytes } from './argument';
import { concatBytes } from './bytes';

/** 单次读取块大小，单位 byte。 */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * 断言值实现了 engine 的随机读取接口。
 *
 * @param value 待检查值。
 * @throws CryptoError `CRYPTO_SOURCE_UNSUPPORTED`：不是合法 ByteSource。
 */
export function assertByteSource(value: unknown): asserts value is ByteSource {
  if (!value || typeof value !== 'object') {
    throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', 'byte-source 必须提供 ByteSource 对象');
  }
  const source = value as { readonly size?: unknown; readonly read?: unknown };
  if (typeof source.read !== 'function') {
    throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', 'byte-source 需要实现 read()');
  }
  if (
    typeof source.size !== 'number' ||
    !Number.isSafeInteger(source.size) ||
    source.size < 0
  ) {
    throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', 'ByteSource.size 必须是非负安全整数');
  }
}

/**
 * 判断值是否像 ByteSource；用于输入源类型分发。
 *
 * @param value 待检查值。
 * @returns 是否具备 size/read。
 */
export function isByteSource(value: unknown): value is ByteSource {
  try {
    assertByteSource(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建隔离的字节源视图：只转发 size/read/ready，不转发 close。
 *
 * 这样 engine 容器关闭时只会释放自身资源，不会关闭调用方拥有的 ByteSource。
 *
 * @param source 调用方字节源。
 * @param signal 取消信号。
 * @returns 隔离视图。
 * @throws CryptoError `CRYPTO_SOURCE_UNSUPPORTED`：字节源非法。
 */
export function isolateByteSource(source: ByteSource, signal?: AbortSignal): ByteSource {
  assertByteSource(source);
  const ready = (source as ByteSource & { ready?: () => Promise<void> | void }).ready;
  const view: ByteSource & { ready?: () => Promise<void> } = {
    get size(): number {
      return source.size;
    },
    async read(offset: number, length: number): Promise<Uint8Array> {
      throwIfAborted(signal);
      const bytes = await source.read(offset, length);
      throwIfAborted(signal);
      if (!(bytes instanceof Uint8Array)) {
        throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', 'ByteSource.read() 必须返回 Uint8Array');
      }
      return bytes;
    },
    ...(typeof ready === 'function'
      ? {
          async ready(): Promise<void> {
            await ready.call(source);
            throwIfAborted(signal);
          },
        }
      : {}),
  };
  return view;
}

/**
 * 读取整个字节源（仅用于公共 `readCryptoSource`，业务入口走按需容器）。
 *
 * @param source 调用方字节源。
 * @param maxBytes 最大字节数，单位 byte。
 * @param signal 取消信号。
 * @returns 完整字节。
 * @throws CryptoError `CRYPTO_SOURCE_UNSUPPORTED` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED`。
 */
export async function readByteSourceAll(
  source: ByteSource,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertByteSource(source);
  requireWithinBytes(source.size, maxBytes, '输入源');
  throwIfAborted(signal);
  if (source.size === 0) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let offset = 0;
  try {
    while (offset < source.size) {
      throwIfAborted(signal);
      const length = Math.min(READ_CHUNK_BYTES, source.size - offset);
      const bytes = await source.read(offset, length);
      throwIfAborted(signal);
      if (!(bytes instanceof Uint8Array)) {
        throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', 'ByteSource.read() 必须返回 Uint8Array');
      }
      if (bytes.length === 0) {
        throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', 'ByteSource.read() 提前返回空数据');
      }
      const remaining = source.size - offset;
      const chunk = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
      chunks.push(chunk);
      offset += chunk.length;
    }
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    if (signal?.aborted) {
      throw new CryptoError('CRYPTO_ABORTED', '操作已取消', { cause: error });
    }
    throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '读取 byte-source 失败', { cause: error });
  }
  throwIfAborted(signal);
  return concatBytes(...chunks);
}
