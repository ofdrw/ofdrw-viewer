/**
 * 加密源到 ZIP 容器的桥接。
 *
 * crypto 只通过 engine 的公共 `VirtualContainer` 读取包内条目：这样可复用
 * engine 的 ZIP 解析、CRC 校验与包/条目/总量/压缩比限制，且不复制 ZIP
 * 解析逻辑。读取出的字节仍是包内原始字节（加密包即密文），解密由
 * `decrypt/` 完成。
 */

import { OFDError } from '@ofdrw/ofdrw-viewer-engine';
import type {
  ByteSource,
  OFDSource,
  ResourceLimits,
  VirtualContainer,
} from '@ofdrw/ofdrw-viewer-engine';
import { openZipVirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import { CryptoError } from '../errors';
import type { CryptoLimits } from '../types/limits';
import type { CryptoSource } from '../types/source';
import { throwIfAborted, requireWithinBytes } from '../util/argument';
import { assertByteSource, isolateByteSource } from '../util/byte-source';
import { readCryptoSource } from '../util/source';

/** 已读取的包内条目快照；path 为规范化路径。 */
export interface EntrySnapshot {
  /** 包内全部文件条目，按 path 升序。 */
  readonly entries: ReadonlyMap<string, Uint8Array>;
  /** 原始包字节数，单位 byte。 */
  readonly packageSize: number;
}

/**
 * 把 crypto 限制映射为 engine 的 ZIP 相关限制。
 *
 * @param limits crypto 限制。
 * @returns engine 资源限制（仅 ZIP 字段）。
 */
function toEngineLimits(limits: CryptoLimits): Partial<ResourceLimits> {
  return {
    maxPackageBytes: limits.maxSourceBytes,
    maxEntries: limits.maxEntries,
    maxEntryBytes: limits.maxEntryBytes,
    maxTotalUncompressedBytes: limits.maxTotalDecryptedBytes,
    maxCompressionRatio: limits.maxCompressionRatio,
  };
}

/**
 * 把 engine 错误映射为 crypto 错误码。
 *
 * @param error 原始错误。
 * @returns CryptoError；已是 CryptoError 时原样返回。
 */
export function mapEngineError(error: unknown): CryptoError {
  if (error instanceof CryptoError) return error;
  if (error instanceof OFDError) {
    switch (error.code) {
      case 'OFD_ABORTED':
        return new CryptoError('CRYPTO_ABORTED', '操作已取消');
      case 'OFD_LIMIT_EXCEEDED':
        return new CryptoError('CRYPTO_LIMIT_EXCEEDED', `包读取超过限制：${error.message}`);
      case 'OFD_ENCRYPTED':
        return new CryptoError('CRYPTO_UNSUPPORTED_ENCRYPTION', '不支持 ZIP 条目级加密');
      case 'OFD_CLOSED':
        return new CryptoError('CRYPTO_INVALID_PACKAGE', '容器已关闭');
      default:
        return new CryptoError('CRYPTO_INVALID_PACKAGE', `OFD 包非法：${error.message}`);
    }
  }
  return new CryptoError('CRYPTO_INVALID_PACKAGE', 'OFD 包解析失败', { cause: error });
}

/**
 * 把 crypto 公共来源映射为 engine 的 `OFDSource`。
 *
 * `byte-source` 会先隔离为不转发 `close` 的只读视图，保证调用方拥有原始字节源。
 * URL 保留既有流式整包读取语义，以维持 fetch/Content-Length 错误码兼容。
 *
 * @param source crypto 输入源。
 * @param signal 取消信号。
 * @returns engine 来源描述。
 * @throws CryptoError `CRYPTO_SOURCE_UNSUPPORTED`：来源非法。
 */
export function toEngineSource(source: CryptoSource, signal?: AbortSignal): OFDSource {
  if (!source || typeof source !== 'object' || typeof source.kind !== 'string') {
    throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '输入源必须是 CryptoSource');
  }
  switch (source.kind) {
    case 'arraybuffer':
      return { kind: 'arraybuffer', data: source.data };
    case 'blob':
      return { kind: 'blob', blob: source.blob };
    case 'url':
      return {
        kind: 'url',
        url: source.url,
        ...(source.headers ? { headers: source.headers } : {}),
      };
    case 'byte-source':
      return { kind: 'custom', source: isolateByteSource(source.source, signal) };
    default:
      throw new CryptoError(
        'CRYPTO_SOURCE_UNSUPPORTED',
        `不支持的输入源类型：${String((source as { kind?: unknown }).kind)}`,
      );
  }
}

/**
 * 从 crypto 输入源打开只读 ZIP 容器。
 *
 * `arraybuffer`/`blob`/`byte-source` 交给 engine `openZipVirtualContainer` 按需
 * 读取；`byte-source` 额外先按 `source.size` 做 `maxSourceBytes` 预检（不读取
 * 内容），且调用方字节源不会被 close。URL 为兼容既有 fetch 语义先流式读取。
 * 容器所有权归调用方，必须 close。
 *
 * @param source crypto 输入源。
 * @param limits crypto 限制。
 * @param signal 取消信号。
 * @returns ZIP 容器。
 * @throws CryptoError 来源/包结构/超限/取消错误。
 */
export async function openCryptoContainer(
  source: CryptoSource,
  limits: CryptoLimits,
  signal?: AbortSignal,
): Promise<VirtualContainer> {
  throwIfAborted(signal);
  if (!source || typeof source !== 'object' || typeof source.kind !== 'string') {
    throw new CryptoError('CRYPTO_SOURCE_UNSUPPORTED', '输入源必须是 CryptoSource');
  }

  if (source.kind === 'byte-source') {
    assertByteSource(source.source);
    requireWithinBytes(source.source.size, limits.maxSourceBytes, '输入源');
    const customSource: ByteSource = isolateByteSource(source.source, signal);
    try {
      const container = await openZipVirtualContainer(
        { kind: 'custom', source: customSource },
        { limits: toEngineLimits(limits) },
      );
      if (signal?.aborted) {
        await closeQuietly(container);
        throw new CryptoError('CRYPTO_ABORTED', '操作已取消');
      }
      return container;
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  if (source.kind === 'url') {
    // 兼容既有 URL 行为：fetch 流式整包读取、Content-Length/无 body 错误码不变。
    const bytes = await readCryptoSource(source, {
      maxBytes: limits.maxSourceBytes,
      signal,
    });
    return openPackageContainer(bytes, limits);
  }

  try {
    const container = await openZipVirtualContainer(toEngineSource(source, signal), {
      limits: toEngineLimits(limits),
    });
    if (signal?.aborted) {
      await closeQuietly(container);
      throw new CryptoError('CRYPTO_ABORTED', '操作已取消');
    }
    return container;
  } catch (error) {
    throw mapEngineError(error);
  }
}

/**
 * 用原始字节打开 engine ZIP 容器。
 *
 * @param bytes 原始包字节。
 * @param limits crypto 限制。
 * @returns ZIP 容器；调用方负责关闭。
 */
export async function openPackageContainer(
  bytes: Uint8Array,
  limits: CryptoLimits,
): Promise<VirtualContainer> {
  try {
    return await openZipVirtualContainer(
      { kind: 'arraybuffer', data: bytes },
      { limits: toEngineLimits(limits) },
    );
  } catch (error) {
    throw mapEngineError(error);
  }
}


/**
 * 关闭容器并吞掉关闭异常。
 *
 * @param container 容器。
 */
export async function closeQuietly(container: VirtualContainer | undefined): Promise<void> {
  if (!container) return;
  try {
    await container.close();
  } catch {
    // 关闭失败不覆盖主流程结论。
  }
}
