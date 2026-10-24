/**
 * 跨平台路径断言的测试工具。
 *
 * macOS 的临时目录位于 `/var/...`（真实路径 `/private/var/...`），Windows 上
 * `realpath` 会把盘符转成大写并展开 8.3 短名（`RUNNER~1` → `runneradmin`），
 * 因此断言不能直接做字符串比较，需先按各自规则归一化。
 */

/**
 * 归一化路径用于比较：统一分隔符，Windows 下忽略盘符与大小写。
 *
 * @param value 待归一化的路径
 * @returns 可直接比较的路径文本
 */
export function normalizePath(value: string): string {
  const text = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? text.replace(/^[a-z]:/iu, '').toLowerCase() : text;
}

/**
 * 判断 `child` 是否位于 `parent` 目录之下（含 `parent` 自身）。
 *
 * @param child 子路径
 * @param parent 父目录
 * @returns 位于其下时返回 true
 */
export function isPathInside(child: string, parent: string): boolean {
  const target = normalizePath(child);
  const root = normalizePath(parent).replace(/\/+$/u, '');
  return target === root || target.startsWith(`${root}/`);
}

/**
 * 判断两个路径是否指向同一位置（忽略分隔符、盘符与大小写差异）。
 *
 * @param left 路径一
 * @param right 路径二
 * @returns 归一化后相等时返回 true
 */
export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}
