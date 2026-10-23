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

/** 3 层大纲：第一层缺省展开，第二层默认收起，第三层含两级目标与越界目标。 */
const multiLevelOutline: OutlineNode[] = [
  {
    title: '第一章',
    dest: { type: 'XYZ', pageIndex: 0 },
    children: [
      {
        title: '1.1 背景',
        dest: { type: 'FitH', pageIndex: 1, topMm: 10 },
        children: [
          { title: '1.1.1 术语', dest: { type: 'Fit', pageIndex: 2 }, children: [] },
          { title: '1.1.2 范围', dest: { type: 'Fit', pageIndex: 3 }, children: [] },
        ],
      },
      { title: '1.2 方法', dest: { type: 'Fit', pageIndex: 4 }, children: [] },
    ],
  },
  {
    title: '第二章',
    dest: { type: 'Fit', pageIndex: 4 },
    children: [],
  },
  {
    title: '附录（越界目标）',
    dest: { type: 'Fit', pageIndex: 99 },
    children: [],
  },
];

/** 读取列表的直接 li 子元素。 */
function directItems(list: Element): HTMLLIElement[] {
  return [...list.children].filter(
    (child): child is HTMLLIElement => child.tagName === 'LI',
  );
}

/** 读取大纲树中按 DOM 顺序排列的 ul 容器。 */
function outlineGroups(panel: HTMLElement): HTMLUListElement[] {
  return [...panel.querySelectorAll<HTMLUListElement>('.ofd-outline__children')];
}

/** 在按钮上派发方向键事件。 */
function pressKey(button: HTMLButtonElement, key: string): void {
  button.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

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

  it('多级大纲渲染 aria-level 1/2/3 与嵌套 role=group，默认仅展开第一层', async () => {
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 6,
      outline: multiLevelOutline,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(3);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    const tree = panel.querySelector<HTMLUListElement>('.ofd-outline__tree')!;
    expect(tree.getAttribute('role')).toBe('tree');

    const [level1] = directItems(tree);
    expect(level1?.getAttribute('role')).toBe('treeitem');
    expect(level1?.getAttribute('aria-level')).toBe('1');
    expect(level1?.getAttribute('aria-expanded')).toBe('true');
    const group1 = outlineGroups(panel)[0]!;
    expect(group1.getAttribute('role')).toBe('group');
    expect(group1.hidden).toBe(false);

    const level2 = directItems(group1);
    expect(level2.map((item) => item.getAttribute('aria-level'))).toEqual(['2', '2']);
    expect(level2[0]?.getAttribute('aria-expanded')).toBe('false');
    const group2 = outlineGroups(panel)[1]!;
    expect(group2.getAttribute('role')).toBe('group');
    expect(group2.hidden).toBe(true);

    const level3 = directItems(group2);
    expect(level3.map((item) => item.getAttribute('aria-level'))).toEqual(['3', '3']);
    expect(outlineTitles(panel).map((title) => title.textContent)).toEqual([
      '第一章',
      '1.1 背景',
      '1.1.1 术语',
      '1.1.2 范围',
      '1.2 方法',
      '第二章',
      '附录（越界目标）',
    ]);

    // 展开第二层后第三层可见；收起第一层后整棵子树隐藏。
    level2[0]!.querySelector<HTMLButtonElement>('.ofd-outline__toggle')!.click();
    expect(level2[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(group2.hidden).toBe(false);
    level1!.querySelector<HTMLButtonElement>('.ofd-outline__toggle')!.click();
    expect(level1!.getAttribute('aria-expanded')).toBe('false');
    expect(group1.hidden).toBe(true);
    level1!.querySelector<HTMLButtonElement>('.ofd-outline__toggle')!.click();
    expect(group1.hidden).toBe(false);
    viewer.destroy();
  });

  it('多级大纲方向键：展开/收起、上下移动与 Home/End', async () => {
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 6,
      outline: multiLevelOutline,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(3);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    const titles = () => outlineTitles(panel);

    // 初始：第一章展开，1.1 收起，第三层不可见。
    titles()[1]!.focus();
    expect(document.activeElement).toBe(titles()[1]);
    pressKey(titles()[1]!, 'ArrowRight');
    expect(titles()[1]!.closest('li')!.getAttribute('aria-expanded')).toBe('true');
    expect(outlineGroups(panel)[1]!.hidden).toBe(false);

    pressKey(titles()[1]!, 'ArrowDown');
    expect(document.activeElement).toBe(titles()[2]);
    expect(titles()[2]!.textContent).toBe('1.1.1 术语');
    pressKey(titles()[2]!, 'ArrowDown');
    expect(document.activeElement).toBe(titles()[3]);
    pressKey(titles()[3]!, 'ArrowUp');
    expect(document.activeElement).toBe(titles()[2]);

    pressKey(titles()[2]!, 'Home');
    expect(document.activeElement).toBe(titles()[0]);
    pressKey(titles()[0]!, 'ArrowUp');
    expect(document.activeElement).toBe(titles()[0]);
    pressKey(titles()[0]!, 'End');
    expect(document.activeElement).toBe(titles()[6]);

    // 收起已展开的父节点；再次左移回到父节点。
    titles()[1]!.focus();
    pressKey(titles()[1]!, 'ArrowLeft');
    expect(titles()[1]!.closest('li')!.getAttribute('aria-expanded')).toBe('false');
    expect(outlineGroups(panel)[1]!.hidden).toBe(true);
    expect(document.activeElement).toBe(titles()[1]);
    pressKey(titles()[1]!, 'ArrowLeft');
    expect(document.activeElement).toBe(titles()[0]);
    viewer.destroy();
  });

  it('多级大纲当前页高亮与无效 dest 降级', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer, shell, navigation } = await createIntegratedViewer({
      pageCount: 6,
      outline: multiLevelOutline,
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(3);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    const outlineView = navigation()!.outline!;
    const toggle = (title: string) =>
      outlineTitles(panel)
        .find((button) => button.textContent === title)!
        .closest('li')!
        .querySelector<HTMLButtonElement>('.ofd-outline__toggle')!;

    toggle('1.1 背景').click();
    viewer.goToPage(4);
    expect(outlineView.getCurrentTitle()).toBe('1.1.2 范围');
    const current = panel.querySelector<HTMLElement>('.ofd-outline__item[aria-current="true"]')!;
    expect(current.textContent).toContain('1.1.2 范围');

    viewer.goToPage(5);
    expect(outlineView.getCurrentTitle()).toBe('第二章');

    viewer.goToPage(1);
    expect(outlineView.getCurrentTitle()).toBe('第一章');

    outlineTitles(panel)
      .find((button) => button.textContent === '1.1.1 术语')!
      .click();
    expect(viewer.getPageNumber()).toBe(3);

    const invalid = outlineTitles(panel).find(
      (button) => button.textContent === '附录（越界目标）',
    )!;
    expect(invalid.getAttribute('aria-disabled')).toBe('true');
    expect(invalid.closest('.ofd-outline__item')?.getAttribute('data-dest-invalid')).toBe('true');
    invalid.click();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('W_NAV_DEST'));
    expect(viewer.getPageNumber()).toBe(3);
    expect(outlineTitles(panel).some((button) => button.textContent === '附录（越界目标）')).toBe(
      true,
    );
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