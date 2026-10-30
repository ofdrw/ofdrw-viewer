/**
 * “图层”侧栏面板（设计方案 §E）。
 *
 * 依赖注入：只通过 `LayerPanelHost` 读写宿主状态，不 import `viewer.ts`，测试可注入
 * 假宿主。面板本身不直接改引擎调用点，勾选变化统一交给宿主的 `setPageLayer()` /
 * `setLayerForAllPages()` 等方法，由宿主完成快照与重绘。
 *
 * 构建策略：总项行与每页行一次建好（轻量行只有展开箭头与文字），六项子项（复选框 +
 * `role=group`）在某行首次展开时按需生成；当前页自动展开。
 *
 * 注释类型组只存在于每页行（页内“注释”子行展开后出现），总项只保留六项总开关，
 * 不做跨页类型三态（用户决定，§I.5 修订）。
 */

import type { Translator } from '../i18n';
import type { PageLayerState, ViewerState } from '../state';
import {
  PAGE_LAYER_KEYS,
  annotationTypesForGroup,
  readAnnotationType,
  selectedAnnotationTypes,
  type AnnotationTypeKey,
  type LayerKey,
  type LayerSummary,
  type ResolvedLayerVisibility,
} from './content-filter';

export type {
  AnnotationTypeKey,
  LayerKey,
  LayerAnnotationVisibility,
  LayerSummary,
  LayerVisibility,
  ResolvedLayerVisibility,
} from './content-filter';
import { createIcon } from '../ui/icons';

/** 子项组标识：总项（`'all'`，只有六项）或页索引（0-based，可再展开注释类型组）。 */
export type GroupId = 'all' | number;

/** 图层面板依赖的宿主能力；`OFDViewer` 结构兼容，测试可注入假宿主。 */
export interface LayerPanelHost {
  /** 读取最新状态（页数、当前页与语言）。 */
  getState(): ViewerState;
  /** 读取“全部页面”总项状态（全部显示 / 全部隐藏 / 混合）。 */
  readAllState(): LayerSummary;
  /** 读取某页六项可见性（页索引 0-based；`annotations` 为 `{ enabled, types }`）。 */
  readPageState(pageIndex: number): ResolvedLayerVisibility;
  /** 设置某页一项（六项复选框使用）。 */
  setPageLayer(pageIndex: number, key: LayerKey, value: boolean): void;
  /** 批量：把所有页的某项设为 value（总项子项使用）。 */
  setLayerForAllPages(key: LayerKey, value: boolean): void;
  /** 批量：所有页六项一起显示（true）/ 隐藏（false）（总项自身复选框使用）。 */
  setAllLayersVisible(visible: boolean): void;
  /** 单页：把该页六项一起显示（true）/ 隐藏（false）（页面行复选框使用）。 */
  setAllLayersVisibleForPage(pageIndex: number, visible: boolean): void;
  /** 恢复默认可见性，保持树的展开状态。 */
  resetLayerVisibility(): void;
  /** 订阅状态变化；返回退订函数。 */
  onStateChange(handler: (state: ViewerState) => void): () => void;
  /** 是否被宿主禁用；禁用时不响应任何交互。 */
  isDisabled(): boolean;
  /** 禁用原因文案。 */
  getDisabledReason(): string;
  /** 读取当前翻译器（语言切换后可取到新实例）。 */
  getTranslator(): Translator;
  /** 读取六项之一的界面名称（i18n 只在宿主侧解析）。 */
  getLayerLabel(key: LayerKey): string;
  /** 读取注释类型的显示名：常见五类本地化，追加类型返回引擎原值（§I.6）。 */
  getAnnotationTypeLabel(type: AnnotationTypeKey): string;
  /** 读取某页应列出的注释类型：常见五类 + 该页追加类型（§I.1）。 */
  readAnnotationTypes(pageIndex: number): readonly AnnotationTypeKey[];
  /** 该页“实际出现过”的类型集合，用于淡色区分（§I.7）。 */
  readAnnotationTypesInUse(pageIndex: number): ReadonlySet<string>;
  /** 写入某页某注释类型的勾选（`types[type] = value`）。 */
  setAnnotationTypeForPage(pageIndex: number, type: AnnotationTypeKey, value: boolean): void;
}

/** 面板选项。 */
export interface LayerPanelOptions {
  /** 面板容器（`Sidebar` 提供的 `.ofd-sidebar__panel`）。 */
  readonly host: HTMLElement;
  /** 宿主能力。 */
  readonly viewer: LayerPanelHost;
}

/** 复选框三态。 */
type CheckboxState = 'on' | 'off' | 'mixed';

/** 一行树节点（总项或页面行）。 */
interface RowView {
  /** 行元素（`role=treeitem`）。 */
  readonly row: HTMLElement;
  /** 展开箭头。 */
  readonly twisty: HTMLElement;
  /** 行名称。 */
  readonly label: HTMLSpanElement;
  /** 行复选框：总项为“全部显示/隐藏”，页面行为该页六项总开关。 */
  readonly box: HTMLInputElement;
  /** 子项容器；首次展开时创建。 */
  readonly group: HTMLElement;
  /** 子项行；首次展开时创建。 */
  readonly children: readonly HTMLElement[];
  /** 子项复选框。 */
  readonly boxes: readonly HTMLInputElement[];
}

/**
 * 写入复选框状态；三态统一入口，调用点不得直接写 checked/indeterminate。
 *
 * @param box 复选框。
 * @param state 'on' | 'off' | 'mixed'。
 */
function setCheckboxState(box: HTMLInputElement, state: CheckboxState): void {
  box.indeterminate = state === 'mixed';
  box.checked = state === 'on';
  // 原生 checkbox 的隐式 aria-checked 会随 checked 变化；显式写回避免读屏缓存。
  box.setAttribute('aria-checked', state === 'mixed' ? 'mixed' : state === 'on' ? 'true' : 'false');
}

/**
 * 由点击前的三态反推点击后的目标值。
 *
 * @param state 点击前的三态。
 * @returns 目标值：`on` 变 false，其余变 true。
 */
function nextChecked(state: CheckboxState): boolean {
  return state !== 'on';
}

/** 图层面板。 */
export class LayerPanel {
  private readonly host: HTMLElement;
  private readonly viewer: LayerPanelHost;
  private root: HTMLElement | null = null;
  private tree: HTMLElement | null = null;
  private title: HTMLElement | null = null;
  private notice: HTMLElement | null = null;
  private restoreButton: HTMLButtonElement | null = null;
  private body: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  /** 当前已构建的页数与行列表。 */
  private rows: RowView[] = [];
  private allRow: RowView | null = null;
  private builtPageCount = -1;
  /** 每行子项是否已生成。 */
  private readonly groups = new Map<GroupId, RowView>();
  /** 注释类型组的行元素（页索引 → 类型行）；只有页面行扩展开过才存在。 */
  private readonly typeGroups = new Map<number, HTMLElement[]>();
  /** 各页类型组最近一次构建时列出的类型签名，用于探测补齐后重建。 */
  private readonly typeSignatures = new Map<number, string>();
  /** 已展开的页面注释类型组（`A:<页索引>`），用于 `update()` 后恢复展开态。 */
  private readonly expandedGroups = new Set<string>();
  /** 复选框 → 最近一次渲染的三态（点击前状态缓存）。 */
  private readonly checkedStates = new WeakMap<HTMLInputElement, CheckboxState>();
  /** 上次自动展开的当前页索引（0-based）。 */
  private lastCurrentPage = -1;
  /** 最近聚焦的可见行；`update()` 后若仍存在则恢复 roving tabindex。 */
  private focusedRow: HTMLElement | null = null;
  /** 上次刷新三态时的图层快照；同一引用表示可见性没有变化，可跳过全量刷新。 */
  private lastLayersState: PageLayerState | null = null;
  /** 上次刷新文案时的语言；文案（含页标题）只随语言、页数与文档状态变化。 */
  private lastLocale: string | null = null;
  /** 上次刷新文案时的文档状态。 */
  private lastDocStatus: string | null = null;
  /** 上次写入 `aria-current` 的页索引（0-based，-1 表示无）。 */
  private lastAriaCurrent = -1;
  /** 上次刷新三态时的禁用态；变化时必须重画复选框。 */
  private lastDisabled = false;
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;
  /** 语言切换时的临时翻译器；未设置时读取宿主翻译器。 */
  private translatorOverride: Translator | null = null;

  /**
   * 创建面板并立即渲染。
   *
   * @param options 面板容器与宿主能力。
   */
  constructor(options: LayerPanelOptions) {
    this.host = options.host;
    this.viewer = options.viewer;
    this.build();
    this.unsubscribe = this.viewer.onStateChange((state) => this.update(state));
    this.update(this.viewer.getState());
  }

  /**
   * 状态变化后调用：刷新三态、页数变化时重建列表。
   *
   * @param state 最新状态快照。
   */
  update(state: ViewerState): void {
    if (this.destroyed) return;
    const pageCount = state.document.pageCount;
    const rebuilt = pageCount !== this.builtPageCount;
    if (rebuilt) {
      this.buildList(pageCount);
      this.builtPageCount = pageCount;
      this.lastCurrentPage = -1;
      this.lastLayersState = null;
      this.lastLocale = null;
      this.lastAriaCurrent = -1;
    }
    this.layout();
    // 文案只随语言、页数、文档状态变化；滚动/翻页时不必逐页重写，避免大文档每帧 O(页数)。
    if (
      rebuilt ||
      state.ui.locale !== this.lastLocale ||
      state.document.status !== this.lastDocStatus
    ) {
      this.refreshTexts();
      this.lastLocale = state.ui.locale;
      this.lastDocStatus = state.document.status;
    }
    this.syncDisabled();
    if (!this.allRow) return;
    const current = state.view.pageNumber - 1;
    if (current !== this.lastAriaCurrent) {
      const previous = this.rows[this.lastAriaCurrent];
      if (previous) previous.row.removeAttribute('aria-current');
      if (current >= 0 && current < pageCount) {
        this.rows[current]?.row.setAttribute('aria-current', 'page');
      }
      this.lastAriaCurrent = current;
    }
    if (current !== this.lastCurrentPage) {
      this.lastCurrentPage = current;
      if (current >= 0 && current < pageCount) {
        this.setExpanded(current, true);
        this.scrollCurrentIntoView();
      }
    }
    // 可见性快照是每次图层写入/探测补齐时新建的引用；同一引用时三态不可能变化，
    // 直接跳过 O(页数) 的刷新（滚动、翻页、缩放等 statechange 不再逐页读状态）。
    const disabled = this.viewer.isDisabled();
    if (rebuilt || state.ui.layers !== this.lastLayersState || disabled !== this.lastDisabled) {
      this.lastLayersState = state.ui.layers;
      this.lastDisabled = disabled;
      // 探测补齐 / 类型集合变化：已展开的类型组重建；重建只改 DOM 与文案，不写状态（§I.3）。
      this.refreshTypeGroups();
      this.refreshStates();
    }
    this.syncRoving();
  }

  /**
   * 语言切换：原地更新全部文案与 `aria-label`（不重建、不清展开状态）。
   *
   * @param translator 新翻译器。
   */
  setLocale(translator: Translator): void {
    if (this.destroyed) return;
    this.translatorOverride = translator;
    // 类型文案由宿主按“当前翻译器”解析；先刷新行文案再走通用更新（不重建、保展开态）。
    for (const pageIndex of this.typeGroups.keys()) this.refreshTypeRows(pageIndex);
    this.update(this.viewer.getState());
  }

  /** 销毁监听与 DOM。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.tree?.removeEventListener('change', this.handleChange);
    this.tree?.removeEventListener('keydown', this.handleKeydown);
    this.tree?.removeEventListener('focusin', this.handleFocusIn);
    this.root?.remove();
    this.root = null;
    this.tree = null;
    this.body = null;
    this.rows = [];
    this.allRow = null;
    this.groups.clear();
    this.typeGroups.clear();
    this.typeSignatures.clear();
    this.expandedGroups.clear();
  }

  /** 当前翻译器。 */
  private get translator(): Translator {
    return this.translatorOverride ?? this.viewer.getTranslator();
  }

  /** 构建面板骨架（工具栏 + 树容器 + 空态）。 */
  private build(): void {
    const doc = this.host.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = 'ofd-layers';

    const toolbar = doc.createElement('div');
    toolbar.className = 'ofd-layers__toolbar';
    this.title = doc.createElement('span');
    this.title.className = 'ofd-layers__title';
    this.title.setAttribute('aria-hidden', 'true');
    this.restoreButton = doc.createElement('button');
    this.restoreButton.type = 'button';
    this.restoreButton.className = 'ofd-button ofd-layers__restore';
    this.restoreButton.appendChild(createIcon('restore'));
    this.restoreButton.addEventListener('click', this.handleRestore);
    toolbar.append(this.title, this.restoreButton);

    this.notice = doc.createElement('p');
    this.notice.className = 'ofd-layers__notice';
    this.notice.setAttribute('role', 'note');
    this.notice.hidden = true;

    this.empty = doc.createElement('p');
    this.empty.className = 'ofd-layers__empty';

    this.tree = doc.createElement('div');
    this.tree.className = 'ofd-layers__tree';
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-multiselectable', 'false');
    this.tree.addEventListener('change', this.handleChange);
    this.tree.addEventListener('keydown', this.handleKeydown);
    this.tree.addEventListener('focusin', this.handleFocusIn);

    this.root.append(toolbar, this.notice, this.tree);
    this.host.appendChild(this.root);
  }

  /** 显示树或空态：有页时显示树，否则显示空态文案。 */
  private layout(): void {
    const root = this.root;
    const tree = this.tree;
    const empty = this.empty;
    if (!root || !tree || !empty) return;
    const treeVisible = this.viewer.getState().document.pageCount > 0;
    tree.hidden = !treeVisible;
    empty.hidden = treeVisible;
    if (treeVisible) {
      if (empty.parentElement) empty.remove();
      if (tree.parentElement !== root) root.appendChild(tree);
    } else if (empty.parentElement !== root) {
      root.appendChild(empty);
    }
  }

  /**
   * 按页数重建总项与页面行。
   *
   * @param pageCount 页数。
   */
  private buildList(pageCount: number): void {
    if (!this.tree) return;
    this.tree.replaceChildren();
    this.rows = [];
    this.groups.clear();
    this.typeGroups.clear();
    this.typeSignatures.clear();
    this.expandedGroups.clear();
    // 零页 / 未打开文档只显示空态，不构建树与任何类型复选框（§I.9）。
    this.allRow = pageCount > 0 ? this.createRow('all', 'all') : null;
    if (this.allRow) {
      this.tree.appendChild(this.allRow.row);
      this.tree.appendChild(this.allRow.group);
    }
    for (let index = 0; index < pageCount; index += 1) {
      const entry = this.createRow(index, 'page');
      this.rows.push(entry);
      this.tree.appendChild(entry.row);
      this.tree.appendChild(entry.group);
    }
    // 树只有一个 tab stop：总项行。
    if (this.allRow) this.allRow.row.tabIndex = 0;
  }

  /**
   * 创建一行。
   *
   * @param id 行标识（`'all'` 或页索引）。
   * @param kind 行类型：总项或页面行。
   * @returns 行视图。
   */
  private createRow(id: GroupId, kind: 'all' | 'page'): RowView {
    const doc = this.host.ownerDocument;
    const row = doc.createElement('div');
    row.className = kind === 'all' ? 'ofd-layers__row ofd-layers__row--all' : 'ofd-layers__row ofd-layers__row--page';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', '1');
    row.setAttribute('aria-expanded', 'false');
    row.setAttribute('aria-selected', 'false');
    row.tabIndex = -1;
    row.dataset.role = kind;
    if (kind === 'page') row.dataset.pageIndex = String(id);

    const twisty = doc.createElement('button');
    twisty.type = 'button';
    twisty.className = 'ofd-layers__twisty';
    twisty.tabIndex = -1;
    twisty.setAttribute('aria-hidden', 'true');
    const chevron = createIcon('chevron-right');
    chevron.setAttribute('class', 'ofd-icon ofd-layers__chevron');
    twisty.appendChild(chevron);

    const label = doc.createElement('span');
    label.className = 'ofd-layers__label';
    label.setAttribute('aria-hidden', 'true');

    const group = doc.createElement('div');
    group.className = 'ofd-layers__group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-level', '2');
    group.hidden = true;

    const box = this.createCheckbox('all', kind === 'page' ? id : undefined);
    row.append(twisty, box, label);
    const children: HTMLElement[] = [];
    const boxes: HTMLInputElement[] = [];

    row.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      // 复选框自带的 change 事件负责状态；点击行其它区域切换展开。
      if (target && target.tagName === 'INPUT') return;
      this.toggleExpanded(id);
    });

    const view: RowView = { row, twisty, label, box, group, children, boxes };
    return view;
  }

  /**
   * 创建复选框。
   *
   * @param key 图层键；总项自身为 `'all'`。
   * @param pageIndex 页面行所在页索引；其它行为 undefined。
   * @returns 复选框。
   */
  private createCheckbox(key: LayerKey | 'all', pageIndex?: GroupId): HTMLInputElement {
    const box = this.host.ownerDocument.createElement('input');
    box.type = 'checkbox';
    box.className = 'ofd-layers__checkbox';
    box.tabIndex = -1;
    box.dataset.key = key;
    box.dataset.role = 'layer';
    if (pageIndex !== undefined) box.dataset.pageIndex = String(pageIndex);
    return box;
  }

  /**
   * 确保某行的六项子项已生成。
   *
   * @param id 行标识。
   * @returns 生成后的行视图；页面行不存在时返回 null。
   */
  private ensureGroup(id: GroupId): RowView | null {
    const existing = this.groups.get(id);
    if (existing) return existing;
    const entry = id === 'all' ? this.allRow : this.rows[id];
    if (!entry) return null;
    const doc = this.host.ownerDocument;
    entry.group.replaceChildren();
    const boxes: HTMLInputElement[] = [];
    const children: HTMLElement[] = [];
    for (const key of PAGE_LAYER_KEYS) {
      const child = doc.createElement('div');
      child.className = 'ofd-layers__row ofd-layers__row--layer';
      child.setAttribute('role', 'treeitem');
      child.setAttribute('aria-level', '2');
      child.setAttribute('aria-selected', 'false');
      child.tabIndex = -1;
      child.dataset.layer = key;
      const box = this.createCheckbox(key, id === 'all' ? undefined : id);
      const label = doc.createElement('span');
      label.className = 'ofd-layers__label';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = this.viewer.getLayerLabel(key);
      box.setAttribute('aria-label', label.textContent);
      if (key === 'annotations' && id !== 'all') {
        // 页面行的注释项是唯一可再展开的子项：自带展开箭头，后面跟注释类型分组（§I.1）。
        // 总项只保留六项总开关，不显示注释类型（用户决定：类型只在每页显示）。
        const subTwisty = doc.createElement('button');
        subTwisty.type = 'button';
        subTwisty.className = 'ofd-layers__twisty ofd-layers__twisty--sub';
        subTwisty.tabIndex = -1;
        subTwisty.setAttribute('aria-hidden', 'true');
        const subChevron = createIcon('chevron-right');
        subChevron.setAttribute('class', 'ofd-icon ofd-layers__chevron');
        subTwisty.appendChild(subChevron);
        child.classList.add('ofd-layers__row--expandable');
        child.setAttribute('aria-expanded', 'false');
        child.append(subTwisty, box, label);
        child.addEventListener('click', (event) => {
          const target = event.target as HTMLElement | null;
          // 点击复选框本身由 change 处理；点行其它区域切换类型组展开。
          if (target && target.tagName === 'INPUT') return;
          this.toggleTypeGroup(id);
        });
        entry.group.appendChild(child);
        const typeGroup = this.createTypeGroup(id);
        entry.group.appendChild(typeGroup);
      } else {
        const placeholder = doc.createElement('span');
        placeholder.className = 'ofd-layers__twisty ofd-layers__twisty--placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        child.append(placeholder, box, label);
        entry.group.appendChild(child);
      }
      boxes.push(box);
      children.push(child);
    }
    const view: RowView = { ...entry, children, boxes };
    this.groups.set(id, view);
    // 首次生成时按当前状态刷新三态，避免展开瞬间显示未初始化状态。
    // 只刷新本组：翻页时当前页自动展开，不应触发 O(页数) 的全量刷新。
    this.refreshGroupStates(id);
    return view;
  }

  /**
   * 创建注释类型分组容器（`role=group`，`aria-level=3`）。
   *
   * 只创建空容器；具体类型行在首次展开时按 `readAnnotationTypes()` 生成（§I.3 懒加载）。
   *
   * @param pageIndex 所属页索引（0-based）；总项没有类型组。
   * @returns 分组容器。
   */
  private createTypeGroup(pageIndex: number): HTMLElement {
    const doc = this.host.ownerDocument;
    const group = doc.createElement('div');
    group.className = 'ofd-layers__group ofd-layers__group--types';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-level', '3');
    group.setAttribute('aria-label', this.translator.t('layers.annotationTypes'));
    group.dataset.group = 'annotations';
    group.dataset.groupId = String(pageIndex);
    group.hidden = true;
    return group;
  }

  /**
   * 取某页行所属 `annotations` 子行（创建子项后才有）。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 子行元素；子项尚未生成时返回 null。
   */
  private annotationRowOf(pageIndex: number): HTMLElement | null {
    const view = this.groups.get(pageIndex);
    if (!view) return null;
    const indexOfAnnotations = PAGE_LAYER_KEYS.indexOf('annotations');
    return view.children[indexOfAnnotations] ?? null;
  }

  /**
   * 切换某页注释类型的展开状态（展开时生成类型行并按需懒加载）。
   *
   * @param pageIndex 页索引，0-based。
   */
  private toggleTypeGroup(pageIndex: number): void {
    if (this.isDisabled()) return;
    const key = typeGroupKey(pageIndex);
    const next = !this.expandedGroups.has(key);
    this.setTypeGroupExpanded(pageIndex, next);
  }

  /**
   * 设置某页注释类型的展开状态。
   *
   * @param pageIndex 页索引，0-based。
   * @param expand 是否展开。
   */
  private setTypeGroupExpanded(pageIndex: number, expand: boolean): void {
    const row = this.annotationRowOf(pageIndex);
    const group = this.typeGroupOf(pageIndex);
    if (!row || !group) return;
    const key = typeGroupKey(pageIndex);
    if (expand) this.expandedGroups.add(key);
    else this.expandedGroups.delete(key);
    row.setAttribute('aria-expanded', expand ? 'true' : 'false');
    group.hidden = !expand;
    if (!expand) return;
    // 首次展开时才生成类型行；已生成但类型集合变化时重建。
    this.ensureTypeRows(pageIndex);
    this.refreshStates();
    this.syncRoving();
  }

  /**
   * 读取某页类型分组容器。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 分组容器；未生成时为 null。
   */
  private typeGroupOf(pageIndex: number): HTMLElement | null {
    const view = this.groups.get(pageIndex);
    if (!view) return null;
    const indexOfAnnotations = PAGE_LAYER_KEYS.indexOf('annotations');
    const row = view.children[indexOfAnnotations];
    const next = row ? row.nextElementSibling : null;
    return next instanceof HTMLElement && next.classList.contains('ofd-layers__group--types')
      ? next
      : null;
  }

  /**
   * 生成/重建某页的注释类型行（按 `readAnnotationTypes()` 给出的顺序）。
   *
   * @param pageIndex 页索引，0-based。
   */
  private ensureTypeRows(pageIndex: number): void {
    const group = this.typeGroupOf(pageIndex);
    if (!group) return;
    const types = annotationTypesForGroup(this.viewer.readAnnotationTypes(pageIndex));
    const signature = types.join('\u0000');
    if (this.typeSignatures.get(pageIndex) === signature) {
      this.refreshTypeRows(pageIndex);
      return;
    }
    this.typeSignatures.set(pageIndex, signature);
    // 重建前记住焦点所在类型，重建后恢复（探测补齐时避免焦点丢失）。
    const active = this.host.ownerDocument.activeElement;
    const focusedType =
      active instanceof HTMLElement && group.contains(active)
        ? active.closest<HTMLElement>('[data-type]')?.dataset.type
        : undefined;
    const inUse = this.viewer.readAnnotationTypesInUse(pageIndex);
    group.replaceChildren();
    const rows: HTMLElement[] = [];
    for (const type of types) {
      const row = this.createTypeRow(pageIndex, type, inUse);
      group.appendChild(row);
      rows.push(row);
    }
    this.typeGroups.set(pageIndex, rows);
    if (focusedType) {
      const target = rows.find((row) => row.dataset.type === focusedType);
      if (target) {
        this.focusedRow = target;
        target.focus();
      }
    }
  }

  /**
   * 创建一行注释类型。
   *
   * @param pageIndex 所属页索引（0-based）。
   * @param type 类型名（引擎原值）。
   * @param inUse 该页实际出现过的类型集合；不在其中时淡色显示（仍可切换）。
   * @returns 类型行。
   */
  private createTypeRow(
    pageIndex: number,
    type: AnnotationTypeKey,
    inUse: ReadonlySet<string>,
  ): HTMLElement {
    const doc = this.host.ownerDocument;
    const row = doc.createElement('div');
    row.className = 'ofd-layers__row ofd-layers__row--type';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', '3');
    row.setAttribute('aria-selected', 'false');
    row.tabIndex = -1;
    row.dataset.type = type;
    row.dataset.role = 'type';
    if (!inUse.has(type)) row.dataset.empty = 'true';
    row.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target.tagName === 'INPUT') return;
      this.focusedRow = row;
      this.syncRoving();
      row.focus();
    });
    const placeholder = doc.createElement('span');
    placeholder.className = 'ofd-layers__twisty ofd-layers__twisty--placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.className = 'ofd-layers__checkbox';
    box.tabIndex = -1;
    box.dataset.key = 'annotation-type';
    box.dataset.role = 'type';
    box.dataset.type = type;
    box.dataset.pageIndex = String(pageIndex);
    const label = doc.createElement('span');
    label.className = 'ofd-layers__label';
    label.setAttribute('aria-hidden', 'true');
    const name = this.viewer.getAnnotationTypeLabel(type);
    label.textContent = name;
    box.title = name;
    box.setAttribute('aria-label', name);
    row.append(placeholder, box, label);
    return row;
  }

  /**
   * 刷新已生成类型行的文案与淡色标记（探测补齐 / 语言切换后）。
   *
   * @param pageIndex 页索引，0-based。
   */
  private refreshTypeRows(pageIndex: number): void {
    const rows = this.typeGroups.get(pageIndex);
    if (!rows) return;
    const inUse = this.viewer.readAnnotationTypesInUse(pageIndex);
    const group = this.typeGroupOf(pageIndex);
    if (group) group.setAttribute('aria-label', this.translator.t('layers.annotationTypes'));
    for (const row of rows) {
      const type = row.dataset.type;
      if (!type) continue;
      if (inUse.has(type)) delete row.dataset.empty;
      else row.dataset.empty = 'true';
      const name = this.viewer.getAnnotationTypeLabel(type);
      const label = row.querySelector<HTMLElement>('.ofd-layers__label');
      const box = row.querySelector<HTMLInputElement>('.ofd-layers__checkbox');
      if (label) label.textContent = name;
      if (box) {
        box.title = name;
        box.setAttribute('aria-label', name);
      }
    }
  }

  /**
   * 探测结果到达等情况下重建所有已展开的页面类型组。
   *
   * 总项没有类型组：注释类型复选框只在页面行提供，总项行不渲染展开箭头，也不设置
   * `aria-expanded`（读屏只把它当普通复选框，避免误判为可展开）。
   */
  private refreshTypeGroups(): void {
    for (const key of [...this.expandedGroups]) {
      const pageIndex = Number(key.slice(2));
      const group = this.typeGroupOf(pageIndex);
      if (!group || group.hidden) continue;
      this.ensureTypeRows(pageIndex);
    }
  }

  /**
   * 展开/收起一行；展开时按需生成子项。
   *
   * @param id 行标识。
   * @param expand 目标状态；省略时切换。
   */
  private setExpanded(id: GroupId, expand?: boolean): void {
    const entry = id === 'all' ? this.allRow : this.rows[id];
    if (!entry) return;
    const next = expand === undefined ? entry.row.getAttribute('aria-expanded') !== 'true' : expand;
    if (next) this.ensureGroup(id);
    entry.row.setAttribute('aria-expanded', next ? 'true' : 'false');
    entry.group.hidden = !next;
  }

  /** 切换展开状态。 */
  private toggleExpanded(id: GroupId): void {
    if (this.isDisabled()) return;
    this.setExpanded(id);
  }

  /** 当前页滚动到可见区（jsdom 无布局时跳过）。 */
  private scrollCurrentIntoView(): void {
    const row = this.rows[this.lastCurrentPage]?.row;
    if (!row || typeof row.scrollIntoView !== 'function') return;
    row.scrollIntoView({ block: 'nearest' });
  }

  /** 刷新所有文案（语言切换或页面重建后调用）。 */
  private refreshTexts(): void {
    const translator = this.translator;
    if (this.title) this.title.textContent = translator.t('layers.title');
    if (this.tree) this.tree.setAttribute('aria-label', translator.t('layers.title'));
    if (this.restoreButton) {
      const name = translator.t('layers.restoreDefault');
      this.restoreButton.title = name;
      this.restoreButton.setAttribute('aria-label', name);
    }
    if (this.empty) {
      const state = this.viewer.getState();
      this.empty.textContent =
        state.document.pageCount === 0 && state.document.status === 'ready'
          ? translator.t('layers.empty')
          : translator.t('layers.noDocument');
    }
    if (this.allRow) {
      this.allRow.label.textContent = translator.t('layers.allPages');
    }
    this.rows.forEach((entry, index) => {
      const page = index + 1;
      entry.label.textContent = translator.t('layers.page', {
        page: translator.formatNumber(page),
      });
    });
    for (const view of this.groups.values()) {
      view.children.forEach((child, index) => {
        const key = PAGE_LAYER_KEYS[index];
        const label = child.querySelector<HTMLElement>('.ofd-layers__label');
        const name = this.viewer.getLayerLabel(key);
        if (label) label.textContent = name;
        view.boxes[index].setAttribute('aria-label', name);
      });
    }
    for (const pageIndex of this.typeGroups.keys()) this.refreshTypeRows(pageIndex);
  }

  /**
   * 刷新禁用态：提示行、复选框与恢复按钮。
   *
   * 复选框的 `disabled` 由 `paint()` 随三态一并写入，这里只处理提示行与按钮。
   */
  private syncDisabled(): void {
    const disabled = this.viewer.isDisabled();
    const reason = disabled
      ? this.viewer.getDisabledReason() || this.translator.t('layers.disabled')
      : '';
    if (this.notice) {
      this.notice.hidden = !disabled;
      this.notice.textContent = reason;
    }
    if (this.restoreButton) {
      const name = disabled ? reason : this.translator.t('layers.restoreDefault');
      this.restoreButton.disabled = disabled;
      this.restoreButton.title = name;
      this.restoreButton.setAttribute('aria-label', name);
    }
    if (this.root) this.root.dataset.state = disabled ? 'disabled' : 'ready';
  }

  /**
   * 刷新单个分组（总项或某页的六项）的复选框状态。
   *
   * 用于分组首次生成时补齐三态；只读本组所需的一页状态，避免大文档翻页时
   * 触发全量刷新（`refreshStates` 的 O(页数) 成本）。
   *
   * @param id 分组标识：`'all'` 或页索引（0-based）。
   */
  private refreshGroupStates(id: GroupId): void {
    const view = this.groups.get(id);
    if (!view) return;
    if (id === 'all') {
      const summary = this.viewer.readAllState();
      PAGE_LAYER_KEYS.forEach((key, index) => {
        this.paint(
          view.boxes[index],
          summary.allKeysOn[key] ? 'on' : summary.allKeysOff[key] ? 'off' : 'mixed',
        );
      });
      return;
    }
    const visibility = this.viewer.readPageState(id);
    PAGE_LAYER_KEYS.forEach((key, index) => {
      this.paint(view.boxes[index], this.effectiveFlag(visibility, key, id) ? 'on' : 'off');
    });
    for (const row of this.typeGroups.get(id) ?? []) {
      const type = row.dataset.type;
      const box = row.querySelector<HTMLInputElement>('.ofd-layers__checkbox');
      if (type && box) this.paint(box, readAnnotationType(visibility.annotations, type) ? 'on' : 'off');
    }
  }

  /** 刷新三态与半选（含注释类型）。 */
  private refreshStates(): void {
    if (!this.allRow || this.rows.length === 0) return;
    const summary = this.viewer.readAllState();
    const allView = this.groups.get('all');
    if (allView) {
      PAGE_LAYER_KEYS.forEach((key, index) => {
        const state: CheckboxState = summary.allKeysOn[key]
          ? 'on'
          : summary.allKeysOff[key]
            ? 'off'
            : 'mixed';
        this.paint(allView.boxes[index], state);
      });
    }
    this.rows.forEach((entry, index) => {
      const visibility = this.viewer.readPageState(index);
      const flags = PAGE_LAYER_KEYS.map((key) => this.effectiveFlag(visibility, key, index));
      const onCount = flags.filter(Boolean).length;
      const state: CheckboxState =
        onCount === flags.length ? 'on' : onCount === 0 ? 'off' : 'mixed';
      this.paint(entry.box, state);
      const pageView = this.groups.get(index);
      if (pageView) {
        PAGE_LAYER_KEYS.forEach((key, keyIndex) => {
          this.paint(
            pageView.boxes[keyIndex],
            this.effectiveFlag(visibility, key, index) ? 'on' : 'off',
          );
        });
      }
    });
    this.paint(this.allRow.box, summary.state);
    this.refreshTypeStates();
  }

  /**
   * 六项中的一项在该页的“有效开”状态（§I.4.1）。
   *
   * `annotations` 的有效开 = 总开关打开 **且** 该页列出的类型里至少一个被勾选；
   * 其余五项直接读布尔。
   *
   * @param visibility 该页可见性。
   * @param key 图层键。
   * @param pageIndex 页索引，0-based（读取该页列出的类型）。
   * @returns 是否有效可见。
   */
  private effectiveFlag(
    visibility: ResolvedLayerVisibility,
    key: LayerKey,
    pageIndex: number,
  ): boolean {
    if (key !== 'annotations') return visibility[key];
    if (!visibility.annotations.enabled) return false;
    return selectedAnnotationTypes(visibility.annotations, this.listedTypes(pageIndex)).length > 0;
  }

  /**
   * 某页列出的注释类型（已去重、含常见五类）。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 类型列表。
   */
  private listedTypes(pageIndex: number): readonly AnnotationTypeKey[] {
    return annotationTypesForGroup(this.viewer.readAnnotationTypes(pageIndex));
  }

  /** 刷新页面注释类型复选框（两态，永不 mixed）。 */
  private refreshTypeStates(): void {
    for (const [pageIndex, rows] of this.typeGroups) {
      const visibility = this.viewer.readPageState(pageIndex);
      for (const row of rows) {
        const type = row.dataset.type;
        const box = row.querySelector<HTMLInputElement>('.ofd-layers__checkbox');
        if (!type || !box) continue;
        this.paint(box, readAnnotationType(visibility.annotations, type) ? 'on' : 'off');
      }
    }
  }

  /**
   * 写入复选框三态并缓存，供 `change` 事件反推点击前状态。
   *
   * @param box 复选框。
   * @param state 三态。
   */
  private paint(box: HTMLInputElement, state: CheckboxState): void {
    setCheckboxState(box, state);
    box.disabled = this.viewer.isDisabled();
    this.checkedStates.set(box, state);
  }

  /** 同步 roving tabindex：树内只有一个 tab stop。 */
  private syncRoving(): void {
    const visible = this.visibleRows();
    if (visible.length === 0) return;
    const target =
      this.focusedRow && visible.includes(this.focusedRow) ? this.focusedRow : visible[0];
    for (const row of this.allRows()) row.tabIndex = row === target ? 0 : -1;
  }

  /** 全部行元素（总项、页面行与已生成的子项）。 */
  private allRows(): HTMLElement[] {
    const rows: HTMLElement[] = [];
    if (this.allRow) rows.push(this.allRow.row);
    for (const entry of this.rows) rows.push(entry.row);
    for (const view of this.groups.values()) rows.push(...view.children);
    return rows;
  }

  /** 可见行序列（折叠行的子项不计入）。 */
  private visibleRows(): HTMLElement[] {
    const rows: HTMLElement[] = [];
    if (!this.allRow) return rows;
    rows.push(this.allRow.row);
    const allGroup = this.groups.get('all');
    if (allGroup && !this.allRow.group.hidden) rows.push(...allGroup.children);
    this.rows.forEach((entry, index) => {
      rows.push(entry.row);
      const group = this.groups.get(index);
      if (group && !entry.group.hidden) rows.push(...group.children);
    });
    return rows;
  }

  /**
   * 读取某行复选框的点击前状态。
   *
   * @param box 复选框。
   * @returns 三态；无缓存时按当前 DOM 推断。
   */
  private stateOf(box: HTMLInputElement): CheckboxState {
    const cached = this.checkedStates.get(box);
    if (cached) return cached;
    return box.indeterminate ? 'mixed' : box.checked ? 'on' : 'off';
  }

  /**
   * 复选框变化：按点击前三态反推目标值，还原视觉后交给宿主。
   *
   * @param event change 事件。
   */
  private readonly handleChange = (event: Event): void => {
    const box = event.target as HTMLInputElement | null;
    if (!box || box.tagName !== 'INPUT') return;
    const previous = this.stateOf(box);
    // 浏览器已把原生勾选切走；先还原，等待 `statechange → update()` 落最终三态。
    setCheckboxState(box, previous);
    this.applyCheckbox(box);
  };

  /** “恢复默认”按钮。 */
  private readonly handleRestore = (): void => {
    if (this.isDisabled()) return;
    this.viewer.resetLayerVisibility();
    // 保持展开状态：只刷新三态，不重建列表。
    this.update(this.viewer.getState());
  };

  /**
   * 行键盘导航（WAI-ARIA tree 模式）。
   *
   * @param event 键盘事件。
   */
  private readonly handleKeydown = (event: KeyboardEvent): void => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]');
    if (!row || !this.tree || !this.tree.contains(row)) return;
    const visible = this.visibleRows();
    const index = visible.indexOf(row);
    const moveTo = (target: HTMLElement | undefined): void => {
      if (!target) return;
      this.focusedRow = target;
      this.syncRoving();
      target.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(visible[index + 1]);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(visible[index - 1]);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(visible[0]);
        return;
      case 'End':
        event.preventDefault();
        moveTo(visible[visible.length - 1]);
        return;
      case 'ArrowRight': {
        event.preventDefault();
        const expanded = row.getAttribute('aria-expanded');
        if (expanded === 'false') {
          this.toggleExpanded(this.idOf(row));
          return;
        }
        if (expanded === null) return;
        const id = this.idOf(row);
        const group = this.groups.get(id);
        moveTo(group?.children[0]);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        const expanded = row.getAttribute('aria-expanded');
        if (expanded === 'true') {
          this.toggleExpanded(this.idOf(row));
          return;
        }
        const group = row.closest('[role="group"]');
        const parent = group ? group.previousElementSibling : null;
        if (parent && parent instanceof HTMLElement && parent.getAttribute('role') === 'treeitem') {
          moveTo(parent);
        }
        return;
      }
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        // 可展开但尚未展开的行：Alt+Space 切换其复选框，Space 只展开。
        if (row.getAttribute('aria-expanded') === 'false') {
          if (event.altKey) this.toggleRowBox(row);
          else this.toggleExpanded(this.idOf(row));
          return;
        }
        this.toggleRowBox(row);
        return;
      }
      default:
    }
  };

  /**
   * 切换某行复选框（键盘 Space 使用）：按点击前三态反推目标值。
   *
   * @param row 行元素。
   */
  private toggleRowBox(row: HTMLElement): void {
    const box = row.querySelector<HTMLInputElement>('.ofd-layers__checkbox');
    if (!box) return;
    this.applyCheckbox(box);
  }

  /**
   * 按复选框当前三态反推目标值并交给宿主。
   *
   * 页面行（有 `data-page-index` 且键为 `all`）批量写六项，页内六项写单项，
   * 总项写全部页。禁用时不做任何操作。
   *
   * @param box 复选框。
   */
  private applyCheckbox(box: HTMLInputElement): void {
    if (this.isDisabled()) return;
    const value = nextChecked(this.stateOf(box));
    const rawPage = box.dataset.pageIndex;
    const pageIndex = rawPage === undefined ? undefined : Number(rawPage);
    if (box.dataset.role === 'type') {
      // 注释类型只在页面行的类型组里出现，按页写单项。
      const type = box.dataset.type;
      if (!type || pageIndex === undefined) return;
      this.viewer.setAnnotationTypeForPage(pageIndex, type, value);
      return;
    }
    const key = box.dataset.key as LayerKey | 'all' | undefined;
    if (!key) return;
    if (pageIndex === undefined) {
      if (key === 'all') this.viewer.setAllLayersVisible(value);
      else this.viewer.setLayerForAllPages(key, value);
    } else if (key === 'all') {
      this.viewer.setAllLayersVisibleForPage(pageIndex, value);
    } else {
      this.viewer.setPageLayer(pageIndex, key, value);
    }
  }

  /**
   * 读取行标识。
   *
   * @param row 行元素。
   * @returns `'all'` 或页索引。
   */
  private idOf(row: HTMLElement): GroupId {
    const role = row.dataset.role;
    if (role === 'all' && row.closest('[role="tree"]')) return 'all';
    const raw = row.dataset.pageIndex;
    return raw === undefined ? 'all' : Number(raw);
  }

  /** 焦点进入行时更新 roving tabindex。 */
  private readonly handleFocusIn = (event: FocusEvent): void => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]');
    if (!row) return;
    this.focusedRow = row;
    this.syncRoving();
  };

  /** 宿主是否禁用。 */
  private isDisabled(): boolean {
    return this.viewer.isDisabled();
  }
}

/**
 * 类型组展开状态的键。
 *
 * @param pageIndex 页索引，0-based。
 * @returns `A:<index>`。
 */
function typeGroupKey(pageIndex: number): string {
  return `A:${pageIndex}`;
}
