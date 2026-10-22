/**
 * T14h 发票监制章 Composite 红章回归：右下章 bbox 必须与 PDF 参考对齐。
 *
 * PDF 参考由 pdftoppm 以 96 DPI 渲染；本测试读取同一 OFD 样本并测量红像素
 * bbox，容差仅用于抗锯齿边缘（≤3px），不修改样本、参考图或全局阈值。
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderOfdSample } from '../golden/lib/engine';
import { computeBBox, computeContentMask, decodePng } from '../golden/lib/image';

/** 红像素 bbox（像素）。 */
interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 在指定像素窗口内计算红色内容的 bbox。 */
function redBox(
  image: PNG,
  region: { x0: number; y0: number; x1: number; y1: number },
): PixelBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      const index = (y * image.width + x) * 4;
      const r = image.data[index] ?? 0;
      const g = image.data[index + 1] ?? 0;
      const b = image.data[index + 2] ?? 0;
      if (r > 120 && r > g * 1.5 && r > b * 1.5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) throw new Error('指定区域没有红像素');
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 断言 bbox 的每个边界在期望值 ±tolerance 内。 */
function expectBoxClose(actual: PixelBox, expected: PixelBox, tolerance: number): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.x + actual.w - (expected.x + expected.w))).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y + actual.h - (expected.y + expected.h))).toBeLessThanOrEqual(tolerance);
}

describe('发票监制章 Composite 红章', () => {
  it('右下红章 bbox 对齐 PDF 参考，左上章保持不变', async () => {
    const sample = fileURLToPath(
      new URL('../../../../ofd_pdf_match/发票监制章-数科.ofd', import.meta.url),
    );
    const result = await renderOfdSample(sample, { dpi: 96, pages: [1] });
    expect(result.status).toBe('ok');
    const page = result.pages[0]!;
    expect(page.width).toBe(813);
    expect(page.height).toBe(526);
    const image = PNG.sync.read(Buffer.from(page.png));

    // 与 t39/golden 同口径：整页非白内容 bbox 的右边界应由右下红章决定。
    const contentImage = decodePng(page.png);
    const contentBox = computeBBox(computeContentMask(contentImage), contentImage.width, contentImage.height, 4);
    expect(contentBox).not.toBeNull();
    const mm = 25.4 / 96;
    expect(contentBox!.x * mm).toBeCloseTo(3.96875, 0);
    expect(contentBox!.y * mm).toBeCloseTo(4.4979166667, 0);
    expect(contentBox!.width * mm).toBeCloseTo(203.2, 0);
    expect(contentBox!.height * mm).toBeCloseTo(130.4395833333, 0);

    // PDF 参考（96 DPI）红章 bbox：右下 640,404,143,106；左上 186,118,95,57。
    const right = redBox(image, { x0: 600, y0: 350, x1: image.width, y1: image.height });
    const left = redBox(image, { x0: 100, y0: 80, x1: 350, y1: 250 });
    expectBoxClose(right, { x: 640, y: 404, w: 143, h: 106 }, 3);
    expectBoxClose(left, { x: 186, y: 118, w: 95, h: 57 }, 2);
  });
});
