/**
 * 矩阵与几何基础操作。
 *
 * 该文件只做纯数学，不依赖 DOM/Node；render/font 的 CTM 与裁剪计算共用这里，
 * 避免各模块重复实现导致顺序/精度不一致。
 */

import type { Box, Matrix, Point } from './types';

/** 单位矩阵。 */
export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * 计算 `m1 × m2`（先应用 m2，再应用 m1）。
 *
 * @param m1 左矩阵。
 * @param m2 右矩阵。
 * @returns 复合矩阵。
 */
export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * 计算 `translate(x, y) × m`。
 *
 * @param m 原矩阵。
 * @param x X 方向平移量，当前空间单位。
 * @param y Y 方向平移量，当前空间单位。
 * @returns 平移后的矩阵。
 */
export function translateMatrix(m: Matrix, x: number, y: number): Matrix {
  const [a, b, c, d, e, f] = m;
  return [a, b, c, d, a * x + c * y + e, b * x + d * y + f];
}

/**
 * 计算 `scale(sx, sy) × m`。
 *
 * @param m 原矩阵。
 * @param sx X 方向缩放，无量纲。
 * @param sy Y 方向缩放，无量纲。
 * @returns 缩放后的矩阵。
 */
export function scaleMatrix(m: Matrix, sx: number, sy: number): Matrix {
  const [a, b, c, d, e, f] = m;
  return [a * sx, b * sx, c * sy, d * sy, e, f];
}

/**
 * 用矩阵变换一个点。
 *
 * @param m 变换矩阵。
 * @param point 输入点。
 * @returns 变换后的点。
 */
export function transformPoint(m: Matrix, point: Point): Point {
  const [a, b, c, d, e, f] = m;
  return {
    x: a * point.x + c * point.y + e,
    y: b * point.x + d * point.y + f,
  };
}

/**
 * 求矩阵逆；不可逆时返回 `null`。
 *
 * @param m 输入矩阵。
 * @returns 逆矩阵或 `null`。
 */
export function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < Number.EPSILON) return null;
  const inv = 1 / det;
  return [
    d * inv,
    -b * inv,
    -c * inv,
    a * inv,
    (c * f - d * e) * inv,
    (b * e - a * f) * inv,
  ];
}

/**
 * 归一化矩形：宽高为负时移动到最小角，保证 w/h 非负。
 *
 * @param box 输入矩形，单位与调用方一致。
 * @returns 归一化后的矩形。
 */
export function normalizeBox(box: Box): Box {
  const x = box.w < 0 ? box.x + box.w : box.x;
  const y = box.h < 0 ? box.y + box.h : box.y;
  return { x, y, w: Math.abs(box.w), h: Math.abs(box.h) };
}

/**
 * 计算两个矩形的并集。
 *
 * @param a 矩形 A。
 * @param b 矩形 B。
 * @returns 覆盖两者的最小矩形。
 */
export function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * 计算两个矩形的交集；无交集时返回 `null`。
 *
 * @param a 矩形 A。
 * @param b 矩形 B。
 * @returns 交集矩形或 `null`。
 */
export function intersectBox(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}