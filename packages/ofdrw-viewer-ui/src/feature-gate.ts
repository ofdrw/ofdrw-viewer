/**
 * 功能开关门面（设计方案 §4.7）。
 *
 * 统一持有宿主开关、文档权限/引擎能力与展示方式，计算有效 `FeatureState`，并为
 * 实例方法提供统一的守卫入口。功能不可用时抛 `OFD_FEATURE_DISABLED`，不做静默
 * no-op；依赖联动（textLayer → find/selection、sidebar → 三个侧栏标签）由
 * `features.ts` 的 `resolveFeatureStates` 负责。
 */

import {
  isViewerFeature,
  mergeViewerFeatures,
  resolveFeatureStates,
  VIEWER_FEATURES,
} from './features';
import type {
  FeatureAvailability,
  FeatureDisplay,
  FeatureState,
  ViewerFeature,
  ViewerFeatureStates,
  ViewerFeatures,
} from './features';
import { assertFeatureEnabled, OFDViewerError } from './errors';

/** 功能门面的构造选项。 */
export interface FeatureGateOptions {
  /** 被关闭功能的展示方式；默认全局 `hide`。 */
  readonly display?: FeatureDisplay;
  /** 文档权限与引擎/环境能力。 */
  readonly availability?: FeatureAvailability;
}

/**
 * 功能开关门面。
 *
 * 只保存宿主补丁而不是每次调用都合并完整配置：`setFeatures` 语义是“合并补丁”，
 * 与设计方案 §4.2 一致。`replaceFeatures` 供内部恢复/重建时使用。
 */
export class FeatureGate {
  /** 宿主开关补丁；只含显式设置的键。 */
  private patch: ViewerFeatures;
  /** 文档权限与能力约束。 */
  private availability: FeatureAvailability;
  /** 被关闭功能的展示方式。 */
  private display: FeatureDisplay;
  /** 当前有效状态。 */
  private states: ViewerFeatureStates;

  /**
   * @param initial 初始宿主开关补丁。
   * @param options 展示方式与可用性输入。
   */
  constructor(initial: ViewerFeatures = {}, options: FeatureGateOptions = {}) {
    this.patch = mergeViewerFeatures({}, initial);
    this.availability = options.availability ?? {};
    this.display = options.display ?? 'hide';
    this.states = this.computeStates();
  }

  /**
   * 合并宿主开关补丁；非法键/非法值被忽略。
   *
   * @param patch 新增补丁。
   * @param options 可选的新展示方式/可用性。
   * @returns 合并后的完整有效状态。
   */
  setFeatures(
    patch: ViewerFeatures,
    options: {
      readonly display?: FeatureDisplay;
      readonly availability?: FeatureAvailability;
    } = {},
  ): ViewerFeatureStates {
    this.patch = mergeViewerFeatures(this.patch, patch);
    if (options.display !== undefined) this.display = options.display;
    if (options.availability !== undefined) this.availability = options.availability;
    this.states = this.computeStates();
    return this.states;
  }

  /**
   * 直接替换宿主补丁（不合并）。
   *
   * @param features 完整补丁。
   * @returns 新的有效状态。
   */
  replaceFeatures(features: ViewerFeatures): ViewerFeatureStates {
    this.patch = mergeViewerFeatures({}, features);
    this.states = this.computeStates();
    return this.states;
  }

  /**
   * 更新文档权限/引擎能力。
   *
   * @param availability 新可用性输入。
   * @returns 新的有效状态。
   */
  setAvailability(availability: FeatureAvailability): ViewerFeatureStates {
    this.availability = availability;
    this.states = this.computeStates();
    return this.states;
  }

  /**
   * 更新被关闭功能的展示方式。
   *
   * @param display 全局或按功能配置。
   * @returns 新的有效状态。
   */
  setDisplay(display: FeatureDisplay): ViewerFeatureStates {
    this.display = display;
    this.states = this.computeStates();
    return this.states;
  }

  /** 当前有效状态；返回内部只读对象，调用方不得修改。 */
  getStates(): ViewerFeatureStates {
    return this.states;
  }

  /**
   * 读取单个功能的有效状态。
   *
   * @param feature 功能键。
   * @returns 有效状态。
   */
  getState(feature: ViewerFeature): FeatureState {
    return this.states[feature] ?? { enabled: true, visible: true };
  }

  /**
   * 功能是否可用。
   *
   * @param feature 功能键。
   * @returns 可用时 true。
   */
  isEnabled(feature: ViewerFeature): boolean {
    return this.getState(feature).enabled;
  }

  /**
   * 功能对应控件是否应显示。
   *
   * @param feature 功能键。
   * @returns 应显示时 true。
   */
  isVisible(feature: ViewerFeature): boolean {
    return this.getState(feature).visible;
  }

  /**
   * 断言功能可用。
   *
   * @param feature 功能键。
   * @throws {OFDViewerError} 功能不可用时抛 `OFD_FEATURE_DISABLED`。
   */
  assertEnabled(feature: ViewerFeature): void {
    assertFeatureEnabled(feature, this.getState(feature));
  }

  /**
   * 判断传入值是否为合法功能键；供 JS 宿主调用。
   *
   * @param value 待判断值。
   * @returns 合法功能键时 true。
   */
  static isFeature(value: unknown): value is ViewerFeature {
    return isViewerFeature(value);
  }

  /** 当前宿主补丁快照。 */
  getFeatures(): ViewerFeatures {
    return { ...this.patch };
  }

  /** 重新计算有效状态。 */
  private computeStates(): ViewerFeatureStates {
    return resolveFeatureStates(this.patch, this.availability, this.display);
  }
}

/**
 * 复制功能状态，避免把内部可变引用暴露给宿主。
 *
 * @param states 功能状态。
 * @returns 逐项复制的状态对象。
 */
export function cloneFeatureStates(states: ViewerFeatureStates): ViewerFeatureStates {
  return Object.fromEntries(
    VIEWER_FEATURES.map((feature) => {
      const state = states[feature] ?? { enabled: true, visible: true };
      return [feature, { ...state }];
    }),
  ) as ViewerFeatureStates;
}

/**
 * 校验功能键；供 JS 宿主传入非法值时给出明确错误。
 *
 * @param value 待校验值。
 * @returns 合法功能键。
 * @throws {OFDViewerError} 非法时抛 `OFD_INVALID_OPTION`。
 */
export function normalizeFeature(value: unknown): ViewerFeature {
  if (!isViewerFeature(value)) {
    throw new OFDViewerError('OFD_INVALID_OPTION', `未知功能键：${String(value)}`);
  }
  return value;
}