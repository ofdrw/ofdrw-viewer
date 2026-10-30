/**
 * 密码能力包版本。
 *
 * 版本号随 package.json 的 version 同步维护；构建产物不读取 package.json，
 * 因此浏览器与 Node.js 环境都能直接取得。发布前由单元测试校验两者一致。
 */
export const VERSION = '0.1.6';

/**
 * 查询密码能力包版本号。
 *
 * @returns 语义化版本号，例如 `0.1.0`
 */
export function getVersion(): string {
  return VERSION;
}