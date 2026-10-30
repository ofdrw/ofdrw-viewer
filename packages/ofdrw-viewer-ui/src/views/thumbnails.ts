/**
 * 缩略图列表（设计方案 §7）。
 *
 * 消费核心已加载的 `PageInfo` 与引擎页渲染能力：
 * - 千页文档只给可见项 ±5 创建低分辨率 canvas，渲染任务在空闲时串行执行；
 * - 窗口内尚无 canvas 的项显示低对比骨架（`aria-hidden`），窗口外只显示静态页码，
 *   避免 1000 项同时播放动画；缩略图不单独放 spinner，也不触发主页面 loading；
 * - 每个 canvas 独立于主视图，使用低 DPI（24–96）与 LRU 缓存；失败只显示灰色占位
 *   与页码，用户点击该项时才重试；
 * - 当前页高亮并与主视图页码同步，点击跳转、侧栏关闭时暂停队列。
 */

import { replaceChildren } from '../compat';

import type { PageContentFilter } from '@ofdrw/ofdrw-viewer-engine';
import type { Translator } from '../i18n';
import type { PageLayerState, Rotation, ViewerState } from '../state';
import {
  createEmptyState,
  ensureNavigationStyle,
  formatPageLabel,
  normalizePageInfo,
  reportNavigationWarning,
  scheduleIdle,
  type NavigationPage,
  type NavigationRenderTask,
  type NavigationViewer,
} from './shared';
import { UI_WARNING_CODES } from '../diagnostics';

/** 只渲染可见项前后各 5 项（设计方案 §7.2）。 */
export const THUMBNAIL_WINDOW = 5;

/** 缩略图目标宽度，单位 px（侧栏 200 px - 24 px 留白）。 */
export const THUMBNAIL_WIDTH = 140;

/** 缩略图最大显示高度，单位 px；避免超长页撑爆侧栏。 */
export const THUMBNAIL_MAX_HEIGHT = 180;

/** 缩略图缓存默认上限（设计方案 `thumbnailCacheSize` 默认值）。 */
export const THUMBNAIL_CACHE_SIZE = 100;

/** 缩略图渲染 DPI 下限。 */
const MIN_DPI = 24;

/** 缩略图渲染 DPI 上限。 */
const MAX_DPI = 96;

/** 缩略图状态（设计方案 §6.9.4 / §7.2）。 */
export type ThumbnailState = 'idle' | 'queued' | 'rendering' | 'rendered' | 'failed';

/** 列表项。 */
interface ThumbnailEntry {
  readonly pageNumber: number;
  readonly element: HTMLButtonElement;
  readonly wrapper: HTMLElement;
  /** 静态页码占位：`idle` / `failed` 时显示。 */
  readonly fallback: HTMLElement;
  /** 低对比骨架：`queued` / `rendering` 时显示，`aria-hidden`。 */
  readonly skeleton: HTMLElement;
  canvas: HTMLCanvasElement | null;
  state: ThumbnailState;
  /** 渲染该 canvas 时的图层过滤签名；与当前签名不同即需要重绘。 */
  filterKey: string;
}

/**
 * 计算缩略图显示宽度。
 *
 * @param widthMm 页宽，单位 mm。
 * @param heightMm 页高，单位 mm。
 * @returns CSS 像素宽度，超长页按最大高度折算。
 */
function getDisplayWidth(widthMm: number, heightMm: number): number {
  const ratio = heightMm / widthMm;
  return THUMBNAIL_WIDTH * ratio > THUMBNAIL_MAX_HEIGHT
    ? THUMBNAIL_MAX_HEIGHT / ratio
    : THUMBNAIL_WIDTH;
}

/** 缩略图视图选项。 */
export interface ThumbnailViewOptions {
  /** 阅读器。 */
  readonly viewer: NavigationViewer;
  /** 面板容器。 */
  readonly host: HTMLElement;
  /** 读取当前翻译器；语言切换后仍能取到新实例。 */
  readonly getTranslator: () => Translator;
  /** 渲染窗口半径；默认 ±5。 */
  readonly windowSize?: number;
  /** 缓存上限；默认 100。 */
  readonly cacheSize?: number;
}

/**
 * 核心阅读器的页面渲染归属登记；最小化替身可缺省。
 *
 * 必须在调用 `page.render()` 前登记，核心依赖同步的 `page:render:start`
 * 把 `operationId` 映射为缩略图用途。
 */
interface RenderStartTracking {
  trackPageRenderStart(
    pageIndex: number,
    purpose: 'main' | 'thumbnail',
  ): { drop(): void };
}

/** 缩略图列表。 */
export class ThumbnailView {
  private readonly viewer: NavigationViewer;
  private readonly host: HTMLElement;
  private readonly getTranslator: () => Translator;
  private readonly windowSize: number;
  private readonly cacheSize: number;
  private readonly root: HTMLElement;
  private readonly entries = new Map<number, ThumbnailEntry>();
  private readonly cache = new Map<number, HTMLCanvasElement>();
  private readonly visible = new Set<number>();
  private readonly offs: Array<() => void> = [];
  private observer: IntersectionObserver | null = null;
  private desired = new Set<number>();
  private queued: number[] = [];
  private pumpCancel: (() => void) | null = null;
  private activeRender: {
    pageNumber: number;
    controller: AbortController;
    task: NavigationRenderTask | null;
  } | null = null;
  private pumping = false;
  private active = false;
  private lastPageNumber = 1;
  private lastPageCount = 0;
  private lastLocale = '';
  private lastRotation: Rotation = 0;
  /** 最近处理的图层快照；引用变化表示有页的过滤改变。 */
  private lastLayers: PageLayerState | null = null;
  private destroyed = false;

  /**
   * @param options 阅读器、面板容器与窗口配置。
   */
  constructor(options: ThumbnailViewOptions) {
    this.viewer = options.viewer;
    this.host = options.host;
    this.getTranslator = options.getTranslator;
    this.windowSize = Math.max(0, Math.trunc(options.windowSize ?? THUMBNAIL_WINDOW));
    this.cacheSize = Math.max(1, Math.trunc(options.cacheSize ?? THUMBNAIL_CACHE_SIZE));
    ensureNavigationStyle(this.host.ownerDocument);
    this.root = this.host.ownerDocument.createElement('div');
    this.root.className = 'ofd-thumbnails';
    this.root.setAttribute('role', 'listbox');
    this.root.setAttribute('aria-label', this.getTranslator().t('sidebar.thumbnails'));
    replaceChildren(this.host, this.root);

    const state = this.viewer.getState();
    this.lastPageNumber = state.view.pageNumber;
    this.lastPageCount = state.document.pageCount;
    this.lastLocale = state.ui.locale;
    this.lastRotation = state.view.rotation;
    this.lastLayers = state.ui.layers;
    this.active = this.viewer.getSidebarView() === 'thumbnails';
    this.root.dataset.rotation = String(this.lastRotation);
    this.buildList();
    this.updateCurrent();
    this.offs.push(this.viewer.on('statechange', (next) => this.handleStateChange(next)));
    this.refreshWindow();
  }

  /** 当前渲染窗口内的页码（升序）。 */
  getWindowPages(): number[] {
    return [...this.desired].sort((left, right) => left - right);
  }

  /** 已渲染并缓存的页码（升序）。 */
  getRenderedPages(): number[] {
    return [...this.cache.keys()].sort((left, right) => left - right);
  }

  /** 释放监听、渲染任务与缓存。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.observer?.disconnect();
    this.observer = null;
    this.host.removeEventListener('scroll', this.handleScroll);
    this.cancelPump();
    this.abortActive();
    this.cache.clear();
    this.entries.clear();
    this.root.remove();
  }

  /** 构建全部页的占位按钮；canvas 在需要时才创建。 */
  private buildList(): void {
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    const pageCount = this.viewer.getState().document.pageCount;
    this.abortActive();
    replaceChildren(this.root);
    this.entries.clear();
    this.cache.clear();
    this.visible.clear();
    this.observer?.disconnect();
    this.observer = null;
    if (pageCount <= 0) {
      this.root.append(createEmptyState(doc, translator.t('sidebar.noThumbnails')));
      return;
    }
    const fragment = doc.createDocumentFragment();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = 'ofd-thumbnail';
      element.dataset.page = String(pageNumber);
      element.dataset.state = 'idle';
      element.setAttribute('role', 'option');
      element.setAttribute('aria-selected', 'false');
      element.setAttribute('aria-label', formatPageLabel(translator, pageNumber, pageCount));

      const info = normalizePageInfo(this.viewer.getPageInfo(pageNumber));
      const displayWidth = Math.round(getDisplayWidth(info.widthMm, info.heightMm));
      // 用显式宽高而非 aspect-ratio，兼容旧版 Chromium（骨架不依赖新 CSS 语法）。
      const displayHeight = Math.max(
        1,
        Math.round(displayWidth * (info.heightMm / info.widthMm)),
      );

      const wrapper = doc.createElement('span');
      wrapper.className = 'ofd-thumbnail__canvas-wrapper';
      // 窗口外的静态页码占位：不播放动画，只保留可读页码。
      const fallback = doc.createElement('span');
      fallback.className = 'ofd-thumbnail__fallback';
      fallback.textContent = translator.formatNumber(pageNumber);
      fallback.style.width = `${displayWidth}px`;
      fallback.style.height = `${displayHeight}px`;
      fallback.hidden = false;
      // 窗口内尚未生成 canvas 时的低对比骨架；纯装饰，读屏忽略。
      const skeleton = doc.createElement('span');
      skeleton.className = 'ofd-thumbnail__skeleton';
      skeleton.setAttribute('aria-hidden', 'true');
      skeleton.hidden = true;
      skeleton.style.width = `${displayWidth}px`;
      skeleton.style.height = `${displayHeight}px`;
      wrapper.append(fallback, skeleton);

      const label = doc.createElement('span');
      label.className = 'ofd-thumbnail__label';
      label.textContent = translator.formatNumber(pageNumber);
      element.append(wrapper, label);
      element.addEventListener('click', () => this.handleClick(pageNumber));
      fragment.append(element);
      const entry: ThumbnailEntry = {
        pageNumber,
        element,
        wrapper,
        fallback,
        skeleton,
        canvas: null,
        state: 'idle',
        filterKey: this.filterKeyOf(pageNumber),
      };
      this.entries.set(pageNumber, entry);
      this.setEntryState(entry, 'idle');
    }
    this.root.append(fragment);
    this.observeVisibility();
  }

  /** 监听可见项：优先 IntersectionObserver，缺失时退化为当前页窗口。 */
  private observeVisibility(): void {
    if (this.destroyed) return;
    this.host.removeEventListener('scroll', this.handleScroll);
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver(
        (records) => {
          let changed = false;
          for (const record of records) {
            const pageNumber = Number((record.target as HTMLElement).dataset.page);
            if (!Number.isFinite(pageNumber)) continue;
            if (record.isIntersecting) {
              if (!this.visible.has(pageNumber)) {
                this.visible.add(pageNumber);
                changed = true;
              }
            } else {
              changed = this.visible.delete(pageNumber) || changed;
            }
          }
          if (changed) this.refreshWindow();
        },
        { root: this.host, rootMargin: '120px 0px' },
      );
      for (const entry of this.entries.values()) this.observer.observe(entry.element);
      return;
    }
    this.host.addEventListener('scroll', this.handleScroll, { passive: true });
  }

  /** 缺少 IntersectionObserver 时按滚动位置扫描可见项。 */
  private readonly handleScroll = (): void => {
    if (this.destroyed) return;
    const hostRect = this.host.getBoundingClientRect();
    if (hostRect.height <= 0) {
      // jsdom 等无布局环境：只按当前页窗口计算，避免渲染全部缩略图。
      this.refreshWindow();
      return;
    }
    this.visible.clear();
    for (const entry of this.entries.values()) {
      const rect = entry.element.getBoundingClientRect();
      if (rect.bottom >= hostRect.top && rect.top <= hostRect.bottom) {
        this.visible.add(entry.pageNumber);
      }
    }
    this.refreshWindow();
  };

  /** 处理状态变化：换页、换文档、语言/旋转、侧栏开关。 */
  private handleStateChange(state: ViewerState): void {
    if (this.destroyed) return;
    let rebuilt = false;
    if (state.document.pageCount !== this.lastPageCount) {
      this.lastPageCount = state.document.pageCount;
      this.buildList();
      rebuilt = true;
    }
    if (state.ui.locale !== this.lastLocale) {
      this.lastLocale = state.ui.locale;
      this.buildList();
      rebuilt = true;
    }
    if (rebuilt) {
      this.updateCurrent();
      this.refreshWindow();
    }
    if (state.view.rotation !== this.lastRotation) {
      this.lastRotation = state.view.rotation;
      this.root.dataset.rotation = String(state.view.rotation);
    }
    if (state.ui.layers !== this.lastLayers) {
      this.lastLayers = state.ui.layers;
      this.invalidateLayers();
    }
    const active = state.view.sidebarView === 'thumbnails';
    if (active !== this.active) {
      this.active = active;
      if (!active) this.pause();
      else this.refreshWindow();
    }
    if (state.view.pageNumber !== this.lastPageNumber) {
      this.lastPageNumber = state.view.pageNumber;
      this.updateCurrent();
      this.refreshWindow();
    }
  }

  /** 点击缩略图：失败项先重试，再跳转。 */
  private handleClick(pageNumber: number): void {
    const entry = this.entries.get(pageNumber);
    if (!entry) return;
    if (entry.state === 'failed') this.retry(pageNumber);
    try {
      this.viewer.goToPage(pageNumber);
    } catch (error) {
      reportNavigationWarning(
        this.viewer,
        UI_WARNING_CODES.W_THUMBNAIL_JUMP,
        `跳转到第 ${pageNumber} 页失败：${error instanceof Error ? error.message : String(error)}`,
        pageNumber - 1,
      );
    }
  }

  /** 用户点击失败项后重试；不参与自动重试。 */
  private retry(pageNumber: number): void {
    const entry = this.entries.get(pageNumber);
    if (!entry || entry.state === 'rendering') return;
    this.releaseCanvas(entry);
    this.setEntryState(entry, 'idle');
    this.refreshWindow();
  }

  /** 更新当前页高亮，并让当前缩略图滚入可视区。 */
  private updateCurrent(): void {
    const current = this.lastPageNumber;
    for (const entry of this.entries.values()) {
      const selected = entry.pageNumber === current;
      entry.element.setAttribute('aria-current', selected ? 'page' : 'false');
      entry.element.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    if (!this.active) return;
    const element = this.entries.get(current)?.element;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 重新计算渲染窗口并排队。 */
  private refreshWindow(): void {
    if (this.destroyed) return;
    if (!this.active) {
      this.pause();
      return;
    }
    if (!this.viewer.isFeatureEnabled('thumbnails')) {
      this.pause();
      return;
    }
    const pageCount = this.entries.size;
    if (pageCount === 0) return;
    const current = Math.min(Math.max(1, this.lastPageNumber), pageCount);
    const base = new Set<number>(this.visible);
    base.add(current);
    const desired = new Set<number>();
    for (const pageNumber of base) {
      if (!Number.isFinite(pageNumber)) continue;
      for (let offset = -this.windowSize; offset <= this.windowSize; offset += 1) {
        const candidate = pageNumber + offset;
        if (candidate >= 1 && candidate <= pageCount) desired.add(candidate);
      }
    }
    this.desired = desired;

    // 离屏渲染任务取消，避免继续占用引擎。
    if (this.activeRender && !desired.has(this.activeRender.pageNumber)) this.abortActive();

    // 状态与窗口对齐：窗口内无 canvas 的项排队并播骨架，窗口外未开始的项回到 idle。
    this.syncEntryStates();

    this.queued = [...desired]
      .filter((pageNumber) => {
        const entry = this.entries.get(pageNumber);
        if (!entry) return false;
        if (entry.state === 'rendered' || entry.state === 'failed') return false;
        if (this.activeRender?.pageNumber === pageNumber) return false;
        if (this.cache.has(pageNumber)) return false;
        return true;
      })
      .sort(
        (left, right) =>
          Math.abs(left - current) - Math.abs(right - current) || left - right,
      );
    this.trimCache();
    this.pumpSoon();
  }

  /**
   * 按渲染窗口同步每个缩略图项的状态。
   *
   * `queued`/`rendering` 只用于窗口内尚无 canvas 的项，因此 1000 页文档中
   * 同一时刻只有窗口内的少量骨架在播放动画；窗口外未开始的项回退 `idle`，
   * 只显示静态页码。已有 canvas 的 `rendered` 与等待用户重试的 `failed` 保持不变。
   */
  private syncEntryStates(): void {
    const activePage = this.activeRender?.pageNumber;
    for (const entry of this.entries.values()) {
      if (!this.desired.has(entry.pageNumber)) {
        if (entry.state === 'queued') this.setEntryState(entry, 'idle');
        continue;
      }
      if (entry.state === 'rendered' || entry.state === 'failed') continue;
      if (activePage === entry.pageNumber) {
        if (entry.state !== 'rendering') this.setEntryState(entry, 'rendering');
        continue;
      }
      if (entry.state !== 'queued') this.setEntryState(entry, 'queued');
    }
  }

  /**
   * 统一写入缩略图状态与占位可见性。
   *
   * - `queued` / `rendering`：显示骨架，隐藏页码占位；
   * - `rendered`：显示 canvas，隐藏骨架与占位；
   * - `idle` / `failed`：隐藏骨架，显示静态页码占位。
   *
   * @param entry 列表项。
   * @param state 目标状态。
   */
  private setEntryState(entry: ThumbnailEntry, state: ThumbnailState): void {
    entry.state = state;
    entry.element.dataset.state = state;
    const showSkeleton = state === 'queued' || state === 'rendering';
    entry.skeleton.hidden = !showSkeleton;
    entry.fallback.hidden = showSkeleton || state === 'rendered';
  }

  /** 空闲时启动串行渲染。 */
  private pumpSoon(): void {
    if (this.pumpCancel || this.pumping || this.destroyed) return;
    if (this.queued.length === 0) return;
    this.pumpCancel = scheduleIdle(() => {
      this.pumpCancel = null;
      void this.pump();
    });
  }

  /** 串行渲染窗口内缩略图。 */
  private async pump(): Promise<void> {
    if (this.pumping || this.destroyed) return;
    this.pumping = true;
    try {
      while (!this.destroyed && this.active) {
        const pageNumber = this.queued.shift();
        if (pageNumber === undefined) break;
        const entry = this.entries.get(pageNumber);
        if (!this.desired.has(pageNumber)) {
          if (entry?.state === 'queued') this.setEntryState(entry, 'idle');
          continue;
        }
        if (this.cache.has(pageNumber)) {
          if (entry && entry.state !== 'rendered') this.setEntryState(entry, 'rendered');
          continue;
        }
        if (!entry || entry.state === 'failed' || entry.state === 'rendered') continue;
        await this.renderThumbnail(entry);
      }
    } finally {
      this.pumping = false;
      if (this.queued.length > 0) this.pumpSoon();
    }
  }

  /**
   * 渲染单个缩略图。
   *
   * @param entry 列表项。
   * @returns 成功渲染时返回 true。
   */
  private async renderThumbnail(entry: ThumbnailEntry): Promise<boolean> {
    const pageNumber = entry.pageNumber;
    const controller = new AbortController();
    this.activeRender = { pageNumber, controller, task: null };
    this.setEntryState(entry, 'rendering');
    try {
      const page: NavigationPage = await this.viewer.getPage(pageNumber);
      if (controller.signal.aborted || this.destroyed) return false;
      const info = normalizePageInfo(this.viewer.getPageInfo(pageNumber));
      const dpr = Math.min(
        2,
        Math.max(1, this.host.ownerDocument.defaultView?.devicePixelRatio ?? 1),
      );
      const displayWidth = getDisplayWidth(info.widthMm, info.heightMm);
      const dpi = Math.min(
        MAX_DPI,
        Math.max(MIN_DPI, (displayWidth / info.widthMm) * 25.4 * dpr),
      );
      const viewport = page.getViewport({ dpi });
      const canvas = entry.canvas ?? this.host.ownerDocument.createElement('canvas');
      canvas.className = 'ofd-thumbnail__canvas';
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      canvas.style.width = `${Math.round(displayWidth)}px`;
      canvas.style.height = 'auto';
      canvas.dataset.dpi = String(Math.round(dpi));
      if (!entry.canvas) {
        entry.canvas = canvas;
        entry.wrapper.insertBefore(canvas, entry.fallback);
      }
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前环境不支持 Canvas 2D');
      const tracker = this.viewer as NavigationViewer & Partial<RenderStartTracking>;
      const pending = tracker.trackPageRenderStart?.(pageNumber - 1, 'thumbnail');
      const filter = this.filterOf(pageNumber);
      const filterKey = this.filterKeyOf(pageNumber);
      let task: NavigationRenderTask;
      try {
        task = page.render({
          canvasContext: context,
          viewport,
          signal: controller.signal,
          ...(filter ? { contentFilter: filter } : {}),
        });
      } catch (error) {
        // 入口校验失败不会派发 start，必须弹出待归属项避免错配后续事件。
        pending?.drop();
        throw error;
      }
      pending?.drop();
      this.activeRender.task = task;
      await task.promise;
      if (controller.signal.aborted || this.destroyed) {
        // 取消后不保留半成品 canvas；refreshWindow 可能已重新排队（骨架保持）。
        this.releaseCanvas(entry);
        if (entry.state === 'rendering') this.setEntryState(entry, 'idle');
        return false;
      }
      this.setEntryState(entry, 'rendered');
      entry.filterKey = filterKey;
      this.touchCache(pageNumber, canvas);
      return true;
    } catch (error) {
      if (controller.signal.aborted || this.destroyed) {
        this.releaseCanvas(entry);
        if (entry.state === 'rendering') this.setEntryState(entry, 'idle');
        return false;
      }
      // 失败只保留灰色占位 + 页码，不遗留空白 canvas。
      this.releaseCanvas(entry);
      this.setEntryState(entry, 'failed');
      reportNavigationWarning(
        this.viewer,
        UI_WARNING_CODES.W_THUMBNAIL,
        `第 ${pageNumber} 页缩略图渲染失败：${error instanceof Error ? error.message : String(error)}`,
        pageNumber - 1,
      );
      return false;
    } finally {
      if (this.activeRender?.pageNumber === pageNumber) this.activeRender = null;
    }
  }

  /**
   * 读取指定页的图层过滤。
   *
   * @param pageNumber 页码，1-based。
   * @returns 过滤配置；宿主未实现或全画时为 undefined。
   */
  private filterOf(pageNumber: number): PageContentFilter | undefined {
    return this.viewer.getPageContentFilter
      ? this.viewer.getPageContentFilter(pageNumber)
      : undefined;
  }

  /**
   * 读取指定页的图层过滤签名。
   *
   * @param pageNumber 页码，1-based。
   * @returns 签名；宿主未实现时为 `'all'`。
   */
  private filterKeyOf(pageNumber: number): string {
    return this.viewer.getLayerFilterKey ? this.viewer.getLayerFilterKey(pageNumber) : 'all';
  }

  /** 过滤变化的页：释放 canvas、回到 idle，并让窗口内该项重新排队。 */
  private invalidateLayers(): void {
    for (const entry of this.entries.values()) {
      if (entry.filterKey === this.filterKeyOf(entry.pageNumber)) continue;
      if (this.activeRender?.pageNumber === entry.pageNumber) this.abortActive();
      this.cache.delete(entry.pageNumber);
      this.releaseCanvas(entry);
      entry.filterKey = this.filterKeyOf(entry.pageNumber);
      this.setEntryState(entry, 'idle');
    }
    this.refreshWindow();
  }

  /** 写入 LRU 缓存并按上限淘汰离屏 canvas。 */
  private touchCache(pageNumber: number, canvas: HTMLCanvasElement): void {
    this.cache.delete(pageNumber);
    this.cache.set(pageNumber, canvas);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      if (!this.desired.has(oldest)) this.releaseEntry(oldest);
    }
  }

  /** 按缓存上限裁剪；离屏且超限的 canvas 释放。 */
  private trimCache(): void {
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      if (!this.desired.has(oldest)) this.releaseEntry(oldest);
    }
  }

  /** 释放指定页 canvas；页码不存在时忽略。 */
  private releaseEntry(pageNumber: number): void {
    const entry = this.entries.get(pageNumber);
    if (!entry) return;
    this.releaseCanvas(entry);
    this.setEntryState(entry, 'idle');
  }

  /** 清空 canvas 像素并移除节点。 */
  private releaseCanvas(entry: ThumbnailEntry): void {
    if (!entry.canvas) return;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas.remove();
    entry.canvas = null;
  }

  /** 暂停队列并取消在途渲染；骨架回到静态页码。 */
  private pause(): void {
    this.cancelPump();
    this.abortActive();
    this.queued = [];
    for (const entry of this.entries.values()) {
      if (entry.state === 'queued' || entry.state === 'rendering') {
        this.setEntryState(entry, 'idle');
      }
    }
  }

  /** 取消空闲调度。 */
  private cancelPump(): void {
    this.pumpCancel?.();
    this.pumpCancel = null;
  }

  /** 取消在途渲染，丢弃半成品 canvas，并把该项同步回 idle（若已重新排队则保留骨架）。 */
  private abortActive(): void {
    const active = this.activeRender;
    if (!active) return;
    this.activeRender = null;
    active.controller.abort();
    active.task?.cancel();
    const entry = this.entries.get(active.pageNumber);
    if (!entry) return;
    this.releaseCanvas(entry);
    if (entry.state === 'rendering') this.setEntryState(entry, 'idle');
  }
}
