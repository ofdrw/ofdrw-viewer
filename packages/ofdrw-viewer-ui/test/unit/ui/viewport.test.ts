/**
 * 断点计算与容器宽度监听。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VIEWPORT_BREAKPOINTS,
  ViewportObserver,
  parseSidebarMode,
  parseViewport,
  resolveSidebarMode,
  resolveViewport,
} from '../../../src/ui/viewport';
import { createRoot, setClientWidth } from './helpers';

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
});

describe('断点计算', () => {
  it('四档边界与设计一致', () => {
    expect(VIEWPORT_BREAKPOINTS).toEqual({ desktop: 1024, compact: 768, mobile: 480 });
    expect(resolveViewport(1280)).toBe('desktop');
    expect(resolveViewport(1024)).toBe('desktop');
    expect(resolveViewport(1023)).toBe('compact');
    expect(resolveViewport(768)).toBe('compact');
    expect(resolveViewport(767)).toBe('mobile');
    expect(resolveViewport(480)).toBe('mobile');
    expect(resolveViewport(479)).toBe('narrow');
    expect(resolveViewport(0)).toBe('desktop');
  });

  it('侧栏布局映射', () => {
    expect(resolveSidebarMode('desktop')).toBe('inline');
    expect(resolveSidebarMode('compact')).toBe('overlay');
    expect(resolveSidebarMode('mobile')).toBe('drawer');
    expect(resolveSidebarMode('narrow')).toBe('drawer');
    expect(parseViewport('mobile')).toBe('mobile');
    expect(parseViewport('unknown')).toBeUndefined();
    expect(parseSidebarMode('overlay')).toBe('overlay');
    expect(parseSidebarMode('inline')).toBe('inline');
  });
});

describe('ViewportObserver', () => {
  it('读取容器宽度并在 resize 时回调', () => {
    const root = createRoot(900);
    const calls: string[] = [];
    const observer = new ViewportObserver(root, {
      onResize: (_width, mode) => calls.push(mode),
    });
    observer.start();
    expect(calls).toEqual(['compact']);
    expect(observer.width).toBe(900);

    setClientWidth(root, 400);
    window.dispatchEvent(new Event('resize'));
    expect(calls.at(-1)).toBe('narrow');
    expect(observer.mode).toBe('narrow');

    observer.stop();
    expect(observer.isStarted).toBe(false);
  });

  it('优先使用 ResizeObserver 监听容器变化', () => {
    const root = createRoot(1200);
    const callbacks: ResizeObserverCallback[] = [];
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    const calls: string[] = [];
    const observer = new ViewportObserver(root, {
      onResize: (_width, mode) => calls.push(mode),
    });
    observer.start();
    expect(calls).toEqual(['desktop']);
    setClientWidth(root, 700);
    callbacks[0]?.([], {} as ResizeObserver);
    expect(calls.at(-1)).toBe('mobile');
    observer.stop();
  });

  it('容器宽度为 0 时回退窗口/media 查询', () => {
    const root = createRoot(0);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === '(max-width: 479px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    const modes: string[] = [];
    const observer = new ViewportObserver(root, {
      onResize: (_width, mode) => modes.push(mode),
    });
    observer.start();
    expect(modes.at(-1)).toBe('narrow');
    observer.stop();
  });
});