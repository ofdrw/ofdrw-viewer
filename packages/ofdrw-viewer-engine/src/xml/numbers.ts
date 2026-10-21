/**
 * 数字/布尔解析（实现由 T2/dev-foundation 完成）。
 *
 * 失败时返回 fallback 并通过回调上报 `W_BAD_NUMBER`；不抛异常，避免坏字段阻塞整页。
 */

import type { BadNumberHandler } from './types';
import { notImplemented } from '../common/not-implemented';

/**
 * 解析单个数值，支持科学计数法。
 *
 * @param raw 原始属性值。
 * @param fallback 解析失败时的回退值。
 * @param onBadNumber 坏值回调。
 * @returns 解析结果或 fallback。
 */
export function toNumber(
  raw: string | undefined,
  fallback: number,
  onBadNumber?: BadNumberHandler,
): number {
  void raw;
  void fallback;
  void onBadNumber;
  return notImplemented('xml.toNumber');
}

/**
 * 解析数值数组，支持空白/逗号分隔与 `g <count> <value>` 压缩组。
 *
 * @param raw 原始属性值。
 * @param fallback 解析失败时的回退数组。
 * @param onBadNumber 坏值回调。
 * @returns 数值数组；`g` 展开后总长度默认上限 100,000。
 */
export function toNumberArray(
  raw: string | undefined,
  fallback: readonly number[],
  onBadNumber?: BadNumberHandler,
): number[] {
  void raw;
  void fallback;
  void onBadNumber;
  return notImplemented('xml.toNumberArray');
}

/**
 * 解析布尔值：`true/1/yes` 为真，`false/0/no` 为假。
 *
 * @param raw 原始属性值。
 * @param fallback 解析失败时的回退值。
 * @param onBadNumber 坏值回调。
 * @returns 解析结果或 fallback。
 */
export function toBoolean(
  raw: string | undefined,
  fallback: boolean,
  onBadNumber?: BadNumberHandler,
): boolean {
  void raw;
  void fallback;
  void onBadNumber;
  return notImplemented('xml.toBoolean');
}