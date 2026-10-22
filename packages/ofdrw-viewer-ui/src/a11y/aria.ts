/**
 * ARIA 状态辅助函数。
 *
 * 所有控件状态（可用性、展开、按下）统一从这里写入，避免各处属性拼写不一致。
 */
import type { FeatureReason } from '../features';

/** 可写 ARIA 状态的元素类型。 */
type AriaControl = HTMLElement & {
  disabled?: boolean;
};

/**
 * 设置禁用状态。
 *
 * @param element 目标控件。
 * @param disabled 是否禁用。
 * @param reason 禁用原因文案；省略时清除 tooltip。
 */
export function setDisabled(
  element: AriaControl,
  disabled: boolean,
  reason?: string,
): void {
  if ('disabled' in element) element.disabled = disabled;
  if (disabled) {
    element.setAttribute('aria-disabled', 'true');
    element.setAttribute('data-feature-disabled', 'true');
    if (reason) {
      element.title = reason;
      element.setAttribute('data-ofd-disabled-title', 'true');
    }
  } else {
    element.removeAttribute('aria-disabled');
    element.removeAttribute('data-feature-disabled');
    if (element.getAttribute('data-ofd-disabled-title') === 'true') {
      element.removeAttribute('title');
      element.removeAttribute('data-ofd-disabled-title');
    }
  }
}

/**
 * 设置 `aria-pressed`（切换按钮）。
 *
 * @param element 目标控件。
 * @param pressed 是否按下。
 */
export function setPressed(element: HTMLElement, pressed: boolean): void {
  element.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

/**
 * 设置 `aria-expanded`（展开/收起控件）。
 *
 * @param element 目标控件。
 * @param expanded 是否展开。
 */
export function setExpanded(element: HTMLElement, expanded: boolean): void {
  element.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

/**
 * 设置 `aria-current`。
 *
 * @param element 目标元素。
 * @param current 是否当前项；false 时移除属性。
 */
export function setCurrent(element: HTMLElement, current: boolean): void {
  if (current) element.setAttribute('aria-current', 'page');
  else element.removeAttribute('aria-current');
}

/**
 * 功能禁用原因的数据属性值。
 *
 * @param reason 不可用原因。
 * @returns 写入 `data-feature-reason` 的字符串；可用时为 undefined。
 */
export function featureReasonAttribute(
  reason?: FeatureReason,
): string | undefined {
  return reason;
}