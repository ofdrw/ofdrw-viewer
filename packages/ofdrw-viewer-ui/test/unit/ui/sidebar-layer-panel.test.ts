/**
 * 图层侧栏面板单测（设计方案 §H.3）。
 *
 * 用假宿主驱动 `LayerPanel`：宿主保存每页六项状态，写入后立即重算并派发
 * `statechange`，从而覆盖“勾选 → 宿主 → 面板重算”的完整回环。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTranslator } from '../../../src/i18n';
import type { Translator } from '../../../src/i18n';
import { LayerPanel } from '../../../src/layers/layer-panel';
import type { LayerPanelHost } from '../../../src/layers/layer-panel';
import {
  PAGE_LAYER_KEYS,
  contentFilterKey,
  createDefaultVisibility,
  readAnnotationEnabled,
  type LayerKey,
  type LayerSummary,
  type ResolvedLayerVisibility,
} from '../../../src/layers/content-filter';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';

/** 面板实例；每个用例结束统一销毁。 */
const panels: LayerPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.innerHTML = '';
});

/** 每页可变可见性（测试宿主自己改值）。 */
interface Six {
  signatures: boolean;
  annotations: { enabled: boolean; types: Readonly<Record<string, boolean>> };
  custom: boolean;
  foreground: boolean;
  body: boolean;
  background: boolean;
}

/** 常见五类（顺序固定，§I.1）。 */
const KNOWN: readonly string[] = ['Link', 'Path', 'Highlight', 'Stamp', 'Watermark'];

/** 常见五类显示名。 */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  Link: '链接',
  Path: '路径',
  Highlight: '高亮',
  Stamp: '印章',
  Watermark: '水印',
};

/** 假宿主。 */
interface FakeHost extends LayerPanelHost {
  /** 每页状态（0-based）。 */
  readonly pages: Six[];
  /** 调用记录。 */
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }>;
  /** 当前页，1-based。 */
  setPage(pageNumber: number): void;
  /** 切换宿主语言。 */
  setLocale(locale: string): void;
  /** 状态变化次数。 */
  commits(): number;
  /** 是否拒绝写入。 */
  readonly rejectChanges?: boolean;
  /** 每页追加的注释类型（模拟探测结果）。 */
  readonly extraTypes: Map<number, readonly string[]>;
}

/** 六项全开、类型全勾的可变副本。 */
function mutableDefault(): Six {
  const base = createDefaultVisibility();
  return {
    signatures: base.signatures,
    annotations: { enabled: base.annotations.enabled, types: {} },
    custom: base.custom,
    foreground: base.foreground,
    body: base.body,
    background: base.background,
  };
}

/** 六项同值的布尔表。 */
function booleanSix(value: boolean): Record<LayerKey, boolean> {
  return {
    signatures: value,
    annotations: value,
    custom: value,
    foreground: value,
    body: value,
    background: value,
  };
}

/** 六项之一的“有效开”（注释按总开关 + 是否有勾选类型，§I.4.1）。 */
function flagOf(page: Six, key: LayerKey): boolean {
  if (key !== 'annotations') return page[key];
  return readAnnotationEnabled(page.annotations);
}

/** 写入六项之一：注释只改总开关并保留类型表。 */
function writeFlag(page: Six, key: LayerKey, value: boolean): void {
  if (key === 'annotations') {
    page.annotations = { enabled: value, types: page.annotations.types };
    return;
  }
  (page as unknown as Record<string, boolean>)[key] = value;
}

/** 六项一起写入：注释只改总开关，类型表保留（§I.2）。 */
function writeAll(page: Six, visible: boolean): void {
  for (const key of PAGE_LAYER_KEYS) writeFlag(page, key, visible);
}

/**
 * 创建假宿主。
 *
 * @param options 页数、当前页与禁用态。
 * @returns 宿主。
 */
function createHost(
  options: {
    readonly pageCount?: number;
    readonly pageNumber?: number;
    readonly disabled?: boolean;
    /** 模拟宿主拒绝写入（只读 / 无实际变化）：调用被记录，但状态不变、不提交。 */
    readonly rejectChanges?: boolean;
  } = {},
): FakeHost {
  const reject = options.rejectChanges ?? false;
  const pageCount = options.pageCount ?? 3;
  const pages: Six[] = Array.from({ length: pageCount }, () => mutableDefault());
  const calls: Array<{ method: string; args: readonly unknown[] }> = [];
  const listeners = new Set<(state: ViewerState) => void>();
  let state: ViewerState = {
    ...createInitialViewerState(),
    document: {
      ...createInitialViewerState().document,
      pageCount,
      status: pageCount > 0 ? 'ready' : 'closed',
    },
    view: { ...createInitialViewerState().view, pageNumber: options.pageNumber ?? 1 },
  };
  const disabled = options.disabled ?? false;
  let translator: Translator = createTranslator('zh-CN');
  /**
   * 模拟真实阅读器的 UI 快照语义：图层写入、语言切换各生成新的 `ui.layers` /
   * `ui.locale` 引用；滚动与翻页只换 `view`。面板靠引用判断是否需要全量刷新。
   */
  const patchUI = (patch: { layers?: unknown; locale?: string }): void => {
    state = {
      ...state,
      ui: {
        ...state.ui,
        ...(patch.layers === undefined ? {} : { layers: patch.layers as ViewerState['ui']['layers'] }),
        ...(patch.locale === undefined ? {} : { locale: patch.locale }),
      },
    };
  };
  /** 图层写入后生成新的快照引用。 */
  const touchLayers = (): void => {
    patchUI({ layers: { ...state.ui.layers } });
  };
  /** 某页列出的类型：常见五类 + 该页追加类型（字典序，§I.1）。 */
  const listedTypesOf = (pageIndex: number): readonly string[] => {
    const extras: string[] = [];
    for (const type of extraTypes.get(pageIndex) ?? []) extras.push(type);
    extras.sort();
    return [...KNOWN, ...extras.filter((type) => KNOWN.indexOf(type) < 0)];
  };
  const commit = (): void => {
    for (const listener of listeners) listener(state);
  };
  const extraTypes = new Map<number, readonly string[]>();
  const host: FakeHost = {
    pages,
    extraTypes,
    rejectChanges: reject,
    calls,
    commits: () => calls.filter((call) => call.method === 'commit').length,
    setPage(pageNumber: number): void {
      state = { ...state, view: { ...state.view, pageNumber } };
      commit();
    },
    setLocale(locale: string): void {
      translator = createTranslator(locale);
      patchUI({ locale });
      commit();
    },
    getState: () => state,
    readAllState: (): LayerSummary => {
      const allKeysOn = { ...createDefaultVisibility() } as unknown as Record<LayerKey, boolean>;
      const allKeysOff = { ...createDefaultVisibility() } as unknown as Record<LayerKey, boolean>;
      for (const key of PAGE_LAYER_KEYS) {
        const values = pages.map((page) => flagOf(page, key));
        allKeysOn[key] = values.every(Boolean);
        allKeysOff[key] = values.every((value) => !value);
      }
      const matrix = PAGE_LAYER_KEYS.map((key) => pages.map((page) => flagOf(page, key)));
      const state3 = matrix.every((column) => column.every(Boolean))
        ? 'on'
        : matrix.every((column) => column.every((value) => !value))
          ? 'off'
          : 'mixed';
      // 总项没有注释类型复选框，宿主不再提供跨页类型三态。
      return { allKeysOn, allKeysOff, state: state3 };
    },
    readPageState: (pageIndex: number) => {
      const page = pages[pageIndex];
      return Object.freeze({
        ...page,
        annotations: Object.freeze({
          enabled: page.annotations.enabled,
          types: Object.freeze({ ...page.annotations.types }),
        }),
      }) as ResolvedLayerVisibility;
    },
    setPageLayer: (pageIndex, key, value) => {
      calls.push({ method: 'setPageLayer', args: [pageIndex, key, value] });
      if (reject) return;
      writeFlag(pages[pageIndex], key, value);
      touchLayers();
      commit();
    },
    setLayerForAllPages: (key, value) => {
      calls.push({ method: 'setLayerForAllPages', args: [key, value] });
      if (reject) return;
      for (const page of pages) writeFlag(page, key, value);
      calls.push({ method: 'commit', args: [] });
      touchLayers();
      commit();
    },
    setAllLayersVisible: (visible) => {
      calls.push({ method: 'setAllLayersVisible', args: [visible] });
      if (reject) return;
      for (const page of pages) writeAll(page, visible);
      touchLayers();
      commit();
    },
    setAllLayersVisibleForPage: (pageIndex, visible) => {
      calls.push({ method: 'setAllLayersVisibleForPage', args: [pageIndex, visible] });
      if (reject) return;
      writeAll(pages[pageIndex], visible);
      touchLayers();
      commit();
    },
    setAnnotationTypeForPage: (pageIndex, type, value) => {
      calls.push({ method: 'setAnnotationTypeForPage', args: [pageIndex, type, value] });
      if (reject) return;
      const page = pages[pageIndex];
      const types: Record<string, boolean> = { ...page.annotations.types };
      if (value) delete types[type];
      else types[type] = false;
      pages[pageIndex] = { ...page, annotations: { enabled: page.annotations.enabled, types } };
      touchLayers();
      commit();
    },
    getAnnotationTypeLabel: (type) =>
      translator.locale === 'zh-CN' ? (TYPE_NAMES[type] ?? type) : type,
    readAnnotationTypes: (pageIndex) => listedTypesOf(pageIndex),
    readAnnotationTypesInUse: (pageIndex) => new Set(extraTypes.get(pageIndex) ?? []),
    resetLayerVisibility: () => {
      calls.push({ method: 'resetLayerVisibility', args: [] });
      pages.forEach((_, index) => {
        pages[index] = mutableDefault();
      });
      touchLayers();
      commit();
    },
    onStateChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    isDisabled: () => disabled,
    getDisabledReason: () => translator.t('layers.disabled'),
    getTranslator: () => translator,
    getLayerLabel: (key: LayerKey) => translator.t(`layers.${key}` as 'layers.body'),
  };
  return host;
}

/** 空文档的假宿主。 */
function createEmptyHost(status: 'ready' | 'closed'): FakeHost {
  const host = createHost({ pageCount: 0 });
  const state: ViewerState = {
    ...host.getState(),
    document: { ...host.getState().document, pageCount: 0, status },
  };
  return {
    ...host,
    getState: () => state,
    // 行数据跟随状态：无页时不再返回任何页。
    readPageState: () => createDefaultVisibility() as ResolvedLayerVisibility,
    readAllState: () => ({
      allKeysOn: booleanSix(true),
      allKeysOff: booleanSix(true),
      state: 'on',
    }),
  };
}

/** 创建面板。 */
function createPanel(host: FakeHost): { panel: LayerPanel; tree: HTMLElement; host: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new LayerPanel({ host: container, viewer: host });
  panels.push(panel);
  const tree = container.querySelector<HTMLElement>('.ofd-layers__tree');
  if (!tree) throw new Error('缺少树容器');
  return { panel, tree, host: container };
}

/** 触发复选框变化（模拟用户点击后的原生状态已翻转）。 */
function toggle(box: HTMLInputElement): void {
  box.checked = !box.checked;
  box.indeterminate = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 读取某行的六项复选框。 */
function layerBoxes(scope: ParentNode): HTMLInputElement[] {
  return [...scope.querySelectorAll<HTMLInputElement>('input[data-role="layer"]')];
}

/** 全部页面行。 */
function pageRows(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>('[data-role="page"]')];
}

describe('图层面板：结构与展开', () => {
  it('首个 treeitem 为“全部页面”，随后是页面行', () => {
    const fake = createHost();
    const { tree } = createPanel(fake);
    expect(tree.getAttribute('role')).toBe('tree');
    expect(tree.getAttribute('aria-label')).toBe('图层');
    const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]')];
    expect(items[0].dataset.role).toBe('all');
    expect(items[0].getAttribute('aria-expanded')).toBe('false');
    expect(items[0].querySelector('.ofd-layers__label')?.textContent).toBe('全部页面');
    const rows = pageRows(tree);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('.ofd-layers__label')?.textContent)).toEqual([
      '第 1 页',
      '第 2 页',
      '第 3 页',
    ]);
    expect(fake.calls.length).toBe(0);
  });

  it('总项展开后六项顺序为 签章→注释→自定义→前景→正文→背景', () => {
    const { tree } = createPanel(createHost());
    const allRow = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    allRow.click();
    const group = allRow.nextElementSibling as HTMLElement;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.hidden).toBe(false);
    expect(allRow.getAttribute('aria-expanded')).toBe('true');
    const boxes = layerBoxes(group);
    expect(boxes.map((box) => box.dataset.key)).toEqual([...PAGE_LAYER_KEYS]);
    expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
      '签章',
      '注释',
      '自定义',
      '前景',
      '正文',
      '背景',
    ]);
    const items = [...group.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(items).toHaveLength(6);
    expect(items.every((item) => item.getAttribute('aria-level') === '2')).toBe(true);
  });

  it('页面行子项按需生成，收起后保留、再次展开不重建', () => {
    const { tree } = createPanel(createHost({ pageNumber: 3 }));
    const row = pageRows(tree)[0];
    const group = row.nextElementSibling as HTMLElement;
    expect(group.children).toHaveLength(0);
    row.click();
    expect(group.hidden).toBe(false);
    expect(layerBoxes(group)).toHaveLength(6);
    const firstBox = layerBoxes(group)[0];
    row.click();
    expect(group.hidden).toBe(true);
    // 六项 + 注释类型分组（首次展开注释项后才生成类型行）。
    expect(group.children).toHaveLength(7);
    row.click();
    expect(layerBoxes(group)[0]).toBe(firstBox);
  });

  it('当前页自动展开，切换页后新当前页展开、旧页保持原状', () => {
    const host = createHost({ pageNumber: 3 });
    const { tree } = createPanel(host);
    let rows = pageRows(tree);
    expect(rows[2].getAttribute('aria-expanded')).toBe('true');
    expect(rows[0].getAttribute('aria-expanded')).toBe('false');
    host.setPage(1);
    rows = pageRows(tree);
    expect(rows[0].getAttribute('aria-expanded')).toBe('true');
    expect(rows[2].getAttribute('aria-expanded')).toBe('true');
  });
});

describe('图层面板：勾选与批量', () => {
  it('页面行复选框在三态之间按“全开 ↔ 全关”切换', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    const row = pageRows(tree)[1];
    const box = row.querySelector<HTMLInputElement>('input[data-key="all"]')!;
    expect(box.checked).toBe(true);
    toggle(box);
    expect(host.calls[0]).toEqual({ method: 'setAllLayersVisibleForPage', args: [1, false] });
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(false);
    toggle(box);
    expect(host.calls[1]).toEqual({ method: 'setAllLayersVisibleForPage', args: [1, true] });
    expect(box.checked).toBe(true);
  });

  it('部分可见的页面行显示半选', () => {
    const host = createHost();
    host.pages[0].body = false;
    const { tree } = createPanel(host);
    const box = pageRows(tree)[0].querySelector<HTMLInputElement>('input[data-key="all"]')!;
    expect(box.indeterminate).toBe(true);
    expect(box.getAttribute('aria-checked')).toBe('mixed');
  });

  it('总项子项批量设置，且只触发一次提交', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    // 收起自动展开的当前页，确保随后只观察到一次批量提交。
    pageRows(tree)[0].click();
    const allRow = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    allRow.click();
    const bodyBox = layerBoxes(allRow.nextElementSibling as HTMLElement).find(
      (box) => box.dataset.key === 'body',
    )!;
    toggle(bodyBox);
    expect(host.calls).toEqual([
      { method: 'setLayerForAllPages', args: ['body', false] },
      { method: 'commit', args: [] },
    ]);
    expect(bodyBox.checked).toBe(false);
    expect(host.pages.every((page) => page.body === false)).toBe(true);
  });

  it('半选的总项子项点击后按“全开”处理', () => {
    const host = createHost();
    writeFlag(host.pages[1], 'annotations', false);
    const { tree } = createPanel(host);
    const allRow = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    allRow.click();
    const annotationBox = layerBoxes(allRow.nextElementSibling as HTMLElement).find(
      (box) => box.dataset.key === 'annotations',
    )!;
    expect(annotationBox.indeterminate).toBe(true);
    toggle(annotationBox);
    expect(host.calls[0]).toEqual({ method: 'setLayerForAllPages', args: ['annotations', true] });
    expect(annotationBox.indeterminate).toBe(false);
    expect(annotationBox.checked).toBe(true);
  });

  it('总项自身复选框：全开 → 全关 → 全开', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    const box = tree.querySelector<HTMLInputElement>('[data-role="all"] input[data-key="all"]')!;
    expect(box.checked).toBe(true);
    toggle(box);
    expect(host.calls[0]).toEqual({ method: 'setAllLayersVisible', args: [false] });
    expect(box.checked).toBe(false);
    expect(
      host.pages.every((page) => PAGE_LAYER_KEYS.every((key) => flagOf(page, key) === false)),
    ).toBe(true);
    toggle(box);
    expect(host.calls[1]).toEqual({ method: 'setAllLayersVisible', args: [true] });
  });

  it('宿主拒绝写入时三态还原，不残留错误的勾选视觉', () => {
    const host = createHost({ pageCount: 3, pageNumber: 1, rejectChanges: true });
    // 只读宿主不会提交状态；面板必须自行还原原生勾选，避免显示“已关闭”。
    const { tree } = createPanel(host);
    const row = pageRows(tree)[1];
    row.click();
    const backgroundBox = layerBoxes(row.nextElementSibling as HTMLElement).find(
      (box) => box.dataset.key === 'background',
    )!;
    expect(backgroundBox.checked).toBe(true);
    toggle(backgroundBox);
    expect(host.calls[0]).toEqual({ method: 'setPageLayer', args: [1, 'background', false] });
    expect(backgroundBox.checked).toBe(true);
    expect(backgroundBox.indeterminate).toBe(false);
    // 页面行总开关同样还原为全开。
    const rowBox = row.querySelector<HTMLInputElement>('input[data-key="all"]')!;
    toggle(rowBox);
    expect(rowBox.checked).toBe(true);
    expect(tree.parentElement?.getAttribute('data-state')).toBe('ready');
  });

  it('页面某层点击只改该页，其它页不受影响', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    const row = pageRows(tree)[0];
    row.click();
    const backgroundBox = layerBoxes(row.nextElementSibling as HTMLElement).find(
      (box) => box.dataset.key === 'background',
    )!;
    toggle(backgroundBox);
    expect(host.calls[0]).toEqual({ method: 'setPageLayer', args: [0, 'background', false] });
    expect(host.pages[0].background).toBe(false);
    expect(host.pages[1].background).toBe(true);
    expect(backgroundBox.checked).toBe(false);
  });
});

describe('图层面板：恢复默认与禁用', () => {
  it('恢复默认按钮调用宿主并保持展开状态', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    const allRow = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    allRow.click();
    pageRows(tree)[0].click();
    const pageRow = pageRows(tree)[1];
    pageRow.click();
    const allBox = tree.querySelector<HTMLInputElement>('[data-role="all"] input[data-key="all"]')!;
    toggle(allBox);
    expect(allBox.checked).toBe(false);

    const button = tree.parentElement!.querySelector<HTMLButtonElement>('.ofd-layers__restore')!;
    expect(button.title).toBe('恢复默认');
    expect(button.getAttribute('aria-label')).toBe('恢复默认');
    button.click();
    expect(host.calls.some((call) => call.method === 'resetLayerVisibility')).toBe(true);
    expect(allBox.checked).toBe(true);
    expect(allRow.getAttribute('aria-expanded')).toBe('true');
    expect(pageRow.getAttribute('aria-expanded')).toBe('true');
  });

  it('禁用宿主：复选框与按钮禁用并显示原因提示', () => {
    const host = createHost({ disabled: true });
    const { tree } = createPanel(host);
    const notice = tree.parentElement!.querySelector<HTMLElement>('.ofd-layers__notice')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe('宿主已禁用图层控制');
    expect(notice.getAttribute('role')).toBe('note');
    const button = tree.parentElement!.querySelector<HTMLButtonElement>('.ofd-layers__restore')!;
    expect(button.disabled).toBe(true);
    const allBox = tree.querySelector<HTMLInputElement>('[data-role="all"] input[data-key="all"]')!;
    expect(allBox.disabled).toBe(true);
    button.click();
    expect(host.calls.length).toBe(0);
  });

  it('空文档：pageCount=0 显示“本文档没有页面”，未打开显示提示', () => {
    const { tree } = createPanel(createEmptyHost('ready'));
    const root = tree.parentElement as HTMLElement;
    expect(tree.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.ofd-layers__empty')?.hidden).toBe(false);
    expect(root.querySelector('.ofd-layers__empty')?.textContent).toBe('本文档没有页面');

    const second = createPanel(createEmptyHost('closed'));
    expect(second.tree.parentElement?.querySelector('.ofd-layers__empty')?.textContent).toBe(
      '打开文档后可控制图层显示',
    );
  });
});

describe('图层面板：键盘与语言', () => {
  it('树内只有一个 tab stop，方向键在可见行间移动', () => {
    const { tree } = createPanel(createHost());
    const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    const allRow = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    allRow.focus();
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(pageRows(tree)[0]);
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(pageRows(tree)[2]);
  });

  it('ArrowRight 展开，ArrowLeft 收起，Space 切换复选框', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    const allRow = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    allRow.focus();
    // 先收起（当前页自动展开），再用 ArrowRight 展开。
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(allRow.getAttribute('aria-expanded')).toBe('true');
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(allRow.getAttribute('aria-expanded')).toBe('false');
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(allRow.getAttribute('aria-expanded')).toBe('true');
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    // Space 在折叠行上只展开，不切换复选框。
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(allRow.getAttribute('aria-expanded')).toBe('true');
    expect(host.calls).toHaveLength(0);
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(host.calls[0]).toEqual({ method: 'setAllLayersVisible', args: [false] });
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(allRow.getAttribute('aria-expanded')).toBe('false');
    allRow.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, altKey: true }));
    expect(host.calls[1]).toEqual({ method: 'setAllLayersVisible', args: [true] });
  });

  it('语言切换原地更新文案并保留展开状态', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    const allRow = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    allRow.click();
    host.setLocale('en-US');
    expect(tree.getAttribute('aria-label')).toBe('Layers');
    expect(allRow.getAttribute('aria-expanded')).toBe('true');
    expect(allRow.querySelector('.ofd-layers__label')?.textContent).toBe('All pages');
    expect(pageRows(tree)[0].querySelector('.ofd-layers__label')?.textContent).toBe('Page 1');
    const boxes = layerBoxes(allRow.nextElementSibling as HTMLElement);
    expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
      'Signatures',
      'Annotations',
      'Custom',
      'Foreground',
      'Body',
      'Background',
    ]);
  });

  it('destroy 后状态变化不再更新 DOM', () => {
    const host = createHost();
    const { panel, tree } = createPanel(host);
    const container = tree.parentElement as HTMLElement;
    panel.destroy();
    panels.splice(panels.indexOf(panel), 1);
    expect(container.querySelector('.ofd-layers')).toBeNull();
    expect(() => host.setPage(2)).not.toThrow();
  });
});

describe('图层面板：可见性映射', () => {
  it('页面行六项勾选与该页签名一致', () => {
    const host = createHost({ pageCount: 2 });
    writeFlag(host.pages[1], 'custom', false);
    const { tree } = createPanel(host);
    const row = pageRows(tree)[1];
    row.click();
    const boxes = layerBoxes(row.nextElementSibling as HTMLElement);
    expect(boxes.find((box) => box.dataset.key === 'custom')?.checked).toBe(false);
    expect(contentFilterKey(host.pages[1])).not.toBe('all');
  });
});

describe('图层面板：注释类型（§I.5 / §H.7）', () => {
  /** 读取某组的注释类型复选框。 */
  function typeBoxes(scope: ParentNode): HTMLInputElement[] {
    return [...scope.querySelectorAll<HTMLInputElement>('input[data-role="type"]')];
  }

  /** 展开某行的注释项类型组：先展开行，再点注释子行。 */
  function openTypeGroup(tree: HTMLElement, row: HTMLElement): HTMLElement {
    const group = row.nextElementSibling as HTMLElement;
    if (group.hidden) row.click();
    const annotationRow = [...group.querySelectorAll<HTMLElement>('[data-layer="annotations"]')][0];
    annotationRow.click();
    const typeGroup = annotationRow.nextElementSibling as HTMLElement;
    return typeGroup;
  }

  it('T15/T16 注释项可展开，类型行为常见五类且顺序固定', () => {
    const { tree } = createPanel(createHost({ pageNumber: 3 }));
    const row = pageRows(tree)[0];
    const group = row.nextElementSibling as HTMLElement;
    row.click();
    const annotationRow = group.querySelector<HTMLElement>('[data-layer="annotations"]')!;
    expect(annotationRow.getAttribute('aria-expanded')).toBe('false');
    annotationRow.click();
    expect(annotationRow.getAttribute('aria-expanded')).toBe('true');
    const typeGroup = annotationRow.nextElementSibling as HTMLElement;
    expect(typeGroup.hidden).toBe(false);
    expect(typeGroup.getAttribute('role')).toBe('group');
    expect(typeGroup.getAttribute('aria-level')).toBe('3');
    expect(typeGroup.getAttribute('aria-label')).toBe('注释类型');
    expect(typeBoxes(typeGroup).map((box) => box.dataset.type)).toEqual([
      'Link',
      'Path',
      'Highlight',
      'Stamp',
      'Watermark',
    ]);
  });

  it('T17/T18 缺类型的行淡色但仍可切换；常见五类本地化、追加类型用原值', () => {
    const host = createHost({ pageNumber: 3 });
    host.extraTypes.set(0, ['Signature']);
    const { tree } = createPanel(host);
    const typeGroup = openTypeGroup(tree, pageRows(tree)[0]);
    const watermark = typeBoxes(typeGroup).find((box) => box.dataset.type === 'Watermark')!;
    const row = watermark.closest<HTMLElement>('[role="treeitem"]')!;
    // 本页没有 Watermark 注释：淡色标记，但不禁用、不加 aria-disabled、不加提示。
    expect(row.dataset.empty).toBe('true');
    expect(watermark.disabled).toBe(false);
    expect(watermark.hasAttribute('aria-disabled')).toBe(false);
    expect(watermark.hasAttribute('title') && watermark.title !== '水印').toBe(false);
    expect(typeBoxes(typeGroup).map((box) => box.getAttribute('aria-label'))).toEqual([
      '链接',
      '路径',
      '高亮',
      '印章',
      '水印',
      'Signature',
    ]);
    // 点击仍生效。
    const before = host.calls.length;
    toggle(watermark);
    expect(host.calls.slice(before)[0]).toEqual({
      method: 'setAnnotationTypeForPage',
      args: [0, 'Watermark', false],
    });
  });

  it('T19 页面行类型复选框只有两态（永不 mixed）', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    host.pages[1] = {
      ...host.pages[1],
      annotations: { enabled: true, types: { Stamp: false } },
    };
    host.setPage(1);
    const pageGroup = openTypeGroup(tree, pageRows(tree)[0]);
    const pageStamp = typeBoxes(pageGroup).find((box) => box.dataset.type === 'Stamp')!;
    expect(pageStamp.checked).toBe(true);
    expect(pageStamp.indeterminate).toBe(false);
    host.setPage(2);
    const second = openTypeGroup(tree, pageRows(tree)[1]);
    const secondStamp = typeBoxes(second).find((box) => box.dataset.type === 'Stamp')!;
    expect(secondStamp.checked).toBe(false);
    expect(secondStamp.indeterminate).toBe(false);
    expect(secondStamp.getAttribute('aria-checked')).toBe('false');
  });

  it('T20/T36 总项不显示注释类型（类型只在每页显示）', () => {
    const host = createHost();
    host.pages[0] = { ...host.pages[0], annotations: { enabled: true, types: { Stamp: false } } };
    const { tree } = createPanel(host);
    const all = tree.querySelector<HTMLElement>('[data-role="all"]')!;
    all.click();
    const group = all.nextElementSibling as HTMLElement;
    const annotationRow = group.querySelector<HTMLElement>('[data-layer="annotations"]')!;
    expect(annotationRow.hasAttribute('aria-expanded')).toBe(false);
    // 注释子行后面紧跟的是“自定义”，没有类型分组。
    expect(group.querySelectorAll('.ofd-layers__group--types')).toHaveLength(0);
    expect(group.querySelectorAll('input[data-role="type"]')).toHaveLength(0);
    expect(layerBoxes(group).map((box) => box.dataset.key)).toEqual([...PAGE_LAYER_KEYS]);
  });

  it('T21/T23 总开关关闭时类型显示为关但不改类型表，重新打开恢复', () => {
    const host = createHost();
    host.pages[0] = { ...host.pages[0], annotations: { enabled: true, types: { Link: false } } };
    const { tree } = createPanel(host);
    const typeGroup = openTypeGroup(tree, pageRows(tree)[0]);
    const link = typeBoxes(typeGroup).find((box) => box.dataset.type === 'Link')!;
    expect(link.checked).toBe(false);
    // 关闭注释总开关：存储的类型表不变，显示为关。
    const group = pageRows(tree)[0].nextElementSibling as HTMLElement;
    const annotationBox = group.querySelector<HTMLInputElement>('input[data-key="annotations"]')!;
    toggle(annotationBox);
    expect(host.calls[0]).toEqual({ method: 'setPageLayer', args: [0, 'annotations', false] });
    expect(host.pages[0].annotations).toEqual({ enabled: false, types: { Link: false } });
    expect(link.checked).toBe(false);
    // 重新打开：Link 仍为关，其它恢复为开。
    toggle(annotationBox);
    expect(host.pages[0].annotations.enabled).toBe(true);
    expect(link.checked).toBe(false);
  });

  it('T22 页面组类型只改该页，不影响其它页（总项不再批量改类型）', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    const typeGroup = openTypeGroup(tree, pageRows(tree)[2]);
    const link = typeBoxes(typeGroup).find((box) => box.dataset.type === 'Link')!;
    toggle(link);
    expect(host.calls.find((call) => call.method === 'setAnnotationTypeForPage')).toEqual({
      method: 'setAnnotationTypeForPage',
      args: [2, 'Link', false],
    });
    expect(host.pages[0].annotations.types).toEqual({});
    expect(host.pages[2].annotations.types).toEqual({ Link: false });
  });

  it('T24 恢复默认后类型勾选回到默认值且保持展开', () => {
    const host = createHost();
    host.pages[0] = { ...host.pages[0], annotations: { enabled: true, types: { Path: false } } };
    const { tree } = createPanel(host);
    const typeGroup = openTypeGroup(tree, pageRows(tree)[0]);
    const path = typeBoxes(typeGroup).find((box) => box.dataset.type === 'Path')!;
    expect(path.checked).toBe(false);
    const button = tree.parentElement!.querySelector<HTMLButtonElement>('.ofd-layers__restore')!;
    button.click();
    expect(path.checked).toBe(true);
    const annotationRow = (pageRows(tree)[0].nextElementSibling as HTMLElement).querySelector<HTMLElement>(
      '[data-layer="annotations"]',
    )!;
    expect(annotationRow.getAttribute('aria-expanded')).toBe('true');
  });

  it('T37 零页 / 未打开文档不出现任何类型复选框', () => {
    const ready = createPanel(createEmptyHost('ready'));
    expect(ready.tree.querySelectorAll('input[data-role="type"]')).toHaveLength(0);
    expect(ready.tree.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    const closed = createPanel(createEmptyHost('closed'));
    expect(closed.tree.querySelectorAll('input[data-role="type"]')).toHaveLength(0);
    expect(closed.tree.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
  });

  it('T38 缺类型的页面仍显示复选框，逐页切换互不影响', () => {
    const host = createHost();
    const { tree } = createPanel(host);
    // 第 3 页没有 Watermark：展开仍能看到复选框（淡色）。
    const third = openTypeGroup(tree, pageRows(tree)[2]);
    const thirdWatermark = typeBoxes(third).find((box) => box.dataset.type === 'Watermark')!;
    expect(thirdWatermark.closest<HTMLElement>('[role="treeitem"]')!.dataset.empty).toBe('true');
    // 在第 1 页取消 Watermark：只改第 1 页，第 3 页不变。
    const first = openTypeGroup(tree, pageRows(tree)[0]);
    const firstWatermark = typeBoxes(first).find((box) => box.dataset.type === 'Watermark')!;
    toggle(firstWatermark);
    expect(host.calls[0]).toEqual({
      method: 'setAnnotationTypeForPage',
      args: [0, 'Watermark', false],
    });
    expect(firstWatermark.checked).toBe(false);
    expect(thirdWatermark.checked).toBe(true);
  });

  it('语言切换后类型文案本地化、追加类型保持原值', () => {
    const host = createHost();
    host.extraTypes.set(0, ['Signature']);
    const { tree } = createPanel(host);
    const typeGroup = openTypeGroup(tree, pageRows(tree)[0]);
    host.setLocale('en-US');
    expect(typeGroup.getAttribute('aria-label')).toBe('Annotation types');
    expect(typeBoxes(typeGroup).map((box) => box.getAttribute('aria-label'))).toEqual([
      'Link',
      'Path',
      'Highlight',
      'Stamp',
      'Watermark',
      'Signature',
    ]);
    expect(typeGroup.querySelectorAll('input[data-role="type"]')).toHaveLength(6);
  });
});

describe('大文档刷新短路（statechange 不逐页重算）', () => {
  it('同一图层快照的滚动/翻页不读任何页状态；图层写入后仍全量刷新一次', () => {
    const host = createHost({ pageCount: 1000 });
    const { tree } = createPanel(host);
    const readPageState = host.readPageState;
    const readAnnotationTypes = host.readAnnotationTypes;
    let pageReads = 0;
    let typeReads = 0;
    host.readPageState = (index) => {
      pageReads += 1;
      return readPageState(index);
    };
    host.readAnnotationTypes = (index) => {
      typeReads += 1;
      return readAnnotationTypes(index);
    };
    pageReads = 0;
    typeReads = 0;
    const started = Date.now();
    host.setPage(500);
    host.setPage(2);
    host.setPage(700);
    const scrollCost = Date.now() - started;
    // 滚动/翻页只改当前页：每次最多读当前页一次（自动展开），绝不逐页扫全表。
    expect(pageReads).toBe(3);
    // 注释项“有效开”需要本页类型表，每次翻页也只读当前页一次。
    expect(typeReads).toBe(3);
    expect(tree.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    // 图层写入会换新快照，三态必须全量刷新（1000 页各读一次）。
    pageReads = 0;
    host.setPageLayer(0, 'background', false);
    expect(pageReads).toBe(1000);
    // 仅记录成本，不做严格性能断言（覆盖 1000 页用例本身）。
    expect(scrollCost).toBeLessThan(1000);
  });
});
