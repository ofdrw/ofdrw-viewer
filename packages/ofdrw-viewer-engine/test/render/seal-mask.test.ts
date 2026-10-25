/**
 * BUG-V2-04 回归：二值 alpha 掩码印章在「保函」p2 的渲染。
 *
 * 样本 `ofd_pdf_match/保函.ofd` 的签章没有 `<ofd:Seal>`，只能从 SignedValue.dat 取
 * GIF：Sign_0 圆章 474×474、Sign_1 方章 250×249，调色板仅 4 色、alpha 仅 {0,255}、
 * 非透明像素全部为 (255,0,0)。
 *
 * 本 BUG 的根因是 GIF LZW 解码器把字典 `first[]` 写错（见 `image/gif.ts`），
 * 解码出的颜色索引整体错位，印章变成随机噪声：Sign_1 的 alpha=255 像素从正确的
 * 18003 掉到 2640，页面上方章只剩淡粉鬼影、框线与编号完全消失。
 *
 * 因此本测试分两层：
 * 1. 解码层：直接断言两枚印章 GIF 的不透明像素数，锁定 LZW 根因（回退即失败）；
 * 2. 渲染层：渲染原始样本字节，在 StampAnnot Boundary 内统计章面像素，防止合成模式
 *    与缩放链路回归。
 *
 * 测试只使用原始样本字节，不依赖 PDF 参考或基线文件。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer, OFDDocument, getPageViewport } from '@ofdrw/ofdrw-viewer-engine';
import type { Canvas2DLike, CanvasRenderingContext2DLike } from '@ofdrw/ofdrw-viewer-engine';
import { decodeGif } from '../../src/image/gif';
import { nodeImageDecoders } from '../helpers/node-image-decoder';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_ROOT = resolve(HERE, '../../../../ofd_pdf_match');

/** 输出精度，与本包黄金图一致。 */
const DPI = 96;

/** 「保函」p2 的两枚印章（StampAnnot Boundary，单位 mm）。 */
const SEALS = {
  /** Sign_0 圆章：474×474 GIF，二值 alpha 掩码。 */
  circle: { x: 60, y: 160, w: 40, h: 40 },
  /** Sign_1 方章：250×249 GIF，二值 alpha 掩码，含框线/姓名/编号细笔画。 */
  square: { x: 80, y: 200, w: 20, h: 20 },
} as const;

/**
 * 两枚印章 GIF 的基准不透明像素数。
 *
 * 由 PIL 对 `保函.ofd` 内嵌 GIF 独立解码得到（Sign_0 41891 / Sign_1 18003），
 * 作为 LZW 解码正确性的权威基准。
 */
const SEAL_OPAQUE = [
  { tag: 'Sign_0 圆章', file: 'Doc_0/Signs/Sign_0/SignedValue.dat', size: 474, opaque: 41891 },
  { tag: 'Sign_1 方章', file: 'Doc_0/Signs/Sign_1/SignedValue.dat', size: 250, opaque: 18003 },
] as const;

/** 印章像素统计。 */
interface SealStats {
  /** 章面红像素数（叠在白底后偏红）。 */
  covered: number;
  /** 浓度像素：红通道高且绿通道低，排除被 multiply 压成的浅粉。 */
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
 * 从 OFD 包内取出某条目的字节。
 *
 * @param bytes OFD 文件字节。
 * @param path 包内条目路径。
 * @returns 条目字节。
 */
function packageEntry(bytes: Uint8Array, path: string): Uint8Array {
  const entries = unzipSync(bytes);
  const entry = entries[path];
  if (!entry) throw new Error(`包内缺少条目 ${path}`);
  return entry;
}

/**
 * 在字节中定位 GIF 文件头并截取到末尾。
 *
 * @param bytes 包含内嵌图片的字节。
 * @returns 以 GIF 文件头开始的字节切片。
 */
function sliceGif(bytes: Uint8Array): Uint8Array {
  const start = Buffer.from(bytes).indexOf(Buffer.from('GIF89a'));
  if (start < 0) throw new Error('未找到 GIF89a 文件头');
  return bytes.subarray(start);
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

/**
 * 统计一片矩形区域内的近黑像素数（用于版面内容断言）。
 *
 * @param page 页面像素。
 * @param x0 左边界，像素。
 * @param y0 上边界，像素。
 * @param x1 右边界，像素。
 * @param y1 下边界，像素。
 * @returns 近黑像素数。
 */
function darkPixels(page: RenderedPage, x0: number, y0: number, x1: number, y1: number): number {
  let count = 0;
  for (let y = Math.max(0, y0); y < Math.min(page.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(page.width, x1); x += 1) {
      const offset = (y * page.width + x) * 4;
      if (page.data[offset]! < 100 && page.data[offset + 1]! < 100 && page.data[offset + 2]! < 100) {
        count += 1;
      }
    }
  }
  return count;
}

describe('签章 GIF 解码（BUG-V2-04 根因）', () => {
  for (const seal of SEAL_OPAQUE) {
    it(`保函 ${seal.tag}：LZW 解码后不透明像素应为 ${seal.opaque}`, async () => {
      const bytes = sampleBytes('保函.ofd');
      const gif = sliceGif(packageEntry(bytes, seal.file));
      const decoded = await decodeGif(gif, { onWarning: () => {} });
      // DecodedImage.data 为嵌套的 ImageData 结构。
      const pixels = (decoded.data as { data: Uint8ClampedArray }).data;
      let opaque = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] === 255) opaque += 1;
      }
      expect(decoded.width).toBe(seal.size);
      // LZW 字典 first[] 写错时该值会掉到约 2640（Sign_1），整枚印章变成噪声。
      expect(opaque).toBe(seal.opaque);
    });
  }
});

describe('签章掩码章渲染（BUG-V2-04）', () => {
  it('保函 p2：圆章实红、方章细笔画可见（原始样本字节）', async () => {
    const page = await renderPage(sampleBytes('保函.ofd'), 2);
    const circle = sealStats(page, SEALS.circle);
    const square = sealStats(page, SEALS.square);

    // 印章非透明覆盖率：圆章约 18.6%（40mm≈152px 方框 → 约 4300px），
    // 方章约 29%（20mm≈76px 方框 → 约 1670px）。阈值取“至少一半的非透明像素被画出来”，
    // 既容忍 Boundary 取整，也不接受章面发白消失。
    expect(circle.covered).toBeGreaterThan(2140);
    expect(square.covered).toBeGreaterThan(830);

    // 方章含框线/姓名/编号等细笔画：LZW 解码错误时整章只剩 585 个覆盖像素、
    // 少量浓度像素，框线与编号几乎不可见。
    expect(square.concentrated).toBeGreaterThan(300);
    // 圆章以文字环/点状圈为主，修复后浓度像素约 3700。
    expect(circle.concentrated).toBeGreaterThan(1500);
  });

  it('保函 p2：方章边框与编号行可见（绝对行号，排除整章发白）', async () => {
    const page = await renderPage(sampleBytes('保函.ofd'), 2);
    // 方章 Boundary 20mm 高，落在 96dpi 下约 76px；框线位于方框上下边缘，
    // 编号位于方框下部。用绝对行统计章面红像素，避免相对行号在网格取整后漂移。
    const x0 = mmToPx(SEALS.square.x);
    const x1 = mmToPx(SEALS.square.x + SEALS.square.w);
    const yTop = mmToPx(SEALS.square.y);
    const yBottom = mmToPx(SEALS.square.y + SEALS.square.h);

    /**
     * 统计指定行区间内的章面红像素。
     *
     * @param from 起始行（含），像素。
     * @param to 结束行（不含），像素。
     * @returns 红像素数。
     */
    const redInRows = (from: number, to: number): number => {
      let count = 0;
      for (let y = from; y < to; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * page.width + x) * 4;
          const red = page.data[offset]!;
          const green = page.data[offset + 1]!;
          if (red > 180 && green < 160) count += 1;
        }
      }
      return count;
    };

    // 顶部框线：章框上沿 3 行必须有连续墨迹。
    const topBorder = redInRows(yTop, yTop + 3);
    // 编号行：位于方框下部约 3/4 处。
    const numberRow = redInRows(yTop + Math.round((yBottom - yTop) * 0.78), yBottom - 2);

    // LZW 解码错误时这两处几乎无墨；正常渲染时各有数十以上像素。
    expect(topBorder).toBeGreaterThan(30);
    expect(numberRow).toBeGreaterThan(30);
  });

  it('掩码章必须用 source-over：章面平均绿通道不得被 multiply 抬高', async () => {
    const page = await renderPage(sampleBytes('保函.ofd'), 2);

    /**
     * 统计印章区域章面像素的平均绿通道。
     *
     * 二值 alpha 掩码章的非透明像素是纯红 (255,0,0)：source-over 叠在白底上得到
     * 饱和度高的实红，平均绿通道低；multiply 会把白底与半透明边缘相乘，章面整体
     * 变浅、平均绿通道升高。因此用 avgG 而非像素计数作为判据（计数差异仅约 1~5%）。
     *
     * @param box 区域（mm，与 StampAnnot Boundary 一致）。
     * @returns 章面像素数与平均绿通道；无章面像素时 avgGreen 为 NaN。
     */
    const faceStats = (box: { x: number; y: number; w: number; h: number }) => {
      let count = 0;
      let sumGreen = 0;
      for (let y = mmToPx(box.y) - 1; y < mmToPx(box.y + box.h) + 1; y += 1) {
        for (let x = mmToPx(box.x) - 1; x < mmToPx(box.x + box.w) + 1; x += 1) {
          const offset = (y * page.width + x) * 4;
          const red = page.data[offset]!;
          const green = page.data[offset + 1]!;
          const blue = page.data[offset + 2]!;
          if (red > 200 && green < red - 10 && blue < red - 10) {
            count += 1;
            sumGreen += green;
          }
        }
      }
      return { count, avgGreen: count > 0 ? sumGreen / count : Number.NaN };
    };

    const circle = faceStats(SEALS.circle);
    const square = faceStats(SEALS.square);
    const all = faceStats({ x: SEALS.circle.x, y: SEALS.circle.y, w: 40, h: 40 });

    // 实测（96dpi）：
    //   source-over：合并 avgG 93.95、圆章 90.74、方章 101.64
    //   强制 multiply：合并 avgG 95.61、圆章 91.68、方章 105.44
    // 三组数值均不重叠，阈值取中间值：合并 94.5、圆章 91.2。
    let combinedCount = 0;
    let combinedSum = 0;
    for (const stat of [circle, square]) {
      if (Number.isNaN(stat.avgGreen)) continue;
      combinedCount += stat.count;
      combinedSum += stat.avgGreen * stat.count;
    }
    const combinedAvgGreen = combinedSum / Math.max(1, combinedCount);

    // 章面必须被画出来（排除整章丢失）。
    expect(combinedCount).toBeGreaterThan(3000);
    // multiply 会把章面整体抬浅：合并平均绿通道必须低于阈值。
    expect(combinedAvgGreen).toBeLessThan(94.5);
    // 圆章单独再卡一道：它是最大的样本，最稳定（两岸 90.74 / 91.68）。
    expect(circle.avgGreen).toBeLessThan(91.2);
    expect(all.count).toBeGreaterThan(2000);
  });

  it('保函 p1 不含签章：版面内容不受签章逻辑影响', async () => {
    const page = await renderPage(sampleBytes('保函.ofd'), 1);
    // 正文行区域应有大量近黑文字像素；红色判定不应命中任何正文。
    const text = darkPixels(page, 0, mmToPx(20), page.width, mmToPx(60));
    expect(text).toBeGreaterThan(500);
    const red = sealStats(page, { x: 0, y: 0, w: 210, h: 297 });
    expect(red.covered).toBe(0);
  });

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

    // 再断言“白底不遮字”：不透明白底章走 multiply，白底与页面底色融合，
    // 章区内的正文墨迹仍应可见。若误用 source-over，白底会把章区文字整片盖成纯白。
    // 章区亮度分布实测：dark(<100) 534、mid(<200) 3047、light 6871、white 6007。
    // 取“深色 + 中间调”合计为墨迹证据，阈值 1500 留出足够余量，
    // 但一旦白底被 source-over 铺成纯白，该计数会大幅跌落。
    expect(dark + mid).toBeGreaterThan(1500);
  });
});
