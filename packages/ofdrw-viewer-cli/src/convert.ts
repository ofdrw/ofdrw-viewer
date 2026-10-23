/**
 * 图片与空间文本转换流程：打开 OFD，逐页导出并原子写入。
 *
 * 使用 engine 公共 API：
 * - `OFDDocument.open` 负责解包、页面与资源；CLI 注入 Node Canvas、编码器、
 *   图片解码插件与补充字体；
 * - `OFDPage.exportImage` 负责整页渲染与编码；
 * - `OFDPage.getTextContent` 返回 px 坐标文本项，CLI 扁平化为 JSON。
 *
 * 页级失败继续处理后续页；文档级失败（打开失败、页码越界、页面像素超限、
 * 文本 API 缺失）立即结束。SIGINT 通过 AbortSignal 取消当前导出。
 */

import { parse as parsePath } from 'node:path';
import { openDecryptingContainer } from '@ofdrw/ofdrw-viewer-crypto';
import type { CryptoCredential } from '@ofdrw/ofdrw-viewer-crypto';
import {
  DEFAULT_RESOURCE_LIMITS,
  OFDDocument,
  isOFDError,
} from '@ofdrw/ofdrw-viewer-engine';
import type {
  Canvas2DLike,
  OFDPage,
  OFDWarning,
  PageImageFormat,
  VirtualContainer,
} from '@ofdrw/ofdrw-viewer-engine';
import { createCanvasLike, encodeCanvasImage } from './canvas.js';
import { closeCryptoByteSource, openCryptoSource } from './credentials.js';
import { reportCryptoWarnings } from './crypto-output.js';
import { CliError, EXIT_CODES, errorMessage, isCliError } from './errors.js';
import type { FontFile } from './fonts.js';
import { createNodeFontInputLoader } from './fonts.js';
import { nodeImageDecoders } from './image-decoder.js';
import type { Logger } from './log.js';
import { buildImagePath, buildTextJsonPath, writeFileAtomic } from './output.js';
import type { ImageFormat } from './output.js';
import { NodeFileByteSource } from './node-file-source.js';
import { resolvePageNumbers } from './pages.js';
import { buildTextRecords } from './text.js';

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
  /** 是否额外导出空间文本 JSON。 */
  readonly text: boolean;
  /**
   * 加密文档凭据；`undefined` 表示未提供。
   *
   * 提供凭据时先经 crypto 检测/解密，再用明文容器打开文档；明文文档会忽略
   * 凭据并产生 warning，行为与未提供凭据一致。
   */
  readonly credentials?: CryptoCredential;
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
  /** 逐页进度回调；仅 TTY 时由 CLI 注入。 */
  readonly onProgress?: (current: number, total: number) => void;
  /** 转换结束（含异常/取消）时清理进度行。 */
  readonly onProgressEnd?: () => void;
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
  let container: VirtualContainer | undefined;

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
      // engine 默认 loader 只服务 Web（url/data）；CLI 注入 Node 文件读取，
      // 让 --font-dir 扫描到的 path 来源真正加载为字体字节。
      loadInput: createNodeFontInputLoader(),
      onWarning: (warning: OFDWarning) => {
        const pageNumber =
          warning.pageIndex === undefined ? undefined : warning.pageIndex + 1;
        logger.warn(warning.code, warning.message, pageNumber);
      },
    };

    if (options.credentials === undefined) {
      // 无凭据：保持既有流式路径；加密包由 engine 抛 OFD_ENCRYPTED，下面
      // 映射为“需要凭据”的退出码 4。
      source = await NodeFileByteSource.open(options.inputPath);
      try {
        document = await openDocument({
          ...commonOptions,
          source: { kind: 'custom', source },
        });
      } catch (error) {
        if (isOFDError(error) && error.code === 'OFD_ENCRYPTED') {
          throw new CliError(
            'CLI_CREDENTIALS_REQUIRED',
            `文档已加密，请使用 --user/--password 或 --key/--key-passphrase 提供凭据：${options.inputPath}`,
            EXIT_CODES.CREDENTIAL,
          );
        }
        throw error;
      }
    } else {
      // 有凭据：inspect → openDecryptingContainer → 明文容器交给 engine。
      // engine 借用容器不关闭，由本函数在 finally 中释放。
      const opened = await openCryptoSource(options.inputPath);
      source = opened.byteSource;
      const decrypted = await openDecryptingContainer({
        source: opened.source,
        credentials: options.credentials,
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      });
      container = decrypted.container;
      reportCryptoWarnings(logger, decrypted.warnings);
      document = await openDocument({ ...commonOptions, container });
    }

    const pageNumbers = resolvePageNumbers(options.pageNumbers, document.pageCount);
    const totalPages = pageNumbers.length;
    let succeededPages = 0;
    let failedPages = 0;
    let interrupted = false;

    if (options.text) {
      await assertTextApiAvailable(document, pageNumbers[0]);
    }

    for (const pageNumber of pageNumbers) {
      if (isSignalAborted(runtime.signal)) {
        interrupted = true;
        break;
      }

      runtime.onProgress?.(pageNumber, totalPages);
      let page: OFDPage;
      try {
        page = await document.getPage(pageNumber - 1);
      } catch (error) {
        if (isSignalAborted(runtime.signal) || isAbortError(error)) {
          interrupted = true;
          break;
        }
        failedPages += 1;
        logger.pageError(pageNumber, totalPages, errorCodeOf(error), errorMessage(error));
        runtime.onProgress?.(pageNumber, totalPages);
        continue;
      }

      assertCanvasWithinLimit(page, pageNumber, options.dpi);

      let textOk = !options.text;
      if (options.text) {
        const textPath = buildTextJsonPath(
          options.outDir,
          stem,
          pageNumber,
          document.pageCount,
        );
        try {
          await exportPageText(page, textPath, options.dpi, runtime.signal);
          textOk = true;
        } catch (error) {
          if (isSignalAborted(runtime.signal) || isAbortError(error)) {
            interrupted = true;
            break;
          }
          if (isTextUnsupportedError(error)) {
            throw new CliError(
              'CLI_TEXT_UNSUPPORTED',
              `当前 engine 不支持空间文本导出：${errorMessage(error)}`,
              EXIT_CODES.DOCUMENT,
            );
          }
          if (isCliError(error) && error.exitCode === EXIT_CODES.DOCUMENT) throw error;
          logger.pageError(
            pageNumber,
            totalPages,
            errorCodeOf(error),
            `文本导出失败：${errorMessage(error)}`,
          );
        }
      }

      if (isSignalAborted(runtime.signal)) {
        interrupted = true;
        break;
      }

      let imageOk = false;
      try {
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
        imageOk = true;
      } catch (error) {
        if (isSignalAborted(runtime.signal) || isAbortError(error)) {
          interrupted = true;
          break;
        }
        // 页面像素超限等文档级错误立即结束，不降级为页级失败。
        if (isCliError(error) && error.exitCode === EXIT_CODES.DOCUMENT) throw error;
        logger.pageError(pageNumber, totalPages, errorCodeOf(error), errorMessage(error));
      }

      if (!textOk || !imageOk) failedPages += 1;
      else succeededPages += 1;
      runtime.onProgress?.(pageNumber, totalPages);
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
        text: options.text,
      }),
    };
  } finally {
    try {
      runtime.onProgressEnd?.();
    } catch {
      // 进度清理失败不应覆盖真正的转换错误。
    }
    if (document !== undefined) {
      try {
        await document.close();
      } catch (error) {
        logger.warn('W_DOC_CLOSE_FAILED', `关闭文档失败：${errorMessage(error)}`);
      }
    }
    // 解密容器由 crypto 创建、CLI 拥有；若它是 source-backed 明文容器，
    // 必须先关闭容器再关闭文件句柄。engine 借用容器，不会替 CLI 关闭。
    if (container !== undefined) {
      try {
        await container.close();
      } catch (error) {
        logger.warn('W_CONTAINER_CLOSE_FAILED', `关闭解密容器失败：${errorMessage(error)}`);
      }
    }
    // engine 会关闭无凭据路径传入的 custom source；这里幂等兜底，确保
    // 打开失败/close 提前抛错，以及带凭据路径（crypto 只借用）也释放句柄。
    if (source !== undefined) {
      await closeCryptoByteSource(source, logger);
    }
  }
}

/**
 * 在进入逐页流程前确认 engine 提供空间文本 API。
 *
 * 只检查首个选中页的方法是否存在；若 `getPage` 本身失败则留给逐页流程
 * 按页级失败处理。旧版 engine 无该方法时直接以文档级错误退出 2。
 *
 * @param document 已打开的文档
 * @param pageNumber 首个选中页的页号（1 起）
 * @throws {CliError} 文本 API 缺失时抛出（退出码 2）
 */
async function assertTextApiAvailable(
  document: OFDDocument,
  pageNumber: number,
): Promise<void> {
  let page: OFDPage;
  try {
    page = await document.getPage(pageNumber - 1);
  } catch {
    return;
  }
  if (typeof page.getTextContent !== 'function') {
    throw new CliError(
      'CLI_TEXT_UNSUPPORTED',
      '当前 engine 不支持空间文本导出（OFDPage.getTextContent 缺失）',
      EXIT_CODES.DOCUMENT,
    );
  }
}

/**
 * 读取单页空间文本并原子写 JSON。
 *
 * @param page 页面
 * @param jsonPath 目标 JSON 路径
 * @param dpi 与图片共用的输出 DPI
 * @param signal 取消信号
 * @throws {CliError} JSON 写盘失败时抛出（退出码 3）
 */
async function exportPageText(
  page: OFDPage,
  jsonPath: string,
  dpi: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const content = await page.getTextContent({
    dpi,
    includeChars: false,
    ...(signal === undefined ? {} : { signal }),
  });
  const records = buildTextRecords(content);
  try {
    await writeFileAtomic(jsonPath, JSON.stringify(records));
  } catch (error) {
    throw new CliError(
      'CLI_TEXT_WRITE_FAILED',
      `写入文本 JSON 失败：${jsonPath}（${errorMessage(error)}）`,
      EXIT_CODES.PAGE,
    );
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

/** 判断错误是否为 engine 未绑定文本驱动。 */
function isTextUnsupportedError(error: unknown): boolean {
  return isOFDError(error) && error.code === 'OFD_RENDERER_UNSUPPORTED';
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
  text: boolean;
}): string {
  const progress = `${summary.succeededPages}/${summary.totalPages} 页`;
  if (summary.interrupted) return `已取消：${progress} → ${summary.outDir}`;
  const mode = summary.text ? '（图片 + 文本）' : '';
  if (summary.failedPages > 0) {
    return `完成：${progress}${mode}，${summary.failedPages} 页失败 → ${summary.outDir}`;
  }
  const arrow = mode === '' ? ' →' : '→';
  return `完成：${progress}${mode}${arrow} ${summary.outDir}（${summary.elapsedSeconds}s）`;
}
