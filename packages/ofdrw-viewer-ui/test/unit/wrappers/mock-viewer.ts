/**
 * wrapper 单测用的阅读器替身。
 *
 * 只实现三种适配层实际调用的核心方法；通过静态 instances 记录构造与销毁，
 * 便于验证“不重建实例”和 StrictMode/卸载清理。
 */

/** 事件监听器。 */
type Listener = (payload: unknown) => void;

/** 阅读器构造选项的最小结构。 */
export interface FakeViewerOptions {
  container: HTMLElement;
  source: unknown;
  initialPage?: number;
  initialScale?: number | string;
  rotation?: number;
  theme?: string;
  locale?: string;
  sidebar?: string | null;
  features?: Record<string, boolean>;
  featureDisplay?: unknown;
  [key: string]: unknown;
}

/** 轻量状态结构。 */
interface FakeState {
  document: { pageCount: number; status: string };
  view: {
    pageNumber: number;
    scale: number;
    rotation: number;
    sidebarView: string | null;
  };
  ui: { theme: string; locale: string; features: Record<string, boolean> };
}

/** 核心阅读器替身。 */
export class FakeViewer {
  /** 全部已创建实例。 */
  static instances: FakeViewer[] = [];

  /** 清空实例记录。 */
  static reset(): void {
    FakeViewer.instances = [];
  }

  readonly options: FakeViewerOptions;
  readonly root: HTMLElement;
  readonly ready: Promise<void> = Promise.resolve();
  destroyed = false;
  openCalls: unknown[] = [];
  pageCalls: number[] = [];
  scaleCalls: number[] = [];
  zoomModeCalls: string[] = [];
  rotationCalls: number[] = [];
  themeCalls: string[] = [];
  localeCalls: string[] = [];
  sidebarCalls: (string | null)[] = [];
  featureCalls: Record<string, boolean>[] = [];
  featureDisplayCalls: unknown[] = [];
  findCalls: [string, unknown][] = [];
  printCalls = 0;
  exportCalls = 0;

  /** 当前状态。 */
  state: FakeState;

  /** 事件监听器表。 */
  private listeners = new Map<string, Set<Listener>>();

  /**
   * @param options 阅读器选项；container 为宿主元素。
   */
  constructor(options: FakeViewerOptions) {
    this.options = options;
    this.state = {
      document: { pageCount: 10, status: 'ready' },
      view: {
        pageNumber: options.initialPage ?? 1,
        scale: typeof options.initialScale === 'number' ? options.initialScale : 1,
        rotation: options.rotation ?? 0,
        sidebarView: options.sidebar ?? null,
      },
      ui: {
        theme: options.theme ?? 'auto',
        locale: options.locale ?? 'zh-CN',
        features: { ...options.features },
      },
    };
    this.root = options.container.ownerDocument.createElement('div');
    this.root.className = 'fake-ofd-viewer';
    options.container.appendChild(this.root);
    FakeViewer.instances.push(this);
  }

  /**
   * 订阅事件。
   *
   * @param event 事件名。
   * @param handler 监听器。
   * @returns 取消订阅函数。
   */
  on(event: string, handler: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /**
   * 触发事件；仅供测试。
   *
   * @param event 事件名。
   * @param payload 载荷。
   */
  emit(event: string, payload: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }

  /** 当前状态快照。 */
  getState(): FakeState {
    return this.state;
  }

  /** 当前页。 */
  getPageNumber(): number {
    return this.state.view.pageNumber;
  }

  /** 当前缩放。 */
  getScale(): number {
    return this.state.view.scale;
  }

  /** 当前旋转。 */
  getRotation(): number {
    return this.state.view.rotation;
  }

  /** 当前侧栏。 */
  getSidebarView(): string | null {
    return this.state.view.sidebarView;
  }

  /** 总页数。 */
  getPageCount(): number {
    return this.state.document.pageCount;
  }

  /** 根节点。 */
  getRoot(): HTMLElement {
    return this.root;
  }

  /** 单个功能状态。 */
  getFeatureState(feature: string): { enabled: boolean; visible: boolean } {
    return { enabled: this.state.ui.features[feature] !== false, visible: true };
  }

  /** 功能是否可用。 */
  isFeatureEnabled(feature: string): boolean {
    return this.state.ui.features[feature] !== false;
  }

  /**
   * 打开文档。
   *
   * @param source 文档来源。
   */
  async open(source: unknown): Promise<void> {
    this.openCalls.push(source);
    this.state.document.status = 'ready';
  }

  /** 关闭文档。 */
  async close(): Promise<void> {
    this.state.document.status = 'closed';
  }

  /**
   * 跳转页码。
   *
   * @param page 页码，1-based。
   */
  goToPage(page: number): void {
    const previous = this.state.view.pageNumber;
    this.pageCalls.push(page);
    this.state.view.pageNumber = page;
    this.emit('pagechanging', { pageNumber: page, previous });
  }

  /** 下一页。 */
  nextPage(): void {
    this.goToPage(this.state.view.pageNumber + 1);
  }

  /** 上一页。 */
  previousPage(): void {
    this.goToPage(this.state.view.pageNumber - 1);
  }

  /**
   * 设置缩放。
   *
   * @param scale 倍率。
   */
  setScale(scale: number): void {
    this.scaleCalls.push(scale);
    this.state.view.scale = scale;
  }

  /**
   * 设置缩放模式。
   *
   * @param mode 模式。
   */
  setZoomMode(mode: string): void {
    this.zoomModeCalls.push(mode);
  }

  /**
   * 设置旋转。
   *
   * @param rotation 角度，单位度。
   */
  setRotation(rotation: number): void {
    this.rotationCalls.push(rotation);
    this.state.view.rotation = rotation;
  }

  /**
   * 设置主题。
   *
   * @param theme 主题。
   */
  setTheme(theme: string): void {
    this.themeCalls.push(theme);
    this.state.ui.theme = theme;
  }

  /**
   * 设置语言。
   *
   * @param locale 语言标签。
   */
  setLocale(locale: string): void {
    this.localeCalls.push(locale);
    this.state.ui.locale = locale;
  }

  /**
   * 合并功能开关。
   *
   * @param features 功能补丁。
   */
  setFeatures(features: Record<string, boolean>): void {
    this.featureCalls.push(features);
    Object.assign(this.state.ui.features, features);
  }

  /**
   * 设置功能展示方式。
   *
   * @param display 展示方式。
   */
  setFeatureDisplay(display: unknown): void {
    this.featureDisplayCalls.push(display);
  }

  /**
   * 打开侧栏。
   *
   * @param view 侧栏视图。
   */
  openSidebar(view: string): void {
    this.sidebarCalls.push(view);
    this.state.view.sidebarView = view;
  }

  /** 关闭侧栏。 */
  closeSidebar(): void {
    this.sidebarCalls.push(null);
    this.state.view.sidebarView = null;
  }

  /**
   * 执行查找。
   *
   * @param query 查询文本。
   * @param options 查找选项。
   */
  async find(query: string, options?: unknown): Promise<void> {
    this.findCalls.push([query, options]);
  }

  /** 打印。 */
  async print(): Promise<void> {
    this.printCalls += 1;
  }

  /** 导出图片。 */
  async exportImage(): Promise<{
    blob: Blob;
    filename: string;
    pageNumber: number;
    format: string;
  }> {
    this.exportCalls += 1;
    return {
      blob: new Blob(),
      filename: 'fake.png',
      pageNumber: this.state.view.pageNumber,
      format: 'png',
    };
  }

  /** 销毁实例。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    this.root.remove();
  }
}