/**
 * 图片转换流程：打开 OFD，逐页导出图片并原子写入。
 *
 * 使用 engine 公共 API：
 * - `OFDDocument.open` 负责解包、页面与资源；CLI 注入 Node Canvas、编码器、
 *   图片解码插件与补充字体；
 * - `OFDPage.exportImage` 负责整页渲染与编码，CLI 只做命名、落盘、日志与
 *   退出码汇总。
 *
 * 页级失败继续处理后续页；文档级失败（打开失败、页码越界、页面像素超限）
 * 立即结束。SIGINT 通过 AbortSignal 取消当前导出。
 */

import { parse as parsePath } from 'node:path';
import {
  DEFAULT_RESOURCE_LIMITS,
  OFDDocument,
  isOFDError,
} from 'ofdrw-viewer-engine';
import type {
  Canvas2DLike,
  OFDPage,
  OFDWarning,
  PageImageFormat,
} from 'ofdrw-viewer-engine';
import { createCanvasLike, encodeCanvasImage } from './canvas.js';
import { CliError, EXIT_CODES, errorMessage, isCliError } from './errors.js';
import type { FontFile } from './fonts.js';
import { nodeImageDecoders } from './image-decoder.js';
import type { Logger } from './log.js';
import { buildImagePath, writeFileAtomic } from './output.js';
import type { ImageFormat } from './output.js';
import { NodeFileByteSource } from './node-file-source.js';
import { resolvePageNumbers } from './pages.js';

/** JPEG/WebP 固定编码质量。 */
const IMAGE_QUALITY = 0.9;

/** 图片转换所需的全部输入。 */
export interface ConvertOptions {
  /** 输入 OFD 文件绝对路径。 */
  readonly inputPath: string;
  /** 输出目录绝对路径。 */
  readonly outDir: string;
  /** 图片格式。 */
  readonly format: ImageFormat;
  /** 输出 DPI。 */
  readonly dpi: number;
  /** 选中的页号；`undefined` 表示全部页。 */
  readonly pageNumbers: readonly number[] | undefined;
  /** 补充字体文件列表。 */
  readonly fontFiles: readonly FontFile[];
}

/** 转换摘要，供成功/部分失败/取消时输出与计算退出码。 */
export interface ConvertSummary {
  /** 计划处理的页数。 */
  readonly totalPages: number;
  /** 成功写出的页数。 */
  readonly succeededPages: number;
  /** 失败页数。 */
  readonly failedPages: number;
  /** 是否因 SIGINT/取消信号中止。 */
  readonly interrupted: boolean;
  /** 结束时打印的单行摘要。 */
  readonly message: string;
}

/** 转换流程的可注入运行环境。 */
export interface ConvertRuntime {
  /** 日志器。 */
  readonly logger: Logger;
  /** 取消信号；SIGINT 时由 CLI 主流程触发。 */
  readonly signal?: AbortSignal;
  /** 打开文档的实现，默认 `OFDDocument.open`（单元测试可替换）。 */
  readonly openDocument?: typeof OFDDocument.open;
}

/**
 * 执行单文件图片转换。
 *
 * @param options 转换输入
 * @param runtime 日志、取消信号与打开文档实现
 * @returns 转换摘要
 * @throws {CliError} 页码越界（退出码 1）、页面像素超限（退出码 2）
 * @throws {OFDError} 文档打开失败（由调用方映射为退出码 2）
 */
export async function convertDocument(
  options: ConvertOptions,
  runtime: ConvertRuntime,
): Promise<ConvertSummary> {
  const { logger } = runtime;
  const startedAt = Date.now();
  const stem = parsePath(options.inputPath).name;
  let document: OFDDocument | undefined;
  let source: NodeFileByteSource | undefined;

  try {
    const openDocument = runtime.openDocument ?? OFDDocument.open;
    const commonOptions = {
      createCanvas: createCanvasLike,
      encodeImage: async (
        canvas: Canvas2DLike,
        format: PageImageFormat,
        quality: number,
      ) => encodeCanvasImage(canvas, format, quality),
      imageDecoders: [...nodeImageDecoders],
      supplementaryFonts: options.fontFiles.map((font) => ({ path: font.path })),
      onWarning: (warning: OFDWarning) => {
        const pageNumber =
          warning.pageIndex === undefined ? undefined : warning.pageIndex + 1;
        logger.warn(warning.code, warning.message, pageNumber);
      },
    };

    source = await NodeFileByteSource.open(options.inputPath);
    document = await openDocument({
      ...commonOptions,
      source: { kind: 'custom', source },
    });

    const pageNumbers = resolvePageNumbers(options.pageNumbers, document.pageCount);
    const totalPages = pageNumbers.length;
    let succeededPages = 0;
    let failedPages = 0;
    let interrupted = false;

    for (const pageNumber of pageNumbers) {
      if (isSignalAborted(runtime.signal)) {
        interrupted = true;
        break;
      }

      try {
        const page = await document.getPage(pageNumber - 1);
        assertCanvasWithinLimit(page, pageNumber, options.dpi);
        const result = await page.exportImage({
          dpi: options.dpi,
          format: options.format,
          quality: IMAGE_QUALITY,
          background: '#ffffff',
          ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        });
        const imagePath = buildImagePath(
          options.outDir,
          stem,
          pageNumber,
          options.format,
          document.pageCount,
        );
        try {
          await writeFileAtomic(imagePath, result.data);
        } catch (error) {
          throw new CliError(
            'CLI_IMAGE_WRITE_FAILED',
            `写入图片失败：${imagePath}（${errorMessage(error)}）`,
            EXIT_CODES.PAGE,
          );
        }
        succeededPages += 1;
      } catch (error) {
        if (isSignalAborted(runtime.signal) || isAbortError(error)) {
          interrupted = true;
          break;
        }
        // 页面像素超限等文档级错误立即结束，不降级为页级失败。
        if (isCliError(error) && error.exitCode === EXIT_CODES.DOCUMENT) throw error;
        failedPages += 1;
        logger.pageError(pageNumber, totalPages, errorCodeOf(error), errorMessage(error));
      }
    }

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    return {
      totalPages,
      succeededPages,
      failedPages,
      interrupted,
      message: formatSummary({
        totalPages,
        succeededPages,
        failedPages,
        interrupted,
        outDir: options.outDir,
        elapsedSeconds,
      }),
    };
  } finally {
    if (document !== undefined) {
      try {
        await document.close();
      } catch (error) {
        logger.warn('W_DOC_CLOSE_FAILED', `关闭文档失败：${errorMessage(error)}`);
      }
    }
    // engine 会关闭 custom source；这里幂等兜底，确保打开失败/close 提前抛错时也释放句柄。
    if (source !== undefined) {
      try {
        await source.close();
      } catch (error) {
        logger.warn('W_SOURCE_CLOSE_FAILED', `关闭输入文件失败：${errorMessage(error)}`);
      }
    }
  }
}

/**
 * 在分配 Canvas 前校验页面像素数。
 *
 * @param page 页面
 * @param pageNumber 页号（1 起）
 * @param dpi 输出 DPI
 * @throws {CliError} 超过 engine 默认画布像素上限时抛出（退出码 2）
 */
function assertCanvasWithinLimit(page: OFDPage, pageNumber: number, dpi: number): void {
  const viewport = page.getViewport({ dpi });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  if (width * height <= DEFAULT_RESOURCE_LIMITS.maxCanvasPixels) return;
  throw new CliError(
    'CLI_PAGE_TOO_LARGE',
    `页面 ${pageNumber} 在 ${dpi} DPI 下为 ${width}×${height} 像素，超过上限 ${DEFAULT_RESOURCE_LIMITS.maxCanvasPixels}；请降低 --dpi`,
    EXIT_CODES.DOCUMENT,
  );
}

/** 判断取消信号是否已触发；封装以避免 TS 对只读属性的窄化。 */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 判断错误是否为取消。 */
function isAbortError(error: unknown): boolean {
  return isOFDError(error) && error.code === 'OFD_ABORTED';
}

/** 提取用于日志的错误码。 */
function errorCodeOf(error: unknown): string {
  if (isOFDError(error)) return error.code;
  if (isCliError(error)) return error.code;
  return 'CLI_UNEXPECTED';
}

/** 生成结束时打印的单行摘要。 */
function formatSummary(summary: {
  totalPages: number;
  succeededPages: number;
  failedPages: number;
  interrupted: boolean;
  outDir: string;
  elapsedSeconds: string;
}): string {
  const progress = `${summary.succeededPages}/${summary.totalPages} 页`;
  if (summary.interrupted) return `已取消：${progress} → ${summary.outDir}`;
  if (summary.failedPages > 0) {
    return `完成：${progress}，${summary.failedPages} 页失败 → ${summary.outDir}`;
  }
  return `完成：${progress} → ${summary.outDir}（${summary.elapsedSeconds}s）`;
}
