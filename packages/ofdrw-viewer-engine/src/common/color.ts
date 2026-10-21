/**
 * 颜色工具。
 *
 * 只输出 target-independent 的 RGBA 或 CSS 颜色字符串，不依赖 Canvas。
 * 颜色空间近似遵循设计方案 9.3：GRAY 复制到 RGB、CMYK 用乘法近似、调色板按索引取色。
 */

import type { Rgba } from './types';

/** 每通道位数；OFD 允许 1/2/4/8/16。 */
export type ColorBits = 1 | 2 | 4 | 8 | 16;

/** 颜色空间类型；`GREY` 是 `GRAY` 的常见拼写，归一化为 `GRAY`。 */
export type ColorSpaceType = 'GRAY' | 'RGB' | 'CMYK';

/** 颜色空间描述；调色板存在时优先按 `Index` 取色。 */
export interface ColorSpaceDescriptor {
  /** 颜色空间类型。 */
  type: ColorSpaceType;
  /** 每通道位数，默认 8。 */
  bitsPerComponent?: ColorBits;
  /** 调色板；索引颜色空间使用。 */
  palette?: readonly Rgba[];
}

/** 把数值四舍五入并夹到 0..255。 */
export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * 创建 RGBA 颜色；各通道夹到 0..255。
 *
 * @param r 红通道，0..255。
 * @param g 绿通道，0..255。
 * @param b 蓝通道，0..255。
 * @param a 透明度，0..255，默认 255。
 * @returns RGBA 对象。
 */
export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: clampByte(a) };
}

/**
 * 把 RGBA 转成 `rgba(r,g,b,a)` CSS 字符串。
 *
 * @param color RGBA 颜色。
 * @returns CSS 颜色字符串，alpha 归一化到 0..1。
 */
export function rgbaToCss(color: Rgba): string {
  const alpha = clampByte(color.a) / 255;
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${alpha})`;
}

/**
 * 按 `alpha/255` 预乘透明度，返回新的颜色。
 *
 * @param color 输入颜色。
 * @param alpha 额外透明度，0..1；越界会夹紧。
 * @returns 新的 RGBA 颜色。
 */
export function multiplyRgbaAlpha(color: Rgba, alpha: number): Rgba {
  const factor = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  return {
    r: clampByte(color.r),
    g: clampByte(color.g),
    b: clampByte(color.b),
    a: clampByte(color.a * factor),
  };
}

/**
 * 归一化颜色空间类型字符串；未知类型回退 RGB。
 *
 * @param raw XML 中的 `Type` 属性。
 * @returns 颜色空间类型。
 */
export function normalizeColorSpaceType(raw: string | undefined): ColorSpaceType {
  const value = (raw ?? '').trim().toUpperCase();
  if (value === 'GRAY' || value === 'GREY') return 'GRAY';
  if (value === 'CMYK') return 'CMYK';
  return 'RGB';
}

/**
 * 归一化每通道位数；非 1/2/4/8/16 时回退 8。
 *
 * @param raw 原始位数。
 * @returns 合法位数。
 */
export function normalizeBitsPerComponent(raw: number | undefined): ColorBits {
  return raw === 1 || raw === 2 || raw === 4 || raw === 8 || raw === 16 ? raw : 8;
}

/**
 * 解析 `#RGB`/`#RRGGBB` 整色 token。
 *
 * @param raw 原始 token（可带前导/尾随空白）。
 * @returns RGBA；不是 3/6 位十六进制时返回 `null`。
 */
export function parseHexColor(raw: string): Rgba | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw.trim());
  if (!match) return null;
  const digits = match[1] as string;
  if (digits.length === 3) {
    const r = Number.parseInt(digits[0] as string, 16);
    const g = Number.parseInt(digits[1] as string, 16);
    const b = Number.parseInt(digits[2] as string, 16);
    return { r: r * 17, g: g * 17, b: b * 17, a: 255 };
  }
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
    a: 255,
  };
}

/**
 * 把指定位深的通道值缩放到 0..255。
 *
 * @param value 原始通道值，范围 `0..2^bits-1`。
 * @param bitsPerComponent 每通道位数，1/2/4/8/16；非法值按 8。
 * @returns 0..255 的通道值。
 */
export function channelToByte(value: number, bitsPerComponent: number | undefined): number {
  const bits = normalizeBitsPerComponent(bitsPerComponent);
  const max = 2 ** bits - 1;
  if (!Number.isFinite(value)) return 0;
  return clampByte((value / max) * 255);
}

/**
 * 按颜色空间把 0..255 的通道值转换为 RGBA；CMYK 使用近似公式。
 *
 * @param channels 通道值，0..255；缺失通道按 0。
 * @param type 颜色空间类型。
 * @param alpha Alpha，0..255，默认 255。
 * @returns RGBA。
 */
export function colorSpaceToRgba(
  channels: readonly number[],
  type: ColorSpaceType,
  alpha = 255,
): Rgba {
  if (type === 'GRAY') {
    const gray = clampByte(channels[0] ?? 0);
    return { r: gray, g: gray, b: gray, a: clampByte(alpha) };
  }
  if (type === 'CMYK') {
    const c = clampByte(channels[0] ?? 0) / 255;
    const m = clampByte(channels[1] ?? 0) / 255;
    const y = clampByte(channels[2] ?? 0) / 255;
    const k = clampByte(channels[3] ?? 0) / 255;
    return {
      r: clampByte(255 * (1 - c) * (1 - k)),
      g: clampByte(255 * (1 - m) * (1 - k)),
      b: clampByte(255 * (1 - y) * (1 - k)),
      a: clampByte(alpha),
    };
  }
  return {
    r: clampByte(channels[0] ?? 0),
    g: clampByte(channels[1] ?? 0),
    b: clampByte(channels[2] ?? 0),
    a: clampByte(alpha),
  };
}

/**
 * 从调色板按索引取色；索引非法或调色板缺失时返回 `null`。
 *
 * @param palette 调色板。
 * @param index 颜色索引。
 * @param alpha Alpha，0..255，默认 255。
 * @returns RGBA 或 `null`。
 */
export function paletteColor(
  palette: readonly Rgba[] | undefined,
  index: number,
  alpha = 255,
): Rgba | null {
  if (!palette || !Number.isInteger(index) || index < 0 || index >= palette.length) return null;
  const entry = palette[index]!;
  return { r: entry.r, g: entry.g, b: entry.b, a: clampByte(alpha) };
}

/**
 * 解析颜色值文本（`0 0 0`、`#RRGGBB` 或按位深缩放的通道）。
 *
 * 该函数只处理通道值，不处理 `Index`；索引颜色请先调用 `paletteColor`。
 * 非法 token 按 0 处理，不抛异常（warning 由调用方决定是否上报）。
 *
 * @param raw 原始颜色值；缺失/空串返回黑色。
 * @param space 颜色空间描述；缺省 RGB 8 位。
 * @param alpha Alpha，0..255，默认 255。
 * @returns RGBA。
 */
export function parseColorValue(
  raw: string | undefined,
  space?: ColorSpaceDescriptor,
  alpha = 255,
): Rgba {
  const value = (raw ?? '').trim();
  if (value.length === 0) return { r: 0, g: 0, b: 0, a: clampByte(alpha) };

  const firstToken = value.split(/[\s,]+/)[0] ?? '';
  const hex = firstToken.startsWith('#') ? parseHexColor(firstToken) : null;
  if (hex) return { ...hex, a: clampByte(alpha) };

  const bits = normalizeBitsPerComponent(space?.bitsPerComponent);
  const type = space?.type ?? 'RGB';
  const channels = value
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      // 单通道也允许 #F/#FF 的十六进制写法。
      const channelHex = /^#([0-9a-fA-F]{1,2})$/.exec(token);
      if (channelHex) {
        const digits = channelHex[1] as string;
        const denominator = digits.length >= 2 ? 255 : 15;
        return clampByte((Number.parseInt(digits, 16) / denominator) * 255);
      }
      const parsed = Number(token);
      return Number.isFinite(parsed) ? channelToByte(parsed, bits) : 0;
    });
  return colorSpaceToRgba(channels, type, alpha);
}