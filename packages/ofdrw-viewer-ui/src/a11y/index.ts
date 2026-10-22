/**
 * 可访问性工具出口。
 */
export {
  FOCUSABLE_SELECTOR,
  focusFirst,
  getFocusableElements,
  isFocusable,
  restoreFocus,
} from './focus';
export { FocusTrap } from './focus-trap';
export type { FocusTrapActivateOptions, FocusTrapOptions } from './focus-trap';
export { LiveAnnouncer } from './announcer';
export {
  featureReasonAttribute,
  setCurrent,
  setDisabled,
  setExpanded,
  setPressed,
} from './aria';