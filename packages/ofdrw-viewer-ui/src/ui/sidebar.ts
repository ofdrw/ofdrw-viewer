/**
 * 侧栏外壳（设计方案 §5.1 / §5.4 / §8.3）。
 *
 * 只提供标签、面板容器、抽屉/覆盖行为与基础可访问性；
 * 缩略图/大纲/书签/签章内容由对应模块通过 `registerPanel()` 注入。
 *
 * 布局由 CSS 按根节点 `data-viewport` 切换（inline / overlay / drawer），这里只同步
 * 遮罩、焦点陷阱与 tab 状态，不重建 DOM、不改变页码/缩放/旋转。
 */

import { replaceChildren } from '../compat';
import { FocusTrap } from '../a11y';
import type { ViewerFeatureStates } from '../features';
import type { MessageKey, Translator } from '../i18n';
import { SIDEBAR_VIEWS, type SidebarView } from '../state';
import { applyFeatureGate, resolveFeatureGate } from './feature-control';
import { createIcon } from './icons';
import type { SidebarMode, SidebarPanelContext, SidebarPanelMount, UIShellViewState } from './types';

/** 标签文案键。 */
const TAB_LABEL_KEYS: Readonly<Record<SidebarView, MessageKey>> = Object.freeze({
  thumbnails: 'sidebar.thumbnails',
  outline: 'sidebar.outline',
  bookmarks: 'sidebar.bookmarks',
  signatures: 'sidebar.signatures',
  attachments: 'attachments.title',
});

/** 空态文案键。 */
const EMPTY_LABEL_KEYS: Readonly<Record<SidebarView, MessageKey>> = Object.freeze({
  thumbnails: 'sidebar.noThumbnails',
  outline: 'sidebar.noOutline',
  bookmarks: 'sidebar.noBookmarks',
  signatures: 'sidebar.noSignatures',
  attachments: 'attachments.empty',
});

/** 侧栏宽度范围，单位 px（设计方案 §5.1）。 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 320;
export const SIDEBAR_DEFAULT_WIDTH = 200;

/** 侧栏标签实例。 */
interface TabEntry {
  readonly view: SidebarView;
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  empty: HTMLElement | null;
  mounted: boolean;
  cleanup: (() => void) | null;
}

/** 侧栏选项。 */
export interface SidebarOptions {
  /** 侧栏元素（核心创建）。 */
  readonly element: HTMLElement;
  /** 遮罩元素（核心创建，`.ofd-viewer__sidebar-mask`）。 */
  readonly mask: HTMLElement;
  /** 翻译器。 */
  readonly translator: Translator;
  /** 功能状态。 */
  readonly featureStates: ViewerFeatureStates;
  /** 初始视图。 */
  readonly view: SidebarView | null;
  /** id 前缀。 */
  readonly idPrefix: string;
  /** 是否由 UI 维护 hidden（独立挂载时为 true）。 */
  readonly manageVisibility: boolean;
  /** 读取外壳视图状态（传给面板渲染函数）。 */
  readonly getState: () => Readonly<UIShellViewState>;
  /** 点击标签请求切换视图。 */
  readonly onOpenView: (view: SidebarView) => void;
  /** 请求关闭侧栏（关闭按钮/遮罩/Esc）。 */
  readonly onCloseRequest: () => void;
  /** 关闭后恢复焦点的元素（通常是工具栏侧栏开关）。 */
  readonly getRestoreFocusTarget?: () => HTMLElement | null;
}

/**
 * 侧栏外壳。
 */
export class Sidebar {
  /** 侧栏根元素。 */
  readonly element: HTMLElement;
  /** 遮罩元素。 */
  readonly mask: HTMLElement;
  private translator: Translator;
  private featureStates: ViewerFeatureStates;
  private view: SidebarView | null;
  private mode: SidebarMode = 'inline';
  private readonly tabs = new Map<SidebarView, TabEntry>();
  private readonly mounts = new Map<SidebarView, SidebarPanelMount>();
  private readonly trap: FocusTrap;
  private readonly tablist: HTMLElement;
  private closeButton!: HTMLButtonElement;
  private resizer!: HTMLElement;
  private resizing: { pointerId: number; startX: number; startWidth: number } | null = null;

  /**
   * 创建侧栏。
   *
   * @param options 侧栏选项。
   */
  constructor(private readonly options: SidebarOptions) {
    this.element = options.element;
    this.mask = options.mask;
    this.translator = options.translator;
    this.featureStates = options.featureStates;
    this.view = options.view;
    this.trap = new FocusTrap(this.element, {
      onEscape: () => this.options.onCloseRequest(),
      restoreFocus: true,
    });
    this.build();
    const tablist = this.element.querySelector<HTMLElement>('.ofd-sidebar__tabs');
    const closeButton = this.element.querySelector<HTMLButtonElement>(
      '.ofd-sidebar__close',
    );
    const resizer = this.element.querySelector<HTMLElement>('.ofd-sidebar__resizer');
    if (!tablist || !closeButton || !resizer) {
      throw new Error('侧栏结构创建失败');
    }
    this.tablist = tablist;
    this.closeButton = closeButton;
    this.resizer = resizer;
    this.applyFeatureStates();
    this.setView(options.view);
  }

  /** 当前视图。 */
  get currentView(): SidebarView | null {
    return this.view;
  }

  /** 当前布局。 */
  get layout(): SidebarMode {
    return this.mode;
  }

  /** 是否打开。 */
  get isOpen(): boolean {
    return this.view !== null;
  }

  /**
   * 更新断点对应的侧栏布局。
   *
   * @param mode inline / overlay / drawer。
   */
  setMode(mode: SidebarMode): void {
    const changed = mode !== this.mode;
    this.mode = mode;
    this.element.dataset.mode = mode;
    this.element.setAttribute('aria-hidden', this.isOpen ? 'false' : 'true');
    this.resizer.hidden = mode !== 'inline';
    if (mode !== 'inline' && this.element.ownerDocument.activeElement === this.resizer) {
      this.closeButton.focus();
    }
    if (this.options.manageVisibility) {
      this.mask.hidden = !(this.isOpen && mode !== 'inline');
    }
    if (changed) this.syncTrap(false);
    this.updateAriaExpanded();
  }

  /**
   * 设置打开的侧栏视图。
   *
   * @param view 视图；null 表示关闭。
   */
  setView(view: SidebarView | null): void {
    this.view = view;
    if (view !== null) {
      const entry = this.tabs.get(view);
      if (!entry || entry.button.hidden || entry.button.disabled) {
        this.view = null;
      }
    }
    const open = this.view !== null;
    for (const entry of this.tabs.values()) {
      const selected = entry.view === this.view;
      entry.button.setAttribute('aria-selected', selected ? 'true' : 'false');
      entry.button.tabIndex = selected ? 0 : -1;
      entry.panel.hidden = !selected;
    }
    if (this.options.manageVisibility) {
      this.element.hidden = !open;
      this.mask.hidden = !(open && this.mode !== 'inline');
    }
    this.updateAriaExpanded();
    const openedView = this.view;
    if (open && openedView !== null) {
      this.ensurePanelMounted(openedView);
      this.syncTrap(true);
    } else {
      const hadFocus = this.element.contains(document.activeElement);
      this.trap.deactivate({ restoreFocus: false });
      if (hadFocus) {
        this.options.getRestoreFocusTarget?.()?.focus();
      }
    }
  }

  /**
   * 更新功能状态；活动视图被关闭时自动收起。
   *
   * @param states 全部功能状态。
   */
  setFeatureStates(states: ViewerFeatureStates): void {
    this.featureStates = states;
    this.applyFeatureStates();
    if (this.view !== null) {
      const entry = this.tabs.get(this.view);
      if (!entry || entry.button.hidden || entry.button.disabled) {
        this.setView(null);
      }
    }
    this.syncTabIndexes();
  }

  /**
   * 切换语言：原地更新标签与 aria 名称。
   *
   * @param translator 新翻译器。
   */
  setLocale(translator: Translator): void {
    this.translator = translator;
    this.element.setAttribute('aria-label', translator.t('sidebar.label'));
    this.tablist.setAttribute('aria-label', translator.t('sidebar.tabsLabel'));
    for (const [view, entry] of this.tabs) {
      entry.button.textContent = translator.t(TAB_LABEL_KEYS[view]);
      if (entry.empty) entry.empty.textContent = translator.t(EMPTY_LABEL_KEYS[view]);
    }
    this.closeButton.setAttribute('aria-label', translator.t('sidebar.close'));
    this.resizer.setAttribute('aria-label', translator.t('sidebar.resize'));
    this.applyFeatureStates();
  }

  /**
   * 注册面板渲染函数；首次激活时调用，并缓存结果。
   *
   * @param view 视图。
   * @param mount 挂载函数；返回清理函数。
   */
  registerPanel(view: SidebarView, mount: SidebarPanelMount): void {
    this.mounts.set(view, mount);
    if (this.view === view) this.ensurePanelMounted(view);
  }

  /**
   * 读取面板容器，供外部模块直接挂载。
   *
   * @param view 视图。
   * @returns 面板元素；不存在时返回 null。
   */
  getPanel(view: SidebarView): HTMLElement | null {
    return this.tabs.get(view)?.panel ?? null;
  }

  /**
   * 读取标签按钮（测试/焦点使用）。
   *
   * @param view 视图。
   * @returns 标签按钮。
   */
  getTab(view: SidebarView): HTMLButtonElement | null {
    return this.tabs.get(view)?.button ?? null;
  }

  /** 聚焦当前标签。 */
  focusActiveTab(): void {
    if (this.view === null) return;
    this.tabs.get(this.view)?.button.focus();
  }

  /** 释放监听与面板内容。 */
  destroy(): void {
    this.trap.deactivate({ restoreFocus: false });
    this.stopResize();
    this.options.mask.removeEventListener('click', this.handleMaskClick);
    this.closeButton.removeEventListener('click', this.handleCloseClick);
    this.resizer.removeEventListener('pointerdown', this.handleResizeStart);
    this.resizer.removeEventListener('keydown', this.handleResizerKeydown);
    this.tablist.removeEventListener('keydown', this.handleTablistKeydown);
    for (const entry of this.tabs.values()) entry.cleanup?.();
    replaceChildren(this.element);
  }

  /** 构建侧栏 DOM。 */
  private build(): void {
    const doc = this.element.ownerDocument;
    this.element.classList.add('ofd-viewer__sidebar');
    this.element.setAttribute('aria-label', this.translator.t('sidebar.label'));
    replaceChildren(this.element);

    const header = doc.createElement('div');
    header.className = 'ofd-sidebar__header';
    const tablist = doc.createElement('div');
    tablist.className = 'ofd-sidebar__tabs';
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', this.translator.t('sidebar.tabsLabel'));
    tablist.setAttribute('aria-orientation', 'horizontal');

    this.closeButton = doc.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'ofd-button ofd-sidebar__close';
    this.closeButton.setAttribute('aria-label', this.translator.t('sidebar.close'));
    this.closeButton.appendChild(createIcon('close'));
    this.closeButton.addEventListener('click', this.handleCloseClick);

    header.append(tablist, this.closeButton);

    const panels = doc.createElement('div');
    panels.className = 'ofd-sidebar__panels';
    for (const view of SIDEBAR_VIEWS) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ofd-sidebar__tab';
      button.setAttribute('role', 'tab');
      button.id = `${this.options.idPrefix}-tab-${view}`;
      button.setAttribute('aria-controls', `${this.options.idPrefix}-panel-${view}`);
      button.setAttribute('aria-selected', 'false');
      button.tabIndex = -1;
      button.dataset.view = view;
      button.textContent = this.translator.t(TAB_LABEL_KEYS[view]);
      button.addEventListener('click', () => this.options.onOpenView(view));
      tablist.appendChild(button);

      const panel = doc.createElement('div');
      panel.className = 'ofd-sidebar__panel';
      panel.id = `${this.options.idPrefix}-panel-${view}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      panel.tabIndex = 0;
      panel.hidden = true;
      panels.appendChild(panel);

      this.tabs.set(view, {
        view,
        button,
        panel,
        empty: null,
        mounted: false,
        cleanup: null,
      });
    }
    tablist.addEventListener('keydown', this.handleTablistKeydown);

    this.resizer = doc.createElement('div');
    this.resizer.className = 'ofd-sidebar__resizer';
    this.resizer.setAttribute('role', 'separator');
    this.resizer.setAttribute('aria-orientation', 'vertical');
    this.resizer.setAttribute('aria-label', this.translator.t('sidebar.resize'));
    this.resizer.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
    this.resizer.setAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH));
    this.resizer.setAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH));
    this.resizer.tabIndex = 0;
    this.resizer.addEventListener('pointerdown', this.handleResizeStart);
    this.resizer.addEventListener('keydown', this.handleResizerKeydown);

    this.element.append(header, panels, this.resizer);
    this.mask.classList.add('ofd-viewer__sidebar-mask');
    this.mask.addEventListener('click', this.handleMaskClick);
    this.setMode(this.mode);
  }

  /** 应用功能门控。 */
  private applyFeatureStates(): void {
    for (const [view, entry] of this.tabs) {
      const gate = resolveFeatureGate(this.featureStates, view, this.translator);
      applyFeatureGate(entry.button, gate);
      entry.panel.setAttribute(
        'aria-hidden',
        entry.button.hidden ? 'true' : 'false',
      );
    }
    this.syncTabIndexes();
  }

  /** 只有一个可用标签进入 Tab 顺序。 */
  private syncTabIndexes(): void {
    const selected = this.view === null ? null : this.tabs.get(this.view);
    if (selected && !selected.button.hidden && !selected.button.disabled) {
      selected.button.tabIndex = 0;
      return;
    }
    const first = [...this.tabs.values()].find(
      (entry) => !entry.button.hidden && !entry.button.disabled,
    );
    for (const entry of this.tabs.values()) entry.button.tabIndex = -1;
    if (first) first.button.tabIndex = 0;
  }

  /** 首次激活时挂载面板内容。 */
  private ensurePanelMounted(view: SidebarView): void {
    const entry = this.tabs.get(view);
    if (!entry || entry.mounted) return;
    const mount = this.mounts.get(view);
    if (!mount) {
      if (!entry.empty) {
        entry.empty = this.element.ownerDocument.createElement('p');
        entry.empty.className = 'ofd-sidebar__empty';
        entry.empty.textContent = this.translator.t(EMPTY_LABEL_KEYS[view]);
        entry.panel.appendChild(entry.empty);
      }
      return;
    }
    entry.empty?.remove();
    entry.empty = null;
    const context: SidebarPanelContext = {
      view,
      locale: this.translator.locale,
      getState: this.options.getState,
    };
    const cleanup = mount(entry.panel, context);
    entry.mounted = true;
    entry.cleanup = typeof cleanup === 'function' ? cleanup : null;
  }

  /** 同步焦点陷阱：覆盖/抽屉打开时启用，常驻时关闭。 */
  private syncTrap(moveFocus: boolean): void {
    const shouldTrap = this.isOpen && this.mode !== 'inline';
    if (shouldTrap) {
      this.trap.activate({ moveFocus });
    } else if (this.trap.isActive) {
      this.trap.deactivate({ restoreFocus: false });
    }
  }

  /** 同步侧栏自身的展开标记与关闭按钮可见性。 */
  private updateAriaExpanded(): void {
    this.options.mask.setAttribute('aria-hidden', 'true');
    this.element.dataset.open = this.isOpen ? 'true' : 'false';
    this.closeButton.hidden = this.mode === 'inline';
  }

  /** 标签键盘导航（自动激活）。 */
  private readonly handleTablistKeydown = (event: KeyboardEvent): void => {
    const focusable = [...this.tabs.values()].filter(
      (entry) => !entry.button.hidden && !entry.button.disabled,
    );
    if (focusable.length === 0) return;
    const current = focusable.findIndex(
      (entry) => entry.button === this.element.ownerDocument.activeElement,
    );
    let nextIndex = current;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (current + 1 + focusable.length) % focusable.length;
        break;
      case 'ArrowLeft':
        nextIndex = (current - 1 + focusable.length) % focusable.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = focusable.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = focusable[nextIndex];
    next.button.focus();
    this.options.onOpenView(next.view);
  };

  /** 遮罩点击关闭。 */
  private readonly handleMaskClick = (): void => {
    if (!this.isOpen) return;
    this.options.onCloseRequest();
  };

  /** 关闭按钮。 */
  private readonly handleCloseClick = (): void => {
    this.options.onCloseRequest();
  };

  /** 开始拖拽调整宽度。 */
  private readonly handleResizeStart = (event: PointerEvent): void => {
    if (this.mode !== 'inline') return;
    event.preventDefault();
    const width = this.getCurrentWidth();
    this.resizing = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    this.resizer.setPointerCapture?.(event.pointerId);
    this.element.ownerDocument.addEventListener('pointermove', this.handleResizeMove);
    this.element.ownerDocument.addEventListener('pointerup', this.handleResizeEnd);
    this.element.ownerDocument.addEventListener('pointercancel', this.handleResizeEnd);
  };

  /** 拖拽中。 */
  private readonly handleResizeMove = (event: PointerEvent): void => {
    if (!this.resizing) return;
    const width = clampSidebarWidth(
      this.resizing.startWidth + (event.clientX - this.resizing.startX),
    );
    this.setWidth(width);
  };

  /** 结束拖拽。 */
  private readonly handleResizeEnd = (): void => {
    this.stopResize();
  };

  /** 键盘调整宽度。 */
  private readonly handleResizerKeydown = (event: KeyboardEvent): void => {
    if (this.mode !== 'inline') return;
    const current = this.getCurrentWidth();
    let width = current;
    switch (event.key) {
      case 'ArrowLeft':
        width = current - 8;
        break;
      case 'ArrowRight':
        width = current + 8;
        break;
      case 'Home':
        width = SIDEBAR_MIN_WIDTH;
        break;
      case 'End':
        width = SIDEBAR_MAX_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.setWidth(clampSidebarWidth(width));
  };

  /** 读取当前宽度，单位 px。 */
  private getCurrentWidth(): number {
    const parsed = Number.parseInt(
      this.element.style.getPropertyValue('--ofd-sidebar-width') || '',
      10,
    );
    return Number.isFinite(parsed) ? parsed : SIDEBAR_DEFAULT_WIDTH;
  }

  /** 写入宽度并同步 aria-valuenow。 */
  private setWidth(width: number): void {
    this.element.style.setProperty('--ofd-sidebar-width', `${width}px`);
    this.resizer.setAttribute('aria-valuenow', String(width));
  }

  /** 移除拖拽监听。 */
  private stopResize(): void {
    if (!this.resizing) return;
    this.resizing = null;
    const doc = this.element.ownerDocument;
    doc.removeEventListener('pointermove', this.handleResizeMove);
    doc.removeEventListener('pointerup', this.handleResizeEnd);
    doc.removeEventListener('pointercancel', this.handleResizeEnd);
  }
}

/**
 * 限制侧栏宽度到设计范围。
 *
 * @param width 目标宽度，单位 px。
 * @returns 180–320 之间的宽度。
 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}