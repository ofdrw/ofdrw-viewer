/**
 * GIF 解码（纯 JS 动态 chunk）。
 *
 * 支持 GIF87a/89a、全局/局部调色板、透明色、隔行扫描与 LZW；
 * 动画仅绘制第一帧。输出 RGBA，供 Canvas 直接绘制。
 */

import type { DecodedImage, ImageDataLike } from '../common/types';
import type { OFDWarning } from '../warnings';
import { OFDError } from '../errors';
import { normalizeMaxPixels } from './limits';
import { isWithinImagePixelLimit } from './format';

/** GIF 解码选项。 */
export interface GifDecodeOptions {
  /** 最大像素数，像素；缺省 100,000,000。 */
  maxPixels?: number;
  /** warning 回调；用于非致命降级提示。 */
  onWarning?: (warning: OFDWarning) => void;
}

/** GIF 解码结果附加信息。 */
export interface GifDecodeResult extends DecodedImage {
  /** RGBA 图像数据。 */
  data: ImageDataLike;
  /** 实际解码的帧索引，固定为 0。 */
  frameIndex: number;
}

/** 调色板：RGB 三元组连续存放。 */
interface GifPalette {
  /** 调色板字节，长度 `颜色数 * 3`。 */
  data: Uint8Array;
  /** 颜色数量。 */
  size: number;
}

/** 图形控制扩展状态。 */
interface GifControl {
  /** 透明色索引；undefined 表示不透明。 */
  transparentIndex?: number;
}

/** 解码后的图像帧。 */
interface GifFrame {
  /** 帧左上角 x，像素。 */
  left: number;
  /** 帧左上角 y，像素。 */
  top: number;
  /** 帧宽，像素。 */
  width: number;
  /** 帧高，像素。 */
  height: number;
  /** 是否隔行扫描。 */
  interlaced: boolean;
  /** 帧调色板。 */
  palette: GifPalette;
  /** LZW 压缩数据。 */
  data: Uint8Array;
  /** LZW 最小码长，bit。 */
  minCodeSize: number;
  /** 透明色索引。 */
  transparentIndex?: number;
}

/**
 * 解码 GIF 字节。
 *
 * @param data GIF 文件字节。
 * @param options 像素上限与 warning 回调。
 * @returns 第一帧 RGBA 图像。
 * @throws OFDError 数据损坏/不支持或超过像素上限时。
 */
export async function decodeGif(
  data: Uint8Array,
  options: GifDecodeOptions = {},
): Promise<GifDecodeResult> {
  const maxPixels = normalizeMaxPixels(options.maxPixels);
  let frame: GifFrame;
  let width: number;
  let height: number;
  let background: { palette: GifPalette; index: number } | undefined;
  try {
    const parsed = parseGif(data, maxPixels);
    frame = parsed.frame;
    width = parsed.width;
    height = parsed.height;
    background = parsed.background;
  } catch (error) {
    if (error instanceof OFDError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    options.onWarning?.({ code: 'W_IMAGE_DECODE', message: `GIF 解码失败：${message}` });
    throw new OFDError('OFD_IMAGE_DECODE', `GIF 解码失败：${message}`, { cause: error });
  }

  if (!isWithinImagePixelLimit(width, height, maxPixels)) {
    throw new OFDError(
      'OFD_LIMIT_EXCEEDED',
      `GIF 图像 ${width}x${height} 超过像素上限 ${maxPixels}`,
    );
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  const transparent = frame.transparentIndex;
  if (transparent === undefined && background) {
    fillBackground(pixels, background.palette, background.index);
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeLzw(frame.data, frame.minCodeSize, frame.width * frame.height);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onWarning?.({ code: 'W_IMAGE_DECODE', message: `GIF LZW 解码失败：${message}` });
    throw new OFDError('OFD_IMAGE_DECODE', `GIF LZW 解码失败：${message}`, { cause: error });
  }

  drawFrame(pixels, width, height, frame, decoded);
  return {
    width,
    height,
    data: { width, height, data: pixels },
    kind: 'imagedata',
    frameIndex: 0,
  };
}

/**
 * 解析 GIF 头与第一帧。
 *
 * @param data 文件字节。
 * @param maxPixels 最大像素数，像素。
 * @returns 逻辑屏幕尺寸、第一帧与背景信息。
 */
function parseGif(
  data: Uint8Array,
  maxPixels: number,
): {
  width: number;
  height: number;
  frame: GifFrame;
  background?: { palette: GifPalette; index: number };
} {
  if (data.byteLength < 13) throw new Error('文件头不完整');
  if (
    !startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) &&
    !startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    throw new Error('不是 GIF87a/GIF89a');
  }
  const width = readUint16LE(data, 6);
  const height = readUint16LE(data, 8);
  if (!isWithinImagePixelLimit(width, height, maxPixels)) {
    throw new OFDError(
      'OFD_LIMIT_EXCEEDED',
      `GIF 图像 ${width}x${height} 超过像素上限 ${maxPixels}`,
    );
  }

  const screenPacked = data[10]!;
  const backgroundIndex = data[11]!;
  let offset = 13;
  let globalPalette: GifPalette | undefined;
  if ((screenPacked & 0x80) !== 0) {
    const paletteSize = 2 << (screenPacked & 0x07);
    globalPalette = readPalette(data, offset, paletteSize);
    offset += paletteSize * 3;
  }

  let control: GifControl = {};
  while (offset < data.byteLength) {
    const block = data[offset++]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      if (offset >= data.byteLength) throw new Error('扩展块不完整');
      const label = data[offset++]!;
      if (label === 0xf9) {
        const blockSize = data[offset]!;
        if (blockSize < 4 || offset + blockSize + 1 > data.byteLength) {
          throw new Error('图形控制扩展不完整');
        }
        const packed = data[offset + 1]!;
        const transparentIndex = (packed & 0x01) !== 0 ? data[offset + 4]! : undefined;
        control = { ...(transparentIndex === undefined ? {} : { transparentIndex }) };
        if (data[offset + blockSize + 1] !== 0) throw new Error('图形控制扩展缺少终止符');
        offset += blockSize + 2;
      } else {
        offset = skipSubBlocks(data, offset);
      }
      continue;
    }
    if (block !== 0x2c) throw new Error(`未知块 0x${block.toString(16)}`);
    if (offset + 9 > data.byteLength) throw new Error('图像描述符不完整');
    const left = readUint16LE(data, offset);
    const top = readUint16LE(data, offset + 2);
    const frameWidth = readUint16LE(data, offset + 4);
    const frameHeight = readUint16LE(data, offset + 6);
    const imagePacked = data[offset + 8]!;
    offset += 9;
    if (!isWithinImagePixelLimit(frameWidth, frameHeight, maxPixels)) {
      throw new OFDError(
        'OFD_LIMIT_EXCEEDED',
        `GIF 帧 ${frameWidth}x${frameHeight} 超过像素上限 ${maxPixels}`,
      );
    }
    let palette = globalPalette;
    if ((imagePacked & 0x80) !== 0) {
      const paletteSize = 2 << (imagePacked & 0x07);
      palette = readPalette(data, offset, paletteSize);
      offset += paletteSize * 3;
    }
    if (!palette) throw new Error('图像帧缺少调色板');
    if (offset >= data.byteLength) throw new Error('缺少 LZW 最小码长');
    const minCodeSize = data[offset++]!;
    const subBlocks = readSubBlocks(data, offset);
    const background =
      globalPalette && backgroundIndex < globalPalette.size
        ? { palette: globalPalette, index: backgroundIndex }
        : undefined;
    return {
      width,
      height,
      frame: {
        left,
        top,
        width: frameWidth,
        height: frameHeight,
        interlaced: (imagePacked & 0x40) !== 0,
        palette,
        data: subBlocks.data,
        minCodeSize,
        ...(control.transparentIndex === undefined
          ? {}
          : { transparentIndex: control.transparentIndex }),
      },
      ...(background ? { background } : {}),
    };
  }
  throw new Error('没有图像帧');
}

/**
 * 把第一帧写入 RGBA 画布。
 *
 * @param pixels 目标 RGBA 画布。
 * @param canvasWidth 画布宽，像素。
 * @param canvasHeight 画布高，像素。
 * @param frame 图像帧。
 * @param indices 调色板索引数据。
 */
function drawFrame(
  pixels: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  frame: GifFrame,
  indices: Uint8Array,
): void {
  const rows = interlacedRows(frame.height, frame.interlaced);
  let source = 0;
  for (const row of rows) {
    const y = frame.top + row;
    for (let x = 0; x < frame.width; x += 1) {
      if (source >= indices.length) return;
      const index = indices[source++]!;
      if (index >= frame.palette.size) throw new Error(`调色板索引越界：${index}`);
      if (index === frame.transparentIndex) continue;
      const targetX = frame.left + x;
      if (targetX >= canvasWidth || y >= canvasHeight) continue;
      const target = (y * canvasWidth + targetX) * 4;
      const palette = index * 3;
      pixels[target] = frame.palette.data[palette]!;
      pixels[target + 1] = frame.palette.data[palette + 1]!;
      pixels[target + 2] = frame.palette.data[palette + 2]!;
      pixels[target + 3] = 255;
    }
  }
}

/**
 * 生成隔行扫描的行顺序。
 *
 * @param height 帧高，像素。
 * @param interlaced 是否隔行。
 * @returns 从上到下的实际行号。
 */
function interlacedRows(height: number, interlaced: boolean): number[] {
  if (!interlaced) return Array.from({ length: height }, (_value, index) => index);
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let row = start; row < height; row += step) rows.push(row);
  }
  return rows;
}

/**
 * 用背景色填充画布。
 *
 * @param pixels 目标 RGBA 画布。
 * @param palette 全局调色板。
 * @param index 背景色索引。
 */
function fillBackground(pixels: Uint8ClampedArray, palette: GifPalette, index: number): void {
  const offset = index * 3;
  const red = palette.data[offset]!;
  const green = palette.data[offset + 1]!;
  const blue = palette.data[offset + 2]!;
  for (let position = 0; position < pixels.length; position += 4) {
    pixels[position] = red;
    pixels[position + 1] = green;
    pixels[position + 2] = blue;
    pixels[position + 3] = 255;
  }
}

/**
 * 读取调色板。
 *
 * @param data 文件字节。
 * @param offset 调色板起点。
 * @param size 颜色数量。
 * @returns 调色板。
 */
function readPalette(data: Uint8Array, offset: number, size: number): GifPalette {
  if (offset + size * 3 > data.byteLength) throw new Error('调色板越界');
  return { data: data.subarray(offset, offset + size * 3), size };
}

/**
 * 跳过一个 GIF 子块序列。
 *
 * @param data 文件字节。
 * @param offset 子块长度字段起点。
 * @returns 终止符后的偏移。
 */
function skipSubBlocks(data: Uint8Array, offset: number): number {
  let position = offset;
  while (position < data.byteLength) {
    const size = data[position++]!;
    if (size === 0) return position;
    if (position + size > data.byteLength) throw new Error('子块越界');
    position += size;
  }
  throw new Error('子块缺少终止符');
}

/**
 * 读取并拼接 GIF 子块数据。
 *
 * @param data 文件字节。
 * @param offset 子块长度字段起点。
 * @returns 拼接后的数据与终止符后的偏移。
 */
function readSubBlocks(data: Uint8Array, offset: number): { data: Uint8Array; next: number } {
  let position = offset;
  let total = 0;
  let terminated = false;
  while (position < data.byteLength) {
    const size = data[position++]!;
    if (size === 0) {
      terminated = true;
      break;
    }
    if (position + size > data.byteLength) throw new Error('子块越界');
    total += size;
    position += size;
  }
  if (!terminated) throw new Error('子块缺少终止符');
  const output = new Uint8Array(total);
  position = offset;
  let outputOffset = 0;
  while (position < data.byteLength) {
    const size = data[position++]!;
    if (size === 0) break;
    output.set(data.subarray(position, position + size), outputOffset);
    outputOffset += size;
    position += size;
  }
  return { data: output, next: position };
}

/**
 * GIF LZW 解压。
 *
 * @param input 压缩数据。
 * @param minCodeSize 最小码长，bit；常见为 8。
 * @param maxOutput 最大输出字节数。
 * @returns 调色板索引数据。
 */
function decodeLzw(input: Uint8Array, minCodeSize: number, maxOutput: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 8) throw new Error(`非法 LZW 最小码长：${minCodeSize}`);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint16Array(4096);
  const stack = new Uint8Array(4096);
  for (let index = 0; index < 256; index += 1) {
    suffix[index] = index;
    first[index] = index;
  }

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let inputOffset = 0;
  const output = new Uint8Array(maxOutput);
  let outputOffset = 0;

  const readCode = (): number => {
    while (bitCount < codeSize) {
      if (inputOffset >= input.byteLength) return -1;
      bitBuffer |= input[inputOffset++]! << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code < 0 || code === endCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      previous = -1;
      continue;
    }
    if (previous < 0) {
      if (code >= clearCode) throw new Error(`首个 LZW 码非法：${code}`);
      if (outputOffset >= maxOutput) throw new Error('LZW 输出超过像素数');
      output[outputOffset++] = code;
      previous = code;
      continue;
    }

    const inputCode = code;
    let current = code;
    let stackSize = 0;
    let firstCurrent: number;
    if (code === nextCode) {
      if (stackSize >= stack.length) throw new Error('LZW 字典栈溢出');
      firstCurrent = first[previous]!;
      stack[stackSize++] = firstCurrent;
      current = previous;
    } else if (code > nextCode) {
      throw new Error(`LZW 码超出字典：${code}`);
    } else {
      firstCurrent = first[code]!;
    }

    while (current >= clearCode) {
      if (current >= nextCode || stackSize >= stack.length) throw new Error('LZW 字典损坏');
      stack[stackSize++] = suffix[current]!;
      current = prefix[current]!;
    }
    if (current >= 256) throw new Error('LZW 首字符非法');
    stack[stackSize++] = current;

    while (stackSize > 0) {
      if (outputOffset >= maxOutput) throw new Error('LZW 输出超过像素数');
      output[outputOffset++] = stack[--stackSize]!;
    }

    if (nextCode < 4096) {
      prefix[nextCode] = previous;
      suffix[nextCode] = firstCurrent;
      // `first` 必须存“新词条的首字符”，即 previous 词条的首字符（不是当前码的首字符）。
      // 存错会让后续词条的首字符错误，但 `suffix` 链仍正确，因此输出序列看似正常、颜色
      // 索引却被破坏（GIF 印章曾因此整片丢墨）。
      first[nextCode] = first[previous]!;
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previous = inputCode;
  }
  return output.subarray(0, outputOffset);
}

/** 判断字节是否以给定前缀开始。 */
function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

/** 读取无符号 16 位小端。 */
function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}
