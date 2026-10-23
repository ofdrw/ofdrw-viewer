/**
 * 黄金图比较：区域/bbox + 关键色 ΔE2000 + 抗锯齿排除 + 辅助指标。
 *
 * 判定口径（设计方案 19.2）：
 * - 页面尺寸偏差 ≤ 0.5 mm 或 1 设备像素（取较宽者）；
 * - 内容 bbox 边缘偏差 ≤ 0.5 mm 或 1 设备像素（取较宽者）；
 * - 双方各取前 5 个主色做最近邻匹配，关键色 ΔE2000 ≤ 5；
 * - Sobel 抗锯齿边缘（含 1px 膨胀）不参与像素/颜色差异；
 * - SSIM、像素差仅作为辅助指标，不单独判定失败。
 *
 * 坐标与单位：像素为 device px（与 DPI 对应）；毫米换算使用 `px × 25.4 / dpi`。
 */

import { deltaE2000, rgbToLab } from './color';
import {
  computeBBox,
  computeContentMask,
  computeEdgeMask,
  countMask,
  cropImage,
  decodePng,
  dominantColors,
  encodePng,
  flattenOnWhite,
  globalSsim,
  toGrayscale,
} from './image';
import type {
  BBoxMm,
  BBoxPx,
  CompareMetrics,
  CompareOptions,
  CompareResult,
  CompareStatus,
  ImageLike,
  RegionMetric,
  Tolerance,
} from './types';
import { DEFAULT_TOLERANCE } from './types';

/** 毫米/像素换算。 */
function mmPerPixel(dpi: number): number {
  return 25.4 / dpi;
}

/** bbox 转毫米。 */
function bboxToMm(bbox: BBoxPx | null, dpi: number): BBoxMm | null {
  if (!bbox) return null;
  const scale = mmPerPixel(dpi);
  return {
    x: bbox.x * scale,
    y: bbox.y * scale,
    width: bbox.width * scale,
    height: bbox.height * scale,
  };
}

/** 取 95 分位（输入会被排序）。 */
function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const index = Math.floor(0.95 * (values.length - 1));
  return values[index]!;
}

/**
 * 比较实际渲染图与参考图。
 *
 * @param actual 实际渲染图（引擎输出）。
 * @param expected 参考图（PDF 或人工确认基线）。
 * @param options 比较选项（DPI、容差、是否生成 diff）。
 * @returns 结论、指标与可选 diff PNG。
 */
export function compareImages(
  actual: ImageLike,
  expected: ImageLike,
  options: CompareOptions = {},
): CompareResult {
  const dpi = options.dpi ?? 96;
  const tolerance: Tolerance = { ...DEFAULT_TOLERANCE, ...options.tolerance };
  const scale = mmPerPixel(dpi);
  const width = Math.min(actual.width, expected.width);
  const height = Math.min(actual.height, expected.height);
  if (width <= 0 || height <= 0) {
    throw new Error('compareImages: 图像尺寸为空，无法比较');
  }

  const actualFlat = cropImage(flattenOnWhite(actual), 0, 0, width, height);
  const expectedFlat = cropImage(flattenOnWhite(expected), 0, 0, width, height);

  const grayA = toGrayscale(actualFlat);
  const grayE = toGrayscale(expectedFlat);
  const edgeMaskA = computeEdgeMask(grayA, width, height, tolerance.aaEdgeThreshold);
  const edgeMaskE = computeEdgeMask(grayE, width, height, tolerance.aaEdgeThreshold);
  const ignoreMask = new Uint8Array(width * height);
  for (let i = 0; i < ignoreMask.length; i += 1) {
    ignoreMask[i] = edgeMaskA[i]! | edgeMaskE[i]!;
  }

  const contentMaskA = computeContentMask(actualFlat, tolerance.minAlpha, tolerance.backgroundDistance);
  const contentMaskE = computeContentMask(expectedFlat, tolerance.minAlpha, tolerance.backgroundDistance);
  // 单像素/极小噪点不应把 bbox 拉到页边；文字页尤其容易被 PDF/引擎的抗锯齿孤立点影响。
  const minBboxComponent = Math.max(4, Math.round(width * height * 0.00001));
  const bboxA = computeBBox(contentMaskA, width, height, minBboxComponent);
  const bboxE = computeBBox(contentMaskE, width, height, minBboxComponent);
  const bboxAm = bboxToMm(bboxA, dpi);
  const bboxEm = bboxToMm(bboxE, dpi);

  let layoutDeltaMm: number | null = 0;
  if (bboxA && bboxE) {
    const deltaPx = Math.max(
      Math.abs(bboxA.x - bboxE.x),
      Math.abs(bboxA.y - bboxE.y),
      Math.abs(bboxA.x + bboxA.width - (bboxE.x + bboxE.width)),
      Math.abs(bboxA.y + bboxA.height - (bboxE.y + bboxE.height)),
    );
    layoutDeltaMm = deltaPx * scale;
  } else if (bboxA || bboxE) {
    layoutDeltaMm = null;
  }

  const diffMask = new Uint8Array(width * height);
  const diffThreshold = Math.max(1, Math.round(tolerance.pixelmatchThreshold * 255));
  let pixelDiffCount = 0;
  for (let i = 0; i < diffMask.length; i += 1) {
    if (ignoreMask[i] !== 0) continue;
    const offset = i * 4;
    const delta = Math.max(
      Math.abs(actualFlat.data[offset]! - expectedFlat.data[offset]!),
      Math.abs(actualFlat.data[offset + 1]! - expectedFlat.data[offset + 1]!),
      Math.abs(actualFlat.data[offset + 2]! - expectedFlat.data[offset + 2]!),
    );
    if (delta > diffThreshold) {
      diffMask[i] = 1;
      pixelDiffCount += 1;
    }
  }
  const pixelDiffRatio = pixelDiffCount / (width * height);

  const ssim = globalSsim(grayA, grayE);

  // 文字页的“主色”很容易被字形抗锯齿灰阶主导；边缘密度 + SSIM 作为显式文字页判定，
  // 只对文字页启用暗墨主色与较宽占比容差，不改变图片/版式页的严格口径。
  const contentCount = countMask(contentMaskA) + countMask(contentMaskE);
  const edgeDensity = contentCount > 0 ? countMask(ignoreMask) / contentCount : 0;
  const isTextLike = edgeDensity >= tolerance.textEdgeDensity && ssim >= tolerance.textSsimMin;

  const colorStats = sampleColorDifferences(
    actualFlat,
    expectedFlat,
    contentMaskA,
    contentMaskE,
    ignoreMask,
    tolerance.regionGrid,
  );
  // 主色统计排除抗锯齿边缘，避免第 5 名灰阶随 AA 抖动导致误判。
  const flatMaskA = maskWithoutEdges(contentMaskA, edgeMaskA);
  const flatMaskE = maskWithoutEdges(contentMaskE, edgeMaskE);
  const colorMaskA = isTextLike
    ? maskByLuminance(actualFlat, flatMaskA, tolerance.textInkMaxLuminance)
    : flatMaskA;
  const colorMaskE = isTextLike
    ? maskByLuminance(expectedFlat, flatMaskE, tolerance.textInkMaxLuminance)
    : flatMaskE;
  const actualColors = dominantColors(actualFlat, colorMaskA, 8, 0.002);
  const expectedColors = dominantColors(expectedFlat, colorMaskE, 8, 0.002);
  let keyColorMaxDE = 0;
  let keyColorCoverageDelta = 0;
  for (const expectedColor of expectedColors) {
    let nearestDE = Number.POSITIVE_INFINITY;
    let nearestRatioDelta = 0;
    const expectedLab = rgbToLab(expectedColor.rgb);
    for (const actualColor of actualColors) {
      const de = deltaE2000(expectedLab, rgbToLab(actualColor.rgb));
      if (de < nearestDE) {
        nearestDE = de;
        nearestRatioDelta = Math.abs(actualColor.ratio - expectedColor.ratio);
      }
    }
    if (Number.isFinite(nearestDE) && nearestDE > keyColorMaxDE) keyColorMaxDE = nearestDE;
    if (nearestRatioDelta > keyColorCoverageDelta) keyColorCoverageDelta = nearestRatioDelta;
  }

  const regions = computeRegionMetrics(
    width,
    height,
    tolerance.regionGrid,
    diffMask,
    contentMaskA,
    contentMaskE,
  );
  const inkDiffRatio = computeInkDiffRatio(
    actualFlat,
    expectedFlat,
    contentMaskA,
    contentMaskE,
    tolerance.inkMaxLuminance,
  );

  const sizeDeltaPx = {
    width: actual.width - expected.width,
    height: actual.height - expected.height,
  };
  const sizeDeltaMm = { width: sizeDeltaPx.width * scale, height: sizeDeltaPx.height * scale };
  const layoutToleranceMm = Math.max(
    tolerance.layoutMm,
    scale,
    isTextLike ? tolerance.textLayoutMm : 0,
  );
  const sizeTolerancePx = Math.max(1, tolerance.sizeMm / scale);
  const sizeOk =
    Math.abs(sizeDeltaPx.width) <= sizeTolerancePx && Math.abs(sizeDeltaPx.height) <= sizeTolerancePx;
  const layoutOk = layoutDeltaMm !== null && layoutDeltaMm <= layoutToleranceMm;
  const colorDeltaLimit = isTextLike ? tolerance.textColorDeltaE : tolerance.colorDeltaE;
  const coverageLimit = isTextLike ? tolerance.textCoverageDelta : tolerance.colorCoverageDelta;
  const colorOk = keyColorMaxDE <= colorDeltaLimit && keyColorCoverageDelta <= coverageLimit;

  const reasons: string[] = [];
  if (!sizeOk) {
    reasons.push(
      `页面尺寸偏差超限：${sizeDeltaPx.width}×${sizeDeltaPx.height} px ` +
        `(${sizeDeltaMm.width.toFixed(2)}×${sizeDeltaMm.height.toFixed(2)} mm)`,
    );
  }
  if (!layoutOk) {
    reasons.push(
      layoutDeltaMm === null
        ? '内容存在性不一致（一方无内容 bbox）'
        : `内容 bbox 偏差 ${layoutDeltaMm.toFixed(3)} mm > ${layoutToleranceMm.toFixed(3)} mm`,
    );
  }
  if (!colorOk) {
    if (keyColorMaxDE > colorDeltaLimit) {
      reasons.push(`关键色 ΔE2000 ${keyColorMaxDE.toFixed(2)} > ${colorDeltaLimit}`);
    }
    if (keyColorCoverageDelta > coverageLimit) {
      reasons.push(
        `关键色占比差 ${(keyColorCoverageDelta * 100).toFixed(1)}% > ` +
          `${(coverageLimit * 100).toFixed(1)}%`,
      );
    }
  }

  let status: CompareStatus = 'pass';
  if (!sizeOk) status = 'size-mismatch';
  else if (!layoutOk) status = 'layout-mismatch';
  else if (!colorOk) status = 'color-mismatch';

  const metrics: CompareMetrics = {
    actualSize: { width: actual.width, height: actual.height },
    expectedSize: { width: expected.width, height: expected.height },
    sizeDeltaPx,
    sizeDeltaMm,
    actualBBoxMm: bboxAm,
    expectedBBoxMm: bboxEm,
    layoutDeltaMm,
    keyColorMaxDE,
    keyColorCoverageDelta,
    colorP95DE: colorStats.p95,
    colorP95DEAll: colorStats.p95All,
    blockColorP95DE: colorStats.blockP95,
    inkDiffRatio,
    contentDiffRatio: colorStats.contentDiffRatio,
    colorSampleCount: colorStats.count,
    ssim,
    pixelDiffRatio,
    regions,
    edgeDensity,
  };

  const result: CompareResult = { status, ok: status === 'pass', reasons, metrics };
  if (options.computeDiff !== false) {
    result.diffPng = encodePng(buildDiffOverlay(actualFlat, diffMask, width, height));
  }
  return result;
}

/**
 * 解码 PNG 并比较（便捷函数）。
 *
 * @param actualPng 实际 PNG 字节。
 * @param expectedPng 参考 PNG 字节。
 * @param options 比较选项。
 * @returns 比较结果。
 */
export function comparePngBuffers(
  actualPng: Uint8Array,
  expectedPng: Uint8Array,
  options: CompareOptions = {},
): CompareResult {
  return compareImages(decodePng(actualPng), decodePng(expectedPng), options);
}

/** 颜色采样与 ΔE 统计（含包含 AA 边缘的全局/分块指标）。 */
interface ColorSampleStats {
  /** 排除 AA 边缘后的样本数。 */
  count: number;
  /** 排除 AA 边缘后的 ΔE2000 95 分位。 */
  p95: number;
  /** 包含 AA 边缘的全部共同内容样本 ΔE2000 95 分位。 */
  p95All: number;
  /** 分块内 ΔE2000 95 分位的最大值（3×3 网格）。 */
  blockP95: number;
  /** 共同内容样本中 ΔE2000 > 10 的比例。 */
  contentDiffRatio: number;
}

function sampleColorDifferences(
  actual: ImageLike,
  expected: ImageLike,
  contentMaskA: Uint8Array,
  contentMaskE: Uint8Array,
  ignoreMask: Uint8Array,
  grid: number,
): ColorSampleStats {
  const totalPixels = actual.width * actual.height;
  const stride = Math.max(1, Math.round(Math.sqrt(totalPixels / 50_000)));
  const values: number[] = [];
  const allValues: number[] = [];
  const gridSize = Math.max(1, Math.floor(grid));
  const blockValues: number[][] = Array.from({ length: gridSize * gridSize }, () => []);
  let contentDiffCount = 0;
  for (let i = 0; i < totalPixels; i += stride) {
    if (contentMaskA[i] === 0 || contentMaskE[i] === 0) continue;
    const offset = i * 4;
    if (actual.data[offset + 3]! < 200 || expected.data[offset + 3]! < 200) continue;
    const labA = rgbToLab({
      r: actual.data[offset]!,
      g: actual.data[offset + 1]!,
      b: actual.data[offset + 2]!,
    });
    const labE = rgbToLab({
      r: expected.data[offset]!,
      g: expected.data[offset + 1]!,
      b: expected.data[offset + 2]!,
    });
    const de = deltaE2000(labA, labE);
    allValues.push(de);
    if (de > 10) contentDiffCount += 1;
    if (ignoreMask[i] === 0) values.push(de);
    // 块级差分：统计每个网格内 ΔE2000 的 95 分位，取最大值；整图 p95 会被大片白底稀释。
    const x = i % actual.width;
    const y = Math.floor(i / actual.width);
    const row = Math.min(gridSize - 1, Math.floor((y * gridSize) / actual.height));
    const col = Math.min(gridSize - 1, Math.floor((x * gridSize) / actual.width));
    blockValues[row * gridSize + col]!.push(de);
  }
  const blockP95Values = blockValues
    .filter((values) => values.length > 0)
    .map((values) => percentile95(values));
  return {
    count: values.length,
    p95: percentile95(values),
    p95All: percentile95(allValues),
    blockP95: blockP95Values.length > 0 ? Math.max(...blockP95Values) : 0,
    contentDiffRatio: allValues.length > 0 ? contentDiffCount / allValues.length : 0,
  };
}

/** 墨迹掩码异或并集比：亮度 ≤ 阈值且为共同内容的像素。 */
function computeInkDiffRatio(
  actual: ImageLike,
  expected: ImageLike,
  contentMaskA: Uint8Array,
  contentMaskE: Uint8Array,
  inkMaxLuminance: number,
): number {
  let union = 0;
  let xor = 0;
  for (let i = 0; i < contentMaskA.length; i += 1) {
    const offset = i * 4;
    const lumA =
      0.299 * actual.data[offset]! + 0.587 * actual.data[offset + 1]! + 0.114 * actual.data[offset + 2]!;
    const lumE =
      0.299 * expected.data[offset]! + 0.587 * expected.data[offset + 1]! + 0.114 * expected.data[offset + 2]!;
    const inkA = contentMaskA[i] !== 0 && lumA <= inkMaxLuminance ? 1 : 0;
    const inkE = contentMaskE[i] !== 0 && lumE <= inkMaxLuminance ? 1 : 0;
    union += inkA | inkE;
    xor += inkA ^ inkE;
  }
  return union > 0 ? xor / union : 0;
}

/** 3×3（可配置）区域差异。 */
function computeRegionMetrics(
  width: number,
  height: number,
  grid: number,
  diffMask: Uint8Array,
  contentMaskA: Uint8Array,
  contentMaskE: Uint8Array,
): RegionMetric[] {
  const metrics: RegionMetric[] = [];
  const gridSize = Math.max(1, Math.floor(grid));
  for (let row = 0; row < gridSize; row += 1) {
    const y0 = Math.floor((height * row) / gridSize);
    const y1 = Math.floor((height * (row + 1)) / gridSize);
    for (let col = 0; col < gridSize; col += 1) {
      const x0 = Math.floor((width * col) / gridSize);
      const x1 = Math.floor((width * (col + 1)) / gridSize);
      const regionPixels = Math.max(1, (x1 - x0) * (y1 - y0));
      let diffPixels = 0;
      let contentA = 0;
      let contentE = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = y * width + x;
          if (diffMask[i] !== 0) diffPixels += 1;
          contentA += contentMaskA[i]!;
          contentE += contentMaskE[i]!;
        }
      }
      metrics.push({
        row,
        col,
        pixelDiffRatio: diffPixels / regionPixels,
        coverageDelta: contentA / regionPixels - contentE / regionPixels,
      });
    }
  }
  return metrics;
}

/** 内容掩码去除抗锯齿边缘后的“平坦色块”掩码。 */
function maskWithoutEdges(contentMask: Uint8Array, edgeMask: Uint8Array): Uint8Array {
  const mask = new Uint8Array(contentMask.length);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = contentMask[i] === 1 && edgeMask[i] === 0 ? 1 : 0;
  }
  return mask;
}

/**
 * 只保留亮度不超过阈值的暗墨像素，排除文字抗锯齿灰阶对主色统计的干扰。
 *
 * @param image 图像。
 * @param mask 基础内容掩码。
 * @param maxLuminance 最大亮度（0..255）。
 * @returns 过滤后的掩码。
 */
function maskByLuminance(image: ImageLike, mask: Uint8Array, maxLuminance: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) continue;
    const offset = i * 4;
    const luminance =
      0.299 * image.data[offset]! + 0.587 * image.data[offset + 1]! + 0.114 * image.data[offset + 2]!;
    if (luminance <= maxLuminance) out[i] = 1;
  }
  return out;
}

/** 构造 diff 叠加图：非差异区淡出，差异区标红。 */
function buildDiffOverlay(actual: ImageLike, diffMask: Uint8Array, width: number, height: number): ImageLike {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    const isDiff = diffMask[i] !== 0;
    if (isDiff) {
      out[offset] = 255;
      out[offset + 1] = 0;
      out[offset + 2] = 0;
    } else {
      out[offset] = Math.round(actual.data[offset]! * 0.35 + 255 * 0.65);
      out[offset + 1] = Math.round(actual.data[offset + 1]! * 0.35 + 255 * 0.65);
      out[offset + 2] = Math.round(actual.data[offset + 2]! * 0.35 + 255 * 0.65);
    }
    out[offset + 3] = 255;
  }
  return { width, height, data: out };
}