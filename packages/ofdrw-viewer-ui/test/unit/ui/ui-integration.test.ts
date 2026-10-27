/**
 * 内置 UI 与核心的结构化接线（不依赖 src/viewer.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFeatureStates } from '../../../src/features';
import { createFindState, createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import { attachUIShell, getUIShell } from '../../../src/ui';
import type { UIShellHost } from '../../../src/ui';
import { getVersions } from '../../../src/version';
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
    exportImages() {
      record('exportImages');
      return Promise.resolve();
    },
    exportOfd() {
      record('exportOfd');
      return Promise.resolve();
    },
    setFullscreen(value) {
      record(`setFullscreen:${value}`);
      return Promise.resolve();
    },
  };
}

describe('内置 UI 接线', () => {
  it('打印/导出选项对话框覆盖范围、DPI、质量、背景、旋转与格式', () => {
    const host = createFakeHost();
    const dispose = attachUIShell(host);
    const shell = getUIShell(host)!;

    (shell.toolbar.getControl('print') as HTMLButtonElement).click();
    let dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
    expect(dialog.textContent).toContain('打印选项');
    expect(dialog.querySelectorAll('select')).toHaveLength(3);
    expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')).not.toBeNull();
    (dialog.querySelector('.ofd-dialog__action:not(.ofd-dialog__action--primary)') as HTMLButtonElement).click();

    (shell.toolbar.getControl('export') as HTMLButtonElement).click();
    dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
    expect(dialog.textContent).toContain('导出选项');
    expect(dialog.querySelectorAll('select')).toHaveLength(5);
    expect(dialog.querySelector<HTMLInputElement>('input[type="range"]')).not.toBeNull();
    const format = [...dialog.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.value === 'webp'),
    )!;
    expect([...format.options].map((option) => option.value)).toEqual([
      'png',
      'jpeg',
      'webp',
      'ofd',
    ]);
    // 选择 OFD 时隐藏图片专属字段并显示“原文件”说明。
    format.value = 'ofd';
    format.dispatchEvent(new Event('change'));
    const fields = [...dialog.querySelectorAll<HTMLElement>('.ofd-output-field')];
    expect(fields.filter((field) => field.hidden)).toHaveLength(5);
    const note = dialog.querySelector<HTMLElement>('[data-ofd-control="output-ofd-note"]')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('OFD 原文件');
    (dialog.querySelector('.ofd-dialog__action:not(.ofd-dialog__action--primary)') as HTMLButtonElement).click();
    expect(document.querySelector('.ofd-dialog')).toBeNull();
    dispose();
  });

  it('输出表单 Enter 提交被阻止并执行确认，所有控件都有可访问名称', () => {
    const host = createFakeHost();
    const dispose = attachUIShell(host);
    const shell = getUIShell(host)!;

    // 打印：每个 select/input 都应有 label 或 aria-label；主按钮显式 type=button。
    (shell.toolbar.getControl('print') as HTMLButtonElement).click();
    let dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
    let form = dialog.querySelector<HTMLFormElement>('form')!;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select,input')) {
      const named =
        (control.labels?.length ?? 0) > 0 ||
        control.hasAttribute('aria-label') ||
        control.hasAttribute('aria-labelledby');
      expect(named, control.outerHTML).toBe(true);
    }
    const dpiField = [...form.querySelectorAll<HTMLElement>('.ofd-output-field')].find((field) =>
      field.textContent?.includes('DPI'),
    )!;
    expect(dpiField.querySelector('label')!.htmlFor).toBe(
      dpiField.querySelector('select')!.id,
    );
    expect(
      dialog.querySelector('.ofd-dialog__action--primary')!.getAttribute('type'),
    ).toBe('button');

    let range = form.querySelector<HTMLSelectElement>('select')!;
    range.value = 'custom';
    range.dispatchEvent(new Event('change'));
    let custom = form.querySelector<HTMLInputElement>('input.ofd-input')!;
    expect(custom.hidden).toBe(false);
    custom.value = '1-2';
    const printSubmit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(printSubmit);
    expect(printSubmit.defaultPrevented).toBe(true);
    expect(document.querySelector('.ofd-dialog')).toBeNull();
    expect(host.calls).toContain('print');

    // 导出：同样通过 submit 执行确认并关闭对话框。
    (shell.toolbar.getControl('export') as HTMLButtonElement).click();
    dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
    form = dialog.querySelector<HTMLFormElement>('form')!;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select,input')) {
      const named =
        (control.labels?.length ?? 0) > 0 ||
        control.hasAttribute('aria-label') ||
        control.hasAttribute('aria-labelledby');
      expect(named, control.outerHTML).toBe(true);
    }
    range = form.querySelector<HTMLSelectElement>('select')!;
    range.value = 'custom';
    range.dispatchEvent(new Event('change'));
    custom = form.querySelector<HTMLInputElement>('input.ofd-input')!;
    custom.value = '2';
    const exportSubmit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(exportSubmit);
    expect(exportSubmit.defaultPrevented).toBe(true);
    expect(document.querySelector('.ofd-dialog')).toBeNull();
    expect(host.calls).toContain('exportImages');
    dispose();
  });

  it('导出对话框选择 OFD 后提交 exportOfd 且不读取图片范围', () => {
    const host = createFakeHost();
    const dispose = attachUIShell(host);
    const shell = getUIShell(host)!;
    (shell.toolbar.getControl('export') as HTMLButtonElement).click();
    const dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const format = [...form.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.value === 'ofd'),
    )!;
    format.value = 'ofd';
    format.dispatchEvent(new Event('change'));
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(document.querySelector('.ofd-dialog')).toBeNull();
    expect(host.calls).toContain('exportOfd');
    expect(host.calls).not.toContain('exportImage');
    dispose();
  });

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
    expect(document.querySelector('.ofd-dialog')).not.toBeNull();
    (document.querySelector('.ofd-dialog__action--primary') as HTMLButtonElement).click();
    expect(host.calls).toContain('print');
    (shell!.toolbar.getControl('export') as HTMLButtonElement).click();
    expect(document.querySelector('.ofd-dialog')).not.toBeNull();
    (document.querySelector('.ofd-dialog__action--primary') as HTMLButtonElement).click();
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
        // 缩放模式由核心维护：用户指定倍率时是 `page-actual`，自适应时是具体模式。
        zoomMode: 'page-actual' as const,
        rotation: 90,
        sidebarView: 'outline',
      },
      ui: { ...host.getState().ui, features: resolveFeatureStates() },
    });
    host.emit('statechange');
    expect(pageInput.value).toBe('5');
    expect(pageInput.max).toBe('20');
    const zoomSelect = shell.toolbar.getControl('zoomMode') as HTMLSelectElement;
    expect(zoomSelect.options[0]?.textContent).toBe('200%');
    expect(zoomSelect.value).toBe('scale:2');
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

  it('文档属性常驻按钮打开本地对话框，销毁时解绑事件', () => {
    const host = createFakeHost(400);
    const dispose = attachUIShell(host);
    const shell = getUIShell(host)!;
    const properties = shell.elements.toolbar.querySelector<HTMLButtonElement>(
      '[data-ofd-control="document-properties"]',
    );
    expect(properties).not.toBeNull();
    expect(properties!.getAttribute('aria-label')).toBe('文档属性');
    expect(shell.root.querySelector('[data-ofd-control="menu-properties"]')).toBeNull();
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

  it('关于菜单在未打开文档时也可用并展示 UI 版本', () => {
    const host = createFakeHost(400);
    const dispose = attachUIShell(host);
    const shell = getUIShell(host)!;
    host.setState({
      ...host.getState(),
      document: { ...host.getState().document, pageCount: 0 },
    });
    host.emit('statechange');

    const about = shell.root.querySelector<HTMLButtonElement>(
      '[data-ofd-control="menu-about"]',
    );
    expect(about).not.toBeNull();
    expect(about!.disabled).toBe(false);

    about!.click();
    expect(shell.dialogs.isOpen).toBe(true);
    expect(shell.dialogs.currentName).toBe('about');
    const text = shell.elements.dialogLayer.textContent ?? '';
    const versions = getVersions();
    expect(text).toContain('关于');
    expect(text).toContain('软件名称');
    expect(text).toContain('ofdrw-viewer-ui');
    expect(text).toContain(versions.ui);
    // 只展示 UI 版本，不再展示渲染引擎与密码工具库版本。
    expect(text).not.toContain('渲染引擎版本');
    expect(text).not.toContain('密码工具库版本');

    const licenseLink = shell.elements.dialogLayer.querySelector<HTMLAnchorElement>(
      '.ofd-properties__link',
    );
    expect(licenseLink).not.toBeNull();
    expect(licenseLink!.textContent).toBe('查看');

    licenseLink!.click();
    expect(shell.dialogs.currentName).toBe('licenses');
    const notices = shell.elements.dialogLayer.textContent ?? '';
    expect(notices).toContain('开源软件许可');
    expect(notices).toContain('fflate 0.8.3');
    expect(notices).toContain('MIT');
    dispose();
  });
});