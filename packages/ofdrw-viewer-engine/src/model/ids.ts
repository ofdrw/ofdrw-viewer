/**
 * 资源 ID 规范化。
 *
 * OFD 的 `ST_ID`/`ST_RefID` 在真实文件中存在 `#` 前缀、前后空白、前导零等写法；
 * 引擎内部统一使用十进制文本，保证 Map 查找与资源覆盖判断一致。
 */

import type { ResourceId } from './types';

/**
 * 把 XML 中的资源 ID 文本规范化为十进制字符串。
 *
 * 规则：去前后空白、去前导 `#`、纯数字时去前导零；非数字文本原样返回（由调用方
 * 决定是否 warning/跳过），空串返回空串。
 *
 * @param raw 原始 ID 文本。
 * @returns 规范化后的资源 ID；不会返回 `#` 前缀。
 */
export function normalizeResourceId(raw: string | undefined | null): ResourceId {
  if (raw === undefined || raw === null) return '';
  let value = raw.trim();
  while (value.startsWith('#')) value = value.slice(1).trim();
  if (/^\d+$/.test(value)) {
    const trimmed = value.replace(/^0+(?=\d)/, '');
    return trimmed;
  }
  return value;
}

/**
 * 判断资源 ID 是否是合法的十进制数字文本（规范化之后）。
 *
 * @param id 资源 ID。
 * @returns 是否是纯数字。
 */
export function isNumericResourceId(id: ResourceId): boolean {
  return /^\d+$/.test(id);
}