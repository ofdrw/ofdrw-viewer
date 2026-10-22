/**
 * 文案字典类型：以简体中文为基准，其他语言必须提供同构的键集合。
 */
import { zhCN } from './locales/zh-CN';

/** 全部文案键。 */
export type MessageKey = keyof typeof zhCN;

/** 完整语言字典；`zh-CN` 为键的基准。 */
export type MessageDictionary = Record<MessageKey, string>;

/** 部分语言字典；注册自定义语言时未覆盖的键回落到简体中文。 */
export type PartialMessageDictionary = Partial<MessageDictionary>;