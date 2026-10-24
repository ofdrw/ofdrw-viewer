/**
 * 缩略图加载骨架与五态契约（设计方案 §6.9.4 / §7.2）。
 *
 * 覆盖 `idle | queued | rendering | rendered | failed`：仅渲染窗口内显示骨架，
 * 窗口外显示静态页码；失败保留占位并仅在点击后重试；骨架对读屏隐藏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntegratedViewer,
  installEnvironment,
  resetDom,
  thumbnailItems,
} from './helpers';
import { UI_WARNING_CODES } from '../../../src/diagnostics';

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

/**
 * 读取指定页缩略图按钮。
 *
 * @param panel 面板根节点。
 * @param pageNumber 页码，1-based。
 * @returns 按钮元素。
 */
function itemOf(panel: HTMLElement, pageNumber: number): HTMLButtonElement {
  const item = panel.querySelector<HTMLButtonElement>(
    `.ofd-thumbnail[data-page="${pageNumber}"]`,
  );
  if (!item) throw new Error(`第 ${pageNumber} 页缩略图缺失`);
  return item;
}

/**
 * 读取缩略图骨架。
 *
 * @param item 缩略图按钮。
 * @returns 骨架元素。
 */
function skeletonOf(item: HTMLElement): HTMLElement {
  const skeleton = item.querySelector<HTMLElement>('.ofd-thumbnail__skeleton');
  if (!skeleton) throw new Error('缩略图骨架缺失');
  return skeleton;
}

/**
 * 读取缩略图静态页码占位。
 *
 * @param item 缩略图按钮。
 * @returns 占位元素。
 */
function fallbackOf(item: HTMLElement): HTMLElement {
  const fallback = item.querySelector<HTMLElement>('.ofd-thumbnail__fallback');
  if (!fallback) throw new Error('缩略图页码占位缺失');
  return fallback;
}

beforeEach(() => {
  resetDom();
  installEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDom();
});

describe('缩略图加载骨架', () => {
  it('窗口内 queued 显示 aria-hidden 骨架，窗口外 idle 显示静态页码', async () => {
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 1000 });
    viewer.openSidebar('thumbnails');
    const panel = shell.sidebar.getPanel('thumbnails');
    expect(panel).not.toBeNull();
    const items = thumbnailItems(panel!);
    expect(items).toHaveLength(1000);

    // 打开侧栏后同步进入 queued，尚未启动渲染任务。
    const first = itemOf(panel!, 1);
    expect(first.dataset.state).toBe('queued');
    expect(skeletonOf(first).hidden).toBe(false);
    expect(skeletonOf(first).getAttribute('aria-hidden')).toBe('true');
    expect(fallbackOf(first).hidden).toBe(true);
    // 骨架之外没有独立 spinner，按钮名称保持可读。
    expect(first.querySelector('.ofd-thumbnail__spinner')).toBeNull();
    expect(first.getAttribute('aria-label')).toBe('第 1 页，共 1,000 页');

    // 远离开口的页（窗口 1..6 之外）不播骨架，只显示静态页码。
    const far = itemOf(panel!, 500);
    expect(far.dataset.state).toBe('idle');
    expect(skeletonOf(far).hidden).toBe(true);
    expect(fallbackOf(far).hidden).toBe(false);
    expect(fallbackOf(far).textContent).toBe('500');
    expect(far.getAttribute('aria-label')).toBe('第 500 页，共 1,000 页');

    // 渲染完成后隐藏骨架与页码，展示 canvas。
    await vi.waitFor(() => {
      expect(first.dataset.state).toBe('rendered');
    });
    expect(skeletonOf(first).hidden).toBe(true);
    expect(fallbackOf(first).hidden).toBe(true);
    expect(first.querySelector('canvas')).not.toBeNull();

    viewer.destroy();
  });

  it('经历 queued → rendering → rendered，其余窗口项保持 queued', async () => {
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 30 });
    const originalGetPage = viewer.getPage.bind(viewer);
    const pageOne = await originalGetPage(1);
    const gate = deferred<typeof pageOne>();
    vi.spyOn(viewer, 'getPage').mockImplementation((pageNumber: number) =>
      pageNumber === 1 ? gate.promise : originalGetPage(pageNumber),
    );

    viewer.openSidebar('thumbnails');
    const panel = shell.sidebar.getPanel('thumbnails')!;
    const first = itemOf(panel, 1);
    const second = itemOf(panel, 2);
    expect(first.dataset.state).toBe('queued');
    expect(skeletonOf(first).hidden).toBe(false);

    await vi.waitFor(() => {
      expect(first.dataset.state).toBe('rendering');
    });
    expect(skeletonOf(first).hidden).toBe(false);
    expect(second.dataset.state).toBe('queued');
    expect(skeletonOf(second).hidden).toBe(false);

    gate.resolve(pageOne);
    await vi.waitFor(() => {
      expect(first.dataset.state).toBe('rendered');
    });
    expect(skeletonOf(first).hidden).toBe(true);
    expect(first.querySelector('canvas')).not.toBeNull();

    viewer.destroy();
  });

  it('失败显示灰色占位 + 页码，不自动重试，仅点击后恢复渲染', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 第 6 页在缩略图窗口内、但不在主视图首屏，首次渲染失败。
    const failures = [5];
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 10,
      failRenderPages: failures,
    });
    viewer.openSidebar('thumbnails');
    const panel = shell.sidebar.getPanel('thumbnails')!;
    const failed = itemOf(panel, 6);

    await vi.waitFor(() => {
      expect(failed.dataset.state).toBe('failed');
    });
    expect(skeletonOf(failed).hidden).toBe(true);
    expect(fallbackOf(failed).hidden).toBe(false);
    expect(fallbackOf(failed).textContent).toBe('6');
    expect(failed.querySelector('canvas')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UI_WARNING_CODES.W_THUMBNAIL));

    // 失败是终态，不参与自动重试。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(failed.dataset.state).toBe('failed');

    // 恢复引擎后点击该缩略图：先重试，再跳转。
    failures.length = 0;
    failed.click();
    await vi.waitFor(() => {
      expect(failed.dataset.state).toBe('rendered');
    });
    expect(skeletonOf(failed).hidden).toBe(true);
    expect(fallbackOf(failed).hidden).toBe(true);
    expect(failed.querySelector('canvas')).not.toBeNull();
    expect(viewer.getPageNumber()).toBe(6);

    viewer.destroy();
  });
});