import { describe, expect, it } from 'vitest';
import {
  channelToByte,
  clampByte,
  colorSpaceToRgba,
  multiplyRgbaAlpha,
  normalizeBitsPerComponent,
  normalizeColorSpaceType,
  paletteColor,
  parseColorValue,
  parseHexColor,
  rgba,
  rgbaToCss,
} from '../../src/common/color';

describe('common/color', () => {
  it('rgba 与 CSS 字符串会夹紧通道', () => {
    expect(rgba(300, -10, 12.6)).toEqual({ r: 255, g: 0, b: 13, a: 255 });
    expect(clampByte(Number.NaN)).toBe(0);
    expect(rgbaToCss({ r: 255, g: 0, b: 128, a: 128 })).toBe('rgba(255, 0, 128, 0.5019607843137255)');
    expect(multiplyRgbaAlpha({ r: 10, g: 20, b: 30, a: 200 }, 0.5).a).toBe(100);
  });

  it('颜色空间类型与位深归一化', () => {
    expect(normalizeColorSpaceType('gray')).toBe('GRAY');
    expect(normalizeColorSpaceType('GREY')).toBe('GRAY');
    expect(normalizeColorSpaceType('cmyk')).toBe('CMYK');
    expect(normalizeColorSpaceType('unknown')).toBe('RGB');
    expect(normalizeBitsPerComponent(1)).toBe(1);
    expect(normalizeBitsPerComponent(16)).toBe(16);
    expect(normalizeBitsPerComponent(7)).toBe(8);
  });

  it('#RGB/#RRGGBB 解析', () => {
    expect(parseHexColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseHexColor('#00FF80')).toEqual({ r: 0, g: 255, b: 128, a: 255 });
    expect(parseHexColor('00FF80')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
  });

  it('位深 1/2/4/8/16 缩放到 0..255', () => {
    expect(channelToByte(1, 1)).toBe(255);
    expect(channelToByte(0, 1)).toBe(0);
    expect(channelToByte(3, 2)).toBe(255);
    expect(channelToByte(15, 4)).toBe(255);
    expect(channelToByte(128, 8)).toBe(128);
    expect(channelToByte(65535, 16)).toBe(255);
    expect(channelToByte(32768, 16)).toBe(128);
  });

  it('GRAY/RGB/CMYK 转换', () => {
    expect(colorSpaceToRgba([128], 'GRAY', 200)).toEqual({ r: 128, g: 128, b: 128, a: 200 });
    expect(colorSpaceToRgba([10, 20, 30], 'RGB')).toEqual({ r: 10, g: 20, b: 30, a: 255 });
    // CMYK 0/255/255/0 → 红。
    expect(colorSpaceToRgba([0, 255, 255, 0], 'CMYK')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(colorSpaceToRgba([0, 0, 0, 255], 'CMYK')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('调色板按索引取色，越界返回 null', () => {
    const palette = [
      { r: 1, g: 2, b: 3, a: 255 },
      { r: 4, g: 5, b: 6, a: 255 },
    ];
    expect(paletteColor(palette, 1, 128)).toEqual({ r: 4, g: 5, b: 6, a: 128 });
    expect(paletteColor(palette, 2)).toBeNull();
    expect(paletteColor(undefined, 0)).toBeNull();
  });

  it('parseColorValue 支持 #hex、按位深缩放的通道与空格/逗号分隔', () => {
    expect(parseColorValue('#00ff00')).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(parseColorValue('255 128 0')).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(parseColorValue('255,128,0')).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(parseColorValue('1', { type: 'GRAY', bitsPerComponent: 1 })).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 255,
    });
    expect(parseColorValue('65535 0 0', { type: 'RGB', bitsPerComponent: 16 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 255,
    });
    expect(parseColorValue('0 0 0 255', { type: 'CMYK', bitsPerComponent: 8 })).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 255,
    });
  });
});