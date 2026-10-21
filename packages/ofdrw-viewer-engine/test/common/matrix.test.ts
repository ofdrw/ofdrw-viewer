import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MATRIX,
  identityMatrix,
  intersectBox,
  invertMatrix,
  isFiniteMatrix,
  isIdentityMatrix,
  multiplyMatrix,
  normalizeBox,
  rotateMatrix,
  rotationMatrix,
  scaleMatrix,
  scalingMatrix,
  skewMatrix,
  transformBox,
  transformPoint,
  translateMatrix,
  translationMatrix,
  unionBox,
} from '../../src/common/matrix';
import type { Point } from '../../src/common/types';

/** 判断两个点是否近似相等。 */
function expectPoint(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
}

describe('common/matrix', () => {
  it('单位矩阵不改变点', () => {
    expect(identityMatrix()).toEqual([1, 0, 0, 1, 0, 0]);
    expectPoint(transformPoint(IDENTITY_MATRIX, { x: 3, y: -4 }), { x: 3, y: -4 });
    expect(isIdentityMatrix(IDENTITY_MATRIX)).toBe(true);
  });

  it('multiplyMatrix 先应用右矩阵，再应用左矩阵', () => {
    const translate = translationMatrix(10, 0);
    const scale = scalingMatrix(2, 2);
    // translate × scale：先缩放再平移。
    expectPoint(transformPoint(multiplyMatrix(translate, scale), { x: 1, y: 1 }), { x: 12, y: 2 });
    // scale × translate：先平移再缩放。
    expectPoint(transformPoint(multiplyMatrix(scale, translate), { x: 1, y: 1 }), { x: 22, y: 2 });
  });

  it('translateMatrix/scaleMatrix/rotateMatrix 都是后乘当前变换', () => {
    const base = translationMatrix(5, 5);
    expectPoint(transformPoint(translateMatrix(base, 1, 2), { x: 0, y: 0 }), { x: 6, y: 7 });
    expectPoint(transformPoint(scaleMatrix(base, 2, 3), { x: 1, y: 1 }), { x: 7, y: 8 });
    expectPoint(transformPoint(rotateMatrix(base, Math.PI / 2), { x: 1, y: 0 }), { x: 5, y: 6 });
  });

  it('旋转 90/180 度与斜切矩阵符合列向量约定', () => {
    expectPoint(transformPoint(rotationMatrix(Math.PI / 2), { x: 1, y: 0 }), { x: 0, y: 1 });
    expectPoint(transformPoint(rotationMatrix(Math.PI), { x: 1, y: 2 }), { x: -1, y: -2 });
    // x' = x + tan(45°)·y；y' = y。
    expectPoint(transformPoint(skewMatrix(identityMatrix(), Math.PI / 4, 0), { x: 0, y: 1 }), {
      x: 1,
      y: 1,
    });
  });

  it('transformBox 返回旋转后的轴对齐包围盒', () => {
    const box = transformBox(rotationMatrix(Math.PI / 2), { x: 0, y: 0, w: 2, h: 1 });
    expect(box.x).toBeCloseTo(-1);
    expect(box.y).toBeCloseTo(0);
    expect(box.w).toBeCloseTo(1);
    expect(box.h).toBeCloseTo(2);
  });

  it('求逆后可还原点；退化矩阵返回 null', () => {
    const matrix = multiplyMatrix(translationMatrix(7, -3), rotationMatrix(0.4));
    const inverse = invertMatrix(matrix);
    expect(inverse).not.toBeNull();
    const original = { x: 2.5, y: -1.25 };
    expectPoint(transformPoint(inverse!, transformPoint(matrix, original)), original);
    expect(invertMatrix([0, 0, 0, 0, 0, 0])).toBeNull();
    expect(isFiniteMatrix(matrix)).toBe(true);
    expect(isFiniteMatrix([Number.NaN, 0, 0, 1, 0, 0])).toBe(false);
  });

  it('矩形归一化、并集与交集', () => {
    expect(normalizeBox({ x: 10, y: 20, w: -4, h: -5 })).toEqual({ x: 6, y: 15, w: 4, h: 5 });
    expect(unionBox({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 3, w: 2, h: 1 })).toEqual({
      x: 0,
      y: 0,
      w: 3,
      h: 4,
    });
    expect(intersectBox({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toEqual({
      x: 1,
      y: 1,
      w: 1,
      h: 1,
    });
    expect(intersectBox({ x: 0, y: 0, w: 1, h: 1 }, { x: 2, y: 2, w: 1, h: 1 })).toBeNull();
  });
});