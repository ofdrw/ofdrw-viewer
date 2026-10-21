/**
 * 图片解码共享限制。
 *
 * 与 api/types.ts 的 `DEFAULT_RESOURCE_LIMITS.maxImagePixels` 保持一致；
 * image 层不反向依赖 api，避免依赖方向倒置。
 */

/** 默认单图最大像素数。 */
export const DEFAULT_MAX_IMAGE_PIXELS = 100_000_000;

/**
 * 归一化像素上限；未提供/非法值使用默认值。
 *
 * @param value 原始上限，像素。
 * @returns 正整数上限。
 */
export function normalizeMaxPixels(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_IMAGE_PIXELS;
  }
  return Math.floor(value);
}
