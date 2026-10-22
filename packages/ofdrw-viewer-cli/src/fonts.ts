/**
 * `--font-dir` 字体目录扫描。
 *
 * 递归收集 `.ttf/.otf/.ttc/.otc`（扩展名大小写不敏感），以 realpath 去重，
 * 并按路径字典序返回，供 engine 的 `supplementaryFonts` 使用。
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { FontInput } from '@ofdrw/ofdrw-viewer-engine';
import { CliError, EXIT_CODES, errorMessage, isCliError, isErrnoError } from './errors.js';
import type { Logger } from './log.js';

/** 支持的字体扩展名（小写）。 */
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);

/** engine `supplementaryFonts` 接收的字体文件项。 */
export interface FontFile {
  /** 字体文件的 realpath。 */
  readonly path: string;
}

/** 判断文件名是否为受支持的字体扩展名（大小写不敏感）。 */
export function isFontFileName(fileName: string): boolean {
  return FONT_EXTENSIONS.has(extname(fileName).toLowerCase());
}

/**
 * 创建 Node 字体来源加载器，供 engine `OFDOpenOptions.loadInput` 使用。
 *
 * `path`/`filePath` 读取本地文件；`url` 使用 fetch。engine 的 Web 默认 loader
 * 不变，CLI 仅在自身进程注入本实现。
 *
 * @returns 字体来源加载器；不支持的来源返回 null。
 */
export function createNodeFontInputLoader(): (
  input: FontInput,
) => Promise<Uint8Array | null> {
  return async (input: FontInput): Promise<Uint8Array | null> => {
    if ('url' in input) {
      if (typeof globalThis.fetch !== 'function') {
        throw new Error('当前 Node 环境没有 fetch，无法加载字体 URL');
      }
      const response = await globalThis.fetch(input.url);
      if (!response.ok) throw new Error(`字体 URL 加载失败：HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    const filePath = 'path' in input ? input.path : 'filePath' in input ? input.filePath : undefined;
    if (filePath === undefined) return null;
    return new Uint8Array(await readFile(filePath));
  };
}

/**
 * 递归扫描字体目录。
 *
 * @param fontDir 字体目录
 * @returns 去重并按路径字典序排列的字体文件列表；目录为空时返回空数组
 * @throws {CliError} 目录不存在、不是目录或不可读取时抛出（退出码 1）
 */
export async function scanFontDirectory(fontDir: string): Promise<FontFile[]> {
  const root = resolve(fontDir);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new CliError(
        'CLI_FONT_DIR_INVALID',
        `字体路径不是目录：${root}`,
        EXIT_CODES.USAGE,
      );
    }
  } catch (error) {
    if (isCliError(error)) throw error;
    if (isErrnoError(error, 'ENOENT')) {
      throw new CliError('CLI_FONT_DIR_INVALID', `字体目录不存在：${root}`, EXIT_CODES.USAGE);
    }
    throw new CliError(
      'CLI_FONT_DIR_UNREADABLE',
      `无法读取字体目录：${root}（${errorMessage(error)}）`,
      EXIT_CODES.USAGE,
    );
  }

  const visitedDirectories = new Set<string>();
  const seenFiles = new Set<string>();
  const fonts: FontFile[] = [];
  await walkFontDirectory(root, visitedDirectories, seenFiles, fonts);
  fonts.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return fonts;
}

/**
 * 扫描字体目录；目录内没有字体时打印 warning 并继续。
 *
 * @param fontDir 字体目录
 * @param logger 日志器
 * @returns 字体文件列表（可能为空）
 */
export async function loadSupplementaryFonts(
  fontDir: string,
  logger: Logger,
): Promise<FontFile[]> {
  const fonts = await scanFontDirectory(fontDir);
  if (fonts.length === 0) {
    logger.warn(
      'W_FONT_DIR_EMPTY',
      `字体目录内未找到 ttf/otf/ttc/otc 文件：${resolve(fontDir)}`,
    );
  }
  return fonts;
}

/**
 * 深度遍历一个目录，收集字体文件。
 *
 * `visitedDirectories` 以 realpath 记录已访问目录，避免符号链接造成的环。
 */
async function walkFontDirectory(
  directory: string,
  visitedDirectories: Set<string>,
  seenFiles: Set<string>,
  fonts: FontFile[],
): Promise<void> {
  let realDirectory: string;
  try {
    realDirectory = await realpath(directory);
  } catch (error) {
    throw new CliError(
      'CLI_FONT_DIR_UNREADABLE',
      `无法解析字体目录：${directory}（${errorMessage(error)}）`,
      EXIT_CODES.USAGE,
    );
  }
  if (visitedDirectories.has(realDirectory)) return;
  visitedDirectories.add(realDirectory);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new CliError(
      'CLI_FONT_DIR_UNREADABLE',
      `无法读取字体目录：${directory}（${errorMessage(error)}）`,
      EXIT_CODES.USAGE,
    );
  }

  // 固定目录内遍历顺序，保证跨平台结果稳定。
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    // 符号链接按目标类型处理：目录继续递归，文件参与扩展名过滤。
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(fullPath);
        isDirectory = info.isDirectory();
        isFile = info.isFile();
      } catch (error) {
        if (isErrnoError(error, 'ENOENT')) continue; // 悬空符号链接：忽略
        throw new CliError(
          'CLI_FONT_DIR_UNREADABLE',
          `无法读取字体路径：${fullPath}（${errorMessage(error)}）`,
          EXIT_CODES.USAGE,
        );
      }
    }

    if (isDirectory) {
      await walkFontDirectory(fullPath, visitedDirectories, seenFiles, fonts);
      continue;
    }
    if (!isFile || !isFontFileName(entry.name)) continue;

    const realFile = await resolveFontFile(fullPath);
    if (realFile === undefined || seenFiles.has(realFile)) continue;
    seenFiles.add(realFile);
    fonts.push({ path: realFile });
  }
}

/** 解析字体文件 realpath；悬空链接返回 `undefined`。 */
async function resolveFontFile(filePath: string): Promise<string | undefined> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isErrnoError(error, 'ENOENT')) return undefined;
    throw new CliError(
      'CLI_FONT_DIR_UNREADABLE',
      `无法读取字体文件：${filePath}（${errorMessage(error)}）`,
      EXIT_CODES.USAGE,
    );
  }
}