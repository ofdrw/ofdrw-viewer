/**
 * 时间戳解析模块公共入口。
 *
 * 只解析、不验证；不支持任何“时间戳验证通过”的返回值。
 */

export { parseTimestamp } from './parse';
export type { TimestampParseOptions } from './parse';
export type { TimestampParseResult } from './types';