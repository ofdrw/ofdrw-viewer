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

  it('LZW 字典 first 字符：解码结果与参考解码器逐像素一致（BUG-V2-04 根因）', async () => {
    // 保函.ofd 的 Sign_1 印章 GIF：250×249、4 色调色板、透明索引 3。
    // 该 GIF 的 LZW 码流会触发“词条首字符”存储错误：输出长度与颜色直方图看似正常，
    // 但像素位置被打乱，印章整体丢墨（曾导致方章几乎不可见）。
    const path = fileURLToPath(
      new URL('../../../../ofd_pdf_match/保函.ofd', import.meta.url),
    );
    const { ZipReader } = await import('../../src/container/zip-reader');
    const { ArrayBufferSource } = await import('../../src/container/byte-source');
    const zip = await ZipReader.open(new ArrayBufferSource(readFileSync(path)));
    const signedValue = await zip.readEntry('Doc_0/Signs/Sign_1/SignedValue.dat');
    await zip.close();
    const start = signedValue.findIndex(
      (byte, index) =>
        byte === 0x47 &&
        signedValue[index + 1] === 0x49 &&
        signedValue[index + 2] === 0x46 &&
        signedValue[index + 3] === 0x38,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    // GIF 文件到图像数据结束：最小码长 2、单帧、无局部调色板。
    const result = await decodeGif(signedValue.subarray(start), { maxPixels: 1_000_000 });
    expect(result.width).toBe(250);
    expect(result.height).toBe(249);
    const alpha = (result.data as { data: Uint8ClampedArray }).data;
    // 不透明像素总数（源图 18003 个 α=255）。
    let opaque = 0;
    for (let index = 3; index < alpha.length; index += 4) if (alpha[index]! > 0) opaque += 1;
    expect(opaque).toBe(18003);
    // 顶部框线：源图每行不透明像素数（第 6/7 行为 200/217）。
    const rowCount = (row: number): number => {
      let count = 0;
      for (let x = 0; x < 250; x += 1) if (alpha[(row * 250 + x) * 4 + 3]! > 0) count += 1;
      return count;
    };
    expect([5, 6, 7].map(rowCount)).toEqual([70, 200, 217]);
    // 底部编号行仍在（第 210 行有近百个不透明像素，说明像素未被打乱）。
    expect(rowCount(210)).toBeGreaterThan(80);
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
