/**
 * 侧栏标签图标与溢出模式单测（设计方案 §D.6 / §H.2）。
 *
 * 直接构造 `Sidebar`，通过 `readTabListWidth` 注入可用宽度、用
 * `getBoundingClientRect` 注入各标签最小宽度；溢出自动重判使用可控的
 * `ResizeObserver` 替身，避免依赖 jsdom 布局。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFeatureStates } from '../../../src/features';
import { createTranslator } from '../../../src/i18n';
import { createInitialViewerState } from '../../../src/state';
import type { SidebarView } from '../../../src/state';
import { Sidebar } from '../../../src/ui/sidebar';
import type { SidebarOptions } from '../../../src/ui/sidebar';
import { TAB_ICONS } from '../../../src/ui/icons';
import { SIDEBAR_VIEWS } from '../../../src/state';

/** 已创建的侧栏；每个用例结束统一销毁。 */
const sides: Sidebar[] = [];

afterEach(() => {
  for (const side of sides.splice(0)) side.destroy();
  document.body.innerHTML = '';
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  vi.restoreAllMocks();
});

/** 创建侧栏。 */
function createSidebar(options: Partial<SidebarOptions> = {}): Sidebar {
  const root = document.createElement('div');
  const mask = document.createElement('div');
  document.body.append(root, mask);
  const sidebar = new Sidebar({
    element: root,
    mask,
    translator: createTranslator('zh-CN'),
    featureStates: resolveFeatureStates(),
    view: null,
    idPrefix: 'test',
    manageVisibility: true,
    getState: () => {
      const state = createInitialViewerState();
      return {
        pageNumber: state.view.pageNumber,
        pageCount: state.document.pageCount,
        scale: state.view.scale,
        zoomMode: state.view.zoomMode,
        rotation: state.view.rotation,
        sidebarView: state.view.sidebarView,
        fullscreen: false,
        find: state.view.findState,
        theme: state.ui.theme,
        locale: state.ui.locale,
      };
    },
    onOpenView: () => undefined,
    onCloseRequest: () => undefined,
    ...options,
  });
  sides.push(sidebar);
  return sidebar;
}

/** 读取标签行。 */
function tabList(sidebar: Sidebar): HTMLElement {
  const element = sidebar.element.querySelector<HTMLElement>('.ofd-sidebar__tabs');
  if (!element) throw new Error('缺少标签行');
  return element;
}

/** 当前 6 个标签在“图标+文字”下的内容宽度（jsdom 无布局，按字数估算，单位 px）。 */
const ZH_FULL_WIDTH = 374;

describe('侧栏标签：图标与名称', () => {
  it('每个视图都有图标与文字节点，顺序以 SIDEBAR_VIEWS 为准', () => {
    const sidebar = createSidebar();
    const tabs = [...tabList(sidebar).querySelectorAll<HTMLButtonElement>('.ofd-sidebar__tab')];
    expect(tabs.map((tab) => tab.dataset.view)).toEqual([...SIDEBAR_VIEWS]);
    expect(tabs.map((tab) => tab.dataset.view)).toEqual([
      'thumbnails',
      'outline',
      'bookmarks',
      'signatures',
      'attachments',
      'layers',
    ]);
    for (const tab of tabs) {
      const svg = tab.querySelector('svg.ofd-icon');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg?.getAttribute('width')).toBe('16');
      expect(svg?.getAttribute('height')).toBe('16');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(tab.querySelector('.ofd-sidebar__tab-label')).not.toBeNull();
    }
    expect(TAB_ICONS.layers).toBe('layers');
  });

  it('图层标签默认出现，title / aria-label / 文字三处为完整名称', () => {
    const sidebar = createSidebar();
    const tab = sidebar.getTab('layers');
    expect(tab).not.toBeNull();
    expect(tab?.hidden).toBe(false);
    expect(tab?.title).toBe('图层');
    expect(tab?.getAttribute('aria-label')).toBe('图层');
    expect(tab?.querySelector('.ofd-sidebar__tab-label')?.textContent).toBe('图层');
  });

  it('enabled=false 时不渲染图层标签，其它标签不受影响', () => {
    const sidebar = createSidebar({ layerPanel: { enabled: false, disabled: false } });
    expect(sidebar.getTab('layers')?.hidden).toBe(true);
    expect(sidebar.getTab('thumbnails')?.hidden).toBe(false);
    sidebar.setView('layers');
    expect(sidebar.currentView).toBeNull();
  });

  it('disabled=true 时标签保留、禁用并带原因提示', () => {
    const sidebar = createSidebar({ layerPanel: { enabled: true, disabled: true } });
    const tab = sidebar.getTab('layers');
    expect(tab?.hidden).toBe(false);
    expect(tab?.disabled).toBe(true);
    expect(tab?.getAttribute('aria-disabled')).toBe('true');
    expect(tab?.getAttribute('data-feature-disabled')).toBe('true');
    expect(tab?.title).toBe('宿主已禁用图层控制');
    expect(tab?.querySelector('.ofd-sidebar__tab-label')?.textContent).toBe('图层');
  });

  it('enabled 与 disabled 同时为真时 disabled 优先', () => {
    const sidebar = createSidebar({ layerPanel: { enabled: true, disabled: true } });
    expect(sidebar.getTab('layers')?.hidden).toBe(false);
    expect(sidebar.getTab('layers')?.disabled).toBe(true);
  });

  it('语言切换后 title / aria-label / 文字同步更新', () => {
    const sidebar = createSidebar();
    sidebar.setLocale(createTranslator('en-US'));
    const tab = sidebar.getTab('layers');
    expect(tab?.title).toBe('Layers');
    expect(tab?.getAttribute('aria-label')).toBe('Layers');
    expect(tab?.querySelector('.ofd-sidebar__tab-label')?.textContent).toBe('Layers');
    expect(sidebar.getTab('thumbnails')?.title).toBe('Thumbnails');
  });
});

describe('侧栏标签：溢出仅图标模式', () => {
  it('默认宽度足够时为图标+文字，窗口变窄后整行切为仅图标，恢复后切回', () => {
    let width = 600;
    const sidebar = createSidebar({ readTabListWidth: () => width });
    sidebar.setMode('inline');
    expect(tabList(sidebar).dataset.mode).toBe('full');
    expect(ZH_FULL_WIDTH).toBeLessThan(600);

    width = 180;
    // 无 ResizeObserver 时由降级路径的 resize 监听重判。
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('icons');
    // 仅图标模式下文字节点仍在 DOM 中，名称由 title / aria-label 提供。
    for (const view of SIDEBAR_VIEWS) {
      const tab = sidebar.getTab(view);
      expect(tab?.getAttribute('aria-label')).toBe(tab?.title);
      expect(tab?.querySelector('.ofd-sidebar__tab-label')).not.toBeNull();
    }

    width = 600;
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('full');
  });

  it('不注入宽度时按 clientWidth 实测判断', () => {
    const sidebar = createSidebar();
    const list = tabList(sidebar);
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 180 });
    list.ownerDocument.defaultView?.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('icons');
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 600 });
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('full');
  });

  it('隐藏的标签不参与溢出判定', () => {
    let width = 240;
    const sidebar = createSidebar({ readTabListWidth: () => width });
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('icons');

    sidebar.setFeatureStates(resolveFeatureStates({ attachments: false, bookmarks: false, outline: false }));
    expect(sidebar.getTab('attachments')?.hidden).toBe(true);
    // 剩下 3 个标签的文字合计 98 + 3 × 32 = 194 ≤ 240，不再溢出。
    expect(sidebar.tabMode).toBe('full');
    width = 180;
    sidebar.setFeatureStates(resolveFeatureStates({ attachments: false, bookmarks: false, outline: false }));
    expect(sidebar.tabMode).toBe('icons');
  });

  it('打开侧栏时按当前真实宽度重判一次（不依赖 ResizeObserver）', () => {
    let width = 180;
    const sidebar = createSidebar({ readTabListWidth: () => width });
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('icons');
    // 收起状态下宽度可能不可测；打开时必须以真实宽度重判，否则会永久停在仅图标。
    width = 600;
    sidebar.setView('layers');
    expect(sidebar.isOpen).toBe(true);
    expect(sidebar.tabMode).toBe('full');
  });

  it('文字节点不可测（侧栏收起 / 已处于仅图标）时仍能按文字宽度切回', () => {
    let width = 180;
    const sidebar = createSidebar({ readTabListWidth: () => width });
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('icons');
    // 仅图标模式下 label 不参与布局，实测 scrollWidth 为 0；判定必须不受影响。
    for (const view of SIDEBAR_VIEWS) {
      const label = sidebar.getTab(view)?.querySelector<HTMLElement>('.ofd-sidebar__tab-label');
      if (label) Object.defineProperty(label, 'scrollWidth', { configurable: true, value: 0 });
    }
    width = 600;
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.tabMode).toBe('full');
  });

  it('无任何布局事件时，打开期间的轮询仍能按新宽度切换（纯 CSS 改宽）', () => {
    vi.useFakeTimers();
    try {
      let width = 180;
      const sidebar = createSidebar({ readTabListWidth: () => width });
      window.dispatchEvent(new Event('resize'));
      expect(sidebar.tabMode).toBe('icons');
      sidebar.setView('layers');
      expect(sidebar.isOpen).toBe(true);
      // 宿主只改 CSS 变量、不派发 resize；靠侧栏打开期间的复核兜住。
      width = 600;
      vi.advanceTimersByTime(300);
      expect(sidebar.tabMode).toBe('full');
      width = 180;
      vi.advanceTimersByTime(300);
      expect(sidebar.tabMode).toBe('icons');
      // 收起后停止复核。
      sidebar.setView(null);
      const calls = vi.getTimerCount();
      expect(calls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ResizeObserver 存在时接管自动重判，destroy 后断开且不挂 resize 监听', () => {
    const observers: Array<{
      callback: ResizeObserverCallback;
      disconnect: ReturnType<typeof vi.fn>;
      observed: Element[];
      trigger: () => void;
    }> = [];
    class FakeResizeObserver {
      readonly observed: Element[] = [];
      readonly close = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push({
          callback,
          disconnect: this.close,
          observed: this.observed,
          trigger: () => callback([], this as unknown as ResizeObserver),
        });
      }
      private readonly callback: ResizeObserverCallback;
      observe(target: Element): void {
        this.observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        this.close();
      }
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    const addListener = vi.spyOn(window, 'addEventListener');
    let width = 600;
    const sidebar = createSidebar({ readTabListWidth: () => width });
    expect(observers).toHaveLength(1);
    // 观察标签行、侧栏本身与每个标签按钮。
    expect(observers[0].observed.length).toBe(2 + SIDEBAR_VIEWS.length);
    expect(tabList(sidebar).dataset.mode).toBe('full');

    width = 180;
    observers[0].trigger();
    expect(sidebar.tabMode).toBe('icons');

    sidebar.destroy();
    sides.splice(sides.indexOf(sidebar), 1);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(addListener.mock.calls.some(([type]) => type === 'resize')).toBe(false);
  });

  it('侧栏整体关闭时图层标签同样隐藏', () => {
    const sidebar = createSidebar({ featureStates: resolveFeatureStates({ sidebar: false }) });
    expect(sidebar.getTab('layers')?.hidden).toBe(true);
    expect(sidebar.getTab('thumbnails')?.hidden).toBe(true);
  });
});
