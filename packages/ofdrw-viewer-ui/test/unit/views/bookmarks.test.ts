import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkItem } from '@ofdrw/ofdrw-viewer-engine';
import {
  DEFAULT_PAGE_GAP,
  DEFAULT_PAGE_PADDING,
  MM_TO_CSS_PX,
  PageLayout,
} from '../../../src/page-layout';
import {
  bookmarkItems,
  createIntegratedViewer,
  installEnvironment,
  makePageInfos,
  resetDom,
} from './helpers';

const bookmarks: BookmarkItem[] = [
  { name: '封面', dest: { type: 'Fit', pageIndex: 0 } },
  { name: '正文', dest: { type: 'XYZ', pageIndex: 4, topMm: 20, zoom: 1.5 } },
  { name: '附录', dest: { type: 'FitH', pageIndex: 9, topMm: 0 } },
  { name: '坏目标', dest: { type: 'Fit', pageIndex: 42 } },
];

beforeEach(() => {
  resetDom();
  installEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BookmarkView 书签列表', () => {
  it('按 XML 顺序渲染，点击按 DocumentDestination 跳转并同步高亮', async () => {
    const { viewer, shell, navigation } = await createIntegratedViewer({
      pageCount: 10,
      bookmarks,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.bookmarks).toHaveLength(4);
    });
    viewer.openSidebar('bookmarks');
    const panel = shell.sidebar.getPanel('bookmarks')!;
    expect(bookmarkItems(panel).map((item) => item.textContent)).toEqual([
      expect.stringContaining('封面'),
      expect.stringContaining('正文'),
      expect.stringContaining('附录'),
      expect.stringContaining('坏目标'),
    ]);
    const bookmarkView = navigation()!.bookmarks!;
    expect(bookmarkView.getCurrentName()).toBe('封面');

    bookmarkItems(panel)[1]!.click();
    expect(viewer.getPageNumber()).toBe(5);
    expect(viewer.getScale()).toBe(1.5);
    // 统一锚点：页顶 + topMm 换算到当前缩放的 CSS 像素。
    const layout = new PageLayout({
      pageInfos: makePageInfos(10),
      scale: 1.5,
      rotation: 0,
      gap: DEFAULT_PAGE_GAP,
      padding: DEFAULT_PAGE_PADDING,
    });
    const expected = layout.getPageTop(4) + 20 * MM_TO_CSS_PX * 1.5;
    expect(viewer.getElements().main.scrollTop).toBeCloseTo(expected, 3);
    expect(bookmarkView.getCurrentName()).toBe('正文');
    expect(bookmarkItems(panel)[1]!.getAttribute('aria-current')).toBe('true');

    viewer.goToPage(10);
    expect(bookmarkView.getCurrentName()).toBe('附录');
    expect(bookmarkItems(panel)[2]!.getAttribute('aria-current')).toBe('true');
    viewer.destroy();
  });

  it('无效 dest 只 warning 并保留条目', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 10,
      bookmarks,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.bookmarks).toHaveLength(4);
    });
    viewer.openSidebar('bookmarks');
    const panel = shell.sidebar.getPanel('bookmarks')!;
    viewer.goToPage(3);
    const invalid = bookmarkItems(panel).find((item) => item.textContent?.includes('坏目标'))!;
    expect(invalid).toBeDefined();
    expect(invalid.dataset.destInvalid).toBe('true');
    invalid.click();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('W_NAV_DEST'));
    expect(viewer.getPageNumber()).toBe(3);
    expect(bookmarkItems(panel)).toHaveLength(4);
    viewer.destroy();
  });

  it('书签缺省 dest 时点击只 warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 2,
      bookmarks: [{ name: '无目标' }],
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.bookmarks).toHaveLength(1);
    });
    viewer.openSidebar('bookmarks');
    const panel = shell.sidebar.getPanel('bookmarks')!;
    bookmarkItems(panel)[0]!.click();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('W_NAV_DEST'));
    expect(viewer.getPageNumber()).toBe(1);
    viewer.destroy();
  });

  it('空书签显示明确空态', async () => {
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 3,
      bookmarks: [],
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.bookmarks).toEqual([]);
    });
    viewer.openSidebar('bookmarks');
    const panel = shell.sidebar.getPanel('bookmarks')!;
    expect(panel.querySelector('.ofd-nav__empty')?.textContent).toBe('本文档没有书签');
    viewer.destroy();
  });

  it('引擎缺少 getBookmarks 时显示 unsupported 空态而不崩溃', async () => {
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 2,
      omitBookmarks: true,
    });
    viewer.openSidebar('bookmarks');
    const panel = shell.sidebar.getPanel('bookmarks')!;
    expect(panel.querySelector('.ofd-nav__empty--unsupported')?.textContent).toBe(
      '当前环境不支持',
    );
    expect(viewer.getState().document.status).toBe('ready');
    viewer.destroy();
  });
});