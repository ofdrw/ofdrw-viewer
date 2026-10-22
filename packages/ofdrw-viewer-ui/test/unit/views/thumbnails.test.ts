import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntegratedViewer,
  installEnvironment,
  resetDom,
  thumbnailItems,
} from './helpers';

beforeEach(() => {
  resetDom();
  installEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ThumbnailView 缩略图', () => {
  it('只为当前页 ±5 项渲染缩略图，并在翻页后同步窗口与高亮', async () => {
    const { viewer, shell, navigation } = await createIntegratedViewer({ pageCount: 1000 });
    viewer.openSidebar('thumbnails');
    const panel = shell.sidebar.getPanel('thumbnails');
    expect(panel).not.toBeNull();
    const thumbs = navigation()!.thumbnails;
    expect(thumbs).toBeDefined();

    await vi.waitFor(() => {
      expect(thumbs!.getRenderedPages().length).toBe(6);
    });
    expect(thumbnailItems(panel!)).toHaveLength(1000);
    // 第 1 页只覆盖 1..6，不会预生成 100 张。
    expect(thumbs!.getWindowPages()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(thumbs!.getRenderedPages()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(thumbItems(panel!).filter((item) => item.dataset.state === 'rendered')).toHaveLength(6);

    const first = panel!.querySelector<HTMLButtonElement>('.ofd-thumbnail[data-page="1"]')!;
    expect(first.getAttribute('aria-current')).toBe('page');

    viewer.goToPage(500);
    await vi.waitFor(() => {
      expect(thumbs!.getWindowPages()).toEqual([
        495, 496, 497, 498, 499, 500, 501, 502, 503, 504, 505,
      ]);
      expect(thumbs!.getRenderedPages()).toEqual(
        expect.arrayContaining([495, 496, 497, 498, 499, 500, 501, 502, 503, 504, 505]),
      );
    });
    // 千页文档中远离窗口的页不会提前渲染。
    expect(thumbs!.getRenderedPages().length).toBeLessThanOrEqual(17);
    expect(
      thumbs!.getRenderedPages().every(
        (page) => page <= 6 || (page >= 495 && page <= 505),
      ),
    ).toBe(true);
    expect(
      panel!.querySelector<HTMLButtonElement>('.ofd-thumbnail[data-page="500"]')!.getAttribute(
        'aria-current',
      ),
    ).toBe('page');
    expect(
      panel!.querySelector<HTMLButtonElement>('.ofd-thumbnail[data-page="1"]')!.getAttribute(
        'aria-current',
      ),
    ).toBe('false');
    viewer.destroy();
  });

  it('缩略图使用独立低分辨率 canvas，不占用主视图 canvas', async () => {
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 3 });
    viewer.openSidebar('thumbnails');
    const panel = shell.sidebar.getPanel('thumbnails')!;
    await vi.waitFor(() => {
      expect(
        panel.querySelector('.ofd-thumbnail[data-page="1"][data-state="rendered"]'),
      ).not.toBeNull();
    });
    const thumbnailCanvas = panel.querySelector<HTMLCanvasElement>(
      '.ofd-thumbnail[data-page="1"] canvas',
    );
    expect(thumbnailCanvas).not.toBeNull();
    expect(Number(thumbnailCanvas!.dataset.dpi)).toBeGreaterThanOrEqual(24);
    expect(Number(thumbnailCanvas!.dataset.dpi)).toBeLessThanOrEqual(96);
    expect(thumbnailCanvas!.width).toBeLessThan(400);
    expect(thumbnailCanvas).not.toBe(viewer.getPageView(1)?.canvas);
    viewer.destroy();
  });

  it('单页缩略图失败显示占位，不阻断主视图', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 4,
      failRenderPages: [0],
    });
    viewer.openSidebar('thumbnails');
    const panel = shell.sidebar.getPanel('thumbnails')!;
    await vi.waitFor(() => {
      const item = panel.querySelector<HTMLButtonElement>('.ofd-thumbnail[data-page="1"]');
      expect(item?.dataset.state).toBe('failed');
    });
    const failed = panel.querySelector<HTMLButtonElement>('.ofd-thumbnail[data-page="1"]')!;
    const fallback = failed.querySelector<HTMLElement>('.ofd-thumbnail__fallback')!;
    expect(fallback.hidden).toBe(false);
    expect(fallback.textContent).toBe('1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('W_THUMBNAIL'));
    // 主视图仍可用：文档 ready，翻页正常。
    expect(viewer.getState().document.status).toBe('ready');
    viewer.goToPage(4);
    expect(viewer.getPageNumber()).toBe(4);
    expect(panel.querySelectorAll('.ofd-thumbnail[data-state="rendered"]').length).toBeGreaterThan(
      0,
    );
    viewer.destroy();
  });

  it('侧栏关闭后暂停缩略图队列，重新打开恢复可知窗口', async () => {
    const { viewer, shell, navigation } = await createIntegratedViewer({ pageCount: 30 });
    viewer.openSidebar('thumbnails');
    const thumbs = navigation()!.thumbnails!;
    await vi.waitFor(() => {
      expect(thumbs.getRenderedPages().length).toBeGreaterThan(0);
    });
    viewer.closeSidebar();
    const renderedWhileClosed = thumbs.getRenderedPages().length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thumbs.getRenderedPages().length).toBe(renderedWhileClosed);

    viewer.openSidebar('thumbnails');
    viewer.goToPage(20);
    await vi.waitFor(() => {
      expect(thumbs.getWindowPages()).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    });
    expect(shell.sidebar.getPanel('thumbnails')).not.toBeNull();
    viewer.destroy();
  });
});

/** 缩略图按钮列表。 */
function thumbItems(panel: HTMLElement): HTMLButtonElement[] {
  return thumbnailItems(panel);
}