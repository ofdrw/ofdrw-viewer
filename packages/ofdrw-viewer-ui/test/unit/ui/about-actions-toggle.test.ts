/**
 * 「关于」对话框的自动执行开关：允许切换时回读一致，受限场景下禁用且不翻转。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFindState, createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import { attachUIShell, getUIShell } from '../../../src/ui';
import type { UIShellHost } from '../../../src/ui';
import { cleanupShells, createRoot } from './helpers';

afterEach(() => {
  cleanupShells();
});

/**
 * 构造带「更多」菜单的最小宿主。
 *
 * @param allowUserToggle 是否允许用户切换自动执行开关；undefined 表示不提供该读取方法。
 * @returns 宿主与开关调用记录。
 */
function createHost(allowUserToggle: boolean | undefined): {
  host: UIShellHost;
  setCalls: boolean[];
} {
  const root = createRoot(400);
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
  /** 核心持有的自动执行开关值，单位无；`setAutoExecuteActions` 只在允许时写入。 */
  let autoExecute = false;
  const setCalls: boolean[] = [];

  const noop = (): void => undefined;
  const host: UIShellHost = {
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
    on: () => noop,
    toggleSidebar: noop,
    openSidebar: noop,
    closeSidebar: noop,
    goToPage: noop,
    nextPage: noop,
    previousPage: noop,
    zoomIn: noop,
    zoomOut: noop,
    setScale: noop,
    setZoomMode: noop,
    rotateClockwise: noop,
    find: noop,
    findNext: noop,
    findPrevious: noop,
    clearFind: noop,
    print: noop,
    exportImage: noop,
    exportImages: noop,
    exportOfd: noop,
    setFullscreen: noop,
    getAutoExecuteActions: () => autoExecute,
    setAutoExecuteActions: (enabled: boolean) => {
      // 与核心一致：禁止用户改动时直接忽略。
      if (allowUserToggle === false) return;
      setCalls.push(enabled);
      autoExecute = enabled;
    },
    ...(allowUserToggle === undefined
      ? {}
      : { getAutoExecuteActionsToggleAllowed: () => allowUserToggle }),
  };
  return { host, setCalls };
}

/**
 * 打开「关于」对话框并返回其中的自动执行开关按钮。
 *
 * @param host 宿主。
 * @returns 外壳与开关按钮。
 */
function openAbout(host: UIShellHost): {
  shell: NonNullable<ReturnType<typeof getUIShell>>;
  toggle: HTMLButtonElement;
} {
  const dispose = attachUIShell(host);
  const shell = getUIShell(host)!;
  const about = shell.root.querySelector<HTMLButtonElement>(
    '[data-ofd-control="menu-about"]',
  )!;
  about.click();
  const toggle = shell.elements.dialogLayer.querySelector<HTMLButtonElement>('.ofd-switch')!;
  expect(toggle).not.toBeNull();
  // 关闭时卸载外壳，避免状态泄漏到后续用例。
  expect(typeof dispose).toBe('function');
  return { shell, toggle };
}

describe('「关于」自动执行开关', () => {
  it('允许切换时点击翻转并回读一致', () => {
    const { host, setCalls } = createHost(true);
    const { toggle } = openAbout(host);

    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('aria-disabled')).toBe(false);
    expect(toggle.tabIndex).not.toBe(-1);

    toggle.click();
    expect(setCalls).toEqual([true]);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.dataset.enabled).toBe('true');

    toggle.click();
    expect(setCalls).toEqual([true, false]);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('不允许切换时开关禁用、点击不改变值也不翻转视觉', () => {
    const { host, setCalls } = createHost(false);
    const { toggle } = openAbout(host);

    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.tabIndex).toBe(-1);
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    toggle.click();
    expect(setCalls).toEqual([]);
    expect(host.getAutoExecuteActions?.()).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.dataset.enabled).toBe('false');
  });

  it('核心静默失败时按回读的真实值刷新视觉', () => {
    const { host } = createHost(true);
    const { toggle } = openAbout(host);

    // 模拟核心拒绝改动：设置方法与读取方法都不生效。
    Object.defineProperty(host, 'setAutoExecuteActions', { value: vi.fn() });
    toggle.click();

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.dataset.enabled).toBe('false');
  });
});