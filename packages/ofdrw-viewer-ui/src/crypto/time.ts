/**
 * 验证时间格式化。
 *
 * 时间戳的 `genTime` 是 UTC ISO 字符串；UI 固定按 Asia/Shanghai（UTC+8）展示，
 * 不依赖运行环境时区或 Intl 数据。
 */

/** 展示时区偏移，单位毫秒。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * ISO 8601 → Asia/Shanghai `YYYY-MM-DD HH:mm:ss`（UTC+8）。
 *
 * @param value ISO 时间；缺失/非法返回 undefined。
 * @returns 本地展示时间；不可解析时为 undefined。
 */
export function formatShanghaiDateTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds(),
  )}`;
}