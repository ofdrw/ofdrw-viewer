/**
 * 读取原始 OFD 字节。
 *
 * 用于“导出原文件”：URL 来源会重新请求一次；blob/arraybuffer 直接复用；
 * 规范化引擎来源作为内部回退。加密文档读取到的仍是原始加密包。
 */

import { readBlobBytes } from '../compat';
import { OFDViewerError } from '../errors';

import type { OFDSource } from '@ofdrw/ofdrw-viewer-engine';
import type { ViewerSource } from '../types';
import { mergeHeaders } from '../document-controller';

/** 判断是否为 `{ url, headers? }` 来源。 */
function isUrlSource(value: unknown): value is { url: string; headers?: Record<string, string> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { url?: unknown }).url === 'string'
  );
}

/**
 * 读取宿主来源的原始字节。
 *
 * @param source 宿主来源。
 * @param requestInit 额外请求参数；只使用 headers。
 * @param signal 取消信号。
 * @returns 原始字节。
 * @throws {Error} URL 请求失败或来源为空时抛出。
 */
export async function readViewerSourceBytes(
  source: ViewerSource,
  requestInit?: RequestInit,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (typeof source === 'string' || isUrlSource(source)) {
    const url = typeof source === 'string' ? source : source.url;
    const headers = mergeHeaders(
      requestInit?.headers,
      typeof source === 'string' ? undefined : source.headers,
    );
    const response = await fetch(url, {
      ...(headers ? { headers } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`读取 OFD 原文件失败：HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source instanceof Uint8Array) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return readBlobBytes(source);
  }
  throw new Error('不支持的 OFD 来源，无法导出原文件');
}

/**
 * 读取引擎规范化来源的原始字节。
 *
 * @param source 引擎来源。
 * @returns 原始字节。
 * @throws {Error} 随机读源读取失败时抛出。
 */
export async function readOFDSourceBytes(source: OFDSource): Promise<Uint8Array> {
  if (source.kind === 'arraybuffer') {
    return source.data instanceof Uint8Array
      ? new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength)
      : new Uint8Array(source.data);
  }
  if (source.kind === 'blob') {
    return readBlobBytes(source.blob);
  }
  const byteSource = source.source;
  await byteSource.ready?.();
  const total = byteSource.size;
  if (!(total > 0)) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < total) {
    const chunk = await byteSource.read(offset, total - offset);
    if (chunk.byteLength === 0) break;
    chunks.push(chunk);
    offset += chunk.byteLength;
  }
  if (offset !== total) {
    throw new OFDViewerError(
      'OFD_EXPORT_FAILED',
      `OFD 原文件读取不完整：期望 ${total} 字节，实际 ${offset} 字节`,
    );
  }
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return merged;
}