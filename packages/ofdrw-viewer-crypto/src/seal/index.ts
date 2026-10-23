/**
 * 电子印章解析模块公共入口。
 *
 * 只导出纯解析 API 与类型；验签/证书链校验在 `sign`/`verify` 模块完成。
 */

export { parseSeal } from './parse';
export type { ParsedSeal, SealPictureInfo, SesVersion } from './parse';