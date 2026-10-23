/**
 * 文档全屏 loading / 错误卡视觉与计时契约（设计方案 §5.5 / §6.9.2）。
 *
 * 用未决的引擎打开替身覆盖打开中的各个阶段：延迟显示、最短展示、淡出、
 * 取消与失败立即隐藏；断言只读取公开 DOM 与阅读器状态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { OFDViewer } from '../../../src/viewer';
import type { ViewerSource } from '../../../src/index';

/** 延迟/最短展示/淡出时长，单位毫秒；与实现契约一致。 */
const DELAY_MS = 150;
const MIN_VISIBLE_MS = 300;
const FADE_MS = 150;

/** 未决结果。 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/**
 * 创建未决结果。
 *
 * @returns promise 与控制函数。
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** 生成页尺寸。 */
function makePageInfos(count: number): PageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
}

/** 生成单页替身。 */
function makePage(index: number): unknown {
  return {
    index,
    getSize: () => ({ width: 210, height: 297 }),
    getViewport: (options: { dpi?: number } = {}) => {
      const dpi = options.dpi ?? 96;
      return {
        width: Math.ceil((210 / 25.4) * dpi),
        height: Math.ceil((297 / 25.4) * dpi),
      };
    },
    render: (params: { canvasContext: { clearRect: (...args: number[]) => void } }) => {
      params.canvasContext.clearRect(0, 0, 1, 1);
      return { promise: Promise.resolve(), cancel: vi.fn() };
    },
    getTextContent: async () => ({ items: [], chars: [] }),
    exportImage: async () => {
      throw new Error('not implemented');
    },
  };
}

/** 生成打开成功的引擎文档替身。 */
function makeDocument(count = 3): unknown {
  return {
    pageCount: count,
    getPageInfos: async () => makePageInfos(count),
    getPage: async (index: number) => makePage(index),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount: count }),
    getPermissions: async () => ({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    }),
    getSignatureEntries: async () => [],
    getSignedValue: async () => undefined,
    close: async () => undefined,
  };
}

/** 打开中的阅读器与全屏 loading 元素。 */
interface PendingViewer {
  readonly viewer: OFDViewer;
  readonly pending: Deferred<unknown>;
  readonly status: HTMLElement;
  readonly error: HTMLElement;
}

/**
 * 创建一个引擎打开尚未完成的阅读器。
 *
 * @param source 打开来源。
 * @returns 阅读器、未决结果与 loading/error 元素。
 */
function createPendingViewer(source: ViewerSource = new ArrayBuffer(8)): PendingViewer {
  const pending = deferred<unknown>();
  engineMocks.open.mockReset();
  engineMocks.open.mockReturnValue(pending.promise);
  const viewer = new OFDViewer({
    container: document.body,
    source,
    crypto: { enabled: false },
  });
  // 取消/销毁会中止打开，ready 可能 reject；测试自行断言，避免未处理拒绝。
  void viewer.ready.catch(() => undefined);
  const root = viewer.getElements().root;
  const status = root.querySelector<HTMLElement>('.ofd-viewer__loading');
  const error = root.querySelector<HTMLElement>('.ofd-viewer__loading-error');
  if (!status || !error) throw new Error('全屏 loading 元素缺失');
  return { viewer, pending, status, error };
}

/** 读取状态层按钮。 */
function statusButton(status: HTMLElement): HTMLButtonElement {
  const button = status.querySelector<HTMLButtonElement>('.ofd-viewer__loading-button');
  if (!button) throw new Error('取消按钮缺失');
  return button;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  engineMocks.open.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('文档全屏 loading', () => {
  it('150 ms 延迟后显示，并暴露 role=status / aria-live=polite / aria-busy=true', async () => {
    const source = new File([new Uint8Array(4)], '季度报告.ofd');
    const { viewer, pending, status, error } = createPendingViewer(source);

    expect(status.hidden).toBe(true);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.querySelector('.ofd-viewer__loading-ring')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(status.querySelector('.ofd-viewer__loading-name')?.textContent).toBe('季度报告.ofd');
    expect(status.querySelector('.ofd-viewer__loading-text')?.textContent).toBe('正在打开文档…');
    expect(statusButton(status).textContent).toBe('取消');
    // 取消按钮可聚焦，但不主动抢焦点。
    expect(statusButton(status).disabled).toBe(false);
    // 错误卡不随 loading 一起出现。
    expect(error.hidden).toBe(true);
    expect(error.getAttribute('role')).toBe('alert');

    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(status.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(status.hidden).toBe(false);

    viewer.destroy();
    pending.resolve(makeDocument(1));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('文档名回退：URL 取 basename，缺失时显示“文档”', async () => {
    const first = createPendingViewer('https://example.com/docs/%E6%8A%A5%E5%91%8A.ofd?token=1');
    expect(
      first.status.querySelector('.ofd-viewer__loading-name')?.textContent,
    ).toBe('报告.ofd');
    first.viewer.destroy();
    first.pending.resolve(makeDocument(1));
    await vi.advanceTimersByTimeAsync(0);

    const second = createPendingViewer(new ArrayBuffer(8));
    expect(second.status.querySelector('.ofd-viewer__loading-name')?.textContent).toBe('文档');
    second.viewer.destroy();
    second.pending.resolve(makeDocument(1));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('显示后最短展示 300 ms，随后 150 ms 淡出', async () => {
    const { viewer, pending, status } = createPendingViewer();
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(status.hidden).toBe(false);

    pending.resolve(makeDocument(2));
    await viewer.ready;
    expect(viewer.getState().document.status).toBe('ready');
    expect(status.hidden).toBe(false);

    // 从显示时刻起至少 300 ms 才进入淡出。
    await vi.advanceTimersByTimeAsync(MIN_VISIBLE_MS - 1);
    expect(status.hidden).toBe(false);
    expect(status.dataset.fading).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(status.dataset.fading).toBe('true');

    // 淡出 150 ms 后才隐藏。
    await vi.advanceTimersByTimeAsync(FADE_MS - 1);
    expect(status.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(status.hidden).toBe(true);

    viewer.destroy();
  });

  it('150 ms 内完成打开时不显示 loading', async () => {
    const { viewer, pending, status } = createPendingViewer();
    await vi.advanceTimersByTimeAsync(100);
    pending.resolve(makeDocument(1));
    await viewer.ready;
    expect(status.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(DELAY_MS + MIN_VISIBLE_MS + FADE_MS);
    expect(status.hidden).toBe(true);
    expect(status.dataset.fading).toBeUndefined();

    viewer.destroy();
  });

  it('取消立即隐藏并进入“正在取消…”禁用态', async () => {
    const { viewer, pending, status } = createPendingViewer();
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    const cancel = statusButton(status);
    expect(status.hidden).toBe(false);

    cancel.click();
    expect(status.hidden).toBe(true);
    expect(status.dataset.fading).toBeUndefined();
    expect(cancel.disabled).toBe(true);
    expect(cancel.textContent).toBe('正在取消…');

    // 引擎打开晚到后走中止分支，文档回到空态且不残留 loading。
    pending.resolve(makeDocument(1));
    await vi.advanceTimersByTimeAsync(0);
    await expect(viewer.ready).resolves.toBeUndefined();
    expect(viewer.getState().document.status).toBe('closed');
    expect(status.hidden).toBe(true);

    viewer.destroy();
  });

  it('打开失败立即切换为 role=alert 错误卡，且不再显示 loading', async () => {
    const { viewer, pending, status, error } = createPendingViewer();
    pending.reject(new Error('文件损坏'));
    await expect(viewer.ready).rejects.toThrow('文件损坏');

    expect(status.hidden).toBe(true);
    expect(error.hidden).toBe(false);
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.querySelector('.ofd-viewer__loading-error-code')?.textContent).toBe(
      'OFD_OPEN_FAILED',
    );
    expect(error.querySelector('.ofd-viewer__loading-error-message')?.textContent).toBe(
      '文件损坏',
    );
    expect(error.querySelector('.ofd-viewer__loading-error-title')?.textContent).toBe(
      '打开文档失败',
    );
    const buttons = [...error.querySelectorAll<HTMLButtonElement>('.ofd-viewer__loading-button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['重试', '关闭']);

    // 失败后延迟/最短展示计时器均已清理，不会迟到显示 loading。
    await vi.advanceTimersByTimeAsync(DELAY_MS + MIN_VISIBLE_MS + FADE_MS);
    expect(status.hidden).toBe(true);
    expect(error.hidden).toBe(false);

    viewer.destroy();
  });
});