/**
 * 焦点工具：可聚焦元素查询与焦点恢复。
 *
 * UI 外壳的对话框、抽屉侧栏和菜单共用这里的判定，避免各处自行拼选择器。
 */

/** 可聚焦元素选择器；排除 `tabindex="-1"` 与禁用元素。 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 判断元素当前是否可聚焦。
 *
 * 除属性检查外，还会参考 `hidden` 祖先与计算样式；在 jsdom 中计算样式可能为空，
 * 此时按属性判定，保证测试与真实浏览器行为一致。
 *
 * @param element 待判断元素。
 * @returns 可聚焦时返回 true。
 */
export function isFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('tabindex') === '-1') return false;
  if (element.closest('[hidden]')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  const view = element.ownerDocument?.defaultView;
  if (view) {
    const style = view.getComputedStyle(element);
    if (style.visibility === 'hidden') return false;
    if (style.display === 'none') return false;
  }
  return true;
}

/**
 * 查询容器内可聚焦元素（DOM 顺序）。
 *
 * @param container 容器元素。
 * @returns 可聚焦元素数组。
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    isFocusable,
  );
}

/**
 * 聚焦容器内第一个可聚焦元素；没有时聚焦容器本身。
 *
 * @param container 容器元素；需要能在无子元素时接收焦点（建议 `tabindex="-1"`）。
 * @returns 是否命中子元素。
 */
export function focusFirst(container: HTMLElement): boolean {
  const [first] = getFocusableElements(container);
  if (first) {
    first.focus();
    return true;
  }
  container.focus();
  return false;
}

/**
 * 恢复焦点到指定元素。
 *
 * @param element 目标元素；不存在、已断开或不可聚焦时忽略。
 */
export function restoreFocus(element: HTMLElement | null | undefined): void {
  if (!element || !element.isConnected) return;
  if (!isFocusable(element) && !element.hasAttribute('tabindex')) return;
  element.focus();
}