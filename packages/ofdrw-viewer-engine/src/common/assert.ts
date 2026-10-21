/**
 * 轻量断言与数值夹紧工具。
 *
 * 这些函数用于内部前提校验，不替代公共 API 的 OFDError 包装。
 */

/**
 * 断言条件成立；否则抛出 Error。
 *
 * @param condition 断言条件。
 * @param message 失败信息。
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * 断言数值有限；否则抛出 Error。
 *
 * @param value 待检查值。
 * @param name 字段名，用于错误信息。
 * @returns 原值，便于链式使用。
 */
export function assertFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} 必须是有限数值，实际为 ${String(value)}`);
  return value;
}

/**
 * 断言数值非负；否则抛出 Error。
 *
 * @param value 待检查值。
 * @param name 字段名，用于错误信息。
 * @returns 原值。
 */
export function assertNonNegative(value: number, name: string): number {
  assertFinite(value, name);
  if (value < 0) throw new Error(`${name} 必须非负，实际为 ${value}`);
  return value;
}

/**
 * 把数值夹到 `[min, max]`；非有限值时返回最小值。
 *
 * @param value 输入值。
 * @param min 下界。
 * @param max 上界。
 * @returns 夹紧后的值。
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * 把数值夹到 0..1。
 *
 * @param value 输入值。
 * @returns 0..1 的有限值。
 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}