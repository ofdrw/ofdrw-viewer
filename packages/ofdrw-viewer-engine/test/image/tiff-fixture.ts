/**
 * 测试用最小 TIFF 写入器。
 *
 * 仅生成测试需要的 baseline/LZW/PackBits/Deflate、条带/瓦片、1/4/8/16 位样本；
 * 不追求覆盖 TIFF 全部标签。
 */

import { zlibSync } from 'fflate';

/** 生成选项。 */
export interface TiffFixtureOptions {
  /** 宽，像素。 */
  width: number;
  /** 高，像素。 */
  height: number;
  /** 每通道位数。 */
  bits: 1 | 4 | 8 | 16;
  /** PhotometricInterpretation。 */
  photometric: 0 | 1 | 2 | 3 | 5;
  /** 每像素样本数；缺省按 photometric 推断。 */
  samplesPerPixel?: number;
  /** 压缩：1 none、5 LZW、8 Deflate、32773 PackBits。 */
  compression?: 1 | 5 | 8 | 32773;
  /** 每 strip 行数。 */
  rowsPerStrip?: number;
  /** 是否小端；默认 true。 */
  littleEndian?: boolean;
  /** Predictor=2。 */
  predictor?: 2;
  /** 调色板，长度 3*2^bits。 */
  colorMap?: number[];
  /** ExtraSamples 标签值。 */
  extraSamples?: number[];
  /** 扁平样本数组，长度 width*height*samplesPerPixel。 */
  samples: number[];
  /** 瓦片尺寸；提供时生成瓦片 TIFF。 */
  tiles?: { width: number; height: number };
  /** 指定 strip 索引置为缺失（offset/count=0）。 */
  missingStrip?: number;
  /** 指定瓦片索引置为缺失。 */
  missingTile?: number;
}

interface Entry {
  tag: number;
  type: number;
  values: number[];
  payload: Uint8Array;
  offset: number;
}

/**
 * 生成 TIFF 字节。
 *
 * @param options 生成选项。
 * @returns TIFF 文件字节。
 */
export function buildTiff(options: TiffFixtureOptions): Uint8Array {
  const {
    width,
    height,
    bits,
    photometric,
    compression = 1,
    rowsPerStrip = height,
    littleEndian = true,
  } = options;
  const samplesPerPixel =
    options.samplesPerPixel ?? (photometric === 2 ? 3 : photometric === 5 ? 4 : 1);
  const pixelSamples = width * height * samplesPerPixel;
  if (options.samples.length !== pixelSamples) {
    throw new Error(`samples 长度 ${options.samples.length} != ${pixelSamples}`);
  }

  const chunks: Array<{ index: number; raw: Uint8Array }> = [];
  if (options.tiles) {
    const tileWidth = options.tiles.width;
    const tileHeight = options.tiles.height;
    const across = Math.ceil(width / tileWidth);
    const down = Math.ceil(height / tileHeight);
    for (let tileY = 0; tileY < down; tileY += 1) {
      for (let tileX = 0; tileX < across; tileX += 1) {
        const raw = packRegion(
          options.samples,
          width,
          samplesPerPixel,
          tileX * tileWidth,
          tileY * tileHeight,
          tileWidth,
          tileHeight,
          bits,
          littleEndian,
        );
        if (options.predictor === 2) applyPredictor(raw, tileWidth, samplesPerPixel, bits, littleEndian);
        chunks.push({
          index: tileY * across + tileX,
          raw: compress(raw, compression),
        });
      }
    }
  } else {
    const stripRows = Math.max(1, rowsPerStrip);
    const stripCount = Math.ceil(height / stripRows);
    for (let index = 0; index < stripCount; index += 1) {
      const y0 = index * stripRows;
      const rows = Math.min(stripRows, height - y0);
      const raw = packRegion(
        options.samples,
        width,
        samplesPerPixel,
        0,
        y0,
        width,
        rows,
        bits,
        littleEndian,
      );
      if (options.predictor === 2) applyPredictor(raw, width, samplesPerPixel, bits, littleEndian);
      chunks.push({ index, raw: compress(raw, compression) });
    }
  }

  const entries: Entry[] = [];
  const push = (tag: number, type: number, values: number[]): void => {
    entries.push({ tag, type, values, payload: encodeValues(type, values, littleEndian), offset: 0 });
  };
  push(256, 4, [width]);
  push(257, 4, [height]);
  push(258, 3, new Array(samplesPerPixel).fill(bits));
  push(259, 3, [compression]);
  push(262, 3, [photometric]);
  push(277, 3, [samplesPerPixel]);
  push(284, 3, [1]);
  if (options.predictor === 2) push(317, 3, [2]);
  if (options.colorMap) push(320, 3, options.colorMap);
  if (options.extraSamples) push(338, 3, options.extraSamples);

  if (options.tiles) {
    push(322, 4, [options.tiles.width]);
    push(323, 4, [options.tiles.height]);
    push(324, 4, chunks.map(() => 0));
    push(325, 4, chunks.map((chunk) => chunk.raw.byteLength));
  } else {
    push(278, 4, [rowsPerStrip]);
    push(273, 4, chunks.map(() => 0));
    push(279, 4, chunks.map((chunk) => chunk.raw.byteLength));
 }

  entries.sort((a, b) => a.tag - b.tag);
  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const extraStart = ifdOffset + ifdSize;
  let extraCursor = extraStart;
  for (const entry of entries) {
    if (entry.payload.byteLength > 4) {
      extraCursor = align2(extraCursor);
      entry.offset = extraCursor;
      extraCursor += entry.payload.byteLength;
    }
  }
  const dataStart = align2(extraCursor);
  const dataOffsets: number[] = [];
  let dataCursor = dataStart;
  for (const chunk of chunks) {
    dataOffsets.push(dataCursor);
    dataCursor += chunk.raw.byteLength;
  }

  const offsetTag = options.tiles ? 324 : 273;
  const countTag = options.tiles ? 325 : 279;
  for (const entry of entries) {
    if (entry.tag === offsetTag) {
      entry.values = dataOffsets.slice();
      if (options.missingStrip !== undefined && !options.tiles) {
        entry.values[options.missingStrip] = 0;
      }
      if (options.missingTile !== undefined && options.tiles) {
        entry.values[options.missingTile] = 0;
      }
      entry.payload = encodeValues(entry.type, entry.values, littleEndian);
    } else if (entry.tag === countTag) {
      if (options.missingStrip !== undefined && !options.tiles) {
        entry.values[options.missingStrip] = 0;
      }
      if (options.missingTile !== undefined && options.tiles) {
        entry.values[options.missingTile] = 0;
      }
      entry.payload = encodeValues(entry.type, entry.values, littleEndian);
    }
  }

  const output = new Uint8Array(dataCursor);
  const view = new DataView(output.buffer);
  output[0] = littleEndian ? 0x49 : 0x4d;
  output[1] = littleEndian ? 0x49 : 0x4d;
  if (littleEndian) {
    output[2] = 0x2a;
    output[3] = 0x00;
  } else {
    output[2] = 0x00;
    output[3] = 0x2a;
  }
  view.setUint32(4, ifdOffset, littleEndian);
  view.setUint16(ifdOffset, entries.length, littleEndian);
  entries.forEach((entry, index) => {
    const entryOffset = ifdOffset + 2 + index * 12;
    view.setUint16(entryOffset, entry.tag, littleEndian);
    view.setUint16(entryOffset + 2, entry.type, littleEndian);
    view.setUint32(entryOffset + 4, entry.values.length, littleEndian);
    if (entry.payload.byteLength <= 4) {
      output.set(entry.payload, entryOffset + 8);
    } else {
      view.setUint32(entryOffset + 8, entry.offset, littleEndian);
      output.set(entry.payload, entry.offset);
    }
  });
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, littleEndian);
  chunks.forEach((chunk, index) => {
    output.set(chunk.raw, dataOffsets[index]!);
  });
  return output;
}

/**
 * 生成灰度/RGB 渐变样本。
 *
 * @param width 宽。
 * @param height 高。
 * @param samplesPerPixel 通道数。
 * @param fn 样本生成函数。
 * @returns 扁平样本数组。
 */
export function makeSamples(
  width: number,
  height: number,
  samplesPerPixel: number,
  fn: (x: number, y: number, channel: number) => number,
): number[] {
  const samples: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < samplesPerPixel; channel += 1) {
        samples.push(fn(x, y, channel));
      }
    }
  }
  return samples;
}

/** 按区域打包为 MSB-first 字节。 */
function packRegion(
  samples: number[],
  imageWidth: number,
  samplesPerPixel: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  bits: number,
  littleEndian: boolean,
): Uint8Array {
  const rowBytes = Math.ceil((width * samplesPerPixel * bits) / 8);
  const imageHeight = Math.floor(samples.length / (imageWidth * samplesPerPixel));
  const output = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    let bitOffset = y * rowBytes * 8;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x0 + x;
      const sourceY = y0 + y;
      for (let channel = 0; channel < samplesPerPixel; channel += 1) {
        const value =
          sourceX < imageWidth && sourceY < imageHeight
            ? (samples[(sourceY * imageWidth + sourceX) * samplesPerPixel + channel] ?? 0)
            : 0;
        if (bits === 16) {
          const offset = bitOffset >> 3;
          if (littleEndian) {
            output[offset] = value & 0xff;
            output[offset + 1] = (value >> 8) & 0xff;
          } else {
            output[offset] = (value >> 8) & 0xff;
            output[offset + 1] = value & 0xff;
          }
        } else if (bits === 8) {
          output[bitOffset >> 3] = value & 0xff;
        } else if (bits === 4) {
          const offset = bitOffset >> 3;
          output[offset] = (output[offset] ?? 0) | ((value & 0x0f) << ((bitOffset & 4) === 0 ? 4 : 0));
        } else {
          const offset = bitOffset >> 3;
          output[offset] = (output[offset] ?? 0) | ((value & 1) << (7 - (bitOffset & 7)));
        }
        bitOffset += bits;
      }
    }
  }
  return output;
}

/** 对 8/16 位样本应用 Predictor=2。 */
function applyPredictor(
  raw: Uint8Array,
  width: number,
  samplesPerPixel: number,
  bits: number,
  littleEndian: boolean,
): void {
  const bytesPerSample = bits / 8;
  const rowSamples = width * samplesPerPixel;
  const rows = raw.byteLength / (rowSamples * bytesPerSample);
  for (let row = 0; row < rows; row += 1) {
    const rowStart = row * rowSamples * bytesPerSample;
    for (let sample = rowSamples - 1; sample >= samplesPerPixel; sample -= 1) {
      const offset = rowStart + sample * bytesPerSample;
      const previous = rowStart + (sample - samplesPerPixel) * bytesPerSample;
      if (bits === 8) {
        raw[offset] = ((raw[offset] ?? 0) - (raw[previous] ?? 0)) & 0xff;
      } else {
        const value = readU16(raw, offset, littleEndian);
        const prev = readU16(raw, previous, littleEndian);
        writeU16(raw, offset, (value - prev) & 0xffff, littleEndian);
      }
    }
  }
}

/** 压缩一个 strip/tile。 */
function compress(raw: Uint8Array, compression: number): Uint8Array {
  if (compression === 1) return raw;
  if (compression === 32773) return packBits(raw);
  if (compression === 8) return zlibSync(raw);
  if (compression === 5) return lzwEncode(raw);
  throw new Error(`compression ${compression}`);
}

/** PackBits 字面量编码。 */
function packBits(raw: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let offset = 0; offset < raw.length; offset += 128) {
    const count = Math.min(128, raw.length - offset);
    output.push(count - 1);
    for (let index = 0; index < count; index += 1) output.push(raw[offset + index]!);
  }
  return Uint8Array.from(output);
}

/** TIFF LZW 编码（MSB-first，early change）。 */
function lzwEncode(raw: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeWidth = 9;
  let nextCode = 258;
  const dictionary = new Map<string, number>();
  const reset = (): void => {
    dictionary.clear();
    for (let index = 0; index < 256; index += 1) dictionary.set(String(index), index);
    codeWidth = 9;
    nextCode = 258;
  };
  const writeCode = (code: number): void => {
    bitBuffer = (bitBuffer << codeWidth) | code;
    bitCount += codeWidth;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bitBuffer >> bitCount) & 0xff);
    }
    bitBuffer &= (1 << bitCount) - 1;
  };
  reset();
  writeCode(256);
  if (raw.length === 0) {
    writeCode(257);
  } else {
    let current = String(raw[0]);
    for (let index = 1; index < raw.length; index += 1) {
      const next = raw[index]!;
      const candidate = `${current},${next}`;
      if (dictionary.has(candidate)) {
        current = candidate;
      } else {
        writeCode(dictionary.get(current)!);
        if (nextCode < 4096) {
          dictionary.set(candidate, nextCode);
          nextCode += 1;
          if (nextCode === (1 << codeWidth) && codeWidth < 12) codeWidth += 1;
        } else {
          writeCode(256);
          reset();
        }
        current = String(next);
      }
    }
    writeCode(dictionary.get(current)!);
    writeCode(257);
  }
  if (bitCount > 0) bytes.push((bitBuffer << (8 - bitCount)) & 0xff);
  return Uint8Array.from(bytes);
}

/** 编码 IFD 值。 */
function encodeValues(type: number, values: number[], littleEndian: boolean): Uint8Array {
  const unit = type === 3 ? 2 : 4;
  const output = new Uint8Array(values.length * unit);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => {
    if (type === 3) view.setUint16(index * 2, value, littleEndian);
    else view.setUint32(index * 4, value, littleEndian);
  });
  return output;
}

/** 2 字节对齐。 */
function align2(value: number): number {
  return (value + 1) & ~1;
}

/** 读取 16 位。 */
function readU16(data: Uint8Array, offset: number, little: boolean): number {
  return little
    ? (data[offset]! | (data[offset + 1]! << 8))
    : ((data[offset]! << 8) | data[offset + 1]!);
}

/** 写入 16 位。 */
function writeU16(data: Uint8Array, offset: number, value: number, little: boolean): void {
  if (little) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
  } else {
    data[offset] = (value >> 8) & 0xff;
    data[offset + 1] = value & 0xff;
  }
}
