/**
 * OFD 包内路径规范化与相对路径解析。
 *
 * 规则与 engine `VirtualContainer` 保持一致：
 * - `\` 统一为 `/`，去掉前导 `/`；
 * - 忽略空段与 `.`，拒绝 `..`（防止路径逃逸）；
 * - 结果不含前导 `/`，与 `container.list()` 的路径形式一致。
 */

import { CryptoError } from '../errors';

/**
 * 规范化包内路径。
 *
 * @param input 原始路径，可含前导 `/`、`\`。
 * @returns 规范化路径；根目录返回空字符串。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：含 `..` 或非字符串。
 */
export function normalizePackagePath(input: string): string {
  if (typeof input !== 'string') {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', '包内路径必须是字符串');
  }
  const raw = input.trim().replace(/\\/g, '/');
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new CryptoError('CRYPTO_INVALID_PACKAGE', '包内路径不能包含 ..');
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 取包内路径所在目录。
 *
 * @param path 包内路径。
 * @returns 目录路径；根目录返回空字符串。
 */
export function packageDirName(path: string): string {
  const normalized = normalizePackagePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

/**
 * 解析 OFD 包内引用路径。
 *
 * 绝对路径（以 `/` 开头）按包根解析；相对路径按 `baseDir` 解析。
 *
 * @param baseDir 引用所在目录（规范化前的包内路径亦可）。
 * @param reference 引用文本。
 * @returns 规范化后的包内路径。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：路径非法。
 */
export function resolvePackagePath(baseDir: string, reference: string): string {
  if (typeof reference !== 'string' || reference.trim().length === 0) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', '包内引用路径为空');
  }
  const clean = reference.trim().replace(/\\/g, '/');
  if (clean.startsWith('/')) return normalizePackagePath(clean);
  const dir = normalizePackagePath(baseDir);
  return normalizePackagePath(dir.length > 0 ? `${dir}/${clean}` : clean);
}

/**
 * 判断两个包内路径是否相同（区分大小写）。
 *
 * @param a 路径 A。
 * @param b 路径 B。
 * @returns 规范化后相同返回 true。
 */
export function samePackagePath(a: string, b: string): boolean {
  return normalizePackagePath(a) === normalizePackagePath(b);
}