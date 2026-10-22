/**
 * 数字/布尔解析。
 *
 * 失败时返回 fallback 并通过回调上报 `W_BAD_NUMBER`；不抛异常，避免坏字段阻塞整页。
 * 数值数组支持 OFD ST_Array 的 `g N V` 压缩组：V 重复 N 次，
 * 例如 `g 3 3.1305` 展开为 3 个 `3.1305`，`0 g 3 5 2` 展开为 `0, 5, 5, 5, 2`。
 * `N=0` 是合法空展开，例如 `g 0 0 3.175` 等价于 `3.175`，不视为坏值。
 */

import type { BadNumberHandler } from './types';

/** `g` 压缩组展开后的数组长度上限，防止恶意属性耗尽内存。 */
export const MAX_EXPANDED_ARRAY_LENGTH = 100_000;

/** 数值 token 正则：支持符号、小数、科学计数法。 */
const NUMBER_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 解析单个数值，支持科学计数法。
 *
 * @param raw 原始属性值；missing/空串回退。
 * @param fallback 解析失败时的回退值。
 * @param onBadNumber 坏值回调。
 * @returns 解析结果或 fallback。
 */
export function toNumber(
  raw: string | undefined,
  fallback: number,
  onBadNumber?: BadNumberHandler,
): number {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (value.length === 0) {
    onBadNumber?.(raw, fallback, '空字符串');
    return fallback;
  }
  if (!NUMBER_TOKEN.test(value)) {
    onBadNumber?.(raw, fallback, '不是合法数值');
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    onBadNumber?.(raw, fallback, '非有限数值');
    return fallback;
  }
  return parsed;
}

/**
 * 解析数值数组，支持空白/逗号分隔与 `g N V` 压缩组（V 重复 N 次）。
 *
 * @param raw 原始属性值；缺失/空串返回 fallback 的副本。
 * @param fallback 解析失败时的回退数组。
 * @param onBadNumber 坏值回调。
 * @returns 数值数组；`g` 展开后总长度上限 100,000。
 */
export function toNumberArray(
  raw: string | undefined,
  fallback: readonly number[],
  onBadNumber?: BadNumberHandler,
): number[] {
  if (raw === undefined) return [...fallback];
  const text = raw.trim();
  if (text.length === 0) return [...fallback];

  const tokens = text.split(/[\s,]+/).filter((token) => token.length > 0);
  const values: number[] = [];
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index] as string;
    if (token === 'g') {
      const countToken = tokens[index + 1];
      const valueToken = tokens[index + 2];
      const count = countToken === undefined ? NaN : Number(countToken);
      const value = valueToken === undefined ? NaN : Number(valueToken);
      // count=0 表示空展开（`g 0 0 3.175` 只产生后续的 3.175），不是格式错误。
      const validCount = Number.isInteger(count) && count >= 0;
      const validValue = valueToken !== undefined && NUMBER_TOKEN.test(valueToken) && Number.isFinite(value);
      if (!validCount || !validValue) {
        onBadNumber?.(`${token} ${countToken ?? ''} ${valueToken ?? ''}`.trim(), 0, 'g 压缩组格式非法');
        index += countToken === undefined ? 1 : valueToken === undefined ? 2 : 3;
        continue;
      }
      const remaining = MAX_EXPANDED_ARRAY_LENGTH - values.length;
      if (remaining <= 0) {
        onBadNumber?.(raw, 0, `数组展开超过上限 ${MAX_EXPANDED_ARRAY_LENGTH}`);
        break;
      }
      const expand = Math.min(count, remaining);
      for (let step = 0; step < expand; step += 1) values.push(value);
      if (expand < count) {
        onBadNumber?.(raw, 0, `数组展开超过上限 ${MAX_EXPANDED_ARRAY_LENGTH}`);
        break;
      }
      index += 3;
      continue;
    }

    if (!NUMBER_TOKEN.test(token)) {
      onBadNumber?.(token, 0, '数组 token 不是合法数值');
      index += 1;
      continue;
    }
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) {
      onBadNumber?.(token, 0, '数组 token 非有限数值');
      index += 1;
      continue;
    }
    if (values.length >= MAX_EXPANDED_ARRAY_LENGTH) {
      onBadNumber?.(raw, 0, `数组长度超过上限 ${MAX_EXPANDED_ARRAY_LENGTH}`);
      break;
    }
    values.push(parsed);
    index += 1;
  }
  return values;
}

/**
 * 解析布尔值：`true/1/yes` 为真，`false/0/no` 为假。
 *
 * @param raw 原始属性值；缺失时直接返回 fallback。
 * @param fallback 解析失败时的回退值。
 * @param onBadNumber 坏值回调。
 * @returns 解析结果或 fallback。
 */
export function toBoolean(
  raw: string | undefined,
  fallback: boolean,
  onBadNumber?: BadNumberHandler,
): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  onBadNumber?.(raw, fallback ? 1 : 0, '不是合法布尔值');
  return fallback;
}