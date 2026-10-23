/**
 * 阅读器功能开关（设计方案 §4.7）。
 *
 * `features` 是内置 UI 与实例方法的唯一开关来源；`FeatureState` 表示合并宿主配置、
 * 文档权限、引擎/环境能力与功能依赖后的有效状态。
 */

/**
 * 全部功能键，顺序与设计方案 §4.7 一致。
 *
 * 该元组同时是运行时校验与类型定义的唯一来源，禁止在其他模块另建功能键列表。
 */
export const VIEWER_FEATURES = [
  'toolbar',
  'sidebar',
  'thumbnails',
  'outline',
  'bookmarks',
  'pageNavigation',
  'pageNumberInput',
  'zoom',
  'rotate',
  'fullscreen',
  'textLayer',
  'selection',
  'find',
  'print',
  'export',
  'signatures',
  'verification',
  'documentProperties',
  'keyboardShortcuts',
] as const;

/** 功能键。 */
export type ViewerFeature = (typeof VIEWER_FEATURES)[number];

/** 功能不可用的原因。 */
export type FeatureReason = 'host' | 'document' | 'unsupported' | 'dependency';

/** 单个功能的有效状态。 */
export interface FeatureState {
  /** 是否可用；false 时对应实例方法抛 `OFD_FEATURE_DISABLED`。 */
  readonly enabled: boolean;
  /** 内置 UI 是否可见；`featureDisplay='disable'` 时禁用但可见。 */
  readonly visible: boolean;
  /** 不可用原因；可用时省略。 */
  readonly reason?: FeatureReason;
}

/** 宿主功能开关补丁；未出现的键默认开启。 */
export type ViewerFeatures = Partial<Record<ViewerFeature, boolean>>;

/** 被关闭功能的展示方式：隐藏，或显示但禁用。 */
export type FeatureDisplayMode = 'hide' | 'disable';

/**
 * 功能展示配置。
 *
 * 传字符串表示全局模式；传对象表示按功能覆盖，未覆盖的键回落到全局模式（默认 `hide`）。
 */
export type FeatureDisplay =
  | FeatureDisplayMode
  | Partial<Record<ViewerFeature, FeatureDisplayMode>>;

/** 展开后的按功能展示模式。 */
export type ResolvedFeatureDisplay = Record<ViewerFeature, FeatureDisplayMode>;

/** 展开后的全部功能有效状态。 */
export type ViewerFeatureStates = Record<ViewerFeature, FeatureState>;

/** 默认展示方式：被关闭的功能默认隐藏对应控件。 */
export const DEFAULT_FEATURE_DISPLAY: FeatureDisplayMode = 'hide';

/** 默认功能开关：全部开启。 */
export const DEFAULT_FEATURES: Readonly<Record<ViewerFeature, boolean>> = Object.freeze(
  Object.fromEntries(VIEWER_FEATURES.map((feature) => [feature, true])) as Record<
    ViewerFeature,
    boolean
  >,
);

/**
 * 功能依赖：键为被依赖方，值为启用它所需的功能。
 *
 * 依赖功能不可用时，本功能以 `reason='dependency'` 关闭。
 */
export const FEATURE_DEPENDENCIES: Readonly<
  Partial<Record<ViewerFeature, readonly ViewerFeature[]>>
> = Object.freeze({
  thumbnails: ['sidebar'],
  outline: ['sidebar'],
  bookmarks: ['sidebar'],
  selection: ['textLayer'],
  find: ['textLayer'],
});

/** 功能可用性输入；由文档权限与引擎/环境能力提供。 */
export interface FeatureAvailability {
  /** 文档权限/内容是否允许；值为 false 表示文档侧禁用该功能。 */
  readonly document?: Partial<Record<ViewerFeature, boolean>>;
  /** 引擎/环境是否支持；值为 true 表示不支持，功能应关闭。 */
  readonly unsupported?: Partial<Record<ViewerFeature, boolean>>;
}

/**
 * 判断值是否为合法的功能键。
 *
 * @param value 待判断的值。
 * @returns 是 `ViewerFeature` 时返回 true。
 */
export function isViewerFeature(value: unknown): value is ViewerFeature {
  return (
    typeof value === 'string' && (VIEWER_FEATURES as readonly string[]).includes(value)
  );
}

/**
 * 生成全部功能开启的默认状态。
 *
 * @returns 每个功能均为 `{ enabled: true, visible: true }`。
 */
export function createDefaultFeatureStates(): ViewerFeatureStates {
  return Object.fromEntries(
    VIEWER_FEATURES.map((feature) => [feature, { enabled: true, visible: true }]),
  ) as ViewerFeatureStates;
}

/**
 * 将全局/按功能展示配置展开为逐功能模式。
 *
 * @param display 展示配置；省略时全局使用 `hide`。
 * @returns 每个功能的展示模式。
 */
export function resolveFeatureDisplay(
  display: FeatureDisplay = DEFAULT_FEATURE_DISPLAY,
): ResolvedFeatureDisplay {
  const fallback: FeatureDisplayMode =
    typeof display === 'string' ? display : DEFAULT_FEATURE_DISPLAY;
  const overrides: Partial<Record<ViewerFeature, FeatureDisplayMode>> =
    typeof display === 'object' && display !== null ? display : {};
  return Object.fromEntries(
    VIEWER_FEATURES.map((feature) => [feature, overrides[feature] ?? fallback]),
  ) as ResolvedFeatureDisplay;
}

/**
 * 合并功能开关补丁，忽略非法键与非法值（供 JS 宿主调用）。
 *
 * @param current 当前补丁。
 * @param patch 新增补丁；`undefined` 值不覆盖。
 * @returns 合并后的新补丁对象。
 */
export function mergeViewerFeatures(
  current: ViewerFeatures = {},
  patch: ViewerFeatures = {},
): ViewerFeatures {
  const merged: ViewerFeatures = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (isViewerFeature(key) && typeof value === 'boolean') merged[key] = value;
  }
  return merged;
}

/**
 * 计算功能的有效状态。
 *
 * 优先级：宿主 `features=false` → 文档权限不允许 → 引擎/环境不支持 → 依赖不满足。
 * 宿主无法通过 `features=true` 绕过文档权限或引擎能力。
 *
 * @param features 宿主功能开关补丁；省略表示全部开启。
 * @param availability 文档权限与引擎能力。
 * @param display 被关闭功能的展示方式。
 * @returns 全部功能的有效状态。
 */
export function resolveFeatureStates(
  features: ViewerFeatures = {},
  availability: FeatureAvailability = {},
  display: FeatureDisplay = DEFAULT_FEATURE_DISPLAY,
): ViewerFeatureStates {
  const displayModes = resolveFeatureDisplay(display);
  const states = createDefaultFeatureStates();

  for (const feature of VIEWER_FEATURES) {
    let reason: FeatureReason | undefined;
    if (features[feature] === false) {
      reason = 'host';
    } else if (availability.document?.[feature] === false) {
      reason = 'document';
    } else if (availability.unsupported?.[feature] === true) {
      reason = 'unsupported';
    }
    if (reason) {
      states[feature] = {
        enabled: false,
        visible: displayModes[feature] === 'disable',
        reason,
      };
    }
  }

  // 依赖可能级联（例如 sidebar → thumbnails），迭代到稳定为止；依赖图无环。
  let changed = true;
  while (changed) {
    changed = false;
    for (const feature of VIEWER_FEATURES) {
      if (!states[feature].enabled) continue;
      const dependencies = FEATURE_DEPENDENCIES[feature];
      if (!dependencies) continue;
      if (dependencies.some((dependency) => !states[dependency].enabled)) {
        states[feature] = {
          enabled: false,
          visible: displayModes[feature] === 'disable',
          reason: 'dependency',
        };
        changed = true;
      }
    }
  }

  return states;
}

/**
 * 读取单个功能的有效状态。
 *
 * @param states 全部功能状态。
 * @param feature 功能键。
 * @returns 对应状态；缺失时按默认开启处理。
 */
export function getFeatureState(
  states: ViewerFeatureStates,
  feature: ViewerFeature,
): FeatureState {
  return states[feature] ?? { enabled: true, visible: true };
}

/**
 * 判断功能是否可用。
 *
 * @param states 全部功能状态。
 * @param feature 功能键。
 * @returns 可用时返回 true。
 */
export function isFeatureEnabled(
  states: ViewerFeatureStates,
  feature: ViewerFeature,
): boolean {
  return getFeatureState(states, feature).enabled;
}