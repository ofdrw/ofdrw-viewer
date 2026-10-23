/**
 * UI 外壳：结构、状态同步、命令、功能门控、断点与侧栏行为。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFeatureStates } from '../../../src/features';
import { createDefaultFeatureStates } from '../../../src/features';
import { createFindState } from '../../../src/state';
import { setClientWidth, cleanupShells, createShell } from './helpers';

afterEach(() => {
  cleanupShells();
});

describe('UI 外壳结构', () => {
  it('复用核心容器并保持单套 DOM', () => {
    const { shell, root } = createShell({ width: 1280 });
    expect(root.querySelectorAll('.ofd-viewer__toolbar')).toHaveLength(1);
    expect(root.querySelectorAll('.ofd-viewer__body')).toHaveLength(1);
    expect(root.querySelectorAll('.ofd-viewer__sidebar')).toHaveLength(1);
    expect(root.querySelectorAll('.ofd-viewer__main')).toHaveLength(1);
    expect(root.querySelectorAll('.ofd-viewer__findbar')).toHaveLength(1);
    expect(root.querySelectorAll('.ofd-viewer__dialog-layer')).toHaveLength(1);
    expect(root.querySelectorAll('.ofd-viewer__toast-layer')).toHaveLength(1);
    expect(shell.elements.toolbar.getAttribute('role')).toBe('toolbar');
    expect(shell.elements.main.getAttribute('aria-label')).toBe('文档内容');
    expect(shell.elements.findbar.getAttribute('role')).toBe('search');
    expect(shell.sidebar.layout).toBe('inline');
    expect(root.dataset.sidebarLayout).toBe('inline');
    expect(root.dataset.viewport).toBe('desktop');
  });

  it('沿用核心已创建的容器而不是新建根节点', () => {
    const root = document.createElement('div');
    root.className = 'ofd-viewer';
    root.dataset.viewport = 'desktop';
    root.dataset.sidebarLayout = 'inline';
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
    const dialog = document.createElement('div');
    dialog.className = 'ofd-viewer__dialog-layer';
    const toast = document.createElement('div');
    toast.className = 'ofd-viewer__toast-layer';
    body.append(sidebar, mask, main, findbar);
    root.append(toolbar, body, dialog, toast);
    document.body.append(root);

    const { shell } = createShell({
      root,
      manageViewport: false,
      manageSidebarVisibility: false,
    });
    expect(shell.elements.toolbar).toBe(toolbar);
    expect(shell.elements.sidebar).toBe(sidebar);
    expect(shell.elements.sidebarMask).toBe(mask);
    expect(shell.elements.main).toBe(main);
    expect(shell.elements.findbar).toBe(findbar);
    expect(root.querySelectorAll('.ofd-viewer__toolbar')).toHaveLength(1);
  });
});

describe('状态同步', () => {
  it('页码、缩放、旋转与全屏状态写入控件', () => {
    const { shell } = createShell({ state: { pageCount: 10, pageNumber: 2 } });
    const input = shell.toolbar.getControl('pageNumber') as HTMLInputElement;
    expect(input.value).toBe('2');
    expect(input.max).toBe('10');
    expect(shell.elements.toolbar.textContent).toContain('/ 10');

    shell.update({ pageNumber: 5, scale: 2, zoomMode: 'auto', rotation: 90, fullscreen: true });
    expect(input.value).toBe('5');
    const fullscreen = shell.toolbar.getControl('fullscreen') as HTMLButtonElement;
    expect(fullscreen.getAttribute('aria-pressed')).toBe('true');
    expect(fullscreen.getAttribute('aria-label')).toBe('退出全屏');
    const rotate = shell.toolbar.getControl('rotate') as HTMLButtonElement;
    expect(rotate.title).toContain('90');
    const zoom = shell.toolbar.getControl('zoomMode') as HTMLSelectElement;
    expect(zoom.value).toBe('scale:2');

    shell.update({ pageNumber: 1, pageCount: 10 });
    const previous = shell.toolbar.getControl('previousPage') as HTMLButtonElement;
    const next = shell.toolbar.getControl('nextPage') as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    shell.update({ pageNumber: 10 });
    expect(next.disabled).toBe(true);
  });

  it('无文档时禁用页面相关控件', () => {
    const { shell } = createShell();
    const ids = ['previousPage', 'nextPage', 'pageNumber', 'zoomMode', 'zoomIn', 'zoomOut', 'rotate', 'print', 'export', 'signatures'];
    for (const id of ids) {
      const control = shell.toolbar.getControl(id) as HTMLButtonElement;
      expect(control.disabled, id).toBe(true);
    }
    expect((shell.toolbar.getControl('fullscreen') as HTMLButtonElement).disabled).toBe(false);
    expect((shell.toolbar.getControl('sidebar') as HTMLButtonElement).disabled).toBe(false);
  });

  it('页码通知写入 aria-live', () => {
    const { shell } = createShell({ state: { pageCount: 10, pageNumber: 1 } });
    shell.update({ pageNumber: 3 });
    const announcer = shell.announcer.element;
    expect(announcer.getAttribute('aria-live')).toBe('polite');
  });
});

describe('工具栏命令', () => {
  it('翻页、页码、缩放、旋转、全屏与查找', () => {
    const { shell, commands } = createShell({ state: { pageCount: 10, pageNumber: 2 } });

    (shell.toolbar.getControl('nextPage') as HTMLButtonElement).click();
    expect(commands).toContainEqual({ type: 'page.next' });
    (shell.toolbar.getControl('previousPage') as HTMLButtonElement).click();
    expect(commands).toContainEqual({ type: 'page.previous' });

    const pageInput = shell.toolbar.getControl('pageNumber') as HTMLInputElement;
    pageInput.value = '3';
    pageInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(commands).toContainEqual({ type: 'page.go', page: 3 });
    pageInput.value = '99';
    pageInput.dispatchEvent(new Event('blur'));
    expect(pageInput.value).toBe('2');

    const zoom = shell.toolbar.getControl('zoomMode') as HTMLSelectElement;
    zoom.value = 'page-fit';
    zoom.dispatchEvent(new Event('change'));
    expect(commands).toContainEqual({ type: 'zoom.set', scale: 'page-fit' });
    zoom.value = 'scale:1.5';
    zoom.dispatchEvent(new Event('change'));
    expect(commands).toContainEqual({ type: 'zoom.set', scale: 1.5 });

    (shell.toolbar.getControl('rotate') as HTMLButtonElement).click();
    expect(commands).toContainEqual({ type: 'rotate.clockwise' });
    (shell.toolbar.getControl('fullscreen') as HTMLButtonElement).click();
    expect(commands).toContainEqual({ type: 'fullscreen.set', value: true });
    (shell.toolbar.getControl('print') as HTMLButtonElement).click();
    expect(commands).toContainEqual({ type: 'print.open' });
    (shell.toolbar.getControl('export') as HTMLButtonElement).click();
    expect(commands).toContainEqual({ type: 'export.open' });
    (shell.toolbar.getControl('document-properties') as HTMLButtonElement).click();
    expect(commands).toContainEqual({ type: 'document.properties' });

    const findButton = shell.toolbar.getControl('find') as HTMLButtonElement;
    findButton.click();
    expect(shell.findbar.isOpen).toBe(true);
    expect(findButton.getAttribute('aria-expanded')).toBe('true');
    const findInput = shell.elements.findbar.querySelector<HTMLInputElement>('input[type="search"]');
    expect(findInput).not.toBeNull();
    expect(document.activeElement).toBe(findInput);
    findInput!.value = '合同';
    findInput!.dispatchEvent(new Event('input'));
    expect(commands).toContainEqual({
      type: 'find.query',
      query: '合同',
      caseSensitive: false,
      wholeWord: false,
      highlightAll: true,
    });
    findInput!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(commands).toContainEqual({ type: 'find.next' });
    findInput!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(shell.findbar.isOpen).toBe(false);
    expect(commands).toContainEqual({ type: 'find.close' });
  });

  it('侧栏开关产生 open/close 命令并同步 aria-expanded', () => {
    const { shell, commands } = createShell({ state: { pageCount: 10 } });
    const toggle = shell.toolbar.getSidebarButton();
    toggle.focus();
    toggle.click();
    expect(commands).toContainEqual({ type: 'sidebar.open', view: 'thumbnails' });
    expect(shell.sidebar.currentView).toBe('thumbnails');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(shell.elements.sidebar.hidden).toBe(false);
    toggle.click();
    expect(commands).toContainEqual({ type: 'sidebar.close' });
    expect(shell.sidebar.currentView).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('功能门控', () => {
  it('隐藏/禁用与原因 tooltip 由 FeatureState 决定', () => {
    const states = resolveFeatureStates(
      { print: false, export: false, find: false },
      {},
      { print: 'disable', export: 'disable' },
    );
    const { shell } = createShell({
      featureStates: states,
      state: { pageCount: 10 },
    });
    const print = shell.toolbar.getControl('print') as HTMLButtonElement;
    expect(print.hidden).toBe(false);
    expect(print.disabled).toBe(true);
    expect(print.getAttribute('aria-disabled')).toBe('true');
    expect(print.dataset.featureReason).toBe('host');
    expect(print.title).toContain('打印不可用');
    expect(print.title).toContain('已被宿主禁用');

    const exportControl = shell.toolbar.getControl('export') as HTMLButtonElement;
    expect(exportControl.disabled).toBe(true);
    expect(exportControl.title).toContain('导出不可用');

    const find = shell.toolbar.getControl('find') as HTMLButtonElement;
    expect(find.hidden).toBe(true);

    shell.setFeatureStates(createDefaultFeatureStates());
    expect(print.hidden).toBe(false);
    expect(print.disabled).toBe(false);
    expect(print.hasAttribute('aria-disabled')).toBe(false);
    expect(print.title).toBe('');
    expect(find.hidden).toBe(false);
  });

  it('文档属性常驻按钮按 documentProperties 功能隐藏或禁用', () => {
    const hiddenShell = createShell({
      featureStates: resolveFeatureStates({ documentProperties: false }),
      state: { pageCount: 10 },
    });
    const hiddenButton = hiddenShell.shell.toolbar.getControl(
      'document-properties',
    ) as HTMLButtonElement;
    expect(hiddenButton.hidden).toBe(true);
    expect(hiddenButton.disabled).toBe(true);

    const disabledShell = createShell({
      featureStates: resolveFeatureStates(
        { documentProperties: false },
        {},
        { documentProperties: 'disable' },
      ),
      state: { pageCount: 10 },
    });
    const disabledButton = disabledShell.shell.toolbar.getControl(
      'document-properties',
    ) as HTMLButtonElement;
    expect(disabledButton.hidden).toBe(false);
    expect(disabledButton.disabled).toBe(true);
    expect(disabledButton.getAttribute('aria-disabled')).toBe('true');
    expect(disabledButton.title).toContain('文档属性不可用');
    // 菜单中不再保留重复入口。
    expect(
      disabledShell.shell.root.querySelector('[data-ofd-control="menu-properties"]'),
    ).toBeNull();
  });

  it('查找栏容器初始隐藏，且显隐只由打开/关闭控制', () => {
    const { shell } = createShell({ state: { pageCount: 10 } });
    const findbar = shell.elements.findbar;
    const input = findbar.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    expect(findbar.hidden).toBe(true);
    expect(shell.findbar.isOpen).toBe(false);

    // 功能状态多次刷新（含核心 setFeatures 触发的同步）都不能把未打开的查找栏显示出来。
    shell.setFeatureStates(createDefaultFeatureStates());
    shell.setFeatureStates(resolveFeatureStates());
    expect(findbar.hidden).toBe(true);

    expect(shell.openFindbar()).toBe(true);
    expect(findbar.hidden).toBe(false);
    expect(shell.findbar.isOpen).toBe(true);
    expect(document.activeElement).toBe(input);
    shell.closeFindbar();
    expect(findbar.hidden).toBe(true);
    expect(shell.findbar.isOpen).toBe(false);

    // 已打开时关闭 find 功能：立即收起，内部控件按门控禁用并带原因 tooltip。
    expect(shell.openFindbar()).toBe(true);
    const disabledStates = resolveFeatureStates(
      { find: false },
      {},
      { find: 'disable' },
    );
    shell.setFeatureStates(disabledStates);
    expect(findbar.hidden).toBe(true);
    expect(shell.findbar.isOpen).toBe(false);
    expect(input!.disabled).toBe(true);
    expect(input!.getAttribute('aria-disabled')).toBe('true');
    expect(input!.title).toContain('查找不可用');
    expect(shell.openFindbar()).toBe(false);
    expect(findbar.hidden).toBe(true);

    // 重复门控调用仍保持隐藏；重新启用后也不自动打开，直到用户再次点击。
    shell.setFeatureStates(disabledStates);
    expect(findbar.hidden).toBe(true);
    shell.setFeatureStates(createDefaultFeatureStates());
    shell.setFeatureStates(resolveFeatureStates());
    expect(findbar.hidden).toBe(true);
    expect(shell.findbar.isOpen).toBe(false);
    expect(input!.disabled).toBe(false);
    expect(input!.hasAttribute('aria-disabled')).toBe(false);
    expect(input!.title).toBe('');
    expect(shell.openFindbar()).toBe(true);
    expect(findbar.hidden).toBe(false);
    shell.closeFindbar();
    expect(findbar.hidden).toBe(true);
  });

  it('关闭侧栏标签功能时隐藏标签并收起侧栏', () => {
    const states = resolveFeatureStates({ signatures: false });
    const { shell } = createShell({
      featureStates: states,
      sidebarView: 'signatures',
      state: { pageCount: 10 },
    });
    const signaturesTab = shell.sidebar.getTab('signatures');
    expect(signaturesTab?.hidden).toBe(true);
    expect(shell.sidebar.currentView).toBeNull();
    expect((shell.toolbar.getControl('signatures') as HTMLButtonElement).hidden).toBe(true);
  });

  it('禁用功能时收起对应对话框', () => {
    const { shell } = createShell({ state: { pageCount: 10 } });
    shell.openDialog({ name: 'print', title: '打印' });
    expect(shell.dialogs.isOpen).toBe(true);
    shell.setFeatureStates(resolveFeatureStates({ print: false }));
    expect(shell.dialogs.isOpen).toBe(false);
  });
});

describe('断点布局', () => {
  it('同一实例跨断点只切换布局，不重建 DOM，也不改变视图状态', () => {
    const { shell, root, commands } = createShell({ width: 1280 });
    const toolbar = shell.elements.toolbar;
    const pageInput = shell.toolbar.getControl('pageNumber');
    const sidebar = shell.elements.sidebar;
    shell.update({ pageCount: 10, pageNumber: 4, scale: 1.25, rotation: 90 });
    expect(shell.viewport).toBe('desktop');
    expect(shell.sidebar.layout).toBe('inline');

    setClientWidth(root, 900);
    shell.syncViewport();
    expect(shell.viewport).toBe('compact');
    expect(shell.sidebar.layout).toBe('overlay');
    expect(root.dataset.viewport).toBe('compact');

    setClientWidth(root, 600);
    shell.syncViewport();
    expect(shell.viewport).toBe('mobile');
    expect(shell.sidebar.layout).toBe('drawer');

    setClientWidth(root, 400);
    shell.syncViewport();
    expect(shell.viewport).toBe('narrow');
    expect(shell.sidebar.layout).toBe('drawer');

    expect(shell.elements.toolbar).toBe(toolbar);
    expect(shell.toolbar.getControl('pageNumber')).toBe(pageInput);
    expect(shell.elements.sidebar).toBe(sidebar);
    expect(shell.getState().pageNumber).toBe(4);
    expect(shell.getState().scale).toBe(1.25);
    expect(shell.getState().rotation).toBe(90);
    expect(commands).toHaveLength(0);
  });

  it('断点回调只报告断点变化', () => {
    const events: string[] = [];
    const { shell, root } = createShell({
      width: 1280,
      onViewportChange: (mode, previous) => events.push(`${previous}->${mode}`),
    });
    setClientWidth(root, 900);
    shell.syncViewport();
    setClientWidth(root, 800);
    shell.syncViewport();
    expect(events).toEqual(['desktop->compact']);
    expect(shell.viewport).toBe('compact');
  });

  it('工具栏保留精简后的核心控件，其余进入更多菜单', () => {
    const { shell } = createShell({ width: 400, state: { pageCount: 10 } });
    expect(shell.viewport).toBe('narrow');
    const more = shell.root.querySelector('.ofd-more-menu');
    expect(more).not.toBeNull();
    const menuIds = [...(more?.querySelectorAll('[data-ofd-control]') ?? [])].map(
      (element) => element.getAttribute('data-ofd-control'),
    );
    expect(menuIds).toContain('menu-print');
    expect(menuIds).toContain('menu-zoom-in');
    expect(menuIds).toContain('menu-previous');
    expect(menuIds).not.toContain('menu-properties');
    // 文档属性改为工具栏常驻 info 图标，不再依赖菜单打开。
    const properties = shell.elements.toolbar.querySelector<HTMLElement>(
      '[data-ofd-control="document-properties"]',
    );
    expect(properties).not.toBeNull();
    expect(properties?.getAttribute('aria-label')).toBe('文档属性');
    expect(properties?.hidden).toBe(false);
    const print = shell.elements.toolbar.querySelector<HTMLElement>('[data-ofd-control="print"]');
    expect(print?.dataset.overflow).toBe('compact');
    const previous = shell.elements.toolbar.querySelector<HTMLElement>(
      '[data-ofd-control="previousPage"]',
    );
    expect(previous?.dataset.overflow).toBe('compact');
  });

  it('覆盖/抽屉侧栏可通过遮罩与关闭按钮关闭', () => {
    const { shell, commands } = createShell({ width: 900, state: { pageCount: 10 } });
    shell.update({ sidebarView: 'outline' });
    expect(shell.elements.sidebarMask.hidden).toBe(false);
    shell.elements.sidebarMask.click();
    expect(shell.sidebar.currentView).toBeNull();
    expect(shell.elements.sidebarMask.hidden).toBe(true);

    shell.update({ sidebarView: 'bookmarks' });
    const close = shell.elements.sidebar.querySelector<HTMLButtonElement>('.ofd-sidebar__close');
    expect(close).not.toBeNull();
    close!.click();
    expect(shell.sidebar.currentView).toBeNull();
    expect(commands).toContainEqual({ type: 'sidebar.close' });
  });

  it('更多菜单支持键盘导航、Esc 关闭并恢复焦点', () => {
    const { shell } = createShell({ width: 400, state: { pageCount: 10 } });
    const more = shell.elements.toolbar.querySelector<HTMLButtonElement>(
      '[data-ofd-control="more"]',
    );
    expect(more).not.toBeNull();
    more!.focus();
    more!.click();
    expect(more!.getAttribute('aria-expanded')).toBe('true');
    const menu = shell.root.querySelector<HTMLElement>('.ofd-more-menu');
    expect(menu?.hidden).toBe(false);
    const first = document.activeElement as HTMLElement;
    expect(menu!.contains(first)).toBe(true);
    menu!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).not.toBe(first);
    menu!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(menu!.hidden).toBe(true);
    expect(more!.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
  });

  it('侧栏在覆盖/抽屉与常驻之间切换时同步遮罩、焦点陷阱与 aria-expanded', () => {
    const { shell, root, commands } = createShell({ width: 900, state: { pageCount: 10 } });
    const toggle = shell.toolbar.getSidebarButton();
    toggle.focus();
    shell.update({ sidebarView: 'thumbnails' });
    expect(shell.sidebar.layout).toBe('overlay');
    expect(shell.elements.sidebar.hidden).toBe(false);
    expect(shell.elements.sidebarMask.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(shell.elements.sidebar.contains(document.activeElement)).toBe(true);

    setClientWidth(root, 1280);
    shell.syncViewport();
    expect(shell.sidebar.layout).toBe('inline');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(shell.elements.sidebar.hidden).toBe(false);
    expect(shell.getState().sidebarView).toBe('thumbnails');

    setClientWidth(root, 500);
    shell.syncViewport();
    expect(shell.sidebar.layout).toBe('drawer');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const active = document.activeElement as HTMLElement;
    active.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(shell.sidebar.currentView).toBeNull();
    expect(shell.elements.sidebar.hidden).toBe(true);
    expect(shell.elements.sidebarMask.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(commands).toContainEqual({ type: 'sidebar.close' });
  });
});

describe('可访问名称', () => {
  it('工具栏、查找栏与侧栏控件都有可读名称', () => {
    const { shell } = createShell({ width: 1280 });
    const toolbarControls = shell.elements.toolbar.querySelectorAll<HTMLElement>(
      'button, input, select',
    );
    expect(toolbarControls.length).toBeGreaterThan(10);
    for (const control of toolbarControls) {
      const label = control.getAttribute('aria-label') ?? control.textContent?.trim();
      expect(label, control.outerHTML).toBeTruthy();
    }
    const findbarControls = shell.elements.findbar.querySelectorAll<HTMLElement>(
      'button, input',
    );
    for (const control of findbarControls) {
      expect(control.getAttribute('aria-label'), control.outerHTML).toBeTruthy();
    }
    for (const view of ['thumbnails', 'outline', 'bookmarks', 'signatures'] as const) {
      expect(shell.sidebar.getTab(view)?.textContent?.length).toBeGreaterThan(0);
    }
    expect(shell.sidebar.getPanel('thumbnails')?.getAttribute('role')).toBe('tabpanel');
  });

  it('查找计数由 live region 文本播报且不再使用 aria-label', () => {
    const { shell } = createShell({ width: 1280, state: { pageCount: 10 } });
    const count = shell.elements.findbar.querySelector<HTMLElement>(
      '.ofd-findbar__count',
    );
    expect(count).not.toBeNull();
    expect(count!.hasAttribute('aria-label')).toBe(false);
    expect(count!.getAttribute('aria-live')).toBe('polite');
    expect(count!.getAttribute('aria-atomic')).toBe('true');

    expect(shell.openFindbar()).toBe(true);
    expect(count!.textContent).toBe('');
    shell.findbar.update(
      createFindState({ query: '合同', total: 3, current: 2, highlightAll: true }),
    );
    expect(count!.textContent).toBe('2 / 3');
    expect(count!.hasAttribute('aria-label')).toBe(false);
    expect(count!.getAttribute('aria-live')).toBe('polite');
    expect(count!.getAttribute('aria-atomic')).toBe('true');

    shell.findbar.update(
      createFindState({ query: '合同', total: 0, current: 0, highlightAll: true }),
    );
    expect(count!.textContent).toBe('无结果');
    expect(count!.hasAttribute('aria-label')).toBe(false);
  });

  it('对话框按钮与 Esc 关闭仍返回触发按钮', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.appendChild(trigger);
    trigger.focus();

    const { shell } = createShell({ state: { pageCount: 1 } });
    const dialog = shell.openDialog({
      name: 'documentProperties',
      title: '文档属性',
      description: '属性说明',
      content: '内容',
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, closeOnClick: false },
      ],
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('.ofd-dialog__title')?.textContent).toBe('文档属性');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(shell.dialogs.currentName).toBe('documentProperties');

    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(shell.dialogs.isOpen).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('语言切换', () => {
  it('en-US 更新文案并对齐 Intl 数字', () => {
    const { shell, root } = createShell({ locale: 'zh-CN', state: { pageCount: 1000, pageNumber: 2 } });
    shell.setLocale('en-US');
    expect(root.lang).toBe('en-US');
    expect(shell.elements.toolbar.getAttribute('aria-label')).toBe('Toolbar');
    expect(shell.elements.toolbar.textContent).toContain('/ 1,000');
    expect(shell.sidebar.getTab('thumbnails')?.textContent).toBe('Thumbnails');
    expect(
      shell.elements.findbar.querySelector<HTMLInputElement>('input[type="search"]')?.placeholder,
    ).toBe('Find in document');
    expect((shell.toolbar.getControl('pageNumber') as HTMLInputElement).title).toBe(
      'Page 2 of 1,000',
    );
    shell.setLocale('zh-CN');
    expect(shell.elements.toolbar.getAttribute('aria-label')).toBe('工具栏');
  });
});