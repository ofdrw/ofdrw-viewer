/**
 * 大纲树（设计方案 §8）。
 *
 * 保持引擎返回的 XML 层级与顺序，默认展开第一层；支持展开/收起、方向键导航、
 * 当前页高亮与跳转。无效 `dest` 只报警并保留节点。
 */

import type { OutlineNode } from '@ofdrw/ofdrw-viewer-engine';
import type { Translator } from '../i18n';
import type { ViewerState } from '../state';
import {
  createEmptyState,
  ensureNavigationStyle,
  goToDestination,
  isJumpableDestination,
  reportNavigationWarning,
  type NavigationViewer,
} from './shared';

/** 大纲条目。 */
interface OutlineEntry {
  readonly node: OutlineNode;
  readonly element: HTMLLIElement;
  readonly row: HTMLElement;
  readonly titleButton: HTMLButtonElement;
  readonly toggleButton: HTMLButtonElement;
  readonly group: HTMLUListElement | null;
  readonly parent: OutlineEntry | null;
  expanded: boolean;
  readonly pageIndex: number | undefined;
}

/** 大纲视图选项。 */
export interface OutlineViewOptions {
  /** 阅读器。 */
  readonly viewer: NavigationViewer;
  /** 面板容器。 */
  readonly host: HTMLElement;
  /** 读取当前翻译器。 */
  readonly getTranslator: () => Translator;
}

/** 大纲树。 */
export class OutlineView {
  private readonly viewer: NavigationViewer;
  private readonly host: HTMLElement;
  private readonly getTranslator: () => Translator;
  private readonly root: HTMLUListElement;
  private readonly offs: Array<() => void> = [];
  private entries: OutlineEntry[] = [];
  private lastOutline: readonly OutlineNode[] | undefined;
  private lastLocale = '';
  private lastEnabled = true;
  private currentPageIndex = 0;
  private active = false;
  private destroyed = false;

  /**
   * @param options 阅读器与面板容器。
   */
  constructor(options: OutlineViewOptions) {
    this.viewer = options.viewer;
    this.host = options.host;
    this.getTranslator = options.getTranslator;
    ensureNavigationStyle(this.host.ownerDocument);
    this.root = this.host.ownerDocument.createElement('ul');
    this.root.className = 'ofd-outline__tree';
    this.root.setAttribute('role', 'tree');
    this.host.replaceChildren(this.root);
    this.active = this.viewer.getSidebarView() === 'outline';
    const state = this.viewer.getState();
    this.lastOutline = state.document.outline;
    this.lastLocale = state.ui.locale;
    this.lastEnabled = state.ui.features.outline.enabled;
    this.currentPageIndex = state.view.pageNumber - 1;
    this.offs.push(this.viewer.on('statechange', (next) => this.handleStateChange(next)));
    this.render();
  }

  /** 当前高亮节点标题；无高亮时为 null。 */
  getCurrentTitle(): string | null {
    const entry = this.entries.find(
      (candidate) => candidate.row.getAttribute('aria-current') === 'true',
    );
    return entry?.node.title ?? null;
  }

  /** 释放监听与 DOM。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.entries = [];
    this.root.remove();
  }

  /** 处理状态变化：数据/语言/页码/侧栏。 */
  private handleStateChange(state: ViewerState): void {
    if (this.destroyed) return;
    const outline = state.document.outline;
    const localeChanged = state.ui.locale !== this.lastLocale;
    const enabled = state.ui.features.outline.enabled;
    if (outline !== this.lastOutline || localeChanged || enabled !== this.lastEnabled) {
      this.lastOutline = outline;
      this.lastLocale = state.ui.locale;
      this.lastEnabled = enabled;
      this.render();
      return;
    }
    this.active = state.view.sidebarView === 'outline';
    if (state.view.pageNumber - 1 !== this.currentPageIndex) {
      this.currentPageIndex = state.view.pageNumber - 1;
      this.updateCurrent();
    }
  }

  /** 重建树或空态。 */
  private render(): void {
    if (this.destroyed) return;
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    this.root.setAttribute('aria-label', translator.t('sidebar.outline'));
    this.entries = [];
    this.root.replaceChildren();

    const state = this.viewer.getState();
    this.currentPageIndex = state.view.pageNumber - 1;
    this.active = state.view.sidebarView === 'outline';

    if (!this.viewer.isFeatureEnabled('outline')) {
      this.root.append(createEmptyState(doc, translator.t('feature.reason.host')));
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    const engineDocument = this.viewer.getDocument();
    if (!engineDocument) {
      this.root.append(createEmptyState(doc, translator.t('sidebar.noOutline')));
      return;
    }
    if (typeof engineDocument.getOutline !== 'function') {
      this.root.append(createEmptyState(doc, translator.t('feature.reason.unsupported'), true));
      return;
    }
    const outline = state.document.outline;
    if (!outline || outline.length === 0) {
      this.root.append(createEmptyState(doc, translator.t('sidebar.noOutline')));
      return;
    }
    const pageCount = state.document.pageCount;
    for (const node of outline) this.appendNode(node, null, this.root, 0, pageCount);
    this.updateCurrent();
  }

  /**
   * 递归追加节点。
   *
   * @param node 大纲节点。
   * @param parent 父条目。
   * @param container 父容器。
   * @param depth 层级，0 开始。
   * @param pageCount 总页数。
   */
  private appendNode(
    node: OutlineNode,
    parent: OutlineEntry | null,
    container: HTMLUListElement,
    depth: number,
    pageCount: number,
  ): void {
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    const element = doc.createElement('li');
    element.setAttribute('role', 'treeitem');
    element.setAttribute('aria-level', String(depth + 1));

    const hasChildren = node.children.length > 0;
    const expanded = hasChildren ? (node.expanded ?? depth === 0) : false;
    element.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    const row = doc.createElement('div');
    row.className = 'ofd-outline__item';

    const toggleButton = doc.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'ofd-outline__toggle';
    toggleButton.tabIndex = -1;
    toggleButton.dataset.empty = hasChildren ? 'false' : 'true';
    toggleButton.setAttribute('aria-hidden', 'true');
    toggleButton.textContent = expanded ? '▾' : '▸';

    const titleButton = doc.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'ofd-outline__title';
    titleButton.textContent = node.title || translator.t('sidebar.outline');

    const pageIndex = node.dest?.pageIndex;
    const jumpable = isJumpableDestination(node.dest, pageCount);
    if (!jumpable) {
      row.dataset.destInvalid = 'true';
      titleButton.setAttribute('aria-disabled', 'true');
      titleButton.title = translator.t('feature.reason.unsupported');
    }
    row.append(toggleButton, titleButton);
    element.append(row);

    let group: HTMLUListElement | null = null;
    if (hasChildren) {
      group = doc.createElement('ul');
      group.className = 'ofd-outline__children';
      group.setAttribute('role', 'group');
      group.hidden = !expanded;
      element.append(group);
    }

    const entry: OutlineEntry = {
      node,
      element,
      row,
      titleButton,
      toggleButton,
      group,
      parent,
      expanded,
      pageIndex,
    };
    this.entries.push(entry);

    toggleButton.addEventListener('click', () => this.toggle(entry));
    titleButton.addEventListener('click', () => this.activate(entry));
    titleButton.addEventListener('keydown', (event) => this.handleKeydown(event, entry));

    if (group) {
      for (const child of node.children) {
        this.appendNode(child, entry, group, depth + 1, pageCount);
      }
    }
    container.append(element);
  }

  /** 展开/收起节点。 */
  private toggle(entry: OutlineEntry): void {
    if (!entry.group) return;
    entry.expanded = !entry.expanded;
    entry.group.hidden = !entry.expanded;
    entry.element.setAttribute('aria-expanded', entry.expanded ? 'true' : 'false');
    entry.toggleButton.textContent = entry.expanded ? '▾' : '▸';
  }

  /** 点击标题：按 dest 跳转；无效时告警。 */
  private activate(entry: OutlineEntry): void {
    if (!entry.node.dest) {
      reportNavigationWarning(
        this.viewer,
        'W_NAV_DEST',
        `大纲“${entry.node.title}”缺少跳转目标`,
      );
      return;
    }
    if (goToDestination(this.viewer, entry.node.dest)) {
      this.currentPageIndex = this.viewer.getPageNumber() - 1;
      this.updateCurrent();
    }
  }

  /** 树形方向键：展开/收起/移动/跳转。 */
  private handleKeydown(event: KeyboardEvent, entry: OutlineEntry): void {
    const visible = this.visibleEntries();
    const index = visible.indexOf(entry);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        visible[Math.min(visible.length - 1, index + 1)]?.titleButton.focus();
        return;
      case 'ArrowUp':
        event.preventDefault();
        visible[Math.max(0, index - 1)]?.titleButton.focus();
        return;
      case 'Home':
        event.preventDefault();
        visible[0]?.titleButton.focus();
        return;
      case 'End':
        event.preventDefault();
        visible[visible.length - 1]?.titleButton.focus();
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (entry.group && !entry.expanded) {
          this.toggle(entry);
          return;
        }
        if (entry.group && entry.expanded) {
          visible[index + 1]?.titleButton.focus();
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (entry.group && entry.expanded) {
          this.toggle(entry);
          return;
        }
        entry.parent?.titleButton.focus();
        return;
      default:
    }
  }

  /** 当前可见（祖先均展开）的条目。 */
  private visibleEntries(): OutlineEntry[] {
    return this.entries.filter((entry) => {
      let parent = entry.parent;
      while (parent) {
        if (!parent.expanded) return false;
        parent = parent.parent;
      }
      return true;
    });
  }

  /** 当前页高亮：取 pageIndex ≤ 当前页的最后一个匹配。 */
  private updateCurrent(): void {
    let current: OutlineEntry | undefined;
    for (const entry of this.entries) {
      if (entry.pageIndex !== undefined && entry.pageIndex <= this.currentPageIndex) {
        current = entry;
      }
    }
    for (const entry of this.entries) {
      if (entry === current) {
        entry.row.setAttribute('aria-current', 'true');
        entry.titleButton.setAttribute('aria-current', 'true');
      } else {
        entry.row.removeAttribute('aria-current');
        entry.titleButton.removeAttribute('aria-current');
      }
    }
    if (!current || !this.active) return;
    if (typeof current.titleButton.scrollIntoView === 'function') {
      current.titleButton.scrollIntoView({ block: 'nearest' });
    }
  }
}