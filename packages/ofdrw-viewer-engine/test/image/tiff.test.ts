import { describe, expect, it } from 'vitest';
import { decodeTiff } from '../../src/image/tiff';
import type { ImageDataLike } from '../../src/common/types';
import type { OFDWarning } from '../../src/warnings';
import { buildTiff, makeSamples } from './tiff-fixture';

/** 读取 RGBA 像素。 */
function pixel(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!];
}

/** 取解码结果的 RGBA。 */
function rgba(result: { data: ImageDataLike }): Uint8ClampedArray {
  return result.data.data;
}

/** 修改指定 SHORT 标签值。 */
function setShortTag(data: Uint8Array, tag: number, value: number): void {
  const little = data[0] === 0x49;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ifd = view.getUint32(4, little);
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const offset = ifd + 2 + index * 12;
    if (view.getUint16(offset, little) === tag) {
      view.setUint16(offset + 8, value, little);
      return;
    }
  }
  throw new Error(`tag ${tag} not found`);
}

describe('decodeTiff 基线', () => {
  it('8 位 BlackIsZero 灰度', async () => {
    const samples = makeSamples(3, 2, 1, (x, y) => [0, 64, 128, 255, 32, 200][y * 3 + x]!);
    const data = buildTiff({ width: 3, height: 2, bits: 8, photometric: 1, samples });
    const result = await decodeTiff(data);
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect(result.frameIndex).toBe(0);
    expect(pixel(rgba(result), 3, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba(result), 3, 1, 0)).toEqual([64, 64, 64, 255]);
    expect(pixel(rgba(result), 3, 2, 0)).toEqual([128, 128, 128, 255]);
    expect(pixel(rgba(result), 3, 0, 1)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(result), 3, 1, 1)).toEqual([32, 32, 32, 255]);
    expect(pixel(rgba(result), 3, 2, 1)).toEqual([200, 200, 200, 255]);
  });

  it('WhiteIsZero 灰度反相', async () => {
    const data = buildTiff({
      width: 2,
      height: 1,
      bits: 8,
      photometric: 0,
      samples: [0, 255],
    });
    const result = await decodeTiff(data);
    expect(pixel(rgba(result), 2, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(result), 2, 1, 0)).toEqual([0, 0, 0, 255]);
  });

  it('1 位灰度（含行尾填充）', async () => {
    const data = buildTiff({
      width: 3,
      height: 2,
      bits: 1,
      photometric: 1,
      samples: [1, 0, 1, 0, 0, 1],
    });
    const result = await decodeTiff(data);
    expect(pixel(rgba(result), 3, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(result), 3, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba(result), 3, 2, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(result), 3, 0, 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba(result), 3, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba(result), 3, 2, 1)).toEqual([255, 255, 255, 255]);
  });

  it('4 位灰度缩放到 8 位', async () => {
    const data = buildTiff({
      width: 3,
      height: 1,
      bits: 4,
      photometric: 1,
      samples: [0, 7, 15],
    });
    const result = await decodeTiff(data);
    expect(pixel(rgba(result), 3, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba(result), 3, 1, 0)).toEqual([119, 119, 119, 255]);
    expect(pixel(rgba(result), 3, 2, 0)).toEqual([255, 255, 255, 255]);
  });

  it('16 位灰度（小端/大端）', async () => {
    for (const littleEndian of [true, false]) {
      const data = buildTiff({
        width: 3,
        height: 1,
        bits: 16,
        photometric: 1,
        samples: [0x0000, 0x1234, 0xffff],
        littleEndian,
      });
      const result = await decodeTiff(data);
      expect(pixel(rgba(result), 3, 0, 0)).toEqual([0, 0, 0, 255]);
      expect(pixel(rgba(result), 3, 1, 0)).toEqual([18, 18, 18, 255]);
      expect(pixel(rgba(result), 3, 2, 0)).toEqual([255, 255, 255, 255]);
    }
  });

  it('RGB 与 alpha', async () => {
    const data = buildTiff({
      width: 3,
      height: 1,
      bits: 8,
      photometric: 2,
      samplesPerPixel: 4,
      extraSamples: [2],
      samples: [255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 0],
    });
    const result = await decodeTiff(data);
    expect(pixel(rgba(result), 3, 0, 0)).toEqual([255, 0, 0, 128]);
    expect(pixel(rgba(result), 3, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(rgba(result), 3, 2, 0)).toEqual([0, 0, 255, 0]);
  });

  it('CMYK', async () => {
    const data = buildTiff({
      width: 3,
      height: 1,
      bits: 8,
      photometric: 5,
      samples: [0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0],
    });
    const result = await decodeTiff(data);
    expect(pixel(rgba(result), 3, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(result), 3, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba(result), 3, 2, 0)).toEqual([0, 255, 255, 255]);
  });

  it('4 位调色板', async () => {
    const colorMap = new Array<number>(3 * 16).fill(0);
    colorMap[1] = 0xffff;
    colorMap[16 + 2] = 0xffff;
    colorMap[32 + 3] = 0xffff;
    const data = buildTiff({
      width: 3,
      height: 1,
      bits: 4,
      photometric: 3,
      colorMap,
      samples: [1, 2, 3],
    });
    const result = await decodeTiff(data);
    expect(pixel(rgba(result), 3, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(rgba(result), 3, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(rgba(result), 3, 2, 0)).toEqual([0, 0, 255, 255]);
  });
});

describe('decodeTiff 压缩/Predictor', () => {
  it('LZW（含码宽增长）', async () => {
    const samples = makeSamples(600, 1, 1, (x) => (x * 7) % 256);
    const data = buildTiff({ width: 600, height: 1, bits: 8, photometric: 1, compression: 5, samples });
    const result = await decodeTiff(data);
    for (let x = 0; x < 600; x += 1) {
      const value = (x * 7) % 256;
      expect(pixel(rgba(result), 600, x, 0)[0]).toBe(value);
    }
  });

  it('PackBits', async () => {
    const samples = makeSamples(4, 4, 1, (x, y) => (x + y * 4) * 10);
    const data = buildTiff({ width: 4, height: 4, bits: 8, photometric: 1, compression: 32773, samples });
    const result = await decodeTiff(data);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect(pixel(rgba(result), 4, x, y)[0]).toBe((x + y * 4) * 10);
      }
    }
  });

  it('Deflate', async () => {
    const samples = makeSamples(4, 4, 1, (x, y) => (x * 20 + y * 5) % 256);
    const data = buildTiff({ width: 4, height: 4, bits: 8, photometric: 1, compression: 8, samples });
    const result = await decodeTiff(data);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect(pixel(rgba(result), 4, x, y)[0]).toBe((x * 20 + y * 5) % 256);
      }
    }
  });

  it('Predictor=2（8 位 / 16 位）', async () => {
    for (const bits of [8, 16] as const) {
      const maxValue = bits === 8 ? 255 : 0xffff;
      const samples = makeSamples(4, 3, 1, (x, y) => (x * 37 + y * 11) % (maxValue + 1));
      const data = buildTiff({ width: 4, height: 3, bits, photometric: 1, predictor: 2, samples });
      const result = await decodeTiff(data);
      for (let y = 0; y < 3; y += 1) {
        for (let x = 0; x < 4; x += 1) {
          const raw = (x * 37 + y * 11) % (maxValue + 1);
          const expected = bits === 16 ? Math.round(raw / 257) : raw;
          expect(pixel(rgba(result), 4, x, y)[0]).toBe(expected);
        }
      }
    }
  });
});

describe('decodeTiff 条带/瓦片与缺失数据', () => {
  it('多 strip 正确拼接', async () => {
    const samples = makeSamples(4, 4, 1, (x, y) => y * 20 + x);
    const data = buildTiff({ width: 4, height: 4, bits: 8, photometric: 1, rowsPerStrip: 2, samples });
    const result = await decodeTiff(data);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect(pixel(rgba(result), 4, x, y)[0]).toBe(y * 20 + x);
      }
    }
  });

  it('缺失 strip 补白', async () => {
    const samples = makeSamples(4, 4, 1, (x, y) => y * 20 + x);
    const data = buildTiff({
      width: 4,
      height: 4,
      bits: 8,
      photometric: 1,
      rowsPerStrip: 2,
      missingStrip: 1,
      samples,
    });
    const result = await decodeTiff(data);
    expect(pixel(rgba(result), 4, 1, 0)[0]).toBe(1);
    expect(pixel(rgba(result), 4, 1, 2)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(result), 4, 3, 3)).toEqual([255, 255, 255, 255]);
  });

  it('瓦片拼接与缺失瓦片补白', async () => {
    const samples = makeSamples(4, 4, 1, (x, y) => y * 20 + x);
    const complete = await decodeTiff(
      buildTiff({ width: 4, height: 4, bits: 8, photometric: 1, tiles: { width: 2, height: 2 }, samples }),
    );
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect(pixel(rgba(complete), 4, x, y)[0]).toBe(y * 20 + x);
      }
    }

    const missing = await decodeTiff(
      buildTiff({
        width: 4,
        height: 4,
        bits: 8,
        photometric: 1,
        tiles: { width: 2, height: 2 },
        missingTile: 1,
        samples,
      }),
    );
    expect(pixel(rgba(missing), 4, 0, 0)[0]).toBe(0);
    expect(pixel(rgba(missing), 4, 2, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(missing), 4, 3, 1)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba(missing), 4, 2, 2)[0]).toBe(42);
  });
});

describe('decodeTiff 限制与错误', () => {
  it('解码前按 IFD 尺寸检查像素上限', async () => {
    const warnings: OFDWarning[] = [];
    const data = buildTiff({
      width: 10,
      height: 10,
      bits: 8,
      photometric: 1,
      samples: new Array(100).fill(0),
    });
    await expect(
      decodeTiff(data, { maxPixels: 99, onWarning: (warning) => warnings.push(warning) }),
    ).rejects.toMatchObject({ code: 'OFD_LIMIT_EXCEEDED' });
    expect(warnings[0]?.code).toBe('W_JBIG2_DECODE');
  });

  it('损坏/截断/不支持字段抛 OFD_IMAGE_DECODE', async () => {
    const warnings: OFDWarning[] = [];
    await expect(decodeTiff(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toMatchObject({
      code: 'OFD_IMAGE_DECODE',
    });

    const valid = buildTiff({
      width: 2,
      height: 2,
      bits: 8,
      photometric: 1,
      samples: [0, 1, 2, 3],
    });
    await expect(decodeTiff(valid.subarray(0, 20))).rejects.toMatchObject({ code: 'OFD_IMAGE_DECODE' });

    const unsupportedCompression = Uint8Array.from(valid);
    setShortTag(unsupportedCompression, 259, 99);
    await expect(
      decodeTiff(unsupportedCompression, { onWarning: (warning) => warnings.push(warning) }),
    ).rejects.toMatchObject({ code: 'OFD_IMAGE_DECODE' });
    expect(warnings[0]?.code).toBe('W_JBIG2_DECODE');

    const planar = Uint8Array.from(valid);
    setShortTag(planar, 284, 2);
    await expect(decodeTiff(planar)).rejects.toMatchObject({ code: 'OFD_IMAGE_DECODE' });

    const photometric = Uint8Array.from(valid);
    setShortTag(photometric, 262, 6);
    await expect(decodeTiff(photometric)).rejects.toMatchObject({ code: 'OFD_IMAGE_DECODE' });
  });
});
