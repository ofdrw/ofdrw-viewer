/**
 * 内置工具栏（设计方案 §5.2）。
 *
 * 只负责 DOM 与交互，不复制阅读逻辑：
 * - 每个控件绑定一个 `ViewerFeature`，由 `FeatureState` 决定隐藏/禁用；
 * - 点击/输入统一通过 `UIShellCommand` 交给核心；
 * - 断点差异全部交给 CSS（`data-viewport`），工具栏不维护第二套 DOM；
 * - 桌面完整、紧凑/移动精简、窄屏仅保留核心控件，其余进入“更多”菜单。
 */
import { setExpanded, setPressed } from '../a11y';
import type { ViewerFeature, ViewerFeatureStates } from '../features';
import type { MessageKey, Translator } from '../i18n';
import { MAX_SCALE, MIN_SCALE } from '../options';
import type { ZoomMode } from '../state';
import {
  applyFeatureGate,
  resolveFeatureGate,
  syncControlDisabled,
} from './feature-control';
import type { FeatureGate } from './feature-control';
import { createIcon, setButtonIcon } from './icons';
import type { IconName } from './icons';
import { MoreMenu } from './more-menu';
import type {
  UIShellCommand,
  UIShellCommandHandler,
  UIShellViewState,
} from './types';

/** 下拉中预置的百分比档位。 */
const ZOOM_PRESETS: readonly number[] = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);

/** 缩放模式与文案键。 */
const ZOOM_MODE_OPTIONS: readonly (readonly [ZoomMode, MessageKey])[] = Object.freeze([
  ['auto', 'toolbar.zoomAuto'],
  ['page-actual', 'toolbar.zoomActual'],
  ['page-fit', 'toolbar.zoomFitPage'],
  ['page-width', 'toolbar.zoomFitWidth'],
]);

/** 控件登记项。 */
interface ControlEntry {
  /** 实际控件（按钮/输入/下拉）。 */
  readonly element: HTMLElement;
  /** 所属功能。 */
  readonly feature: ViewerFeature;
  /** 需要隐藏时优先隐藏的容器（例如页码输入的外层）。 */
  readonly visibilityTarget?: HTMLElement;
  /** 功能门控结果。 */
  gate: FeatureGate;
  /** 控件自身条件（页码边界、缩放上下限、无文档）。 */
  stateDisabled: boolean;
}

/** 静态文案绑定。 */
interface LabelBinding {
  readonly element: HTMLElement;
  readonly key: MessageKey;
}

/** 工具栏选项。 */
export interface ToolbarOptions {
  /** 核心创建的工具栏容器。 */
  readonly element: HTMLElement;
  /** 翻译器。 */
  readonly translator: Translator;
  /** 功能状态。 */
  readonly featureStates: ViewerFeatureStates;
  /** 初始视图状态。 */
  readonly state: UIShellViewState;
  /** 侧栏元素 id，用于 `aria-controls`。 */
  readonly sidebarId: string;
  /** 命令回调。 */
  readonly onCommand: UIShellCommandHandler;
}

/**
 * 内置工具栏。
 */
export class Toolbar {
  /** 工具栏根元素。 */
  readonly element: HTMLElement;
  private translator: Translator;
  private featureStates: ViewerFeatureStates;
  private viewState: UIShellViewState;
  private findOpen = false;
  private fullscreenIcon: IconName = 'fullscreen';

  private readonly entries = new Map<string, ControlEntry>();
  private readonly controls = new Map<string, HTMLElement>();
  private readonly labelBindings: LabelBinding[] = [];
  private readonly groups: { element: HTMLElement; key: MessageKey }[] = [];

  private sidebarButton!: HTMLButtonElement;
  private findButton!: HTMLButtonElement;
  private fullscreenButton!: HTMLButtonElement;
  private rotateButton!: HTMLButtonElement;
  private pageInput!: HTMLInputElement;
  private pageInputWrapper!: HTMLSpanElement;
  private pageTotal!: HTMLSpanElement;
  private zoomSelect!: HTMLSelectElement;
  private moreMenu!: MoreMenu;

  /**
   * 创建工具栏并填充控件。
   *
   * @param options 工具栏选项。
   */
  constructor(private readonly options: ToolbarOptions) {
    this.element = options.element;
    this.translator = options.translator;
    this.featureStates = options.featureStates;
    this.viewState = options.state;
    this.build();
    this.applyFeatureGates();
    this.update(options.state);
  }

  /**
   * 刷新视图状态。
   *
   * @param state 最新视图状态。
   */
  update(state: UIShellViewState): void {
    this.viewState = state;
    const { pageNumber, pageCount, scale, zoomMode, rotation, fullscreen, sidebarView } =
      state;

    if (this.element.ownerDocument.activeElement !== this.pageInput) {
      this.pageInput.value = pageCount > 0 ? String(pageNumber) : '';
    }
    this.pageInput.max = String(Math.max(1, pageCount));
    this.pageInput.title =
      pageCount > 0
        ? this.translator.t('toolbar.pageNumberOf', {
            page: this.translator.formatNumber(pageNumber),
            total: this.translator.formatNumber(pageCount),
          })
        : this.translator.t('toolbar.pageNumber');
    this.pageTotal.textContent =
      pageCount > 0
        ? this.translator.t('toolbar.pageTotal', {
            total: this.translator.formatNumber(pageCount),
          })
        : '';

    const sidebarOpen = sidebarView !== null;
    setExpanded(this.sidebarButton, sidebarOpen);
    setPressed(this.sidebarButton, sidebarOpen);
    this.sidebarButton.setAttribute(
      'aria-label',
      this.translator.t(
        sidebarOpen ? 'toolbar.toggleSidebarHide' : 'toolbar.toggleSidebarShow',
      ),
    );
    setPressed(this.fullscreenButton, fullscreen);
    this.fullscreenButton.setAttribute(
      'aria-label',
      this.translator.t(fullscreen ? 'toolbar.exitFullscreen' : 'toolbar.fullscreen'),
    );
    const nextIcon: IconName = fullscreen ? 'fullscreen-exit' : 'fullscreen';
    if (nextIcon !== this.fullscreenIcon) {
      this.fullscreenIcon = nextIcon;
      setButtonIcon(this.fullscreenButton, nextIcon);
    }

    if (!(this.entries.get('rotate')?.gate.disabled ?? false)) {
      this.rotateButton.title = this.translator.t('toolbar.rotationValue', {
        value: this.translator.formatNumber(rotation),
      });
    }

    this.zoomSelect.value = this.resolveZoomSelectValue(scale, zoomMode);
    this.refreshDisabled();
    this.moreMenu.update(state);
  }

  /**
   * 更新功能状态。
   *
   * @param states 全部功能状态。
   */
  setFeatureStates(states: ViewerFeatureStates): void {
    this.featureStates = states;
    this.applyFeatureGates();
    this.update(this.viewState);
  }

  /**
   * 切换语言：原地更新文本与 aria 名称，不重建工具栏。
   *
   * @param translator 新翻译器。
   */
  setLocale(translator: Translator): void {
    this.translator = translator;
    this.element.setAttribute('aria-label', translator.t('toolbar.label'));
    for (const group of this.groups) {
      group.element.setAttribute('aria-label', translator.t(group.key));
    }
    for (const binding of this.labelBindings) {
      binding.element.setAttribute('aria-label', translator.t(binding.key));
    }
    this.pageInput.setAttribute('aria-label', translator.t('toolbar.pageNumber'));
    this.zoomSelect.setAttribute('aria-label', translator.t('toolbar.zoomMode'));
    this.buildZoomOptions();
    this.applyFeatureGates();
    this.update(this.viewState);
    this.moreMenu.setLocale(translator);
  }

  /**
   * 同步查找栏开关状态。
   *
   * @param open 是否打开。
   */
  setFindOpen(open: boolean): void {
    this.findOpen = open;
    setExpanded(this.findButton, open);
    setPressed(this.findButton, open);
  }

  /**
   * 读取控件（用于焦点恢复与测试）。
   *
   * @param id 控件 id。
   * @returns 控件元素；不存在时返回 null。
   */
  getControl(id: string): HTMLElement | null {
    return this.controls.get(id) ?? null;
  }

  /** 侧栏切换按钮。 */
  getSidebarButton(): HTMLButtonElement {
    return this.sidebarButton;
  }

  /** 查找按钮。 */
  getFindButton(): HTMLButtonElement {
    return this.findButton;
  }

  /** 释放事件与菜单。 */
  destroy(): void {
    this.moreMenu.destroy();
    this.element.replaceChildren();
  }

  /** 构建工具栏 DOM。 */
  private build(): void {
    this.element.classList.add('ofd-viewer__toolbar');
    this.element.setAttribute('role', 'toolbar');
    this.element.setAttribute('aria-label', this.translator.t('toolbar.label'));
    this.element.replaceChildren();

    const sidebarGroup = this.createGroup('toolbar.groupSidebar');
    this.sidebarButton = this.createButton(
      'sidebar',
      'sidebar',
      'toolbar.toggleSidebarShow',
      'sidebar',
    );
    this.sidebarButton.setAttribute('aria-controls', this.options.sidebarId);
    this.sidebarButton.addEventListener('click', () => {
      this.options.onCommand({ type: 'sidebar.toggle' });
    });
    sidebarGroup.appendChild(this.sidebarButton);

    const navGroup = this.createGroup('toolbar.groupNavigation');
    const previous = this.createButton(
      'previousPage',
      'previous',
      'toolbar.previousPage',
      'pageNavigation',
      'compact',
    );
    previous.addEventListener('click', () => {
      this.options.onCommand({ type: 'page.previous' });
    });
    navGroup.appendChild(previous);

    this.pageInputWrapper = this.element.ownerDocument.createElement('span');
    this.pageInputWrapper.className = 'ofd-toolbar__page-number';
    this.pageInput = this.element.ownerDocument.createElement('input');
    this.pageInput.className = 'ofd-input ofd-toolbar__page-input';
    this.pageInput.type = 'number';
    this.pageInput.min = '1';
    this.pageInput.step = '1';
    this.pageInput.inputMode = 'numeric';
    this.pageInput.autocomplete = 'off';
    this.pageInput.setAttribute('aria-label', this.translator.t('toolbar.pageNumber'));
    this.pageInput.addEventListener('keydown', this.handlePageKeydown);
    this.pageInput.addEventListener('blur', this.handlePageCommit);
    this.pageTotal = this.element.ownerDocument.createElement('span');
    this.pageTotal.className = 'ofd-toolbar__page-count';
    this.pageTotal.setAttribute('aria-hidden', 'true');
    this.pageInputWrapper.append(this.pageInput, this.pageTotal);
    navGroup.appendChild(this.pageInputWrapper);
    this.registerControl('pageNumber', this.pageInput, 'pageNumberInput', {
      visibilityTarget: this.pageInputWrapper,
    });

    const next = this.createButton(
      'nextPage',
      'next',
      'toolbar.nextPage',
      'pageNavigation',
      'compact',
    );
    next.addEventListener('click', () => {
      this.options.onCommand({ type: 'page.next' });
    });
    navGroup.appendChild(next);

    const zoomGroup = this.createGroup('toolbar.groupZoom');
    const zoomOut = this.createButton(
      'zoomOut',
      'zoom-out',
      'toolbar.zoomOut',
      'zoom',
      'narrow',
    );
    zoomOut.addEventListener('click', () => {
      this.options.onCommand({ type: 'zoom.out' });
    });
    zoomGroup.appendChild(zoomOut);

    const zoomIn = this.createButton(
      'zoomIn',
      'zoom-in',
      'toolbar.zoomIn',
      'zoom',
      'narrow',
    );
    zoomIn.addEventListener('click', () => {
      this.options.onCommand({ type: 'zoom.in' });
    });
    zoomGroup.appendChild(zoomIn);

    this.zoomSelect = this.element.ownerDocument.createElement('select');
    this.zoomSelect.className = 'ofd-select ofd-toolbar__zoom-select';
    this.zoomSelect.dataset.overflow = 'narrow';
    this.zoomSelect.setAttribute('aria-label', this.translator.t('toolbar.zoomMode'));
    this.zoomSelect.addEventListener('change', this.handleZoomChange);
    this.buildZoomOptions();
    zoomGroup.appendChild(this.zoomSelect);
    this.registerControl('zoomMode', this.zoomSelect, 'zoom');

    const viewGroup = this.createGroup('toolbar.groupView');
    this.rotateButton = this.createButton(
      'rotate',
      'rotate',
      'toolbar.rotateClockwise',
      'rotate',
      'compact',
    );
    this.rotateButton.dataset.ofdControl = 'rotate';
    this.rotateButton.addEventListener('click', () => {
      this.options.onCommand({ type: 'rotate.clockwise' });
    });
    viewGroup.appendChild(this.rotateButton);

    this.findButton = this.createButton(
      'find',
      'search',
      'toolbar.find',
      'find',
      'compact',
    );
    this.findButton.addEventListener('click', () => {
      this.options.onCommand({ type: 'find.open' });
    });
    setExpanded(this.findButton, false);
    viewGroup.appendChild(this.findButton);

    const print = this.createButton(
      'print',
      'print',
      'toolbar.print',
      'print',
      'compact',
    );
    print.addEventListener('click', () => {
      this.options.onCommand({ type: 'print.open' });
    });
    viewGroup.appendChild(print);

    const exportButton = this.createButton(
      'export',
      'export',
      'toolbar.export',
      'export',
      'compact',
    );
    exportButton.addEventListener('click', () => {
      this.options.onCommand({ type: 'export.open' });
    });
    viewGroup.appendChild(exportButton);

    const signatures = this.createButton(
      'signatures',
      'signature',
      'toolbar.signatures',
      'signatures',
      'compact',
    );
    signatures.addEventListener('click', () => {
      this.options.onCommand({ type: 'signatures.open' });
    });
    viewGroup.appendChild(signatures);

    const verification = this.createButton(
      'verification',
      'shield',
      'toolbar.verification',
      'verification',
      'compact',
    );
    verification.addEventListener('click', () => {
      this.options.onCommand({ type: 'verification.open' });
    });
    viewGroup.appendChild(verification);

    this.fullscreenButton = this.createButton(
      'fullscreen',
      'fullscreen',
      'toolbar.fullscreen',
      'fullscreen',
      'compact',
    );
    setPressed(this.fullscreenButton, false);
    this.fullscreenButton.addEventListener('click', () => {
      this.options.onCommand({
        type: 'fullscreen.set',
        value: !this.viewState.fullscreen,
      });
    });
    viewGroup.appendChild(this.fullscreenButton);

    const moreGroup = this.createGroup('toolbar.groupDocument');
    const moreContainer = this.element.ownerDocument.createElement('div');
    moreContainer.className = 'ofd-toolbar__item ofd-toolbar__item--more';
    const moreButton = this.element.ownerDocument.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'ofd-button ofd-toolbar__button';
    moreButton.dataset.ofdControl = 'more';
    moreButton.setAttribute('aria-label', this.translator.t('toolbar.more'));
    moreButton.setAttribute('aria-haspopup', 'menu');
    setExpanded(moreButton, false);
    moreButton.appendChild(createIcon('more'));
    moreContainer.appendChild(moreButton);
    moreGroup.appendChild(moreContainer);
    this.moreMenu = new MoreMenu({
      button: moreButton,
      container: moreContainer,
      translator: this.translator,
      featureStates: this.featureStates,
      state: this.viewState,
      onCommand: this.options.onCommand,
    });
  }

  /** 创建分组。 */
  private createGroup(key: MessageKey): HTMLDivElement {
    const group = this.element.ownerDocument.createElement('div');
    group.className = 'ofd-toolbar__group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', this.translator.t(key));
    this.element.appendChild(group);
    this.groups.push({ element: group, key });
    return group;
  }

  /** 创建图标按钮。 */
  private createButton(
    id: string,
    icon: IconName,
    labelKey: MessageKey,
    feature: ViewerFeature,
    overflow?: 'compact' | 'narrow',
  ): HTMLButtonElement {
    const button = this.element.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'ofd-button ofd-toolbar__button';
    button.dataset.ofdControl = id;
    if (overflow) button.dataset.overflow = overflow;
    button.setAttribute('aria-label', this.translator.t(labelKey));
    button.appendChild(createIcon(icon));
    this.registerControl(id, button, feature);
    this.labelBindings.push({ element: button, key: labelKey });
    return button;
  }

  /** 登记控件（功能门控 + 自身禁用状态）。 */
  private registerControl(
    id: string,
    element: HTMLElement,
    feature: ViewerFeature,
    extra: { visibilityTarget?: HTMLElement } = {},
  ): void {
    this.entries.set(id, {
      element,
      feature,
      visibilityTarget: extra.visibilityTarget,
      gate: { visible: true, disabled: false },
      stateDisabled: false,
    });
    this.controls.set(id, element);
  }

  /** 构建缩放下拉选项。 */
  private buildZoomOptions(): void {
    const doc = this.element.ownerDocument;
    const previousValue = this.zoomSelect.value;
    this.zoomSelect.replaceChildren();
    for (const [mode, key] of ZOOM_MODE_OPTIONS) {
      const option = doc.createElement('option');
      option.value = mode;
      option.textContent = this.translator.t(key);
      this.zoomSelect.appendChild(option);
    }
    for (const level of ZOOM_PRESETS) {
      const option = doc.createElement('option');
      option.value = `scale:${level}`;
      option.textContent = this.translator.t('toolbar.zoomPercent', {
        value: this.translator.formatNumber(level * 100, {
          maximumFractionDigits: 0,
        }),
      });
      this.zoomSelect.appendChild(option);
    }
    if (previousValue) this.zoomSelect.value = previousValue;
  }

  /** 根据当前缩放选择下拉值。 */
  private resolveZoomSelectValue(scale: number, mode: ZoomMode): string {
    if (mode !== 'auto') return mode;
    const preset = ZOOM_PRESETS.find((level) => Math.abs(level - scale) < 0.005);
    return preset === undefined ? 'auto' : `scale:${preset}`;
  }

  /** 应用功能门控。 */
  private applyFeatureGates(): void {
    for (const entry of this.entries.values()) {
      const gate = resolveFeatureGate(
        this.featureStates,
        entry.feature,
        this.translator,
      );
      entry.gate = gate;
      applyFeatureGate(entry.visibilityTarget ?? entry.element, gate);
      syncControlDisabled(entry.element, gate, entry.stateDisabled);
    }
  }

  /** 合并功能门控与状态禁用。 */
  private refreshDisabled(): void {
    for (const [id, entry] of this.entries) {
      entry.stateDisabled = this.computeStateDisabled(id, this.viewState);
      syncControlDisabled(entry.element, entry.gate, entry.stateDisabled);
    }
  }

  /** 控件自身的禁用条件。 */
  private computeStateDisabled(id: string, state: UIShellViewState): boolean {
    if (id === 'sidebar' || id === 'fullscreen') return false;
    if (state.pageCount <= 0) return true;
    switch (id) {
      case 'previousPage':
        return state.pageNumber <= 1;
      case 'nextPage':
        return state.pageNumber >= state.pageCount;
      case 'zoomIn':
        return state.scale >= MAX_SCALE - 1e-6;
      case 'zoomOut':
        return state.scale <= MIN_SCALE + 1e-6;
      default:
        return false;
    }
  }

  /** 页码输入键盘。 */
  private readonly handlePageKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitPage();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.pageInput.value =
        this.viewState.pageCount > 0 ? String(this.viewState.pageNumber) : '';
      this.pageInput.blur();
    }
  };

  /** 页码输入失焦。 */
  private readonly handlePageCommit = (): void => {
    this.commitPage();
  };

  /** 提交页码输入；非法值恢复当前页。 */
  private commitPage(): void {
    const { pageNumber, pageCount } = this.viewState;
    const parsed = Number.parseInt(this.pageInput.value, 10);
    const valid =
      Number.isFinite(parsed) &&
      parsed >= 1 &&
      (pageCount <= 0 || parsed <= pageCount);
    if (!valid || parsed === pageNumber) {
      this.pageInput.value = pageCount > 0 ? String(pageNumber) : '';
      return;
    }
    this.pageInput.value = String(parsed);
    this.options.onCommand({ type: 'page.go', page: parsed });
  }

  /** 缩放下拉变化。 */
  private readonly handleZoomChange = (): void => {
    const value = this.zoomSelect.value;
    if (value.startsWith('scale:')) {
      const scale = Number.parseFloat(value.slice('scale:'.length));
      if (Number.isFinite(scale)) {
        this.options.onCommand({ type: 'zoom.set', scale });
      }
      return;
    }
    this.options.onCommand({ type: 'zoom.set', scale: value as ZoomMode });
  };
}
