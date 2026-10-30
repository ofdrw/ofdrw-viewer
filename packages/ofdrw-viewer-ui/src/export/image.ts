/**
 * 逐页图片生成（设计方案 §10.5）。
 *
 * 打印与导出都只调用引擎 `page.exportImage`，不调用 `page.render`、不修改
 * 页面 canvas 或模型；旋转、背景、质量等选项原样交给引擎，确保输出与页面一致。
 */

import type {
  PageContentFilter,
  PageImageFormat,
  PageImageResult,
} from '@ofdrw/ofdrw-viewer-engine';
import { createFeatureDisabledError } from '../errors';
import type { ViewerFeature } from '../features';
import type { Rotation } from '../state';
import type { EnginePage } from '../document-controller';
import type { OutputHost } from './host';

/** 单页图片生成参数。 */
export interface PageImageRequest {
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 已加载的页面；省略时按页码读取（打印/导出复用同一页面对象）。 */
  readonly page?: EnginePage;
  /** 输出 DPI。 */
  readonly dpi: number;
  /** 目标格式。 */
  readonly format: PageImageFormat;
  /** JPEG/WebP 质量，0..1。 */
  readonly quality: number;
  /** 背景色；`null` 表示 PNG 透明背景。 */
  readonly background: string | null;
  /** 导出旋转；仅影响输出图片。 */
  readonly rotation: Rotation;
  /** 取消信号。 */
  readonly signal: AbortSignal;
  /** 所属功能；引擎能力不足时用于错误码。 */
  readonly feature: ViewerFeature;
  /** 页级内容过滤；省略表示全画。 */
  readonly contentFilter?: PageContentFilter;
}

/** 单页图片生成结果。 */
export interface PageImageOutput {
  /** 编码后的图片。 */
  readonly blob: Blob;
  /** 原始字节，多页 ZIP 直接复用，避免二次解码。 */
  readonly data: Uint8Array;
  /** 实际格式；WebP 不受支持时可能回退 PNG。 */
  readonly format: PageImageFormat;
  /** 输出宽，设备像素。 */
  readonly width: number;
  /** 输出高，设备像素。 */
  readonly height: number;
  /** 实际 DPI。 */
  readonly dpi: number;
}

/** 取消作用域；统一合并外部 signal 与内部取消按钮。 */
export interface AbortScope {
  /** 合并后的取消信号。 */
  readonly signal: AbortSignal;
  /** 触发取消。 */
  abort(reason?: unknown): void;
  /** 释放外部监听。 */
  dispose(): void;
}

/** 创建取消错误；与浏览器 AbortError 语义一致。 */
export function createAbortError(): Error {
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 判断是否取消错误。
 *
 * @param error 任意错误。
 * @returns 取消类错误返回 true。
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || code === 'OFD_ABORTED';
}

/**
 * 创建取消作用域。
 *
 * @param external 宿主取消信号；可选。
 * @returns 内部控制器与外部信号合并结果。
 */
export function createAbortScope(external?: AbortSignal): AbortScope {
  const controller = new AbortController();
  let listener: (() => void) | null = null;
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else {
      listener = () => controller.abort(external.reason);
      external.addEventListener('abort', listener, { once: true });
    }
  }
  return {
    signal: controller.signal,
    abort(reason?: unknown) {
      controller.abort(reason);
    },
    dispose() {
      if (external && listener) external.removeEventListener('abort', listener);
      listener = null;
    },
  };
}

/**
 * 取消时抛出统一的 AbortError。
 *
 * @param scope 取消作用域。
 * @throws {Error} 已取消时抛出 AbortError。
 */
export function throwIfAborted(scope: AbortScope): void {
  throwIfSignalAborted(scope.signal);
}

/**
 * 取消信号已中止时抛出统一的 AbortError。
 *
 * @param signal 取消信号。
 * @throws {Error} 已取消时抛出 AbortError。
 */
export function throwIfSignalAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

/**
 * 读取页面并确认引擎具备图片导出能力。
 *
 * @param host 输出宿主。
 * @param pageNumber 页码，1-based。
 * @param feature 所属功能。
 * @returns 引擎页面。
 * @throws {OFDViewerError} 引擎不支持导出时抛出 `OFD_FEATURE_DISABLED`。
 */
export async function getExportablePage(
  host: OutputHost,
  pageNumber: number,
  feature: ViewerFeature,
): Promise<EnginePage> {
  const page = await host.getPage(pageNumber);
  if (typeof page.exportImage !== 'function') {
    throw createFeatureDisabledError(feature, '当前引擎不支持图片导出');
  }
  return page;
}

/**
 * 生成单页图片。
 *
 * @param host 输出宿主。
 * @param request 生成参数。
 * @returns 图片及实际尺寸/格式。
 */
export async function renderPageImage(
  host: OutputHost,
  request: PageImageRequest,
): Promise<PageImageOutput> {
  const page = request.page ?? (await getExportablePage(host, request.pageNumber, request.feature));
  if (typeof page.exportImage !== 'function') {
    throw createFeatureDisabledError(request.feature, '当前引擎不支持图片导出');
  }
  const contentFilter = request.contentFilter;
  const result: PageImageResult = await page.exportImage({
    dpi: request.dpi,
    format: request.format,
    quality: request.quality,
    rotation: request.rotation,
    background: request.background,
    signal: request.signal,
    ...(contentFilter ? { contentFilter } : {}),
  });
  if (request.signal.aborted) throw createAbortError();
  const format = formatFromMime(result.mime, request.format);
  return {
    blob: new Blob([result.data as unknown as BlobPart], { type: result.mime }),
    data: result.data,
    format,
    width: result.width,
    height: result.height,
    dpi: result.dpi,
  };
}

/**
 * 根据引擎返回的 MIME 判断实际格式。
 *
 * @param mime 引擎返回的 MIME。
 * @param fallback 请求格式。
 * @returns 实际格式；未知 MIME 回落到请求格式。
 */
export function formatFromMime(
  mime: string | undefined,
  fallback: PageImageFormat,
): PageImageFormat {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'image/webp') return 'webp';
  return fallback;
}