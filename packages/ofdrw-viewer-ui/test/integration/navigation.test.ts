/**
 * 导航集成基线：缩略图、大纲、书签通过公共入口自动注册并驱动真实阅读器跳转。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import type { BookmarkItem, OutlineNode } from '@ofdrw/ofdrw-viewer-engine';
import { getUIShell } from '../../src/ui';
import { getNavigationServices } from '../../src/views/nav';
import { NAVIGATION_WARNING_EVENT } from '../../src/views/shared';
import { installDomEnvironment } from '../helpers/environment';
import { openViewer, type EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;

const OUTLINE: OutlineNode[] = [
  {
    title: '第一章',
    dest: { type: 'Fit', pageIndex: 1 },
    children: [
      { title: '1.1 小节', dest: { type: 'XYZ', pageIndex: 2, zoom: 1.5 }, children: [] },
    ],
  },
  {
    title: '无效目标',
    dest: { type: 'Fit', pageIndex: 99 },
    children: [],
  },
];

const MULTI_OUTLINE: OutlineNode[] = [
  {
    title: '第一章',
    dest: { type: 'XYZ', pageIndex: 0, zoom: 1.25 },
    children: [
      {
        title: '1.1 背景',
        dest: { type: 'FitH', pageIndex: 1, topMm: 5 },
        children: [
          { title: '1.1.1 术语', dest: { type: 'Fit', pageIndex: 2 }, children: [] },
        ],
      },
    ],
  },
  { title: '第二章', dest: { type: 'Fit', pageIndex: 3 }, children: [] },
];

const BOOKMARKS: BookmarkItem[] = [
  { name: '封面', dest: { type: 'XYZ', pageIndex: 0, zoom: 1 } },
  { name: '越界书签', dest: { type: 'FitH', pageIndex: 99 } },
];

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 等待导航视图绑定。 */
async function waitNavigation(
  viewer: Awaited<ReturnType<typeof openViewer>>['viewer'],
): Promise<NonNullable<ReturnType<typeof getNavigationServices>>> {
  await vi.waitFor(() => expect(getNavigationServices(viewer)).toBeDefined());
  return getNavigationServices(viewer)!;
}

describe('导航集成', () => {
  it('缩略图/大纲/书签跳转与当前页高亮', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer } = await openViewer(openMock, {
      pageCount: 3,
      outline: OUTLINE,
      bookmarks: BOOKMARKS,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(2);
      expect(viewer.getState().document.bookmarks).toHaveLength(2);
    });
    const shell = getUIShell(viewer)!;

    // 缩略图：只构建占位，点击后跳转。
    viewer.openSidebar('thumbnails');
    const navigation = await waitNavigation(viewer);
    const thumbnailPanel = shell.sidebar.getPanel('thumbnails')!;
    const thumbnails = [
      ...thumbnailPanel.querySelectorAll<HTMLButtonElement>('.ofd-thumbnail'),
    ];
    expect(thumbnails).toHaveLength(3);
    thumbnails[1]!.click();
    expect(viewer.getPageNumber()).toBe(2);

    // 大纲：默认展开第一层、子节点收起；点击节点按 dest 跳转并调整缩放。
    viewer.openSidebar('outline');
    await vi.waitFor(() => expect(navigation.outline).toBeDefined());
    const outlinePanel = shell.sidebar.getPanel('outline')!;
    const firstTitle = outlinePanel.querySelector<HTMLButtonElement>('.ofd-outline__title')!;
    expect(firstTitle.textContent).toBe('第一章');
    const childGroup = outlinePanel.querySelector<HTMLElement>('.ofd-outline__children')!;
    expect(childGroup.hidden).toBe(false);
    firstTitle.click();
    expect(viewer.getPageNumber()).toBe(2);

    const toggle = firstTitle
      .closest('.ofd-outline__item')!
      .querySelector<HTMLButtonElement>('.ofd-outline__toggle');
    if (toggle) {
      toggle.click();
      expect(childGroup.hidden).toBe(true);
      toggle.click();
      expect(childGroup.hidden).toBe(false);
    }
    const childTitle = [...outlinePanel.querySelectorAll<HTMLButtonElement>('.ofd-outline__title')]
      .find((element) => element.textContent === '1.1 小节')!;
    childTitle.click();
    expect(viewer.getPageNumber()).toBe(3);
    expect(viewer.getScale()).toBeCloseTo(1.5, 2);

    // 无效 dest 只告警、不跳转。
    const warnings: Array<{ code: string }> = [];
    viewer.getRoot().addEventListener(NAVIGATION_WARNING_EVENT, (event) => {
      warnings.push((event as CustomEvent<{ code: string }>).detail);
    });
    const invalidTitle = [...outlinePanel.querySelectorAll<HTMLButtonElement>('.ofd-outline__title')]
      .find((element) => element.textContent === '无效目标')!;
    expect(invalidTitle.getAttribute('aria-disabled')).toBe('true');
    invalidTitle.click();
    expect(warnings.some((warning) => warning.code === 'W_NAV_DEST')).toBe(true);
    expect(viewer.getPageNumber()).toBe(3);

    // 书签：按 XML 顺序渲染并跳转。
    viewer.openSidebar('bookmarks');
    await vi.waitFor(() => expect(navigation.bookmarks).toBeDefined());
    const bookmarkPanel = shell.sidebar.getPanel('bookmarks')!;
    const bookmarks = [...bookmarkPanel.querySelectorAll<HTMLButtonElement>('.ofd-bookmark')];
    expect(bookmarks.map((button) => button.textContent)).toEqual([
      expect.stringContaining('封面'),
      expect.stringContaining('越界书签'),
    ]);
    bookmarks[0]!.click();
    expect(viewer.getPageNumber()).toBe(1);
    expect(bookmarks[1]!.getAttribute('aria-disabled')).toBe('true');
    bookmarks[1]!.click();
    expect(viewer.getPageNumber()).toBe(1);
    expect(warn).toHaveBeenCalled();
    viewer.destroy();
  });

  it('多级大纲渲染 aria-level/role=group，逐层展开后可跳转第三级', async () => {
    const { viewer } = await openViewer(openMock, {
      pageCount: 4,
      outline: MULTI_OUTLINE,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(2);
    });
    const shell = getUIShell(viewer)!;
    viewer.openSidebar('outline');
    const navigation = await waitNavigation(viewer);
    await vi.waitFor(() => expect(navigation.outline).toBeDefined());
    const panel = shell.sidebar.getPanel('outline')!;

    const level1 = panel.querySelector<HTMLLIElement>('.ofd-outline__tree > li')!;
    expect(level1.getAttribute('aria-level')).toBe('1');
    expect(level1.getAttribute('aria-expanded')).toBe('true');
    const level1Group = level1.querySelector<HTMLUListElement>('.ofd-outline__children')!;
    expect(level1Group.getAttribute('role')).toBe('group');
    expect(level1Group.hidden).toBe(false);

    const level2 = [...level1Group.children] as HTMLLIElement[];
    expect(level2.map((item) => item.getAttribute('aria-level'))).toEqual(['2']);
    expect(level2[0]!.getAttribute('aria-expanded')).toBe('false');
    const level2Group = level2[0]!.querySelector<HTMLUListElement>('.ofd-outline__children')!;
    expect(level2Group.getAttribute('role')).toBe('group');
    expect(level2Group.hidden).toBe(true);
    const level3 = [...level2Group.children] as HTMLLIElement[];
    expect(level3.map((item) => item.getAttribute('aria-level'))).toEqual(['3']);

    level2[0]!
      .querySelector<HTMLButtonElement>('.ofd-outline__toggle')!
      .click();
    expect(level2Group.hidden).toBe(false);
    const deepTitle = level3[0]!.querySelector<HTMLButtonElement>('.ofd-outline__title')!;
    deepTitle.click();
    expect(viewer.getPageNumber()).toBe(3);
    viewer.destroy();
  });

  it('引擎缺少 getOutline/getBookmarks 时显示 unsupported 空态且阅读不中断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer } = await openViewer(openMock, {
      pageCount: 2,
      omit: { outline: true, bookmarks: true },
    });
    await vi.waitFor(() =>
      expect(
        viewer.getState().ui.warnings.some((warning) => warning.code === 'W_OUTLINE'),
      ).toBe(true),
    );
    expect(viewer.getState().document.outline).toBeUndefined();
    expect(viewer.getState().document.bookmarks).toBeUndefined();

    const shell = getUIShell(viewer)!;
    viewer.openSidebar('outline');
    await waitNavigation(viewer);
    const outlinePanel = shell.sidebar.getPanel('outline')!;
    expect(outlinePanel.textContent).toContain('当前环境不支持');

    viewer.openSidebar('bookmarks');
    const bookmarkPanel = shell.sidebar.getPanel('bookmarks')!;
    await vi.waitFor(() => expect(bookmarkPanel.textContent).toContain('当前环境不支持'));
    expect(viewer.getPageCount()).toBe(2);
    viewer.destroy();
    expect(warn).not.toHaveBeenCalled();
  });

  it('1000 页文档缩略图只渲染当前页窗口', async () => {
    const { viewer } = await openViewer(openMock, { pageCount: 1000 });
    viewer.openSidebar('thumbnails');
    const navigation = await waitNavigation(viewer);
    await vi.waitFor(() => expect(navigation.thumbnails).toBeDefined());
    const thumbnails = navigation.thumbnails!;
    await vi.waitFor(() => {
      const pages = thumbnails.getWindowPages();
      expect(pages).toContain(1);
      expect(pages.length).toBeLessThanOrEqual(12);
    });
    expect(thumbnails.getWindowPages()).not.toContain(500);
    viewer.destroy();
  });
});