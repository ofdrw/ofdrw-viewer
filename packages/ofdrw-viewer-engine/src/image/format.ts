/**
 * 图片格式识别与头部尺寸读取（实现由 T6/dev-foundation 完成）。
 *
 * 识别顺序：扩展名 → magic → 解码器探测；像素上限在解码前检查。
 */

import type { ImageFormat } from '../model/types';
import { notImplemented } from '../common/not-implemented';

/** 图片头部尺寸。 */
export interface ImageHeaderSize {
  width: number;
  height: number;
}

/**
 * 识别图片格式。
 *
 * @param data 文件字节。
 * @param path 可选包内路径（用于扩展名提示）。
 * @returns 图片格式。
 */
export function detectImageFormat(data: Uint8Array, path?: string): ImageFormat {
  void data;
  void path;
  return notImplemented('image.detectImageFormat');
}

/**
 * 从图片头部读取宽高（不解码像素）。
 *
 * @param data 文件字节。
 * @param format 已识别格式。
 * @returns 宽高（像素）；格式不支持或头部损坏时返回 null。
 */
export function readImageSize(data: Uint8Array, format: ImageFormat): ImageHeaderSize | null {
  void data;
  void format;
  return notImplemented('image.readImageSize');
}