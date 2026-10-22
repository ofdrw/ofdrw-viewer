/**
 * 焦点陷阱（对话框、覆盖/抽屉侧栏）。
 *
 * 行为：
 * - 激活时记录当前焦点，可按需把焦点移入容器；
 * - Tab/Shift+Tab 在容器内循环，`focusin` 越界时拉回；
 * - Esc 通过回调交由调用方决定是否关闭；
 * - 关闭时把焦点还给触发元素（可关闭恢复，用于布局切换）。
 */
import { getFocusableElements, restoreFocus } from './focus';

/** 焦点陷阱选项。 */
export interface FocusTrapOptions {
  /** Esc 回调；省略时不处理 Esc。 */
  readonly onEscape?: () => void;
  /** 初始焦点；省略时聚焦容器内第一个可聚焦元素。 */
  readonly initialFocus?: HTMLElement | (() => HTMLElement | null);
  /** 关闭时是否恢复焦点；默认 true。 */
  readonly restoreFocus?: boolean;
  /** 是否把焦点移入容器；默认 true。 */
  readonly moveFocus?: boolean;
}

/** 激活时可覆盖的选项。 */
export interface FocusTrapActivateOptions {
  /** 初始焦点；覆盖构造选项。 */
  readonly initialFocus?: HTMLElement | (() => HTMLElement | null);
  /** 是否把焦点移入容器；覆盖构造选项。 */
  readonly moveFocus?: boolean;
}

/** 焦点陷阱。 */
export class FocusTrap {
  private active = false;
  private previouslyFocused: HTMLElement | null = null;
  private readonly options: FocusTrapOptions;

  /**
   * 创建焦点陷阱。
   *
   * @param container 陷阱范围；通常为对话框或覆盖侧栏。
   * @param options 行为选项。
   */
  constructor(
    private readonly container: HTMLElement,
    options: FocusTrapOptions = {},
  ) {
    this.options = options;
  }

  /** 是否处于激活状态。 */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * 激活陷阱。
   *
   * @param options 本次激活的覆盖选项。
   */
  activate(options: FocusTrapActivateOptions = {}): void {
    if (this.active) return;
    this.active = true;
    const doc = this.container.ownerDocument;
    this.previouslyFocused =
      doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    doc.addEventListener('keydown', this.handleKeydown, true);
    doc.addEventListener('focusin', this.handleFocusIn, true);

    const moveFocus = options.moveFocus ?? this.options.moveFocus ?? true;
    if (!moveFocus) return;
    if (this.container.contains(doc.activeElement)) return;
    const initial = options.initialFocus ?? this.options.initialFocus;
    const target =
      typeof initial === 'function' ? initial() : (initial ?? undefined);
    if (target && this.container.contains(target)) {
      target.focus();
      return;
    }
    const [first] = getFocusableElements(this.container);
    if (first) first.focus();
    else if (!this.container.hasAttribute('tabindex')) {
      this.container.tabIndex = -1;
      this.container.focus();
    } else {
      this.container.focus();
    }
  }

  /**
   * 取消陷阱。
   *
   * @param options `restoreFocus` 是否把焦点还给激活前的元素；默认遵循构造选项。
   */
  deactivate(options: { restoreFocus?: boolean } = {}): void {
    if (!this.active) return;
    this.active = false;
    const doc = this.container.ownerDocument;
    doc.removeEventListener('keydown', this.handleKeydown, true);
    doc.removeEventListener('focusin', this.handleFocusIn, true);
    const shouldRestore =
      options.restoreFocus ?? this.options.restoreFocus ?? true;
    const target = this.previouslyFocused;
    this.previouslyFocused = null;
    if (shouldRestore) restoreFocus(target);
  }

  /** Tab 循环、Esc 处理。 */
  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.options.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = getFocusableElements(this.container);
    if (focusables.length === 0) {
      event.preventDefault();
      this.container.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeElement = this.container.ownerDocument.activeElement;
    if (event.shiftKey) {
      if (activeElement === first || !this.container.contains(activeElement)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (activeElement === last || !this.container.contains(activeElement)) {
      event.preventDefault();
      first.focus();
    }
  };

  /** 焦点越界时拉回容器。 */
  private readonly handleFocusIn = (event: FocusEvent): void => {
    if (!this.active) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (this.container.contains(target)) return;
    const [first] = getFocusableElements(this.container);
    if (first) first.focus();
    else this.container.focus();
  };
}