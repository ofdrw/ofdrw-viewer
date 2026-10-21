/**
 * fontkit 封装与字体面创建（实现由 T4/dev-text 完成）。
 *
 * 必须兼容 TTF/OTF/TTC/CFF CID 与无 cmap/name 的剥离子集；
 * 解析失败时返回/抛出明确错误，不把 fontkit 对象泄漏给渲染器。
 */

import type { FontFace, FontFaceCreateOptions } from './types';
import { notImplemented } from '../common/not-implemented';

/**
 * 从字节创建单个字体面。
 *
 * @param data 字体文件字节。
 * @param options 缓存键与 TTC 选面选项。
 * @returns 字体面。
 */
export function createFontFace(data: Uint8Array, options?: FontFaceCreateOptions): FontFace {
  void data;
  void options;
  return notImplemented('font.createFontFace');
}

/**
 * 从字体集合（TTC）创建多个字体面。
 *
 * @param data 字体集合字节。
 * @param options 可选的期望名称。
 * @returns 按文件内顺序排列的字体面；非集合字体返回单元素数组。
 */
export function createFontFaces(data: Uint8Array, options?: FontFaceCreateOptions): FontFace[] {
  void data;
  void options;
  return notImplemented('font.createFontFaces');
}

/**
 * 释放字体面持有的底层资源（fontkit 对象）；实现可做缓存引用计数。
 *
 * @param face 字体面。
 */
export function disposeFontFace(face: FontFace): void {
  void face;
  return notImplemented('font.disposeFontFace');
}