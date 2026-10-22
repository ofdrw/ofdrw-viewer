/**
 * 缩略图列表（设计方案 §7）。
 *
 * 消费核心已加载的 `PageInfo` 与引擎页渲染能力：
 * - 千页文档只给可见项 ±5 创建低分辨率 canvas，渲染任务在空闲时串行执行；
 * - 每个 canvas 独立于主视图，使用低 DPI（24–96）与 LRU 缓存，失败只显示占位；
 * - 当前页高亮并与主视图页码同步，点击跳转、侧栏关闭时暂停队列。
 */

import type { Translator } from '../i18n';
import type { Rotation, ViewerState } from '../state';
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

/** 缩略图状态。 */
export type ThumbnailState = 'idle' | 'rendering' | 'rendered' | 'failed';

/** 列表项。 */
interface ThumbnailEntry {
  readonly pageNumber: number;
  readonly element: HTMLButtonElement;
  readonly wrapper: HTMLElement;
  readonly fallback: HTMLElement;
  canvas: HTMLCanvasElement | null;
  state: ThumbnailState;
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
    this.host.replaceChildren(this.root);

    const state = this.viewer.getState();
    this.lastPageNumber = state.view.pageNumber;
    this.lastPageCount = state.document.pageCount;
    this.lastLocale = state.ui.locale;
    this.lastRotation = state.view.rotation;
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
    this.root.replaceChildren();
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

      const wrapper = doc.createElement('span');
      wrapper.className = 'ofd-thumbnail__canvas-wrapper';
      const fallback = doc.createElement('span');
      fallback.className = 'ofd-thumbnail__fallback';
      fallback.textContent = translator.formatNumber(pageNumber);
      fallback.hidden = true;
      wrapper.append(fallback);

      const label = doc.createElement('span');
      label.className = 'ofd-thumbnail__label';
      label.textContent = translator.formatNumber(pageNumber);
      element.append(wrapper, label);
      element.addEventListener('click', () => this.handleClick(pageNumber));
      fragment.append(element);
      this.entries.set(pageNumber, {
        pageNumber,
        element,
        wrapper,
        fallback,
        canvas: null,
        state: 'idle',
      });
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
        'W_THUMBNAIL_JUMP',
        `跳转到第 ${pageNumber} 页失败：${error instanceof Error ? error.message : String(error)}`,
        pageNumber - 1,
      );
    }
  }

  /** 用户点击失败项后重试。 */
  private retry(pageNumber: number): void {
    const entry = this.entries.get(pageNumber);
    if (!entry || entry.state === 'rendering') return;
    this.releaseCanvas(entry);
    entry.state = 'idle';
    entry.element.dataset.state = 'idle';
    entry.fallback.hidden = true;
    this.queued.push(pageNumber);
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

    this.queued = [...desired]
      .filter((pageNumber) => {
        const entry = this.entries.get(pageNumber);
        if (!entry) return false;
        if (entry.state === 'rendered' || entry.state === 'failed') return false;
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
        if (!this.desired.has(pageNumber)) continue;
        if (this.cache.has(pageNumber)) continue;
        const entry = this.entries.get(pageNumber);
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
    entry.state = 'rendering';
    entry.element.dataset.state = 'rendering';
    try {
      const page: NavigationPage = await this.viewer.getPage(pageNumber);
      if (controller.signal.aborted || this.destroyed) return false;
      const info = normalizePageInfo(this.viewer.getPageInfo(pageNumber));
      const dpr = Math.min(
        2,
        Math.max(1, this.host.ownerDocument.defaultView?.devicePixelRatio ?? 1),
      );
      const ratio = info.heightMm / info.widthMm;
      const displayWidth =
        THUMBNAIL_WIDTH * ratio > THUMBNAIL_MAX_HEIGHT
          ? THUMBNAIL_MAX_HEIGHT / ratio
          : THUMBNAIL_WIDTH;
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
      const task = page.render({
        canvasContext: context,
        viewport,
        signal: controller.signal,
      });
      this.activeRender.task = task;
      await task.promise;
      if (controller.signal.aborted || this.destroyed) {
        entry.state = 'idle';
        entry.element.dataset.state = 'idle';
        return false;
      }
      entry.state = 'rendered';
      entry.element.dataset.state = 'rendered';
      entry.fallback.hidden = true;
      this.touchCache(pageNumber, canvas);
      return true;
    } catch (error) {
      if (controller.signal.aborted || this.destroyed) {
        entry.state = 'idle';
        entry.element.dataset.state = 'idle';
        return false;
      }
      entry.state = 'failed';
      entry.element.dataset.state = 'failed';
      entry.fallback.hidden = false;
      entry.fallback.textContent = this.getTranslator().formatNumber(pageNumber);
      reportNavigationWarning(
        this.viewer,
        'W_THUMBNAIL',
        `第 ${pageNumber} 页缩略图渲染失败：${error instanceof Error ? error.message : String(error)}`,
        pageNumber - 1,
      );
      return false;
    } finally {
      if (this.activeRender?.pageNumber === pageNumber) this.activeRender = null;
    }
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
    entry.state = 'idle';
    entry.element.dataset.state = 'idle';
    entry.fallback.hidden = true;
  }

  /** 清空 canvas 像素并移除节点。 */
  private releaseCanvas(entry: ThumbnailEntry): void {
    if (!entry.canvas) return;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas.remove();
    entry.canvas = null;
  }

  /** 暂停队列并取消在途渲染。 */
  private pause(): void {
    this.cancelPump();
    this.abortActive();
    this.queued = [];
  }

  /** 取消空闲调度。 */
  private cancelPump(): void {
    this.pumpCancel?.();
    this.pumpCancel = null;
  }

  /** 取消在途渲染。 */
  private abortActive(): void {
    const active = this.activeRender;
    if (!active) return;
    this.activeRender = null;
    active.controller.abort();
    active.task?.cancel();
  }
}
