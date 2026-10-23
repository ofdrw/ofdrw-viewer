/**
 * UI 外壳（设计方案 §5）。
 *
 * 职责边界：
 * - 只操作核心已建好的 `.ofd-viewer__*` 容器，不创建第二套阅读器根节点、不复制渲染/布局；
 * - 视图状态由核心通过 `update()` 推入；用户操作通过 `UIShellCommand` 交给核心；
 * - 断点由核心（或独立挂载时的 `ViewportObserver`）写 `data-viewport` /
 *   `data-sidebar-layout`，外壳只按属性切换侧栏行为；
 * - 功能开关只读取 `FeatureState`，不新增 `enableXxx`。
 */
import { LiveAnnouncer } from '../a11y';
import { createDefaultFeatureStates, getFeatureState } from '../features';
import type { FeatureState, ViewerFeature, ViewerFeatureStates } from '../features';
import { createTranslator } from '../i18n';
import type { Translator } from '../i18n';
import { createFindState } from '../state';
import type { SidebarView, Theme } from '../state';
import { ThemeController, isTheme } from '../theme';
import { DialogManager } from './dialog';
import { Findbar } from './findbar';
import { Sidebar } from './sidebar';
import { ToastManager } from './toast';
import { Toolbar } from './toolbar';
import type {
  SidebarMode,
  SidebarPanelMount,
  UIDialogOptions,
  UIShellCommand,
  UIShellElements,
  UIShellOptions,
  UIShellViewState,
  UIToastOptions,
  ViewportMode,
} from './types';
import {
  ViewportObserver,
  parseSidebarMode,
  parseViewport,
  resolveSidebarMode,
  resolveViewport,
} from './viewport';

/** 侧栏标签回退顺序。 */
const SIDEBAR_VIEW_ORDER: readonly SidebarView[] = Object.freeze([
  'thumbnails',
  'outline',
  'bookmarks',
  'signatures',
]);

/** 对话框名称到功能的映射，用于功能关闭时收起弹窗。 */
const DIALOG_FEATURES: Readonly<Record<string, ViewerFeature>> = Object.freeze({
  print: 'print',
  export: 'export',
  documentProperties: 'documentProperties',
  signatureDetail: 'signatures',
  verification: 'verification',
});

let shellSequence = 0;

/**
 * 内置 UI 外壳。
 */
export class UIShell {
  /** 阅读器根节点。 */
  readonly root: HTMLElement;
  /** 结构元素。 */
  readonly elements: UIShellElements;
  /** 工具栏。 */
  readonly toolbar: Toolbar;
  /** 侧栏。 */
  readonly sidebar: Sidebar;
  /** 查找栏。 */
  readonly findbar: Findbar;
  /** 对话框管理器。 */
  readonly dialogs: DialogManager;
  /** Toast 管理器。 */
  readonly toasts: ToastManager;
  /** 读屏播报器。 */
  readonly announcer: LiveAnnouncer;

  private translator: Translator;
  private featureStates: ViewerFeatureStates;
  private state: UIShellViewState;
  private readonly themeController: ThemeController;
  private viewportMode: ViewportMode = 'desktop';
  private sidebarMode: SidebarMode = 'inline';
  private lastSidebarView: SidebarView = 'thumbnails';
  private viewportObserver: ViewportObserver | null = null;
  private attributeObserver: MutationObserver | null = null;
  private destroyed = false;
  private readonly manageViewport: boolean;
  private readonly manageSidebarVisibility: boolean;
  private readonly idPrefix: string;

  /**
   * 创建并挂载外壳。
   *
   * @param options 外壳选项；`root` 为核心创建的 `.ofd-viewer`。
   */
  constructor(private readonly options: UIShellOptions) {
    this.root = options.root;
    this.root.classList.add('ofd-viewer');
    this.manageViewport = options.manageViewport ?? false;
    this.manageSidebarVisibility = options.manageSidebarVisibility ?? false;
    this.idPrefix = this.root.id || `ofd-viewer-${++shellSequence}`;

    const initialTheme: Theme =
      options.theme ?? (isTheme(this.root.dataset.theme) ? this.root.dataset.theme : 'auto');
    const initialLocale = options.locale ?? this.root.lang ?? 'zh-CN';
    this.translator = createTranslator(initialLocale);
    this.featureStates = options.featureStates ?? createDefaultFeatureStates();

    const patch = options.state ?? {};
    this.state = {
      pageNumber: patch.pageNumber ?? 1,
      pageCount: patch.pageCount ?? 0,
      scale: patch.scale ?? 1,
      zoomMode: patch.zoomMode ?? 'auto',
      rotation: patch.rotation ?? 0,
      sidebarView:
        patch.sidebarView !== undefined
          ? patch.sidebarView
          : (options.sidebarView ?? null),
      fullscreen: patch.fullscreen ?? false,
      find: patch.find ?? createFindState(),
      theme: patch.theme ?? initialTheme,
      locale: patch.locale ?? this.translator.locale,
      documentStatus: patch.documentStatus,
      documentTitle: patch.documentTitle,
    };
    if (this.state.sidebarView !== null) this.lastSidebarView = this.state.sidebarView;

    this.themeController = new ThemeController(this.root, this.state.theme, {
      onChange: (theme, resolved) => this.options.onThemeChange?.(theme, resolved),
    });
    this.root.lang = this.translator.locale;
    this.root.setAttribute('role', this.root.getAttribute('role') ?? 'region');
    if (!this.root.hasAttribute('aria-label')) {
      this.root.setAttribute('aria-label', this.translator.t('viewer.label'));
    }

    this.elements = this.ensureStructure();
    const sidebarId = `${this.idPrefix}-sidebar`;
    this.elements.sidebar.id = sidebarId;
    if (!this.elements.main.hasAttribute('aria-label')) {
      this.elements.main.setAttribute('aria-label', this.translator.t('viewer.main'));
    }
    if (!this.elements.main.hasAttribute('tabindex')) this.elements.main.tabIndex = 0;

    this.toolbar = new Toolbar({
      element: this.elements.toolbar,
      translator: this.translator,
      featureStates: this.featureStates,
      state: this.state,
      sidebarId,
      onCommand: this.handleCommand,
    });
    this.sidebar = new Sidebar({
      element: this.elements.sidebar,
      mask: this.elements.sidebarMask,
      translator: this.translator,
      featureStates: this.featureStates,
      view: this.state.sidebarView,
      idPrefix: this.idPrefix,
      manageVisibility: this.manageSidebarVisibility,
      getState: () => this.state,
      onOpenView: (view) => this.handleCommand({ type: 'sidebar.open', view }),
      onCloseRequest: () => this.handleCommand({ type: 'sidebar.close' }),
      getRestoreFocusTarget: () => this.toolbar.getSidebarButton(),
    });
    this.state = { ...this.state, sidebarView: this.sidebar.currentView };
    this.findbar = new Findbar({
      element: this.elements.findbar,
      translator: this.translator,
      featureStates: this.featureStates,
      findState: this.state.find,
      onCommand: this.handleCommand,
      onRequestClose: () => this.closeFindbar(),
      idPrefix: `${this.idPrefix}-find`,
    });
    this.dialogs = new DialogManager({
      layer: this.elements.dialogLayer,
      translator: this.translator,
    });
    this.toasts = new ToastManager({
      layer: this.elements.toastLayer,
      translator: this.translator,
    });
    this.announcer = new LiveAnnouncer(this.root);

    this.toolbar.update(this.state);
    this.findbar.update(this.state.find);
    this.setupViewport();
  }

  /** 当前断点。 */
  get viewport(): ViewportMode {
    return this.viewportMode;
  }

  /** 当前侧栏布局。 */
  get sidebarLayout(): SidebarMode {
    return this.sidebarMode;
  }

  /** 当前语言翻译器。 */
  get translatorInstance(): Translator {
    return this.translator;
  }

  /** 读取最新视图状态（只读）。 */
  getState(): Readonly<UIShellViewState> {
    return this.state;
  }

  /**
   * 合并视图状态并刷新控件。只更新布局属性，不重建 DOM。
   *
   * @param patch 视图状态补丁。
   */
  update(patch: Partial<UIShellViewState>): void {
    if (this.destroyed) return;
    const previous = this.state;
    this.state = {
      ...previous,
      ...patch,
      find: patch.find ?? previous.find,
    };
    if (this.state.theme !== previous.theme) this.setTheme(this.state.theme);
    if (this.state.locale !== previous.locale) this.setLocale(this.state.locale);

    if (this.state.sidebarView !== previous.sidebarView) {
      this.sidebar.setView(this.state.sidebarView);
      this.state = { ...this.state, sidebarView: this.sidebar.currentView };
      if (this.sidebar.currentView !== null) {
        this.lastSidebarView = this.sidebar.currentView;
      }
    }

    this.toolbar.update(this.state);
    this.findbar.update(this.state.find);
    this.toolbar.setFindOpen(this.findbar.isOpen);

    if (
      this.state.pageNumber !== previous.pageNumber &&
      this.state.pageCount > 0
    ) {
      this.announcer.announce(
        this.translator.t('a11y.pageAnnounce', {
          page: this.translator.formatNumber(this.state.pageNumber),
          total: this.translator.formatNumber(this.state.pageCount),
        }),
      );
    }
  }

  /**
   * 更新功能状态。
   *
   * @param states 全部功能有效状态。
   */
  setFeatureStates(states: ViewerFeatureStates): void {
    if (this.destroyed) return;
    this.featureStates = states;
    this.toolbar.setFeatureStates(states);
    this.sidebar.setFeatureStates(states);
    this.findbar.setFeatureStates(states);
    if (this.sidebar.currentView !== this.state.sidebarView) {
      this.state = { ...this.state, sidebarView: this.sidebar.currentView };
    }
    if (this.state.sidebarView !== null) this.lastSidebarView = this.state.sidebarView;
    this.toolbar.setFindOpen(this.findbar.isOpen);
    this.toolbar.update(this.state);
    this.closeDisabledDialog(states);
  }

  /** 读取单个功能状态。 */
  getFeatureState(feature: ViewerFeature): FeatureState {
    return getFeatureState(this.featureStates, feature);
  }

  /**
   * 设置主题。
   *
   * @param theme light/dark/auto。
   */
  setTheme(theme: Theme): void {
    this.state = { ...this.state, theme };
    this.themeController.setTheme(theme);
  }

  /**
   * 设置语言并刷新所有外壳文案；日期/数字使用 `Intl`。
   *
   * @param locale 语言代码。
   */
  setLocale(locale: string): void {
    const translator = createTranslator(locale);
    this.translator = translator;
    this.state = { ...this.state, locale: translator.locale };
    this.root.lang = translator.locale;
    this.root.setAttribute('aria-label', translator.t('viewer.label'));
    this.elements.main.setAttribute('aria-label', translator.t('viewer.main'));
    this.toolbar.setLocale(translator);
    this.sidebar.setLocale(translator);
    this.findbar.setLocale(translator);
    this.dialogs.setLocale(translator);
    this.toasts.setLocale(translator);
    this.options.onLocaleChange?.(translator.locale);
  }

  /**
   * 注册侧栏面板渲染函数。
   *
   * @param view 视图。
   * @param mount 挂载函数。
   */
  registerSidebarPanel(view: SidebarView, mount: SidebarPanelMount): void {
    this.sidebar.registerPanel(view, mount);
  }

  /**
   * 读取侧栏面板容器，供视图模块直接挂载。
   *
   * @param view 视图。
   * @returns 面板元素。
   */
  getSidebarPanel(view: SidebarView): HTMLElement | null {
    return this.sidebar.getPanel(view);
  }

  /**
   * 打开查找栏并聚焦输入框。
   *
   * @returns 是否打开；`find` 功能被关闭时返回 false。
   */
  openFindbar(): boolean {
    const opened = this.findbar.open();
    this.toolbar.setFindOpen(opened);
    return opened;
  }

  /**
   * 关闭查找栏并把焦点还给打开前的控件。
   *
   * @param restoreFocus 是否恢复焦点；默认 true。
   */
  closeFindbar(restoreFocus = true): void {
    const wasOpen = this.findbar.isOpen;
    this.findbar.close(restoreFocus);
    this.toolbar.setFindOpen(false);
    if (wasOpen) this.emit({ type: 'find.close' });
  }

  /**
   * 打开对话框。
   *
   * @param options 对话框内容。
   * @returns 对话框元素。
   */
  openDialog(options: UIDialogOptions): HTMLElement {
    return this.dialogs.open(options);
  }

  /**
   * 关闭当前对话框。
   *
   * @param restoreFocus 是否恢复焦点；默认 true。
   */
  closeDialog(restoreFocus = true): void {
    this.dialogs.close(restoreFocus);
  }

  /**
   * 展示 Toast。
   *
   * @param message 文案。
   * @param options 级别与时长。
   */
  showToast(message: string, options?: UIToastOptions): void {
    this.toasts.show(message, options);
  }

  /** 关闭 Toast。 */
  dismissToast(): void {
    this.toasts.dismiss();
  }

  /** 按根节点属性重新同步断点（核心写属性后调用，或测试使用）。 */
  syncViewport(): void {
    // 独立挂载时以容器实测宽度为准；集成模式优先采用核心写入的布局属性。
    const measuredMode = resolveViewport(this.measureWidth());
    const mode = this.manageViewport
      ? measuredMode
      : (parseViewport(this.root.dataset.viewport) ?? measuredMode);
    const layout = this.manageViewport
      ? resolveSidebarMode(mode)
      : (parseSidebarMode(this.root.dataset.sidebarLayout) ?? resolveSidebarMode(mode));
    this.applyViewport(mode, layout, true);
  }

  /** 释放监听与 DOM。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.viewportObserver?.stop();
    this.viewportObserver = null;
    this.attributeObserver?.disconnect();
    this.attributeObserver = null;
    this.toolbar.destroy();
    this.sidebar.destroy();
    this.findbar.destroy();
    this.dialogs.destroy();
    this.toasts.destroy();
    this.announcer.destroy();
    this.themeController.destroy();
  }

  /** 处理来自控件的命令。 */
  private readonly handleCommand = (command: UIShellCommand): void => {
    switch (command.type) {
      case 'sidebar.toggle': {
        if (this.state.sidebarView !== null) {
          this.handleCommand({ type: 'sidebar.close' });
          return;
        }
        const view = this.pickSidebarView();
        if (view) this.handleCommand({ type: 'sidebar.open', view });
        return;
      }
      case 'sidebar.open':
        if (this.manageSidebarVisibility) this.applySidebarView(command.view);
        this.emit(command);
        return;
      case 'sidebar.close':
        if (this.manageSidebarVisibility) this.applySidebarView(null);
        this.emit(command);
        return;
      case 'find.open':
        this.openFindbar();
        this.emit(command);
        return;
      case 'find.close':
        this.closeFindbar();
        return;
      case 'find.query':
        this.openFindbar();
        this.emit(command);
        return;
      default:
        this.emit(command);
    }
  };

  /** 发出命令。 */
  private emit(command: UIShellCommand): void {
    this.options.onCommand?.(command);
  }

  /** 选择要打开的侧栏视图。 */
  private pickSidebarView(): SidebarView | null {
    const usable = (view: SidebarView): boolean => {
      const state = getFeatureState(this.featureStates, view);
      return state.enabled && state.visible;
    };
    if (usable(this.lastSidebarView)) return this.lastSidebarView;
    return SIDEBAR_VIEW_ORDER.find(usable) ?? null;
  }

  /** 直接应用侧栏视图（独立挂载时使用）。 */
  private applySidebarView(view: SidebarView | null): void {
    this.sidebar.setView(view);
    this.state = { ...this.state, sidebarView: this.sidebar.currentView };
    if (this.sidebar.currentView !== null) {
      this.lastSidebarView = this.sidebar.currentView;
    }
    this.toolbar.update(this.state);
  }

  /** 功能关闭时收起对应对话框。 */
  private closeDisabledDialog(states: ViewerFeatureStates): void {
    const name = this.dialogs.currentName;
    if (!name) return;
    const feature = DIALOG_FEATURES[name];
    if (feature && !getFeatureState(states, feature).enabled) {
      this.dialogs.close();
    }
  }

  /** 初始化断点监听。 */
  private setupViewport(): void {
    const initial = this.readViewportFromRoot();
    this.applyViewport(initial.mode, initial.layout, false);
    if (this.manageViewport) {
      this.viewportObserver = new ViewportObserver(this.root, {
        onResize: (_width, mode) => {
          this.applyViewport(mode, resolveSidebarMode(mode), true);
        },
      });
      this.viewportObserver.start();
    }
    if (typeof MutationObserver !== 'undefined') {
      this.attributeObserver = new MutationObserver(() => {
        const next = this.readViewportFromRoot();
        if (
          next.mode !== this.viewportMode ||
          next.layout !== this.sidebarMode
        ) {
          this.applyViewport(next.mode, next.layout, true);
        }
      });
      this.attributeObserver.observe(this.root, {
        attributes: true,
        attributeFilter: ['data-viewport', 'data-sidebar-layout'],
      });
    }
  }

  /** 读取根节点断点属性。 */
  private readViewportFromRoot(): { mode: ViewportMode; layout: SidebarMode } {
    const mode =
      parseViewport(this.root.dataset.viewport) ?? resolveViewport(this.measureWidth());
    const layout =
      parseSidebarMode(this.root.dataset.sidebarLayout) ?? resolveSidebarMode(mode);
    return { mode, layout };
  }

  /** 应用断点；只改属性与侧栏行为，不动视图状态。 */
  private applyViewport(
    mode: ViewportMode,
    layout: SidebarMode,
    notify: boolean,
  ): void {
    const previousMode = this.viewportMode;
    const previousLayout = this.sidebarMode;
    this.viewportMode = mode;
    this.sidebarMode = layout;
    if (this.manageViewport) {
      if (this.root.dataset.viewport !== mode) this.root.dataset.viewport = mode;
      if (this.root.dataset.sidebarLayout !== layout) {
        this.root.dataset.sidebarLayout = layout;
      }
    }
    this.sidebar.setMode(layout);
    if (notify && (mode !== previousMode || layout !== previousLayout)) {
      this.options.onViewportChange?.(mode, previousMode);
    }
  }

  /** 测量根节点宽度，单位 px；为 0 时回退窗口宽度。 */
  private measureWidth(): number {
    const own = this.root.clientWidth || this.root.getBoundingClientRect().width;
    if (own > 0) return own;
    const view = this.root.ownerDocument.defaultView;
    return view?.innerWidth ?? 1024;
  }

  /** 查找/校正核心结构元素；缺失时补建（独立挂载/测试）。 */
  private ensureStructure(): UIShellElements {
    const root = this.root;
    const doc = root.ownerDocument;
    const provided = this.options.elements ?? {};
    const create = (className: string): HTMLElement => {
      const element = doc.createElement('div');
      element.className = className;
      return element;
    };

    let body = provided.body ?? root.querySelector<HTMLElement>('.ofd-viewer__body');
    let toolbar =
      provided.toolbar ?? root.querySelector<HTMLElement>('.ofd-viewer__toolbar');
    if (!toolbar) {
      toolbar = create('ofd-viewer__toolbar');
      if (body) root.insertBefore(toolbar, body);
      else root.appendChild(toolbar);
    }
    if (!body) {
      body = create('ofd-viewer__body');
      root.appendChild(body);
    }

    let sidebar =
      provided.sidebar ??
      body.querySelector<HTMLElement>('.ofd-viewer__sidebar') ??
      root.querySelector<HTMLElement>('.ofd-viewer__sidebar');
    if (!sidebar) {
      sidebar = create('ofd-viewer__sidebar');
      body.insertBefore(sidebar, body.firstChild);
    }

    let sidebarMask =
      provided.sidebarMask ??
      body.querySelector<HTMLElement>('.ofd-viewer__sidebar-mask') ??
      root.querySelector<HTMLElement>('.ofd-viewer__sidebar-mask') ??
      body.querySelector<HTMLElement>('.ofd-viewer__scrim');
    if (!sidebarMask) {
      sidebarMask = create('ofd-viewer__sidebar-mask');
      sidebar.after(sidebarMask);
    }

    let main =
      provided.main ??
      body.querySelector<HTMLElement>('.ofd-viewer__main') ??
      root.querySelector<HTMLElement>('.ofd-viewer__main');
    if (!main) {
      main = create('ofd-viewer__main');
      body.appendChild(main);
    }

    let findbar =
      provided.findbar ??
      body.querySelector<HTMLElement>('.ofd-viewer__findbar') ??
      root.querySelector<HTMLElement>('.ofd-viewer__findbar');
    if (!findbar) {
      findbar = create('ofd-viewer__findbar');
      body.appendChild(findbar);
    }

    let dialogLayer =
      provided.dialogLayer ??
      root.querySelector<HTMLElement>('.ofd-viewer__dialog-layer');
    if (!dialogLayer) {
      dialogLayer = create('ofd-viewer__dialog-layer');
      root.appendChild(dialogLayer);
    }

    let toastLayer =
      provided.toastLayer ??
      root.querySelector<HTMLElement>('.ofd-viewer__toast-layer');
    if (!toastLayer) {
      toastLayer = create('ofd-viewer__toast-layer');
      root.appendChild(toastLayer);
    }

    return {
      root,
      toolbar,
      body,
      sidebar,
      sidebarMask,
      main,
      findbar,
      dialogLayer,
      toastLayer,
    };
  }
}

