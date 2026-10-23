/**
 * `CryptoSource` 读取适配。
 *
 * 所有来源最终读成 `Uint8Array`，并强制 `maxBytes` 上限；业务入口优先
 * 使用随机访问容器，不调用本函数读取整个包。crypto 包自身不 import `node:*`。
 */

import { CryptoError } from '../errors';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import type { CryptoSource } from '../types/source';
import { throwIfAborted, requireWithinBytes } from './argument';
import { concatBytes, toUint8Array } from './bytes';
import { readByteSourceAll } from './byte-source';

/** 读取输入源的选项。 */
export interface ReadCryptoSourceOptions {
  /** 最大字节数，单位 byte；默认 `DEFAULT_CRYPTO_LIMITS.maxSourceBytes`。 */
  readonly maxBytes?: number;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 读取输入源全部字节。
 *
 * @param source 输入源。
 * @param options 大小上限与取消信号。
 * @returns 输入字节；`arraybuffer` 来源可能返回调用方字节的视图，调用方不得修改。
 * @throws CryptoError `CRYPTO_SOURCE_UNSUPPORTED` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED`。
 */
export async function readCryptoSource(
  source: CryptoSource,
  options: ReadCryptoSourceOptions = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? DEFAULT_CRYPTO_LIMITS.maxSourceBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'maxBytes 必须是正整数');
  }
  throwIfAborted(options.signal);
  if (!source || typeof source !== 'object' || typeof (source as { kind?: unknown }).kind !== 'string') {
    throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '输入源必须是 CryptoSource');
  }

  switch (source.kind) {
    case 'arraybuffer': {
      const bytes = toUint8Array(source.data);
      requireWithinBytes(bytes.length, maxBytes, '输入源');
      return bytes;
    }
    case 'blob': {
      const blob = source.blob;
      if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
        throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '当前环境不支持 Blob 输入');
      }
      requireWithinBytes(blob.size, maxBytes, '输入源');
      throwIfAborted(options.signal);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      requireWithinBytes(bytes.length, maxBytes, '输入源');
      throwIfAborted(options.signal);
      return bytes;
    }
    case 'byte-source': {
      return readByteSourceAll(source.source, maxBytes, options.signal);
    }
    case 'url': {
      if (typeof fetch !== 'function') {
        throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '当前环境不支持 fetch，无法读取 URL 输入');
      }
      let response: Response;
      try {
        response = await fetch(source.url, {
          headers: source.headers,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw new CryptoError('CRYPTO_ABORTED', '操作已取消', { cause: error });
        }
        // 不挂 cause：底层错误可能包含带凭据查询串的 URL。
        throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '读取 URL 输入失败');
      }
      if (!response.ok) {
        throw new CryptoError(
          'CRYPTO_SOURCE_UNSUPPORTED',
          `读取 URL 输入失败：HTTP ${response.status}`,
        );
      }
      const lengthHeader = response.headers.get('content-length');
      const contentLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new CryptoError(
          'CRYPTO_LIMIT_EXCEEDED',
          `输入源大小 ${contentLength} byte 超过上限 ${maxBytes} byte`,
        );
      }
      const body = response.body;
      if (!body || typeof body.getReader !== 'function') {
        // 无法流式读取时，必须依赖服务端声明的 Content-Length 才能守住上限。
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          throw new CryptoError(
            'CRYPTO_SOURCE_UNSUPPORTED',
            '响应无法流式读取且缺少可信 Content-Length',
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        requireWithinBytes(bytes.length, maxBytes, '输入源');
        throwIfAborted(options.signal);
        return bytes;
      }
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          throwIfAborted(options.signal);
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          total += value.length;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new CryptoError(
              'CRYPTO_LIMIT_EXCEEDED',
              `输入源超过上限 ${maxBytes} byte`,
            );
          }
          chunks.push(value);
        }
        throwIfAborted(options.signal);
        return concatBytes(...chunks);
      } catch (error) {
        if (error instanceof CryptoError) throw error;
        if (options.signal?.aborted) {
          throw new CryptoError('CRYPTO_ABORTED', '操作已取消', { cause: error });
        }
        throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '读取 URL 输入失败');
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // 已释放的 reader 无需处理。
        }
      }
    }
    default: {
      const kind = (source as { kind?: unknown }).kind;
      throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', `不支持的输入源类型：${String(kind)}`);
    }
  }
}