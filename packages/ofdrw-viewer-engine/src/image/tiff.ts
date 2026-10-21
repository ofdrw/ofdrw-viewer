/**
 * TIFF 解码（纯 JS 动态 chunk）。
 *
 * 支持 baseline、LZW、PackBits、Deflate；单页/第一帧；1/4/8/16 位；
 * WhiteIsZero/BlackIsZero/RGB/CMYK/Palette；条带与瓦片。缺失条带/瓦片按白色补。
 * 不支持 PlanarConfiguration=2、浮点、YCbCr 与复杂 ICC。
 */

import type { DecodedImage, ImageDataLike } from '../common/types';
import type { OFDWarning } from '../warnings';
import { OFDError } from '../errors';
import { normalizeMaxPixels } from './limits';
import { isWithinImagePixelLimit } from './format';

/** TIFF 解码选项。 */
export interface TiffDecodeOptions {
  /** 最大像素数，像素；缺省 100,000,000。 */
  maxPixels?: number;
  /** warning 回调；失败/降级时上报。 */
  onWarning?: (warning: OFDWarning) => void;
}

/** TIFF 解码结果附加信息。 */
export interface TiffDecodeResult extends DecodedImage {
  /** RGBA 图像数据。 */
  data: ImageDataLike;
  /** 实际解码的帧索引，通常为 0。 */
  frameIndex: number;
}

/** TIFF 标签号。 */
const TAG = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfig: 284,
  Predictor: 317,
  ColorMap: 320,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  ExtraSamples: 338,
} as const;

/** 解析后的 TIFF 布局。 */
interface TiffInfo {
  little: boolean;
  width: number;
  height: number;
  bitsPerSample: number[];
  samplesPerPixel: number;
  compression: number;
  photometric: number;
  predictor: number;
  rowsPerStrip: number;
  stripOffsets: number[];
  stripByteCounts: number[];
  tileWidth?: number;
  tileHeight?: number;
  tileOffsets?: number[];
  tileByteCounts?: number[];
  colorMap?: number[];
  extraSamples: number[];
}

/** TIFF 结构错误。 */
class TiffError extends Error {
  /**
   * @param message 错误信息。
   */
  constructor(message: string) {
    super(message);
    this.name = 'TiffError';
  }
}

/**
 * 解码 TIFF 字节。
 *
 * @param data TIFF 文件字节。
 * @param options 像素上限与 warning 回调。
 * @returns 解码结果；`data` 为 RGBA ImageDataLike，帧索引为 0。
 * @throws OFDError `OFD_IMAGE_DECODE` 数据损坏/不支持，`OFD_LIMIT_EXCEEDED` 超过像素上限。
 */
export async function decodeTiff(
  data: Uint8Array,
  options: TiffDecodeOptions = {},
): Promise<TiffDecodeResult> {
  const maxPixels = normalizeMaxPixels(options.maxPixels);
  let info: TiffInfo;
  try {
    info = parseTiff(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onWarning?.({ code: 'W_JBIG2_DECODE', message: `TIFF 解码失败：${message}` });
    throw new OFDError('OFD_IMAGE_DECODE', `TIFF 解码失败：${message}`, { cause: error });
  }

  if (!isWithinImagePixelLimit(info.width, info.height, maxPixels)) {
    const message = `TIFF 图像 ${info.width}x${info.height} 超过像素上限 ${maxPixels}`;
    options.onWarning?.({ code: 'W_JBIG2_DECODE', message });
    throw new OFDError('OFD_LIMIT_EXCEEDED', message);
  }

  try {
    const pixels = await renderTiff(data, info);
    return {
      width: info.width,
      height: info.height,
      data: { width: info.width, height: info.height, data: pixels },
      kind: 'imagedata',
      frameIndex: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onWarning?.({ code: 'W_JBIG2_DECODE', message: `TIFF 解码失败：${message}` });
    throw new OFDError('OFD_IMAGE_DECODE', `TIFF 解码失败：${message}`, { cause: error });
  }
}

/**
 * 解析 TIFF 头、第一 IFD 与像素布局。
 *
 * @param data 文件字节。
 * @returns 布局信息。
 */
function parseTiff(data: Uint8Array): TiffInfo {
  if (data.byteLength < 8) throw new TiffError('文件过短');
  let little: boolean;
  if (data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) {
    little = true;
  } else if (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a) {
    little = false;
  } else {
    throw new TiffError('字节序/魔数非法');
  }
  const ifdOffset = readUint32(data, 4, little);
  if (ifdOffset + 2 > data.byteLength) throw new TiffError('IFD 越界');
  const entryCount = readUint16(data, ifdOffset, little);
  if (entryCount === 0 || entryCount > 1000) throw new TiffError('IFD 条目数非法');

  const entries = new Map<number, { values: number[]; type: number }>();
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > data.byteLength) throw new TiffError('IFD 条目越界');
    const tag = readUint16(data, entryOffset, little);
    const type = readUint16(data, entryOffset + 2, little);
    const count = readUint32(data, entryOffset + 4, little);
    const values = readEntryValues(data, entryOffset, type, count, little);
    entries.set(tag, { values, type });
  }

  const width = firstValue(entries, TAG.ImageWidth);
  const height = firstValue(entries, TAG.ImageLength);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TiffError('ImageWidth/ImageLength 非法');
  }

  const compression = firstValue(entries, TAG.Compression, 1);
  const photometric = firstValue(entries, TAG.Photometric, 0);
  const planar = firstValue(entries, TAG.PlanarConfig, 1);
  if (planar !== 1) throw new TiffError('仅支持 chunky PlanarConfiguration=1');
  const predictor = firstValue(entries, TAG.Predictor, 1);
  if (predictor !== 1 && predictor !== 2) throw new TiffError(`不支持 Predictor=${predictor}`);
  if (![0, 1, 2, 3, 5].includes(photometric)) {
    throw new TiffError(`不支持 PhotometricInterpretation=${photometric}`);
  }

  const sampleValues = entries.get(TAG.SamplesPerPixel)?.values;
  let samplesPerPixel = sampleValues?.[0] ?? 1;
  if (photometric === 2 && sampleValues === undefined) samplesPerPixel = 3;
  if (photometric === 5 && sampleValues === undefined) samplesPerPixel = 4;
  if (samplesPerPixel < 1 || samplesPerPixel > 8) throw new TiffError('SamplesPerPixel 非法');

  const bitValues = entries.get(TAG.BitsPerSample)?.values;
  const bitsPerSample = normalizeBits(bitValues, samplesPerPixel);
  if (predictor === 2 && bitsPerSample.some((bits) => bits !== 8 && bits !== 16)) {
    throw new TiffError('Predictor=2 仅支持 8/16 位');
  }

  const rowsPerStrip = firstValue(entries, TAG.RowsPerStrip, height) || height;
  const stripOffsets = entries.get(TAG.StripOffsets)?.values ?? [];
  const stripByteCounts = entries.get(TAG.StripByteCounts)?.values ?? [];
  const tileWidth = firstValue(entries, TAG.TileWidth, 0);
  const tileHeight = firstValue(entries, TAG.TileLength, 0);
  const tileOffsets = entries.get(TAG.TileOffsets)?.values;
  const tileByteCounts = entries.get(TAG.TileByteCounts)?.values;
  const colorMap = entries.get(TAG.ColorMap)?.values;
  const extraSamples = entries.get(TAG.ExtraSamples)?.values ?? [];

  if (tileOffsets && tileWidth > 0 && tileHeight > 0) {
    if (!tileByteCounts) throw new TiffError('瓦片缺少 TileByteCounts');
  } else if (stripOffsets.length === 0) {
    throw new TiffError('缺少 StripOffsets/TileOffsets');
  }

  return {
    little,
    width,
    height,
    bitsPerSample,
    samplesPerPixel,
    compression,
    photometric,
    predictor,
    rowsPerStrip,
    stripOffsets,
    stripByteCounts,
    tileWidth: tileWidth > 0 ? tileWidth : undefined,
    tileHeight: tileHeight > 0 ? tileHeight : undefined,
    tileOffsets,
    tileByteCounts,
    colorMap,
    extraSamples,
  };
}

/**
 * 读取 IFD 条目的内联或偏移值。
 *
 * @param data 文件字节。
 * @param entryOffset 条目偏移，byte。
 * @param type 字段类型。
 * @param count 元素个数。
 * @param little 是否小端。
 * @returns 数值数组。
 */
function readEntryValues(
  data: Uint8Array,
  entryOffset: number,
  type: number,
  count: number,
  little: boolean,
): number[] {
  const unit = typeSize(type);
  if (unit === 0) return [];
  const total = unit * count;
  if (!Number.isSafeInteger(total) || total < 0) throw new TiffError('字段长度溢出');
  const start = total <= 4 ? entryOffset + 8 : readUint32(data, entryOffset + 8, little);
  if (start + total > data.byteLength) throw new TiffError('字段值越界');
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = start + index * unit;
    if (type === 1) values.push(data[offset]!);
    else if (type === 3) values.push(readUint16(data, offset, little));
    else if (type === 4) values.push(readUint32(data, offset, little));
    else if (type === 5) values.push(readUint32(data, offset, little));
    else values.push(0);
  }
  return values;
}

/** 返回字段类型字节数；未知类型返回 0。 */
function typeSize(type: number): number {
  switch (type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return 1;
    case 3:
    case 8:
      return 2;
    case 4:
    case 9:
    case 11:
      return 4;
    case 5:
    case 10:
    case 12:
      return 8;
    default:
      return 0;
  }
}

/** 读取首个标签值。 */
function firstValue(
  entries: Map<number, { values: number[]; type: number }>,
  tag: number,
  fallback = 0,
): number {
  return entries.get(tag)?.values[0] ?? fallback;
}

/**
 * 归一化 BitsPerSample：支持单值/每通道同值；混合位深不支持。
 *
 * @param values 原始值。
 * @param samplesPerPixel 通道数。
 * @returns 每通道位数。
 */
function normalizeBits(values: number[] | undefined, samplesPerPixel: number): number[] {
  if (!values || values.length === 0) return new Array(samplesPerPixel).fill(1);
  if (values.length === 1) return new Array(samplesPerPixel).fill(values[0]);
  if (values.length !== samplesPerPixel) throw new TiffError('BitsPerSample 数量与通道数不符');
  const first = values[0]!;
  if (values.some((value) => value !== first)) throw new TiffError('不支持混合 BitsPerSample');
  if (![1, 4, 8, 16].includes(first)) throw new TiffError(`不支持 ${first} 位样本`);
  return values.slice();
}

/**
 * 解码条带/瓦片并合成 RGBA。
 *
 * @param data 文件字节。
 * @param info 布局。
 * @returns RGBA 字节数组。
 */
async function renderTiff(data: Uint8Array, info: TiffInfo): Promise<Uint8ClampedArray> {
  const output = new Uint8ClampedArray(info.width * info.height * 4);
  output.fill(255);

  if (info.tileOffsets && info.tileWidth && info.tileHeight) {
    const across = Math.ceil(info.width / info.tileWidth);
    const down = Math.ceil(info.height / info.tileHeight);
    const tileRowBytes = rowBytes(info.tileWidth, info.bitsPerSample);
    for (let index = 0; index < across * down; index += 1) {
      const offset = info.tileOffsets[index] ?? 0;
      const count = info.tileByteCounts?.[index] ?? 0;
      if (offset <= 0 || count <= 0 || offset >= data.byteLength) continue;
      const raw = await decompress(data.subarray(offset, Math.min(data.byteLength, offset + count)), info.compression);
      const padded = padTo(raw, tileRowBytes * info.tileHeight);
      if (info.predictor === 2) applyPredictor(padded, info, info.tileWidth, info.tileHeight);
      const x0 = (index % across) * info.tileWidth;
      const y0 = Math.floor(index / across) * info.tileHeight;
      decodeRows(output, padded, info, info.tileWidth, info.tileHeight, x0, y0, info.width, info.height);
    }
    return output;
  }

  const rowLength = rowBytes(info.width, info.bitsPerSample);
  const strips = Math.max(
    1,
    Math.ceil(info.height / Math.max(1, info.rowsPerStrip)),
  );
  for (let index = 0; index < strips; index += 1) {
    const y0 = index * info.rowsPerStrip;
    const rows = Math.min(info.rowsPerStrip, info.height - y0);
    if (rows <= 0) break;
    const offset = info.stripOffsets[index] ?? 0;
    const count = info.stripByteCounts[index] ?? 0;
    if (offset <= 0 || count <= 0 || offset >= data.byteLength) continue;
    const raw = await decompress(
      data.subarray(offset, Math.min(data.byteLength, offset + count)),
      info.compression,
    );
    const padded = padTo(raw, rowLength * rows);
    if (info.predictor === 2) applyPredictor(padded, info, info.width, rows);
    decodeRows(output, padded, info, info.width, rows, 0, y0, info.width, info.height);
  }
  return output;
}

/**
 * 计算一行字节数（含位打包填充）。
 *
 * @param width 宽，像素。
 * @param bits 每通道位数。
 * @returns 行字节数。
 */
function rowBytes(width: number, bits: number[]): number {
  const bitsPerPixel = bits.reduce((sum, value) => sum + value, 0);
  return Math.ceil((width * bitsPerPixel) / 8);
}

/**
 * 把解压结果补齐到期望长度；超出时截断。
 *
 * @param raw 原始字节。
 * @param expected 期望长度，byte。
 * @returns 补齐后的字节。
 */
function padTo(raw: Uint8Array, expected: number): Uint8Array {
  if (raw.byteLength === expected) return raw;
  const output = new Uint8Array(expected);
  output.set(raw.subarray(0, expected));
  return output;
}

/**
 * 应用 TIFF Predictor=2（水平差分）到 8/16 位样本。
 *
 * @param raw 解压后的字节，原地修改。
 * @param info 布局。
 * @param width 行宽，像素。
 * @param rows 行数。
 */
function applyPredictor(raw: Uint8Array, info: TiffInfo, width: number, rows: number): void {
  const samplesPerRow = width * info.samplesPerPixel;
  const bytesPerSample = info.bitsPerSample[0]! / 8;
  for (let row = 0; row < rows; row += 1) {
    const rowStart = row * rowBytes(width, info.bitsPerSample);
    const maxSample = (1 << info.bitsPerSample[0]!) - 1;
    for (let sample = info.samplesPerPixel; sample < samplesPerRow; sample += 1) {
      const offset = rowStart + sample * bytesPerSample;
      const previousOffset = rowStart + (sample - info.samplesPerPixel) * bytesPerSample;
      if (bytesPerSample === 1) {
        raw[offset] = (raw[offset]! + raw[previousOffset]!) & 0xff;
      } else if (offset + 1 < raw.byteLength) {
        const value = readUint16(raw, offset, info.little);
        const previous = readUint16(raw, previousOffset, info.little);
        writeUint16(raw, offset, (value + previous) & maxSample, info.little);
      }
    }
  }
}

/**
 * 逐行解码条带/瓦片并写入 RGBA。
 *
 * @param output RGBA 输出。
 * @param raw 解压后的字节。
 * @param info 布局。
 * @param width 数据行宽，像素（瓦片时为 tileWidth）。
 * @param rows 行数。
 * @param x0 目标起点 X，像素。
 * @param y0 目标起点 Y，像素。
 * @param imageWidth 图像宽，像素。
 * @param imageHeight 图像高，像素。
 */
function decodeRows(
  output: Uint8ClampedArray,
  raw: Uint8Array,
  info: TiffInfo,
  width: number,
  rows: number,
  x0: number,
  y0: number,
  imageWidth: number,
  imageHeight: number,
): void {
  const bitsPerPixel = info.bitsPerSample.reduce((sum, value) => sum + value, 0);
  const strideBytes = Math.ceil((width * bitsPerPixel) / 8);
  for (let row = 0; row < rows; row += 1) {
    const y = y0 + row;
    if (y >= imageHeight) break;
    const rowStart = row * strideBytes;
    for (let x = 0; x < width; x += 1) {
      const targetX = x0 + x;
      if (targetX >= imageWidth) break;
      const samples = readPixelSamples(raw, rowStart, x, info);
      const offset = (y * imageWidth + targetX) * 4;
      writePixel(output, offset, samples, info);
    }
  }
}

/**
 * 读取一个像素的样本值。
 *
 * @param raw 原始字节。
 * @param rowStart 行起始偏移，byte。
 * @param x 行内像素索引。
 * @param info 布局。
 * @returns 样本数组（长度 samplesPerPixel）。
 */
function readPixelSamples(
  raw: Uint8Array,
  rowStart: number,
  x: number,
  info: TiffInfo,
): number[] {
  const samples: number[] = [];
  let bitOffset = rowStart * 8;
  const pixelBitOffset = x * info.bitsPerSample.reduce((sum, value) => sum + value, 0);
  bitOffset += pixelBitOffset;
  for (let channel = 0; channel < info.samplesPerPixel; channel += 1) {
    const bits = info.bitsPerSample[channel]!;
    samples.push(readBits(raw, bitOffset, bits, info.little));
    bitOffset += bits;
  }
  return samples;
}

/**
 * 按 MSB-first 读取 1/4/8/16 位样本。
 *
 * @param raw 字节。
 * @param bitOffset 位偏移。
 * @param bits 位数。
 * @param little 16 位时是否小端。
 * @returns 样本值。
 */
function readBits(raw: Uint8Array, bitOffset: number, bits: number, little: boolean): number {
  if (bits === 8) return raw[bitOffset >> 3] ?? 0;
  if (bits === 16) {
    const byteOffset = bitOffset >> 3;
    return readUint16(raw, byteOffset, little);
  }
  if (bits === 4) {
    const byte = raw[bitOffset >> 3] ?? 0;
    return (bitOffset & 4) === 0 ? byte >> 4 : byte & 0x0f;
  }
  if (bits === 1) {
    const byte = raw[bitOffset >> 3] ?? 0;
    return (byte >> (7 - (bitOffset & 7))) & 1;
  }
  return 0;
}

/**
 * 把样本转换为 RGBA 并写入输出。
 *
 * @param output RGBA 输出。
 * @param offset 输出偏移，byte。
 * @param samples 样本数组。
 * @param info 布局。
 */
function writePixel(
  output: Uint8ClampedArray,
  offset: number,
  samples: number[],
  info: TiffInfo,
): void {
  const bits = info.bitsPerSample[0]!;
  const baseSamples = info.photometric === 2 ? 3 : info.photometric === 5 ? 4 : 1;
  const alpha =
    info.samplesPerPixel > baseSamples
      ? scaleSample(samples[baseSamples] ?? 0, info.bitsPerSample[baseSamples] ?? bits)
      : 255;

  if (info.photometric === 0 || info.photometric === 1) {
    let gray = scaleSample(samples[0] ?? 0, bits);
    if (info.photometric === 0) gray = 255 - gray;
    output[offset] = gray;
    output[offset + 1] = gray;
    output[offset + 2] = gray;
    output[offset + 3] = alpha;
    return;
  }
  if (info.photometric === 2) {
    output[offset] = scaleSample(samples[0] ?? 0, info.bitsPerSample[0] ?? bits);
    output[offset + 1] = scaleSample(samples[1] ?? 0, info.bitsPerSample[1] ?? bits);
    output[offset + 2] = scaleSample(samples[2] ?? 0, info.bitsPerSample[2] ?? bits);
    output[offset + 3] = alpha;
    return;
  }
  if (info.photometric === 3) {
    const index = samples[0] ?? 0;
    const map = info.colorMap;
    const entries = 1 << bits;
    if (!map || map.length < entries * 3) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
      output[offset + 3] = alpha;
      return;
    }
    output[offset] = (map[index] ?? 0) >> 8;
    output[offset + 1] = (map[entries + index] ?? 0) >> 8;
    output[offset + 2] = (map[entries * 2 + index] ?? 0) >> 8;
    output[offset + 3] = alpha;
    return;
  }
  if (info.photometric === 5) {
    const c = scaleSample(samples[0] ?? 0, info.bitsPerSample[0] ?? bits);
    const m = scaleSample(samples[1] ?? 0, info.bitsPerSample[1] ?? bits);
    const y = scaleSample(samples[2] ?? 0, info.bitsPerSample[2] ?? bits);
    const k = scaleSample(samples[3] ?? 0, info.bitsPerSample[3] ?? bits);
    output[offset] = Math.round(255 * (1 - c / 255) * (1 - k / 255));
    output[offset + 1] = Math.round(255 * (1 - m / 255) * (1 - k / 255));
    output[offset + 2] = Math.round(255 * (1 - y / 255) * (1 - k / 255));
    output[offset + 3] = alpha;
    return;
  }
  output[offset] = 0;
  output[offset + 1] = 0;
  output[offset + 2] = 0;
  output[offset + 3] = alpha;
}

/**
 * 把样本缩放到 0..255。
 *
 * @param value 样本值。
 * @param bits 位数。
 * @returns 0..255。
 */
function scaleSample(value: number, bits: number): number {
  if (bits === 16) return Math.round((value & 0xffff) / 257);
  if (bits === 8) return value & 0xff;
  if (bits === 4) return (value & 0x0f) * 17;
  if (bits === 1) return (value & 1) * 255;
  return 0;
}

/**
 * 按压缩方式解压条带/瓦片。
 *
 * @param raw 压缩字节。
 * @param compression 压缩标签。
 * @returns 解压字节。
 */
async function decompress(raw: Uint8Array, compression: number): Promise<Uint8Array> {
  switch (compression) {
    case 1:
      return raw;
    case 5:
      return decodeLzw(raw);
    case 8:
    case 32946:
      return inflateZlib(raw);
    case 32773:
      return decodePackBits(raw);
    default:
      throw new TiffError(`不支持 Compression=${compression}`);
  }
}

/**
 * 解码 TIFF LZW（MSB-first，early change）。
 *
 * @param data 压缩字节。
 * @returns 解压字节。
 */
function decodeLzw(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let dictionary: Uint8Array[] = [];
  let nextCode = 258;
  let codeWidth = 9;
  let previous: Uint8Array | null = null;
  let bitPosition = 0;
  const totalBits = data.byteLength * 8;

  const reset = (): void => {
    dictionary = new Array(256);
    for (let index = 0; index < 256; index += 1) dictionary[index] = Uint8Array.of(index);
    nextCode = 258;
    codeWidth = 9;
    previous = null;
  };
  const readCode = (): number => {
    let code = 0;
    for (let bit = 0; bit < codeWidth; bit += 1) {
      const position = bitPosition + bit;
      const byte = data[position >> 3] ?? 0;
      code = (code << 1) | ((byte >> (7 - (position & 7))) & 1);
    }
    bitPosition += codeWidth;
    return code;
  };

  reset();
  while (bitPosition + codeWidth <= totalBits) {
    const code = readCode();
    if (code === 256) {
      reset();
      continue;
    }
    if (code === 257) break;

    let entry: Uint8Array;
    if (code < nextCode && dictionary[code]) {
      entry = dictionary[code]!;
    } else if (code === nextCode && previous) {
      entry = new Uint8Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = previous[0]!;
    } else {
      throw new TiffError('LZW 码流非法');
    }
    for (let index = 0; index < entry.length; index += 1) output.push(entry[index]!);

    if (previous && nextCode < 4096) {
      const combined = new Uint8Array(previous.length + 1);
      combined.set(previous);
      combined[previous.length] = entry[0]!;
      dictionary[nextCode] = combined;
      nextCode += 1;
      if (nextCode === (1 << codeWidth) - 1 && codeWidth < 12) codeWidth += 1;
    }
    previous = entry;
  }
  return Uint8Array.from(output);
}

/**
 * 解码 PackBits。
 *
 * @param data 压缩字节。
 * @returns 解压字节。
 */
function decodePackBits(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let offset = 0;
  while (offset < data.byteLength) {
    const header = (data[offset]! << 24) >> 24;
    offset += 1;
    if (header >= 0) {
      const count = header + 1;
      for (let index = 0; index < count && offset < data.byteLength; index += 1) {
        output.push(data[offset]!);
        offset += 1;
      }
    } else if (header !== -128) {
      const count = 1 - header;
      const value = data[offset] ?? 0;
      offset += 1;
      for (let index = 0; index < count; index += 1) output.push(value);
    }
  }
  return Uint8Array.from(output);
}

/**
 * 解压 zlib/deflate；优先 DecompressionStream，回退 fflate。
 *
 * @param data 压缩字节。
 * @returns 解压字节。
 */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const streamConstructor = (
    globalThis as unknown as {
      DecompressionStream?: new (format: string) => {
        readable: {
          getReader(): {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(reason?: unknown): Promise<void>;
          };
        };
        writable: {
          getWriter(): {
            write(chunk: Uint8Array): Promise<void>;
            close(): Promise<void>;
          };
        };
      };
    }
  ).DecompressionStream;

  if (streamConstructor) {
    try {
      const stream = new streamConstructor('deflate');
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const readPromise = (async (): Promise<Uint8Array> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          total += value.byteLength;
        }
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return output;
      })();
      const writePromise = (async (): Promise<void> => {
        await writer.write(data);
        await writer.close();
      })();
      writePromise.catch(() => {
        void reader.cancel().catch(() => undefined);
      });
      const output = await readPromise;
      await writePromise;
      return output;
    } catch {
      // 继续尝试 fflate；部分环境支持 DecompressionStream 但不支持 zlib。
    }
  }

  const { inflateSync, unzlibSync } = await import('fflate');
  try {
    return unzlibSync(data);
  } catch {
    return inflateSync(data);
  }
}

/** 读取无符号 16 位。 */
function readUint16(data: Uint8Array, offset: number, little: boolean): number {
  if (offset + 1 >= data.byteLength) return 0;
  return little
    ? (data[offset]! | (data[offset + 1]! << 8))
    : ((data[offset]! << 8) | data[offset + 1]!);
}

/** 写入无符号 16 位。 */
function writeUint16(data: Uint8Array, offset: number, value: number, little: boolean): void {
  if (offset + 1 >= data.byteLength) return;
  if (little) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
  } else {
    data[offset] = (value >> 8) & 0xff;
    data[offset + 1] = value & 0xff;
  }
}

/** 读取无符号 32 位。 */
function readUint32(data: Uint8Array, offset: number, little: boolean): number {
  if (offset + 3 >= data.byteLength) return 0;
  return little
    ? (data[offset]! |
        (data[offset + 1]! << 8) |
        (data[offset + 2]! << 16) |
        (data[offset + 3]! << 24)) >>>
        0
    : (((data[offset]! << 24) |
        (data[offset + 1]! << 16) |
        (data[offset + 2]! << 8) |
        data[offset + 3]!) >>>
        0);
}
