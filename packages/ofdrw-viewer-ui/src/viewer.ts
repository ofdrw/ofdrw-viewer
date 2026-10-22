/**
 * `OFDViewer`：框架无关的 OFD 阅读器核心。
 *
 * 负责 DOM 外壳、文档生命周期、连续滚动排版、可见页渲染调度、缩放/旋转、页码、
 * 功能门控与扩展注册；文本层、查找、缩略图、签章、打印/导出由扩展模块挂载，
 * 核心不直接 import 这些模块，避免并行目录互相依赖。
 */

import type {
  DocumentPermissions,
  PageImageFormat,
  PageInfo,
  SignatureEntryInfo,
} from 'ofdrw-viewer-engine';
import {
  DocumentController,
  type EngineDocument,
  type EnginePage,
} from './document-controller';
import {
  createFeatureDisabledError,
  OFDViewerError,
  type ViewerErrorCode,
} from './errors';
import { EventBus, type ViewerEventBus } from './event-bus';
import { FeatureGate } from './feature-gate';
import {
  cloneFeatureStates,
  type FeatureGateOptions,
} from './feature-gate';
import type {
  FeatureDisplay,
  FeatureState,
  ViewerFeature,
  ViewerFeatureStates,
  ViewerFeatures,
} from './features';
import { ViewerHistory, type ViewerHashState } from './history';
import { KeyboardController } from './keyboard';
import {
  DEFAULT_MOBILE_RENDER_CONCURRENCY,
  DEFAULT_RENDER_CONCURRENCY,
  MAX_SCALE,
  MIN_SCALE,
  resolveViewerOptions,
  ZOOM_LEVELS,
  type OFDViewerOptions,
  type ResolvedViewerOptions,
} from './options';
import {
  DEFAULT_PAGE_GAP,
  DEFAULT_PAGE_PADDING,
  PageLayout,
  type ScrollAnchor,
} from './page-layout';
import { PageView } from './page-view';
import { RenderQueue, type RenderQueueStats } from './render-queue';
import {
  createInitialViewerState,
  type Rotation,
  type ScaleValue,
  type SidebarView,
  type Theme,
  type ViewerErrorInfo,
  type ViewerState,
  type ViewerWarning,
  type ZoomMode,
} from './state';
import type {
  ExportImageOptions,
  ExportImageResult,
  ExportImagesOptions,
  FindOptions,
  PageRange,
  PrintOptions,
  SignatureDetail,
  ViewerEventMap,
  ViewerEventName,
  ViewerEventHandler,
  ViewerSource,
} from './types';
import type { UIShellElements } from './ui/types';
import type { UIShellHost } from './ui';

/** 阅读器扩展：在实例创建/注册时执行，返回清理函数。 */
export type ViewerExtension = (viewer: OFDViewer) => void | (() => void);

/** 查找/选区服务；由文本模块实现。 */
export interface ViewerFindService {
  /** 执行查找。 */
  find(query: string, options?: FindOptions): void | Promise<void>;
  /** 下一个匹配。 */
  findNext?(): void | Promise<void>;
  /** 上一个匹配。 */
  findPrevious?(): void | Promise<void>;
  /** 清除查找。 */
  clearFind?(): void;
  /** 读取当前选区文本。 */
  getSelectedText?(): string;
  /** 复制当前选区。 */
  copySelection?(): void | Promise<void>;
  /** 清除选区。 */
  clearSelection?(): void;
}

/** 文本层服务；由文本模块实现。 */
export interface ViewerTextLayerService {
  /** 页面创建/布局变化时刷新文本层。 */
  refresh?(): void;
  /** 销毁。 */
  destroy?(): void;
}

/** 签章服务；由签章模块实现。 */
export interface ViewerSignatureService {
  /** 当前签章摘要。 */
  getSignatures?(): readonly SignatureEntryInfo[];
  /** 读取单个签章详情。 */
  getSignatureDetail?(id: string): SignatureDetail | Promise<SignatureDetail>;
  /** 打开/定位签章。 */
  showSignature?(id: string): void | Promise<void>;
  /** 销毁。 */
  destroy?(): void;
}

/** 打印服务；由输出模块实现。 */
export interface ViewerPrintService {
  /** 执行打印。 */
  print(options?: PrintOptions): void | Promise<void>;
}

/** 导出服务；由输出模块实现。 */
export interface ViewerExportService {
  /** 导出单页图片。 */
  exportImage(options?: ExportImageOptions): Promise<ExportImageResult>;
  /** 导出多页图片。 */
  exportImages(options?: ExportImagesOptions): Promise<void>;
}

/** 扩展服务集合。 */
interface ViewerServices {
  find?: ViewerFindService;
  textLayer?: ViewerTextLayerService;
  signature?: ViewerSignatureService;
  print?: ViewerPrintService;
  export?: ViewerExportService;
}

/** 模块级扩展；先注册后创建的实例会在构造时应用。 */
const extensions = new Set<ViewerExtension>();
/** 活跃实例；后注册的扩展会补应用到这些实例。 */
const activeViewers = new Set<OFDViewer>();

/** 判断是否为 PromiseLike。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function';
}

/** 视口宽度对应的断点。 */
type ViewportMode = 'desktop' | 'compact' | 'mobile' | 'narrow';

/** 捕获阶段忽略的错误；用于区分取消与真实失败。 */
function isAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'OFD_ABORTED';
}

/** 创建取消错误。 */
function createAbortError(): Error {
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 注册阅读器扩展。
 *
 * 可在入口 import 阶段调用（模块顶层注册），也可在实例创建后调用；重复注册同一
 * 函数不会重复执行。返回取消注册函数。
 *
 * @param extension 扩展函数。
 * @returns 取消注册函数。
 */
export function registerViewerExtension(extension: ViewerExtension): () => void {
  if (typeof extension !== 'function') return () => undefined;
  extensions.add(extension);
  for (const viewer of activeViewers) viewer.applyExtension(extension);
  return () => {
    extensions.delete(extension);
  };
}

/** 创建空扩展服务集合。 */
function createServices(): ViewerServices {
  return {};
}

/**
 * 阅读器核心实例。
 *
 * 构造时创建 DOM 并异步打开 `options.source`；`ready` 可用于等待首次打开完成。
 * 同一个实例跨断点、缩放、旋转只重排/重渲染，不重建文档。
 */
export class OFDViewer implements UIShellHost {
  /** 首次打开完成的 Promise；打开失败会 reject。 */
  readonly ready: Promise<void>;

  private readonly options: ResolvedViewerOptions;
  private readonly root: HTMLElement;
  private readonly elements: UIShellElements;
  private readonly pagesElement: HTMLElement;
  private readonly controller: DocumentController;
  private readonly eventBus: ViewerEventBus;
  private readonly featureGate: FeatureGate;
  private readonly layout: PageLayout;
  private readonly queue: RenderQueue;
  private readonly keyboard: KeyboardController;
  private readonly history: ViewerHistory | null;
  private readonly services: ViewerServices = createServices();
  private readonly extensionCleanups: Array<() => void> = [];
  private readonly appliedExtensions = new Set<ViewerExtension>();
  private readonly pageViews: PageView[] = [];
  private readonly renderOrder: number[] = [];
  private readonly ownerDocument: Document;
  private resizeObserver: ResizeObserver | null = null;
  private state: ViewerState;
  private pageInfos: readonly PageInfo[] = [];
  private disposed = false;
  private viewportMode: ViewportMode = 'desktop';
  private sidebarLayout: 'inline' | 'overlay' | 'drawer' = 'inline';
  private openToken = 0;
  private openAbort: AbortController | null = null;
  private scrollFrame: number | null = null;
  private reflowFrame: number | null = null;
  private lastVisibleRange = { start: 0, end: -1 };
  private readonly onWindowResize = (): void => this.scheduleViewportUpdate();
  private readonly onFullscreenChange = (): void => {
    const value = !!this.ownerDocument.fullscreenElement;
    if (value !== this.state.view.fullscreen) {
      this.patchView({ fullscreen: value });
      this.commit();
    }
  };

  /**
   * @param options 容器、来源与阅读器选项。
   * @throws {OFDViewerError} 容器不存在或选项非法。
   */
  constructor(options: OFDViewerOptions) {
    this.options = resolveViewerOptions(options, { mobile: detectMobile() });
    const host = resolveContainer(this.options.container);
    this.ownerDocument = host.ownerDocument;
    this.root = this.ownerDocument.createElement('div');
    this.root.className = 'ofd-viewer';
    this.root.dataset.theme = this.options.theme;
    this.root.lang = this.options.locale;
    host.appendChild(this.root);
    this.elements = createStructure(this.root, this.ownerDocument);
    this.pagesElement = this.elements.main.querySelector<HTMLElement>('.ofd-viewer__pages')!;
    this.elements.main.style.padding = '0';
    this.elements.sidebar.hidden = true;
    this.elements.sidebarMask.hidden = true;

    this.eventBus = new EventBus<ViewerEventMap>({
      onListenerError: (error, event) => {
        this.warn('W_UI_LISTENER', `事件 ${event} 的监听器抛出异常：${String(error)}`);
      },
    });
    this.controller = new DocumentController({
      ...(this.options.requestInit ? { requestInit: this.options.requestInit } : {}),
      onWarning: (warning) => this.reportWarning(warning),
    });
    this.featureGate = new FeatureGate(this.options.features, {
      display: this.options.featureDisplay,
    });
    this.layout = new PageLayout({
      pageInfos: [],
      scale: 1,
      rotation: this.options.rotation,
      gap: DEFAULT_PAGE_GAP,
      padding: DEFAULT_PAGE_PADDING,
    });
    this.state = createInitialViewerState({
      pageNumber: this.options.initialPage,
      scale: 1,
      zoomMode: typeof this.options.initialScale === 'string' ? this.options.initialScale : 'page-actual',
      rotation: this.options.rotation,
      sidebarView: this.options.sidebar,
      theme: this.options.theme,
      locale: this.options.locale,
      features: this.featureGate.getStates(),
    });
    this.queue = new RenderQueue({
      concurrency: this.options.renderConcurrency,
      onTaskError: (error, task) => {
        if (isAbort(error)) return;
        this.reportError({
          code: 'OFD_RENDER_FAILED',
          message: `页面渲染失败：${error instanceof Error ? error.message : String(error)}`,
          pageIndex: task.pageIndex,
          cause: error,
        });
      },
    });
    this.keyboard = new KeyboardController(this.root, {
      nextPage: () => this.nextPage(),
      previousPage: () => this.previousPage(),
      firstPage: () => this.goToPage(1),
      lastPage: () => this.goToPage(this.state.document.pageCount),
      zoomIn: () => this.zoomIn(),
      zoomOut: () => this.zoomOut(),
      resetZoom: () => this.setZoomMode('auto'),
      find: () => this.openFindFromKeyboard(),
      print: () => void this.print(),
      close: () => this.close(),
    }, { enabled: this.featureGate.isEnabled('keyboardShortcuts') });
    this.history = this.options.updateHash
      ? new ViewerHistory({
          enabled: true,
          onChange: (hash) => this.applyHashState(hash),
        })
      : null;
    this.history?.start();

    this.setupViewport();
    this.applyExtensions();
    for (const extension of extensions) this.applyExtension(extension);
    this.applyFeatureStates();
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.state.view.sidebarView !== null) {
        this.closeSidebar();
      }
    });
    if (typeof this.ownerDocument.addEventListener === 'function') {
      this.ownerDocument.addEventListener('fullscreenchange', this.onFullscreenChange);
    }
    this.ready = this.open(this.options.source);
  }

  // -------------------------------------------------------------------------
  // 公共读取
  // -------------------------------------------------------------------------

  /** 最新状态快照。 */
  getState(): ViewerState {
    return this.state;
  }

  /** 阅读器根节点。 */
  getRoot(): HTMLElement {
    return this.root;
  }

  /** 核心创建的结构元素；供 UI/扩展模块挂载。 */
  getElements(): UIShellElements {
    return this.elements;
  }

  /** 当前总页数。 */
  getPageCount(): number {
    return this.state.document.pageCount;
  }

  /** 当前页码，1-based。 */
  getPageNumber(): number {
    return this.state.view.pageNumber;
  }

  /** 当前缩放倍率。 */
  getScale(): number {
    return this.state.view.scale;
  }

  /** 当前旋转角度。 */
  getRotation(): Rotation {
    return this.state.view.rotation;
  }

  /** 当前打开的侧栏；关闭时为 null。 */
  getSidebarView(): SidebarView | null {
    return this.state.view.sidebarView;
  }

  /** 当前可见页范围，内部 0-based。 */
  getVisiblePageRange(): ViewerState['view']['visiblePageRange'] {
    return this.state.view.visiblePageRange;
  }

  /** 渲染队列统计；用于诊断。 */
  getRenderStats(): RenderQueueStats {
    return this.queue.stats;
  }

  /** 当前功能状态。 */
  getFeatureState(feature: ViewerFeature): FeatureState {
    return this.featureGate.getState(feature);
  }

  /** 全部功能状态。 */
  getFeatureStates(): ViewerFeatureStates {
    return cloneFeatureStates(this.featureGate.getStates());
  }

  /** 功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean {
    return this.featureGate.isEnabled(feature);
  }

  /** 当前页视图；页码 1-based。 */
  getPageView(pageNumber: number): PageView | undefined {
    return this.pageViews[Math.trunc(pageNumber) - 1];
  }

  /** 全部页视图；只读。 */
  getPageViews(): readonly PageView[] {
    return this.pageViews;
  }

  /** 当前页信息；页码 1-based。 */
  getPageInfo(pageNumber: number): PageInfo | undefined {
    return this.pageInfos[Math.trunc(pageNumber) - 1];
  }

  /** 全部页信息。 */
  getPageInfos(): readonly PageInfo[] {
    return this.pageInfos;
  }

  /** 底层引擎文档；未打开时为 null。 */
  getDocument(): EngineDocument | null {
    return this.controller.document;
  }

  /** 读取指定页引擎对象；页码 1-based。 */
  async getPage(pageNumber: number): Promise<EnginePage> {
    this.assertOpen();
    const index = this.toIndex(pageNumber);
    return this.controller.getPage(index);
  }

  /** 读取当前文档权限；未打开时返回宽松默认值。 */
  async getPermissions(): Promise<DocumentPermissions> {
    if (!this.controller.isOpen) {
      return { edit: true, annot: true, export: true, signature: true, watermark: true, printScreen: true };
    }
    return this.controller.getPermissions();
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  /** 订阅事件。 */
  on<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): () => void {
    return this.eventBus.on(event, handler);
  }

  /** 订阅一次事件。 */
  once<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): () => void {
    return this.eventBus.once(event, handler);
  }

  /** 退订事件。 */
  off<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): void {
    this.eventBus.off(event, handler);
  }

  // -------------------------------------------------------------------------
  // 文档生命周期
  // -------------------------------------------------------------------------

  /**
   * 打开/切换文档；会关闭旧文档并取消渲染。
   *
   * @param source 文档来源；省略时使用构造参数。
   */
  async open(source: ViewerSource = this.options.source): Promise<void> {
    this.assertNotDisposed();
    this.openToken += 1;
    const token = this.openToken;
    this.openAbort?.abort();
    const abort = new AbortController();
    this.openAbort = abort;
    this.queue.cancelAll();
    this.patchDocument({ status: 'opening', source: null });
    this.commit();
    try {
      const opened = await this.controller.open(source);
      if (token !== this.openToken || abort.signal.aborted) throw createAbortError();
      const infos = await this.controller.getPageInfos();
      if (token !== this.openToken || abort.signal.aborted) throw createAbortError();
      this.pageInfos = infos;
      this.buildPages();
      this.patchDocument({
        source: opened.source,
        pageCount: opened.pageCount,
        pageInfos: infos,
        status: 'ready',
        signaturesSummary: [],
      });
      const initialIndex = this.layout.indexOfPageNumber(this.options.initialPage);
      const initialScale =
        typeof this.options.initialScale === 'number'
          ? clampScale(this.options.initialScale)
          : this.layout.scaleForMode(
              this.options.initialScale,
              this.measureViewport(),
              initialIndex,
            );
      this.layout.setScale(initialScale);
      this.patchView({
        pageNumber: initialIndex + 1,
        scale: initialScale,
        zoomMode:
          typeof this.options.initialScale === 'string' ? this.options.initialScale : 'page-actual',
        rotation: this.options.rotation,
      });
      this.reflow();
      this.scrollToPageInternal(initialIndex, false);
      await this.applyAvailability(token);
      this.commit();
      this.emit('documentopen', { pageCount: opened.pageCount });
      this.emit('pagesloaded', { pageCount: opened.pageCount });
      this.renderVisible(true);
      void this.loadSideData(token);
      this.syncHash();
    } catch (error) {
      if (token !== this.openToken || isAbort(error)) return;
      const info = this.toErrorInfo(error, 'OFD_OPEN_FAILED', '打开文档失败');
      this.patchDocument({ status: 'error' });
      this.reportError(info);
      this.commit();
      throw error;
    } finally {
      if (this.openAbort === abort) this.openAbort = null;
    }
  }

  /** 关闭文档，保留阅读器实例。 */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.openToken += 1;
    this.openAbort?.abort();
    this.openAbort = null;
    this.queue.cancelAll();
    this.destroyPages();
    await this.controller.close();
    this.pageInfos = [];
    this.patchDocument({
      status: 'closed',
      source: null,
      pageCount: 0,
      pageInfos: [],
      signaturesSummary: [],
      metadata: undefined,
      outline: undefined,
      bookmarks: undefined,
    });
    this.patchView({
      pageNumber: 1,
      visiblePageRange: { start: 0, end: -1 },
      selectedText: '',
      findState: { ...this.state.view.findState, query: '', current: 0, total: 0, searching: false },
    });
    this.commit();
    this.emit('documentclose', {});
  }

  /** 销毁阅读器，释放 DOM、渲染任务、监听与扩展。 */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.openToken += 1;
    this.openAbort?.abort();
    this.openAbort = null;
    this.queue.dispose();
    this.destroyPages();
    this.keyboard.destroy();
    this.history?.destroy();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.ownerDocument.removeEventListener('fullscreenchange', this.onFullscreenChange);
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    if (this.reflowFrame !== null) cancelAnimationFrame(this.reflowFrame);
    for (const cleanup of this.extensionCleanups.splice(0)) this.safeCleanup(cleanup);
    this.appliedExtensions.clear();
    void this.controller.close();
    this.root.remove();
    activeViewers.delete(this);
    this.eventBus.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // 翻页/缩放/旋转
  // -------------------------------------------------------------------------

  /**
   * 跳转到指定页。
   *
   * @param pageNumber 页码，1-based。
   * @param options 平滑滚动选项。
   */
  goToPage(pageNumber: number, options: { smooth?: boolean } = {}): void {
    this.assertFeature('pageNavigation');
    this.assertOpen();
    const index = this.toIndex(pageNumber);
    this.scrollToPageInternal(index, options.smooth ?? false);
    this.patchView({ pageNumber: index + 1 });
    this.commit();
    this.renderVisible();
    this.syncHash();
  }

  /** 下一页。 */
  nextPage(): void {
    this.assertFeature('pageNavigation');
    const next = this.state.view.pageNumber + 1;
    if (next <= this.state.document.pageCount) this.goToPage(next);
  }

  /** 上一页。 */
  previousPage(): void {
    this.assertFeature('pageNavigation');
    const previous = this.state.view.pageNumber - 1;
    if (previous >= 1) this.goToPage(previous);
  }

  /** 第一页。 */
  firstPage(): void {
    this.goToPage(1);
  }

  /** 最后一页。 */
  lastPage(): void {
    this.goToPage(Math.max(1, this.state.document.pageCount));
  }

  /**
   * 设置实际缩放倍率。
   *
   * @param scale 倍率，限制在 0.1..25。
   */
  setScale(scale: number): void {
    this.assertFeature('zoom');
    this.applyScale(clampScale(scale), this.state.view.zoomMode);
  }

  /**
   * 设置缩放模式。
   *
   * @param mode 缩放模式。
   */
  setZoomMode(mode: ZoomMode): void {
    this.assertFeature('zoom');
    const index = this.toIndex(this.state.view.pageNumber);
    const scale = this.layout.scaleForMode(mode, this.measureViewport(), index);
    this.applyScale(scale, mode);
  }

  /** 放大到下一个预置档位。 */
  zoomIn(): void {
    this.assertFeature('zoom');
    const current = this.state.view.scale;
    const next = ZOOM_LEVELS.find((level) => level > current + 0.001) ?? MAX_SCALE;
    this.setScale(next);
  }

  /** 缩小到上一个预置档位。 */
  zoomOut(): void {
    this.assertFeature('zoom');
    const current = this.state.view.scale;
    const next = [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? MIN_SCALE;
    this.setScale(next);
  }

  /** 重置为适合宽度。 */
  resetZoom(): void {
    this.setZoomMode('auto');
  }

  /**
   * 设置旋转角度，顺时针。
   *
   * @param rotation 0/90/180/270。
   */
  setRotation(rotation: Rotation): void {
    this.assertFeature('rotate');
    const normalized = normalizeRotation(rotation);
    if (normalized === this.state.view.rotation) return;
    const previous = this.state.view.rotation;
    const anchor = this.captureAnchor();
    this.layout.setRotation(normalized);
    this.patchView({ rotation: normalized });
    this.reflow(anchor);
    this.emit('rotationchanging', { rotation: normalized, previous });
    this.cancelAllPageTasks();
    this.renderVisible(true);
    this.commit();
    this.syncHash();
  }

  /** 顺时针旋转 90°。 */
  rotateClockwise(): void {
    this.setRotation(((this.state.view.rotation + 90) % 360) as Rotation);
  }

  /** 逆时针旋转 90°。 */
  rotateCounterClockwise(): void {
    this.setRotation(((this.state.view.rotation + 270) % 360) as Rotation);
  }

  // -------------------------------------------------------------------------
  // 侧栏/全屏/主题
  // -------------------------------------------------------------------------

  /** 打开指定侧栏。 */
  openSidebar(view: SidebarView): void {
    this.assertFeature('sidebar');
    if (view === 'thumbnails') this.assertFeature('thumbnails');
    else if (view === 'outline') this.assertFeature('outline');
    else if (view === 'bookmarks') this.assertFeature('bookmarks');
    else if (view === 'signatures') this.assertFeature('signatures');
    this.patchView({ sidebarView: view });
    this.updateSidebarVisibility();
    this.emit('sidebarviewchanged', { view });
    this.commit();
  }

  /** 关闭侧栏。 */
  closeSidebar(): void {
    if (this.state.view.sidebarView === null) return;
    this.patchView({ sidebarView: null });
    this.updateSidebarVisibility();
    this.emit('sidebarviewchanged', { view: null });
    this.commit();
  }

  /** 切换侧栏。 */
  toggleSidebar(): void {
    this.assertFeature('sidebar');
    if (this.state.view.sidebarView !== null) {
      this.closeSidebar();
      return;
    }
    const first = (['thumbnails', 'outline', 'bookmarks', 'signatures'] as const).find(
      (view) => this.featureGate.isEnabled(view) && this.featureGate.isVisible(view),
    );
    if (first) this.openSidebar(first);
  }

  /**
   * 进入/退出全屏。
   *
   * @param value 是否全屏。
   */
  async setFullscreen(value: boolean): Promise<void> {
    this.assertFeature('fullscreen');
    try {
      if (value) {
        if (this.ownerDocument.fullscreenElement !== this.root) {
          await this.root.requestFullscreen?.();
        }
      } else if (this.ownerDocument.fullscreenElement) {
        await this.ownerDocument.exitFullscreen?.();
      }
      this.patchView({ fullscreen: value });
      this.commit();
    } catch (error) {
      this.reportError(this.toErrorInfo(error, 'OFD_UNSUPPORTED', '全屏切换失败'));
    }
  }

  /** 切换全屏。 */
  toggleFullscreen(): void {
    void this.setFullscreen(!this.state.view.fullscreen);
  }

  /**
   * 设置主题。
   *
   * @param theme light/dark/auto。
   */
  setTheme(theme: Theme): void {
    this.root.dataset.theme = theme;
    this.patchUI({ theme });
    this.commit();
  }

  /**
   * 设置语言。
   *
   * @param locale 语言标签。
   */
  setLocale(locale: string): void {
    this.root.lang = locale;
    this.patchUI({ locale });
    this.commit();
  }

  // -------------------------------------------------------------------------
  // 功能开关
  // -------------------------------------------------------------------------

  /**
   * 合并功能开关补丁；运行时立即生效。
   *
   * @param patch 功能补丁。
   * @param options 可选展示方式。
   */
  setFeatures(
    patch: ViewerFeatures,
    options: { display?: FeatureDisplay } = {},
  ): void {
    const states = this.featureGate.setFeatures(patch, options);
    this.patchUI({ features: cloneFeatureStates(states) });
    this.applyFeatureStates();
    this.emit('featureschange', cloneFeatureStates(states));
    this.commit();
  }

  /**
   * 设置功能展示方式。
   *
   * @param display 展示方式。
   */
  setFeatureDisplay(display: FeatureDisplay): void {
    const states = this.featureGate.setDisplay(display);
    this.patchUI({ features: cloneFeatureStates(states) });
    this.applyFeatureStates();
    this.emit('featureschange', cloneFeatureStates(states));
    this.commit();
  }

  // -------------------------------------------------------------------------
  // 文本/查找/选区（服务扩展）
  // -------------------------------------------------------------------------

  /**
   * 执行查找。
   *
   * @param query 查询文本。
   * @param options 查找选项。
   */
  async find(query: string, options: FindOptions = {}): Promise<void> {
    this.assertFeature('find');
    const service = this.requireService('find', '查找控制器');
    const result = service.find(query, options);
    if (isPromiseLike(result)) await result;
  }

  /** 下一个匹配。 */
  async findNext(): Promise<void> {
    this.assertFeature('find');
    const service = this.requireService('find', '查找控制器');
    if (!service.findNext) throw new OFDViewerError('OFD_UNSUPPORTED', '查找控制器不支持 findNext');
    await service.findNext();
  }

  /** 上一个匹配。 */
  async findPrevious(): Promise<void> {
    this.assertFeature('find');
    const service = this.requireService('find', '查找控制器');
    if (!service.findPrevious) throw new OFDViewerError('OFD_UNSUPPORTED', '查找控制器不支持 findPrevious');
    await service.findPrevious();
  }

  /** 清除查找。 */
  clearFind(): void {
    this.assertFeature('find');
    this.requireService('find', '查找控制器').clearFind?.();
    this.patchView({ findState: { ...this.state.view.findState, query: '', current: 0, total: 0, searching: false } });
    this.commit();
  }

  /** 读取当前选区文本。 */
  getSelectedText(): string {
    this.assertFeature('selection');
    return this.services.find?.getSelectedText?.() ?? this.state.view.selectedText;
  }

  /** 复制当前选区。 */
  async copySelection(): Promise<void> {
    this.assertFeature('selection');
    const service = this.services.find;
    if (service?.copySelection) {
      await service.copySelection();
      return;
    }
    const text = this.getSelectedText();
    if (!text) return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      throw new OFDViewerError('OFD_CLIPBOARD_FAILED', '当前环境不支持剪贴板');
    }
    await clipboard.writeText(text);
  }

  /** 清除选区。 */
  clearSelection(): void {
    this.assertFeature('selection');
    this.services.find?.clearSelection?.();
    this.patchView({ selectedText: '' });
    this.commit();
  }

  // -------------------------------------------------------------------------
  // 签章/打印/导出（服务扩展）
  // -------------------------------------------------------------------------

  /** 当前签章摘要；未打开时为空。 */
  getSignatures(): readonly SignatureEntryInfo[] {
    return this.state.document.signaturesSummary;
  }

  /**
   * 读取签章详情。
   *
   * @param id 签章 ID。
   */
  async getSignatureDetail(id: string): Promise<SignatureDetail> {
    this.assertFeature('signatures');
    const service = this.requireService('signature', '签章服务');
    if (!service.getSignatureDetail) {
      throw new OFDViewerError('OFD_UNSUPPORTED', '签章服务不支持详情读取');
    }
    return service.getSignatureDetail(id);
  }

  /**
   * 打开/定位签章。
   *
   * @param id 签章 ID。
   */
  async showSignature(id: string): Promise<void> {
    this.assertFeature('signatures');
    const service = this.requireService('signature', '签章服务');
    await service.showSignature?.(id);
  }

  /**
   * 打印。
   *
   * @param options 打印选项。
   */
  async print(options: PrintOptions = {}): Promise<void> {
    this.assertFeature('print');
    const service = this.requireService('print', '打印服务');
    await service.print(options);
  }

  /**
   * 导出单页图片。
   *
   * @param options 导出选项。
   * @returns 导出结果。
   */
  async exportImage(options: ExportImageOptions = {}): Promise<ExportImageResult> {
    this.assertFeature('export');
    const service = this.requireService('export', '导出服务');
    return service.exportImage(options);
  }

  /**
   * 导出多页图片。
   *
   * @param options 导出选项。
   */
  async exportImages(options: ExportImagesOptions = {}): Promise<void> {
    this.assertFeature('export');
    const service = this.requireService('export', '导出服务');
    await service.exportImages(options);
  }

  // -------------------------------------------------------------------------
  // 扩展挂载
  // -------------------------------------------------------------------------

  /**
   * 挂载查找控制器。
   *
   * @param service 查找服务。
   * @returns 卸载函数。
   */
  attachFindController(service: ViewerFindService): () => void {
    return this.attachService('find', service);
  }

  /**
   * 挂载文本层服务。
   *
   * @param service 文本层服务。
   * @returns 卸载函数。
   */
  attachTextLayerService(service: ViewerTextLayerService): () => void {
    return this.attachService('textLayer', service);
  }

  /**
   * 挂载签章服务。
   *
   * @param service 签章服务。
   * @returns 卸载函数。
   */
  attachSignatureService(service: ViewerSignatureService): () => void {
    return this.attachService('signature', service);
  }

  /**
   * 挂载打印服务。
   *
   * @param service 打印服务。
   * @returns 卸载函数。
   */
  attachPrintService(service: ViewerPrintService): () => void {
    return this.attachService('print', service);
  }

  /**
   * 挂载导出服务。
   *
   * @param service 导出服务。
   * @returns 卸载函数。
   */
  attachExportService(service: ViewerExportService): () => void {
    return this.attachService('export', service);
  }

  /** 内部：应用扩展；供 registerViewerExtension 调用。 */
  applyExtension(extension: ViewerExtension): void {
    if (this.disposed || this.appliedExtensions.has(extension)) return;
    this.appliedExtensions.add(extension);
    try {
      const cleanup = extension(this);
      if (typeof cleanup === 'function') this.extensionCleanups.push(cleanup);
    } catch (error) {
      this.reportError(this.toErrorInfo(error, 'OFD_UNSUPPORTED', '扩展初始化失败'));
    }
  }

  // -------------------------------------------------------------------------
  // 内部：DOM/排版/渲染
  // -------------------------------------------------------------------------

  /** 建立页壳并挂载全部页视图。 */
  private buildPages(): void {
    this.destroyPages();
    this.layout.setPageInfos(this.pageInfos);
    const total = this.pageInfos.length;
    for (let index = 0; index < total; index += 1) {
      const info = this.pageInfos[index]!;
      const pageView = new PageView({
        pageNumber: index + 1,
        pageIndex: index,
        pageInfo: info,
        totalPages: total,
        ownerDocument: this.ownerDocument,
        onRetry: (pageNumber) => this.renderPage(pageNumber - 1, true),
      });
      this.pageViews.push(pageView);
      this.pagesElement.appendChild(pageView.element);
    }
    this.reflow();
    this.applyFeatureStates();
  }

  /** 销毁全部页视图。 */
  private destroyPages(): void {
    for (const pageView of this.pageViews) pageView.destroy();
    this.pageViews.length = 0;
    this.renderOrder.length = 0;
    this.pagesElement.replaceChildren();
    this.pagesElement.style.height = '0px';
  }

  /** 重新排版并更新页定位；可恢复滚动锚点。 */
  private reflow(anchor?: ScrollAnchor): void {
    const boxes = this.layout.getBoxes();
    this.pagesElement.style.height = `${Math.max(0, this.layout.totalHeight)}px`;
    for (let index = 0; index < this.pageViews.length; index += 1) {
      const box = boxes[index];
      if (!box) continue;
      this.pageViews[index]!.setLayout({
        box,
        rotation: this.state.view.rotation,
        scale: this.state.view.scale,
      });
    }
    if (anchor) {
      this.mainScrollTop = this.layout.getOffsetForAnchor(anchor);
    }
    this.scheduleScrollUpdate();
  }

  /** 主区域滚动位置。 */
  private get mainScrollTop(): number {
    return this.elements.main.scrollTop;
  }

  private set mainScrollTop(value: number) {
    this.elements.main.scrollTop = Math.max(0, value);
  }

  /** 应用缩放并保持滚动锚点。 */
  private applyScale(nextScale: number, zoomMode: ZoomMode): void {
    if (Math.abs(nextScale - this.state.view.scale) < 0.0001) {
      if (zoomMode !== this.state.view.zoomMode) {
        this.patchView({ zoomMode });
        this.commit();
      }
      return;
    }
    const previous = this.state.view.scale;
    const anchor = this.captureAnchor();
    this.layout.setScale(nextScale);
    this.patchView({ scale: nextScale, zoomMode });
    this.reflow(anchor);
    this.emit('scalechanging', { scale: nextScale, zoomMode, previous });
    this.cancelAllPageTasks();
    this.renderVisible(true);
    this.commit();
    this.syncHash();
  }

  /** 捕获当前滚动锚点。 */
  private captureAnchor(): ScrollAnchor {
    return this.layout.getAnchor(this.mainScrollTop);
  }

  /** 滚动到指定页；保留页顶。 */
  private scrollToPageInternal(index: number, smooth: boolean): void {
    const top = this.layout.getPageTop(index);
    if (smooth && typeof this.elements.main.scrollTo === 'function') {
      try {
        this.elements.main.scrollTo({ top, behavior: 'smooth' });
      } catch {
        this.mainScrollTop = top;
      }
    } else {
      this.mainScrollTop = top;
    }
    this.patchView({ pageNumber: index + 1 });
    this.scheduleScrollUpdate();
  }

  /** 计算当前可见页并调度渲染。 */
  private renderVisible(force = false): void {
    if (this.pageViews.length === 0) return;
    const viewportHeight = this.measureViewport().height;
    const range = this.layout.getVisibleRange(this.mainScrollTop, viewportHeight, 1);
    const visible = this.layout.getVisibleRange(this.mainScrollTop, viewportHeight, 0);
    this.lastVisibleRange = visible;
    this.patchView({ visiblePageRange: visible });
    const wanted = new Set<number>();
    for (let index = range.start; index <= range.end; index += 1) wanted.add(index);
    for (let index = 0; index < this.pageViews.length; index += 1) {
      this.pageViews[index]!.setCurrent(index >= visible.start && index <= visible.end);
    }
    this.queue.cancelWhere((task) => task.key.startsWith('page:') && !wanted.has(task.pageIndex));
    for (let index = range.start; index <= range.end; index += 1) {
      const priority = index >= visible.start && index <= visible.end ? 0 : 1;
      this.renderPage(index, force, priority);
    }
    this.trimCache();
  }

  /** 调度单页渲染。 */
  private renderPage(index: number, force: boolean, priority = 0): void {
    const pageView = this.pageViews[index];
    if (!pageView || pageView.isDestroyed) return;
    const key = this.renderKey();
    if (!force && pageView.renderedKey === key) return;
    const generation = pageView.beginRender(key);
    this.queue.enqueue({
      key: `page:${index}`,
      pageIndex: index,
      priority,
      generation,
      run: async (signal) => {
        const page = await this.controller.getPage(index);
        if (signal.aborted) throw createAbortError();
        const size = this.computeCanvasSize(page);
        const context = pageView.prepareCanvas(size.width, size.height, generation);
        if (!context) throw new OFDViewerError('OFD_UNSUPPORTED', '当前环境不支持 Canvas 2D');
        pageView.markRendering(generation);
        const viewport = page.getViewport({ dpi: size.dpi });
        const task = page.render({
          canvasContext: context,
          viewport,
          signal,
        });
        await task.promise;
        if (signal.aborted) throw createAbortError();
        pageView.completeRender(generation, key);
        this.markRendered(index);
        this.emit('pagerendered', {
          pageNumber: index + 1,
          scale: this.state.view.scale,
          rotation: this.state.view.rotation,
        });
      },
      onError: (error) => {
        if (isAbort(error)) {
          pageView.cancelRender(generation);
          return;
        }
        const info = this.toErrorInfo(error, 'OFD_RENDER_FAILED', '页面渲染失败', index);
        pageView.failRender(generation, info);
        this.reportError(info);
      },
      onCancel: () => pageView.cancelRender(generation),
    });
  }

  /** 计算 canvas 设备像素与受上限约束的 DPI。 */
  private computeCanvasSize(page: EnginePage): { width: number; height: number; dpi: number } {
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const baseDpi = 96 * this.state.view.scale * dpr;
    let dpi = baseDpi;
    const maxPixels = Math.max(1, this.options.maxCanvasPixels);
    const maxSide = 32767;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const viewport = page.getViewport({ dpi });
      if (
        viewport.width <= maxSide &&
        viewport.height <= maxSide &&
        viewport.width * viewport.height <= maxPixels
      ) {
        return {
          width: Math.max(1, Math.ceil(viewport.width)),
          height: Math.max(1, Math.ceil(viewport.height)),
          dpi,
        };
      }
      dpi *= 0.75;
    }
    const viewport = page.getViewport({ dpi });
    this.warn(
      'W_CANVAS_LIMIT',
      `页面像素超过上限，已降低渲染 DPI 至 ${Math.round(dpi)}。`,
    );
    return {
      width: Math.max(1, Math.ceil(viewport.width)),
      height: Math.max(1, Math.ceil(viewport.height)),
      dpi,
    };
  }

  /** 当前渲染参数键。 */
  private renderKey(): string {
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    return `${this.state.view.scale.toFixed(4)}:${this.state.view.rotation}:${dpr}`;
  }

  /** 记录已渲染页并裁剪 LRU。 */
  private markRendered(index: number): void {
    const position = this.renderOrder.indexOf(index);
    if (position >= 0) this.renderOrder.splice(position, 1);
    this.renderOrder.push(index);
    this.trimCache();
  }

  /** 释放超出缓存且不可见的 canvas。 */
  private trimCache(): void {
    const visible = this.lastVisibleRange;
    while (this.renderOrder.length > this.options.pageCacheSize) {
      const index = this.renderOrder.find(
        (candidate) => candidate < visible.start || candidate > visible.end,
      );
      if (index === undefined) return;
      const pageView = this.pageViews[index];
      pageView?.releaseCanvas();
      const position = this.renderOrder.indexOf(index);
      if (position >= 0) this.renderOrder.splice(position, 1);
    }
  }

  /** 取消全部页渲染任务。 */
  private cancelAllPageTasks(): void {
    this.queue.cancelWhere((task) => task.key.startsWith('page:'));
  }

  /** 按当前滚动位置更新页码/可见范围。 */
  private scheduleScrollUpdate(): void {
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.handleScroll();
    });
  }

  /** 处理滚动。 */
  private handleScroll(): void {
    if (this.pageViews.length === 0) return;
    const scrollTop = this.mainScrollTop;
    const pageIndex = this.layout.getPageAtOffset(scrollTop);
    const pageNumber = pageIndex + 1;
    if (pageNumber !== this.state.view.pageNumber) {
      const previous = this.state.view.pageNumber;
      this.patchView({ pageNumber, scrollTop });
      this.emit('pagechanging', { pageNumber, previous });
    } else {
      this.patchView({ scrollTop });
    }
    this.patchView({
      visiblePageRange: this.layout.getVisibleRange(
        scrollTop,
        this.measureViewport().height,
        0,
      ),
    });
    this.renderVisible();
    this.commit();
    this.syncHash();
  }

  /** 断点/尺寸变化：更新根节点属性并重排。 */
  private scheduleViewportUpdate(): void {
    if (this.reflowFrame !== null) return;
    this.reflowFrame = requestAnimationFrame(() => {
      this.reflowFrame = null;
      this.updateViewport();
    });
  }

  /** 计算并应用视口断点。 */
  private updateViewport(): void {
    const width = this.root.clientWidth || this.measureViewport().width;
    const mode: ViewportMode =
      width >= 1024 ? 'desktop' : width >= 768 ? 'compact' : width >= 480 ? 'mobile' : 'narrow';
    const layout: 'inline' | 'overlay' | 'drawer' =
      mode === 'desktop' ? 'inline' : mode === 'compact' ? 'overlay' : 'drawer';
    if (mode !== this.viewportMode || layout !== this.sidebarLayout) {
      this.viewportMode = mode;
      this.sidebarLayout = layout;
      this.root.dataset.viewport = mode;
      this.root.dataset.sidebarLayout = layout;
      this.updateSidebarVisibility();
    }
    if (
      this.state.view.zoomMode === 'auto' ||
      this.state.view.zoomMode === 'page-width' ||
      this.state.view.zoomMode === 'page-fit'
    ) {
      const index = this.toIndex(this.state.view.pageNumber);
      const next = this.layout.scaleForMode(
        this.state.view.zoomMode,
        this.measureViewport(),
        index,
      );
      if (Math.abs(next - this.state.view.scale) > 0.001) {
        this.applyScale(next, this.state.view.zoomMode);
        return;
      }
    }
    this.reflow(this.layout.getAnchor(this.mainScrollTop));
    this.renderVisible();
  }

  /** 测量主区域；jsdom 中回退窗口尺寸。 */
  private measureViewport(): { width: number; height: number } {
    const width =
      this.elements.main.clientWidth ||
      this.root.clientWidth ||
      (typeof window !== 'undefined' ? window.innerWidth : 1024);
    const height =
      this.elements.main.clientHeight ||
      this.root.clientHeight ||
      (typeof window !== 'undefined' ? window.innerHeight : 800);
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  /** 设置 ResizeObserver/窗口监听。 */
  private setupViewport(): void {
    this.root.dataset.viewport = this.viewportMode;
    this.root.dataset.sidebarLayout = this.sidebarLayout;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.scheduleViewportUpdate());
      observer.observe(this.root);
      this.resizeObserver = observer;
    } else {
      this.resizeObserver = null;
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onWindowResize);
  }

  /** 核心管理侧栏与遮罩可见性。 */
  private updateSidebarVisibility(): void {
    const open = this.state.view.sidebarView !== null;
    const sidebarEnabled = this.featureGate.isVisible('sidebar');
    this.elements.sidebar.hidden = !open || !sidebarEnabled;
    this.elements.sidebarMask.hidden = !(open && this.sidebarLayout !== 'inline' && sidebarEnabled);
    this.elements.sidebar.dataset.open = open ? 'true' : 'false';
    this.elements.sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    this.elements.sidebarMask.dataset.open = open ? 'true' : 'false';
  }

  /** 应用功能状态到核心 DOM。 */
  private applyFeatureStates(): void {
    const states = this.featureGate.getStates();
    this.elements.toolbar.hidden = !states.toolbar.visible;
    if (!states.sidebar.enabled) {
      this.elements.sidebar.hidden = true;
      this.elements.sidebarMask.hidden = true;
    }
    for (const pageView of this.pageViews) {
      pageView.setTextLayerVisible(states.textLayer.enabled);
      pageView.setSignatureLayerVisible(states.signatures.enabled);
      pageView.textLayer.dataset.selectable = states.selection.enabled ? 'true' : 'false';
    }
    this.keyboard.setEnabled(states.keyboardShortcuts.enabled);
    this.updateSidebarVisibility();
  }

  /** 读取文档权限与引擎能力，更新功能可用性。 */
  private async applyAvailability(token: number): Promise<void> {
    if (token !== this.openToken) return;
    const permissions = await this.controller.getPermissions().catch(() => null);
    const documentAvailability: Partial<Record<ViewerFeature, boolean>> = {};
    const unsupported: Partial<Record<ViewerFeature, boolean>> = {};
    if (permissions?.print?.printable === false) documentAvailability.print = false;
    if (permissions?.export === false) documentAvailability.export = false;
    let page: EnginePage | null = null;
    try {
      page = await this.controller.getPage(0);
    } catch {
      page = null;
    }
    if (page && typeof page.getTextContent !== 'function') unsupported.textLayer = true;
    if (page && typeof page.exportImage !== 'function') {
      unsupported.print = true;
      unsupported.export = true;
    }
    if (this.controller.document && typeof this.controller.document.getSignatureEntries !== 'function') {
      unsupported.signatures = true;
    }
    const states = this.featureGate.setAvailability({
      document: documentAvailability,
      unsupported,
    });
    this.patchUI({ features: cloneFeatureStates(states) });
    this.applyFeatureStates();
    this.emit('featureschange', cloneFeatureStates(states));
  }

  /** 异步加载侧栏数据，不阻塞首屏。 */
  private async loadSideData(token: number): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    if (this.featureGate.isEnabled('documentProperties')) {
      jobs.push(
        this.controller
          .getMetadata()
          .then((metadata) => {
            if (token !== this.openToken) return;
            this.patchDocument({ metadata });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, 'W_METADATA', '文档属性读取失败')),
      );
    }
    if (this.featureGate.isEnabled('outline')) {
      jobs.push(
        this.controller
          .getOutline()
          .then((outline) => {
            if (token !== this.openToken) return;
            this.patchDocument({ outline });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, 'W_OUTLINE', '大纲读取失败')),
      );
    }
    if (this.featureGate.isEnabled('bookmarks')) {
      jobs.push(
        this.controller
          .getBookmarks()
          .then((bookmarks) => {
            if (token !== this.openToken) return;
            this.patchDocument({ bookmarks });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, 'W_BOOKMARKS', '书签读取失败')),
      );
    }
    if (this.featureGate.isEnabled('signatures')) {
      jobs.push(
        this.controller
          .getSignatureEntries()
          .then((entries) => {
            if (token !== this.openToken) return;
            this.patchDocument({ signaturesSummary: entries });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, 'W_SIGNATURE_ENTRIES', '签章列表读取失败')),
      );
    }
    await Promise.allSettled(jobs);
  }

  /** 应用 URL hash 状态。 */
  private applyHashState(hash: ViewerHashState): void {
    if (this.pageInfos.length === 0) return;
    if (hash.page !== undefined) {
      const index = this.toIndex(hash.page);
      this.mainScrollTop = this.layout.getPageTop(index);
      this.patchView({ pageNumber: index + 1 });
    }
    if (hash.zoom !== undefined) {
      if (typeof hash.zoom === 'number') this.setScale(hash.zoom);
      else this.setZoomMode(hash.zoom);
    }
    if (hash.rotation !== undefined) this.setRotation(hash.rotation);
    if (hash.sidebar !== undefined) {
      if (hash.sidebar === null) this.closeSidebar();
      else this.openSidebar(hash.sidebar);
    }
    this.renderVisible();
    this.commit();
  }

  /** 写入 URL hash；失败不影响阅读。 */
  private syncHash(): void {
    if (!this.history || !this.options.updateHash) return;
    try {
      this.history.sync({
        page: this.state.view.pageNumber,
        zoom:
          this.state.view.zoomMode === 'page-actual'
            ? this.state.view.scale
            : this.state.view.zoomMode,
        rotation: this.state.view.rotation,
        sidebar: this.state.view.sidebarView,
      });
    } catch {
      // 历史写入失败不影响阅读。
    }
  }

  /** 键盘 Ctrl/Cmd+F：复用工具栏查找按钮，避免核心直接依赖 UI。 */
  private openFindFromKeyboard(): void {
    if (!this.featureGate.isEnabled('find')) return;
    this.elements.toolbar
      .querySelector<HTMLButtonElement>('[data-ofd-control="find"]')
      ?.click();
  }

  /** 挂载服务并返回卸载函数。 */
  private attachService<K extends keyof ViewerServices>(
    key: K,
    service: NonNullable<ViewerServices[K]>,
  ): () => void {
    this.services[key] = service;
    return () => {
      if (this.services[key] === service) delete this.services[key];
    };
  }

  /** 读取必需服务；缺失时抛不支持错误。 */
  private requireService<K extends keyof ViewerServices>(
    key: K,
    label: string,
  ): NonNullable<ViewerServices[K]> {
    const service = this.services[key];
    if (!service) throw new OFDViewerError('OFD_UNSUPPORTED', `${label}未挂载`);
    return service as NonNullable<ViewerServices[K]>;
  }

  /** 应用扩展集合；构造时调用。 */
  private applyExtensions(): void {
    for (const extension of extensions) this.applyExtension(extension);
  }

  /** 断言功能可用。 */
  private assertFeature(feature: ViewerFeature): void {
    const state = this.featureGate.getState(feature);
    if (!state.enabled) throw createFeatureDisabledError(feature);
  }

  /** 断言文档已打开。 */
  private assertOpen(): void {
    if (!this.controller.isOpen) throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开');
  }

  /** 断言实例未销毁。 */
  private assertNotDisposed(): void {
    if (this.disposed) throw new OFDViewerError('OFD_DESTROYED', '阅读器已销毁');
  }

  /** 页码转内部索引，并夹取到有效范围。 */
  private toIndex(pageNumber: number): number {
    const count = this.pageInfos.length;
    if (count === 0) return 0;
    const normalized = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1;
    return Math.min(count - 1, Math.max(0, normalized - 1));
  }

  /** 报告 warning。 */
  private reportWarning(warning: ViewerWarning): void {
    this.warn(warning.code, warning.message, warning.pageIndex);
  }

  /** 记录 warning 并触发回调/事件。 */
  private warn(code: string, message: string, pageIndex?: number): void {
    const warning: ViewerWarning = pageIndex === undefined ? { code, message } : { code, message, pageIndex };
    this.patchUI({ warnings: [...this.state.ui.warnings, warning].slice(-100) });
    this.options.onWarning?.(warning);
    this.emit('warning', warning);
    this.commit();
  }

  /** 记录错误并触发回调/事件。 */
  private reportError(info: ViewerErrorInfo): void {
    this.options.onError?.(info);
    this.emit('error', info);
  }

  /** 把任意错误转成 ViewerErrorInfo。 */
  private toErrorInfo(
    error: unknown,
    code: string,
    message: string,
    pageIndex?: number,
  ): ViewerErrorInfo {
    return {
      code,
      message: error instanceof Error ? error.message : message,
      ...(pageIndex === undefined ? {} : { pageIndex }),
      cause: error,
    };
  }

  /** 把 warning 错误转成 warning。 */
  private reportWarningError(error: unknown, code: string, message: string): void {
    this.warn(code, `${message}：${error instanceof Error ? error.message : String(error)}`);
  }

  /** 安全执行清理函数。 */
  private safeCleanup(cleanup: () => void): void {
    try {
      cleanup();
    } catch (error) {
      this.reportWarningError(error, 'W_UI_CLEANUP', '扩展清理失败');
    }
  }

  /** 更新文档状态。 */
  private patchDocument(patch: Partial<ViewerState['document']>): void {
    this.state = { ...this.state, document: { ...this.state.document, ...patch } };
  }

  /** 更新视图状态。 */
  private patchView(patch: Partial<ViewerState['view']>): void {
    this.state = { ...this.state, view: { ...this.state.view, ...patch } };
  }

  /** 更新 UI 状态。 */
  private patchUI(patch: Partial<ViewerState['ui']>): void {
    this.state = { ...this.state, ui: { ...this.state.ui, ...patch } };
  }

  /** 发出状态变化。 */
  private commit(): void {
    if (!this.disposed) this.eventBus.emit('statechange', this.state);
  }

  /** 类型安全地发出事件。 */
  private emit<K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]): void {
    this.eventBus.emit(event, payload);
  }
}

/** 夹取缩放倍率。 */
function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/** 规范化旋转角度。 */
function normalizeRotation(value: number): Rotation {
  const normalized = ((Math.trunc(value / 90) * 90) % 360 + 360) % 360;
  return normalized as Rotation;
}

/** 判断移动端默认环境。 */
function detectMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(max-width: 767px)').matches ?? window.innerWidth < 768;
}

/** 解析容器；字符串按 CSS 选择器处理。 */
function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container === 'string') {
    const found = document.querySelector<HTMLElement>(container);
    if (!found) throw new OFDViewerError('OFD_INVALID_OPTION', `找不到容器：${container}`);
    return found;
  }
  if (!container) throw new OFDViewerError('OFD_INVALID_OPTION', 'container 不能为空');
  return container;
}

/** 创建阅读器结构；UI 外壳会复用这些元素。 */
function createStructure(root: HTMLElement, doc: Document): UIShellElements {
  const create = (className: string, tag = 'div'): HTMLElement => {
    const element = doc.createElement(tag);
    element.className = className;
    return element;
  };
  const toolbar = create('ofd-viewer__toolbar');
  const body = create('ofd-viewer__body');
  const sidebar = create('ofd-viewer__sidebar', 'aside');
  const sidebarMask = create('ofd-viewer__sidebar-mask');
  const main = create('ofd-viewer__main');
  const pages = create('ofd-viewer__pages');
  const findbar = create('ofd-viewer__findbar');
  const dialogLayer = create('ofd-viewer__dialog-layer');
  const toastLayer = create('ofd-viewer__toast-layer');
  pages.style.position = 'relative';
  pages.style.width = '100%';
  pages.style.height = '0px';
  main.appendChild(pages);
  body.append(sidebar, sidebarMask, main);
  root.append(toolbar, body, findbar, dialogLayer, toastLayer);
  sidebar.hidden = true;
  sidebarMask.hidden = true;
  findbar.hidden = true;
  return { root, toolbar, body, sidebar, sidebarMask, main, findbar, dialogLayer, toastLayer };
}

export type { PageRange, ViewerSource };
