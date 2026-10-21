/**
 * sRGB → CIELAB 与 CIEDE2000 色差（黄金图颜色容差用）。
 *
 * 参考：CIE 15:2004、Sharma et al. 2005（CIEDE2000 实现测试数据）。
 * 说明：输入 sRGB 8 位，D65 白点；不做 ICC 色彩管理。
 */

/** CIELAB 颜色。 */
export interface Lab {
  /** 明度 L*（0..100）。 */
  L: number;
  /** 绿-红轴 a*。 */
  a: number;
  /** 蓝-黄轴 b*。 */
  b: number;
}

/** sRGB 8 位颜色。 */
export interface Rgb8 {
  /** 红（0..255）。 */
  r: number;
  /** 绿（0..255）。 */
  g: number;
  /** 蓝（0..255）。 */
  b: number;
}

/** D65 参考白（XYZ，Y=1）。 */
const D65 = Object.freeze({ x: 0.95047, y: 1.0, z: 1.08883 });

/**
 * sRGB 8 位通道转线性值（0..1）。
 *
 * @param channel8 8 位通道值。
 * @returns 线性值。
 */
export function srgbToLinear(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * sRGB 转 XYZ（D65，Y 归一化到 1）。
 *
 * @param rgb sRGB 颜色。
 * @returns XYZ。
 */
export function rgbToXyz(rgb: Rgb8): { x: number; y: number; z: number } {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return {
    x: 0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    y: 0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    z: 0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  };
}

/** XYZ 转 Lab 的辅助函数 f(t)。 */
function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
}

/**
 * XYZ 转 CIELAB（D65）。
 *
 * @param xyz XYZ。
 * @returns Lab。
 */
export function xyzToLab(xyz: { x: number; y: number; z: number }): Lab {
  const fx = labF(xyz.x / D65.x);
  const fy = labF(xyz.y / D65.y);
  const fz = labF(xyz.z / D65.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * sRGB 8 位转 Lab。
 *
 * @param rgb sRGB 颜色。
 * @returns Lab。
 */
export function rgbToLab(rgb: Rgb8): Lab {
  return xyzToLab(rgbToXyz(rgb));
}

/** 角度归一化到 [0, 360)。 */
function normalizeAngle(angle: number): number {
  const mod = angle % 360;
  return mod < 0 ? mod + 360 : mod;
}

/** 度转弧度。 */
function rad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * 计算 CIEDE2000 色差。
 *
 * @param lab1 颜色 1。
 * @param lab2 颜色 2。
 * @returns ΔE2000（0 表示完全一致）。
 */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = C1p === 0 ? 0 : normalizeAngle((Math.atan2(b1, a1p) * 180) / Math.PI);
  const h2p = C2p === 0 ? 0 : normalizeAngle((Math.atan2(b2, a2p) * 180) / Math.PI);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p !== 0 && C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp = 0;
  if (C1p !== 0 && C2p !== 0) {
    hbarp = (h1p + h2p) / 2;
    if (Math.abs(h1p - h2p) > 180) hbarp += hbarp < 180 ? 180 : -180;
  }

  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;

  const termL = dLp / Sl;
  const termC = dCp / Sc;
  const termH = dHp / Sh;
  return Math.sqrt(termL * termL + termC * termC + termH * termH + Rt * termC * termH);
}

/**
 * 将 RGBA 颜色转成 CSS 字符串（HTML 报告用）。
 *
 * @param r 红（0..255）。
 * @param g 绿（0..255）。
 * @param b 蓝（0..255）。
 * @param a alpha（0..1）。
 * @returns `rgba(...)` 字符串。
 */
export function rgbaToCss(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`;
}