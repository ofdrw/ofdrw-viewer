/**
 * 工具栏“更多”菜单。
 *
 * 桌面端只包含低频操作（文档属性）；紧凑/移动/窄屏断点下，工具栏中被 CSS
 * 隐藏的控件会出现在这里，保证核心操作不丢失。菜单项同样受 FeatureState 控制。
 */
import { setExpanded } from '../a11y';
import { createIcon, type IconName } from './icons';
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
  /** 可选图标。 */
  readonly icon?: IconName;
  /** 根据当前状态构造命令。 */
  readonly command: (state: UIShellViewState) => UIShellCommand;
  /** 文档未打开时是否禁用；默认 true。 */
  readonly requiresDocument?: boolean;
  /**
   * 是否为可勾选项（`role="menuitemradio"`）。
   *
   * 传入判定函数，返回 true 表示当前选中；用于页面布局这类“多选一”的菜单组。
   */
  readonly checked?: (state: UIShellViewState) => boolean;
}

/** 菜单分组定义：一个可选的组标题与若干菜单项。 */
interface MenuGroupSpec {
  /** 组标题（可选）；标题行不可聚焦。 */
  readonly titleKey?: MessageKey;
  /** 组内菜单项，按声明顺序排列。 */
  readonly items: readonly MenuItemSpec[];
}

/** 菜单项实例。 */
interface MenuItem {
  readonly spec: MenuItemSpec;
  readonly element: HTMLButtonElement;
  gate: FeatureGate;
  stateDisabled: boolean;
}

/**
 * 滚动方向菜单项（页面滚动 / 水平滚动）。
 *
 * 决定页面之间如何衔接：页面滚动上下衔接、纵向连续；水平滚动左右衔接、单行横滑。
 */
const DIRECTION_ITEMS: readonly MenuItemSpec[] = [
  {
    id: 'menu-scroll-page',
    labelKey: 'toolbar.scrollPage',
    icon: 'scroll-page',
    visibility: 'always',
    command: () => ({ type: 'layout.set', direction: 'page' }),
    checked: (state) => state.layout.direction === 'page',
  },
  {
    id: 'menu-scroll-horizontal',
    labelKey: 'toolbar.scrollHorizontal',
    icon: 'scroll-horizontal',
    visibility: 'always',
    command: () => ({ type: 'layout.set', direction: 'horizontal' }),
    checked: (state) => state.layout.direction === 'horizontal',
  },
];

/**
 * 视图模式菜单项（单页 / 双页）。
 *
 * 决定一次滚动/翻页推进多少页：单页一次一页；双页一组两页（组内保留间隔）。
 */
const VIEW_MODE_ITEMS: readonly MenuItemSpec[] = [
  {
    id: 'menu-view-single',
    labelKey: 'toolbar.viewSingle',
    icon: 'view-single',
    visibility: 'always',
    command: () => ({ type: 'layout.set', viewMode: 'single' }),
    checked: (state) => state.layout.viewMode === 'single',
  },
  {
    id: 'menu-view-spread',
    labelKey: 'toolbar.viewSpread',
    icon: 'view-spread',
    visibility: 'always',
    command: () => ({ type: 'layout.set', viewMode: 'spread' }),
    checked: (state) => state.layout.viewMode === 'spread',
  },
];

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
    id: 'menu-document-properties',
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

/** 信息类分组（文档属性 / 关于）：单独成组，排在操作分组之后。 */
const INFO_ITEM_IDS: ReadonlySet<string> = new Set([
  'menu-document-properties',
  'menu-about',
]);

/** 布局菜单项 id 集合；用于把布局项从主列表里剔除。 */
const LAYOUT_ITEM_IDS: ReadonlySet<string> = new Set(
  [...DIRECTION_ITEMS, ...VIEW_MODE_ITEMS].map((item) => item.id),
);

/**
 * 菜单分组（顺序即菜单顺序）：布局模式在最上方，其余为低频操作。
 *
 * 用函数返回而不是顶层常量：菜单项常量在同模块内声明顺序靠后，顶层引用会触发
 * 暂时性死区。
 *
 * @returns 分组列表。
 */
function buildMenuGroups(): readonly MenuGroupSpec[] {
  return [
    { titleKey: 'toolbar.scrollGroup', items: DIRECTION_ITEMS },
    { titleKey: 'toolbar.viewGroup', items: VIEW_MODE_ITEMS },
    {
      // 低频操作（翻页/缩放/打印等）：不带标题，保持原有紧凑排列。
      items: MENU_ITEMS.filter(
        (item) => !LAYOUT_ITEM_IDS.has(item.id) && !INFO_ITEM_IDS.has(item.id),
      ),
    },
    {
      titleKey: 'toolbar.infoGroup',
      items: MENU_ITEMS.filter((item) => INFO_ITEM_IDS.has(item.id)),
    },
  ];
}

/** “更多”菜单选项。 */
export interface MoreMenuOptions {
  /** 触发按钮。 */
  readonly button: HTMLButtonElement;
  /** 按钮容器；菜单优先挂到 `.ofd-viewer` 根节点，找不到时回退到该容器。 */
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

/** 菜单与视口边缘的最小间距（px）。 */
const VIEWPORT_MARGIN = 8;

/** 菜单与触发按钮之间的间距（px）。 */
const MENU_GAP = 4;

let moreMenuSequence = 0;

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
  private readonly portal: HTMLElement;
  private readonly viewportPortal: boolean;
  private resizeObserver: ResizeObserver | null = null;

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
    // 菜单必须脱离 `.ofd-viewer__toolbar` 的 overflow 裁剪；优先挂到阅读器根节点，
    // 脱离组件时回退到按钮容器并使用 fixed 坐标。
    const viewerRoot = options.button.closest<HTMLElement>('.ofd-viewer');
    this.portal = viewerRoot ?? options.container;
    this.viewportPortal = viewerRoot === null;

    this.element = this.doc.createElement('div');
    this.element.id = `ofd-more-menu-${++moreMenuSequence}`;
    this.element.className = 'ofd-more-menu';
    if (this.viewportPortal) this.element.classList.add('ofd-more-menu--fixed');
    this.element.setAttribute('role', 'menu');
    this.element.setAttribute('aria-label', this.translator.t('toolbar.more'));
    this.element.hidden = true;
    this.buildItems();
    this.portal.appendChild(this.element);

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
    // 先移除动画类再测量，避免 scale 动画影响 getBoundingClientRect 的尺寸；
    // 定位完成后再加入，首帧从 0.96/透明开始，不改变最终坐标。
    this.element.classList.remove('ofd-more-menu--open');
    this.element.hidden = false;
    this.positionMenu();
    this.element.classList.add('ofd-more-menu--open');
    this.element.scrollTop = 0;
    setExpanded(this.options.button, true);
    this.doc.addEventListener('pointerdown', this.handleOutsidePointer, true);
    this.doc.defaultView?.addEventListener('resize', this.handleViewportChange);
    this.doc.defaultView?.addEventListener('scroll', this.handleViewportChange, true);
    if (typeof ResizeObserver !== 'undefined') {
      // 断点/文案/功能变化会改变菜单高度，尺寸变化后重新夹紧到视口。
      this.resizeObserver = new ResizeObserver(() => this.positionMenu());
      this.resizeObserver.observe(this.element);
    }
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
    this.element.classList.remove('ofd-more-menu--open');
    setExpanded(this.options.button, false);
    this.doc.removeEventListener('pointerdown', this.handleOutsidePointer, true);
    this.doc.defaultView?.removeEventListener('resize', this.handleViewportChange);
    this.doc.defaultView?.removeEventListener('scroll', this.handleViewportChange, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
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
    for (const item of this.items) {
      if (!item.spec.checked) continue;
      item.element.setAttribute(
        'aria-checked',
        item.spec.checked(state) ? 'true' : 'false',
      );
    }
    const fullscreenItem = this.items.find((item) => item.spec.id === 'menu-fullscreen');
    if (fullscreenItem) {
      const text = this.translator.t(
        state.fullscreen ? 'toolbar.exitFullscreen' : 'toolbar.fullscreen',
      );
      const label = fullscreenItem.element.querySelector('.ofd-more-menu__label');
      if (label) label.textContent = text;
      else fullscreenItem.element.textContent = text;
    }
    // 全屏文案等变化可能改变菜单高度，打开时重新夹紧到视口内。
    if (this.menuOpen) this.positionMenu();
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
    if (this.menuOpen) this.positionMenu();
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
      const label = item.element.querySelector('.ofd-more-menu__label');
      if (label) label.textContent = translator.t(item.spec.labelKey);
      else item.element.textContent = translator.t(item.spec.labelKey);
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

  /**
   * 计算菜单位置：右对齐触发按钮，遇到视口边缘翻转/夹紧，超高时限制高度并允许滚动。
   *
   * 坐标先按视口计算，再换算到 `.ofd-viewer` 根节点的绝对定位坐标系。
   */
  private positionMenu(): void {
    const view = this.doc.defaultView;
    if (!view || !this.menuOpen) return;
    const maxHeight = Math.max(0, view.innerHeight - VIEWPORT_MARGIN * 2);
    this.element.style.maxHeight = `${maxHeight}px`;
    const anchor = this.options.button.getBoundingClientRect();
    // 用布局尺寸而不是 getBoundingClientRect：打开动画的 scale 会缩小视觉矩形，
    // 但不应该参与夹紧计算。
    const size = {
      width: this.element.offsetWidth,
      height: this.element.offsetHeight,
    };
    const left = Math.min(
      Math.max(anchor.right - size.width, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, view.innerWidth - size.width - VIEWPORT_MARGIN),
    );
    let top = anchor.bottom + MENU_GAP;
    let placement: 'above' | 'below' = 'below';
    if (top + size.height > view.innerHeight - VIEWPORT_MARGIN) {
      const above = anchor.top - MENU_GAP - size.height;
      if (above >= VIEWPORT_MARGIN) {
        top = above;
        placement = 'above';
      } else {
        top = Math.max(VIEWPORT_MARGIN, view.innerHeight - VIEWPORT_MARGIN - size.height);
      }
    }
    // 动画原点跟随展开方向：向下展开从右上角生长，向上展开从右下角生长。
    this.element.dataset.placement = placement;
    if (this.viewportPortal) {
      this.element.style.left = `${Math.round(left)}px`;
      this.element.style.top = `${Math.round(top)}px`;
      return;
    }
    const origin = this.portal.getBoundingClientRect();
    this.element.style.left = `${Math.round(left - origin.left - this.portal.clientLeft)}px`;
    this.element.style.top = `${Math.round(top - origin.top - this.portal.clientTop)}px`;
  }

  /** 创建菜单分组与菜单项。 */
  private buildItems(): void {
    for (const [index, group] of buildMenuGroups().entries()) {
      if (group.titleKey) {
        const title = this.doc.createElement('div');
        title.className = 'ofd-more-menu__group-title';
        title.setAttribute('role', 'presentation');
        title.dataset.menuGroup = String(index);
        title.textContent = this.translator.t(group.titleKey);
        this.element.appendChild(title);
      }
      for (const spec of group.items) this.buildItem(spec);
    }
    this.element.addEventListener('keydown', this.handleMenuKeydown);
  }

  /**
   * 创建单个菜单项。
   *
   * 可勾选项使用 `menuitemradio` 语义，勾选状态由 `aria-checked` 表达，样式由
   * CSS 读取该属性驱动。
   *
   * @param spec 菜单项定义。
   */
  private buildItem(spec: MenuItemSpec): void {
    {
      const item = this.doc.createElement('button');
      item.type = 'button';
      item.className = 'ofd-more-menu__item';
      if (spec.checked) {
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', 'false');
      } else {
        item.setAttribute('role', 'menuitem');
      }
      item.dataset.ofdControl = spec.id;
      item.dataset.menuVisibility = spec.visibility;
      if (spec.icon) item.appendChild(createIcon(spec.icon));
      const label = this.doc.createElement('span');
      label.className = 'ofd-more-menu__label';
      label.textContent = this.translator.t(spec.labelKey);
      item.appendChild(label);
      item.addEventListener('click', () => {
        // 先关闭并把焦点还给触发按钮，后续对话框/侧栏关闭时可恢复到该按钮。
        this.close();
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

  /** 窗口尺寸/滚动变化时重算位置；菜单内部滚动不重算。 */
  private readonly handleViewportChange = (event: Event): void => {
    if (!this.menuOpen) return;
    if (event.type === 'scroll' && event.target === this.element) return;
    this.positionMenu();
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

  /** 点击菜单外关闭；未点击可聚焦控件时把焦点还给触发按钮。 */
  private readonly handleOutsidePointer = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.element.contains(target)) return;
    if (this.options.button.contains(target)) return;
    const focusable =
      target instanceof Element
        ? target.closest(
            'button, a[href], input:not([type="hidden"]), select, textarea, [contenteditable="true"]',
          )
        : null;
    this.close(false);
    if (focusable) return;
    // 等待指针事件的默认焦点处理结束后再还给触发按钮，避免点击文档区域后焦点落到 body。
    this.doc.defaultView?.setTimeout(() => {
      if (!this.menuOpen) this.options.button.focus();
    }, 0);
  };
}
