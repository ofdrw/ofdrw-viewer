/**
 * 图片格式识别、头部尺寸读取与解码器插件适配。
 *
 * 识别顺序：扩展名 → magic → `unknown`（由调用方再走解码器探测）。
 * 本文件只做头部解析，不解码像素；JBIG2/TIFF 解码器在需要时通过动态 `import()` 加载，
 * 主包不静态引入解码表。
 */

import type { DecodedImage } from '../common/types';
import type { ImageFormat } from '../model/types';
import type { ImageDecoderPlugin } from '../platform/image-decoder';
import type { OFDWarning } from '../warnings';
import { DEFAULT_MAX_IMAGE_PIXELS, normalizeMaxPixels } from './limits';

/** 图片头部尺寸，单位像素。 */
export interface ImageHeaderSize {
  /** 宽，像素。 */
  width: number;
  /** 高，像素。 */
  height: number;
}

/** 内置动态解码器选项。 */
export interface BuiltinDecoderOptions {
  /** 最大像素数，像素。 */
  maxPixels?: number;
  /** warning 回调。 */
  onWarning?: (warning: OFDWarning) => void;
  /** JBIG2 ImageMask 语义：bit0 透明、bit1 黑色。 */
  imageMask?: boolean;
  /** JBIG2 Decode 反相。 */
  decode?: boolean;
  /** `decode` 兼容别名。 */
  invert?: boolean;
  /** JBIG2 白色是否透明。 */
  transparentWhite?: boolean;
}

/** JBIG2 文件头。 */
const JBIG2_MAGIC = [0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 扩展名到格式。 */
const EXTENSION_FORMATS: Readonly<Record<string, ImageFormat>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  gif: 'gif',
  bmp: 'bmp',
  dib: 'bmp',
  webp: 'webp',
  tif: 'tiff',
  tiff: 'tiff',
  jb2: 'jbig2',
  jbig2: 'jbig2',
  big2: 'jbig2',
};

/**
 * 识别图片格式。
 *
 * @param data 文件字节。
 * @param path 可选包内路径（用于扩展名提示）。
 * @returns 图片格式；无法识别时为 `unknown`。
 */
export function detectImageFormat(data: Uint8Array, path?: string): ImageFormat {
  const extension = path === undefined ? '' : extensionOf(path);
  const byExtension = EXTENSION_FORMATS[extension];
  if (byExtension !== undefined) return byExtension;

  const bytes = data;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && matchesAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'webp';
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])) return 'tiff';
  if (startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(bytes, JBIG2_MAGIC)) return 'jbig2';
  return 'unknown';
}

/**
 * 从图片头部读取宽高（不解码像素）。
 *
 * @param data 文件字节。
 * @param format 已识别格式。
 * @returns 宽高（像素）；格式不支持或头部损坏时返回 null。
 */
export function readImageSize(data: Uint8Array, format: ImageFormat): ImageHeaderSize | null {
  try {
    switch (format.toLowerCase()) {
      case 'png':
        return readPngSize(data);
      case 'jpeg':
        return readJpegSize(data);
      case 'gif':
        return readGifSize(data);
      case 'bmp':
        return readBmpSize(data);
      case 'webp':
        return readWebpSize(data);
      case 'tiff':
        return readTiffSize(data);
      case 'jbig2':
        return readJbig2Size(data);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * 判断宽高是否在像素上限内。
 *
 * @param width 宽，像素。
 * @param height 高，像素。
 * @param maxPixels 最大像素数，像素；缺省 100,000,000。
 * @returns 合法且在限制内时返回 true。
 */
export function isWithinImagePixelLimit(
  width: number,
  height: number,
  maxPixels: number = DEFAULT_MAX_IMAGE_PIXELS,
): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return width * height <= normalizeMaxPixels(maxPixels);
}

/**
 * 读取头部尺寸并做像素上限检查；超限时返回 null。
 *
 * @param data 文件字节。
 * @param format 图片格式。
 * @param maxPixels 最大像素数，像素。
 * @returns 合法尺寸或 null。
 */
export function readImageSizeWithinLimit(
  data: Uint8Array,
  format: ImageFormat,
  maxPixels: number = DEFAULT_MAX_IMAGE_PIXELS,
): ImageHeaderSize | null {
  const size = readImageSize(data, format);
  if (!size || !isWithinImagePixelLimit(size.width, size.height, maxPixels)) return null;
  return size;
}

/** 延迟加载的 JBIG2 插件；导入本对象不会加载解码表。 */
export const jbig2ImageDecoderPlugin: ImageDecoderPlugin = {
  format: 'jbig2',
  async decode(data: Uint8Array): Promise<DecodedImage> {
    const module = await import('./jbig2');
    return module.decodeJbig2(data);
  },
};

/** 延迟加载的 TIFF 插件；导入本对象不会加载解码表。 */
export const tiffImageDecoderPlugin: ImageDecoderPlugin = {
  format: 'tiff',
  async decode(data: Uint8Array): Promise<DecodedImage> {
    const module = await import('./tiff');
    return module.decodeTiff(data);
  },
};

/** 内置 JBIG2/TIFF 插件集合，可直接展开到 `OFDOpenOptions.imageDecoders`。 */
export const builtinImageDecoders: readonly ImageDecoderPlugin[] = Object.freeze([
  jbig2ImageDecoderPlugin,
  tiffImageDecoderPlugin,
]);

/**
 * 在注入插件中按 format 查找解码器（大小写不敏感）。
 *
 * @param plugins 插件列表。
 * @param format 格式标识，例如 `jbig2`/`tiff`。
 * @returns 匹配插件或 undefined。
 */
export function findImageDecoderPlugin(
  plugins: readonly ImageDecoderPlugin[] | undefined,
  format: string,
): ImageDecoderPlugin | undefined {
  const normalized = format.toLowerCase();
  return plugins?.find((plugin) => plugin.format.toLowerCase() === normalized);
}

/**
 * 动态加载内置 JBIG2/TIFF 解码器；其他格式返回 undefined。
 *
 * 该函数中的 `import()` 是唯一的解码器入口，保证构建工具把解码表拆成独立 chunk。
 *
 * @param format 图片格式。
 * @param options 像素上限、二值语义与 warning 回调。
 * @returns 解码器插件或 undefined。
 */
export async function loadBuiltinImageDecoder(
  format: ImageFormat | string,
  options: BuiltinDecoderOptions = {},
): Promise<ImageDecoderPlugin | undefined> {
  const normalized = format.toLowerCase();
  if (normalized === 'jbig2') {
    const module = await import('./jbig2');
    return {
      format: 'jbig2',
      decode: (data: Uint8Array): Promise<DecodedImage> => module.decodeJbig2(data, options),
    };
  }
  if (normalized === 'tiff') {
    const module = await import('./tiff');
    return {
      format: 'tiff',
      decode: (data: Uint8Array): Promise<DecodedImage> => module.decodeTiff(data, options),
    };
  }
  return undefined;
}

/**
 * 解析插件：优先使用宿主注入，其次按需加载内置 JBIG2/TIFF。
 *
 * @param format 图片格式。
 * @param plugins 宿主插件列表。
 * @param options 内置解码器选项。
 * @returns 解码器插件或 undefined。
 */
export async function resolveImageDecoder(
  format: ImageFormat | string,
  plugins?: readonly ImageDecoderPlugin[],
  options: BuiltinDecoderOptions = {},
): Promise<ImageDecoderPlugin | undefined> {
  return findImageDecoderPlugin(plugins, format) ?? (await loadBuiltinImageDecoder(format, options));
}

/**
 * 用插件解码并统一处理缺失/失败 warning；失败返回 undefined，不阻断整页。
 *
 * @param data 图片字节。
 * @param format 图片格式。
 * @param plugins 插件列表。
 * @param options 像素上限与 warning 回调。
 * @returns 解码结果或 undefined。
 */
export async function decodeWithImageDecoder(
  data: Uint8Array,
  format: ImageFormat | string,
  plugins: readonly ImageDecoderPlugin[] | undefined,
  options: BuiltinDecoderOptions = {},
): Promise<DecodedImage | undefined> {
  let plugin = findImageDecoderPlugin(plugins, format);
  if (!plugin) {
    // JBIG2/TIFF 有内置动态 chunk；宿主未注入时按需加载。
    plugin = await loadBuiltinImageDecoder(format, options);
  }
  if (!plugin) {
    emit(options.onWarning, warningCodeFor(format), `缺少 ${format} 图片解码器，已跳过`);
    return undefined;
  }
  const header = readImageSize(data, format as ImageFormat);
  if (header && !isWithinImagePixelLimit(header.width, header.height, options.maxPixels)) {
    emit(
      options.onWarning,
      warningCodeFor(format),
      `${format} 图片 ${header.width}x${header.height} 超过像素上限 ${normalizeMaxPixels(options.maxPixels)}`,
    );
    return undefined;
  }
  try {
    const decoded = await plugin.decode(data);
    if (
      !Number.isFinite(decoded.width) ||
      !Number.isFinite(decoded.height) ||
      decoded.width <= 0 ||
      decoded.height <= 0
    ) {
      emit(options.onWarning, warningCodeFor(format), `${format} 解码结果尺寸非法，已跳过`);
      return undefined;
    }
    if (!isWithinImagePixelLimit(decoded.width, decoded.height, options.maxPixels)) {
      emit(options.onWarning, warningCodeFor(format), `${format} 解码结果超过像素上限，已跳过`);
      return undefined;
    }
    return decoded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(options.onWarning, warningCodeFor(format), `${format} 解码失败：${message}`);
    return undefined;
  }
}

/**
 * 取路径扩展名（小写，不含点）；支持 URL query/hash。
 *
 * @param path 包内路径或 URL。
 * @returns 扩展名。
 */
function extensionOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * 判断字节是否以给定前缀开始。
 *
 * @param data 字节。
 * @param prefix 前缀。
 * @returns 是否匹配。
 */
function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * 判断指定偏移处是否匹配字节序列。
 *
 * @param data 字节。
 * @param offset 偏移，byte。
 * @param expected 期望字节。
 * @returns 是否匹配。
 */
function matchesAt(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > data.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (data[offset + index] !== expected[index]) return false;
  }
  return true;
}

/**
 * 读取 PNG IHDR 尺寸。
 *
 * @param data 文件字节。
 * @returns 尺寸或 null。
 */
function readPngSize(data: Uint8Array): ImageHeaderSize | null {
  if (data.byteLength < 24 || !startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return null;
  }
  if (!matchesAt(data, 12, [0x49, 0x48, 0x44, 0x52])) return null;
  const width = readUint32BE(data, 16);
  const height = readUint32BE(data, 20);
  return validSize(width, height);
}

/**
 * 扫描 JPEG 标记直到 SOF，读取宽高。
 *
 * @param data 文件字节。
 * @returns 尺寸或 null。
 */
function readJpegSize(data: Uint8Array): ImageHeaderSize | null {
  if (!startsWith(data, [0xff, 0xd8, 0xff])) return null;
  let offset = 2;
  while (offset + 4 <= data.byteLength) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = data[offset + 1]!;
    offset += 2;
    while (marker === 0xff) {
      if (offset >= data.byteLength) return null;
      marker = data[offset]!;
      offset += 1;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > data.byteLength) return null;
    const segmentLength = (data[offset]! << 8) | data[offset + 1]!;
    if (segmentLength < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 7 > data.byteLength) return null;
      const height = (data[offset + 3]! << 8) | data[offset + 4]!;
      const width = (data[offset + 5]! << 8) | data[offset + 6]!;
      return validSize(width, height);
    }
    offset += segmentLength;
  }
  return null;
}

/**
 * 读取 GIF 逻辑屏幕尺寸。
 *
 * @param data 文件字节。
 * @returns 尺寸或 null。
 */
function readGifSize(data: Uint8Array): ImageHeaderSize | null {
  if (data.byteLength < 10 || !startsWith(data, [0x47, 0x49, 0x46, 0x38])) return null;
  return validSize(readUint16LE(data, 6), readUint16LE(data, 8));
}

/**
 * 读取 BMP 信息头尺寸。
 *
 * @param data 文件字节。
 * @returns 尺寸或 null。
 */
function readBmpSize(data: Uint8Array): ImageHeaderSize | null {
  if (data.byteLength < 26 || !startsWith(data, [0x42, 0x4d])) return null;
  const headerSize = readUint32LE(data, 14);
  if (headerSize < 12) return null;
  const width =
    headerSize >= 40 ? readInt32LE(data, 18) : (data[18]! | (data[19]! << 8));
  const height =
    headerSize >= 40 ? Math.abs(readInt32LE(data, 22)) : (data[20]! | (data[21]! << 8));
  return validSize(width, height);
}

/**
 * 读取 WebP VP8X 画布尺寸。
 *
 * @param data 文件字节。
 * @returns 尺寸或 null。
 */
function readWebpSize(data: Uint8Array): ImageHeaderSize | null {
  if (
    data.byteLength < 30 ||
    !startsWith(data, [0x52, 0x49, 0x46, 0x46]) ||
    !matchesAt(data, 8, [0x57, 0x45, 0x42, 0x50]) ||
    !matchesAt(data, 12, [0x56, 0x50, 0x38, 0x58])
  ) {
    return null;
  }
  const width = 1 + readUint24LE(data, 24);
  const height = 1 + readUint24LE(data, 27);
  return validSize(width, height);
}

/**
 * 读取 TIFF 第一 IFD 的 ImageWidth/ImageLength。
 *
 * 只解析 IFD 条目，不解压条带/瓦片，因此可在解码前做像素上限检查。
 *
 * @param data 文件字节。
 * @returns 尺寸或 null。
 */
function readTiffSize(data: Uint8Array): ImageHeaderSize | null {
  if (data.byteLength < 8) return null;
  let little: boolean;
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00])) little = true;
  else if (startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) little = false;
  else return null;
  const ifdOffset = readUint32(data, 4, little);
  if (ifdOffset + 2 > data.byteLength) return null;
  const count = readUint16(data, ifdOffset, little);
  if (count > 1000) return null;
  let width = 0;
  let height = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > data.byteLength) return null;
    const tag = readUint16(data, entry, little);
    if (tag !== 256 && tag !== 257) continue;
    const type = readUint16(data, entry + 2, little);
    const valueCount = readUint32(data, entry + 4, little);
    if (valueCount < 1) continue;
    let value: number;
    if (type === 3) value = readUint16(data, entry + 8, little);
    else if (type === 4) value = readUint32(data, entry + 8, little);
    else return null;
    if (tag === 256) width = value;
    else height = value;
  }
  return validSize(width, height);
}


/**
 * 读取 JBIG2 第一页页面信息段的宽高。
 *
 * 仅遍历段头，不解码区域；无头嵌入式段从偏移 0 开始。
 *
 * @param data 文件字节。
 * @returns 尺寸或 null。
 */
function readJbig2Size(data: Uint8Array): ImageHeaderSize | null {
  let position = 0;
  if (startsWith(data, JBIG2_MAGIC)) {
    if (data.byteLength < 9) return null;
    const flags = data[8]!;
    position = 9 + ((flags & 2) === 0 ? 4 : 0);
  }
  let guard = 0;
  while (position + 11 <= data.byteLength) {
    if (++guard > 100000) return null;
    const segmentNumber = readUint32BE(data, position);
    const flags = data[position + 4]!;
    const type = flags & 0x3f;
    const pageAssociationSize = (flags & 0x40) === 0 ? 1 : 4;
    const referredFlags = data[position + 5]!;
    let referredCount = (referredFlags >> 5) & 7;
    let cursor = position + 6;
    if (referredFlags === 7) {
      if (cursor + 3 > data.byteLength) return null;
      referredCount = readUint32BE(data, position + 5) & 0x1fffffff;
      cursor += 3;
      const retainBytes = (referredCount + 7) >> 3;
      if (cursor + retainBytes > data.byteLength) return null;
      cursor += retainBytes;
    } else if (referredFlags === 5 || referredFlags === 6) {
      return null;
    }
    const numberSize = segmentNumber <= 256 ? 1 : segmentNumber <= 65536 ? 2 : 4;
    cursor += referredCount * numberSize;
    cursor += pageAssociationSize;
    if (cursor + 4 > data.byteLength) return null;
    const length = readUint32BE(data, cursor);
    cursor += 4;
    if (length === 0xffffffff) return null;
    if (type === 48) {
      if (cursor + 8 > data.byteLength) return null;
      return validSize(readUint32BE(data, cursor), readUint32BE(data, cursor + 4));
    }
    position = cursor + length;
  }
  return null;
}

/**
 * 校验尺寸为正有限整数。
 *
 * @param width 宽，像素。
 * @param height 高，像素。
 * @returns 尺寸或 null。
 */
function validSize(width: number, height: number): ImageHeaderSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

/** 读取无符号 16 位小端。 */
function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

/** 读取无符号 16 位（按字节序）。 */
function readUint16(data: Uint8Array, offset: number, little: boolean): number {
  return little ? readUint16LE(data, offset) : (data[offset]! << 8) | data[offset + 1]!;
}

/** 读取无符号 24 位小端。 */
function readUint24LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

/** 读取无符号 32 位大端。 */
function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! * 0x1000000 +
      (data[offset + 1]! << 16) +
      (data[offset + 2]! << 8) +
      data[offset + 3]!) >>>
    0
  );
}

/** 读取无符号 32 位小端。 */
function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

/** 读取有符号 32 位小端。 */
function readInt32LE(data: Uint8Array, offset: number): number {
  return (
    data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)
  );
}

/** 读取无符号 32 位（按字节序）。 */
function readUint32(data: Uint8Array, offset: number, little: boolean): number {
  return little ? readUint32LE(data, offset) : readUint32BE(data, offset);
}

/**
 * 上报 warning。
 *
 * @param handler 回调。
 * @param code warning 码。
 * @param message 诊断信息。
 */
function emit(
  handler: ((warning: OFDWarning) => void) | undefined,
  code: OFDWarning['code'],
  message: string,
): void {
  handler?.({ code, message });
}

/**
 * 选择 warning 码：JBIG2/TIFF 使用设计方案的专用码，其余使用通用图片解码码。
 *
 * @param format 格式。
 * @returns warning 码。
 */
function warningCodeFor(format: string): OFDWarning['code'] {
  const normalized = format.toLowerCase();
  return normalized === 'jbig2' || normalized === 'tiff' ? 'W_JBIG2_DECODE' : 'W_IMAGE_DECODE';
}
