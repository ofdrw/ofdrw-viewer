/**
 * 查找控制器（设计方案 §9.4）。
 *
 * 逐页读取 `getTextContent`，把命中映射为字符 quad 高亮框；搜索按“时间片 + 页数”
 * 分片，片间让出事件循环，保证 1000 页文档可滚动、可取消、有进度。查询变化或关闭
 * 时递增代次并中止旧任务，旧结果一律丢弃。
 *
 * 本类不直接操作 DOM：高亮渲染与滚动交给 `FindHighlightRenderer`。
 */

import type { PageContentFilter, TextContent } from '@ofdrw/ofdrw-viewer-engine';
import { createFeatureDisabledError } from '../errors';
import type { FindOptions } from '../types';
import type { FindState, ViewerState } from '../state';
import type { FindHighlightRenderer, FindMatch, SliceScheduler } from './types';
import type { TextViewerHost, ViewerBridge } from './viewer-bridge';
import { textContentOptions } from './viewer-bridge';
import type { PageSearchSource } from './search';
import {
  createPageSearchSource,
  findPageMatches,
  highlightBoxesForRange,
  normalizeQuery,
} from './search';
import { UI_WARNING_CODES } from '../diagnostics';

/** 默认单个时间片预算，单位毫秒。 */
export const DEFAULT_SLICE_BUDGET_MS = 8;

/** 默认单个时间片最多处理页数；保证分片可被测试与取消观察。 */
export const DEFAULT_PAGES_PER_SLICE = 8;

/** 默认单页命中上限。 */
export const DEFAULT_MAX_PAGE_MATCHES = 1000;

/** 默认全篇命中上限。 */
export const DEFAULT_MAX_TOTAL_MATCHES = 10_000;

/** 默认文本抽取缓存页数。 */
export const DEFAULT_MAX_CACHED_PAGES = 16;

/** 默认分片调度：优先 requestIdleCallback，回退 setTimeout。 */
const defaultScheduler: SliceScheduler = {
  request(callback: () => void): void {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => callback(), { timeout: 50 });
      return;
    }
    setTimeout(callback, 0);
  },
};

/** 查找控制器选项。 */
export interface FindControllerOptions {
  /** 分片调度器；测试可注入同步队列。 */
  readonly scheduler?: SliceScheduler;
  /** 时间源，单位毫秒；测试可注入。 */
  readonly now?: () => number;
  /** 片时间预算，单位毫秒；默认 8。 */
  readonly sliceBudgetMs?: number;
  /** 每片最多页数；默认 8。 */
  readonly pagesPerSlice?: number;
  /** 单页命中上限；默认 1000，0 表示不限。 */
  readonly maxPageMatches?: number;
  /** 全篇命中上限；默认 10000，0 表示不限。 */
  readonly maxTotalMatches?: number;
  /** 文本抽取缓存页数；默认 16。 */
  readonly maxCachedPages?: number;
}

/** 查找启动后解析的选项。 */
interface ResolvedFindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly highlightAll: boolean;
  readonly fromCurrentPage: boolean;
}

/** 解析后的默认查找选项。 */
const DEFAULT_FIND_OPTIONS: ResolvedFindOptions = Object.freeze({
  caseSensitive: false,
  wholeWord: false,
  highlightAll: true,
  fromCurrentPage: true,
});

/**
 * 查找控制器。
 *
 * 实现核心 `ViewerFindService` 结构；由文本入口挂载到 `OFDViewer`。
 */
export class FindController {
  private readonly host: TextViewerHost;
  private readonly bridge: ViewerBridge;
  private readonly highlights: FindHighlightRenderer;
  private readonly scheduler: SliceScheduler;
  private readonly now: () => number;
  private readonly sliceBudgetMs: number;
  private readonly pagesPerSlice: number;
  private readonly maxPageMatches: number;
  private readonly maxTotalMatches: number;
  private readonly maxCachedPages: number;
  private readonly cache = new Map<number, PageSearchSource>();
  /** 与 `cache` 同步的过滤签名；签名变化后旧命中作废。 */
  private readonly cacheKeys = new Map<number, string>();
  private readonly cleanups: Array<() => void> = [];
  /** 最近一次处理过的图层快照；用引用比较判断是否发生过滤变化。 */
  private lastLayers: ViewerState['ui']['layers'] | null = null;
  /** 最近一次 `find()` 的原始查询串；重跑时原样使用。 */
  private rawQuery = '';

  private query = '';
  private options: ResolvedFindOptions = DEFAULT_FIND_OPTIONS;
  private matches: FindMatch[] = [];
  private current = 0;
  private searching = false;
  private truncated = false;
  private emptyPageCount = 0;
  private generation = 0;
  private abort: AbortController | null = null;
  private searchPromise: Promise<void> | null = null;
  private disposed = false;

  /**
   * @param host 阅读器能力集合。
   * @param bridge 核心状态/事件桥。
   * @param highlights 高亮渲染器（文本层服务）。
   * @param options 分片、上限与调度选项。
   */
  constructor(
    host: TextViewerHost,
    bridge: ViewerBridge,
    highlights: FindHighlightRenderer,
    options: FindControllerOptions = {},
  ) {
    this.host = host;
    this.bridge = bridge;
    this.highlights = highlights;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now =
      options.now ??
      (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.sliceBudgetMs = Math.max(0, options.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS);
    this.pagesPerSlice = Math.max(1, options.pagesPerSlice ?? DEFAULT_PAGES_PER_SLICE);
    this.maxPageMatches = Math.max(0, options.maxPageMatches ?? DEFAULT_MAX_PAGE_MATCHES);
    this.maxTotalMatches = Math.max(0, options.maxTotalMatches ?? DEFAULT_MAX_TOTAL_MATCHES);
    this.maxCachedPages = Math.max(1, options.maxCachedPages ?? DEFAULT_MAX_CACHED_PAGES);

    this.cleanups.push(
      host.on('documentopen', () => this.resetForDocument()),
      host.on('documentclose', () => this.resetForDocument()),
      host.on('featureschange', () => {
        if (!host.isFeatureEnabled('find')) this.clearFind();
      }),
      host.on('statechange', (state) => this.handleStateChange(state)),
    );
    this.lastLayers = host.getState().ui.layers;
  }

  /**
   * 图层可见性变化：作废旧缓存命中，并按需重跑当前查询。
   *
   * 用快照引用比较判断：引用未变说明没有页的过滤改变，滚动等常规状态变化直接返回。
   *
   * @param state 最新状态快照。
   */
  private handleStateChange(state: ViewerState): void {
    if (this.disposed) return;
    if (state.ui.layers === this.lastLayers) return;
    this.lastLayers = state.ui.layers;
    this.refreshLayerVisibility();
  }

  /**
   * 过滤变化后立即重跑当前查询。
   *
   * 清空逐页缓存后重新搜索：即使不重跑，下一次 `find()` 也会重新抽取（不会命中隐藏
   * 内容）；重跑只保证面板打开时的结果立即变化。
   */
  refreshLayerVisibility(): void {
    if (this.disposed) return;
    this.cache.clear();
    this.cacheKeys.clear();
    if (this.query === '' || this.searching) return;
    void this.find(this.rawQuery, this.toFindOptions());
  }

  /**
   * 把解析后的选项还原为调用方选项，用于按原样重跑。
   *
   * @returns 可直接传给 `find()` 的选项。
   */
  private toFindOptions(): FindOptions {
    return {
      caseSensitive: this.options.caseSensitive,
      wholeWord: this.options.wholeWord,
      highlightAll: this.options.highlightAll,
      fromCurrentPage: this.options.fromCurrentPage,
    };
  }

  /**
   * 读取指定页的图层过滤。
   *
   * @param pageNumber 页码，1-based。
   * @returns 过滤配置；宿主未实现或全画时为 undefined。
   */
  private filterFor(pageNumber: number): PageContentFilter | undefined {
    return this.host.getPageContentFilter
      ? this.host.getPageContentFilter(pageNumber)
      : undefined;
  }

  /**
   * 读取指定页的过滤签名。
   *
   * @param pageNumber 页码，1-based。
   * @returns 签名；宿主未实现时为 `'all'`。
   */
  private filterKeyFor(pageNumber: number): string {
    return this.host.getLayerFilterKey ? this.host.getLayerFilterKey(pageNumber) : 'all';
  }

  /**
   * 开始查找；返回的 Promise 在搜索完成或被取消后 resolve。
   *
   * @param query 查询文本。
   * @param options 大小写/全词/高亮全部/起始页。
   * @throws {OFDViewerError} `features.find=false` 时抛 `OFD_FEATURE_DISABLED`。
   */
  async find(query: string, options: FindOptions = {}): Promise<void> {
    this.assertFeature();
    const normalized = normalizeQuery(query);
    if (normalized.length === 0) {
      this.clearFind();
      return;
    }
    const resolved: ResolvedFindOptions = {
      caseSensitive: options.caseSensitive ?? false,
      wholeWord: options.wholeWord ?? false,
      highlightAll: options.highlightAll ?? true,
      fromCurrentPage: options.fromCurrentPage ?? true,
    };
    this.cancelSearch();
    this.generation += 1;
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.rawQuery = query;
    this.query = normalized;
    this.options = resolved;
    this.matches = [];
    this.current = 0;
    this.searching = true;
    this.truncated = false;
    this.emptyPageCount = 0;
    this.highlights.clearFindHighlights();
    this.bridge.emit('findstart', { query: normalized, total: 0, current: 0 });
    this.publishState(true);
    const run = this.runSearch(generation, abort.signal);
    this.searchPromise = run;
    return run;
  }

  /** 下一个匹配；循环到首个。 */
  findNext(): void {
    this.assertFeature();
    if (this.matches.length === 0) return;
    this.current = this.current >= this.matches.length ? 1 : this.current + 1;
    this.activateCurrent();
  }

  /** 上一个匹配；循环到末个。 */
  findPrevious(): void {
    this.assertFeature();
    if (this.matches.length === 0) return;
    this.current = this.current <= 1 ? this.matches.length : this.current - 1;
    this.activateCurrent();
  }

  /** 清除查找与高亮。 */
  clearFind(): void {
    this.cancelSearch();
    this.generation += 1;
    this.query = '';
    this.matches = [];
    this.current = 0;
    this.searching = false;
    this.truncated = false;
    this.emptyPageCount = 0;
    this.highlights.clearFindHighlights();
    this.bridge.patchFindState({
      query: '',
      current: 0,
      total: 0,
      searching: false,
    });
    this.bridge.emit('findmatches', { query: '', total: 0, current: 0 });
  }

  /** 当前查找状态快照。 */
  getFindState(): FindState {
    return {
      query: this.query,
      current: this.current,
      total: this.matches.length,
      searching: this.searching,
      caseSensitive: this.options.caseSensitive,
      wholeWord: this.options.wholeWord,
      highlightAll: this.options.highlightAll,
    };
  }

  /** 当前命中列表；只读快照，供测试/诊断。 */
  getMatches(): readonly FindMatch[] {
    return this.matches;
  }

  /** 等待进行中的搜索结束；无搜索时立即 resolve。 */
  async waitForSearch(): Promise<void> {
    if (this.searchPromise) await this.searchPromise;
  }

  /** 销毁控制器并中止搜索。 */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSearch();
    this.generation += 1;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.highlights.clearFindHighlights();
    this.cache.clear();
    this.cacheKeys.clear();
  }

  // -------------------------------------------------------------------------
  // 内部：搜索
  // -------------------------------------------------------------------------

  /** 分片搜索主循环。 */
  private async runSearch(generation: number, signal: AbortSignal): Promise<void> {
    const order = this.pageOrder();
    let sliceStart = this.now();
    let processed = 0;
    try {
      for (let index = 0; index < order.length; index += 1) {
        if (this.isStale(generation, signal)) return;
        await this.searchPage(order[index]!, generation, signal);
        if (this.isStale(generation, signal)) return;
        if (this.truncated) break;
        processed += 1;
        if (
          processed >= this.pagesPerSlice ||
          (this.sliceBudgetMs > 0 && this.now() - sliceStart >= this.sliceBudgetMs)
        ) {
          this.publishProgress();
          await this.yieldSlice();
          sliceStart = this.now();
          processed = 0;
        }
      }
      if (this.isStale(generation, signal)) return;
      this.finishSearch(generation);
    } catch (error) {
      if (this.isStale(generation, signal) || isAbortError(error)) return;
      this.searching = false;
      this.publishState(false);
      this.bridge.warn(
        UI_WARNING_CODES.W_FIND_FAILED,
        `查找失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 处理单页；命中直接写入 this.matches。 */
  private async searchPage(
    pageNumber: number,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const filterKey = this.filterKeyFor(pageNumber);
    let source = this.cacheKeys.get(pageNumber) === filterKey
      ? this.cache.get(pageNumber)
      : undefined;
    if (!source) {
      this.cache.delete(pageNumber);
      this.cacheKeys.delete(pageNumber);
      let content: TextContent;
      try {
        const page = await this.host.getPage(pageNumber);
        if (this.isStale(generation, signal)) return;
        if (typeof page.getTextContent !== 'function') {
          this.bridge.warn(UI_WARNING_CODES.W_TEXT_UNSUPPORTED, '当前引擎页面不支持文本提取', pageNumber - 1);
          return;
        }
        content = await page.getTextContent(
          textContentOptions(signal, this.filterFor(pageNumber)),
        );
      } catch (error) {
        if (this.isStale(generation, signal) || isAbortError(error)) return;
        this.bridge.warn(
          UI_WARNING_CODES.W_FIND_PAGE,
          `第 ${pageNumber} 页文本提取失败：${error instanceof Error ? error.message : String(error)}`,
          pageNumber - 1,
        );
        return;
      }
      if (this.isStale(generation, signal)) return;
      source = createPageSearchSource(content, pageNumber);
      this.remember(pageNumber, source, this.filterKeyFor(pageNumber));
    }
    if (source.text.length === 0) {
      this.emptyPageCount += 1;
      return;
    }

    const ranges = findPageMatches(source, this.query, {
      caseSensitive: this.options.caseSensitive,
      wholeWord: this.options.wholeWord,
      maxMatches: this.maxPageMatches,
    });
    if (this.maxPageMatches > 0 && ranges.length >= this.maxPageMatches) {
      this.bridge.warn(
        UI_WARNING_CODES.W_FIND_PAGE_LIMIT,
        `第 ${pageNumber} 页命中超过 ${this.maxPageMatches} 条，已截断`,
        pageNumber - 1,
      );
    }
    const firstNewIndex = this.matches.length;
    for (const range of ranges) {
      const match: FindMatch = {
        id: `${pageNumber}:${this.matches.length}`,
        pageNumber,
        start: range.start,
        end: range.end,
        text: range.text,
        boxes: highlightBoxesForRange(source, range.start, range.end),
      };
      this.matches.push(match);
      if (this.maxTotalMatches > 0 && this.matches.length >= this.maxTotalMatches) {
        this.truncated = true;
        this.bridge.warn(
          UI_WARNING_CODES.W_FIND_LIMIT,
          `查找命中超过 ${this.maxTotalMatches} 条，已停止继续搜索`,
        );
        break;
      }
    }
    // 首个命中立即高亮并滚动，长文档无需等全篇搜索结束。
    if (firstNewIndex === 0 && this.matches.length > 0 && this.current === 0) {
      this.current = 1;
      this.highlights.setFindMatches(this.matches, this.current, this.options.highlightAll);
      this.scrollToCurrent();
    }
  }

  /** 搜索结束：发布最终计数并同步当前项。 */
  private finishSearch(generation: number): void {
    if (generation !== this.generation) return;
    this.searching = false;
    this.searchPromise = null;
    if (this.matches.length > 0 && this.current === 0) this.current = 1;
    this.publishState(false);
    this.bridge.emit('findmatches', {
      query: this.query,
      total: this.matches.length,
      current: this.current,
    });
    if (this.current > 0) {
      this.highlights.setFindMatches(this.matches, this.current, this.options.highlightAll);
      this.emitCurrent();
      this.scrollToCurrent();
      return;
    }
    if (this.emptyPageCount > 0) {
      this.bridge.warn(UI_WARNING_CODES.W_TEXT_EMPTY, '该文档没有可提取文字');
    }
  }

  /** 切换当前命中并滚动。 */
  private activateCurrent(): void {
    this.highlights.setFindMatches(this.matches, this.current, this.options.highlightAll);
    this.publishState(false);
    this.emitCurrent();
    this.scrollToCurrent();
  }

  /** 发出当前命中事件。 */
  private emitCurrent(): void {
    this.bridge.emit('findcurrent', {
      query: this.query,
      total: this.matches.length,
      current: this.current,
    });
  }

  /** 滚动到当前命中。 */
  private scrollToCurrent(): void {
    const match = this.current > 0 ? this.matches[this.current - 1] : undefined;
    if (match) this.highlights.scrollToMatch(match);
  }

  /** 发布搜索中进度（每个时间片一次）。 */
  private publishProgress(): void {
    this.publishState(true);
    this.bridge.emit('findmatches', {
      query: this.query,
      total: this.matches.length,
      current: this.current,
    });
  }

  /** 写入核心查找状态。 */
  private publishState(searching: boolean): void {
    this.bridge.patchFindState({
      query: this.query,
      current: this.current,
      total: this.matches.length,
      searching,
      caseSensitive: this.options.caseSensitive,
      wholeWord: this.options.wholeWord,
      highlightAll: this.options.highlightAll,
    });
  }

  /** 计算搜索页顺序：默认当前页 → 文末，再从文首 → 当前页前一页。 */
  private pageOrder(): number[] {
    const count = this.host.getPageCount();
    if (count <= 0) return [];
    const current = Math.min(count, Math.max(1, this.host.getPageNumber()));
    const order: number[] = [];
    if (!this.options.fromCurrentPage) {
      for (let page = 1; page <= count; page += 1) order.push(page);
      return order;
    }
    for (let page = current; page <= count; page += 1) order.push(page);
    for (let page = 1; page < current; page += 1) order.push(page);
    return order;
  }

  /** 让出主线程，等待下一个空闲/宏任务。 */
  private yieldSlice(): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        this.scheduler.request(resolve);
      } catch {
        resolve();
      }
    });
  }

  /**
   * 写入单页缓存并做 LRU 淘汰。
   *
   * @param pageNumber 页码，1-based。
   * @param source 文本索引。
   * @param filterKey 生成该索引时的过滤签名。
   */
  private remember(pageNumber: number, source: PageSearchSource, filterKey: string): void {
    this.cache.delete(pageNumber);
    this.cache.set(pageNumber, source);
    this.cacheKeys.set(pageNumber, filterKey);
    while (this.cache.size > this.maxCachedPages) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.cacheKeys.delete(oldest);
    }
  }

  /** 判断任务是否已过期（代次/取消/销毁）。 */
  private isStale(generation: number, signal: AbortSignal): boolean {
    return this.disposed || signal.aborted || generation !== this.generation;
  }

  /** 中止进行中的搜索。 */
  private cancelSearch(): void {
    this.abort?.abort();
    this.abort = null;
    this.searchPromise = null;
  }

  /** 文档切换/关闭时重置，不向核心发事件（核心自行重置状态）。 */
  private resetForDocument(): void {
    this.cancelSearch();
    this.generation += 1;
    this.query = '';
    this.matches = [];
    this.current = 0;
    this.searching = false;
    this.truncated = false;
    this.emptyPageCount = 0;
    this.rawQuery = '';
    this.cache.clear();
    this.cacheKeys.clear();
    this.highlights.clearFindHighlights();
  }

  /** 断言查找可用。 */
  private assertFeature(): void {
    if (!this.host.isFeatureEnabled('find')) {
      throw createFeatureDisabledError('find');
    }
  }
}

/** 判断是否取消错误。 */
function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'OFD_ABORTED';
}
