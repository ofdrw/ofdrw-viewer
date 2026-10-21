/**
 * 包内路径解析与安全校验（实现由 T2/dev-foundation 完成）。
 *
 * 规则：去前导 `/`；统一 `/` 分隔；拒绝 `..` 逃出包根与重复规范化路径。
 */

import { notImplemented } from '../common/not-implemented';

/**
 * 规范化包内路径：去前导 `/`、折叠 `.`、校验 `..` 不越界。
 *
 * @param path 原始包内路径。
 * @returns 规范化路径；越界时抛 OFDError。
 */
export function normalizePackagePath(path: string): string {
  void path;
  return notImplemented('container.normalizePackagePath');
}

/**
 * 解析相对路径。
 *
 * @param baseDir 基准目录，包内绝对路径（无前导 `/`）。
 * @param relative 相对路径或 `/` 开头的包内绝对路径。
 * @returns 规范化后的包内绝对路径（无前导 `/`）。
 */
export function resolvePackagePath(baseDir: string, relative: string): string {
  void baseDir;
  void relative;
  return notImplemented('container.resolvePackagePath');
}

/**
 * 校验路径是否安全（不越出包根）。
 *
 * @param path 包内路径。
 * @throws OFDError 当路径穿越或包含非法段时。
 */
export function assertSafePackagePath(path: string): void {
  void path;
  return notImplemented('container.assertSafePackagePath');
}

/**
 * 取父目录。
 *
 * @param path 包内路径。
 * @returns 父目录；根目录返回空串。
 */
export function dirnameOf(path: string): string {
  void path;
  return notImplemented('container.dirnameOf');
}