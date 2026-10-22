/**
 * 内置 UI 与核心的结构化接线（不依赖 src/viewer.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFeatureStates } from '../../../src/features';
import { createFindState, createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import { attachUIShell, getUIShell } from '../../../src/ui';
import type { UIShellHost } from '../../../src/ui';
import { cleanupShells, createRoot, setClientWidth } from './helpers';

afterEach(() => {
  cleanupShells();
});

interface FakeHost extends UIShellHost {
  readonly calls: string[];
  emit(event: string): void;
  setState(next: ViewerState): void;
  offCount(): number;
}

function createFakeHost(width = 1280): FakeHost {
  const root = createRoot(width);
  const toolbar = document.createElement('div');
  toolbar.className = 'ofd-viewer__toolbar';
  const body = document.createElement('div');
  body.className = 'ofd-viewer__body';
  const sidebar = document.createElement('div');
  sidebar.className = 'ofd-viewer__sidebar';
  const mask = document.createElement('div');
  mask.className = 'ofd-viewer__sidebar-mask';
  const main = document.createElement('div');
  main.className = 'ofd-viewer__main';
  const findbar = document.createElement('div');
  findbar.className = 'ofd-viewer__findbar';
  body.append(sidebar, mask, main, findbar);
  const dialogLayer = document.createElement('div');
  dialogLayer.className = 'ofd-viewer__dialog-layer';
  const toastLayer = document.createElement('div');
  toastLayer.className = 'ofd-viewer__toast-layer';
  root.append(toolbar, body, dialogLayer, toastLayer);

  let state: ViewerState = {
    ...createInitialViewerState(),
    document: { ...createInitialViewerState().document, pageCount: 10 },
    view: { ...createInitialViewerState().view, findState: createFindState() },
  };
  const handlers = new Map<string, Set<() => void>>();
  const calls: string[] = [];
  const record = (name: string) => {
    calls.push(name);
  };

  return {
    calls,
    getElements: () => ({
      root,
      toolbar,
      body,
      sidebar,
      sidebarMask: mask,
      main,
      findbar,
      dialogLayer,
      toastLayer,
    }),
    getState: () => state,
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      const stored = handler as unknown as () => void;
      set.add(stored);
      return () => set?.delete(stored);
    },
    emit(event) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    setState(next) {
      state = next;
    },
    offCount() {
      let total = 0;
      for (const set of handlers.values()) total += set.size;
      return total;
    },
    toggleSidebar() {
      record('toggleSidebar');
    },
    openSidebar(view) {
      record(`openSidebar:${view}`);
    },
    closeSidebar() {
      record('closeSidebar');
    },
    goToPage(pageNumber) {
      record(`goToPage:${pageNumber}`);
    },
    nextPage() {
      record('nextPage');
    },
    previousPage() {
      record('previousPage');
    },
    zoomIn() {
      record('zoomIn');
    },
    zoomOut() {
      record('zoomOut');
    },
    setScale(scale) {
      record(`setScale:${scale}`);
    },
    setZoomMode(mode) {
      record(`setZoomMode:${mode}`);
    },
    rotateClockwise() {
      record('rotateClockwise');
    },
    find(query, options) {
      record(`find:${query}:${options?.caseSensitive}:${options?.wholeWord}`);
      return Promise.resolve();
    },
    findNext() {
      record('findNext');
    },
    findPrevious() {
      record('findPrevious');
    },
    clearFind() {
      record('clearFind');
    },
    print() {
      record('print');
      return Promise.resolve();
    },
    exportImage() {
      record('exportImage');
      return Promise.resolve();
    },
    setFullscreen(value) {
      record(`setFullscreen:${value}`);
      return Promise.resolve();
    },
  };
}

describe('内置 UI 接线', () => {
  it('把工具栏/查找命令映射到核心方法', () => {
    const host = createFakeHost();
    const dispose = attachUIShell(host);
    const shell = getUIShell(host);
    expect(shell).toBeDefined();
    expect(shell!.getState().pageCount).toBe(10);

    (shell!.toolbar.getControl('nextPage') as HTMLButtonElement).click();
    expect(host.calls).toContain('nextPage');
    host.setState({
      ...host.getState(),
      view: { ...host.getState().view, pageNumber: 2 },
    });
    host.emit('statechange');
    (shell!.toolbar.getControl('previousPage') as HTMLButtonElement).click();
    expect(host.calls).toContain('previousPage');
    (shell!.toolbar.getControl('rotate') as HTMLButtonElement).click();
    expect(host.calls).toContain('rotateClockwise');
    (shell!.toolbar.getControl('fullscreen') as HTMLButtonElement).click();
    expect(host.calls).toContain('setFullscreen:true');
    (shell!.toolbar.getControl('print') as HTMLButtonElement).click();
    expect(host.calls).toContain('print');
    (shell!.toolbar.getControl('export') as HTMLButtonElement).click();
    expect(host.calls).toContain('exportImage');
    (shell!.toolbar.getControl('signatures') as HTMLButtonElement).click();
    expect(host.calls).toContain('openSidebar:signatures');

    const pageInput = shell!.toolbar.getControl('pageNumber') as HTMLInputElement;
    pageInput.value = '4';
    pageInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(host.calls).toContain('goToPage:4');

    const zoom = shell!.toolbar.getControl('zoomMode') as HTMLSelectElement;
    zoom.value = 'page-fit';
    zoom.dispatchEvent(new Event('change'));
    expect(host.calls).toContain('setZoomMode:page-fit');
    zoom.value = 'scale:2';
    zoom.dispatchEvent(new Event('change'));
    expect(host.calls).toContain('setScale:2');

    (shell!.toolbar.getControl('find') as HTMLButtonElement).click();
    const findInput = shell!.elements.findbar.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    expect(findInput).not.toBeNull();
    findInput!.value = '合同';
    findInput!.dispatchEvent(new Event('input'));
    expect(host.calls).toContain('find:合同:false:false');
    findInput!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(host.calls).toContain('findNext');
    findInput!.value = '';
    findInput!.dispatchEvent(new Event('input'));
    expect(host.calls).toContain('clearFind');

    const sidebarToggle = shell!.toolbar.getSidebarButton();
    sidebarToggle.click();
    expect(host.calls).toContain('openSidebar:thumbnails');
    dispose();
  });

  it('核心状态/功能/侧栏/查找事件反向刷新外壳', () => {
    const host = createFakeHost();
    const dispose = attachUIShell(host);
    const shell = getUIShell(host)!;
    const pageInput = shell.toolbar.getControl('pageNumber') as HTMLInputElement;
    const print = shell.toolbar.getControl('print') as HTMLButtonElement;
    expect(print.disabled).toBe(false);

    host.setState({
      ...host.getState(),
      document: { ...host.getState().document, pageCount: 20 },
      view: {
        ...host.getState().view,
        pageNumber: 5,
        scale: 2,
        rotation: 90,
        sidebarView: 'outline',
      },
      ui: { ...host.getState().ui, features: resolveFeatureStates() },
    });
    host.emit('statechange');
    expect(pageInput.value).toBe('5');
    expect(pageInput.max).toBe('20');
    expect((shell.toolbar.getControl('zoomMode') as HTMLSelectElement).value).toBe(
      'scale:2',
    );
    expect(print.disabled).toBe(false);
    expect(shell.toolbar.getSidebarButton().getAttribute('aria-expanded')).toBe('true');
    expect(shell.sidebar.currentView).toBe('outline');

    host.setState({
      ...host.getState(),
      ui: {
        ...host.getState().ui,
        features: resolveFeatureStates({ print: false }, {}, { print: 'disable' }),
      },
    });
    host.emit('featureschange');
    expect(print.disabled).toBe(true);
    expect(print.title).toContain('打印不可用');

    host.setState({
      ...host.getState(),
      view: {
        ...host.getState().view,
        findState: { ...createFindState(), query: '合同', current: 1, total: 2 },
      },
    });
    host.emit('findmatches');
    expect(shell.elements.findbar.textContent).toContain('1 / 2');
    dispose();
  });

  it('文档属性菜单打开本地对话框，销毁时解绑事件', () => {
    const host = createFakeHost(400);
    const dispose = attachUIShell(host);
    const shell = getUIShell(host)!;
    const properties = shell.elements.toolbar.querySelector<HTMLButtonElement>(
      '[data-ofd-control="menu-properties"]',
    );
    expect(properties).not.toBeNull();
    properties!.click();
    expect(shell.dialogs.isOpen).toBe(true);
    expect(shell.dialogs.currentName).toBe('documentProperties');
    expect(shell.elements.dialogLayer.textContent).toContain('文档属性');

    const before = host.offCount();
    expect(before).toBeGreaterThan(0);
    dispose();
    expect(host.offCount()).toBe(0);
    expect(getUIShell(host)).toBeUndefined();
    expect(shell.elements.toolbar.childElementCount).toBe(0);
  });
});