/**
 * 查找栏（设计方案 §9.4）。
 *
 * 外壳只维护输入、计数、上下一个匹配与三个选项的 DOM；匹配、高亮、滚动由核心
 * FindController 负责。查找栏是浮层，不占据主区域布局高度。
 */

import { replaceChildren } from '../compat';
import { setDisabled } from '../a11y';
import type { FeatureState, ViewerFeatureStates } from '../features';
import type { MessageKey, Translator } from '../i18n';
import type { FindState } from '../state';
import { createIcon } from './icons';
import { resolveFeatureGate } from './feature-control';
import type {
  UIShellCommand,
  UIShellCommandHandler,
} from './types';

/** 查找选项键。 */
interface FindOptionSpec {
  readonly key: 'caseSensitive' | 'wholeWord' | 'highlightAll';
  readonly labelKey: MessageKey;
  readonly shortKey: MessageKey;
}

const FIND_OPTIONS: readonly FindOptionSpec[] = Object.freeze([
  { key: 'caseSensitive', labelKey: 'findbar.caseSensitive', shortKey: 'findbar.caseSensitiveShort' },
  { key: 'wholeWord', labelKey: 'findbar.wholeWord', shortKey: 'findbar.wholeWordShort' },
  { key: 'highlightAll', labelKey: 'findbar.highlightAll', shortKey: 'findbar.highlightAllShort' },
]);

/** 查找栏选项。 */
export interface FindbarOptions {
  /** 核心创建的查找栏容器。 */
  readonly element: HTMLElement;
  /** 翻译器。 */
  readonly translator: Translator;
  /** 功能状态。 */
  readonly featureStates: ViewerFeatureStates;
  /** 初始查找状态。 */
  readonly findState: FindState;
  /** 命令回调。 */
  readonly onCommand: UIShellCommandHandler;
  /** 请求关闭（由外壳同步工具栏状态与核心）。 */
  readonly onRequestClose: () => void;
  /** id 前缀，避免多实例冲突。 */
  readonly idPrefix: string;
}

/**
 * 查找栏浮层。
 */
export class Findbar {
  /** 查找栏根元素。 */
  readonly element: HTMLElement;
  private translator: Translator;
  private featureStates: ViewerFeatureStates;
  private findState: FindState;
  private gate: FeatureState | null = null;
  private previouslyFocused: HTMLElement | null = null;

  private input!: HTMLInputElement;
  private count!: HTMLSpanElement;
  private previousButton!: HTMLButtonElement;
  private nextButton!: HTMLButtonElement;
  private readonly optionInputs = new Map<string, HTMLInputElement>();
  private readonly optionLabels: { element: HTMLLabelElement; spec: FindOptionSpec }[] = [];
  private readonly labelBindings: { element: HTMLElement; key: MessageKey }[] = [];

  /**
   * 创建查找栏。
   *
   * @param options 查找栏选项。
   */
  constructor(private readonly options: FindbarOptions) {
    this.element = options.element;
    this.translator = options.translator;
    this.featureStates = options.featureStates;
    this.findState = options.findState;
    this.build();
    this.applyFeatureGate();
    this.update(options.findState);
    this.element.hidden = true;
  }

  /** 是否打开。 */
  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /**
   * 打开查找栏并聚焦输入框。
   *
   * @returns 打开成功返回 true；功能被关闭时返回 false。
   */
  open(): boolean {
    if (!this.gate?.enabled) return false;
    if (this.isOpen) {
      this.input.focus();
      return true;
    }
    const active = this.element.ownerDocument.activeElement;
    this.previouslyFocused = active instanceof HTMLElement ? active : null;
    this.element.hidden = false;
    this.input.focus();
    return true;
  }

  /**
   * 关闭查找栏。
   *
   * @param restoreFocus 是否把焦点还给打开前的元素；默认 true。
   */
  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    if (restoreFocus) {
      const active = this.element.ownerDocument.activeElement;
      if (
        active instanceof HTMLElement &&
        this.element.contains(active) &&
        this.previouslyFocused?.isConnected
      ) {
        this.previouslyFocused.focus();
      }
    }
    this.previouslyFocused = null;
  }

  /** 聚焦输入框。 */
  focus(): void {
    if (this.isOpen) this.input.focus();
  }

  /**
   * 刷新查找状态。
   *
   * @param state 最新查找状态。
   */
  update(state: FindState): void {
    this.findState = state;
    if (this.element.ownerDocument.activeElement !== this.input) {
      this.input.value = state.query;
    }
    for (const spec of FIND_OPTIONS) {
      const input = this.optionInputs.get(spec.key);
      if (input) input.checked = state[spec.key];
    }

    const total = this.translator.formatNumber(state.total);
    const current = this.translator.formatNumber(state.current);
    if (state.searching) {
      this.count.textContent = this.translator.t('findbar.searching');
      this.count.setAttribute('aria-busy', 'true');
    } else if (state.query.length === 0) {
      this.count.textContent = '';
      this.count.removeAttribute('aria-busy');
    } else if (state.total === 0) {
      this.count.textContent = this.translator.t('findbar.noResults');
      this.count.removeAttribute('aria-busy');
    } else {
      this.count.textContent = this.translator.t('findbar.count', {
        current,
        total,
      });
      this.count.removeAttribute('aria-busy');
    }
    this.refreshDisabled();
  }

  /**
   * 更新功能状态。
   *
   * @param states 全部功能状态。
   */
  setFeatureStates(states: ViewerFeatureStates): void {
    this.featureStates = states;
    this.applyFeatureGate();
    if (!this.gate?.enabled) this.close(false);
    this.refreshDisabled();
  }

  /**
   * 切换语言。
   *
   * @param translator 新翻译器。
   */
  setLocale(translator: Translator): void {
    this.translator = translator;
    this.element.setAttribute('aria-label', translator.t('findbar.label'));
    this.input.setAttribute('aria-label', translator.t('findbar.placeholder'));
    this.input.placeholder = translator.t('findbar.placeholder');
    this.previousButton.setAttribute('aria-label', translator.t('findbar.previous'));
    this.nextButton.setAttribute('aria-label', translator.t('findbar.next'));
    const closeButton = this.element.querySelector<HTMLButtonElement>(
      '.ofd-findbar__close',
    );
    closeButton?.setAttribute('aria-label', translator.t('findbar.close'));
    for (const binding of this.labelBindings) {
      binding.element.setAttribute('aria-label', translator.t(binding.key));
      binding.element.title = translator.t(binding.key);
    }
    for (const { element, spec } of this.optionLabels) {
      const short = element.querySelector<HTMLElement>('.ofd-findbar__option-text');
      if (short) short.textContent = translator.t(spec.shortKey);
    }
    this.update(this.findState);
  }

  /** 释放事件与 DOM。 */
  destroy(): void {
    replaceChildren(this.element);
    this.element.hidden = true;
  }

  /** 构建 DOM。 */
  private build(): void {
    const doc = this.element.ownerDocument;
    this.element.classList.add('ofd-viewer__findbar');
    this.element.setAttribute('role', 'search');
    this.element.setAttribute('aria-label', this.translator.t('findbar.label'));
    replaceChildren(this.element);

    this.input = doc.createElement('input');
    this.input.className = 'ofd-input ofd-findbar__input';
    this.input.type = 'search';
    this.input.setAttribute('role', 'searchbox');
    this.input.setAttribute('aria-label', this.translator.t('findbar.placeholder'));
    this.input.placeholder = this.translator.t('findbar.placeholder');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.addEventListener('input', this.handleInput);
    this.input.addEventListener('keydown', this.handleInputKeydown);

    this.count = doc.createElement('span');
    this.count.className = 'ofd-findbar__count';
    this.count.setAttribute('aria-live', 'polite');
    this.count.setAttribute('aria-atomic', 'true');

    this.previousButton = this.createIconButton(
      'findbar-previous',
      'previous',
      'findbar.previous',
    );
    this.previousButton.addEventListener('click', () => {
      this.options.onCommand({ type: 'find.previous' });
    });

    this.nextButton = this.createIconButton(
      'findbar-next',
      'next',
      'findbar.next',
    );
    this.nextButton.addEventListener('click', () => {
      this.options.onCommand({ type: 'find.next' });
    });

    const closeButton = this.createIconButton('findbar-close', 'close', 'findbar.close');
    closeButton.classList.add('ofd-findbar__close');
    closeButton.addEventListener('click', () => {
      this.options.onRequestClose();
    });

    const optionsWrap = doc.createElement('div');
    optionsWrap.className = 'ofd-findbar__options';
    optionsWrap.setAttribute('role', 'group');
    optionsWrap.setAttribute('aria-label', this.translator.t('findbar.label'));
    for (const spec of FIND_OPTIONS) {
      const label = doc.createElement('label');
      label.className = 'ofd-findbar__option';
      label.htmlFor = `${this.options.idPrefix}-${spec.key}`;
      label.title = this.translator.t(spec.labelKey);
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'ofd-findbar__checkbox';
      checkbox.id = `${this.options.idPrefix}-${spec.key}`;
      checkbox.setAttribute('aria-label', this.translator.t(spec.labelKey));
      checkbox.checked = this.findState[spec.key];
      checkbox.addEventListener('change', () => this.emitQuery());
      const text = doc.createElement('span');
      text.className = 'ofd-findbar__option-text';
      text.setAttribute('aria-hidden', 'true');
      text.textContent = this.translator.t(spec.shortKey);
      label.append(checkbox, text);
      optionsWrap.appendChild(label);
      this.optionInputs.set(spec.key, checkbox);
      this.optionLabels.push({ element: label, spec });
    }

    this.element.append(
      this.input,
      this.count,
      this.previousButton,
      this.nextButton,
      optionsWrap,
      closeButton,
    );
  }

  /** 创建带图标的查找栏按钮。 */
  private createIconButton(
    id: string,
    icon: 'previous' | 'next' | 'close',
    labelKey: MessageKey,
  ): HTMLButtonElement {
    const button = this.element.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'ofd-button ofd-findbar__button';
    button.dataset.ofdControl = id;
    const label = this.translator.t(labelKey);
    button.setAttribute('aria-label', label);
    button.title = label;
    button.appendChild(createIcon(icon));
    this.labelBindings.push({ element: button, key: labelKey });
    return button;
  }

  /** 应用功能门控。 */
  private applyFeatureGate(): void {
    const gate = resolveFeatureGate(
      this.featureStates,
      'find',
      this.translator,
    );
    this.gate = {
      enabled: gate.visible && !gate.disabled,
      visible: gate.visible,
      reason: gate.reason,
    };
    // 容器显隐只由 open()/close() 控制；门控仅作用于内部控件。
    setDisabled(this.input, !this.gate.enabled, gate.tooltip);
    for (const input of this.optionInputs.values()) {
      setDisabled(input, !this.gate.enabled, gate.tooltip);
    }
  }

  /** 合并功能门控与计数条件。 */
  private refreshDisabled(): void {
    const enabled = this.gate?.enabled ?? true;
    const noMatch =
      !enabled ||
      this.findState.searching ||
      this.findState.total === 0 ||
      this.findState.query.length === 0;
    setDisabled(this.previousButton, noMatch);
    setDisabled(this.nextButton, noMatch);
    setDisabled(this.input, !enabled);
  }

  /** 读取当前选项并发出查询命令。 */
  private emitQuery(): void {
    const query = this.input.value;
    if (query.length === 0) {
      this.options.onCommand({ type: 'find.clear' });
      return;
    }
    this.options.onCommand({
      type: 'find.query',
      query,
      caseSensitive: this.optionInputs.get('caseSensitive')?.checked ?? false,
      wholeWord: this.optionInputs.get('wholeWord')?.checked ?? false,
      highlightAll: this.optionInputs.get('highlightAll')?.checked ?? true,
    });
  }

  /** 输入事件。 */
  private readonly handleInput = (): void => {
    this.emitQuery();
  };

  /** 输入键盘：Enter 下一个、Shift+Enter 上一个、Esc 关闭。 */
  private readonly handleInputKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.options.onCommand({
        type: event.shiftKey ? 'find.previous' : 'find.next',
      });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.options.onRequestClose();
    }
  };
}