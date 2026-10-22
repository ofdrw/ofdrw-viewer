/**
 * UI 外壳测试辅助。
 */
import { vi } from 'vitest';
import { UIShell } from '../../../src/ui/ui-shell';
import type { UIShellCommand, UIShellOptions } from '../../../src/ui/types';

const activeShells: UIShell[] = [];

/**
 * 创建阅读器根节点。
 *
 * @param width 模拟的容器宽度，单位 px。
 * @returns 根节点。
 */
export function createRoot(width = 1280): HTMLElement {
  const root = document.createElement('div');
  root.className = 'ofd-viewer';
  document.body.appendChild(root);
  setClientWidth(root, width);
  return root;
}

/**
 * 覆盖元素 clientWidth（jsdom 不做布局）。
 *
 * @param element 元素。
 * @param width 宽度，单位 px。
 */
export function setClientWidth(element: HTMLElement, width: number): void {
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: width,
  });
}

/**
 * 创建并登记 UI 外壳，测试结束自动销毁。
 *
 * @param options 外壳选项与模拟宽度。
 * @returns 外壳、根节点与收到的命令。
 */
export function createShell(
  options: Partial<UIShellOptions> & { width?: number } = {},
): { shell: UIShell; root: HTMLElement; commands: UIShellCommand[] } {
  const { width = 1280, root: providedRoot, ...rest } = options;
  const root = providedRoot ?? createRoot(width);
  const commands: UIShellCommand[] = [];
  const shell = new UIShell({
    root,
    manageViewport: true,
    manageSidebarVisibility: true,
    theme: 'light',
    locale: 'zh-CN',
    onCommand: (command) => commands.push(command),
    ...rest,
  });
  activeShells.push(shell);
  return { shell, root, commands };
}

/** 销毁所有外壳并清空 DOM。 */
export function cleanupShells(): void {
  for (const shell of activeShells.splice(0)) shell.destroy();
  document.body.innerHTML = '';
}

/**
 * 安装 matchMedia 模拟。
 *
 * @param initial 初始 `matches`。
 * @returns 控制对象。
 */
export function installMatchMedia(initial: boolean): {
  setMatches(value: boolean): void;
  dispatch(): void;
  query(): string;
} {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let media = '(prefers-color-scheme: dark)';
  const mql = {
    matches: initial,
    media,
    onchange: null,
    addEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
      if (type === 'change') listeners.delete(listener);
    },
    addListener(listener: (event: MediaQueryListEvent) => void) {
      listeners.add(listener);
    },
    removeListener(listener: (event: MediaQueryListEvent) => void) {
      listeners.delete(listener);
    },
    dispatchEvent(): boolean {
      return true;
    },
  };
  const stub = vi.fn((query: string) => {
    media = query;
    return mql as unknown as MediaQueryList;
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: stub,
  });
  return {
    setMatches(value: boolean) {
      mql.matches = value;
    },
    dispatch() {
      const event = { matches: mql.matches, media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    query() {
      return media;
    },
  };
}