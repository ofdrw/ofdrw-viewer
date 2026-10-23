/**
 * 明文容器包内路径规范化与安全校验。
 *
 * 规则与 engine 默认 ZIP 容器保持一致：统一 `/`、去前导 `/`、折叠 `.`、
 * 拒绝 `..` 越界、拒绝盘符/UNC/控制字符；路径大小写敏感，不做 Unicode 归一化。
 */

import { OFDError } from '@ofdrw/ofdrw-viewer-engine';

/** Windows 盘符或 URL scheme。 */
const DRIVE_OR_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** 控制字符。 */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * 规范化包内路径。
 *
 * @param path 原始路径；允许前导 `/`。
 * @returns 规范化路径；根路径返回空串。
 * @throws OFDError `OFD_INVALID_PACKAGE`：路径穿越、UNC、盘符或控制字符。
 */
export function normalizeVirtualPath(path: string): string {
  if (typeof path !== 'string') {
    throw new OFDError('OFD_INVALID_PACKAGE', '包内路径必须是字符串');
  }
  const raw = path.trim();
  if (raw.length === 0) return '';
  if (CONTROL_CHAR.test(raw)) {
    throw new OFDError('OFD_INVALID_PACKAGE', '包内路径包含控制字符');
  }
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('//')) {
    throw new OFDError('OFD_INVALID_PACKAGE', '不允许 UNC 路径');
  }
  if (DRIVE_OR_SCHEME.test(unified)) {
    throw new OFDError('OFD_INVALID_PACKAGE', '不允许盘符或 URL 作为包内路径');
  }
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new OFDError('OFD_INVALID_PACKAGE', '路径穿越包根');
      }
      segments.pop();
      continue;
    }
    if (segment.includes(':')) {
      throw new OFDError('OFD_INVALID_PACKAGE', '包内路径段包含冒号');
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 取包内路径的父目录。
 *
 * @param path 包内路径。
 * @returns 父目录；根目录返回空串。
 */
export function dirnameVirtualPath(path: string): string {
  const normalized = normalizeVirtualPath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

/**
 * 相对目录解析包内路径。
 *
 * @param baseDir 基准目录，包内路径。
 * @param relative 相对路径，或以 `/` 开头的包内绝对路径。
 * @returns 规范化路径。
 */
export function resolveVirtualPath(baseDir: string, relative: string): string {
  const target = relative.trim();
  if (target.startsWith('/') || target.startsWith('\\')) return normalizeVirtualPath(target);
  const base = normalizeVirtualPath(baseDir);
  if (target.length === 0) return base;
  return normalizeVirtualPath(base.length > 0 ? `${base}/${target}` : target);
}
