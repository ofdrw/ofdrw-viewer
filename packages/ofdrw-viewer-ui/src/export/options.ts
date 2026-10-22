/**
 * 打印/导出的选项解析与纯计算工具（设计方案 §10.4）。
 *
 * 页码统一为 1-based；范围解析、DPI 自适应、格式/质量校验与旋转尺寸换算都
 * 放在这里，保证打印与导出使用同一套规则。
 */

import type { PageImageFormat } from '@ofdrw/ofdrw-viewer-engine';
import { OFDViewerError } from '../errors';
import type { PageRange } from '../types';
import type { Rotation } from '../state';

/** 允许的范围输入：设计类型，或宿主自定义工具栏传入的页码范围文本。 */
export type PageRangeInput = PageRange | string;

/** 自动 DPI 分档；按本次任务页数计算。 */
export const AUTO_DPI_SMALL = 200;
/** 自动 DPI 分档：51–200 页。 */
export const AUTO_DPI_MEDIUM = 150;
/** 自动 DPI 分档：> 200 页。 */
export const AUTO_DPI_LARGE = 96;

/** 自动 DPI 的分界页数（含）。 */
export const AUTO_DPI_SMALL_MAX = 50;
/** 自动 DPI 的第二档分界页数（含）。 */
export const AUTO_DPI_MEDIUM_MAX = 200;

/** 允许的最大输出 DPI；超出按非法选项处理。 */
export const MAX_OUTPUT_DPI = 600;

/** 默认 JPEG/WebP 质量。 */
export const DEFAULT_IMAGE_QUALITY = 0.92;

/** 每英寸毫米数。 */
export const MM_PER_INCH = 25.4;

/** 判断是否为四分之一转（宽高交换）。 */
export function isQuarterTurn(rotation: number): boolean {
  return rotation === 90 || rotation === 270;
}

/**
 * 规范化旋转角度。
 *
 * @param value 任意角度。
 * @returns 0/90/180/270；非法值回退 0。
 */
export function normalizeRotation(value: number | undefined): Rotation {
  if (value === undefined || !Number.isFinite(value)) return 0;
  const normalized = ((Math.trunc(value / 90) * 90) % 360 + 360) % 360;
  return normalized as Rotation;
}

/**
 * 按任务页数选择自动 DPI。
 *
 * @param pageCount 本次打印/导出的页数。
 * @returns ≤50 页 200，51–200 页 150，>200 页 96。
 */
export function resolveAutoDpi(pageCount: number): number {
  const total = Math.max(1, Math.trunc(pageCount));
  if (total <= AUTO_DPI_SMALL_MAX) return AUTO_DPI_SMALL;
  if (total <= AUTO_DPI_MEDIUM_MAX) return AUTO_DPI_MEDIUM;
  return AUTO_DPI_LARGE;
}

/**
 * 解析 DPI 选项。
 *
 * @param value 显式 DPI 或 `auto`；省略按自动。
 * @param pageCount 本次任务页数。
 * @returns 有效 DPI。
 * @throws {OFDViewerError} DPI 非法时抛出 `OFD_INVALID_OPTION`。
 */
export function resolveDpi(value: number | 'auto' | undefined, pageCount: number): number {
  if (value === undefined || value === 'auto') return resolveAutoDpi(pageCount);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_OUTPUT_DPI) {
    throw new OFDViewerError(
      'OFD_INVALID_OPTION',
      `DPI 必须是 0 到 ${MAX_OUTPUT_DPI} 之间的数字`,
    );
  }
  return Math.round(value);
}

/**
 * 解析图片格式。
 *
 * @param value 格式；省略默认 PNG。
 * @returns 合法格式。
 * @throws {OFDViewerError} 格式不受支持时抛出。
 */
export function resolveImageFormat(value: PageImageFormat | undefined): PageImageFormat {
  if (value === undefined) return 'png';
  if (value === 'png' || value === 'jpeg' || value === 'webp') return value;
  throw new OFDViewerError('OFD_INVALID_OPTION', `不支持的图片格式：${String(value)}`);
}

/**
 * 解析图片质量。
 *
 * @param value 0..1；省略使用 0.92。
 * @returns 有效质量。
 * @throws {OFDViewerError} 超出范围时抛出。
 */
export function resolveQuality(value: number | undefined): number {
  if (value === undefined) return DEFAULT_IMAGE_QUALITY;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new OFDViewerError('OFD_INVALID_OPTION', '图片质量必须在 0 到 1 之间');
  }
  return value;
}

/**
 * 解析导出背景。
 *
 * PNG 允许透明（`null`）；JPEG/WebP 不支持透明，强制白底。
 *
 * @param background 宿主传入背景色；省略时 PNG 默认白底。
 * @param format 目标格式。
 * @returns 传给引擎的背景色或 `null`。
 */
export function resolveBackground(
  background: string | null | undefined,
  format: PageImageFormat,
): string | null {
  if (format !== 'png') return '#ffffff';
  return background === undefined ? '#ffffff' : background;
}

/**
 * 计算输出像素尺寸；旋转 90/270 时交换宽高。
 *
 * @param widthMm 页面宽，单位 mm。
 * @param heightMm 页面高，单位 mm。
 * @param dpi 输出 DPI。
 * @param rotation 旋转角度。
 * @returns 输出宽高，单位设备像素。
 */
export function computeOutputSize(
  widthMm: number,
  heightMm: number,
  dpi: number,
  rotation: Rotation,
): { width: number; height: number } {
  const naturalWidth = Math.max(1, Math.ceil((widthMm / MM_PER_INCH) * dpi));
  const naturalHeight = Math.max(1, Math.ceil((heightMm / MM_PER_INCH) * dpi));
  return isQuarterTurn(rotation)
    ? { width: naturalHeight, height: naturalWidth }
    : { width: naturalWidth, height: naturalHeight };
}

/**
 * 解析页码范围。
 *
 * 支持 `current`、`all`、`{ from, to }`、数字数组，以及宿主自定义输入框常见的
 * `1-3,5`、`-3`、`5-` 文本。结果按升序去重。
 *
 * @param range 范围；省略等同 `current`。
 * @param currentPage 当前页，1-based。
 * @param pageCount 总页数。
 * @returns 页号数组，1-based 升序。
 * @throws {OFDViewerError} 范围为空、越界或非法时抛出 `OFD_INVALID_OPTION`。
 */
export function resolvePageRange(
  range: PageRangeInput | undefined,
  currentPage: number,
  pageCount: number,
): number[] {
  const total = Math.trunc(pageCount);
  if (!Number.isFinite(total) || total < 1) {
    throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开');
  }
  const current = clampPage(currentPage, total);
  if (range === undefined) return [current];
  if (range === 'current') return [current];
  if (range === 'all') return Array.from({ length: total }, (_, index) => index + 1);

  if (typeof range === 'string') {
    return parseRangeText(range, total);
  }

  if (Array.isArray(range)) {
    if (range.length === 0) {
      throw new OFDViewerError('OFD_INVALID_OPTION', '页码范围不能为空');
    }
    const pages = new Set<number>();
    for (const value of range) {
      if (!Number.isInteger(value) || value < 1 || value > total) {
        throw new OFDViewerError('OFD_INVALID_OPTION', `页码越界：${String(value)}`);
      }
      pages.add(value);
    }
    return [...pages].sort((left, right) => left - right);
  }

  if (typeof range === 'object' && range !== null) {
    const { from, to } = range as { readonly from?: unknown; readonly to?: unknown };
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      (from as number) < 1 ||
      (to as number) > total ||
      (from as number) > (to as number)
    ) {
      throw new OFDViewerError(
        'OFD_INVALID_OPTION',
        `页码范围非法：${String(from)}-${String(to)}`,
      );
    }
    return Array.from(
      { length: (to as number) - (from as number) + 1 },
      (_, index) => (from as number) + index,
    );
  }

  throw new OFDViewerError('OFD_INVALID_OPTION', '页码范围格式不受支持');
}

/**
 * 解析自定义页码范围文本。
 *
 * @param text 例如 `1-3,5`、`-3`、`5-`；分隔符支持英文/中文逗号与空白。
 * @param pageCount 总页数。
 * @returns 页号数组，1-based 升序去重。
 * @throws {OFDViewerError} 文本非法或越界时抛出。
 */
export function parseRangeText(text: string, pageCount: number): number[] {
  const total = Math.trunc(pageCount);
  const tokens = text
    .split(/[,，、;\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new OFDViewerError('OFD_INVALID_OPTION', '页码范围不能为空');
  }
  const pages = new Set<number>();
  for (const token of tokens) {
    const match = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(token);
    if (match) {
      const hasStart = match[1]!.length > 0;
      const hasEnd = match[2]!.length > 0;
      if (!hasStart && !hasEnd) {
        throw new OFDViewerError('OFD_INVALID_OPTION', `页码范围非法：${token}`);
      }
      const from = hasStart ? Number(match[1]) : 1;
      const to = hasEnd ? Number(match[2]) : total;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > total || from > to) {
        throw new OFDViewerError('OFD_INVALID_OPTION', `页码范围非法：${token}`);
      }
      for (let page = from; page <= to; page += 1) pages.add(page);
      continue;
    }
    if (!/^\d+$/.test(token)) {
      throw new OFDViewerError('OFD_INVALID_OPTION', `页码范围非法：${token}`);
    }
    const page = Number(token);
    if (!Number.isInteger(page) || page < 1 || page > total) {
      throw new OFDViewerError('OFD_INVALID_OPTION', `页码越界：${token}`);
    }
    pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

/**
 * 校验单页页码。
 *
 * @param value 页码，1-based。
 * @param pageCount 总页数。
 * @returns 有效页码。
 * @throws {OFDViewerError} 越界或非整数时抛出 `OFD_INVALID_PAGE`。
 */
export function normalizePageNumber(value: number, pageCount: number): number {
  if (!Number.isInteger(value) || value < 1 || value > pageCount) {
    throw new OFDViewerError('OFD_INVALID_PAGE', `页码越界：${String(value)}`, {
      pageNumber: typeof value === 'number' ? value : undefined,
    });
  }
  return value;
}

/** 把页码夹取到 1..total。 */
function clampPage(value: number, total: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(total, Math.max(1, Math.trunc(value)));
}