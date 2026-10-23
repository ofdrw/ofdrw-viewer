/**
 * 默认 ZIP 容器构造与来源规范化（公共基础能力）。
 *
 * 默认 ZIP 容器是 **raw package container**：`read()` 返回包内存仓原始字节。
 * 明文包的 `encrypted=false`，可直接注入 `OFDDocument`；加密包的
 * `encrypted=true`，此时 `read()` 可能是密文，只能用于检查或交给
 * `@ofdrw/ofdrw-viewer-crypto` 解密，解密后需提供 `encrypted=false` 的明文
 * 容器再注入 engine。`OFDDocument.open` 会在解析 XML 前拒绝 `encrypted=true`。
 */

import type { ByteSource } from '../platform/byte-source';
import type { VirtualContainer } from '../platform/virtual-container';
import type { OFDSource, ResourceLimits } from './types';
import { DEFAULT_RESOURCE_LIMITS } from './types';
import { ZipVirtualContainer } from '../container/zip-container';
import { openByteSource } from './source';

/** 默认 ZIP 容器构造选项。 */
export interface OpenZipVirtualContainerOptions {
  /** 资源限制覆盖；仅 ZIP 相关字段生效，未提供字段使用默认值。 */
  limits?: Partial<ResourceLimits>;
}

/**
 * 把 `ResourceLimits` 中与 ZIP 相关的字段映射为容器限制。
 *
 * @param limits 资源限制。
 * @returns ZIP 打开限制；大小单位 byte。
 */
function toZipLimits(limits: ResourceLimits) {
  return {
    maxPackageBytes: limits.maxPackageBytes,
    maxEntries: limits.maxEntries,
    maxEntryBytes: limits.maxEntryBytes,
    maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
    maxCompressionRatio: limits.maxCompressionRatio,
  };
}

/**
 * 静默关闭字节源（若实现提供 close）。
 *
 * @param source 字节源。
 */
async function closeByteSource(source: ByteSource): Promise<void> {
  const close = (source as ByteSource & { close?: () => Promise<void> | void }).close;
  if (typeof close !== 'function') return;
  try {
    await close.call(source);
  } catch {
    // 关闭失败不覆盖调用方结论。
  }
}

/**
 * 把公共来源规范化为默认 ZIP 虚拟容器（raw package container）。
 *
 * 容器拥有来源：成功后调用方负责 `container.close()`；构造失败时本函数会
 * 关闭已打开的字节源，不泄漏句柄。加密包返回的容器 `encrypted=true`，
 * `read()` 返回存仓原始字节，调用方负责解密后再注入 engine。
 *
 * @param source 文档来源。
 * @param options 资源限制覆盖。
 * @returns 默认 ZIP 容器。
 * @throws OFDError 来源不支持、ZIP 非法或超限时。
 */
export async function openZipVirtualContainer(
  source: OFDSource,
  options: OpenZipVirtualContainerOptions = {},
): Promise<VirtualContainer> {
  const limits: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...(options.limits ?? {}) };
  const byteSource = await openByteSource(source);
  try {
    return await ZipVirtualContainer.open(byteSource, toZipLimits(limits));
  } catch (error) {
    await closeByteSource(byteSource);
    throw error;
  }
}