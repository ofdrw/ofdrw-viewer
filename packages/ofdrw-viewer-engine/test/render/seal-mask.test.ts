/**
 * 签章掩码章渲染回归：签章图片的合成与缩放链路。
 *
 * 用 `ofd_pdf_match/dzbh.ofd` 的渐变 alpha 印章验证章被实际绘制、白底不遮正文。
 *
 * 测试只使用原始样本字节，不依赖 PDF 参考或基线文件。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer, OFDDocument, getPageViewport } from '@ofdrw/ofdrw-viewer-engine';
import type { Canvas2DLike, CanvasRenderingContext2DLike } from '@ofdrw/ofdrw-viewer-engine';
import { nodeImageDecoders } from '../helpers/node-image-decoder';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_ROOT = resolve(HERE, '../../../../ofd_pdf_match');

/** 输出精度，与本包黄金图一致。 */
const DPI = 96;

/** 页面尺寸与页渲染结果。 */
interface RenderedPage {
  /** 画布宽，像素。 */
  width: number;
  /** 画布高，像素。 */
  height: number;
  /** RGBA 像素。 */
  data: Uint8ClampedArray;
}

/**
 * 读取样本文件字节。
 *
 * @param name 样本文件名（相对 `ofd_pdf_match/`）。
 * @returns 文件字节。
 */
function sampleBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(SAMPLE_ROOT, name)));
}

/**
 * 渲染 OFD 的指定页（白底，与黄金图 harness 一致）。
 *
 * @param bytes OFD 文件字节。
 * @param pageNumber 页号，1 起。
 * @returns 该页像素与尺寸。
 */
async function renderPage(bytes: Uint8Array, pageNumber: number): Promise<RenderedPage> {
  const renderer = new H5Canvas2DRenderer({
    createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
  });
  const document = await OFDDocument.open({
    source: { kind: 'arraybuffer', data: bytes },
    renderer,
    imageDecoders: [...nodeImageDecoders],
  });
  try {
    const page = await document.getPage(pageNumber - 1);
    const viewport = getPageViewport(page.getSize(), { dpi: DPI });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2DLike,
      viewport: { width, height, dpi: DPI },
    }).promise;
    const image = context.getImageData(0, 0, width, height);
    return { width, height, data: new Uint8ClampedArray(image.data) };
  } finally {
    await document.close();
  }
}

/**
 * 把毫米转换为像素（按 DPI 四舍五入）。
 *
 * @param mm 长度，单位 mm。
 * @returns 像素数。
 */
function mmToPx(mm: number): number {
  return Math.round((mm / 25.4) * DPI);
}

describe('签章掩码章渲染（BUG-V2-04）', () => {
  it('dzbh 不透明白底章：章确实画出且白底不遮文字', async () => {
    const page = await renderPage(sampleBytes('dzbh.ofd'), 1);
    // Sign_2 的 StampAnnot 在 PageRef=1（第 1 页），Boundary 150,250,40×29 mm。
    const seal = { x: 150, y: 250, w: 40, h: 29 };
    const x0 = mmToPx(seal.x);
    const y0 = mmToPx(seal.y);
    const x1 = Math.min(page.width, mmToPx(seal.x + seal.w));
    const y1 = Math.min(page.height, mmToPx(seal.y + seal.h));

    // 先断言“章确实画了”：该区域不能是纯白，必须有大量非白像素。
    let nonWhite = 0;
    let dark = 0;
    let mid = 0;
    let total = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * page.width + x) * 4;
        const red = page.data[offset]!;
        const green = page.data[offset + 1]!;
        const blue = page.data[offset + 2]!;
        total += 1;
        if (!(red > 250 && green > 250 && blue > 250)) nonWhite += 1;
        const luminance = (red + green + blue) / 3;
        if (luminance < 100) dark += 1;
        else if (luminance < 200) mid += 1;
      }
    }
    // 实测章区约 16459 像素、非白 13535；若印章未被绘制（image 丢失或合成被跳过），
    // 该区域几乎全白，此断言即失败。
    expect(total).toBeGreaterThan(10000);
    expect(nonWhite).toBeGreaterThan(total * 0.3);

    // 再断言章区内存在正文墨迹（防止该章把下方内容整体遮盖）。
    // 注意：本样本的印章是非二值的渐变 alpha 章，实测强制 multiply 后章区
    // 「深色 + 中间调」计数一字不变（534 + 3047），因此这条断言**测不出合成模式
    // 回退**。这里只作为一种更粗糙的保护：一旦章未绘制或被整块纯白覆盖，计数会大幅跌落。
    expect(dark + mid).toBeGreaterThan(1500);
  });
});
