/**
 * 颜色工具。
 *
 * 只输出 target-independent 的 RGBA 或 CSS 颜色字符串，不依赖 Canvas。
 */

import type { Rgba } from './types';
import { notImplemented } from './not-implemented';

/**
 * 创建 RGBA 颜色。
 *
 * @param r 红通道，0..255。
 * @param g 绿通道，0..255。
 * @param b 蓝通道，0..255。
 * @param a 透明度，0..255，默认 255。
 * @returns RGBA 对象。
 */
export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return notImplemented('common.rgba');
}

/**
 * 把 RGBA 转成 `rgba(r,g,b,a)` CSS 字符串。
 *
 * @param color RGBA 颜色。
 * @returns CSS 颜色字符串，alpha 归一化到 0..1。
 */
export function rgbaToCss(color: Rgba): string {
  return notImplemented('common.rgbaToCss');
}

/**
 * 按 `alpha/255` 预乘透明度，返回新的颜色。
 *
 * @param color 输入颜色。
 * @param alpha 额外透明度，0..1。
 * @returns 新的 RGBA 颜色。
 */
export function multiplyRgbaAlpha(color: Rgba, alpha: number): Rgba {
  return notImplemented('common.multiplyRgbaAlpha');
}