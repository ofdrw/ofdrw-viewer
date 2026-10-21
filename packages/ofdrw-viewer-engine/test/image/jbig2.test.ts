import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeJbig2 } from '../../src/image/jbig2';
import type { OFDWarning } from '../../src/warnings';

/** 读取真实 JBIG2 fixture。 */
function fixture(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

/** 简单 FNV-1a，用于比较整幅像素。 */
function checksum(data: Uint8ClampedArray): number {
  let hash = 0x811c9dc5;
  for (const value of data) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** 统计默认黑色像素数。 */
function countBlack(data: Uint8ClampedArray): number {
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] === 0 && data[index + 3] === 255) count += 1;
  }
  return count;
}

describe('decodeJbig2 真实 OFD 样本', () => {
  it('解码带文件头样本并输出 1bpp/RGBA', async () => {
    const expectedBlack: Readonly<Record<string, number>> = {
      '1-image_78.jb2': 4931,
      'no_page_container-image_100.jb2': 5191,
      'signedFile-image_80.jb2': 4806,
    };
    for (const name of Object.keys(expectedBlack)) {
      const result = await decodeJbig2(fixture(name));
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
      expect(result.kind).toBe('imagedata');
      expect(result.bilevel).toBe(true);
      expect(result.pageCount).toBe(1);
      expect(result.stride).toBe(13);
      expect(result.bits).toHaveLength(1300);
      expect(result.data.width).toBe(100);
      expect(result.data.height).toBe(100);
      expect(result.data.data).toHaveLength(40000);
      expect(countBlack(result.data.data)).toBe(expectedBlack[name]);
    }
  });

  it('无头嵌入式段与带文件头结果一致', async () => {
    const full = fixture('1-image_78.jb2');
    const headered = await decodeJbig2(full);
    const headerless = await decodeJbig2(full.subarray(13));
    expect(headerless.width).toBe(headered.width);
    expect(headerless.height).toBe(headered.height);
    expect(headerless.pageCount).toBe(headered.pageCount);
    expect(checksum(headerless.data.data)).toBe(checksum(headered.data.data));
  });

  it('bits 缓存与默认 RGBA 一致（bit1=黑、bit0=白）', async () => {
    const result = await decodeJbig2(fixture('1-image_78.jb2'));
    const { bits, stride, width, height } = result;
    for (let y = 0; y < height; y += 7) {
      for (let x = 0; x < width; x += 7) {
        const bit = (bits[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1;
        const offset = (y * width + x) * 4;
        expect(result.data.data[offset]).toBe(bit === 1 ? 0 : 255);
        expect(result.data.data[offset + 1]).toBe(bit === 1 ? 0 : 255);
        expect(result.data.data[offset + 2]).toBe(bit === 1 ? 0 : 255);
        expect(result.data.data[offset + 3]).toBe(255);
      }
    }
  });

  it('多页头只解第一页并上报 warning', async () => {
    const bytes = Uint8Array.from(fixture('1-image_78.jb2'));
    new DataView(bytes.buffer).setUint32(9, 2);
    const warnings: OFDWarning[] = [];
    const result = await decodeJbig2(bytes, { onWarning: (warning) => warnings.push(warning) });
    expect(result.pageCount).toBe(2);
    expect(result.width).toBe(100);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('W_JBIG2_DECODE');
    expect(warnings[0]?.message).toContain('仅解码第 1 页');
  });
});

describe('decodeJbig2 二值语义', () => {
  it('decode/invert 反转黑白', async () => {
    const bytes = fixture('1-image_78.jb2');
    const normal = await decodeJbig2(bytes);
    const inverted = await decodeJbig2(bytes, { decode: true });
    for (let offset = 0; offset < normal.data.data.length; offset += 4) {
      expect(inverted.data.data[offset]).toBe(255 - normal.data.data[offset]!);
      expect(inverted.data.data[offset + 3]).toBe(255);
    }
  });

  it('ImageMask 模式白底透明、墨黑不透明', async () => {
    const normal = await decodeJbig2(fixture('1-image_78.jb2'));
    const mask = await decodeJbig2(fixture('1-image_78.jb2'), { imageMask: true });
    let transparent = 0;
    for (let offset = 0; offset < normal.data.data.length; offset += 4) {
      if (normal.data.data[offset] === 255) {
        expect(mask.data.data[offset + 3]).toBe(0);
        transparent += 1;
      } else {
        expect(mask.data.data[offset]).toBe(0);
        expect(mask.data.data[offset + 3]).toBe(255);
      }
    }
    expect(transparent).toBe(10000 - 4931);
  });

  it('transparentWhite 让白像素透明', async () => {
    const result = await decodeJbig2(fixture('1-image_78.jb2'), { transparentWhite: true });
    for (let offset = 0; offset < result.data.data.length; offset += 4) {
      expect(result.data.data[offset + 3]).toBe(result.data.data[offset] === 255 ? 0 : 255);
    }
  });
});

describe('decodeJbig2 限制与错误', () => {
  it('解码前按页面信息检查像素上限', async () => {
    const warnings: OFDWarning[] = [];
    await expect(
      decodeJbig2(fixture('1-image_78.jb2'), { maxPixels: 5000, onWarning: (warning) => warnings.push(warning) }),
    ).rejects.toMatchObject({ code: 'OFD_LIMIT_EXCEEDED' });
    expect(warnings[0]?.code).toBe('W_JBIG2_DECODE');
    expect(warnings[0]?.message).toContain('像素上限');
  });

  it('损坏字节抛 OFD_IMAGE_DECODE 并上报 warning', async () => {
    const warnings: OFDWarning[] = [];
    await expect(
      decodeJbig2(Uint8Array.from([1, 2, 3, 4, 5]), { onWarning: (warning) => warnings.push(warning) }),
    ).rejects.toMatchObject({ code: 'OFD_IMAGE_DECODE' });
    expect(warnings[0]?.code).toBe('W_JBIG2_DECODE');
  });

  it('截断文件头抛 OFD_IMAGE_DECODE', async () => {
    await expect(decodeJbig2(fixture('1-image_78.jb2').subarray(0, 20))).rejects.toMatchObject({
      code: 'OFD_IMAGE_DECODE',
    });
  });
});
