/**
 * 书签列表（设计方案 §8）。
 *
 * 扁平列表，按引擎返回的 XML 顺序渲染；点击按 `DocumentDestination` 跳转，
 * 当前页对应条目高亮。无效 `dest` 只报警并保留条目。
 */

import { replaceChildren } from '../compat';

import type { BookmarkItem } from '@ofdrw/ofdrw-viewer-engine';
import type { Translator } from '../i18n';
import type { ViewerState } from '../state';
import {
  createEmptyState,
  ensureNavigationStyle,
  formatPageLabel,
  goToDestination,
  isJumpableDestination,
  reportNavigationWarning,
  type NavigationViewer,
} from './shared';
import { UI_WARNING_CODES } from '../diagnostics';

/** 书签条目。 */
interface BookmarkEntry {
  readonly item: BookmarkItem;
  readonly element: HTMLButtonElement;
  readonly pageIndex: number | undefined;
}

/** 书签视图选项。 */
export interface BookmarkViewOptions {
  /** 阅读器。 */
  readonly viewer: NavigationViewer;
  /** 面板容器。 */
  readonly host: HTMLElement;
  /** 读取当前翻译器。 */
  readonly getTranslator: () => Translator;
}

/** 书签列表。 */
export class BookmarkView {
  private readonly viewer: NavigationViewer;
  private readonly host: HTMLElement;
  private readonly getTranslator: () => Translator;
  private readonly root: HTMLUListElement;
  private readonly offs: Array<() => void> = [];
  private entries: BookmarkEntry[] = [];
  private lastBookmarks: readonly BookmarkItem[] | undefined;
  private lastLocale = '';
  private lastEnabled = true;
  private currentPageIndex = 0;
  private active = false;
  private destroyed = false;

  /**
   * @param options 阅读器与面板容器。
   */
  constructor(options: BookmarkViewOptions) {
    this.viewer = options.viewer;
    this.host = options.host;
    this.getTranslator = options.getTranslator;
    ensureNavigationStyle(this.host.ownerDocument);
    this.root = this.host.ownerDocument.createElement('ul');
    this.root.className = 'ofd-bookmarks';
    this.root.setAttribute('role', 'list');
    replaceChildren(this.host, this.root);
    this.active = this.viewer.getSidebarView() === 'bookmarks';
    const state = this.viewer.getState();
    this.lastBookmarks = state.document.bookmarks;
    this.lastLocale = state.ui.locale;
    this.lastEnabled = state.ui.features.bookmarks.enabled;
    this.currentPageIndex = state.view.pageNumber - 1;
    this.offs.push(this.viewer.on('statechange', (next) => this.handleStateChange(next)));
    this.render();
  }

  /** 当前高亮书签名称；无高亮时为 null。 */
  getCurrentName(): string | null {
    const entry = this.entries.find(
      (candidate) => candidate.element.getAttribute('aria-current') === 'true',
    );
    return entry?.item.name ?? null;
  }

  /** 释放监听与 DOM。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.entries = [];
    this.root.remove();
  }

  /** 处理状态变化：数据/语言/功能/页码/侧栏。 */
  private handleStateChange(state: ViewerState): void {
    if (this.destroyed) return;
    const bookmarks = state.document.bookmarks;
    const localeChanged = state.ui.locale !== this.lastLocale;
    const enabled = state.ui.features.bookmarks.enabled;
    if (bookmarks !== this.lastBookmarks || localeChanged || enabled !== this.lastEnabled) {
      this.lastBookmarks = bookmarks;
      this.lastLocale = state.ui.locale;
      this.lastEnabled = enabled;
      this.render();
      return;
    }
    this.active = state.view.sidebarView === 'bookmarks';
    if (state.view.pageNumber - 1 !== this.currentPageIndex) {
      this.currentPageIndex = state.view.pageNumber - 1;
      this.updateCurrent();
    }
  }

  /** 重建列表或空态。 */
  private render(): void {
    if (this.destroyed) return;
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    this.root.setAttribute('aria-label', translator.t('sidebar.bookmarks'));
    this.entries = [];
    replaceChildren(this.root);

    const state = this.viewer.getState();
    this.currentPageIndex = state.view.pageNumber - 1;
    this.active = state.view.sidebarView === 'bookmarks';
    this.root.hidden = false;

    if (!this.viewer.isFeatureEnabled('bookmarks')) {
      this.root.append(createEmptyState(doc, translator.t('feature.reason.host')));
      this.root.hidden = true;
      return;
    }
    const engineDocument = this.viewer.getDocument();
    if (!engineDocument) {
      this.root.append(createEmptyState(doc, translator.t('sidebar.noBookmarks')));
      return;
    }
    if (typeof engineDocument.getBookmarks !== 'function') {
      this.root.append(createEmptyState(doc, translator.t('feature.reason.unsupported'), true));
      return;
    }
    const bookmarks = state.document.bookmarks;
    if (!bookmarks || bookmarks.length === 0) {
      this.root.append(createEmptyState(doc, translator.t('sidebar.noBookmarks')));
      return;
    }
    const pageCount = state.document.pageCount;
    for (const item of bookmarks) {
      const listItem = doc.createElement('li');
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = 'ofd-bookmark';
      const jumpable = isJumpableDestination(item.dest, pageCount);
      if (!jumpable) {
        element.dataset.destInvalid = 'true';
        element.setAttribute('aria-disabled', 'true');
      }
      const name = doc.createElement('span');
      name.className = 'ofd-bookmark__name';
      name.textContent = item.name;
      element.append(name);
      if (item.dest && item.dest.pageIndex >= 0 && item.dest.pageIndex < pageCount) {
        const page = doc.createElement('span');
        page.className = 'ofd-bookmark__page';
        page.textContent = formatPageLabel(translator, item.dest.pageIndex + 1, pageCount);
        element.append(page);
        element.setAttribute(
          'aria-label',
          `${item.name}，${formatPageLabel(translator, item.dest.pageIndex + 1, pageCount)}`,
        );
      } else {
        element.setAttribute('aria-label', item.name);
      }
      element.addEventListener('click', () => this.activate(item));
      const entry: BookmarkEntry = {
        item,
        element,
        pageIndex: item.dest?.pageIndex,
      };
      this.entries.push(entry);
      listItem.append(element);
      this.root.append(listItem);
    }
    this.updateCurrent();
  }

  /** 点击书签跳转。 */
  private activate(item: BookmarkItem): void {
    if (!item.dest) {
      reportNavigationWarning(
        this.viewer,
        UI_WARNING_CODES.W_NAV_DEST,
        `书签“${item.name}”缺少跳转目标`,
      );
      return;
    }
    if (goToDestination(this.viewer, item.dest)) {
      this.currentPageIndex = this.viewer.getPageNumber() - 1;
      this.updateCurrent();
    }
  }

  /** 当前页高亮：取 pageIndex ≤ 当前页的最后一个匹配。 */
  private updateCurrent(): void {
    let current: BookmarkEntry | undefined;
    for (const entry of this.entries) {
      if (entry.pageIndex !== undefined && entry.pageIndex <= this.currentPageIndex) {
        current = entry;
      }
    }
    for (const entry of this.entries) {
      if (entry === current) entry.element.setAttribute('aria-current', 'true');
      else entry.element.removeAttribute('aria-current');
    }
    if (!current || !this.active) return;
    if (typeof current.element.scrollIntoView === 'function') {
      current.element.scrollIntoView({ block: 'nearest' });
    }
  }
}