/**
 * 输出目录、文件命名与原子写。
 *
 * 命名规则：`<out>/<stem>-p<NNN>.<ext>`，页号至少 3 位；页数更多时按
 * `pageCount` 的十进制位数扩展（例如 1000 页时为 4 位）。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { CliError, EXIT_CODES, errorMessage, isCliError, isErrnoError } from './errors.js';

/** 支持的图片格式，与 engine 的 `PageImageFormat` 一致。 */
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;

/** 图片格式类型。 */
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** 图片格式到文件扩展名的映射；JPEG 使用常见的 `.jpg`。 */
const IMAGE_EXTENSIONS: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

/** 页号的最短位数。 */
const MIN_PAGE_NUMBER_WIDTH = 3;

/** 返回图片格式对应的文件扩展名（不含点）。 */
export function getImageExtension(format: ImageFormat): string {
  return IMAGE_EXTENSIONS[format];
}

/**
 * 计算页号补零位数。
 *
 * @param pageCount 文档总页数，必须为正整数
 * @returns `max(3, pageCount 的十进制位数)`
 */
export function pageNumberWidth(pageCount: number): number {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new RangeError(`pageCount 必须为正整数，收到：${pageCount}`);
  }
  return Math.max(MIN_PAGE_NUMBER_WIDTH, String(pageCount).length);
}

/**
 * 生成单页图片文件名。
 *
 * @param stem 输入文件 stem（含中文、空格时原样保留）
 * @param pageNumber 页号，1 起
 * @param format 图片格式
 * @param pageCount 文档总页数
 */
export function buildImageFileName(
  stem: string,
  pageNumber: number,
  format: ImageFormat,
  pageCount: number,
): string {
  assertPageNumber(pageNumber);
  const padded = String(pageNumber).padStart(pageNumberWidth(pageCount), '0');
  return `${stem}-p${padded}.${getImageExtension(format)}`;
}

/**
 * 生成单页图片的绝对路径。
 *
 * @param outDir 输出目录
 * @param stem 输入文件 stem
 * @param pageNumber 页号，1 起
 * @param format 图片格式
 * @param pageCount 文档总页数
 */
export function buildImagePath(
  outDir: string,
  stem: string,
  pageNumber: number,
  format: ImageFormat,
  pageCount: number,
): string {
  return join(outDir, buildImageFileName(stem, pageNumber, format, pageCount));
}

/**
 * 生成单页空间文本 JSON 的绝对路径。
 *
 * 与图片使用相同的页号补零规则；`--text` 时每页写 `<stem>-p<NNN>.json`。
 *
 * @param outDir 输出目录
 * @param stem 输入文件 stem
 * @param pageNumber 页号，1 起
 * @param pageCount 文档总页数
 */
export function buildTextJsonPath(
  outDir: string,
  stem: string,
  pageNumber: number,
  pageCount: number,
): string {
  assertPageNumber(pageNumber);
  const padded = String(pageNumber).padStart(pageNumberWidth(pageCount), '0');
  return join(outDir, `${stem}-p${padded}.json`);
}

/**
 * 计算默认输出目录：当前工作目录下的输入文件 stem。
 *
 * @param inputPath 输入文件路径
 * @param cwd 当前工作目录，默认 `process.cwd()`
 */
export function resolveDefaultOutputDir(inputPath: string, cwd: string = process.cwd()): string {
  return resolve(cwd, parse(inputPath).name);
}

/**
 * 确保输出目录存在且为目录。
 *
 * 不存在时递归创建；路径已存在但不是目录时报用法错误（退出码 1）。
 *
 * @param outDir 输出目录路径
 */
export async function prepareOutputDirectory(outDir: string): Promise<void> {
  try {
    const info = await stat(outDir);
    if (!info.isDirectory()) {
      throw new CliError(
        'CLI_OUTPUT_NOT_DIRECTORY',
        `输出路径不是目录：${outDir}`,
        EXIT_CODES.USAGE,
      );
    }
    return;
  } catch (error) {
    if (isCliError(error)) throw error;
    if (!isErrnoError(error, 'ENOENT')) {
      throw new CliError(
        'CLI_OUTPUT_CREATE_FAILED',
        `无法检查输出目录：${outDir}（${errorMessage(error)}）`,
        EXIT_CODES.USAGE,
      );
    }
  }

  try {
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    throw new CliError(
      'CLI_OUTPUT_CREATE_FAILED',
      `无法创建输出目录：${outDir}（${errorMessage(error)}）`,
      EXIT_CODES.USAGE,
    );
  }
}

/**
 * 原子写文件：同目录写入唯一临时文件，`fsync` 后 `rename` 替换目标。
 *
 * 任一步失败都会删除临时文件；成功时不残留临时文件。
 *
 * @param filePath 目标文件路径
 * @param data 文本或二进制内容
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: FileHandle | undefined;

  try {
    handle = await open(tempPath, 'wx');
    await handle.writeFile(data);
    // 先落盘再 rename，避免断电后留下空文件；失败时同样清理临时文件。
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 校验页号为正整数，供内部命名函数复用。 */
function assertPageNumber(pageNumber: number): void {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(`pageNumber 必须为正整数，收到：${pageNumber}`);
  }
}
