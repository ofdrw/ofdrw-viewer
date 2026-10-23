/**
 * `OFDSource` → `ByteSource` 解析（纯适配，不访问网络/文件）。
 *
 * - `arraybuffer`/`blob` 包装 container 层内置实现；
 * - `custom` 直接返回宿主提供的随机读源；
 * - 运行期遇到已删除的旧来源（`url`/`node-file`/`wechat-file`）时抛出带迁移指引的
 *   `OFDError`，兼容 JavaScript/旧版本调用方。
 */

import type { ByteSource } from '../platform/byte-source';
import type { OFDSource } from './types';
import { ArrayBufferSource, BlobSource } from '../container/byte-source';
import { OFDError } from '../errors';

/** 运行期来源描述；用于识别已删除的旧变体。 */
interface LegacySource {
  kind?: unknown;
}

/**
 * 把公共来源描述解析为按需字节源。
 *
 * @param source 文档来源。
 * @returns 随机可读字节源。
 * @throws OFDError 来源不支持/参数非法时。
 */
export async function openByteSource(source: OFDSource): Promise<ByteSource> {
  switch (source.kind) {
    case 'arraybuffer': {
      if (!(source.data instanceof ArrayBuffer) && !(source.data instanceof Uint8Array)) {
        throw new OFDError('OFD_INVALID_PACKAGE', 'arraybuffer 来源需要 ArrayBuffer 或 Uint8Array');
      }
      const bytes = source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data);
      if (bytes.byteLength === 0) throw new OFDError('OFD_INVALID_PACKAGE', 'OFD 字节为空');
      return new ArrayBufferSource(bytes);
    }
    case 'blob': {
      if (typeof Blob === 'undefined' || !(source.blob instanceof Blob)) {
        throw new OFDError('OFD_INVALID_PACKAGE', 'blob 来源需要有效的 Blob/File');
      }
      if (source.blob.size === 0) throw new OFDError('OFD_INVALID_PACKAGE', 'OFD Blob 为空');
      return new BlobSource(source.blob);
    }
    case 'custom': {
      if (!source.source || typeof source.source.read !== 'function') {
        throw new OFDError('OFD_INVALID_PACKAGE', 'custom 来源需要实现 ByteSource.read()');
      }
      return source.source;
    }
    default: {
      const kind = (source as LegacySource).kind;
      if (kind === 'url') {
        throw new OFDError(
          'OFD_INVALID_PACKAGE',
          '未知来源类型：url。engine 不再负责网络获取，请宿主下载后传 arraybuffer/blob，或传 custom ByteSource。',
        );
      }
      if (kind === 'node-file' || kind === 'wechat-file') {
        throw new OFDError(
          'OFD_RENDERER_UNSUPPORTED',
          `未知来源类型：${String(kind)}。engine 不再读取本地文件，请宿主读取后传 { kind: 'arraybuffer', data } 或 { kind: 'custom', source }。`,
        );
      }
      throw new OFDError('OFD_INVALID_PACKAGE', `未知来源类型：${String(kind)}`);
    }
  }
}