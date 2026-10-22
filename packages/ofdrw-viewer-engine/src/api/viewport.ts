/**
 * 页面渲染任务参数与 Viewport 计算（对应设计方案 10.6）。
 *
 * 这里只做纯数学；不加载字体/图片，也不设置 canvas 尺寸。
 */

import type { Box, Matrix, Viewport } from '../common/types';
import type { PageSize } from '../model/types';
import type { ViewportOptions } from './types';

/** 每英寸毫米数。 */
export const MM_PER_INCH = 25.4;

/** 默认输出 DPI。 */
export const DEFAULT_DPI = 96;

/** Viewport 像素尺寸保留的小数位数；1 单位 = 0.001px。 */
const VIEWPORT_DECIMALS = 3;

/** Viewport 像素尺寸的归一化倍数。 */
const VIEWPORT_SCALE = 10 ** VIEWPORT_DECIMALS;

/**
 * 把 viewport 像素尺寸归一化到固定小数位，去掉 mm→px 浮点尾差。
 *
 * 只限制小数精度，不做整数取整；例如 864.0000000000001 → 864，
 * 793.7007874015749 → 793.701，864.3 仍为 864.3。画布分配方继续使用
 * `Math.ceil(viewport.width/height)`，因此 864 取 864，864.3 取 865。
 *
 * @param value 像素尺寸（px）。
 * @returns 保留 3 位小数（0.001px）的像素尺寸。
 */
function normalizeViewportPx(value: number): number {
  const rounded = Math.round(value * VIEWPORT_SCALE) / VIEWPORT_SCALE;
  // 避免 -0 进入快照/相等断言。
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 计算页面在指定 DPI 下的像素尺寸。
 *
 * @param size 页尺寸，单位 mm。
 * @param options DPI 选项；默认 96。
 * @returns 设备像素尺寸与 DPI。
 */
export function getPageViewport(size: PageSize, options: ViewportOptions = {}): Viewport {
  const dpi = options.dpi ?? DEFAULT_DPI;
  const scale = dpi / MM_PER_INCH;
  return {
    width: normalizeViewportPx(size.width * scale),
    height: normalizeViewportPx(size.height * scale),
    dpi,
  };
}

/**
 * 计算页面空间（mm）到设备空间的固定矩阵。
 *
 * `M_page = S(dpi / 25.4) × T(-PhysicalBox.x, -PhysicalBox.y)`。
 *
 * @param area 页面 PhysicalBox，单位 mm。
 * @param dpi 输出 DPI。
 * @returns 2×3 矩阵。
 */
export function getPageTransform(area: Box, dpi: number = DEFAULT_DPI): Matrix {
  const scale = dpi / MM_PER_INCH;
  // 归一化 -0，避免矩阵比较/快照测试出现 -0 与 0 的差异。
  const tx = area.x === 0 ? 0 : -scale * area.x;
  const ty = area.y === 0 ? 0 : -scale * area.y;
  return [scale, 0, 0, scale, tx, ty];
}