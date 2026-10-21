/**
 * 矩阵与颜色 fixture 数据（测试 fixture 专用）。
 *
 * 矩阵采用 `[a, b, c, d, e, f]` 列向量约定：`x' = a*x + c*y + e`，`y' = b*x + d*y + f`。
 * 颜色同时给出 OFD 常见写法与期望 RGBA（0..255，alpha 0..1），供颜色解析测试复用。
 */

/** 矩阵用例。 */
export interface MatrixCase {
  /** 用例名。 */
  name: string;
  /** 2×3 矩阵。 */
  matrix: readonly [number, number, number, number, number, number];
  /** 输入点，单位由用例说明（mm 或 device px）。 */
  point: readonly [number, number];
  /** 期望输出点。 */
  expected: readonly [number, number];
}

/** 覆盖平移、缩放、旋转、镜像与组合的固定矩阵用例。 */
export const MATRIX_CASES: readonly MatrixCase[] = Object.freeze([
  {
    name: 'identity',
    matrix: [1, 0, 0, 1, 0, 0],
    point: [12.5, -3.25],
    expected: [12.5, -3.25],
  },
  {
    name: 'translate',
    matrix: [1, 0, 0, 1, 10, 20],
    point: [1, 2],
    expected: [11, 22],
  },
  {
    name: 'scale-96dpi',
    matrix: [96 / 25.4, 0, 0, 96 / 25.4, 0, 0],
    point: [25.4, 25.4],
    expected: [96, 96],
  },
  {
    name: 'rotate-90',
    matrix: [0, 1, -1, 0, 0, 0],
    point: [1, 0],
    expected: [0, 1],
  },
  {
    name: 'mirror-x',
    matrix: [-1, 0, 0, 1, 0, 0],
    point: [5, 5],
    expected: [-5, 5],
  },
  {
    name: 'page-transform-with-origin',
    matrix: [1, 0, 0, 1, -10, -20],
    point: [10, 20],
    expected: [0, 0],
  },
]);

/** 颜色用例。 */
export interface ColorCase {
  /** 用例名。 */
  name: string;
  /** OFD/样式中的颜色原文。 */
  input: string;
  /** 期望 RGBA；alpha 为 0..1。 */
  expected: { r: number; g: number; b: number; a: number };
  /** 说明（单位/写法来源）。 */
  note?: string;
}

/** 覆盖 RGB/GRAY/CMYK/十六进制/透明度的颜色用例。 */
export const COLOR_CASES: readonly ColorCase[] = Object.freeze([
  {
    name: 'rgb-triplet',
    input: '255 0 0',
    expected: { r: 255, g: 0, b: 0, a: 1 },
    note: 'OFD Color Value 写法：空格分隔 RGB（0..255）',
  },
  {
    name: 'rgb-gray',
    input: '128 128 128',
    expected: { r: 128, g: 128, b: 128, a: 1 },
  },
  {
    name: 'hex-rgb',
    input: '#FF0000',
    expected: { r: 255, g: 0, b: 0, a: 1 },
    note: '普通 `#RRGGBB`',
  },
  {
    name: 'hex-argb',
    input: '#80FF0000',
    expected: { r: 255, g: 0, b: 0, a: 128 / 255 },
    note: 'OFD 允许 `#AARRGGBB`；alpha 需按 8 位换算',
  },
  {
    name: 'css-rgb',
    input: 'rgb(0, 128, 255)',
    expected: { r: 0, g: 128, b: 255, a: 1 },
  },
  {
    name: 'cmyk-percent',
    input: '0 100 100 0',
    expected: { r: 255, g: 0, b: 0, a: 1 },
    note: 'CMYK 资源需按 ICC/色彩空间解析，这里只给常见近似期望',
  },
]);

/** 纸张尺寸 fixture（mm），用于 viewport/页码回归。 */
export const PAPER_SIZES_MM = Object.freeze([
  { name: 'A4', width: 210, height: 297 },
  { name: 'A4-landscape', width: 297, height: 210 },
  { name: 'ticket-105x70', width: 105, height: 70 },
  { name: 'a3', width: 297, height: 420 },
]);