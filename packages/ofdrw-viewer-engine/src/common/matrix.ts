/**
 * 矩阵与几何基础操作。
 *
 * 该文件只做纯数学，不依赖 DOM/Node；render/font 的 CTM 与裁剪计算共用这里，
 * 避免各模块重复实现导致顺序/精度不一致。
 *
 * 矩阵采用列向量约定：`[a, b, c, d, e, f]` 表示
 * `x' = a·x + c·y + e`、`y' = b·x + d·y + f`；
 * 复合 `m1 × m2` 表示先应用 `m2`，再应用 `m1`。
 */

import type { Box, Matrix, Point } from './types';

/** 单位矩阵。 */
export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * 创建单位矩阵。
 *
 * @returns 新的单位矩阵。
 */
export function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

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
 * 计算 `m × T(x, y)`（先应用当前变换，再平移，与 Canvas `translate` 一致）。
 *
 * @param m 原矩阵。
 * @param x X 方向平移量，当前空间单位（通常 mm）。
 * @param y Y 方向平移量，当前空间单位（通常 mm）。
 * @returns 平移后的矩阵。
 */
export function translateMatrix(m: Matrix, x: number, y: number): Matrix {
  const [a, b, c, d, e, f] = m;
  return [a, b, c, d, a * x + c * y + e, b * x + d * y + f];
}

/**
 * 计算 `m × S(sx, sy)`（先应用当前变换，再缩放，与 Canvas `scale` 一致）。
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
 * 计算 `m × R(rad)`（先应用当前变换，再旋转，与 Canvas `rotate` 一致）。
 *
 * 正角方向与 Canvas 一致：X 轴转向 Y 轴。
 *
 * @param m 原矩阵。
 * @param radians 旋转角，单位弧度。
 * @returns 旋转后的矩阵。
 */
export function rotateMatrix(m: Matrix, radians: number): Matrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const [a, b, c, d, e, f] = m;
  return [a * cos + c * sin, b * cos + d * sin, -a * sin + c * cos, -b * sin + d * cos, e, f];
}

/**
 * 计算 `m × K(ax, ay)`（先应用当前变换，再斜切）。
 *
 * @param m 原矩阵。
 * @param ax X 方向斜切角，单位弧度。
 * @param ay Y 方向斜切角，单位弧度。
 * @returns 斜切后的矩阵。
 */
export function skewMatrix(m: Matrix, ax: number, ay: number): Matrix {
  const tanX = Math.tan(ax);
  const tanY = Math.tan(ay);
  const [a, b, c, d, e, f] = m;
  return [a + c * tanY, b + d * tanY, c + a * tanX, d + b * tanX, e, f];
}

/**
 * 创建纯平移矩阵 `T(x, y)`。
 *
 * @param x X 方向平移量，单位由调用方决定（通常 mm）。
 * @param y Y 方向平移量，单位由调用方决定（通常 mm）。
 * @returns 平移矩阵。
 */
export function translationMatrix(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

/**
 * 创建纯缩放矩阵 `S(sx, sy)`。
 *
 * @param sx X 方向缩放，无量纲。
 * @param sy Y 方向缩放，无量纲。
 * @returns 缩放矩阵。
 */
export function scalingMatrix(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

/**
 * 创建纯旋转矩阵 `R(rad)`。
 *
 * @param radians 旋转角，单位弧度。
 * @returns 旋转矩阵。
 */
export function rotationMatrix(radians: number): Matrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
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
 * 用矩阵变换一个矩形，返回变换后四个角点的轴对齐包围盒。
 *
 * @param m 变换矩阵。
 * @param box 输入矩形；宽高可为负。
 * @returns 变换后的轴对齐包围盒。
 */
export function transformBox(m: Matrix, box: Box): Box {
  const [a, b, c, d, e, f] = m;
  const x1 = box.x;
  const y1 = box.y;
  const x2 = box.x + box.w;
  const y2 = box.y + box.h;
  const points: readonly Point[] = [
    { x: a * x1 + c * y1 + e, y: b * x1 + d * y1 + f },
    { x: a * x2 + c * y1 + e, y: b * x2 + d * y1 + f },
    { x: a * x1 + c * y2 + e, y: b * x1 + d * y2 + f },
    { x: a * x2 + c * y2 + e, y: b * x2 + d * y2 + f },
  ];
  let minX = points[0]!.x;
  let minY = points[0]!.y;
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
 * 判断矩阵是否为单位矩阵（按 `Number.EPSILON` 容差）。
 *
 * @param m 输入矩阵。
 * @returns 是否为单位矩阵。
 */
export function isIdentityMatrix(m: Matrix): boolean {
  return (
    Math.abs(m[0] - 1) <= Number.EPSILON &&
    Math.abs(m[1]) <= Number.EPSILON &&
    Math.abs(m[2]) <= Number.EPSILON &&
    Math.abs(m[3] - 1) <= Number.EPSILON &&
    Math.abs(m[4]) <= Number.EPSILON &&
    Math.abs(m[5]) <= Number.EPSILON
  );
}

/**
 * 判断矩阵所有分量是否有限。
 *
 * @param m 输入矩阵。
 * @returns 全部分量有限时返回 true。
 */
export function isFiniteMatrix(m: Matrix): boolean {
  return m.every((value) => Number.isFinite(value));
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