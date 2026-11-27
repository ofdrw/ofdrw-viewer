/**
 * 包版本号。
 *
 * 与 `package.json` 的 `version` 同步维护；构建产物不读取 `package.json`，
 * 因此可执行文件与依赖方都能直接取得。发布前由单元测试校验两者一致。
 */

/** 包版本号。 */
export const VERSION = '0.3.0';