/**
 * 主题：light/dark/auto、系统主题变化与 CSS 变量入口。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeController, isTheme } from '../../../src/theme';
import { cleanupShells, createRoot, createShell, installMatchMedia } from './helpers';

afterEach(() => {
  cleanupShells();
});

describe('ThemeController', () => {
  it('auto 跟随 prefers-color-scheme 并响应变化', () => {
    const media = installMatchMedia(true);
    const root = createRoot();
    const changes: string[] = [];
    const controller = new ThemeController(root, 'auto', {
      onChange: (theme, resolved) => changes.push(`${theme}:${resolved}`),
    });

    expect(root.dataset.theme).toBe('auto');
    expect(root.dataset.resolvedTheme).toBe('dark');
    expect(controller.currentTheme).toBe('auto');
    expect(controller.currentResolvedTheme).toBe('dark');

    media.setMatches(false);
    media.dispatch();
    expect(root.dataset.resolvedTheme).toBe('light');

    controller.setTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.resolvedTheme).toBe('dark');
    controller.setTheme('light');
    expect(root.dataset.resolvedTheme).toBe('light');
    expect(changes).toContain('auto:light');
    controller.destroy();
    root.remove();
  });

  it('环境不支持 matchMedia 时 auto 回落 light', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const root = createRoot();
    const controller = new ThemeController(root, 'auto');
    expect(controller.currentResolvedTheme).toBe('light');
    controller.destroy();
    root.remove();
  });

  it('UI 外壳 setTheme 同步根节点 data-theme', () => {
    const media = installMatchMedia(false);
    const { shell, root } = createShell({ theme: 'auto' });
    expect(root.dataset.theme).toBe('auto');
    expect(root.dataset.resolvedTheme).toBe('light');
    media.setMatches(true);
    media.dispatch();
    expect(root.dataset.resolvedTheme).toBe('dark');
    shell.setTheme('light');
    expect(root.dataset.theme).toBe('light');
    expect(root.dataset.resolvedTheme).toBe('light');
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('sepia')).toBe(false);
  });
});