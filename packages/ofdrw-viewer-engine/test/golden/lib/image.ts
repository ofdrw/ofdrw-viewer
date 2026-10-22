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
 * @param minComponentPixels 连通域最小像素数；小于该值的孤立噪点不参与 bbox，默认 1。
 * @returns bbox；无内容时返回 null。
 */
export function computeBBox(
  mask: Uint8Array,
  width: number,
  height: number,
  minComponentPixels = 1,
): BBoxPx | null {
  const filtered =
    minComponentPixels > 1
      ? filterSmallComponents(mask, width, height, minComponentPixels)
      : mask;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (filtered[y * width + x] === 0) continue;
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
 * 过滤小于阈值的 4 邻接连通域，避免单像素噪点把内容 bbox 拉大到页边。
 *
 * @param mask 输入掩码。
 * @param width 宽，像素。
 * @param height 高，像素。
 * @param minPixels 保留连通域的最小像素数。
 * @returns 过滤后的掩码。
 */
function filterSmallComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minPixels: number,
): Uint8Array {
  const size = width * height;
  const visited = new Uint8Array(size);
  const output = new Uint8Array(size);
  const stack = new Int32Array(size);
  const component: number[] = [];
  for (let start = 0; start < size; start += 1) {
    if (mask[start] === 0 || visited[start] !== 0) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    component.length = 0;
    while (top > 0) {
      const index = stack[--top]!;
      component.push(index);
      const x = index % width;
      const y = (index / width) | 0;
      if (x > 0) {
        const next = index - 1;
        if (mask[next] !== 0 && visited[next] === 0) {
          visited[next] = 1;
          stack[top++] = next;
        }
      }
      if (x + 1 < width) {
        const next = index + 1;
        if (mask[next] !== 0 && visited[next] === 0) {
          visited[next] = 1;
          stack[top++] = next;
        }
      }
      if (y > 0) {
        const next = index - width;
        if (mask[next] !== 0 && visited[next] === 0) {
          visited[next] = 1;
          stack[top++] = next;
        }
      }
      if (y + 1 < height) {
        const next = index + width;
        if (mask[next] !== 0 && visited[next] === 0) {
          visited[next] = 1;
          stack[top++] = next;
        }
      }
    }
    if (component.length >= minPixels) {
      for (const index of component) output[index] = 1;
    }
  }
  return output;
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
/**
 * 按整页等比缩放并居中到目标尺寸（白底，保持宽高比，双线性插值）。
 *
 * 用于把人工权威图归一化到引擎目标页尺寸；只做缩放/对齐，不裁切内容。
 *
 * @param image 源图像。
 * @param width 目标宽，像素。
 * @param height 目标高，像素。
 * @returns 目标尺寸的 RGBA8 图像。
 */
export function resizeImageContain(image: ImageLike, width: number, height: number): ImageLike {
  if (width <= 0 || height <= 0) throw new Error(`目标尺寸非法：${width}×${height}`);
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = Math.max(1, Math.round(image.width * scale));
  const drawHeight = Math.max(1, Math.round(image.height * scale));
  const offsetX = Math.floor((width - drawWidth) / 2);
  const offsetY = Math.floor((height - drawHeight) / 2);
  const out = new Uint8Array(width * height * 4).fill(255);

  /** 双线性采样一个通道，坐标已限制在源图内。 */
  const sample = (x: number, y: number, channel: number): number => {
    const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const p00 = image.data[(y0 * image.width + x0) * 4 + channel]!;
    const p10 = image.data[(y0 * image.width + x1) * 4 + channel]!;
    const p01 = image.data[(y1 * image.width + x0) * 4 + channel]!;
    const p11 = image.data[(y1 * image.width + x1) * 4 + channel]!;
    return p00 * (1 - tx) * (1 - ty) + p10 * tx * (1 - ty) + p01 * (1 - tx) * ty + p11 * tx * ty;
  };

  for (let y = 0; y < drawHeight; y += 1) {
    const srcY = (y + 0.5) / scale - 0.5;
    for (let x = 0; x < drawWidth; x += 1) {
      const srcX = (x + 0.5) / scale - 0.5;
      const alpha = sample(srcX, srcY, 3);
      const a = alpha / 255;
      const offset = ((y + offsetY) * width + (x + offsetX)) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = sample(srcX, srcY, channel);
        out[offset + channel] = Math.round(value * a + 255 * (1 - a));
      }
      out[offset + 3] = 255;
    }
  }
  return { width, height, data: out };
}


/**
 * 双线性缩放到精确目标尺寸（不保持宽高比）。
 *
 * @param image 源图像。
 * @param width 目标宽，像素。
 * @param height 目标高，像素。
 * @returns 缩放后的 RGBA8 图像。
 */
export function resizeImageTo(image: ImageLike, width: number, height: number): ImageLike {
  if (width <= 0 || height <= 0) throw new Error(`目标尺寸非法：${width}×${height}`);
  const out = new Uint8Array(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  const sample = (x: number, y: number, channel: number): number => {
    const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const p00 = image.data[(y0 * image.width + x0) * 4 + channel]!;
    const p10 = image.data[(y0 * image.width + x1) * 4 + channel]!;
    const p01 = image.data[(y1 * image.width + x0) * 4 + channel]!;
    const p11 = image.data[(y1 * image.width + x1) * 4 + channel]!;
    return p00 * (1 - tx) * (1 - ty) + p10 * tx * (1 - ty) + p01 * (1 - tx) * ty + p11 * tx * ty;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcX = (x + 0.5) * scaleX - 0.5;
      const srcY = (y + 0.5) * scaleY - 0.5;
      const a = sample(srcX, srcY, 3) / 255;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        out[offset + channel] = Math.round(sample(srcX, srcY, channel) * a + 255 * (1 - a));
      }
      out[offset + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * 将源图内容区等比缩放到目标内容 bbox，并贴回白底页面。
 *
 * 只移动/缩放内容区，不改变页边距；检测内容时排除 1–3 px 边框噪点，
 * 缩放后把近黑像素保持为纯黑，避免双线性插值把墨色打灰。
 *
 * @param image 源图。
 * @param pageWidth 目标页宽，像素。
 * @param pageHeight 目标页高，像素。
 * @param targetBBox 目标内容 bbox，像素。
 * @returns 目标页尺寸的 RGBA8 图像。
 */
export function alignContentToBBox(
  image: ImageLike,
  pageWidth: number,
  pageHeight: number,
  targetBBox: BBoxPx,
): ImageLike {
  const mask = computeContentMask(image);
  const border = 3;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (x < border || y < border || x >= image.width - border || y >= image.height - border) {
        mask[y * image.width + x] = 0;
      }
    }
  }
  const bbox = computeBBox(mask, image.width, image.height, Math.max(4, Math.round(image.width * image.height * 0.00001)));
  if (!bbox) throw new Error('权威图未检测到内容 bbox');
  const content = cropImage(image, bbox.x, bbox.y, bbox.width, bbox.height);
  const scaled = resizeImageTo(content, targetBBox.width, targetBBox.height);
  const out = new Uint8Array(pageWidth * pageHeight * 4).fill(255);
  for (let y = 0; y < scaled.height; y += 1) {
    const dstY = targetBBox.y + y;
    if (dstY < 0 || dstY >= pageHeight) continue;
    for (let x = 0; x < scaled.width; x += 1) {
      const dstX = targetBBox.x + x;
      if (dstX < 0 || dstX >= pageWidth) continue;
      const srcOffset = (y * scaled.width + x) * 4;
      const dstOffset = (dstY * pageWidth + dstX) * 4;
      const r = scaled.data[srcOffset]!;
      const g = scaled.data[srcOffset + 1]!;
      const b = scaled.data[srcOffset + 2]!;
      if (r < 32 && g < 32 && b < 32) {
        out[dstOffset] = 0;
        out[dstOffset + 1] = 0;
        out[dstOffset + 2] = 0;
      } else {
        out[dstOffset] = r;
        out[dstOffset + 1] = g;
        out[dstOffset + 2] = b;
      }
      out[dstOffset + 3] = 255;
    }
  }
  return { width: pageWidth, height: pageHeight, data: out };
}
