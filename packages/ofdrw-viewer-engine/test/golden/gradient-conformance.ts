/**
 * 渐变（§8.3.4）对照验收辅助：渲染 `ofd_pdf_match/gradient.ofd` 并按单元格取样。
 *
 * 该模块只被 `gradient-conformance.test.ts` 使用，用于把「逐格对照标准效果图」的
 * 判定固化为可重复执行的像素采样；不参与引擎运行时。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestCanvas } from '../api/helpers';
import { openTestDocument, renderPage } from '../api/helpers';

/** 页面尺寸，单位 mm（A4 横向）。 */
export const PAGE_MM = { width: 297, height: 210 };

/** 渲染 DPI。 */
export const RENDER_DPI = 96;

/** 一条 warning 记录。 */
export interface WarningRecord {
  /** warning 码。 */
  code: string;
  /** 说明。 */
  message: string;
  /** 关联对象 ID。 */
  objectId?: string;
}

/** 单页渲染结果。 */
export interface RenderedPage {
  /** 1 起的页码。 */
  pageNumber: number;
  /** 画布（含 toBuffer）。 */
  canvas: TestCanvas;
  /** 像素尺寸。 */
  width: number;
  /** 像素尺寸。 */
  height: number;
}

/** 全部页渲染结果与 warning。 */
export interface RenderedSample {
  /** 页码 → 渲染结果。 */
  pages: RenderedPage[];
  /** 渲染过程中产生的 warning。 */
  warnings: WarningRecord[];
}

/** 样本文件默认路径。 */
export const SAMPLE_PATH = resolve(__dirname, '../../../../ofd_pdf_match/gradient.ofd');

/**
 * 渲染样本全部页面（白底、96dpi）。
 *
 * @param samplePath OFD 路径。
 * @returns 渲染结果与 warning。
 */
export async function renderGradientSample(samplePath = SAMPLE_PATH): Promise<RenderedSample> {
  const bytes = new Uint8Array(readFileSync(samplePath));
  const warnings: WarningRecord[] = [];
  const doc = await openTestDocument(bytes, {
    onWarning: (warning: unknown) => {
      warnings.push(warning as WarningRecord);
    },
  } as never);
  const pages: RenderedPage[] = [];
  const pageCount = doc.pageCount;
  for (let index = 0; index < pageCount; index += 1) {
    const page = await doc.getPage(index);
    const { canvas, viewport } = await renderPage(page, { dpi: RENDER_DPI });
    pages.push({
      pageNumber: index + 1,
      canvas,
      width: Math.max(1, Math.ceil(viewport.width)),
      height: Math.max(1, Math.ceil(viewport.height)),
    });
  }
  return { pages, warnings };
}

/**
 * 取像素。
 *
 * @param page 渲染结果。
 * @param xMm 横坐标，单位 mm（页面坐标）。
 * @param yMm 纵坐标，单位 mm（页面坐标）。
 * @returns RGBA 分量。
 */
export function pixelAt(page: RenderedPage, xMm: number, yMm: number): [number, number, number, number] {
  const x = Math.min(page.width - 1, Math.max(0, Math.round((xMm / PAGE_MM.width) * page.width)));
  const y = Math.min(page.height - 1, Math.max(0, Math.round((yMm / PAGE_MM.height) * page.height)));
  return page.canvas.pixel(x, y);
}

/**
 * 计算两个颜色的通道最大绝对差。
 *
 * @param a 颜色 A。
 * @param b 颜色 B。
 * @returns 通道最大差，0..255。
 */
export function colorDistance(
  a: readonly number[],
  b: readonly number[],
): number {
  return Math.max(
    Math.abs((a[0] ?? 0) - (b[0] ?? 0)),
    Math.abs((a[1] ?? 0) - (b[1] ?? 0)),
    Math.abs((a[2] ?? 0) - (b[2] ?? 0)),
  );
}

/**
 * 两色是否接近。
 *
 * @param a 颜色 A。
 * @param b 颜色 B。
 * @param tolerance 允许的通道最大差。
 * @returns 是否接近。
 */
export function isClose(
  a: readonly number[],
  b: readonly number[],
  tolerance = 12,
): boolean {
  return colorDistance(a, b) <= tolerance;
}

/**
 * 按某个 warning 码统计次数。
 *
 * @param warnings warning 列表。
 * @param code warning 码。
 * @returns 出现次数。
 */
export function countWarnings(warnings: readonly WarningRecord[], code: string): number {
  return warnings.filter((warning) => warning.code === code).length;
}

/**
 * 统计一块矩形区域内「非白」像素占比。
 *
 * @param page 渲染结果。
 * @param rect 矩形（页面 mm 坐标）。
 * @returns 非白像素占比，0..1。
 */
export function inkRatio(
  page: RenderedPage,
  rect: { x: number; y: number; w: number; h: number },
): number {
  const x0 = Math.round((rect.x / PAGE_MM.width) * page.width);
  const x1 = Math.round(((rect.x + rect.w) / PAGE_MM.width) * page.width);
  const y0 = Math.round((rect.y / PAGE_MM.height) * page.height);
  const y1 = Math.round(((rect.y + rect.h) / PAGE_MM.height) * page.height);
  let ink = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const [r, g, b] = page.canvas.pixel(x, y);
      total += 1;
      if (r < 245 || g < 245 || b < 245) ink += 1;
    }
  }
  return total === 0 ? 0 : ink / total;
}