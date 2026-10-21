/**
 * JBIG2 解码（纯 JS 动态 chunk）。
 *
 * 支持带文件头的独立 JBIG2 流与 OFD 中常见的无头嵌入式段；只解码第一页，
 * 多页时通过 warning 提示。解码表位于 `jbig2-vendor/`，仅在动态加载本模块时进入 chunk。
 */

import type { DecodedImage, ImageDataLike } from '../common/types';
import type { OFDWarning } from '../warnings';
import { OFDError } from '../errors';
import { normalizeMaxPixels } from './limits';
import { Jbig2Image } from './jbig2-vendor/jbig2';

/** JBIG2 文件头 `97 4A 42 32 0D 0A 1A 0A`。 */
const JBIG2_MAGIC = new Uint8Array([0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JBIG2 解码选项。 */
export interface Jbig2DecodeOptions {
  /** 最大像素数，像素；缺省 100,000,000。 */
  maxPixels?: number;
  /** ImageMask 语义：bit0 透明、bit1 黑色；默认 false（白底黑字不透明）。 */
  imageMask?: boolean;
  /** Decode 反相：true 时 bit0 为墨、bit1 为白；默认 false。 */
  decode?: boolean;
  /** `decode` 的兼容别名。 */
  invert?: boolean;
  /** 白色像素是否透明；默认 false。 */
  transparentWhite?: boolean;
  /** warning 回调；多页/失败时上报。 */
  onWarning?: (warning: OFDWarning) => void;
}

/** JBIG2 解码结果附加信息。 */
export interface Jbig2DecodeResult extends DecodedImage {
  /** RGBA 图像数据。 */
  data: ImageDataLike;
  /** 是否为二值图。 */
  bilevel: boolean;
  /** 页数；多页时 >1。 */
  pageCount: number;
  /** 1bpp 位图，行优先、MSB first；bit1 表示墨（默认黑色），用于缓存。 */
  bits: Uint8Array;
  /** 1bpp 位图行跨度，byte。 */
  stride: number;
}

/**
 * 解码 JBIG2/JB2/GBIG2 字节。
 *
 * 无文件头的嵌入式段会自动补一个顺序文件头后再解析；只返回第一页。
 * 失败时先上报 `W_JBIG2_DECODE`（若提供回调），再抛 `OFD_IMAGE_DECODE`/`OFD_LIMIT_EXCEEDED`。
 *
 * @param data JBIG2 文件或嵌入段字节。
 * @param options 像素上限、二值语义与 warning 回调。
 * @returns 解码结果；`data` 为 RGBA ImageDataLike。
 */
export async function decodeJbig2(
  data: Uint8Array,
  options: Jbig2DecodeOptions = {},
): Promise<Jbig2DecodeResult> {
  const maxPixels = normalizeMaxPixels(options.maxPixels);
  const normalized = ensureFileHeader(data);
  let parsed: {
    width: number;
    height: number;
    bitPacked: Uint8ClampedArray;
    pageCount: number;
  };
  try {
    const Parser = Jbig2Image as unknown as new () => {
      parsePage(
        data: Uint8Array,
        options?: { maxPixels?: number },
      ): typeof parsed;
    };
    const parser = new Parser();
    parsed = parser.parsePage(normalized, { maxPixels });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('exceed limit') || message.includes('too large')) {
      const limitMessage = `JBIG2 图像超过像素上限 ${maxPixels}`;
      options.onWarning?.({ code: 'W_JBIG2_DECODE', message: limitMessage });
      throw new OFDError('OFD_LIMIT_EXCEEDED', limitMessage, { cause: error });
    }
    options.onWarning?.({
      code: 'W_JBIG2_DECODE',
      message: `JBIG2 解码失败：${message}`,
    });
    throw new OFDError('OFD_IMAGE_DECODE', `JBIG2 解码失败：${message}`, { cause: error });
  }

  const { width, height, bitPacked, pageCount } = parsed;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    options.onWarning?.({
      code: 'W_JBIG2_DECODE',
      message: `JBIG2 页面尺寸非法：${width}x${height}`,
    });
    throw new OFDError('OFD_IMAGE_DECODE', `JBIG2 页面尺寸非法：${width}x${height}`);
  }
  if (pageCount > 1) {
    options.onWarning?.({
      code: 'W_JBIG2_DECODE',
      message: `JBIG2 含 ${pageCount} 页，仅解码第 1 页`,
    });
  }

  const stride = (width + 7) >> 3;
  const imageData = toRgba(bitPacked, width, height, stride, options);
  return {
    width,
    height,
    data: imageData,
    kind: 'imagedata',
    bilevel: true,
    pageCount,
    bits: Uint8Array.from(bitPacked),
    stride,
  };
}

/**
 * 确保输入带 JBIG2 文件头；无头嵌入段补 `magic + flags(0x03)`。
 *
 * @param data 原始字节。
 * @returns 带文件头的字节。
 */
function ensureFileHeader(data: Uint8Array): Uint8Array {
  let hasMagic = data.byteLength >= JBIG2_MAGIC.byteLength;
  if (hasMagic) {
    for (let index = 0; index < JBIG2_MAGIC.byteLength; index += 1) {
      if (data[index] !== JBIG2_MAGIC[index]) {
        hasMagic = false;
        break;
      }
    }
  }
  if (hasMagic) return data;
  const withHeader = new Uint8Array(JBIG2_MAGIC.byteLength + 1 + data.byteLength);
  withHeader.set(JBIG2_MAGIC, 0);
  // bit0=0 顺序模式；bit1=1 页数未知，避免伪造页数。
  withHeader[JBIG2_MAGIC.byteLength] = 0x03;
  withHeader.set(data, JBIG2_MAGIC.byteLength + 1);
  return withHeader;
}

/**
 * 把 JBIG2 1bpp 页面位图转换为 RGBA。
 *
 * @param bits 1bpp 位图，行优先、MSB first。
 * @param width 宽，像素。
 * @param height 高，像素。
 * @param stride 行跨度，byte。
 * @param options 二值语义选项。
 * @returns RGBA ImageDataLike。
 */
function toRgba(
  bits: Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
  options: Jbig2DecodeOptions,
): ImageDataLike {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const invert = options.decode ?? options.invert ?? false;
  const imageMask = options.imageMask ?? false;
  const transparentWhite = options.transparentWhite ?? false;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const outRow = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const bit = (bits[row + (x >> 3)]! >> (7 - (x & 7))) & 1;
      const ink = invert ? bit === 0 : bit === 1;
      const offset = outRow + x * 4;
      if (imageMask) {
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
        pixels[offset + 3] = ink ? 255 : 0;
      } else if (ink) {
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
        pixels[offset + 3] = 255;
      } else {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = transparentWhite ? 0 : 255;
      }
    }
  }
  return { width, height, data: pixels };
}
