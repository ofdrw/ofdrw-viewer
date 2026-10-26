/**
 * 页面变换数学（黄金图尺寸口径的基础）。
 *
 * getPageViewport 的精度与 DPI 语义已由 `test/api/viewport.test.ts` 覆盖，这里只保留
 * 黄金图专用的 getPageTransform。
 */

import { describe, expect, it } from 'vitest';
import { getPageTransform } from '@ofdrw/ofdrw-viewer-engine';

describe('getPageTransform', () => {
  it('PhysicalBox 原点平移 + DPI 缩放', () => {
    const transform = getPageTransform({ x: 10, y: 20, w: 100, h: 200 }, 96);
    const scale = 96 / 25.4;
    expect(transform[0]).toBeCloseTo(scale, 9);
    expect(transform[3]).toBeCloseTo(scale, 9);
    expect(transform[4]).toBeCloseTo(-scale * 10, 9);
    expect(transform[5]).toBeCloseTo(-scale * 20, 9);
    // PhysicalBox 原点映射到 (0, 0)
    const x = transform[0] * 10 + transform[2] * 20 + transform[4];
    const y = transform[1] * 10 + transform[3] * 20 + transform[5];
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
  });

  it('原点为 0 时不产生 -0', () => {
    const transform = getPageTransform({ x: 0, y: 0, w: 210, h: 297 }, 96);
    expect(Object.is(transform[4], -0)).toBe(false);
    expect(Object.is(transform[5], -0)).toBe(false);
  });

  it('默认 DPI 为 96', () => {
    expect(getPageTransform({ x: 0, y: 0, w: 1, h: 1 })).toEqual(
      getPageTransform({ x: 0, y: 0, w: 1, h: 1 }, 96),
    );
  });
});