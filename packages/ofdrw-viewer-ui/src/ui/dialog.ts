/**
 * 对话框管理器（设计方案 §5.1 / §4.6）。
 *
 * 负责遮罩、层级、焦点陷阱、Esc 关闭与关闭后焦点回到触发按钮；
 * 具体内容（打印、导出、文档属性、签章详情）由调用方以节点/按钮注入。
 */

import { replaceChildren } from '../compat';
import { FocusTrap, getFocusableElements, restoreFocus } from '../a11y';
import type { Translator } from '../i18n';
import { createIcon } from './icons';
import type { UIDialogOptions } from './types';

let dialogSequence = 0;

/** 对话框管理器选项。 */
export interface DialogManagerOptions {
  /** 对话框层容器（`.ofd-viewer__dialog-layer`）。 */
  readonly layer: HTMLElement;
  /** 翻译器；用于关闭按钮与默认标题。 */
  readonly translator: Translator;
}

/** 当前打开的对话框。 */
interface OpenDialog {
  readonly options: UIDialogOptions;
  readonly element: HTMLElement;
  readonly trigger: HTMLElement | null;
  readonly trap: FocusTrap;
}

/**
 * 单对话框管理器；打开新对话框会替换旧对话框。
 */
export class DialogManager {
  private current: OpenDialog | null = null;
  private translator: Translator;

  /**
   * 创建管理器。
   *
   * @param options 管理器选项。
   */
  constructor(private readonly options: DialogManagerOptions) {
    this.translator = options.translator;
  }

  /** 是否已有打开的对话框。 */
  get isOpen(): boolean {
    return this.current !== null;
  }

  /** 当前对话框名称。 */
  get currentName(): string | null {
    return this.current?.options.name ?? null;
  }

  /**
   * 打开对话框。
   *
   * @param options 对话框内容与行为。
   * @returns 对话框元素，调用方可继续填充内容。
   */
  open(options: UIDialogOptions): HTMLElement {
    if (this.current) this.close(false);
    const doc = this.options.layer.ownerDocument;
    const dismissed = options.dismissible !== false;
    const id = `ofd-dialog-${++dialogSequence}`;
    const trigger = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

    replaceChildren(this.options.layer);
    const backdrop = doc.createElement('div');
    backdrop.className = 'ofd-dialog__backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', () => {
      if (dismissed) this.close();
    });

    const dialog = doc.createElement('div');
    dialog.className = 'ofd-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    if (options.description) {
      dialog.setAttribute('aria-describedby', `${id}-description`);
    }

    const header = doc.createElement('div');
    header.className = 'ofd-dialog__header';
    const title = doc.createElement('h2');
    title.className = 'ofd-dialog__title';
    title.id = `${id}-title`;
    title.textContent = options.title ?? this.translator.t('dialog.defaultTitle');
    const closeButton = doc.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'ofd-button ofd-dialog__close';
    closeButton.setAttribute('aria-label', this.translator.t('dialog.close'));
    closeButton.appendChild(createIcon('close'));
    closeButton.addEventListener('click', () => this.close());
    header.append(title, closeButton);

    const body = doc.createElement('div');
    body.className = 'ofd-dialog__body';
    if (options.description) {
      const description = doc.createElement('p');
      description.className = 'ofd-dialog__description';
      description.id = `${id}-description`;
      description.textContent = options.description;
      body.appendChild(description);
    }
    if (options.content instanceof Node) {
      body.appendChild(options.content);
    } else if (typeof options.content === 'string') {
      const text = doc.createElement('p');
      text.className = 'ofd-dialog__text';
      text.textContent = options.content;
      body.appendChild(text);
    }

    const footer = doc.createElement('div');
    footer.className = 'ofd-dialog__footer';
    const actions = options.actions ?? [];
    for (const action of actions) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = action.primary
        ? 'ofd-button ofd-dialog__action ofd-dialog__action--primary'
        : 'ofd-button ofd-dialog__action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        action.onClick?.();
        if (action.closeOnClick !== false) this.close();
      });
      footer.appendChild(button);
    }

    dialog.append(header, body, footer);
    this.options.layer.append(backdrop, dialog);
    this.options.layer.hidden = false;

    const trap = new FocusTrap(dialog, {
      onEscape: () => {
        if (dismissed) this.close();
      },
      initialFocus: () => {
        const [first] = getFocusableElements(body);
        return first ?? null;
      },
      restoreFocus: false,
    });
    trap.activate({ moveFocus: true });
    if (doc.activeElement === null || doc.activeElement === doc.body) {
      closeButton.focus();
    }

    this.current = { options, element: dialog, trigger, trap };
    return dialog;
  }

  /**
   * 关闭当前对话框。
   *
   * @param restoreFocus 是否把焦点还给触发元素；默认 true。
   */
  close(restoreFocusOnClose = true): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    current.trap.deactivate({ restoreFocus: false });
    replaceChildren(this.options.layer);
    this.options.layer.hidden = true;
    if (restoreFocusOnClose) {
      restoreFocus(current.trigger);
    }
    current.options.onClose?.();
  }

  /**
   * 切换翻译器（后续打开的对话框使用新语言）。
   *
   * @param translator 新翻译器。
   */
  setLocale(translator: Translator): void {
    this.translator = translator;
  }

  /** 关闭并清理。 */
  destroy(): void {
    this.close(false);
    replaceChildren(this.options.layer);
  }
}