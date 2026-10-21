/**
 * JBIG2 解码（实现由 T6/dev-foundation 完成）。
 *
 * 纯 JS、动态 chunk；只支持单页，多页取第一页并 warning。
 */

import type { DecodedImage } from '../common/types';
import { notImplemented } from '../common/not-implemented';

/** JBIG2 解码结果附加信息。 */
export interface Jbig2DecodeResult extends DecodedImage {
  /** 是否为二值图。 */
  bilevel: boolean;
  /** 页数；多页时 >1。 */
  pageCount: number;
}

/**
 * 解码 JBIG2/JB2/GBIG2 字节。
 *
 * @param data JBIG2 文件或嵌入段字节。
 * @param options 像素上限与是否反色。
 * @returns 解码结果；失败时抛 OFD_IMAGE_DECODE。
 */
export async function decodeJbig2(
  data: Uint8Array,
  options?: { maxPixels?: number; invert?: boolean },
): Promise<Jbig2DecodeResult> {
  void data;
  void options;
  return notImplemented('image.decodeJbig2');
}