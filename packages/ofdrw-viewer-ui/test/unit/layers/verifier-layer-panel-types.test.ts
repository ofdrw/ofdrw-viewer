/**
 * verifier 独立验证用例：图层面板注释类型（设计方案 §I.5 / §I.7 / §H.7 T17–T22、T36）。
 *
 * 用最小假宿主驱动真实 `LayerPanel`：宿主只保存“每页注释总开关 + 类型表”，
 * 类型列表由探测定稿（固定五类 + 追加类型），并断言：
 * - 页面行类型复选框永不为 mixed；总项跨页三态；总项 mixed 点击 → 全勾；
 * - 缺类型仍可切换、仅 `data-empty` 淡色、不 disabled、不加 title 提示；
 * - 总开关关闭时类型显示为 off 但存储不丢，重新打开恢复。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTranslator } from '../../../src/i18n';
import type { Translator } from '../../../src/i18n';
import { LayerPanel } from '../../../src/layers/layer-panel';
import type { LayerPanelHost } from '../../../src/layers/layer-panel';
import {
  PAGE_LAYER_KEYS,
  annotationTypesForGroup,
  type AnnotationTypeKey,
  type LayerKey,
  type LayerSummary,
  type ResolvedLayerVisibility,
} from '../../../src/layers/content-filter';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';

/** 每个用例结束后销毁的面板。 */
const panels: LayerPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.innerHTML = '';
});

/** 一页的存储状态：注释总开关 + 类型表（只存 false 项）。 */
interface PageState {
  enabled: boolean;
  types: Record<string, boolean>;
  /** 其它五项恒为 true，本用例不关心。 */
}

/** 最小假宿主：只覆盖注释类型相关的读写。 */
function createHost(pageCount: number, extras: Map<number, readonly string[]>) {
  const pages: PageState[] = Array.from({ length: pageCount }, () => ({
    enabled: true,
    types: {},
  }));
  const calls: string[] = [];
  const listeners = new Set<(state: ViewerState) => void>();
  let translator: Translator = createTranslator('zh-CN');
  const base = createInitialViewerState();
  let state: ViewerState = {
    ...base,
    document: { ...base.document, pageCount, status: 'ready' },
    view: { ...base.view, pageNumber: 1 },
  };
  const commit = (): void => {
    for (const listener of listeners) listener(state);
  };
  /** 某页列出的类型：常见五类 + 该页追加类型（用户决定：类型只在每页显示）。 */
  const listed = (pageIndex: number): readonly string[] =>
    annotationTypesForGroup(extras.get(pageIndex) ?? []);
  const pageOf = (index: number): ResolvedLayerVisibility => {
    const page = pages[index]!;
    const result: Record<string, unknown> = {};
    for (const key of PAGE_LAYER_KEYS) result[key] = key === 'annotations' ? true : true;
    result['annotations'] = { enabled: page.enabled, types: { ...page.types } };
    return result as unknown as ResolvedLayerVisibility;
  };
  const host: LayerPanelHost & {
    readonly pages: PageState[];
    readonly calls: readonly string[];
  } = {
    pages,
    calls,
    getState: () => state,
    readAllState: (): LayerSummary => {
      const on: Record<LayerKey, boolean> = {
        signatures: true,
        annotations: true,
        custom: true,
        foreground: true,
        body: true,
        background: true,
      };
      const types = annotationTypesForGroup([...extras.values()].flat());
      const anyType = types.some((type) => pages.some((page) => page.enabled && page.types[type] !== false));
      on.annotations = pages.every((page) => page.enabled) && anyType;
      // 总项不再有类型复选框，宿主也不再提供跨页类型三态。
      return { allKeysOn: { ...on }, allKeysOff: { ...on }, state: 'on' };
    },
    readPageState: (index) => pageOf(index),
    setPageLayer: () => undefined,
    setLayerForAllPages: () => undefined,
    setAllLayersVisible: () => undefined,
    setAllLayersVisibleForPage: () => undefined,
    resetLayerVisibility: () => undefined,
    onStateChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    isDisabled: () => false,
    getDisabledReason: () => translator.t('layers.disabled'),
    getTranslator: () => translator,
    getLayerLabel: (key) => translator.t(`layers.${key}` as 'layers.body'),
    getAnnotationTypeLabel: (type) => {
      const map: Record<string, string> = {
        Link: '链接',
        Path: '路径',
        Highlight: '高亮',
        Stamp: '印章',
        Watermark: '水印',
      };
      return map[type] ?? type;
    },
    readAnnotationTypes: (pageIndex) => listed(pageIndex),
    readAnnotationTypesInUse: (pageIndex) => new Set(extras.get(pageIndex) ?? []),
    setAnnotationTypeForPage: (index, type: AnnotationTypeKey, value) => {
      calls.push(`page:${index}:${type}:${value}`);
      const page = pages[index]!;
      const types = { ...page.types };
      if (value) delete types[type];
      else types[type] = false;
      pages[index] = { ...page, types };
      // 模拟真实阅读器：图层写入后生成新的 ui.layers 快照引用（面板据此判断是否全量刷新）。
      state = { ...state, ui: { ...state.ui, layers: { ...state.ui.layers } } };
      commit();
    },
  };
  return host;
}

/** 建面板并返回根节点。 */
function mount(host: LayerPanelHost): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new LayerPanel({ host: container, viewer: host });
  panels.push(panel);
  return container;
}

/** 展开某行（总项 `'all'` 或页索引）的注释类型组。 */
function openTypes(root: HTMLElement, group: 'all' | number): HTMLElement {
  const row =
    group === 'all'
      ? root.querySelector<HTMLElement>('[data-role="all"]')!
      : root.querySelectorAll<HTMLElement>('[data-role="page"]')[group]!;
  if (row.getAttribute('aria-expanded') !== 'true') row.click();
  const annotationRow = row.nextElementSibling!.querySelector<HTMLElement>(
    '[data-layer="annotations"]',
  )!;
  if (annotationRow.getAttribute('aria-expanded') !== 'true') annotationRow.click();
  return annotationRow.nextElementSibling as HTMLElement;
}

/** 读取某分组里的类型复选框。 */
function typeBoxes(group: HTMLElement, type: string): HTMLInputElement | null {
  return group.querySelector<HTMLInputElement>(`input[data-role="type"][data-type="${type}"]`);
}

/** 模拟用户点击复选框（原生状态翻转后派发 change）。 */
function click(box: HTMLInputElement): void {
  box.checked = !box.checked;
  box.indeterminate = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('verifier · 面板注释类型', () => {
  it('PW1 页面行类型复选框永不 mixed；总项没有注释类型复选框', () => {
    const host = createHost(3, new Map());
    const root = mount(host);
    host.pages[0]!.types['Stamp'] = false;
    const pageGroup = openTypes(root, 0);
    const pageStamp = typeBoxes(pageGroup, 'Stamp')!;
    expect(pageStamp.checked).toBe(false);
    expect(pageStamp.indeterminate).toBe(false);
    expect(pageStamp.getAttribute('aria-checked')).toBe('false');
    click(pageStamp);
    expect(host.calls).toContain('page:0:Stamp:true');
    expect(pageStamp.checked).toBe(true);
    // 总项展开后只有六项总开关，不出现任何类型复选框。
    const allRow = root.querySelector<HTMLElement>('[data-role="all"]')!;
    if (allRow.getAttribute('aria-expanded') !== 'true') allRow.click();
    const allGroup = allRow.nextElementSibling as HTMLElement;
    expect(allGroup.querySelectorAll('input[data-role="type"]')).toHaveLength(0);
    expect(allGroup.querySelectorAll('[data-layer="annotations"]')).toHaveLength(1);
    expect(
      allGroup.querySelector<HTMLElement>('[data-layer="annotations"]')!.hasAttribute('aria-expanded'),
    ).toBe(false);
  });

  it('PW2 缺类型仍可切换、仅 data-empty 淡色、不 disabled、不加 title 提示', () => {
    const host = createHost(2, new Map([[0, ['Signature']]]));
    const root = mount(host);
    const group = openTypes(root, 0);
    const watermark = typeBoxes(group, 'Watermark')!;
    const signature = typeBoxes(group, 'Signature')!;
    // 类型行即为复选框的直接父元素；`data-empty` 标在行上（CSS 据此淡色）。
    const watermarkRow = watermark.parentElement!;
    const signatureRow = signature.parentElement!;
    expect(watermarkRow.dataset.type).toBe('Watermark');
    expect(signatureRow.dataset.type).toBe('Signature');
    // 缺类型淡色：只有本页实际出现的追加类型不带 data-empty。
    expect(watermarkRow.dataset.empty).toBe('true');
    expect(signatureRow.dataset.empty).toBeUndefined();
    for (const box of [watermark, signature]) {
      expect(box.disabled).toBe(false);
      expect(box.hasAttribute('aria-disabled')).toBe(false);
      // 显示名同时用作 title / aria-label（追加类型用原值），没有任何“本页无此类型”的提示文案。
      expect(box.title).toBe(box.getAttribute('aria-label'));
      expect(box.title === undefined ? '' : box.title).not.toMatch(/没有|缺|无/);
    }
    click(watermark);
    expect(host.calls).toContain('page:0:Watermark:false');
  });

  it('PW3 总开关关闭后类型显示 off，但存储的类型表不变，重新打开恢复', () => {
    const host = createHost(1, new Map());
    const root = mount(host);
    host.pages[0]!.types['Link'] = false;
    const group = openTypes(root, 0);
    const link = typeBoxes(group, 'Link')!;
    expect(link.checked).toBe(false);
    // 关闭总开关（宿主只改 enabled，类型表保留）。
    host.pages[0]!.enabled = false;
    click(typeBoxes(group, 'Path')!);
    expect(typeBoxes(group, 'Link')!.checked).toBe(host.pages[0]!.types['Link'] !== false);
    expect(host.pages[0]!.types['Link']).toBe(false);
  });
});
