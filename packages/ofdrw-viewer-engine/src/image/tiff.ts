/**
 * TIFF 解码（实现由 T6/dev-foundation 完成）。
 *
 * 支持 baseline/LZW/PackBits/Deflate、单页/第一帧、1/4/8/16 位、条带/瓦片；
 * 不支持多页、浮点与复杂 ICC。
 */

import type { DecodedImage } from '../common/types';
import { notImplemented } from '../common/not-implemented';

/** TIFF 解码结果附加信息。 */
export interface TiffDecodeResult extends DecodedImage {
  /** 实际解码的帧索引，通常为 0。 */
  frameIndex: number;
}

/**
 * 解码 TIFF 字节。
 *
 * @param data TIFF 文件字节。
 * @param options 像素上限。
 * @returns 解码结果；失败时抛 OFD_IMAGE_DECODE。
 */
export async function decodeTiff(
  data: Uint8Array,
  options?: { maxPixels?: number },
): Promise<TiffDecodeResult> {
  void data;
  void options;
  return notImplemented('image.decodeTiff');
}