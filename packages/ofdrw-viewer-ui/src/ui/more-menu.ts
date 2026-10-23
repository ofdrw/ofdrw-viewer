/**
 * 工具栏“更多”菜单。
 *
 * 桌面端只包含低频操作（文档属性）；紧凑/移动/窄屏断点下，工具栏中被 CSS
 * 隐藏的控件会出现在这里，保证核心操作不丢失。菜单项同样受 FeatureState 控制。
 */
import { setExpanded } from '../a11y';
import type { ViewerFeature, ViewerFeatureStates } from '../features';
import type { MessageKey, Translator } from '../i18n';
import type { SidebarView } from '../state';
import {
  applyFeatureGate,
  resolveFeatureGate,
  syncControlDisabled,
} from './feature-control';
import type { FeatureGate } from './feature-control';
import type {
  UIShellCommand,
  UIShellCommandHandler,
  UIShellViewState,
} from './types';

/** 菜单项可见断点。 */
type MenuVisibility = 'overflow' | 'narrow' | 'always';

/** 菜单项定义。 */
interface MenuItemSpec {
  /** 控件 id（`data-ofd-control`）。 */
  readonly id: string;
  /** 文案键。 */
  readonly labelKey: MessageKey;
  /** 所属功能；省略表示不受功能开关控制（如“关于”）。 */
  readonly feature?: ViewerFeature;
  /** 在哪些断点显示。 */
  readonly visibility: MenuVisibility;
  /** 根据当前状态构造命令。 */
  readonly command: (state: UIShellViewState) => UIShellCommand;
  /** 文档未打开时是否禁用；默认 true。 */
  readonly requiresDocument?: boolean;
}

/** 菜单项实例。 */
interface MenuItem {
  readonly spec: MenuItemSpec;
  readonly element: HTMLButtonElement;
  gate: FeatureGate;
  stateDisabled: boolean;
}

/** 菜单项定义（顺序即菜单顺序）。 */
const MENU_ITEMS: readonly MenuItemSpec[] = [
  {
    id: 'menu-previous',
    labelKey: 'toolbar.previousPage',
    feature: 'pageNavigation',
    visibility: 'overflow',
    command: () => ({ type: 'page.previous' }),
  },
  {
    id: 'menu-next',
    labelKey: 'toolbar.nextPage',
    feature: 'pageNavigation',
    visibility: 'overflow',
    command: () => ({ type: 'page.next' }),
  },
  {
    id: 'menu-zoom-out',
    labelKey: 'toolbar.zoomOut',
    feature: 'zoom',
    visibility: 'narrow',
    command: () => ({ type: 'zoom.out' }),
  },
  {
    id: 'menu-zoom-in',
    labelKey: 'toolbar.zoomIn',
    feature: 'zoom',
    visibility: 'narrow',
    command: () => ({ type: 'zoom.in' }),
  },
  {
    id: 'menu-fit-page',
    labelKey: 'toolbar.zoomFitPage',
    feature: 'zoom',
    visibility: 'narrow',
    command: () => ({ type: 'zoom.set', scale: 'page-fit' }),
  },
  {
    id: 'menu-fit-width',
    labelKey: 'toolbar.zoomFitWidth',
    feature: 'zoom',
    visibility: 'narrow',
    command: () => ({ type: 'zoom.set', scale: 'page-width' }),
  },
  {
    id: 'menu-rotate',
    labelKey: 'toolbar.rotate',
    feature: 'rotate',
    visibility: 'overflow',
    command: () => ({ type: 'rotate.clockwise' }),
  },
  {
    id: 'menu-find',
    labelKey: 'toolbar.find',
    feature: 'find',
    visibility: 'overflow',
    command: () => ({ type: 'find.open' }),
  },
  {
    id: 'menu-print',
    labelKey: 'toolbar.print',
    feature: 'print',
    visibility: 'overflow',
    command: () => ({ type: 'print.open' }),
  },
  {
    id: 'menu-export',
    labelKey: 'toolbar.export',
    feature: 'export',
    visibility: 'overflow',
    command: () => ({ type: 'export.open' }),
  },
  {
    id: 'menu-signatures',
    labelKey: 'toolbar.signatures',
    feature: 'signatures',
    visibility: 'overflow',
    command: (): UIShellCommand => {
      const view: SidebarView = 'signatures';
      return { type: 'sidebar.open', view };
    },
  },
  {
    id: 'menu-fullscreen',
    labelKey: 'toolbar.fullscreen',
    feature: 'fullscreen',
    visibility: 'overflow',
    command: (state) => ({ type: 'fullscreen.set', value: !state.fullscreen }),
    requiresDocument: false,
  },
  {
    id: 'menu-properties',
    labelKey: 'toolbar.documentProperties',
    feature: 'documentProperties',
    visibility: 'always',
    command: () => ({ type: 'document.properties' }),
  },
  {
    id: 'menu-about',
    labelKey: 'toolbar.about',
    visibility: 'always',
    command: () => ({ type: 'about.open' }),
    requiresDocument: false,
  },
];

/** “更多”菜单选项。 */
export interface MoreMenuOptions {
  /** 触发按钮。 */
  readonly button: HTMLButtonElement;
  /** 按钮容器（菜单绝对定位的参照）。 */
  readonly container: HTMLElement;
  /** 翻译器。 */
  readonly translator: Translator;
  /** 功能状态。 */
  readonly featureStates: ViewerFeatureStates;
  /** 视图状态。 */
  readonly state: UIShellViewState;
  /** 命令回调。 */
  readonly onCommand: UIShellCommandHandler;
}

/**
 * “更多”菜单。
 */
export class MoreMenu {
  /** 菜单元素。 */
  readonly element: HTMLDivElement;
  private readonly items: MenuItem[] = [];
  private translator: Translator;
  private featureStates: ViewerFeatureStates;
  private viewState: UIShellViewState;
  private menuOpen = false;
  private readonly doc: Document;

  /**
   * 创建菜单。
   *
   * @param options 菜单选项。
   */
  constructor(private readonly options: MoreMenuOptions) {
    this.translator = options.translator;
    this.featureStates = options.featureStates;
    this.viewState = options.state;
    this.doc = options.button.ownerDocument;

    this.element = this.doc.createElement('div');
    this.element.className = 'ofd-more-menu';
    this.element.setAttribute('role', 'menu');
    this.element.setAttribute('aria-label', this.translator.t('toolbar.more'));
    this.element.hidden = true;
    this.buildItems();
    options.container.appendChild(this.element);

    options.button.addEventListener('click', this.handleButtonClick);
    options.button.addEventListener('keydown', this.handleButtonKeydown);
    setExpanded(options.button, false);
    this.applyFeatureStates();
    this.update(this.viewState);
  }

  /** 菜单是否打开。 */
  get isOpen(): boolean {
    return this.menuOpen;
  }

  /**
   * 打开菜单并把焦点移到第一个可用菜单项。
   */
  open(): void {
    if (this.menuOpen) return;
    this.menuOpen = true;
    this.element.hidden = false;
    setExpanded(this.options.button, true);
    this.doc.addEventListener('pointerdown', this.handleOutsidePointer, true);
    const [first] = this.getEnabledItems();
    first?.focus();
  }

  /**
   * 关闭菜单。
   *
   * @param restoreFocus 是否把焦点还给触发按钮；默认 true。
   */
  close(restoreFocus = true): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.element.hidden = true;
    setExpanded(this.options.button, false);
    this.doc.removeEventListener('pointerdown', this.handleOutsidePointer, true);
    const active = this.doc.activeElement;
    if (restoreFocus && active instanceof HTMLElement && this.element.contains(active)) {
      this.options.button.focus();
    }
  }

  /** 切换菜单。 */
  toggle(): void {
    if (this.menuOpen) this.close();
    else this.open();
  }

  /**
   * 刷新视图状态（页码、缩放、全屏等）。
   *
   * @param state 最新视图状态。
   */
  update(state: UIShellViewState): void {
    this.viewState = state;
    for (const item of this.items) {
      item.stateDisabled = this.isStateDisabled(item.spec, state);
    }
    this.refreshDisabled();
    const fullscreenItem = this.items.find((item) => item.spec.id === 'menu-fullscreen');
    if (fullscreenItem) {
      fullscreenItem.element.textContent = this.translator.t(
        state.fullscreen ? 'toolbar.exitFullscreen' : 'toolbar.fullscreen',
      );
    }
  }

  /**
   * 更新功能状态。
   *
   * @param states 全部功能状态。
   */
  setFeatureStates(states: ViewerFeatureStates): void {
    this.featureStates = states;
    this.applyFeatureStates();
    this.refreshDisabled();
  }

  /**
   * 切换语言。
   *
   * @param translator 新翻译器。
   */
  setLocale(translator: Translator): void {
    this.translator = translator;
    this.element.setAttribute('aria-label', translator.t('toolbar.more'));
    for (const item of this.items) {
      item.element.textContent = translator.t(item.spec.labelKey);
    }
    this.applyFeatureStates();
    this.update(this.viewState);
  }

  /** 释放事件与 DOM。 */
  destroy(): void {
    this.close(false);
    this.options.button.removeEventListener('click', this.handleButtonClick);
    this.options.button.removeEventListener('keydown', this.handleButtonKeydown);
    this.element.remove();
  }

  /** 创建菜单项。 */
  private buildItems(): void {
    for (const spec of MENU_ITEMS) {
      const item = this.doc.createElement('button');
      item.type = 'button';
      item.className = 'ofd-more-menu__item';
      item.setAttribute('role', 'menuitem');
      item.dataset.ofdControl = spec.id;
      item.dataset.menuVisibility = spec.visibility;
      item.textContent = this.translator.t(spec.labelKey);
      item.addEventListener('click', () => {
        this.close(false);
        this.options.onCommand(spec.command(this.viewState));
      });
      this.element.appendChild(item);
      this.items.push({
        spec,
        element: item,
        gate: { visible: true, disabled: false },
        stateDisabled: false,
      });
    }
    this.element.addEventListener('keydown', this.handleMenuKeydown);
  }

  /** 应用功能门控。 */
  private applyFeatureStates(): void {
    for (const item of this.items) {
      const gate =
        item.spec.feature === undefined
          ? { visible: true, disabled: false }
          : resolveFeatureGate(this.featureStates, item.spec.feature, this.translator);
      item.gate = gate;
      applyFeatureGate(item.element, gate);
    }
  }

  /** 合并功能门控与状态禁用。 */
  private refreshDisabled(): void {
    for (const item of this.items) {
      syncControlDisabled(item.element, item.gate, item.stateDisabled);
    }
  }

  /** 菜单项在当前状态下是否禁用。 */
  private isStateDisabled(spec: MenuItemSpec, state: UIShellViewState): boolean {
    if (spec.requiresDocument === false) return false;
    return state.pageCount <= 0;
  }

  /** 可用且可见的菜单项。 */
  private getEnabledItems(): HTMLButtonElement[] {
    this.refreshDisabled();
    const view = this.doc.defaultView;
    return this.items
      .map((item) => item.element)
      .filter((element) => {
        if (element.hidden || element.hasAttribute('disabled')) return false;
        if (element.getAttribute('aria-disabled') === 'true') return false;
        // 断点显示规则由 CSS 控制，键盘导航需跳过 display:none 的菜单项。
        const display = view?.getComputedStyle(element).display;
        return display !== 'none';
      });
  }

  /** 触发按钮点击。 */
  private readonly handleButtonClick = (): void => {
    this.toggle();
  };

  /** 触发按钮键盘：ArrowDown 直接打开。 */
  private readonly handleButtonKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    this.open();
  };

  /** 菜单键盘导航。 */
  private readonly handleMenuKeydown = (event: KeyboardEvent): void => {
    const enabled = this.getEnabledItems();
    const active = this.doc.activeElement;
    const index = enabled.findIndex((element) => element === active);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        enabled[(index + 1 + enabled.length) % enabled.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        enabled[(index - 1 + enabled.length) % enabled.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        enabled[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        enabled[enabled.length - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.close();
        break;
      case 'Tab':
        this.close(false);
        break;
      default:
        break;
    }
  };

  /** 点击菜单外关闭。 */
  private readonly handleOutsidePointer = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.element.contains(target)) return;
    if (this.options.button.contains(target)) return;
    this.close(false);
  };
}