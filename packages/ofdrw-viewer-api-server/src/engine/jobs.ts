/**
 * 作业执行：按作业参数逐页导出图片与文本，并导出音视频与附件。
 *
 * 文件名只由服务端生成：`p<NNN>.<ext>`、`p<NNN>.json`、`media-<id>.<ext>`、
 * `attachment-<id>.<ext>`；页号至少补零 3 位，页数更多时按页数位数扩展。
 * 所有写文件走「同目录临时文件 + fsync + rename」原子写；单页失败不中断作业，
 * 通过 `onFailure` 上报后继续；取消信号触发时以 `OFD_ABORTED` 结束。
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isOFDError } from '@ofdrw/ofdrw-viewer-engine';
import type { OFDDocument, PageImageFormat } from '@ofdrw/ofdrw-viewer-engine';
import type { ApiMediaDto } from './export.js';
import {
  SAFE_RESOURCE_ID,
  exportPageImage,
  exportPageText,
  readAttachment,
  readMedia,
  toAttachmentDto,
  toMediaDto,
} from './export.js';
import type { FontFile } from './fonts.js';
import { openDocument } from './open.js';
import { codedError } from './source.js';

/** 作业可选的导出项。 */
export type JobOp = 'images' | 'text' | 'media' | 'attachments';

/** 作业执行参数。 */
export interface JobRunParams {
  /** 导出项；可同时包含多项。 */
  readonly ops: readonly JobOp[];
  /** 选中的页号（1 起，升序去重）；省略表示全部页。 */
  readonly pages?: readonly number[];
  /** 图片输出精度，单位：DPI。 */
  readonly dpi: number;
  /** 图片格式。 */
  readonly format: PageImageFormat;
  /** JPEG/WebP 编码质量，0..1。 */
  readonly quality: number;
  /** 只导出指定媒体类型；需 `ops` 含 `media`。 */
  readonly mediaKind?: 'video' | 'audio';
  /** 只导出指定媒体 ID；需 `ops` 含 `media`。 */
  readonly mediaId?: string;
}

/** 作业执行回调。 */
export interface JobRunCallbacks {
  /**
   * 每页处理结束时回调。
   *
   * @param progress `done` 为已处理页数，`total` 为计划页数，`page` 为刚结束的页号（1 起）
   */
  onProgress(progress: { done: number; total: number; page: number }): void | Promise<void>;
  /**
   * 每写出一个产物文件时回调。
   *
   * @param name 文件名（不含目录）
   * @param kind 产物类型
   * @param size 字节数，单位：byte
   */
  onFile(name: string, kind: 'image' | 'text' | 'media' | 'attachment', size: number): void | Promise<void>;
  /**
   * 单个页面或资源失败时回调；作业继续执行。
   *
   * @param failure 页号（1 起，非页级失败为 0）、错误码与错误消息
   */
  onFailure(failure: { page: number; code: string; message: string }): void | Promise<void>;
  /** 取消信号。 */
  signal: AbortSignal;
}

/** 作业执行输入。 */
export interface JobRunInput {
  /** 已落盘的源文档路径。 */
  readonly sourcePath: string;
  /** 作业目录；不存在时递归创建。 */
  readonly outDir: string;
  /** 已扫描好的补充字体。 */
  readonly fonts?: readonly FontFile[];
  /** 作业参数。 */
  readonly params: JobRunParams;
}

/** 单个页码区间允许的最大跨度（含两端），单位：页。 */
export const MAX_PAGE_RANGE_SPAN = 100_000;

/** 页范围并集允许选择的最大总页数，单位：页。 */
export const MAX_SELECTED_PAGES = 100_000;

/** 页号补零的最短位数，单位：位。 */
const MIN_PAGE_NUMBER_WIDTH = 3;

/** 图片格式到文件扩展名的映射；JPEG 使用 `.jpg`。 */
const IMAGE_EXTENSIONS: Readonly<Record<PageImageFormat, string>> = Object.freeze({
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
});

/** 无法判定扩展名时的回退扩展名（不含点）。 */
const FALLBACK_EXTENSION = 'bin';

/** MIME 类型到文件扩展名的映射；键为小写 MIME，值为不含点的扩展名。 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/x-ms-wma': 'wma',
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-msvideo': 'avi',
  'video/avi': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/x-flv': 'flv',
  'video/quicktime': 'mov',
  'video/x-avs': 'avs',
  'video/avs': 'avs',
  'video/mpeg': 'mpg',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/zip': 'zip',
  'application/json': 'json',
});

/**
 * 解析页码范围，如 `1-3,5`。
 *
 * 支持逗号分隔的单页与闭区间；重复/重叠与乱序输入自动去重升序。
 *
 * @param raw 原始页码范围字符串
 * @returns 升序去重的页号数组（1 起）
 * @throws 带 `CLI_INVALID_PAGES` 码的错误：语法非法、页号小于 1、区间倒置或超过上限
 */
export function parsePageRanges(raw: string): number[] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of raw.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token.trim());
    if (match === null) throw invalidPageRanges(raw);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw invalidPageRanges(raw);
    }
    if (end - start + 1 > MAX_PAGE_RANGE_SPAN) throw pageRangeTooLarge(raw);
    ranges.push({ start, end });
  }

  // 先合并区间再按总页数限流，重叠输入不能被重复计数。
  ranges.sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  let total = 0;
  for (const range of merged) total += range.end - range.start + 1;
  if (total > MAX_SELECTED_PAGES) throw pageRangeTooLarge(raw);

  const pages: number[] = [];
  for (const range of merged) {
    for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
      pages.push(pageNumber);
    }
  }
  return pages;
}

/**
 * 校验页号不超过文档总页数。
 *
 * @param pageNumbers 待校验页号（1 起）
 * @param pageCount 文档总页数
 * @throws 带 `CLI_INVALID_PAGES` 码的错误：页号越界或页数非法
 */
export function validatePageNumbers(pageNumbers: readonly number[], pageCount: number): void {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw codedError('CLI_INVALID_PAGES', `文档页数非法：${pageCount}`);
  }
  const outOfRange = pageNumbers.filter(
    (pageNumber) => !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount,
  );
  if (outOfRange.length > 0) {
    throw codedError(
      'CLI_INVALID_PAGES',
      `页码越界：${outOfRange.join(', ')}（文档共 ${pageCount} 页）`,
    );
  }
}

/**
 * 结合文档页数得到最终页号列表。
 *
 * @param selected 已解析页号；`undefined` 表示全部页
 * @param pageCount 文档总页数
 * @returns 升序页号数组（1 起）
 * @throws 带 `CLI_INVALID_PAGES` 码的错误：页号越界或页数非法
 */
export function resolvePageNumbers(
  selected: readonly number[] | undefined,
  pageCount: number,
): number[] {
  if (selected !== undefined) {
    validatePageNumbers(selected, pageCount);
    return [...new Set(selected)].sort((left, right) => left - right);
  }
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw codedError('CLI_INVALID_PAGES', `文档页数非法：${pageCount}`);
  }
  if (pageCount > MAX_SELECTED_PAGES) {
    throw codedError(
      'CLI_INVALID_PAGES',
      `文档页数过大：${pageCount}，最多支持 ${MAX_SELECTED_PAGES} 页`,
    );
  }
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

/**
 * 构造页码范围语法错误。
 *
 * @param raw 原始范围字符串
 * @returns 带 `CLI_INVALID_PAGES` 码的错误
 */
function invalidPageRanges(raw: string): Error {
  return codedError('CLI_INVALID_PAGES', `页码范围语法非法：${JSON.stringify(raw)}；示例：1-3,5`);
}

/**
 * 构造范围过大错误；在分配/展开前快速失败。
 *
 * @param raw 原始范围字符串
 * @returns 带 `CLI_INVALID_PAGES` 码的错误
 */
function pageRangeTooLarge(raw: string): Error {
  return codedError(
    'CLI_INVALID_PAGES',
    `页码范围过大：单段最多 ${MAX_PAGE_RANGE_SPAN} 页、总计最多 ${MAX_SELECTED_PAGES} 页；收到 ${JSON.stringify(raw)}`,
  );
}

/**
 * 计算页号补零位数。
 *
 * @param pageCount 文档总页数，单位：页
 * @returns `max(3, pageCount 的十进制位数)`
 */
export function pageNumberWidth(pageCount: number): number {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new RangeError(`pageCount 必须为正整数，收到：${pageCount}`);
  }
  return Math.max(MIN_PAGE_NUMBER_WIDTH, String(pageCount).length);
}

/**
 * 由 MIME 类型推导文件扩展名。
 *
 * 先截断 `; charset=` 等参数并按小写查询；无法判定时返回 `bin`。
 *
 * @param mimeType MIME 类型
 * @returns 不含点的扩展名
 */
export function extensionOfMime(mimeType: string): string {
  const essence = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MIME_EXTENSIONS[essence] ?? FALLBACK_EXTENSION;
}

/**
 * 原子写文件：同目录唯一临时文件 → `fsync` → `rename`。
 *
 * 任一步失败都会删除临时文件；成功时不残留临时文件。
 *
 * @param filePath 目标文件路径
 * @param data 文本或二进制内容
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, 'wx');
    await handle.writeFile(data);
    // 先落盘再 rename，避免断电后留下空文件。
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 检查取消信号；已中止时抛出取消错误。
 *
 * @param signal 取消信号
 * @throws 带 `OFD_ABORTED` 码的错误
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw codedError('OFD_ABORTED', '作业已取消');
}

/**
 * 判断错误是否为取消。
 *
 * @param error 任意错误
 * @returns 取消错误或信号已中止时为 true
 */
function isAborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (isOFDError(error) && error.code === 'OFD_ABORTED');
}

/**
 * 提取错误码；非本层错误统一为 `CLI_UNEXPECTED`。
 *
 * @param error 任意错误
 * @returns 错误码
 */
function codeOf(error: unknown): string {
  if (isOFDError(error)) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'CLI_UNEXPECTED';
}

/**
 * 提取错误消息。
 *
 * @param error 任意错误
 * @returns 消息文本
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 执行一个导出作业。
 *
 * 页面按 `pages` 顺序串行处理：每页先写文本再写图片，单页失败只上报
 * `onFailure`；页面处理完毕后依次导出音视频与附件。每个文件写完即调用
 * `onFile`，每页结束调用 `onProgress`。
 *
 * @param input 源文档、输出目录、字体与作业参数
 * @param callbacks 进度、产物、失败回调与取消信号
 * @throws 带 `OFD_ABORTED` 码的错误：已取消
 * @throws 带 `CLI_INVALID_PAGES` 码的错误：页号非法
 * @throws 其他打开/文档级错误：文档无法打开、加密文档等
 */
export async function runJob(
  input: JobRunInput,
  callbacks: JobRunCallbacks,
): Promise<void> {
  const { params, outDir } = input;
  const { signal } = callbacks;
  throwIfAborted(signal);
  await mkdir(outDir, { recursive: true });

  const opened = await openDocument({
    filePath: input.sourcePath,
    fontFiles: input.fonts ?? [],
    signal,
  });
  try {
    const document = opened.document;
    const pageNumbers = resolvePageNumbers(params.pages, document.pageCount);
    const width = pageNumberWidth(document.pageCount);
    const wantsPages = params.ops.includes('images') || params.ops.includes('text');

    if (wantsPages) {
      let done = 0;
      for (const pageNumber of pageNumbers) {
        throwIfAborted(signal);
        await processPage(
          document,
          pageNumber,
          width,
          { ...params, outDir },
          callbacks,
        );
        done += 1;
        throwIfAborted(signal);
        await callbacks.onProgress({ done, total: pageNumbers.length, page: pageNumber });
      }
    }

    if (params.ops.includes('media')) {
      await exportMediaFiles(document, outDir, params, callbacks);
    }
    if (params.ops.includes('attachments')) {
      await exportAttachmentFiles(document, outDir, callbacks);
    }
  } finally {
    await opened.close();
  }
}

/**
 * 处理单页：写文本 JSON 与图片，失败只上报不抛出。
 *
 * @param document 已打开文档
 * @param pageNumber 页号，1 起
 * @param width 页号补零位数
 * @param params 作业参数（含输出目录）
 * @param callbacks 回调与取消信号
 */
async function processPage(
  document: OFDDocument,
  pageNumber: number,
  width: number,
  params: JobRunParams & { readonly outDir: string },
  callbacks: JobRunCallbacks,
): Promise<void> {
  const padded = String(pageNumber).padStart(width, '0');
  if (params.ops.includes('text')) {
    try {
      const result = await exportPageText(document, pageNumber, {
        dpi: params.dpi,
        includeChars: false,
        includeInvisible: false,
        includeAnnotations: true,
        signal: callbacks.signal,
      });
      const name = `p${padded}.json`;
      const body = JSON.stringify(result.items);
      await writeFileAtomic(join(params.outDir, name), body);
      await callbacks.onFile(name, 'text', Buffer.byteLength(body, 'utf8'));
    } catch (error) {
      if (isAborted(error, callbacks.signal)) throw codedError('OFD_ABORTED', '作业已取消');
      await callbacks.onFailure({ page: pageNumber, code: codeOf(error), message: messageOf(error) });
    }
  }

  if (params.ops.includes('images')) {
    try {
      const result = await exportPageImage(document, pageNumber, {
        dpi: params.dpi,
        format: params.format,
        quality: params.quality,
        signal: callbacks.signal,
      });
      const name = `p${padded}.${IMAGE_EXTENSIONS[params.format]}`;
      await writeFileAtomic(join(params.outDir, name), result.data);
      await callbacks.onFile(name, 'image', result.data.byteLength);
    } catch (error) {
      if (isAborted(error, callbacks.signal)) throw codedError('OFD_ABORTED', '作业已取消');
      await callbacks.onFailure({ page: pageNumber, code: codeOf(error), message: messageOf(error) });
    }
  }
}

/**
 * 导出音视频资源：`media-<id>.<ext>`。
 *
 * @param document 已打开文档
 * @param outDir 作业目录
 * @param params 作业参数（媒体筛选条件）
 * @param callbacks 回调与取消信号
 */
async function exportMediaFiles(
  document: OFDDocument,
  outDir: string,
  params: JobRunParams,
  callbacks: JobRunCallbacks,
): Promise<void> {
  const { signal } = callbacks;
  let selected: ApiMediaDto[];
  if (params.mediaId !== undefined) {
    if (!SAFE_RESOURCE_ID.test(params.mediaId)) {
      throw codedError('CLI_USAGE', `mediaId 必须是 1–20 位十进制数字：${JSON.stringify(params.mediaId)}`);
    }
    const resource = await document.getMediaResource(params.mediaId, { signal });
    selected =
      resource === undefined ? [] : [toMediaDto(resource)];
  } else {
    selected = (await document.getMediaResources({ signal })).map(toMediaDto);
  }
  if (params.mediaKind !== undefined) {
    selected = selected.filter((item) => item.kind === params.mediaKind);
  }

  if (params.mediaId !== undefined && selected.length === 0) {
    await callbacks.onFailure({
      page: 0,
      code: 'CLI_MEDIA_NOT_FOUND',
      message: `音视频资源不存在：${params.mediaId}`,
    });
    return;
  }

  for (const resource of selected) {
    throwIfAborted(signal);
    try {
      const bytes = await readMedia(document, resource.id, signal);
      if (bytes === undefined) {
        await callbacks.onFailure({
          page: 0,
          code: 'CLI_MEDIA_NOT_FOUND',
          message: `音视频资源 ${resource.id} 不可用（包内文件缺失或类型不符）`,
        });
        continue;
      }
      const name = `media-${resource.id}.${extensionOfMime(bytes.mime)}`;
      await writeFileAtomic(join(outDir, name), bytes.data);
      await callbacks.onFile(name, 'media', bytes.size);
    } catch (error) {
      if (isAborted(error, signal)) throw codedError('OFD_ABORTED', '作业已取消');
      await callbacks.onFailure({ page: 0, code: codeOf(error), message: messageOf(error) });
    }
  }
}

/**
 * 导出附件：`attachment-<id>.<ext>`。
 *
 * @param document 已打开文档
 * @param outDir 作业目录
 * @param callbacks 回调与取消信号
 */
async function exportAttachmentFiles(
  document: OFDDocument,
  outDir: string,
  callbacks: JobRunCallbacks,
): Promise<void> {
  const { signal } = callbacks;
  const attachments = (await document.getAttachments({ signal })).map(toAttachmentDto);
  for (const attachment of attachments) {
    throwIfAborted(signal);
    if (!SAFE_RESOURCE_ID.test(attachment.id)) continue;
    try {
      const bytes = await readAttachment(document, attachment.id, signal);
      if (bytes === undefined) {
        await callbacks.onFailure({
          page: 0,
          code: 'CLI_MEDIA_NOT_FOUND',
          message: `附件 ${attachment.id} 内容缺失`,
        });
        continue;
      }
      const name = `attachment-${attachment.id}.${extensionOfMime(bytes.mime)}`;
      await writeFileAtomic(join(outDir, name), bytes.data);
      await callbacks.onFile(name, 'attachment', bytes.size);
    } catch (error) {
      if (isAborted(error, signal)) throw codedError('OFD_ABORTED', '作业已取消');
      await callbacks.onFailure({ page: 0, code: codeOf(error), message: messageOf(error) });
    }
  }
}