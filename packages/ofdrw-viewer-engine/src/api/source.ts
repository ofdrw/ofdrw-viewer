/**
 * `OFDSource` → `ByteSource` 解析（Web 优先）。
 *
 * - `arraybuffer`/`blob`/`url`/`custom` 直接复用 container 层实现；
 * - `node-file`/`wechat-file` 本轮只保留类型，统一抛出明确的
 *   `OFD_RENDERER_UNSUPPORTED`（Node 端适配另行规划）；
 * - HTTP Range 探测/回退、Content-Range 校验与“不信任 Content-Length”由
 *   `HttpRangeSource` 负责。
 */

import type { ByteSource } from '../platform/byte-source';
import type { OFDSource } from './types';
import {
  ArrayBufferSource,
  BlobSource,
  HttpRangeSource,
  type FetchLike,
} from '../container/byte-source';
import { OFDError } from '../errors';

/**
 * 构造绑定到 `globalThis` 的全局 fetch 包装。
 *
 * 浏览器把 `fetch` 解构后直接调用会抛 `Illegal invocation`；包装函数内以
 * 方法形式调用，保证 `this` 始终是全局对象。环境没有 fetch 时返回 undefined，
 * 由 `HttpRangeSource` 给出统一错误。
 *
 * @returns 绑定后的 fetch，或 undefined。
 */
function bindGlobalFetch(): FetchLike | undefined {
  if (typeof globalThis.fetch !== 'function') return undefined;
  return (input, init) => globalThis.fetch(input, init);
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
    case 'url': {
      if (!source.url.trim()) throw new OFDError('OFD_INVALID_PACKAGE', 'url 来源不能为空');
      const fetchImpl = bindGlobalFetch();
      return new HttpRangeSource(source.url, {
        ...(source.headers ? { headers: source.headers } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    }
    case 'custom': {
      if (!source.source || typeof source.source.read !== 'function') {
        throw new OFDError('OFD_INVALID_PACKAGE', 'custom 来源需要实现 ByteSource.read()');
      }
      return source.source;
    }
    case 'node-file': {
      throw new OFDError(
        'OFD_RENDERER_UNSUPPORTED',
        'Web 优先版本未实现 node-file 来源；请在 Node 适配阶段启用，或注入 custom ByteSource',
      );
    }
    case 'wechat-file': {
      throw new OFDError(
        'OFD_RENDERER_UNSUPPORTED',
        'Web 优先版本未实现 wechat-file 来源；请在微信环境注入 custom ByteSource',
      );
    }
    default: {
      const exhaustive: never = source;
      throw new OFDError('OFD_INVALID_PACKAGE', `未知来源类型：${String(exhaustive)}`);
    }
  }
}