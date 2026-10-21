/**
 * `OFDSource` → `ByteSource` 解析。
 *
 * Web 优先：arraybuffer/blob/url/custom 由 T7 实现；node-file/wechat-file 本轮
 * 只保留类型并返回明确的 `OFD_RENDERER_UNSUPPORTED`。
 */

import type { ByteSource } from '../platform/byte-source';
import type { OFDSource } from './types';
import { notImplemented } from '../common/not-implemented';

/**
 * 把公共来源描述解析为按需字节源。
 *
 * @param source 文档来源。
 * @returns 随机可读字节源。
 */
export async function openByteSource(source: OFDSource): Promise<ByteSource> {
  void source;
  return notImplemented('api.openByteSource');
}