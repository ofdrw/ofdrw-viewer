/**
 * T9d intro 图片回归：p12 高速公路照片不能空白，p25 设备图必须按 CTM 完整绘制。
 *
 * 两页均使用真实 OFD 与 96 DPI；断言直接读取渲染像素，不依赖 golden 阈值。
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderOfdSample } from '../golden/lib/engine';

/** 图片区域的非白像素 bbox（device px）。 */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 计算指定区域内亮度超过阈值的像素 bbox。 */
function brightBox(
  image: PNG,
  region: { x0: number; y0: number; x1: number; y1: number },
  threshold: number,
): Box | null {
  let box: Box | null = null;
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      const index = (y * image.width + x) * 4;
      const value = Math.max(
        image.data[index] ?? 0,
        image.data[index + 1] ?? 0,
        image.data[index + 2] ?? 0,
      );
      if (value <= threshold) continue;
      if (!box) box = { x0: x, y0: y, x1: x, y1: y };
      else {
        box.x0 = Math.min(box.x0, x);
        box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x);
        box.y1 = Math.max(box.y1, y);
      }
    }
  }
  return box;
}

describe('intro 图片 CTM/裁剪', () => {
  it('p12 高速公路照片铺满页面，p25 左侧设备图完整可见', async () => {
    const sample = fileURLToPath(
      new URL('../../../../ofd_pdf_match/intro-数科.ofd', import.meta.url),
    );
    const result = await renderOfdSample(sample, { dpi: 96, pages: [12, 25] });
    expect(result.status).toBe('ok');
    expect(result.pages).toHaveLength(2);

    const p12 = PNG.sync.read(Buffer.from(result.pages[0]!.png));
    let nonWhite = 0;
    for (let i = 0; i < p12.data.length; i += 4) {
      if (
        (p12.data[i] ?? 0) < 247 ||
        (p12.data[i + 1] ?? 0) < 247 ||
        (p12.data[i + 2] ?? 0) < 247
      ) {
        nonWhite += 1;
      }
    }
    // 照片覆盖整页；旧实现 Clips 在 CTM 后把图片裁掉，只剩 Trail Version 文字。
    expect(nonWhite / (p12.width * p12.height)).toBeGreaterThan(0.95);

    const p25 = PNG.sync.read(Buffer.from(result.pages[1]!.png));
    const device = brightBox(p25, { x0: 150, y0: 430, x1: 480, y1: 680 }, 45);
    expect(device).not.toBeNull();
    expect(device!.x0).toBeGreaterThanOrEqual(192);
    expect(device!.x0).toBeLessThanOrEqual(196);
    expect(device!.x1).toBeGreaterThanOrEqual(454);
    expect(device!.x1).toBeLessThanOrEqual(459);
    // PDF 参考亮区宽度 264px；引擎 263px，容差 3px。
    expect(device!.x1 - device!.x0 + 1).toBeGreaterThanOrEqual(260);
    expect(device!.x1 - device!.x0 + 1).toBeLessThanOrEqual(267);
    expect(device!.y1 - device!.y0 + 1).toBeGreaterThanOrEqual(90);
    expect(device!.y1 - device!.y0 + 1).toBeLessThanOrEqual(98);
  });
});
