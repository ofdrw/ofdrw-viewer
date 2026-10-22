/**
 * T9d y 图片回归：p1 建筑照片与 p3 蓝色架构图必须完整绘制。
 *
 * y 的图片位于 CompositeObject/ImageObject 中；p3 架构图旧实现因图片 Clips
 * 顺序错误整块丢失。测试读取真实渲染像素，不依赖 golden 阈值。
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderOfdSample } from '../golden/lib/engine';

/** 蓝色架构图像素 bbox 与数量。 */
function blueStats(
  image: PNG,
  box: { x0: number; y0: number; x1: number; y1: number },
): { count: number; x0: number; y0: number; x1: number; y1: number } | null {
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const index = (y * image.width + x) * 4;
      const r = image.data[index] ?? 0;
      const g = image.data[index + 1] ?? 0;
      const b = image.data[index + 2] ?? 0;
      if (b > 100 && b > r * 1.2 && b > g * 1.1) {
        count += 1;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return count > 0 ? { count, x0, y0, x1, y1 } : null;
}

/** 统计区域非白像素比例。 */
function nonWhiteRatio(
  image: PNG,
  box: { x0: number; y0: number; x1: number; y1: number },
): number {
  let count = 0;
  const total = (box.x1 - box.x0) * (box.y1 - box.y0);
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const index = (y * image.width + x) * 4;
      const r = image.data[index] ?? 255;
      const g = image.data[index + 1] ?? 255;
      const b = image.data[index + 2] ?? 255;
      if (Math.max(255 - r, 255 - g, 255 - b) > 20) count += 1;
    }
  }
  return count / total;
}

describe('y Composite 图片', () => {
  it('p1 建筑照片与 p3 蓝色架构图恢复绘制', async () => {
    const sample = fileURLToPath(
      new URL('../../../../ofd_pdf_match/y.ofd', import.meta.url),
    );
    const result = await renderOfdSample(sample, { dpi: 96, pages: [1, 3] });
    expect(result.status).toBe('ok');
    expect(result.pages).toHaveLength(2);

    const p1 = PNG.sync.read(Buffer.from(result.pages[0]!.png));
    expect(p1.width).toBe(772);
    expect(p1.height).toBe(998);
    // 建筑照片区域：旧实现无图时只剩稀疏文字，非白覆盖率很低。
    expect(nonWhiteRatio(p1, { x0: 240, y0: 550, x1: 535, y1: 780 })).toBeGreaterThan(0.6);

    const p3 = PNG.sync.read(Buffer.from(result.pages[1]!.png));
    expect(p3.width).toBe(772);
    expect(p3.height).toBe(998);
    // 蓝色架构图整块区域；旧实现只有文字，蓝色像素接近 0。
    // 引擎/PDF 参考 bbox 分别 448×265 / 449×266，位置同为 (45,183)。
    const blue = blueStats(p3, { x0: 30, y0: 180, x1: 650, y1: 600 });
    expect(blue).not.toBeNull();
    expect(blue!.count).toBeGreaterThan(15000);
    expect(Math.abs(blue!.x0 - 45)).toBeLessThanOrEqual(2);
    expect(Math.abs(blue!.y0 - 183)).toBeLessThanOrEqual(2);
    expect(Math.abs(blue!.x1 - 493)).toBeLessThanOrEqual(2);
    expect(Math.abs(blue!.y1 - 448)).toBeLessThanOrEqual(2);
  });
});
