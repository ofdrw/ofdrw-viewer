/**
 * 本地字体开关状态与持久化（本地字体加载方案设计 §3.2 / §4，需求清单 REQ-007 / REQ-008，C13）。
 *
 * 本模块只承载「开关怎么算、用户选择怎么记」，不访问 `queryLocalFonts`，也不读文档：
 * - 生效值解析：宿主配置决定可见性与默认值，用户选择优先；
 * - 持久化：localStorage 只存一个布尔值与「已告知」标记，不存字体清单；
 * - 隐私模式下读写失败一律静默降级为「无记忆」，不抛错、不影响阅读。
 *
 * 浏览器能力探测与权限查询归 `local-fonts.ts`（t2）；本模块只消费它们的同步结果。
 */

/** 本地字体持久化存储键（REQ-008）。 */
export const LOCAL_FONTS_STORAGE_KEY = 'ofd-viewer:local-fonts';

/** 单个文档最多查询的声明字体数，默认值（=需求清单 §0.2 的 `maxFonts`）。 */
export const DEFAULT_LOCAL_FONTS_MAX_FONTS = 8;

/** `maxFonts` 的上限，防止误配产生超长查询。 */
export const MAX_LOCAL_FONTS_MAX_FONTS = 32;

/**
 * 本地字体权限状态。
 *
 * `prompt` 表示尚未申请或已被浏览器重置；`granted` 已授权；`denied` 已拒绝；
 * `unsupported` 浏览器不提供该能力。
 */
export type LocalFontStatus = 'prompt' | 'granted' | 'denied' | 'unsupported';

/** 本地字体当前状态（设计 §3.5）。 */
export interface LocalFontsStatus {
  /** 浏览器是否提供 `queryLocalFonts`。 */
  readonly supported: boolean;
  /** 开关是否开启（用户选择或宿主默认值）。 */
  readonly enabled: boolean;
  /** 权限状态：未申请 / 已授权 / 已拒绝 / 不支持。 */
  readonly permission: LocalFontStatus;
  /** 是否应展示「使用本机字体」开关（能力可用且宿主允许）。 */
  readonly visible: boolean;
  /** 最近一次读取是否正在进行。 */
  readonly loading: boolean;
}

/** 本地字体能力的已解析配置。 */
export interface ResolvedLocalFontsConfig {
  /** 宿主是否允许展示开关（`fonts.localFonts.enabled === true` 且浏览器支持）。 */
  readonly visible: boolean;
  /** 生效的开关值。 */
  readonly enabled: boolean;
  /** 是否把用户选择记在 localStorage。 */
  readonly remember: boolean;
  /** 单个文档最多查询多少个声明字体。 */
  readonly maxFonts: number;
  /** 授权确认框说明文案覆盖；缺省用内置文案。 */
  readonly consentText?: string;
}

/** 用户选择；两项都是布尔值，不包含任何字体信息。 */
export interface LocalFontsPreference {
  /** 用户最后一次明确选择的开关值。 */
  readonly enabled: boolean;
  /** 是否已经向用户展示过授权说明（避免重复打扰）。 */
  readonly notified: boolean;
}

/** 解析配置的输入。 */
export interface ResolveLocalFontsConfigInput {
  /** 宿主传入的 `fonts.localFonts`；省略表示未配置。 */
  readonly localFonts?: {
    readonly enabled?: boolean;
    readonly defaultEnabled?: boolean;
    readonly remember?: boolean;
    readonly maxFonts?: number;
    readonly consentText?: string;
  };
  /** 浏览器是否提供 `queryLocalFonts`。 */
  readonly supported: boolean;
  /** 已持久化的用户选择；未记住或不可用时为 undefined。 */
  readonly preference?: LocalFontsPreference | undefined;
}

/**
 * 规范化 `maxFonts`。
 *
 * @param value 原始值；可为 undefined。
 * @returns 1–32 之间的整数；非法值回落默认 8。
 */
export function normalizeLocalFontsMaxFonts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LOCAL_FONTS_MAX_FONTS;
  const truncated = Math.trunc(value);
  if (truncated < 1) return DEFAULT_LOCAL_FONTS_MAX_FONTS;
  return Math.min(MAX_LOCAL_FONTS_MAX_FONTS, truncated);
}

/**
 * 解析本地字体能力的生效配置（需求清单 REQ-007 的唯一实现点）。
 *
 * 解析表：未配置 / `enabled !== true` / 浏览器不支持 → 不可见且不生效；否则可见，
 * 且「用户选择优先于宿主 `defaultEnabled`」。
 *
 * @param input 宿主配置、浏览器能力与已记住的用户选择。
 * @returns 展开默认值后的配置。
 */
export function resolveLocalFontsConfig(
  input: ResolveLocalFontsConfigInput,
): ResolvedLocalFontsConfig {
  const options = input.localFonts;
  const remember = options?.remember !== false;
  const maxFonts = normalizeLocalFontsMaxFonts(options?.maxFonts);
  const consentText = options?.consentText;
  const base = {
    remember,
    maxFonts,
    ...(consentText === undefined ? {} : { consentText }),
  };
  if (!options || options.enabled !== true || !input.supported) {
    return { ...base, visible: false, enabled: false };
  }
  const preference = remember ? input.preference : undefined;
  return {
    ...base,
    visible: true,
    enabled: preference ? preference.enabled : options.defaultEnabled === true,
  };
}

/**
 * 读取已持久化的用户选择（需求清单 REQ-008）。
 *
 * 隐私模式下 `localStorage` 读写抛错时静默返回 undefined，按「无用户选择」处理。
 *
 * @param storage localStorage 实现；省略时取全局 `localStorage`。
 * @returns 用户选择；未记住、不存在或内容非法时为 undefined。
 */
export function readLocalFontsPreference(
  storage: Storage | undefined = getLocalStorage(),
): LocalFontsPreference | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(LOCAL_FONTS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const enabled = (parsed as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean') return undefined;
    const notified = (parsed as { notified?: unknown }).notified;
    return { enabled, notified: notified === true };
  } catch {
    return undefined;
  }
}

/**
 * 写入用户选择（需求清单 REQ-008）。
 *
 * 只写 `enabled` / `notified` 两个布尔值，不写字体清单；写入失败静默忽略。
 *
 * @param preference 用户选择。
 * @param storage localStorage 实现；省略时取全局 `localStorage`。
 */
export function writeLocalFontsPreference(
  preference: LocalFontsPreference,
  storage: Storage | undefined = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      LOCAL_FONTS_STORAGE_KEY,
      JSON.stringify({ enabled: preference.enabled, notified: preference.notified }),
    );
  } catch {
    // 隐私模式或配额不足：降级为「无记忆」，不影响阅读。
  }
}

/**
 * 读取全局 localStorage；不可访问（隐私模式、`SecurityError`）时返回 undefined。
 *
 * @returns localStorage 实现或 undefined。
 */
function getLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
