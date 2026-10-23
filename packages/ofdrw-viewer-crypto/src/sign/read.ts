/**
 * 容器读取辅助（签名/完整性/验证共用）。
 *
 * 统一处理：
 * - 路径先规范化；
 * - 缺失条目不抛错，返回 undefined（由调用方决定缺失语义）；
 * - 读取失败/超限/取消转换为 `CryptoError`，便于 UI/CLI 统一处理；
 * - 条目大小受 `CryptoLimits.maxEntryBytes` 限制。
 */

import { isOFDError, type VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError, isCryptoError } from '../errors';
import type { CryptoLimits } from '../types/limits';
import { normalizePackagePath } from './paths';

/** 读取选项。 */
export interface ReadEntryOptions {
  /** 容器。 */
  readonly container: VirtualContainer;
  /** 资源限制。 */
  readonly limits: CryptoLimits;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 读取包内条目；不存在时返回 undefined。
 *
 * @param path 包内路径。
 * @param options 读取选项。
 * @returns 明文字节或 undefined。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE` / `CRYPTO_LIMIT_EXCEEDED` / `CRYPTO_ABORTED`。
 */
export async function readEntry(
  path: string,
  options: ReadEntryOptions,
): Promise<Uint8Array | undefined> {
  const normalized = normalizePackagePath(path);
  if (normalized.length === 0) return undefined;
  if (options.signal?.aborted) {
    throw new CryptoError('CRYPTO_ABORTED', '操作已取消');
  }
  if (!options.container.has(normalized)) return undefined;
  try {
    return await options.container.read(normalized, {
      maxBytes: options.limits.maxEntryBytes,
      signal: options.signal,
    });
  } catch (error) {
    if (isCryptoError(error)) throw error;
    if (isOFDError(error)) {
      if (error.code === 'OFD_ABORTED') {
        throw new CryptoError('CRYPTO_ABORTED', '操作已取消');
      }
      if (error.code === 'OFD_LIMIT_EXCEEDED') {
        throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', `读取 ${normalized} 超过资源限制`);
      }
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', `读取 ${normalized} 失败`);
    }
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', `读取 ${normalized} 失败`);
  }
}

/**
 * 读取包内必需条目。
 *
 * @param path 包内路径。
 * @param options 读取选项。
 * @returns 明文字节。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：条目缺失。
 */
export async function readRequiredEntry(
  path: string,
  options: ReadEntryOptions,
): Promise<Uint8Array> {
  const bytes = await readEntry(path, options);
  if (!bytes) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', `包内缺少必需条目：${normalizePackagePath(path)}`);
  }
  return bytes;
}

/**
 * 读取文本条目（UTF-8）。
 *
 * @param path 包内路径。
 * @param options 读取选项。
 * @returns 文本；条目不存在时 undefined。
 */
export async function readTextEntry(
  path: string,
  options: ReadEntryOptions,
): Promise<string | undefined> {
  const bytes = await readEntry(path, options);
  if (!bytes) return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * 列出容器内全部文件路径（规范化、不含目录项）。
 *
 * @param container 容器。
 * @returns 路径数组，按容器顺序。
 */
export function listEntryPaths(container: VirtualContainer): readonly string[] {
  return container.list().map((meta) => normalizePackagePath(meta.path));
}

/**
 * 查找以指定文件名结尾的条目（用于 Signatures.xml 等未声明路径）。
 *
 * @param container 容器。
 * @param defaultPath 首选路径；存在时直接返回。
 * @param suffix 文件名后缀，例如 `/Signatures.xml`。
 * @returns 包内路径；不存在时 undefined。
 */
export function findEntryBySuffix(
  container: VirtualContainer,
  defaultPath: string,
  suffix: string,
): string | undefined {
  const normalized = normalizePackagePath(defaultPath);
  if (normalized.length > 0 && container.has(normalized)) return normalized;
  const candidates = listEntryPaths(container).filter(
    (path) => path === suffix.replace(/^\//, '') || path.endsWith(suffix),
  );
  candidates.sort();
  return candidates[0];
}