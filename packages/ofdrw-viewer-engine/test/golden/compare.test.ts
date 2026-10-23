/**
 * 黄金图比较口径自测：尺寸/bbox 容差、关键色 ΔE2000、抗锯齿排除、diff 输出。
 */

import { describe, expect, it } from 'vitest';
import { deltaE2000, rgbToLab } from './lib/color';
import { compareImages } from './lib/compare';
import { decodePng } from './lib/image';
import type { ImageLike } from './lib/types';

/** 在白色底图上画一个实心矩形。 */
function imageWithRect(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
  rgb: readonly [number, number, number],
): ImageLike {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    data[offset] = 255;
    data[offset + 1] = 255;
    data[offset + 2] = 255;
    data[offset + 3] = 255;
  }
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const offset = (y * width + x) * 4;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
    }
  }
  return { width, height, data };
}

const RED = [220, 20, 30] as const;
const GREEN = [30, 122, 50] as const;
const BASE_RECT = { x: 40, y: 30, width: 120, height: 80 };

describe('图像比较容差', () => {
  it('完全一致：pass，SSIM=1，像素差=0', () => {
    const image = imageWithRect(300, 200, BASE_RECT, RED);
    const result = compareImages(image, image);
    expect(result.status).toBe('pass');
    expect(result.metrics.ssim).toBeCloseTo(1, 6);
    expect(result.metrics.pixelDiffRatio).toBe(0);
    expect(result.metrics.layoutDeltaMm).toBe(0);
    expect(result.metrics.keyColorMaxDE).toBeCloseTo(0, 3);
    expect(result.metrics.regions).toHaveLength(9);
    expect(result.diffPng).toBeDefined();
  });

  it('整体位移 1 px：在 1 设备像素容差内，pass', () => {
    const expected = imageWithRect(300, 200, BASE_RECT, RED);
    const actual = imageWithRect(300, 200, { ...BASE_RECT, x: BASE_RECT.x + 1, y: BASE_RECT.y + 1 }, RED);
    const result = compareImages(actual, expected);
    expect(result.metrics.sizeDeltaPx).toEqual({ width: 0, height: 0 });
    expect(result.metrics.layoutDeltaMm).toBeCloseTo(25.4 / 96, 6);
    expect(result.status).toBe('pass');
  });

  it('整体位移 5 px：超出 0.5 mm，layout-mismatch', () => {
    const expected = imageWithRect(300, 200, BASE_RECT, RED);
    const actual = imageWithRect(300, 200, { ...BASE_RECT, x: BASE_RECT.x + 5, y: BASE_RECT.y + 5 }, RED);
    const result = compareImages(actual, expected);
    expect(result.status).toBe('layout-mismatch');
    expect(result.metrics.layoutDeltaMm).toBeGreaterThan(0.5);
    expect(result.diffPng).toBeDefined();
  });

  it('关键色变化：color-mismatch，bbox 不变', () => {
    const expected = imageWithRect(300, 200, BASE_RECT, RED);
    const actual = imageWithRect(300, 200, BASE_RECT, GREEN);
    const result = compareImages(actual, expected);
    expect(result.status).toBe('color-mismatch');
    expect(result.metrics.layoutDeltaMm).toBe(0);
    expect(result.metrics.keyColorMaxDE).toBeGreaterThan(5);
  });

  it('页面尺寸差 10 px：size-mismatch', () => {
    const expected = imageWithRect(200, 200, BASE_RECT, RED);
    const actual = imageWithRect(210, 200, BASE_RECT, RED);
    const result = compareImages(actual, expected);
    expect(result.status).toBe('size-mismatch');
    expect(result.metrics.sizeDeltaPx).toEqual({ width: 10, height: 0 });
    expect(result.metrics.sizeDeltaMm.width).toBeCloseTo((10 * 25.4) / 96, 6);
  });

  it('一方为空白：内容存在性不一致，layout-mismatch', () => {
    const expected = imageWithRect(300, 200, BASE_RECT, RED);
    const blank: ImageLike = {
      width: 300,
      height: 200,
      data: new Uint8Array(300 * 200 * 4).fill(255),
    };
    const result = compareImages(blank, expected);
    expect(result.status).toBe('layout-mismatch');
    expect(result.metrics.layoutDeltaMm).toBeNull();
    expect(result.metrics.actualBBoxMm).toBeNull();
    expect(result.metrics.expectedBBoxMm).not.toBeNull();
  });

  it('diff PNG 为合法图像并标出差异像素', () => {
    const expected = imageWithRect(120, 80, { x: 10, y: 10, width: 40, height: 30 }, RED);
    const actual = imageWithRect(120, 80, { x: 20, y: 10, width: 40, height: 30 }, RED);
    const result = compareImages(actual, expected);
    expect(result.diffPng).toBeDefined();
    const diff = decodePng(result.diffPng!);
    expect(diff.width).toBe(120);
    expect(diff.height).toBe(80);
    let redPixels = 0;
    for (let i = 0; i < diff.width * diff.height; i += 1) {
      const offset = i * 4;
      if (diff.data[offset] === 255 && diff.data[offset + 1] === 0 && diff.data[offset + 2] === 0) {
        redPixels += 1;
      }
    }
    expect(redPixels).toBeGreaterThan(0);
    // 非差异区必须是淡出的原图，而不是整张全红（回归 pixelmatch alpha 恒 255 的缺陷）。
    const farOffset = (5 * diff.width + 5) * 4;
    expect(diff.data[farOffset]).toBeGreaterThan(240);
    expect(diff.data[farOffset + 1]).toBeGreaterThan(240);
    expect(diff.data[farOffset + 2]).toBeGreaterThan(240);
    // 差异页级比例与 3×3 区域加权比例一致（容差 0.01）。
    const regionPixels = Math.ceil(diff.width / 3) * Math.ceil(diff.height / 3);
    const weighted =
      result.metrics.regions.reduce((sum, region) => sum + region.pixelDiffRatio, 0) /
      result.metrics.regions.length;
    expect(result.metrics.regions.every((region) => region.pixelDiffRatio < 1)).toBe(true);
    expect(Math.abs(weighted - result.metrics.pixelDiffRatio)).toBeLessThan(0.01);
    expect(regionPixels).toBeGreaterThan(0);
  });

  it('暴露颜色 95 分位/分块/墨迹/内容差异辅助指标', () => {
    const expected = imageWithRect(120, 80, { x: 10, y: 10, width: 40, height: 30 }, RED);
    const actual = imageWithRect(120, 80, { x: 10, y: 10, width: 40, height: 30 }, GREEN);
    const result = compareImages(actual, expected);
    expect(result.metrics.colorP95DE).toBeGreaterThan(0);
    expect(result.metrics.colorP95DEAll).toBeGreaterThan(0);
    expect(result.metrics.blockColorP95DE).toBeGreaterThan(0);
    expect(result.metrics.contentDiffRatio).toBeGreaterThan(0);
    // 墨迹差异用位移矩形验证（颜色变化不改变墨迹掩码）。
    const shifted = compareImages(
      imageWithRect(120, 80, { x: 20, y: 10, width: 40, height: 30 }, RED),
      expected,
    );
    expect(shifted.metrics.inkDiffRatio).toBeGreaterThan(0);
    const identical = compareImages(expected, expected);
    expect(identical.metrics.colorP95DEAll).toBe(0);
    expect(identical.metrics.blockColorP95DE).toBe(0);
    expect(identical.metrics.inkDiffRatio).toBe(0);
    expect(identical.metrics.contentDiffRatio).toBe(0);
  });
});

describe('CIEDE2000 色差', () => {
  it('符合 Sharma 标准测试数据', () => {
    const pairs: Array<[Parameters<typeof deltaE2000>[0], Parameters<typeof deltaE2000>[1], number]> = [
      [{ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 }, 2.0425],
      [{ L: 50, a: 3.1571, b: -77.2803 }, { L: 50, a: 0, b: -82.7485 }, 2.8615],
      [{ L: 50, a: 2.8361, b: -74.02 }, { L: 50, a: 0, b: -82.7485 }, 3.4412],
    ];
    for (const [lab1, lab2, expected] of pairs) {
      expect(deltaE2000(lab1, lab2)).toBeCloseTo(expected, 3);
    }
  });

  it('sRGB 白/黑到 Lab 的端点正确', () => {
    const white = rgbToLab({ r: 255, g: 255, b: 255 });
    expect(white.L).toBeCloseTo(100, 2);
    expect(white.a).toBeCloseTo(0, 2);
    expect(white.b).toBeCloseTo(0, 2);
    const black = rgbToLab({ r: 0, g: 0, b: 0 });
    expect(black.L).toBeCloseTo(0, 4);
  });
});