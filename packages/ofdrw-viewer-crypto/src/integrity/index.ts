/**
 * 防夹带完整性模块公共入口。
 *
 * 对外只暴露清单解析（`parseOfdEntriesXml`）；完整性验证统一经 `verifyOfd`，
 * 不提供独立的 `verifyContainer` 公共入口。
 */

export { parseOfdEntriesXml } from './parse';
export type { OfdEntriesInfo } from './parse';