/**
 * T1 骨架的“未实现”哨兵。
 *
 * 各模块在实现阶段替换此调用；保留它可以让所有 skeleton 在 tsc 下通过，
 * 同时避免静默返回错误结果。
 */

/**
 * 抛出“尚未实现”错误。
 *
 * @param feature 功能标识，建议使用 `模块.函数` 形式，便于定位。
 * @returns 永不返回；用于满足 `never` 位置的类型收窄。
 */
export function notImplemented(feature: string): never {
  throw new Error(`@ofdrw/ofdrw-viewer-engine: not implemented: ${feature}`);
}