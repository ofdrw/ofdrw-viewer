/**
 * PNG 读写与图像分析（内容 bbox、抗锯齿边缘、主色）。
 *
 * 像素数据统一为 RGBA8、行优先；坐标为左上原点、y 向下（与 Canvas 一致）。
 * 图片尺寸单位均为像素（device px）。
 */

import { PNG } from 'pngjs';
import type { BBoxPx, ImageLike } from './types';

/**
 * 解码 PNG。
 *
 * @param input PNG 字节。
 * @returns RGBA8 图像。
 * @throws 当 PNG 非法时抛出。
 */
export function decodePng(input: Uint8Array): ImageLike {
  const png = PNG.sync.read(Buffer.from(input));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data),
  };
}

/**
 * 编码 PNG。
 *
 * @param image RGBA8 图像。
 * @returns PNG 字节。
 */
export function encodePng(image: ImageLike): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return new Uint8Array(PNG.sync.write(png));
}

/**
 * 复制图像。
 *
 * @param image 源图像。
 * @returns 深拷贝。
 */
export function cloneImage(image: ImageLike): ImageLike {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}

/**
 * 按白底合成（alpha 混合到不透明白色）。
 *
 * 黄金图 harness 约定：引擎不负责背景，测试侧先填白底；PDF 参考图本身为白底。
 * 该函数把透明背景统一成白色，避免“透明 vs 白”被误判为差异。
 *
 * @param image 图像。
 * @returns 不透明白底图像。
 */
export function flattenOnWhite(image: ImageLike): ImageLike {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < image.width * image.height; i += 1) {
    const offset = i * 4;
    const a = image.data[offset + 3]! / 255;
    const inv = 1 - a;
    out[offset] = Math.round(image.data[offset]! * a + 255 * inv);
    out[offset + 1] = Math.round(image.data[offset + 1]! * a + 255 * inv);
    out[offset + 2] = Math.round(image.data[offset + 2]! * a + 255 * inv);
    out[offset + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * 裁剪图像；越界部分填透明黑。
 *
 * @param image 源图像。
 * @param x 左上角 x，像素。
 * @param y 左上角 y，像素。
 * @param width 宽度，像素。
 * @param height 高度，像素。
 * @returns 裁剪结果。
 */
export function cropImage(image: ImageLike, x: number, y: number, width: number, height: number): ImageLike {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const srcY = y + row;
    if (srcY < 0 || srcY >= image.height) continue;
    const copyStart = Math.max(0, -x);
    const copyEnd = Math.min(width, image.width - x);
    if (copyEnd <= copyStart) continue;
    const srcOffset = (srcY * image.width + (x + copyStart)) * 4;
    const dstOffset = (row * width + copyStart) * 4;
    out.set(image.data.subarray(srcOffset, srcOffset + (copyEnd - copyStart) * 4), dstOffset);
  }
  return { width, height, data: out };
}

/**
 * 转灰度（Rec.601 亮度，0..255）。
 *
 * @param image 图像。
 * @returns 灰度数组，长度 = width × height。
 */
export function toGrayscale(image: ImageLike): Uint8Array {
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i += 1) {
    const offset = i * 4;
    const a = image.data[offset + 3]!;
    // 透明像素按白底合成，避免 alpha 边缘形成假轮廓。
    const r = (image.data[offset]! * a + 255 * (255 - a)) / 255;
    const g = (image.data[offset + 1]! * a + 255 * (255 - a)) / 255;
    const b = (image.data[offset + 2]! * a + 255 * (255 - a)) / 255;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return gray;
}

/**
 * 计算内容掩码：alpha 足够且与白色的通道差超过阈值。
 *
 * @param image 图像。
 * @param minAlpha 最小 alpha（0..255）。
 * @param backgroundDistance 与白色的最大通道差阈值（0..255）。
 * @returns 掩码，1 表示内容。
 */
export function computeContentMask(
  image: ImageLike,
  minAlpha = 8,
  backgroundDistance = 8,
): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i += 1) {
    const offset = i * 4;
    const r = image.data[offset]!;
    const g = image.data[offset + 1]!;
    const b = image.data[offset + 2]!;
    const a = image.data[offset + 3]!;
    if (a < minAlpha) continue;
    const distance = Math.max(255 - r, 255 - g, 255 - b);
    if (distance > backgroundDistance) mask[i] = 1;
  }
  return mask;
}

/**
 * 计算抗锯齿边缘掩码（Sobel 梯度 + 1 像素膨胀）。
 *
 * @param gray 灰度数组。
 * @param width 宽，像素。
 * @param height 高，像素。
 * @param threshold 梯度阈值（0..255）。
 * @returns 掩码，1 表示边缘/边缘邻域。
 */
export function computeEdgeMask(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): Uint8Array {
  const raw = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = gray[i - width - 1]!;
      const tc = gray[i - width]!;
      const tr = gray[i - width + 1]!;
      const ml = gray[i - 1]!;
      const mr = gray[i + 1]!;
      const bl = gray[i + width - 1]!;
      const bc = gray[i + width]!;
      const br = gray[i + width + 1]!;
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      if (Math.abs(gx) + Math.abs(gy) > threshold) raw[i] = 1;
    }
  }
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (raw[i] === 0) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          dilated[ny * width + nx] = 1;
        }
      }
    }
  }
  return dilated;
}

/**
 * 计算掩码的内容 bbox。
 *
 * @param mask 掩码。
 * @param width 宽，像素。
 * @param height 高，像素。
 * @returns bbox；无内容时返回 null。
 */
export function computeBBox(mask: Uint8Array, width: number, height: number): BBoxPx | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 统计掩码中 1 的数量。
 *
 * @param mask 掩码。
 * @returns 数量。
 */
export function countMask(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i]!;
  return count;
}

/** 主色条目。 */
export interface DominantColor {
  /** 量化后的代表色。 */
  rgb: { r: number; g: number; b: number };
  /** 在内容像素中的占比，0..1。 */
  ratio: number;
}

/**
 * 计算主色（每通道 5 位量化，取前 N）。
 *
 * @param image 图像。
 * @param contentMask 内容掩码。
 * @param limit 最多返回数量，默认 5。
 * @param minRatio 最小占比，默认 0.001。
 * @returns 按占比降序的主色。
 */
export function dominantColors(
  image: ImageLike,
  contentMask: Uint8Array,
  limit = 5,
  minRatio = 0.001,
): DominantColor[] {
  const counts = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < contentMask.length; i += 1) {
    if (contentMask[i] === 0) continue;
    const offset = i * 4;
    const a = image.data[offset + 3]!;
    if (a < 200) continue;
    const r = image.data[offset]!;
    const g = image.data[offset + 1]!;
    const b = image.data[offset + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return [];
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const colors: DominantColor[] = [];
  for (const [key, count] of sorted) {
    const ratio = count / total;
    if (ratio < minRatio) continue;
    const r = Math.min(255, ((key >> 10) & 0x1f) * 8 + 4);
    const g = Math.min(255, ((key >> 5) & 0x1f) * 8 + 4);
    const b = Math.min(255, (key & 0x1f) * 8 + 4);
    colors.push({ rgb: { r, g, b }, ratio });
  }
  return colors;
}

/**
 * 计算两张图的全局 SSIM（灰度，辅助指标）。
 *
 * @param grayA 灰度图 A。
 * @param grayB 灰度图 B。
 * @returns SSIM，-1..1；1 表示完全一致。
 */
export function globalSsim(grayA: Uint8Array, grayB: Uint8Array): number {
  if (grayA.length !== grayB.length || grayA.length === 0) return 0;
  const n = grayA.length;
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  for (let i = 0; i < n; i += 1) {
    const a = grayA[i]!;
    const b = grayB[i]!;
    sumA += a;
    sumB += b;
    sumAA += a * a;
    sumBB += b * b;
    sumAB += a * b;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  const varA = sumAA / n - meanA * meanA;
  const varB = sumBB / n - meanB * meanB;
  const cov = sumAB / n - meanA * meanB;
  const c1 = Math.pow(0.01 * 255, 2);
  const c2 = Math.pow(0.03 * 255, 2);
  return ((2 * meanA * meanB + c1) * (2 * cov + c2)) / ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
}