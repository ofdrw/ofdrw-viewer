/**
 * 页面查询参数预览来源（`?file=` / `?base64=`）。
 *
 * 纯解析逻辑，不访问全局 `window`：宿主传入 `location`，便于单元测试与 SSR
 * 预检。解析只读取 `search`，因此不会与 `updateHash` 写入的页码/缩放 hash
 * 互相覆盖。
 */

import { getGlobalObject } from '../compat';

import { OFDViewerError } from '../errors';
import type { ViewerWarning } from '../state';
import type { ViewerSource } from '../types';
import { UI_WARNING_CODES } from '../diagnostics';

/** base64 查询参数解码后的默认字节上限（64 MiB）。 */
export const DEFAULT_MAX_BASE64_BYTES = 64 * 1024 * 1024;

/** 查询参数预览来源解析选项。 */
export interface PreviewSourceOptions {
  /** 同时提供 `file` 与 `base64` 时产生的 warning 回调。 */
  readonly onWarning?: (warning: ViewerWarning) => void;
  /** base64 解码后的字节上限；默认 64 MiB。 */
  readonly maxBase64Bytes?: number;
}

/** 解析所需的最小 `location` 契约；真实 `Location` 可直接传入。 */
export interface PreviewLocation {
  /** 完整页面地址，用于解析相对路径。 */
  readonly href: string;
  /** 查询串，通常以 `?` 开头。 */
  readonly search: string;
}

/**
 * 从页面查询参数读取预览来源。
 *
 * 规则：
 * - `file`：URLSearchParams 解码后再尝试一次 `decodeURIComponent`（失败保留原值）；
 *   绝对 http(s) 地址直接使用，相对路径以当前页面地址为 base 解析；拒绝
 *   `file:`、`javascript:`、`data:` 等非 http(s) 协议。
 * - `base64`：支持纯 base64 与 `data:...;base64,...`，兼容 URL-safe 字符、
 *   缺失 padding 与查询串中的空格（`+` 被 URLSearchParams 解码为空格）。
 * - 两者同时存在时优先 `file`，并通过 `onWarning` 报告一次 warning。
 *
 * @param location 页面地址与查询串。
 * @param options 解析选项。
 * @returns 预览来源；两者都未提供时返回 null。
 * @throws {OFDViewerError} `OFD_INVALID_OPTION`：协议非法、URL/Base64 非法或超限。
 */
export function readPreviewSourceFromLocation(
  location: PreviewLocation,
  options: PreviewSourceOptions = {},
): ViewerSource | null {
  const params = new URLSearchParams(location.search);
  const hasFile = params.has('file');
  const hasBase64 = params.has('base64');
  if (!hasFile && !hasBase64) return null;

  if (hasFile) {
    if (hasBase64) {
      options.onWarning?.({
        code: UI_WARNING_CODES.W_QUERY_SOURCE,
        message: '同时提供 file 与 base64 查询参数，已优先使用 file',
      });
    }
    return resolveFileSource(params.get('file') ?? '', location.href);
  }
  return decodeBase64Source(params.get('base64') ?? '', options.maxBase64Bytes);
}

/**
 * 解析 `file` 参数为绝对 http(s) URL。
 *
 * @param raw 查询串中的原始值（URLSearchParams 已解码一次）。
 * @param pageHref 当前页面完整地址。
 * @returns 绝对 http(s) URL 字符串。
 */
function resolveFileSource(raw: string, pageHref: string): string {
  const decoded = decodeOnce(raw).trim();
  if (!decoded) {
    throw new OFDViewerError('OFD_INVALID_OPTION', 'file 查询参数不能为空');
  }

  let url: URL;
  try {
    url = new URL(decoded, pageHref);
  } catch (error) {
    throw new OFDViewerError('OFD_INVALID_OPTION', 'file 查询参数不是合法的 URL', {
      cause: error,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OFDViewerError(
      'OFD_INVALID_OPTION',
      `file 查询参数仅支持 http(s) 地址，收到 ${url.protocol}`,
    );
  }
  return url.href;
}

/**
 * 尝试二次 URI 解码；非法百分号序列时保留原值。
 *
 * @param value 已解码一次的参数值。
 * @returns 解码后的值。
 */
function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 解码 `base64` 参数为字节数组。
 *
 * @param raw 查询串中的原始值（URLSearchParams 已解码一次）。
 * @param maxBytes 解码后字节上限；默认 64 MiB。
 * @returns 解码后的字节。
 */
function decodeBase64Source(raw: string, maxBytes = DEFAULT_MAX_BASE64_BYTES): Uint8Array {
  let payload = raw.trim();
  if (!payload) {
    throw new OFDViewerError('OFD_INVALID_OPTION', 'base64 查询参数不能为空');
  }

  if (/^data:/i.test(payload)) {
    const comma = payload.indexOf(',');
    const header = comma < 0 ? '' : payload.slice(5, comma);
    if (comma < 0 || !/(?:^|;)base64(?:;|$)/i.test(header)) {
      throw new OFDViewerError(
        'OFD_INVALID_OPTION',
        'base64 data URI 必须包含 ;base64 标记与逗号分隔的数据',
      );
    }
    payload = payload.slice(comma + 1).trim();
    if (!payload) {
      throw new OFDViewerError('OFD_INVALID_OPTION', 'base64 data URI 数据部分为空');
    }
  }

  // URLSearchParams 把未编码的 `+` 解码成空格，这里还原；其余空白（换行等）移除。
  payload = payload
    .replace(/[\t\n\r\f\v]/g, '')
    .replace(/ /g, '+')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(payload)) {
    throw new OFDViewerError('OFD_INVALID_OPTION', 'base64 查询参数包含非法字符');
  }

  const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_MAX_BASE64_BYTES;
  // 先按编码长度粗判，避免为超限数据分配过大的解码结果。
  if (payload.length > Math.ceil((limit * 4) / 3) + 4) {
    throw base64TooLargeError(limit);
  }

  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const decode = getGlobalObject().atob;
  if (typeof decode !== 'function') {
    throw new OFDViewerError(
      'OFD_UNSUPPORTED',
      '当前环境不支持 atob，无法解析 base64 查询参数',
    );
  }

  let binary: string;
  try {
    binary = decode(padded);
  } catch (error) {
    throw new OFDViewerError('OFD_INVALID_OPTION', 'base64 查询参数不是合法的 Base64 数据', {
      cause: error,
    });
  }

  if (binary.length > limit) throw base64TooLargeError(limit);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 构造 base64 超限错误。
 *
 * @param limit 字节上限。
 * @returns UI 错误。
 */
function base64TooLargeError(limit: number): OFDViewerError {
  return new OFDViewerError(
    'OFD_INVALID_OPTION',
    `base64 查询参数解码后超过上限 ${Math.trunc(limit)} 字节`,
  );
}