/**
 * 图片与空间文本转换流程：打开 OFD，逐页导出并原子写入。
 *
 * 使用 engine 公共 API：
 * - `OFDDocument.open` 负责解包、页面与资源；CLI 注入 Node Canvas、编码器、
 *   图片解码插件与已读好的字体字节；
 * - `OFDPage.exportImage` 负责整页渲染与编码；
 * - `OFDPage.getTextContent` 返回 px 坐标文本项，CLI 扁平化为 JSON；
 * - `OFDDocument.getMediaResources`/`getMediaData` 列出并整块读取音视频资源，
 *   由 CLI 落盘为 `media-<id>.<ext>`。
 *
 * 页级失败继续处理后续页；文档级失败（打开失败、页码越界、页面像素超限、
 * 文本 API 缺失）立即结束。SIGINT 通过 AbortSignal 取消当前导出。
 */

import { parse as parsePath } from 'node:path';
import { openDecryptingContainer } from '@ofdrw/ofdrw-viewer-crypto';
import type { CryptoCredential } from '@ofdrw/ofdrw-viewer-crypto';
import {
  OFDDocument,
  isOFDError,
} from '@ofdrw/ofdrw-viewer-engine';
import type {
  Canvas2DLike,
  MediaResource,
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
import { loadFontInputs } from './fonts.js';
import { nodeImageDecoders } from './image-decoder.js';
import type { Logger } from './log.js';
import { exportMediaFile, isValidMediaId, reserveMediaFilePath } from './media.js';
import { buildImagePath, buildTextJsonPath, writeFileAtomic } from './output.js';
import type { ImageFormat } from './output.js';
import { NodeFileByteSource } from './node-file-source.js';
import { resolvePageNumbers } from './pages.js';
import { sanitizeDisplayText } from './safe-text.js';
import { buildTextRecords } from './text.js';

/** JPEG/WebP 固定编码质量。 */
const IMAGE_QUALITY = 0.9;

/** 音视频导出选项。 */
export interface MediaExportOptions {
  /** 只导出指定媒体类型；省略时导出音频与视频。 */
  readonly kind: 'audio' | 'video' | undefined;
  /** 只导出指定资源 ID；省略时导出全部匹配资源。 */
  readonly id: string | undefined;
}

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
  /** 补充字体文件列表；转换开始时读取字节注入 engine。 */
  readonly fontFiles: readonly FontFile[];
  /** 是否额外导出空间文本 JSON。 */
  readonly text: boolean;
  /** 音视频导出选项；未提供时不导出音视频。 */
  readonly media?: MediaExportOptions;
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
  /** 成功写出的音视频文件数；未启用 `--media` 时为 0。 */
  readonly mediaWritten: number;
  /** 导出失败的音视频资源数；未启用 `--media` 时为 0。 */
  readonly mediaFailed: number;
  /** 是否因 SIGINT/取消信号中止。 */
  readonly interrupted: boolean;
  /** 结束时打印的单行摘要。 */
  readonly message: string;
}

/** 单页处理进度。 */
export interface PageProgress {
  /** 当前是本次计划的第几页（1 起）。 */
  readonly index: number;
  /** 本次计划导出的总页数。 */
  readonly total: number;
  /** 文档中的页号（1 起）；指定 `--pages` 时可能大于 `index`。 */
  readonly pageNumber: number;
}

/** 转换流程的可注入运行环境。 */
export interface ConvertRuntime {
  /** 日志器。 */
  readonly logger: Logger;
  /** 取消信号；SIGINT 时由 CLI 主流程触发。 */
  readonly signal?: AbortSignal;
  /** 单页开始处理时回调；用于输出逐页进度。 */
  readonly onPageStart?: (progress: PageProgress) => void;
  /** 单页处理结束时回调；`ok` 为 false 表示该页有失败项。 */
  readonly onPageEnd?: (progress: PageProgress, ok: boolean) => void;
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
    // CLI 自己读取字体字节；engine 只接受已读好的 data，不再读取路径或 URL。
    const supplementaryFonts = await loadFontInputs(options.fontFiles, logger);
    const commonOptions = {
      createCanvas: createCanvasLike,
      encodeImage: async (
        canvas: Canvas2DLike,
        format: PageImageFormat,
        quality: number,
      ) => encodeCanvasImage(canvas, format, quality),
      imageDecoders: [...nodeImageDecoders],
      ...(supplementaryFonts.length === 0 ? {} : { supplementaryFonts }),
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
    // `--media` 是唯一产物时不做任何页面渲染：既不加载页面，也不产生图片/文本文件。
    const renderPages = !isMediaOnly(options);
    const totalPages = renderPages ? pageNumbers.length : 0;
    let succeededPages = 0;
    let failedPages = 0;
    let interrupted = false;
    let processedPages = 0;

    if (options.text) {
      await assertTextApiAvailable(document, pageNumbers[0]);
    }

    for (const pageNumber of totalPages === 0 ? [] : pageNumbers) {
      if (isSignalAborted(runtime.signal)) {
        interrupted = true;
        break;
      }

      processedPages += 1;
      const progress: PageProgress = { index: processedPages, total: totalPages, pageNumber };
      runtime.onPageStart?.(progress);
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
        runtime.onPageEnd?.(progress, false);
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

      const pageOk = textOk && imageOk;
      if (pageOk) succeededPages += 1;
      else failedPages += 1;
      runtime.onPageEnd?.(progress, pageOk);
    }

    const mediaResult =
      interrupted || options.media === undefined
        ? { written: 0, failed: 0, interrupted: false }
        : await exportMediaResources(document, options.media, options.outDir, runtime);
    if (mediaResult.interrupted) interrupted = true;

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    return {
      totalPages,
      succeededPages,
      failedPages,
      mediaWritten: mediaResult.written,
      mediaFailed: mediaResult.failed,
      interrupted,
      message: formatSummary({
        totalPages,
        succeededPages,
        failedPages,
        mediaWritten: mediaResult.written,
        mediaFailed: mediaResult.failed,
        interrupted,
        outDir: options.outDir,
        elapsedSeconds,
        text: options.text,
        media: options.media !== undefined,
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
 * 判断本次是否只导出音视频。
 *
 * 仅当 `--media` 是唯一产物开关时成立：既未要求空间文本，也未显式指定页码。
 * 页码、图片格式、DPI 与 `--font-dir` 都属于"要求产出页面"的显式意图，任一
 * 出现即照常渲染逐页图片，避免用户以为加了 `-p 1` 会得到图片却只拿到音视频。
 *
 * @param options 转换输入
 * @returns 仅导出音视频时为 true
 */
export function isMediaOnly(options: {
  readonly text: boolean;
  readonly pageNumbers: readonly number[] | undefined;
  readonly media?: MediaExportOptions;
}): boolean {
  return options.media !== undefined && !options.text && options.pageNumbers === undefined;
}

/** 音视频导出结果。 */
interface MediaExportResult {
  /** 成功写出的文件数。 */
  readonly written: number;
  /** 失败资源数。 */
  readonly failed: number;
  /** 是否因取消而中止。 */
  readonly interrupted: boolean;
}

/**
 * 列出并导出文档级音视频资源。
 *
 * 资源清单来自 `getMediaResources()`（只含文档级资源，零内容 IO）；指定
 * `--media-id` 时改为按 ID 精确查找，可命中页级 `PageRes` 中声明的资源。
 * 单个资源失败不中断其余资源，逐个记入 `failed`。
 *
 * @param document 已打开的文档
 * @param media 导出筛选条件
 * @param outDir 输出目录绝对路径
 * @param runtime 日志与取消信号
 * @returns 成功/失败计数与取消标记
 * @throws {OFDError} 取消、文档关闭或包损坏等文档级错误
 */
async function exportMediaResources(
  document: OFDDocument,
  media: MediaExportOptions,
  outDir: string,
  runtime: ConvertRuntime,
): Promise<MediaExportResult> {
  const { logger } = runtime;
  const signal = runtime.signal;
  const selected = await selectMediaResources(document, media, signal);
  if (selected.length === 0) {
    // 无资源可导出时明确告知用户：声明可能因路径非法/类型不符在索引阶段被跳过，
    // 具体原因已由 engine 的 W_MEDIA_* warning 输出到 stderr。
    logger.warn(
      'W_MEDIA_NONE',
      media.kind === undefined
        ? '未发现可导出的音视频资源（声明可能缺少 MediaFile 或路径非法）'
        : `未发现可导出的音视频资源（--media-kind ${media.kind}）`,
    );
  }
  const taken = new Set<string>();
  let written = 0;
  let failed = 0;

  for (const resource of selected) {
    if (isSignalAborted(signal)) return { written, failed, interrupted: true };
    const filePath = reserveMediaFilePath(outDir, resource.id, resource.mimeType, taken);
    try {
      const bytes = await exportMediaFile(
        { id: resource.id, kind: resource.kind, mimeType: resource.mimeType, filePath },
        async (id, abortSignal) =>
          document.getMediaData(id, {
            ...(abortSignal === undefined ? {} : { signal: abortSignal }),
          }),
        signal,
      );
      logger.info(
        `多媒体 ${resource.id}（${resource.kind}，${bytes} byte）→ ${filePath}`,
      );
      written += 1;
    } catch (error) {
      if (isSignalAborted(signal) || isAbortError(error)) {
        return { written, failed, interrupted: true };
      }
      // 单个资源失败只影响自身；错误码原样输出便于脚本匹配。
      if (isCliError(error) && error.code === 'CLI_MEDIA_WRITE_FAILED') throw error;
      failed += 1;
      logger.error(errorCodeOf(error), errorMessage(error));
    }
  }
  return { written, failed, interrupted: false };
}

/**
 * 按筛选条件选出待导出的音视频资源。
 *
 * 未指定 `--media-id` 时使用 `getMediaResources()`（文档级资源，按 ID 升序）；
 * 指定时按 ID 精确查找，命中才导出，未命中抛 `CLI_MEDIA_NOT_FOUND`。指定 ID
 * 命中图片资源时抛 `CLI_MEDIA_UNSUPPORTED_TYPE`。
 *
 * @param document 已打开的文档
 * @param media 筛选条件
 * @param signal 取消信号
 * @returns 待导出资源列表
 * @throws {CliError} ID 不存在（退出码 1）或类型不符（退出码 1）
 * @throws {OFDError} 取消或文档关闭
 */
async function selectMediaResources(
  document: OFDDocument,
  media: MediaExportOptions,
  signal: AbortSignal | undefined,
): Promise<readonly MediaResource[]> {
  const options = signal === undefined ? {} : { signal };
  const all = await document.getMediaResources(options);
  if (media.id === undefined) {
    return media.kind === undefined ? all : all.filter((item) => item.kind === media.kind);
  }
  if (!isValidMediaId(media.id)) {
    throw new CliError(
      'CLI_USAGE',
      `--media-id 必须是十进制资源 ID，收到：${sanitizeDisplayText(media.id)}`,
      EXIT_CODES.USAGE,
    );
  }
  const found =
    all.find((item) => item.id === media.id) ??
    (await document.getMediaResource(media.id, options));
  if (found === undefined) {
    throw await describeMissingMediaId(document, media.id, options);
  }
  return media.kind === undefined || found.kind === media.kind ? [found] : [];
}

/**
 * 为查找不到的音视频资源 ID 生成错误。
 *
 * `getMediaResource` 对"图片资源"与"不存在的 ID"都返回 `undefined`，因此再用
 * `hasImageResource`（只查资源索引、不读内容）区分两者：图片资源报
 * `CLI_MEDIA_UNSUPPORTED_TYPE`，其余报 `CLI_MEDIA_NOT_FOUND`。
 *
 * @param document 已打开的文档
 * @param id 未命中的资源 ID
 * @param options 取消信号
 * @returns 待抛出的 CLI 错误
 */
async function describeMissingMediaId(
  document: OFDDocument,
  id: string,
  options: { signal?: AbortSignal },
): Promise<CliError> {
  if (await document.hasImageResource(id, options)) {
    return new CliError(
      'CLI_MEDIA_UNSUPPORTED_TYPE',
      `--media-id 指定的资源 ${sanitizeDisplayText(id)} 是图片而非音视频，无法通过 --media 导出`,
      EXIT_CODES.USAGE,
    );
  }
  return new CliError(
    'CLI_MEDIA_NOT_FOUND',
    `--media-id 指定的音视频资源不存在：${sanitizeDisplayText(id)}`,
    EXIT_CODES.USAGE,
  );
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
 * CLI 单页导出画布的像素上限，单位 像素。
 *
 * 引擎不再内置画布预算（`limits.maxCanvasPixels` 默认 0 = 不限制），由调用方按自身
 * 策略决策；CLI 是批量转图工具，沿用原先的保守上限，避免一次转换把内存打满。
 */
export const CLI_MAX_CANVAS_PIXELS = 64_000_000;

/**
 * 在分配 Canvas 前校验页面像素数。
 *
 * @param page 页面
 * @param pageNumber 页号（1 起）
 * @param dpi 输出 DPI
 * @throws {CliError} 超过 {@link CLI_MAX_CANVAS_PIXELS} 时抛出（退出码 2）
 */
function assertCanvasWithinLimit(page: OFDPage, pageNumber: number, dpi: number): void {
  const viewport = page.getViewport({ dpi });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  if (width * height <= CLI_MAX_CANVAS_PIXELS) return;
  throw new CliError(
    'CLI_PAGE_TOO_LARGE',
    `页面 ${pageNumber} 在 ${dpi} DPI 下为 ${width}×${height} 像素，超过上限 ${CLI_MAX_CANVAS_PIXELS}；请降低 --dpi`,
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
/**
 * 生成结束时打印的单行摘要。
 *
 * 摘要只描述本次实际产出的产物：`--media` 跳过渲染时页进度显示为 0/0。
 *
 * @param summary 汇总数据
 * @returns 单行摘要
 */
function formatSummary(summary: {
  totalPages: number;
  succeededPages: number;
  failedPages: number;
  mediaWritten: number;
  mediaFailed: number;
  interrupted: boolean;
  outDir: string;
  elapsedSeconds: string;
  text: boolean;
  media: boolean;
}): string {
  const mediaOnly = summary.media && !summary.text && summary.totalPages === 0;
  const progress = mediaOnly
    ? `多媒体 ${summary.mediaWritten} 个`
    : `${summary.succeededPages}/${summary.totalPages} 页${
        summary.media ? `，多媒体 ${summary.mediaWritten} 个` : ''
      }`;
  if (summary.interrupted) return `已取消：${progress} → ${summary.outDir}`;
  const mode = summary.text ? '（图片 + 文本）' : '';
  const failed = summary.failedPages + summary.mediaFailed;
  if (failed > 0) {
    const detail = mediaOnly
      ? `${summary.mediaFailed} 个多媒体失败`
      : `${summary.failedPages} 页失败${summary.mediaFailed > 0 ? `，${summary.mediaFailed} 个多媒体失败` : ''}`;
    return `完成：${progress}${mode}，${detail} → ${summary.outDir}`;
  }
  const arrow = mode === '' ? ' →' : '→';
  return `完成：${progress}${mode}${arrow} ${summary.outDir}（${summary.elapsedSeconds}s）`;
}
