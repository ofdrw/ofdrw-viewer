/**
 * T18a zsbk 背景回归：p1 模板背景图带 `Clips TransFlag=true`，必须完整绘制。
 *
 * 该标记表示裁剪区受外部对象 CTM 影响；单位正方形 Clips 在图片 CTM 之后
 * 覆盖整张背景图。缺省/false 时仍按标准对象空间（CTM 前）裁剪。
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderOfdSample } from '../golden/lib/engine';

/** 读取像素 RGB。 */
function pixel(image: PNG, x: number, y: number): [number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index] ?? 0, image.data[index + 1] ?? 0, image.data[index + 2] ?? 0];
}

describe('zsbk 模板背景', () => {
  it('p1 绘制浅色防伪底纹而非白底', async () => {
    const sample = fileURLToPath(
      new URL('../../../../ofd_pdf_match/zsbk.ofd', import.meta.url),
    );
    const result = await renderOfdSample(sample, { dpi: 96, pages: [1] });
    expect(result.status).toBe('ok');
    expect(result.pages).toHaveLength(1);

    const p1 = PNG.sync.read(Buffer.from(result.pages[0]!.png));
    expect(p1.width).toBe(1123);
    expect(p1.height).toBe(794);
    // 左侧空白背景区域：缺底纹时为纯白，模板底纹为浅米色。
    const background = pixel(p1, 500, 500);
    expect(background[0]).toBeLessThan(250);
    expect(background[2]).toBeLessThan(245);
    expect(background[0] - background[2]).toBeGreaterThan(2);
  });
});
