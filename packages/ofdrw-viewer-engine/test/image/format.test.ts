import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeWithImageDecoder,
  detectImageFormat,
  findImageDecoderPlugin,
  isWithinImagePixelLimit,
  loadBuiltinImageDecoder,
  readImageSize,
  readImageSizeWithinLimit,
  resolveImageDecoder,
} from '../../src/image/format';
import type { ImageDecoderPlugin } from '../../src/platform/image-decoder';
import type { OFDWarning } from '../../src/warnings';

/** 生成最小 PNG 头。 */
function png(width: number, height: number): Uint8Array {
  const data = new Uint8Array(33);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  data.set([0x00, 0x00, 0x00, 0x0d], 8);
  data.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(data.buffer).setUint32(16, width);
  new DataView(data.buffer).setUint32(20, height);
  return data;
}

/** 生成最小 JPEG 头（SOF0）。 */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

/** 生成最小 GIF 头。 */
function gif(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10);
  data.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  new DataView(data.buffer).setUint16(6, width, true);
  new DataView(data.buffer).setUint16(8, height, true);
  return data;
}

/** 生成最小 BMP 信息头。 */
function bmp(width: number, height: number): Uint8Array {
  const data = new Uint8Array(54);
  data.set([0x42, 0x4d]);
  const view = new DataView(data.buffer);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  return data;
}

/** 生成最小 WebP VP8X 头。 */
function webp(width: number, height: number): Uint8Array {
  const data = new Uint8Array(30);
  data.set([0x52, 0x49, 0x46, 0x46]);
  data.set([0x57, 0x45, 0x42, 0x50], 8);
  data.set([0x56, 0x50, 0x38, 0x58], 12);
  writeUint24LE(data, 24, width - 1);
  writeUint24LE(data, 27, height - 1);
  return data;
}

/** 写 24 位小端。 */
function writeUint24LE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >> 8) & 0xff;
  data[offset + 2] = (value >> 16) & 0xff;
}

/** 读取真实 JBIG2 fixture。 */
function jbig2Fixture(): Uint8Array {
  return readFileSync(fileURLToPath(new URL('./fixtures/1-image_78.jb2', import.meta.url)));
}

describe('detectImageFormat', () => {
  it('优先使用扩展名，大小写与 query 不敏感', () => {
    expect(detectImageFormat(png(2, 3), 'a.JPG')).toBe('jpeg');
    expect(detectImageFormat(png(2, 3), 'DOC_0/Res/Image_4.JPEG')).toBe('jpeg');
    expect(detectImageFormat(png(2, 3), 'a.png?v=1')).toBe('png');
    expect(detectImageFormat(jbig2Fixture(), 'Doc_0/Res/image_78.jb2')).toBe('jbig2');
    expect(detectImageFormat(new Uint8Array([1, 2, 3]), 'a.tif')).toBe('tiff');
  });

  it('扩展名缺失/未知时按 magic 识别', () => {
    expect(detectImageFormat(png(2, 3))).toBe('png');
    expect(detectImageFormat(jpeg(2, 3))).toBe('jpeg');
    expect(detectImageFormat(gif(2, 3))).toBe('gif');
    expect(detectImageFormat(bmp(2, 3))).toBe('bmp');
    expect(detectImageFormat(webp(2, 3))).toBe('webp');
    expect(detectImageFormat(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]))).toBe('tiff');
    expect(detectImageFormat(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe('tiff');
    expect(detectImageFormat(jbig2Fixture())).toBe('jbig2');
    expect(detectImageFormat(Uint8Array.from([1, 2, 3]))).toBe('unknown');
  });

  it('无头嵌入式 JBIG2 依赖扩展名识别', () => {
    const headerless = jbig2Fixture().subarray(13);
    expect(detectImageFormat(headerless, 'Doc_0/Res/image_78.jb2')).toBe('jbig2');
    expect(detectImageFormat(headerless)).toBe('unknown');
  });
});

describe('readImageSize', () => {
  it('解析 PNG/JPEG/GIF/BMP/WebP 头部尺寸', () => {
    expect(readImageSize(png(320, 240), 'png')).toEqual({ width: 320, height: 240 });
    expect(readImageSize(jpeg(640, 480), 'jpeg')).toEqual({ width: 640, height: 480 });
    expect(readImageSize(gif(16, 9), 'gif')).toEqual({ width: 16, height: 9 });
    expect(readImageSize(bmp(100, 50), 'bmp')).toEqual({ width: 100, height: 50 });
    expect(readImageSize(webp(1920, 1080), 'webp')).toEqual({ width: 1920, height: 1080 });
  });

  it('读取 JBIG2 页面信息尺寸（带/无文件头）', () => {
    const full = jbig2Fixture();
    expect(readImageSize(full, 'jbig2')).toEqual({ width: 100, height: 100 });
    expect(readImageSize(full.subarray(13), 'jbig2')).toEqual({ width: 100, height: 100 });
  });

  it('损坏/截断/未知头部返回 null', () => {
    expect(readImageSize(new Uint8Array(), 'png')).toBeNull();
    expect(readImageSize(png(10, 10).subarray(0, 20), 'png')).toBeNull();
    expect(readImageSize(jpeg(10, 10).subarray(0, 10), 'jpeg')).toBeNull();
    expect(readImageSize(Uint8Array.from([1, 2, 3]), 'unknown')).toBeNull();
  });

  it('读取 TIFF 第一 IFD 尺寸（小端/大端）', async () => {
    const { buildTiff } = await import('./tiff-fixture');
    for (const littleEndian of [true, false]) {
      const data = buildTiff({
        width: 7,
        height: 5,
        bits: 8,
        photometric: 1,
        samples: new Array(35).fill(0),
        littleEndian,
      });
      expect(readImageSize(data, 'tiff')).toEqual({ width: 7, height: 5 });
    }
  });
});

describe('像素上限', () => {
  it('按宽高乘积判断', () => {
    expect(isWithinImagePixelLimit(10, 10, 100)).toBe(true);
    expect(isWithinImagePixelLimit(10, 11, 100)).toBe(false);
    expect(isWithinImagePixelLimit(0, 10, 100)).toBe(false);
    expect(isWithinImagePixelLimit(Number.NaN, 10, 100)).toBe(false);
  });

  it('头部尺寸超限时返回 null', () => {
    expect(readImageSizeWithinLimit(png(10, 10), 'png', 99)).toBeNull();
    expect(readImageSizeWithinLimit(png(10, 10), 'png', 100)).toEqual({ width: 10, height: 10 });
  });
});

describe('ImageDecoderPlugin 适配', () => {
  it('按 format 匹配插件（大小写不敏感）', () => {
    const plugin: ImageDecoderPlugin = {
      format: 'JBIG2',
      decode: async () => ({ width: 1, height: 1, data: { width: 1, height: 1, data: new Uint8ClampedArray(4) } }),
    };
    expect(findImageDecoderPlugin([plugin], 'jbig2')).toBe(plugin);
    expect(findImageDecoderPlugin([plugin], 'tiff')).toBeUndefined();
  });

  it('动态加载内置 GIF/JBIG2/TIFF 解码器并可解码', async () => {
    const jbig2 = await loadBuiltinImageDecoder('jbig2');
    const tiff = await loadBuiltinImageDecoder('tiff');
    expect(jbig2?.format).toBe('jbig2');
    expect(tiff?.format).toBe('tiff');
    expect((await jbig2!.decode(jbig2Fixture())).width).toBe(100);
    const { buildTiff } = await import('./tiff-fixture');
    expect(
      (
        await tiff!.decode(
          buildTiff({ width: 2, height: 1, bits: 8, photometric: 1, samples: [1, 2] }),
        )
      ).width,
    ).toBe(2);
    expect(await loadBuiltinImageDecoder('png')).toBeUndefined();
    expect((await resolveImageDecoder('jbig2'))?.format).toBe('jbig2');
    expect((await loadBuiltinImageDecoder('JBIG2'))?.format).toBe('jbig2');
    const { builtinImageDecoders } = await import('../../src/image/format');
    expect(builtinImageDecoders.map((item) => item.format)).toEqual(['gif', 'jbig2', 'tiff']);
    const builtinJbig2 = builtinImageDecoders.find((item) => item.format === 'jbig2')!;
    expect((await builtinJbig2.decode(jbig2Fixture())).width).toBe(100);
  });

  it('内置解码器接收 maxPixels 选项并在插件层拒绝超限', async () => {
    const jbig2 = await loadBuiltinImageDecoder('jbig2', { maxPixels: 1 });
    await expect(jbig2!.decode(jbig2Fixture())).rejects.toMatchObject({ code: 'OFD_LIMIT_EXCEEDED' });
  });

  it('缺失解码器/解码失败上报 warning 并返回 undefined', async () => {
    const warnings: OFDWarning[] = [];
    expect(await decodeWithImageDecoder(new Uint8Array(), 'avif', [], { onWarning: (w) => warnings.push(w) })).toBeUndefined();
    expect(warnings[0]?.code).toBe('W_IMAGE_DECODE');
    expect(warnings[0]?.message).toContain('缺少 avif');

    const failing: ImageDecoderPlugin = {
      format: 'tiff',
      decode: async () => {
        throw new Error('boom');
      },
    };
    warnings.length = 0;
    expect(await decodeWithImageDecoder(new Uint8Array(), 'tiff', [failing], { onWarning: (w) => warnings.push(w) })).toBeUndefined();
    expect(warnings[0]?.code).toBe('W_JBIG2_DECODE');
    expect(warnings[0]?.message).toContain('boom');
  });

  it('宿主未注入时自动使用内置 JBIG2 插件', async () => {
    const decoded = await decodeWithImageDecoder(jbig2Fixture(), 'jbig2', []);
    expect(decoded?.width).toBe(100);
    expect(decoded?.height).toBe(100);
  });

  it('插件解码成功后返回结果，头部超限则跳过', async () => {
    const plugin: ImageDecoderPlugin = {
      format: 'jbig2',
      decode: async () => ({ width: 10, height: 10, data: { width: 10, height: 10, data: new Uint8ClampedArray(400) } }),
    };
    expect((await decodeWithImageDecoder(jbig2Fixture(), 'jbig2', [plugin]))?.width).toBe(10);
    const warnings: OFDWarning[] = [];
    expect(
      await decodeWithImageDecoder(jbig2Fixture(), 'jbig2', [plugin], { maxPixels: 1, onWarning: (w) => warnings.push(w) }),
    ).toBeUndefined();
    // readImageSize 不解析 JBIG2 尺寸，此处由插件返回结果触发二次检查。
    expect(warnings[0]?.code).toBe('W_JBIG2_DECODE');
  });
});
