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
    width: size.width * scale,
    height: size.height * scale,
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