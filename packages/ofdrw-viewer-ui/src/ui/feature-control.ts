/**
 * 功能开关到控件状态的映射（设计方案 §4.7）。
 *
 * 控件只读取 `FeatureState`：`visible=false` 时隐藏并从 Tab 顺序移除；
 * `enabled=false` 且可见时使用 `disabled`/`aria-disabled`，并把原因写入 tooltip。
 */
import { setDisabled } from '../a11y';
import { getFeatureState } from '../features';
import type {
  FeatureReason,
  FeatureState,
  ViewerFeature,
  ViewerFeatureStates,
} from '../features';
import type { Translator } from '../i18n';
import type { SidebarView } from '../state';

/**
 * 侧栏视图对应的功能键。
 *
 * `settings` 刻意没有独立功能键（需求清单 C3），由侧栏功能门控；映射集中在此处，
 * 避免各调用点各写一份判断。
 *
 * @param view 侧栏视图。
 * @returns 对应的功能键。
 */
export function sidebarViewFeature(view: SidebarView): ViewerFeature {
  return view;
}

/** 控件当前的功能门控结果。 */
export interface FeatureGate {
  /** 是否可见。 */
  readonly visible: boolean;
  /** 是否被功能开关禁用。 */
  readonly disabled: boolean;
  /** 禁用原因；可用时为空。 */
  readonly reason?: FeatureReason;
  /** 面向前端的禁用说明。 */
  readonly tooltip?: string;
}

/** 可接收禁用状态的原生控件。 */
export type DisableableElement = HTMLElement & { disabled?: boolean };

/**
 * 计算控件的功能门控结果。
 *
 * @param states 全部功能状态。
 * @param feature 控件所属功能。
 * @param t 翻译器。
 * @returns 可见性、禁用状态与说明。
 */
export function resolveFeatureGate(
  states: ViewerFeatureStates,
  feature: ViewerFeature,
  t: Translator,
): FeatureGate {
  const state = getFeatureState(states, feature);
  if (!state.enabled) {
    return {
      visible: state.visible,
      disabled: true,
      reason: state.reason,
      tooltip: t.featureDisabledTooltip(feature, state.reason),
    };
  }
  return { visible: true, disabled: false };
}

/**
 * 把功能门控结果写入控件。
 *
 * @param element 控件元素。
 * @param gate 门控结果。
 * @returns 传入的 `FeatureState`，便于调用方继续计算控件自身状态。
 */
export function applyFeatureGate(
  element: HTMLElement,
  gate: FeatureGate,
): void {
  element.hidden = !gate.visible;
  setDisabled(element as DisableableElement, gate.disabled, gate.tooltip);
  if (gate.disabled && gate.reason) {
    element.dataset.featureReason = gate.reason;
  } else {
    delete element.dataset.featureReason;
  }
}

/**
 * 设置控件禁用状态，并把功能门控与控件自身条件（如页码边界）合并。
 *
 * @param element 控件元素。
 * @param gate 功能门控结果。
 * @param stateDisabled 控件自身是否禁用（页码首尾、缩放上下限等）。
 */
export function syncControlDisabled(
  element: HTMLElement,
  gate: FeatureGate,
  stateDisabled = false,
): void {
  const disabled = gate.disabled || stateDisabled;
  setDisabled(
    element as DisableableElement,
    disabled,
    gate.disabled ? gate.tooltip : undefined,
  );
}

/** 读取功能状态。 */
export function readFeature(
  states: ViewerFeatureStates,
  feature: ViewerFeature,
): FeatureState {
  return getFeatureState(states, feature);
}