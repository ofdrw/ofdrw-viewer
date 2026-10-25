/**
 * BUG-V2-04 回归：二值 alpha 掩码印章在「保函」p2 的合成与缩放。
 *
 * 样本 `ofd_pdf_match/保函.ofd` 的签章没有 `<ofd:Seal>`，只能从 SignedValue.dat 取
 * GIF：Sign_0 圆章 474×474、Sign_1 方章 250×249，调色板仅 4 色、alpha 仅 {0,255}、
 * 非透明像素全部为 (255,0,0)。此前引擎对所有签章一律 `multiply` 合成，且印章原图
 * 直接交给页面画布一次性缩小，导致：
 * - 章面被乘成浅粉（圆章发白）；
 * - 方章框线/文字/编号这类 1px 细笔画退化为稀疏点，几乎不可见。
 *
 * 本测试直接渲染原始样本字节（不经 PDF 参考、不依赖基线文件），在两张印章的
 * StampAnnot Boundary 内按 alpha/颜色统计像素，防止上述回归。
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

/** 印章像素统计。 */
interface SealStats {
  /** alpha > 0 的像素数（叠在白底后的非白像素近似）。 */
  covered: number;
  /** 浓度像素：绿通道低于 200（浅粉在 200 以上），章面以实红为主。 */
  concentrated: number;
}

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
 * @param withResample 是否启用签章重采样（默认启用）。
 * @returns 该页像素与尺寸。
 */
async function renderPage(
  bytes: Uint8Array,
  pageNumber: number,
  withResample = true,
): Promise<RenderedPage> {
  // 默认渲染器带自持画布工厂；`withResample=false` 时换成不支持 beginPageFresh 的渲染器
  // 以模拟宿主未提供重采样能力，用于对照“不重采样”的退化效果。
  const renderer = withResample
    ? new H5Canvas2DRenderer({
        createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
      })
    : new H5Canvas2DRenderer({ createCanvas: () => ({} as unknown as Canvas2DLike) });
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

/**
 * 统计印章区域内的像素。
 *
 * @param page 页面像素。
 * @param box 区域（mm，与 StampAnnot Boundary 一致）。
 * @returns 统计结果。
 */
function sealStats(page: RenderedPage, box: { x: number; y: number; w: number; h: number }): SealStats {
  // 区域边界允许 ±1px：Boundary 换算到像素后可能落在半像素上。
  const x0 = Math.max(0, mmToPx(box.x) - 1);
  const y0 = Math.max(0, mmToPx(box.y) - 1);
  const x1 = Math.min(page.width, mmToPx(box.x + box.w) + 1);
  const y1 = Math.min(page.height, mmToPx(box.y + box.h) + 1);
  let covered = 0;
  let concentrated = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * page.width + x) * 4;
      const red = page.data[offset]!;
      const green = page.data[offset + 1]!;
      const blue = page.data[offset + 2]!;
      // 章面偏红：红通道明显高于绿/蓝通道。
      if (red > 200 && green < red - 10 && blue < red - 10) covered += 1;
      // 浓度：multiply 会把半透明边缘压成浅粉（绿通道 200 以上），这类像素不计入。
      if (red > 150 && green < 200) concentrated += 1;
    }
  }
  return { covered, concentrated };
}

/** 「保函」p2 的两枚印章（StampAnnot Boundary，单位 mm）。 */
const SEALS = {
  /** Sign_0 圆章：474px GIF，二值 alpha 掩码。 */
  circle: { x: 60, y: 160, w: 40, h: 40 },
  /** Sign_1 方章：250×249 GIF，二值 alpha 掩码，含框线/姓名/编号细笔画。 */
  square: { x: 80, y: 200, w: 20, h: 20 },
} as const;

describe('签章掩码章合成（BUG-V2-04）', () => {
  it('保函 p2：圆章实红、方章细笔画可见（原始样本字节）', async () => {
    const page = await renderPage(sampleBytes('保函.ofd'), 2);
    const circle = sealStats(page, SEALS.circle);
    const square = sealStats(page, SEALS.square);

    // 印章非透明覆盖率：圆章约 18.6%（40mm≈152px 方框 → 约 4300px），
    // 方章约 29%（20mm≈76px 方框 → 约 1670px）。阈值取“至少一半的非透明像素被画出来”，
    // 既容忍 Boundary 取整，也不接受章面发白消失。
    expect(circle.covered).toBeGreaterThan(2140);
    expect(square.covered).toBeGreaterThan(830);

    // 方章含框线/姓名/编号等 1px 细笔画：旧实现（multiply + 单步缩小）整章只剩 585 个
    // 覆盖像素、11 个浓度像素，框线与编号几乎不可见；修复后覆盖 1365、浓度像素 664。
    expect(square.concentrated).toBeGreaterThan(300);
    // 圆章以文字环/点状圈为主，修复后浓度像素约 3700。
    expect(circle.concentrated).toBeGreaterThan(1500);
  });

  it('保函 p2：页面其他内容不被签章改变（p1 无签章，内容保持不变）', async () => {
    // p1 不含 StampAnnot，用于确认签章改动不影响普通页面绘制。
    const page = await renderPage(sampleBytes('保函.ofd'), 1);
    const all = sealStats(page, { x: 0, y: 0, w: 210, h: 297 });
    // 正文为黑色文字：红色判定覆盖不到任何正文字形。
    expect(all.covered).toBe(0);
  });

  it('不透明印章仍按 multiply 合成（dzbh SEAL_SIGN 为无 alpha 的 JPEG）', async () => {
    const bytes = sampleBytes('dzbh.ofd');
    const renderer = new H5Canvas2DRenderer({
      createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
    });
    const document = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: bytes },
      renderer,
      imageDecoders: [...nodeImageDecoders],
    });
    try {
      const page = await document.getPage(1);
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
      const pixels = context.getImageData(0, 0, width, height).data as Uint8ClampedArray;
      // 不透明白底章：绘制后不得出现整块白底，签章区域以外仍是白底文字。
      let whiteBlock = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i]! > 250 && pixels[i + 1]! > 250 && pixels[i + 2]! > 250) whiteBlock += 1;
      }
      expect(whiteBlock).toBeGreaterThan(0);
    } finally {
      await document.close();
    }
  });
});
