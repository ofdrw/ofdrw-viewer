/**
 * T16a：viewport 小数精度归一化（固定 3 位，单位 px）。
 */

import { describe, expect, it } from 'vitest';
import { OFDPage } from '../../src/api/page';
import {
  DEFAULT_DPI,
  MM_PER_INCH,
  getPageViewport,
} from '../../src/api/viewport';

/** 把毫米尺寸换算为指定 DPI 的理论像素值（未归一化）。 */
function pixelsOfMm(mm: number, dpi = DEFAULT_DPI): number {
  return mm * (dpi / MM_PER_INCH);
}

describe('getPageViewport 小数精度', () => {
  it('228.6mm@96dpi 归一化为 864，不再被 ceil 成 865', () => {
    const viewport = getPageViewport({ width: 228.6, height: 228.6 });
    expect(viewport.dpi).toBe(DEFAULT_DPI);
    expect(viewport.width).toBe(864);
    expect(viewport.height).toBe(864);
    expect(Math.ceil(viewport.width)).toBe(864);
    expect(Math.ceil(viewport.height)).toBe(864);
    // 原始浮点值是 864.0000000000001，归一化必须消除尾差。
    expect(pixelsOfMm(228.6)).not.toBe(864);
  });

  it('406.4mm@96dpi 归一化为 1536', () => {
    const viewport = getPageViewport({ width: 406.4, height: 228.6 });
    expect(viewport.width).toBe(1536);
    expect(viewport.height).toBe(864);
  });

  it('A4 210×297mm@96dpi 保留 3 位真实小数', () => {
    const viewport = getPageViewport({ width: 210, height: 297 });
    expect(viewport.width).toBe(793.701);
    expect(viewport.height).toBe(1122.52);
    expect(viewport.width).not.toBe(794);
    expect(viewport.height).not.toBe(1123);
    expect(Math.ceil(viewport.width)).toBe(794);
    expect(Math.ceil(viewport.height)).toBe(1123);
  });

  it('真实小数 864.3 保留，不被整数取整', () => {
    const widthMm = 864.3 / (DEFAULT_DPI / MM_PER_INCH);
    const viewport = getPageViewport({ width: widthMm, height: 100 });
    expect(viewport.width).toBe(864.3);
    expect(viewport.width).not.toBe(864);
    expect(Math.ceil(viewport.width)).toBe(865);
  });

  it('DPI 变化后仍按 3 位小数归一化', () => {
    const size = { width: 100, height: 50 };
    expect(getPageViewport(size, { dpi: 96 })).toMatchObject({
      width: 377.953,
      height: 188.976,
      dpi: 96,
    });
    expect(getPageViewport(size, { dpi: 144 })).toMatchObject({
      width: 566.929,
      height: 283.465,
      dpi: 144,
    });
    expect(getPageViewport(size, { dpi: 300 })).toMatchObject({
      width: 1181.102,
      height: 590.551,
      dpi: 300,
    });
  });

  it('page.getViewport 与 getPageViewport 语义一致', () => {
    const page = new OFDPage(0, { width: 228.6, height: 228.6 }, async () => undefined);
    const viewport = page.getViewport();
    expect(viewport).toEqual(getPageViewport({ width: 228.6, height: 228.6 }));
    expect(viewport.width).toBe(864);
    expect(viewport.height).toBe(864);
  });
});
