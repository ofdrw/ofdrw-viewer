/**
 * 内置国际化（设计方案 §4.6）。
 *
 * 不引入重型 i18n 运行时：字典是普通对象，`t()` 只做 `{name}` 插值；
 * 日期/数字统一走 `Intl.DateTimeFormat` / `Intl.NumberFormat`。
 * 默认支持 `zh-CN`、`en-US`，宿主可通过 `registerLocale` 追加或覆盖语言。
 */
import type { FeatureReason, ViewerFeature } from '../features';
import { enUS } from './locales/en-US';
import { zhCN } from './locales/zh-CN';
import type { MessageDictionary, MessageKey, PartialMessageDictionary } from './messages';

export type { MessageDictionary, MessageKey, PartialMessageDictionary } from './messages';

/** 兜底语言；未注册/非法语言回落到简体中文。 */
export const FALLBACK_LOCALE = 'zh-CN';

/** 内置语言。 */
export const BUILTIN_LOCALES = ['zh-CN', 'en-US'] as const;

/** 内置语言代码。 */
export type BuiltinLocale = (typeof BUILTIN_LOCALES)[number];

/** 已注册语言字典；键为规范化后的语言代码。 */
const dictionaries = new Map<string, MessageDictionary>([
  ['zh-CN', zhCN],
  ['en-US', enUS],
]);

/** 语言别名，用于把 `zh`、`en`、`zh-Hans` 等写法归一到内置代码。 */
const LOCALE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-hans-cn': 'zh-CN',
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-US',
});

/** 功能键到文案键的映射，用于禁用原因 tooltip。 */
const FEATURE_LABEL_KEYS: Readonly<Record<ViewerFeature, MessageKey>> = Object.freeze({
  toolbar: 'feature.toolbar',
  sidebar: 'feature.sidebar',
  thumbnails: 'feature.thumbnails',
  outline: 'feature.outline',
  bookmarks: 'feature.bookmarks',
  attachments: 'feature.attachments',
  pageNavigation: 'feature.pageNavigation',
  pageNumberInput: 'feature.pageNumberInput',
  zoom: 'feature.zoom',
  rotate: 'feature.rotate',
  fullscreen: 'feature.fullscreen',
  textLayer: 'feature.textLayer',
  selection: 'feature.selection',
  find: 'feature.find',
  print: 'feature.print',
  export: 'feature.export',
  signatures: 'feature.signatures',
  verification: 'feature.verification',
  documentProperties: 'feature.documentProperties',
  keyboardShortcuts: 'feature.keyboardShortcuts',
});

/** 翻译器；UI 组件只依赖该接口，不直接读取字典。 */
export interface Translator {
  /** 当前语言代码（已规范化）。 */
  readonly locale: string;
  /**
   * 翻译文案。
   *
   * @param key 文案键。
   * @param vars 插值变量；缺失的占位符原样保留。
   * @returns 翻译后的文本。
   */
  t(key: MessageKey, vars?: Readonly<Record<string, string | number>>): string;
  /**
   * 使用 `Intl.NumberFormat` 格式化数字。
   *
   * @param value 数字。
   * @param options 格式化选项。
   * @returns 本地化数字；非有限数字返回空字符串。
   */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  /**
   * 使用 `Intl.DateTimeFormat` 格式化日期。
   *
   * @param value 日期对象、时间戳（毫秒）或可解析字符串。
   * @param options 格式化选项。
   * @returns 本地化日期；非法日期返回空字符串。
   */
  formatDate(
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  /**
   * 功能名称。
   *
   * @param feature 功能键。
   * @returns 面向用户的名称。
   */
  featureLabel(feature: ViewerFeature): string;
  /**
   * 功能禁用原因的 tooltip 文案。
   *
   * @param feature 功能键。
   * @param reason 不可用原因。
   * @returns 例如“打印不可用：已被宿主禁用”。
   */
  featureDisabledTooltip(feature: ViewerFeature, reason?: FeatureReason): string;
}

/**
 * 规范化语言代码：大小写不敏感，支持语言别名。
 *
 * @param locale 宿主传入的语言代码。
 * @returns 已注册的语言代码；无法识别时回落到 `zh-CN`。
 */
export function normalizeLocale(locale?: string): string {
  if (!locale) return FALLBACK_LOCALE;
  const normalized = locale.trim().toLowerCase();
  if (normalized.length === 0) return FALLBACK_LOCALE;
  const direct = [...dictionaries.keys()].find(
    (code) => code.toLowerCase() === normalized,
  );
  if (direct) return direct;
  const alias = LOCALE_ALIASES[normalized];
  if (alias && dictionaries.has(alias)) return alias;
  const language = LOCALE_ALIASES[normalized.split('-')[0] ?? ''];
  if (language && dictionaries.has(language)) return language;
  return FALLBACK_LOCALE;
}

/**
 * 判断语言是否可用。
 *
 * @param locale 语言代码。
 * @returns 已注册时返回 true。
 */
export function isLocaleSupported(locale: string): boolean {
  return normalizeLocale(locale) === locale || dictionaries.has(locale);
}

/**
 * 读取已注册语言代码。
 *
 * @returns 语言代码数组（插入顺序）。
 */
export function getSupportedLocales(): string[] {
  return [...dictionaries.keys()];
}

/**
 * 注册或覆盖语言字典。
 *
 * 未覆盖的键自动回落到简体中文，便于只翻译部分文案。
 *
 * @param locale 语言代码，例如 `ja-JP`。
 * @param messages 部分字典。
 */
export function registerLocale(
  locale: string,
  messages: PartialMessageDictionary,
): void {
  const code = locale.trim();
  if (code.length === 0) throw new Error('语言代码不能为空');
  const existing = dictionaries.get(code) ?? zhCN;
  dictionaries.set(code, { ...existing, ...messages });
}

/**
 * 替换 `{name}` 占位符。
 *
 * @param template 模板文本。
 * @param vars 插值变量。
 * @returns 替换后的文本；缺失变量保持原占位符。
 */
export function interpolate(
  template: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * 读取功能不可用原因对应的文案键。
 *
 * @param reason 原因；省略时按宿主禁用处理。
 * @returns 文案键。
 */
export function featureReasonKey(reason?: FeatureReason): MessageKey {
  switch (reason) {
    case 'document':
      return 'feature.reason.document';
    case 'unsupported':
      return 'feature.reason.unsupported';
    case 'dependency':
      return 'feature.reason.dependency';
    case 'host':
    default:
      return 'feature.reason.host';
  }
}

/**
 * 创建翻译器。
 *
 * @param locale 语言代码；未注册时回落到简体中文。
 * @returns 绑定语言的翻译与格式化函数。
 */
export function createTranslator(locale?: string): Translator {
  const resolved = normalizeLocale(locale);
  const dictionary = dictionaries.get(resolved) ?? zhCN;
  const t: Translator['t'] = (key, vars) => {
    const template = dictionary[key] ?? zhCN[key] ?? key;
    return interpolate(template, vars);
  };
  return {
    locale: resolved,
    t,
    formatNumber(value, options) {
      if (!Number.isFinite(value)) return '';
      return new Intl.NumberFormat(resolved, options).format(value);
    },
    formatDate(value, options) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat(resolved, options).format(date);
    },
    featureLabel(feature) {
      return t(FEATURE_LABEL_KEYS[feature]);
    },
    featureDisabledTooltip(feature, reason) {
      return t('feature.disabled', {
        feature: t(FEATURE_LABEL_KEYS[feature]),
        reason: t(featureReasonKey(reason)),
      });
    },
  };
}