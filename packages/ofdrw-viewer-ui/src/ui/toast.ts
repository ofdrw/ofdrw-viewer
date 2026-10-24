/**
 * Toast 管理器（设计方案 §5.1 / §5.2）。
 *
 * 同一时间只展示一条 Toast；`info`/`warning` 使用 `role="status"`，
 * `error` 使用 `role="alert"`。自动关闭计时可被新的 Toast 替换。
 */

import { replaceChildren } from '../compat';
import type { Translator } from '../i18n';
import type { ToastLevel, ViewerToast } from '../state';
import { createIcon } from './icons';
import type { UIToastOptions } from './types';

/** 默认自动关闭时间，单位毫秒。 */
const DEFAULT_TOAST_DURATION = 5000;

/** Toast 管理器选项。 */
export interface ToastManagerOptions {
  /** Toast 层容器（`.ofd-viewer__toast-layer`）。 */
  readonly layer: HTMLElement;
  /** 翻译器。 */
  readonly translator: Translator;
}

/**
 * Toast 管理器。
 */
export class ToastManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: ViewerToast | null = null;
  private closeButton: HTMLButtonElement | null = null;
  private translator: Translator;

  /**
   * 创建管理器。
   *
   * @param options 管理器选项。
   */
  constructor(private readonly options: ToastManagerOptions) {
    this.translator = options.translator;
  }

  /** 当前 Toast。 */
  get toast(): ViewerToast | null {
    return this.current;
  }

  /**
   * 展示一条 Toast。
   *
   * @param message 文案。
   * @param options 级别与自动关闭时间。
   * @returns 本次 Toast。
   */
  show(message: string, options: UIToastOptions = {}): ViewerToast {
    const level: ToastLevel = options.level ?? 'info';
    const id = options.id ?? `toast-${Date.now()}`;
    const toast: ViewerToast = { id, message, level };
    this.render(toast);
    const duration = options.durationMs ?? DEFAULT_TOAST_DURATION;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (duration > 0) {
      this.timer = setTimeout(() => this.dismiss(), duration);
    }
    return toast;
  }

  /**
   * 与状态模型同步：传入 null 隐藏，传入对象展示。
   *
   * @param toast 状态中的 Toast。
   */
  sync(toast: ViewerToast | null): void {
    if (!toast) {
      this.dismiss();
      return;
    }
    if (this.current?.id === toast.id) return;
    this.render(toast);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dismiss(), DEFAULT_TOAST_DURATION);
  }

  /** 关闭当前 Toast。 */
  dismiss(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.current = null;
    this.closeButton = null;
    replaceChildren(this.options.layer);
    this.options.layer.hidden = true;
  }

  /**
   * 切换语言；关闭按钮的 aria 名称随之下一次渲染更新。
   *
   * @param translator 新翻译器。
   */
  setLocale(translator: Translator): void {
    this.translator = translator;
    this.closeButton?.setAttribute(
      'aria-label',
      translator.t('toast.dismiss'),
    );
  }

  /** 释放计时器与 DOM。 */
  destroy(): void {
    this.dismiss();
  }

  /** 渲染 Toast。 */
  private render(toast: ViewerToast): void {
    const doc = this.options.layer.ownerDocument;
    this.current = toast;
    replaceChildren(this.options.layer);
    const element = doc.createElement('div');
    element.className = 'ofd-toast';
    element.dataset.level = toast.level;
    element.dataset.toastId = toast.id;
    if (toast.level === 'error') {
      element.setAttribute('role', 'alert');
      element.setAttribute('aria-live', 'assertive');
    } else {
      element.setAttribute('role', 'status');
      element.setAttribute('aria-live', 'polite');
    }
    element.setAttribute('aria-atomic', 'true');

    const message = doc.createElement('div');
    message.className = 'ofd-toast__message';
    if (toast.level !== 'info') {
      const prefix = doc.createElement('span');
      prefix.className = 'ofd-toast__level';
      prefix.textContent = this.translator.t(
        toast.level === 'error' ? 'toast.error' : 'toast.warning',
      );
      message.appendChild(prefix);
    }
    const text = doc.createElement('span');
    text.className = 'ofd-toast__text';
    text.textContent = toast.message;
    message.appendChild(text);

    this.closeButton = doc.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'ofd-button ofd-toast__close';
    this.closeButton.setAttribute('aria-label', this.translator.t('toast.dismiss'));
    this.closeButton.appendChild(createIcon('close'));
    this.closeButton.addEventListener('click', () => this.dismiss());

    element.append(message, this.closeButton);
    this.options.layer.hidden = false;
    this.options.layer.appendChild(element);
  }
}