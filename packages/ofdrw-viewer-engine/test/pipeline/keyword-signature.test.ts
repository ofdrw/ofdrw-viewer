/**
 * T14f keyword 签章白底回归：Seal 全不透明白底必须 multiply，不能遮盖表格文字。
 *
 * 真实 keyword.ofd 的 StampAnnot 为 90,110,42,42mm；区域内的纯白像素应消失，
 * 背景变为页面底色（cream），红色印章与下方黑色文字仍可见。
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderOfdSample } from '../golden/lib/engine';

describe('keyword 签章白底 multiply', () => {
  it('红章可见、白底不遮字、下方文字仍显示', async () => {
    const sample = fileURLToPath(
      new URL('../../../../ofd_pdf_match/keyword.ofd', import.meta.url),
    );
    const result = await renderOfdSample(sample, { dpi: 96, pages: [1] });
    expect(result.status).toBe('ok');
    const page = result.pages[0]!;
    expect(page.width).toBe(1070);
    expect(page.height).toBe(741);
    const image = PNG.sync.read(Buffer.from(page.png));

    // StampAnnot Boundary=90 110 42 42mm，96 DPI 下的像素框。
    const scale = 96 / 25.4;
    const x0 = Math.round(90 * scale);
    const y0 = Math.round(110 * scale);
    const x1 = Math.round(132 * scale);
    const y1 = Math.round(152 * scale);
    let red = 0;
    let dark = 0;
    let cream = 0;
    let pureWhite = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = (y * image.width + x) * 4;
        const r = image.data[index] ?? 0;
        const g = image.data[index + 1] ?? 0;
        const b = image.data[index + 2] ?? 0;
        if (r > 150 && r > g * 1.5 && r > b * 1.5) red += 1;
        if (r < 100 && g < 100 && b < 100) dark += 1;
        if (r > 245 && g > 230 && g < 250 && b > 215 && b < 240) cream += 1;
        if (r > 250 && g > 250 && b > 250) pureWhite += 1;
      }
    }

    expect(red).toBeGreaterThan(1000);
    expect(dark).toBeGreaterThan(100);
    expect(cream).toBeGreaterThan(5000);
    expect(pureWhite).toBeLessThan(50);
  });
});
