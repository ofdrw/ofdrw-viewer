/**
 * 字体来源：字体目录扫描、系统字体发现与字节读取。
 *
 * 两条来源都只读文件系统，收集 `.ttf/.otf/.ttc/.otc`（扩展名大小写不敏感），
 * 以 realpath 去重；字节由本层读好后以 `supplementaryFonts` 交给 engine。
 * 系统字体只读平台白名单目录，不调用外部命令、不访问注册表与网络。
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, posix, resolve, sep, win32 } from 'node:path';
import type { FontInput } from '@ofdrw/ofdrw-viewer-engine';
import { codedError, isErrnoError } from './source.js';

/** 支持的字体扩展名（小写）。 */
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);

/** 单次目录扫描收集的字体文件数上限，单位：个。 */
export const MAX_SCANNED_FONTS = 2000;

/** 单次文档注入的系统字体数量上限，单位：个。 */
export const MAX_SYSTEM_FONTS = 6;

/** 单次文档注入的系统字体总字节预算，单位：byte（96 MiB）。 */
export const MAX_SYSTEM_FONT_BYTES = 96 * 1024 * 1024;

/** CJK 字体文件名关键字（小写）；命中者优先注入，保证中文字形可读。 */
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

/** 字体文件项；`path` 为 realpath。 */
export interface FontFile {
  /** 字体文件的 realpath。 */
  readonly path: string;
}

/** 系统字体发现的可注入参数；默认读取当前平台的白名单目录。 */
export interface SystemFontDiscoveryOptions {
  /** 平台名，默认 `process.platform`。 */
  readonly platform?: string;
  /** 环境变量，默认 `process.env`（Windows 用于定位字体目录）。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 用户主目录，默认 `os.homedir()`。 */
  readonly homeDir?: string;
  /** 覆盖白名单目录（测试注入）；提供时忽略平台。 */
  readonly directories?: readonly string[];
  /** 扫描的字体文件数上限，单位：个；默认 {@link MAX_SCANNED_FONTS}。 */
  readonly maxFonts?: number;
  /** 注入的字体数量上限，单位：个；默认 {@link MAX_SYSTEM_FONTS}。 */
  readonly maxSystemFonts?: number;
  /** 注入字体的总字节预算，单位：byte；默认 {@link MAX_SYSTEM_FONT_BYTES}。 */
  readonly maxTotalBytes?: number;
}

/** 系统字体发现结果。 */
export interface SystemFontDiscoveryResult {
  /** 按优先级排序并截断后的字体文件。 */
  readonly fonts: readonly FontFile[];
  /** 去重后扫描到的字体文件总数，单位：个（含被注入上限截断的部分）。 */
  readonly scannedFiles: number;
  /** 入选字体的总字节数，单位：byte（不超过 `maxTotalBytes`）。 */
  readonly scannedBytes: number;
}

/**
 * 判断文件名是否为受支持的字体扩展名（大小写不敏感）。
 *
 * @param fileName 文件名
 * @returns 受支持时为 true
 */
export function isFontFileName(fileName: string): boolean {
  return FONT_EXTENSIONS.has(extname(fileName).toLowerCase());
}

/**
 * 读取全部字体文件字节，供 engine `supplementaryFonts` 使用。
 *
 * 单个文件读取失败时跳过并继续，不影响其余字体；结果顺序与输入一致。
 *
 * @param files 字体文件列表（调用方负责“用户字体在前、系统字体在后”的排序）
 * @returns 已读好的字体输入；全部失败时为空数组
 */
export async function loadFontInputs(files: readonly FontFile[]): Promise<FontInput[]> {
  const inputs: FontInput[] = [];
  for (const file of files) {
    try {
      inputs.push({ data: new Uint8Array(await readFile(file.path)) });
    } catch {
      // 单个字体不可读不阻断文档打开，engine 会回退到其余字体。
    }
  }
  return inputs;
}

/**
 * 合并用户字体与系统字体。
 *
 * 按 realpath 去重，`userFonts` 保持原顺序并排在前面，系统字体依次追加。
 *
 * @param userFonts 用户字体目录扫描结果
 * @param systemFonts 系统字体发现结果
 * @returns 去重后的合并列表
 */
export function mergeFontFiles(
  userFonts: readonly FontFile[],
  systemFonts: readonly FontFile[],
): FontFile[] {
  const seen = new Set(userFonts.map((font) => font.path));
  const merged = [...userFonts];
  for (const font of systemFonts) {
    if (seen.has(font.path)) continue;
    seen.add(font.path);
    merged.push(font);
  }
  return merged;
}

/**
 * 递归扫描字体目录。
 *
 * @param dir 字体目录
 * @returns 去重并按路径字典序排列的字体文件；目录内无字体时为空数组
 * @throws 带 `CLI_FONT_DIR_INVALID`/`CLI_FONT_DIR_UNREADABLE` 码的错误
 */
export async function scanFontDirectory(dir: string): Promise<FontFile[]> {
  const root = resolve(dir);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw codedError('CLI_FONT_DIR_INVALID', `字体路径不是目录：${root}`);
    }
  } catch (error) {
    if (isCoded(error)) throw error;
    if (isErrnoError(error, 'ENOENT')) {
      throw codedError('CLI_FONT_DIR_INVALID', `字体目录不存在：${root}`);
    }
    throw codedError('CLI_FONT_DIR_UNREADABLE', `无法读取字体目录：${root}（${messageOf(error)}）`);
  }

  const state: FontWalkState = {
    visitedDirectories: new Set<string>(),
    seenFiles: new Set<string>(),
    fonts: [],
  };
  await walkFontDirectory(root, state);
  state.fonts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return state.fonts;
}

/** 用户字体目录扫描状态。 */
interface FontWalkState {
  /** 已访问目录的 realpath，避免符号链接成环。 */
  readonly visitedDirectories: Set<string>;
  /** 已收集字体文件的 realpath。 */
  readonly seenFiles: Set<string>;
  /** 已收集字体文件。 */
  readonly fonts: FontFile[];
}

/** 系统字体发现结果缓存；键由目录与限额组成。 */
const systemFontCache = new Map<string, Promise<SystemFontDiscoveryResult>>();

/**
 * 按平台白名单发现系统字体。
 *
 * 只读白名单目录；结果按 CJK 优先级排序后截断到 `maxSystemFonts`，总字节不超过
 * `maxTotalBytes`。同一组目录与限额在进程内只扫描一次。
 *
 * @param options 可注入参数；目录不存在或不可读时返回空结果
 * @returns 排序截断后的字体列表与扫描统计
 */
export async function discoverSystemFonts(
  options: SystemFontDiscoveryOptions = {},
): Promise<SystemFontDiscoveryResult> {
  const maxFonts = options.maxFonts ?? MAX_SCANNED_FONTS;
  const maxSystemFonts = options.maxSystemFonts ?? MAX_SYSTEM_FONTS;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_SYSTEM_FONT_BYTES;
  const directories =
    options.directories ?? systemFontDirectories(options.platform, options.env, options.homeDir);

  const cacheKey = `${maxFonts}|${maxSystemFonts}|${maxTotalBytes}|${directories.join('\u0000')}`;
  const cached = systemFontCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pending = scanSystemFonts(directories, { maxFonts, maxSystemFonts, maxTotalBytes });
  systemFontCache.set(cacheKey, pending);
  // 意外异常不留在缓存里，下次调用可重试。
  pending.catch(() => {
    if (systemFontCache.get(cacheKey) === pending) systemFontCache.delete(cacheKey);
  });
  return pending;
}

/** 清空系统字体发现缓存。 */
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

/** 系统字体扫描限额。 */
interface SystemFontScanLimits {
  /** 字体文件数上限，单位：个。 */
  readonly maxFonts: number;
  /** 注入字体数上限，单位：个。 */
  readonly maxSystemFonts: number;
  /** 字体总字节预算，单位：byte。 */
  readonly maxTotalBytes: number;
}

/** 一次系统字体扫描的共享状态。 */
interface SystemFontScanState {
  /** 扫描限额。 */
  readonly limits: SystemFontScanLimits;
  /** 白名单根的 realpath；文件 realpath 必须位于其中之一。 */
  readonly allowedRoots: readonly string[];
  /** 已访问目录的 realpath。 */
  readonly seenDirectories: Set<string>;
  /** 已收集文件的 realpath。 */
  readonly seenFiles: Set<string>;
  /** 已收集字体文件的 realpath。 */
  readonly found: string[];
  /** 字体 realpath → 字节数，单位：byte。 */
  readonly sizes: Map<string, number>;
}

/**
 * 扫描全部白名单目录，按优先级排序后应用数量与字节预算。
 *
 * @param directories 白名单目录
 * @param limits 数量与字节限额
 * @returns 发现结果；单个目录失败只跳过该目录
 */
async function scanSystemFonts(
  directories: readonly string[],
  limits: SystemFontScanLimits,
): Promise<SystemFontDiscoveryResult> {
  const allowedRoots: string[] = [];
  for (const directory of directories) {
    try {
      allowedRoots.push(await realpath(directory));
    } catch {
      // 目录不存在时由遍历阶段统一按“无字体”处理。
    }
  }

  const state: SystemFontScanState = {
    limits,
    allowedRoots,
    seenDirectories: new Set<string>(),
    seenFiles: new Set<string>(),
    found: [],
    sizes: new Map<string, number>(),
  };
  for (const directory of directories) {
    if (state.found.length >= limits.maxFonts) break;
    await walkSystemFontDirectory(directory, state);
  }

  const sorted = [...state.found].sort(compareSystemFontPriority);
  const fonts: FontFile[] = [];
  let bytes = 0;
  // 单个字体放不下时跳过并继续尝试后续更小的字体，名额不被白占。
  for (const path of sorted) {
    if (fonts.length >= limits.maxSystemFonts) break;
    const size = state.sizes.get(path) ?? 0;
    if (bytes + size > limits.maxTotalBytes) continue;
    fonts.push({ path });
    bytes += size;
  }
  return { fonts, scannedFiles: sorted.length, scannedBytes: bytes };
}

/**
 * 容错遍历一个系统字体目录。
 *
 * 目录不存在、不可读或链接损坏时静默跳过；符号链接目录不跟随，字体文件
 * （含符号链接）的 realpath 必须仍位于白名单根之下。
 *
 * @param directory 目录路径
 * @param state 扫描共享状态
 */
async function walkSystemFontDirectory(
  directory: string,
  state: SystemFontScanState,
): Promise<void> {
  if (state.found.length >= state.limits.maxFonts) return;

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
    if (state.found.length >= state.limits.maxFonts) return;
    const fullPath = join(directory, entry.name);

    if (entry.isSymbolicLink() && (await isDirectoryTarget(fullPath))) continue;
    if (entry.isDirectory()) {
      await walkSystemFontDirectory(fullPath, state);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!isFontFileName(entry.name)) continue;

    let realFile: string;
    try {
      realFile = await realpath(fullPath);
    } catch {
      continue;
    }
    if (!isPathInsideRoots(realFile, state.allowedRoots)) continue;
    if (state.seenFiles.has(realFile)) continue;

    let size: number;
    try {
      size = (await stat(realFile)).size;
    } catch {
      continue;
    }
    state.seenFiles.add(realFile);
    state.found.push(realFile);
    state.sizes.set(realFile, size);
  }
}

/**
 * 判断符号链接是否指向目录；悬空链接返回 false。
 *
 * @param fullPath 链接路径
 * @returns 目标为目录时为 true
 */
async function isDirectoryTarget(fullPath: string): Promise<boolean> {
  try {
    return (await stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 判断路径是否位于任一白名单根的 realpath 之下。
 *
 * 使用分隔符边界比较，避免 `/usr/share/fonts-evil` 误匹配 `/usr/share/fonts`。
 *
 * @param filePath 已规范化的字体文件路径
 * @param roots 白名单根的 realpath 列表
 * @returns 位于任一白名单根之下时为 true
 */
function isPathInsideRoots(filePath: string, roots: readonly string[]): boolean {
  const caseInsensitive = process.platform === 'win32';
  const candidate = caseInsensitive ? filePath.toLowerCase() : filePath;
  return roots.some((root) => {
    const normalizedRoot = caseInsensitive ? root.toLowerCase() : root;
    return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${sep}`);
  });
}

/**
 * 按目录项名称排序，保证同目录内遍历顺序稳定。
 *
 * @param left 目录项
 * @param right 目录项
 * @returns 比较结果
 */
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

/**
 * 先按优先级、再按路径字典序排序，保证结果跨进程可复现。
 *
 * @param left 字体路径
 * @param right 字体路径
 * @returns 比较结果
 */
function compareSystemFontPriority(left: string, right: string): number {
  const byPriority = systemFontPriority(left) - systemFontPriority(right);
  if (byPriority !== 0) return byPriority;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 深度遍历一个目录收集字体文件；`visitedDirectories` 以 realpath 记录已访问目录。
 *
 * @param directory 目录路径
 * @param state 扫描状态
 */
async function walkFontDirectory(directory: string, state: FontWalkState): Promise<void> {
  if (state.fonts.length >= MAX_SCANNED_FONTS) return;

  let realDirectory: string;
  try {
    realDirectory = await realpath(directory);
  } catch (error) {
    throw codedError(
      'CLI_FONT_DIR_UNREADABLE',
      `无法解析字体目录：${directory}（${messageOf(error)}）`,
    );
  }
  if (state.visitedDirectories.has(realDirectory)) return;
  state.visitedDirectories.add(realDirectory);

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw codedError(
      'CLI_FONT_DIR_UNREADABLE',
      `无法读取字体目录：${directory}（${messageOf(error)}）`,
    );
  }
  entries.sort(compareDirentByName);

  for (const entry of entries) {
    if (state.fonts.length >= MAX_SCANNED_FONTS) return;
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
        if (isErrnoError(error, 'ENOENT')) continue;
        throw codedError(
          'CLI_FONT_DIR_UNREADABLE',
          `无法读取字体路径：${fullPath}（${messageOf(error)}）`,
        );
      }
    }

    if (isDirectory) {
      await walkFontDirectory(fullPath, state);
      continue;
    }
    if (!isFile || !isFontFileName(entry.name)) continue;

    const realFile = await resolveFontFile(fullPath);
    if (realFile === undefined || state.seenFiles.has(realFile)) continue;
    state.seenFiles.add(realFile);
    state.fonts.push({ path: realFile });
  }
}

/**
 * 解析字体文件 realpath；悬空链接返回 `undefined`。
 *
 * @param filePath 字体文件路径
 * @returns realpath 或 undefined
 * @throws 带 `CLI_FONT_DIR_UNREADABLE` 码的错误
 */
async function resolveFontFile(filePath: string): Promise<string | undefined> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isErrnoError(error, 'ENOENT')) return undefined;
    throw codedError(
      'CLI_FONT_DIR_UNREADABLE',
      `无法读取字体文件：${filePath}（${messageOf(error)}）`,
    );
  }
}

/**
 * 判断错误是否已带本层错误码。
 *
 * @param error 任意错误值
 * @returns 带字符串 `code` 字段时为 true
 */
function isCoded(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === 'string';
}

/**
 * 提取错误消息文本。
 *
 * @param error 任意错误值
 * @returns 消息文本
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}