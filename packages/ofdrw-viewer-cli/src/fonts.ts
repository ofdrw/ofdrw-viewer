/**
 * 字体来源：`--font-dir` 目录扫描与系统字体自动发现。
 *
 * 两者都只读文件系统、收集 `.ttf/.otf/.ttc/.otc`（扩展名大小写不敏感），
 * 并以 realpath 去重；结果直接用于 engine 的 `supplementaryFonts`。
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, posix, resolve, win32 } from 'node:path';
import type { FontInput } from '@ofdrw/ofdrw-viewer-engine';
import { CliError, EXIT_CODES, errorMessage, isCliError, isErrnoError } from './errors.js';
import type { Logger } from './log.js';

/** 支持的字体扩展名（小写）。 */
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);

/** 系统字体扫描的文件数上限，避免超大字体目录拖慢启动。 */
export const MAX_SCANNED_FONTS = 2000;

/** 单次转换注入的系统字体数量上限，避免逐个读取解析全部系统字体。 */
export const MAX_SYSTEM_FONTS = 16;

/**
 * CJK 字体文件名关键字（小写）。
 *
 * 命中者优先注入：缺省字体方案的首要目标是让中文字形可读。
 */
const CJK_FONT_KEYWORDS = [
  'cjk',
  'noto',
  'sourcehan',
  'source-han',
  'simsun',
  'simhei',
  'msyh',
  'pingfang',
  'fangsong',
  'kaiti',
  'heiti',
  'songti',
  'yahei',
  'wqy',
  'wenquanyi',
  'uming',
  'ukai',
  'arphic',
  'hiragino',
  'droid',
] as const;

/** 常见西文衬线/无衬线字体关键字（小写），作为 CJK 之后的次级优先项。 */
const LATIN_FONT_KEYWORDS = [
  'dejavu',
  'liberation',
  'freesans',
  'freefont',
  'arial',
  'helvetica',
  'times',
  'verdana',
  'georgia',
  'tahoma',
  'segoe',
  'roboto',
  'ubuntu',
  'cantarell',
] as const;

/** engine `supplementaryFonts` 接收的字体文件项。 */
export interface FontFile {
  /** 字体文件的 realpath。 */
  readonly path: string;
}

/** 系统字体发现的可注入参数；默认读取当前平台的白名单目录。 */
export interface SystemFontDiscoveryOptions {
  /** 平台名，默认 `process.platform`。 */
  readonly platform?: string;
  /** 环境变量，默认 `process.env`（Windows 用于定位 `%WINDIR%`/`%LOCALAPPDATA%`）。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 用户主目录，默认 `os.homedir()`。 */
  readonly homeDir?: string;
  /** 覆盖白名单目录（测试注入）；提供时忽略平台。 */
  readonly directories?: readonly string[];
  /** 扫描的字体文件数上限，默认 {@link MAX_SCANNED_FONTS}。 */
  readonly maxFonts?: number;
  /** 注入的字体数量上限，默认 {@link MAX_SYSTEM_FONTS}。 */
  readonly maxSystemFonts?: number;
}

/** 系统字体发现结果。 */
export interface SystemFontDiscoveryResult {
  /** 按优先级排序并截断后的字体文件，供 `supplementaryFonts` 使用。 */
  readonly fonts: readonly FontFile[];
  /** 去重后扫描到的字体文件总数（含被注入上限截断的部分）。 */
  readonly scannedFiles: number;
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

/** 系统字体发现结果缓存；键由目录与限额组成，避免测试注入时互相命中。 */
const systemFontCache = new Map<string, Promise<SystemFontDiscoveryResult>>();

/**
 * 发现系统字体并向 stderr 输出一行数量日志。
 *
 * 目录不存在或不可读时返回空数组，不报错、不中断转换。
 *
 * @param logger 日志器；数量日志走 `detail`（stderr），不污染 stdout
 * @param options 可注入的平台/目录/限额；省略时使用当前平台白名单
 * @returns 按 CJK 优先级排序后截断的字体文件列表
 */
export async function loadSystemFonts(
  logger: Logger,
  options: SystemFontDiscoveryOptions = {},
): Promise<FontFile[]> {
  const result = await discoverSystemFonts(options);
  logger.detail(
    `自动发现系统字体 ${result.fonts.length} 个（扫描 ${result.scannedFiles} 个文件）`,
  );
  return [...result.fonts];
}

/**
 * 按平台白名单发现系统字体。
 *
 * 只读白名单目录，不调用 `fc-list`、不访问注册表与网络；结果按 CJK 关键字
 * 优先级排序后截断到 `maxSystemFonts`。同一组目录与限额在本进程内只扫描一次。
 *
 * @param options 可注入参数；目录不存在或不可读时返回空结果
 * @returns 排序截断后的字体列表与扫描文件数
 */
export async function discoverSystemFonts(
  options: SystemFontDiscoveryOptions = {},
): Promise<SystemFontDiscoveryResult> {
  const maxFonts = options.maxFonts ?? MAX_SCANNED_FONTS;
  const maxSystemFonts = options.maxSystemFonts ?? MAX_SYSTEM_FONTS;
  const directories =
    options.directories ??
    systemFontDirectories(options.platform, options.env, options.homeDir);

  const cacheKey = `${maxFonts}|${maxSystemFonts}|${directories.join('\u0000')}`;
  const cached = systemFontCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pending = scanSystemFonts(directories, maxFonts, maxSystemFonts);
  systemFontCache.set(cacheKey, pending);
  // 意外异常不留在缓存里，下次调用可重试。
  pending.catch(() => {
    if (systemFontCache.get(cacheKey) === pending) systemFontCache.delete(cacheKey);
  });
  return pending;
}

/** 清空系统字体发现缓存（测试用）。 */
export function clearSystemFontCache(): void {
  systemFontCache.clear();
}

/**
 * 返回平台白名单系统字体目录。
 *
 * @param platform 平台名，默认 `process.platform`
 * @param env 环境变量，默认 `process.env`
 * @param homeDir 用户主目录，默认 `os.homedir()`
 * @returns 只读白名单目录；未知平台返回空数组
 */
export function systemFontDirectories(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = safeHomeDirectory(),
): string[] {
  switch (platform) {
    case 'linux':
      return [
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        ...(homeDir.length === 0
          ? []
          : [posix.join(homeDir, '.fonts'), posix.join(homeDir, '.local', 'share', 'fonts')]),
      ];
    case 'darwin':
      return [
        '/System/Library/Fonts',
        '/Library/Fonts',
        ...(homeDir.length === 0 ? [] : [posix.join(homeDir, 'Library', 'Fonts')]),
      ];
    case 'win32': {
      const directories: string[] = [];
      const windowsDir = env.WINDIR ?? env.SystemRoot;
      if (windowsDir !== undefined && windowsDir.length > 0) {
        directories.push(win32.join(windowsDir, 'Fonts'));
      }
      const localAppData = env.LOCALAPPDATA;
      if (localAppData !== undefined && localAppData.length > 0) {
        directories.push(win32.join(localAppData, 'Microsoft', 'Windows', 'Fonts'));
      }
      return directories;
    }
    default:
      return [];
  }
}

/** 读取用户主目录；不可用时返回空串，由调用方跳过相关目录。 */
function safeHomeDirectory(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

/** 一次系统字体扫描的共享状态。 */
interface SystemFontScanState {
  /** 字体文件数上限。 */
  readonly maxFonts: number;
  /** 已访问目录的 realpath，避免符号链接成环。 */
  readonly seenDirectories: Set<string>;
  /** 已收集文件的 realpath，用于去重。 */
  readonly seenFiles: Set<string>;
  /** 已收集字体文件的 realpath。 */
  readonly found: string[];
}

/**
 * 扫描全部白名单目录，排序并截断。
 *
 * @param directories 白名单目录
 * @param maxFonts 扫描字体文件数上限
 * @param maxSystemFonts 注入字体数上限
 * @returns 发现结果；单个目录失败只跳过该目录
 */
async function scanSystemFonts(
  directories: readonly string[],
  maxFonts: number,
  maxSystemFonts: number,
): Promise<SystemFontDiscoveryResult> {
  const state: SystemFontScanState = {
    maxFonts,
    seenDirectories: new Set<string>(),
    seenFiles: new Set<string>(),
    found: [],
  };
  for (const directory of directories) {
    if (state.found.length >= maxFonts) break;
    await walkSystemFontDirectory(directory, state);
  }

  const sorted = [...state.found].sort(compareSystemFontPriority);
  return {
    fonts: sorted.slice(0, maxSystemFonts).map((path) => ({ path })),
    scannedFiles: sorted.length,
  };
}

/**
 * 容错遍历一个系统字体目录。
 *
 * 与 `--font-dir` 的严格扫描不同：目录不存在、不可读或链接损坏时静默跳过，
 * 不产生错误，也不影响其他目录。
 *
 * @param directory 目录路径
 * @param state 扫描共享状态
 */
async function walkSystemFontDirectory(
  directory: string,
  state: SystemFontScanState,
): Promise<void> {
  if (state.found.length >= state.maxFonts) return;

  let realDirectory: string;
  try {
    realDirectory = await realpath(directory);
  } catch {
    return;
  }
  if (state.seenDirectories.has(realDirectory)) return;
  state.seenDirectories.add(realDirectory);

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort(compareDirentByName);

  for (const entry of entries) {
    if (state.found.length >= state.maxFonts) return;
    const fullPath = join(directory, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    // 符号链接按目标类型处理；悬空链接直接跳过。
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(fullPath);
        isDirectory = info.isDirectory();
        isFile = info.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      await walkSystemFontDirectory(fullPath, state);
      continue;
    }
    if (!isFile || !isFontFileName(entry.name)) continue;

    let realFile: string;
    try {
      realFile = await realpath(fullPath);
    } catch {
      continue;
    }
    if (state.seenFiles.has(realFile)) continue;
    state.seenFiles.add(realFile);
    state.found.push(realFile);
  }
}

/** 按目录项名称排序，保证同目录内遍历顺序稳定。 */
function compareDirentByName(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * 计算系统字体优先级：CJK 关键字 0，常见西文 1，其他 2。
 *
 * @param filePath 字体文件路径
 * @returns 优先级数值，越小越优先
 */
function systemFontPriority(filePath: string): number {
  const fileName = basename(filePath).toLowerCase();
  if (CJK_FONT_KEYWORDS.some((keyword) => fileName.includes(keyword))) return 0;
  if (LATIN_FONT_KEYWORDS.some((keyword) => fileName.includes(keyword))) return 1;
  return 2;
}

/** 先按优先级、再按路径字典序排序，保证结果跨进程可复现。 */
function compareSystemFontPriority(left: string, right: string): number {
  const byPriority = systemFontPriority(left) - systemFontPriority(right);
  if (byPriority !== 0) return byPriority;
  return left < right ? -1 : left > right ? 1 : 0;
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