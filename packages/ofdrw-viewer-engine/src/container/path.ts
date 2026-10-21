/**
 * 包内路径解析与安全校验。
 *
 * 规则：统一 `/` 分隔、去前导 `/`、折叠 `.`、拒绝 `..` 逃出包根、
 * 拒绝 Windows 盘符/UNC/控制字符。ZIP 条目名与 OFD 的 `BaseLoc`/`MediaFile`
 * 都按本文件的规范化结果查找。
 */

import { OFDError } from '../errors';

/** Windows 盘符（`C:`）或 URL scheme；不允许出现在包内路径。 */
const DRIVE_OR_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** 文件名中不允许的控制字符。 */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * 规范化包内路径：去前导 `/`、折叠 `.`、校验 `..` 不越界。
 *
 * @param path 原始包内路径；允许 `/` 开头的包内绝对路径。
 * @returns 规范化路径；根目录返回空串。
 * @throws OFDError `OFD_INVALID_PACKAGE` 当路径穿越、盘符/UNC 或包含控制字符时。
 */
export function normalizePackagePath(path: string): string {
  const raw = path.trim();
  if (raw.length === 0) return '';
  if (CONTROL_CHAR.test(raw)) {
    throw new OFDError('OFD_INVALID_PACKAGE', `包内路径包含控制字符：${JSON.stringify(path)}`);
  }

  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('//')) {
    throw new OFDError('OFD_INVALID_PACKAGE', `不允许 UNC/网络路径：${JSON.stringify(path)}`);
  }
  if (DRIVE_OR_SCHEME.test(unified)) {
    throw new OFDError('OFD_INVALID_PACKAGE', `不允许绝对文件系统路径或 URL：${JSON.stringify(path)}`);
  }

  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new OFDError('OFD_INVALID_PACKAGE', `路径穿越包根：${JSON.stringify(path)}`);
      }
      segments.pop();
      continue;
    }
    if (segment.includes(':')) {
      throw new OFDError('OFD_INVALID_PACKAGE', `包内路径段包含冒号：${JSON.stringify(path)}`);
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 校验路径是否安全（不越出包根）。
 *
 * @param path 包内路径。
 * @throws OFDError 当路径穿越或包含非法段时。
 */
export function assertSafePackagePath(path: string): void {
  normalizePackagePath(path);
}

/**
 * 解析相对路径。
 *
 * @param baseDir 基准目录，包内路径（无前导 `/`）。
 * @param relative 相对路径或 `/` 开头的包内绝对路径。
 * @returns 规范化后的包内绝对路径（无前导 `/`）。
 * @throws OFDError 当路径穿越或包含非法段时。
 */
export function resolvePackagePath(baseDir: string, relative: string): string {
  const target = relative.trim();
  if (target.startsWith('/') || target.startsWith('\\')) {
    return normalizePackagePath(target);
  }
  if (DRIVE_OR_SCHEME.test(target)) {
    // 绝对文件系统路径不允许作为包内相对路径。
    return normalizePackagePath(target);
  }
  const base = normalizePackagePath(baseDir);
  if (target.length === 0) return base;
  return normalizePackagePath(base.length > 0 ? `${base}/${target}` : target);
}

/**
 * 取父目录。
 *
 * @param path 包内路径。
 * @returns 父目录；根目录或没有父目录时返回空串。
 */
export function dirnameOf(path: string): string {
  const normalized = normalizePackagePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}