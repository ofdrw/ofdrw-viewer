/**
 * 响应式断点与容器宽度监听（设计方案 §5.4）。
 *
 * 集成场景由核心的 `ResizeObserver` 写 `data-viewport`/`data-sidebar-layout`，
 * 外壳只读取；独立挂载时使用 `ViewportObserver` 以容器宽度写入同名属性。
 * 全程只使用 `ResizeObserver`/`matchMedia`/`window.innerWidth`，不做 UA 判断。
 */
import type { SidebarMode, ViewportMode } from './types';

/** 断点阈值，单位 px；与设计方案 §5.4 对应。 */
export const VIEWPORT_BREAKPOINTS = Object.freeze({
  /** >= 1024 为桌面。 */
  desktop: 1024,
  /** >= 768 为紧凑。 */
  compact: 768,
  /** >= 480 为移动。 */
  mobile: 480,
});

/**
 * 根据容器宽度计算断点。
 *
 * @param width 容器内容宽度，单位 px。
 * @returns 断点模式；`<480` 为 narrow。
 */
export function resolveViewport(width: number): ViewportMode {
  if (!Number.isFinite(width) || width <= 0) return 'desktop';
  if (width >= VIEWPORT_BREAKPOINTS.desktop) return 'desktop';
  if (width >= VIEWPORT_BREAKPOINTS.compact) return 'compact';
  if (width >= VIEWPORT_BREAKPOINTS.mobile) return 'mobile';
  return 'narrow';
}

/**
 * 断点对应的侧栏布局。
 *
 * @param mode 断点模式。
 * @returns 桌面常驻、紧凑覆盖、移动/窄屏抽屉。
 */
export function resolveSidebarMode(mode: ViewportMode): SidebarMode {
  switch (mode) {
    case 'desktop':
      return 'inline';
    case 'compact':
      return 'overlay';
    case 'mobile':
    case 'narrow':
    default:
      return 'drawer';
  }
}

/**
 * 规范化外部写入的 `data-viewport` 值。
 *
 * @param value 属性值。
 * @returns 合法断点；非法值返回 undefined。
 */
export function parseViewport(value: string | null | undefined): ViewportMode | undefined {
  if (value === 'desktop' || value === 'compact' || value === 'mobile' || value === 'narrow') {
    return value;
  }
  return undefined;
}

/**
 * 规范化外部写入的 `data-sidebar-layout` 值。
 *
 * @param value 属性值。
 * @returns 合法布局；非法值返回 undefined。
 */
export function parseSidebarMode(
  value: string | null | undefined,
): SidebarMode | undefined {
  if (value === 'inline' || value === 'overlay' || value === 'drawer') {
    return value;
  }
  return undefined;
}

/** 容器宽度监听选项。 */
export interface ViewportObserverOptions {
  /** 宽度变化回调；初始 `start()` 时也会调用一次。 */
  readonly onResize: (width: number, mode: ViewportMode) => void;
  /** 读取窗口；默认当前全局 window。测试可注入。 */
  readonly getWindow?: () => (Window & typeof globalThis) | null;
}

/** `ResizeObserver` 的最小结构，便于测试注入。 */
export interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

/** 可通过全局构造的 ResizeObserver 工厂。 */
type ResizeObserverConstructor = new (
  callback: ResizeObserverCallback,
) => ResizeObserverLike;

/**
 * 以阅读器容器宽度为准的断点监听器。
 *
 * 优先 `ResizeObserver`；环境不支持时回退到窗口 `resize` 事件。
 * 容器不可见（宽度为 0）时回退到窗口宽度，保证全屏/隐藏切换后状态可用。
 */
export class ViewportObserver {
  private observer: ResizeObserverLike | null = null;
  private started = false;
  private lastMode: ViewportMode | null = null;
  private lastWidth = 0;
  private readonly options: ViewportObserverOptions;

  /**
   * 创建监听器。
   *
   * @param element 阅读器根节点或容器。
   * @param options 回调与可注入依赖。
   */
  constructor(
    private readonly element: HTMLElement,
    options: ViewportObserverOptions,
  ) {
    this.options = options;
  }

  /** 是否已启动。 */
  get isStarted(): boolean {
    return this.started;
  }

  /** 最近一次测量的容器宽度，单位 px。 */
  get width(): number {
    return this.lastWidth;
  }

  /** 最近一次断点。 */
  get mode(): ViewportMode | null {
    return this.lastMode;
  }

  /** 启动监听并立即测量一次。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    const win = this.getWindow();
    const ResizeObserverCtor = (win as unknown as {
      ResizeObserver?: ResizeObserverConstructor;
    } | null)?.ResizeObserver;
    if (ResizeObserverCtor) {
      this.observer = new ResizeObserverCtor(() => this.update());
      this.observer.observe(this.element);
    }
    win?.addEventListener('resize', this.handleWindowResize);
    this.update();
  }

  /** 停止监听。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    this.getWindow()?.removeEventListener('resize', this.handleWindowResize);
  }

  /**
   * 立即重新测量并触发回调。
   *
   * @returns 当前断点。
   */
  update(): ViewportMode {
    const width = this.measure();
    const mode = resolveViewport(width);
    this.lastWidth = width;
    this.lastMode = mode;
    this.options.onResize(width, mode);
    return mode;
  }

  /** 读取窗口。 */
  private getWindow(): (Window & typeof globalThis) | null {
    if (this.options.getWindow) return this.options.getWindow();
    return typeof window === 'undefined' ? null : window;
  }

  /** 测量容器宽度；容器为 0 时回退到窗口宽度。 */
  private measure(): number {
    const rect = this.element.getBoundingClientRect();
    const own = this.element.clientWidth || rect.width;
    if (own > 0) return own;
    const win = this.getWindow();
    if (win) {
      const media = win.matchMedia;
      if (typeof media === 'function') {
        if (media.call(win, '(max-width: 479px)').matches) return 479;
        if (media.call(win, '(max-width: 767px)').matches) return 767;
        if (media.call(win, '(max-width: 1023px)').matches) return 1023;
      }
      return win.innerWidth || VIEWPORT_BREAKPOINTS.desktop;
    }
    return VIEWPORT_BREAKPOINTS.desktop;
  }

  /** 窗口 resize 兜底。 */
  private readonly handleWindowResize = (): void => {
    this.update();
  };
}