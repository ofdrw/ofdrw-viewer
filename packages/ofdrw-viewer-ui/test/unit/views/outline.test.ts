import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutlineNode } from '@ofdrw/ofdrw-viewer-engine';
import {
  createIntegratedViewer,
  installEnvironment,
  outlineTitles,
  resetDom,
} from './helpers';

const outline: OutlineNode[] = [
  {
    title: '第一章',
    expanded: true,
    dest: { type: 'XYZ', pageIndex: 0, topMm: 0 },
    children: [
      {
        title: '1.1 背景',
        dest: { type: 'FitH', pageIndex: 2, topMm: 10 },
        children: [],
      },
    ],
  },
  {
    title: '第二章',
    dest: { type: 'Fit', pageIndex: 4 },
    children: [],
  },
  {
    title: '损坏目标',
    dest: { type: 'Fit', pageIndex: 99 },
    children: [],
  },
];

beforeEach(() => {
  resetDom();
  installEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OutlineView 大纲树', () => {
  it('保持 XML 层级/顺序，默认展开第一层并支持展开收起', async () => {
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 5, outline });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(3);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    const titles = outlineTitles(panel);
    expect(titles.map((title) => title.textContent)).toEqual([
      '第一章',
      '1.1 背景',
      '第二章',
      '损坏目标',
    ]);
    // 第一层默认展开，第二层子项可见。
    const rootItem = panel.querySelector<HTMLLIElement>('.ofd-outline__tree > li')!;
    expect(rootItem.getAttribute('aria-expanded')).toBe('true');
    expect(rootItem.querySelector<HTMLElement>('.ofd-outline__children')!.hidden).toBe(false);
    expect(titles[0]!.closest('li')!.getAttribute('aria-level')).toBe('1');
    expect(titles[1]!.closest('li')!.getAttribute('aria-level')).toBe('2');

    const toggle = rootItem.querySelector<HTMLButtonElement>('.ofd-outline__toggle')!;
    toggle.click();
    expect(rootItem.getAttribute('aria-expanded')).toBe('false');
    expect(rootItem.querySelector<HTMLElement>('.ofd-outline__children')!.hidden).toBe(true);
    toggle.click();
    expect(rootItem.getAttribute('aria-expanded')).toBe('true');
    expect(rootItem.querySelector<HTMLElement>('.ofd-outline__children')!.hidden).toBe(false);
    viewer.destroy();
  });

  it('当前页高亮取 pageIndex ≤ 当前页的最后一个节点', async () => {
    const { viewer, shell, navigation } = await createIntegratedViewer({
      pageCount: 5,
      outline,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(3);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    const outlineView = navigation()!.outline!;

    viewer.goToPage(1);
    expect(outlineView.getCurrentTitle()).toBe('第一章');
    viewer.goToPage(3);
    expect(outlineView.getCurrentTitle()).toBe('1.1 背景');
    viewer.goToPage(5);
    expect(outlineView.getCurrentTitle()).toBe('第二章');
    // 超出全部目标页时仍保留最后一个匹配。
    viewer.goToPage(5);
    expect(outlineView.getCurrentTitle()).toBe('第二章');
    expect(
      panel.querySelector('.ofd-outline__item[aria-current="true"]')?.textContent,
    ).toContain('第二章');
    viewer.destroy();
  });

  it('无效 dest 只 warning 并保留节点，不改变当前页', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 5, outline });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(3);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    viewer.goToPage(2);
    const invalid = outlineTitles(panel).find((title) => title.textContent === '损坏目标')!;
    expect(invalid).toBeDefined();
    expect(invalid.closest('.ofd-outline__item')?.getAttribute('data-dest-invalid')).toBe('true');
    invalid.click();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('W_NAV_DEST'));
    expect(viewer.getPageNumber()).toBe(2);
    expect(outlineTitles(panel).some((title) => title.textContent === '损坏目标')).toBe(true);
    viewer.destroy();
  });

  it('空大纲显示明确空态', async () => {
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 2, outline: [] });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toEqual([]);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    expect(panel.querySelector('.ofd-nav__empty')?.textContent).toBe('本文档没有大纲');
    viewer.destroy();
  });

  it('引擎缺少 getOutline 时显示 unsupported 空态而不崩溃', async () => {
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 2,
      omitOutline: true,
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    expect(panel.querySelector('.ofd-nav__empty--unsupported')?.textContent).toBe(
      '当前环境不支持',
    );
    expect(viewer.getState().document.status).toBe('ready');
    viewer.destroy();
  });
});