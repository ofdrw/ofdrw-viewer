import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeGif } from '../../src/image/gif';
import {
  builtinImageDecoders,
  decodeWithImageDecoder,
  loadBuiltinImageDecoder,
} from '../../src/image/format';
import type { OFDWarning } from '../../src/warnings';

/** 读取测试 GIF fixture。 */
function fixture(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

/** 取 RGBA 像素。 */
function pixel(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!];
}

describe('GIF 解码', () => {
  it('解码调色板与 RGBA 像素', async () => {
    const result = await decodeGif(fixture('tiny.gif'));
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect(result.kind).toBe('imagedata');
    const data = result.data as { data: Uint8ClampedArray };
    expect(pixel(data.data, 3, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(data.data, 3, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(data.data, 3, 2, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(data.data, 3, 2, 1)).toEqual([255, 0, 0, 255]);
  });

  it('保留透明色 alpha=0', async () => {
    const result = await decodeGif(fixture('transparent.gif'));
    const data = result.data as { data: Uint8ClampedArray };
    expect(pixel(data.data, 2, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(data.data, 2, 1, 0)[3]).toBe(0);
    expect(pixel(data.data, 2, 0, 1)[3]).toBe(0);
  });

  it('按隔行扫描顺序还原行', async () => {
    const result = await decodeGif(fixture('interlaced.gif'));
    const data = result.data as { data: Uint8ClampedArray };
    const palette = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ];
    const rows = [
      [0, 1, 2],
      [1, 2, 0],
      [2, 0, 1],
      [0, 2, 1],
      [2, 1, 0],
    ];
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        expect(pixel(data.data, 3, x, y)).toEqual(palette[rows[y]![x]!]);
      }
    }
  });

  it('通过内置动态插件解码，失败只 warning', async () => {
    const plugin = await loadBuiltinImageDecoder('gif');
    expect(plugin).toBeDefined();
    expect(builtinImageDecoders.some((item) => item.format === 'gif')).toBe(true);
    const decoded = await plugin!.decode(fixture('tiny.gif'));
    expect(decoded.width).toBe(3);

    const warnings: OFDWarning[] = [];
    const missing = await decodeWithImageDecoder(
      fixture('tiny.gif').subarray(0, 20),
      'gif',
      undefined,
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect(missing).toBeUndefined();
    expect(warnings.some((warning) => warning.code === 'W_IMAGE_DECODE')).toBe(true);
  });

  it('拒绝损坏头与超过像素上限的 GIF', async () => {
    await expect(decodeGif(new Uint8Array([0, 1, 2]))).rejects.toThrow();
    const data = fixture('tiny.gif');
    await expect(decodeGif(data, { maxPixels: 2 })).rejects.toMatchObject({
      code: 'OFD_LIMIT_EXCEEDED',
    });
  });

  it('解码真实样本 2.gif', async () => {
    const path = fileURLToPath(
      new URL('../../../../ofd_pdf_match/不规范资源路径.ofd', import.meta.url),
    );
    const { ZipReader } = await import('../../src/container/zip-reader');
    const { ArrayBufferSource } = await import('../../src/container/byte-source');
    const zip = await ZipReader.open(new ArrayBufferSource(readFileSync(path)));
    const bytes = await zip.readEntry('Doc_0/Res/2.gif');
    const result = await decodeGif(bytes, { maxPixels: 100_000_000 });
    expect(result.width).toBe(1536);
    expect(result.height).toBe(864);
    expect((result.data as { data: Uint8ClampedArray }).data[3]).toBe(255);
    await zip.close();
  });
});
