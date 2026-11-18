/**
 * 大纲/书签收敛到动作服务的单测（UI 动作处理机制设计 §11.2）。
 *
 * 覆盖三条路径：
 * - 节点声明动作且动作服务可用：经 `runActions()` 执行，面板不直接跳转；
 * - 节点无动作：回退 `goToDestination()`，保持既有导航行为；
 * - 动作服务缺失：即使节点声明动作也回退跳转。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInfo, BookmarkItem, OutlineNode } from '@ofdrw/ofdrw-viewer-engine';

import { activateNavigationEntry } from '../../../src/views/shared';
import {
  bookmarkItems,
  createIntegratedViewer,
  installEnvironment,
  outlineTitles,
  resetDom,
} from './helpers';
import { UI_WARNING_CODES } from '../../../src/diagnostics';
import type { ActionOutcome } from '../../../src/actions/types';

/** 构造大纲节点动作（`Goto` 到指定页）。 */
function gotoAction(pageIndex: number): ActionInfo {
  return {
    event: 'CLICK',
    type: 'goto',
    owner: { kind: 'outline' },
    payload: { type: 'goto', dest: { type: 'Fit', pageIndex } },
  } as ActionInfo;
}

beforeEach(() => {
  resetDom();
  installEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('大纲节点经动作服务执行', () => {
  it('节点声明动作时走 runActions，面板不直接按 dest 跳转', async () => {
    const outline: OutlineNode[] = [
      {
        title: '带动作',
        dest: { type: 'Fit', pageIndex: 1 },
        actions: [gotoAction(2)],
        children: [],
      },
    ];
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 5, outline });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(1);
    });
    // 面板经 `getActionService()` 取服务执行；这里注入记录调用的替身。
    const runActions = vi.fn(async () => ['executed'] as ActionOutcome[]);
    viewer.attachActionService({ runActions });

    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    outlineTitles(panel)[0]!.click();
    await vi.waitFor(() => {
      expect(runActions).toHaveBeenCalledTimes(1);
    });
    expect(runActions).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'goto' })],
      { trigger: 'HOST', pageIndex: 0 },
    );
    viewer.destroy();
  });

  it('节点无动作时回退 goToDestination', async () => {
    const outline: OutlineNode[] = [
      { title: '无动作', dest: { type: 'Fit', pageIndex: 2 }, children: [] },
    ];
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 5, outline });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(1);
    });
    // 核心把动作服务挂在扩展服务槽上，面板经 viewers 的 `runActions` 最小面访问它。
    const service = { runActions: vi.fn(async () => ['executed'] as ActionOutcome[]) };
    const attach = vi.spyOn(viewer, 'attachActionService');
    attach.mockImplementation(() => {
      (viewer as unknown as { getState: () => unknown }).getState();
      return () => undefined;
    });

    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    outlineTitles(panel)[0]!.click();
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(3);
    });
    expect(service.runActions).not.toHaveBeenCalled();
    viewer.destroy();
  });

  it('动作服务缺失时即使节点有动作也回退跳转', async () => {
    const outline: OutlineNode[] = [
      {
        title: '带动作',
        dest: { type: 'Fit', pageIndex: 3 },
        actions: [gotoAction(1)],
        children: [],
      },
    ];
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 5, outline });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(1);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    outlineTitles(panel)[0]!.click();
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(4);
    });
    viewer.destroy();
  });

  it('动作服务抛错时不阻断导航，改按 dest 跳转并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outline: OutlineNode[] = [
      {
        title: '动作异常',
        dest: { type: 'Fit', pageIndex: 3 },
        actions: [gotoAction(1)],
        children: [],
      },
    ];
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 5, outline });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(1);
    });
    const runActions = vi.fn(async () => {
      throw new Error('boom');
    });
    viewer.attachActionService({ runActions });

    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    outlineTitles(panel)[0]!.click();
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(4);
    });
    expect(runActions).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UI_WARNING_CODES.W_NAV_ACTION));
    viewer.destroy();
  });
});

describe('书签经动作服务执行', () => {
  it('书签激活走统一入口，服务可用时保持跳转', async () => {
    const bookmarks: BookmarkItem[] = [
      { name: '正文', dest: { type: 'Fit', pageIndex: 3 } },
    ];
    const { viewer, shell } = await createIntegratedViewer({ pageCount: 6, bookmarks });
    await vi.waitFor(() => {
      expect(viewer.getState().document.bookmarks).toHaveLength(1);
    });
    viewer.openSidebar('bookmarks');
    const panel = shell.sidebar.getPanel('bookmarks')!;
    bookmarkItems(panel)[0]!.click();
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(4);
    });
    viewer.destroy();
  });
});

describe('activateNavigationEntry 回退行为', () => {
  /** 构造最小导航视图替身：只实现统一跳转所需的能力。 */
  function createViewer(): Parameters<typeof activateNavigationEntry>[0] & {
    readonly goToPage: ReturnType<typeof vi.fn>;
    readonly service: { readonly runActions: ReturnType<typeof vi.fn> };
  } {
    const goToPage = vi.fn();
    const service = { runActions: vi.fn(async () => ['executed'] as ActionOutcome[]) };
    return {
      getState: () => ({ document: { pageCount: 3 } }) as never,
      getElements: () => ({ root: document.createElement('div'), main: document.createElement('div') }) as never,
      getPageInfos: () => [
        { index: 0, widthMm: 210, heightMm: 297 },
        { index: 1, widthMm: 210, heightMm: 297 },
        { index: 2, widthMm: 210, heightMm: 297 },
      ],
      getPageInfo: () => ({ index: 0, widthMm: 210, heightMm: 297 }),
      getDocument: () => null,
      getPage: async () => {
        throw new Error('not used');
      },
      getScale: () => 1,
      getRotation: () => 0,
      getPageNumber: () => 1,
      getSidebarView: () => null,
      isFeatureEnabled: () => false,
      goToPage,
      setScale: vi.fn(),
      setZoomMode: vi.fn(),
      on: () => () => undefined,
      getActionService: () => service,
      service,
    } as never;
  }

  it('无动作时回退 goToDestination', async () => {
    const viewer = createViewer();
    const navigated = await activateNavigationEntry(viewer, [], { type: 'Fit', pageIndex: 1 });
    expect(navigated).toBe(true);
    expect(viewer.service.runActions).not.toHaveBeenCalled();
    expect(viewer.goToPage).toHaveBeenCalledWith(2, expect.objectContaining({ smooth: true }));
  });

  it('动作服务不可用时回退 goToDestination', async () => {
    const base = createViewer();
    const viewer = { ...base, getActionService: () => undefined } as never;
    const navigated = await activateNavigationEntry(viewer, [gotoAction(2)], {
      type: 'Fit',
      pageIndex: 1,
    });
    expect(navigated).toBe(true);
    expect((viewer as unknown as { goToPage: ReturnType<typeof vi.fn> }).goToPage).toHaveBeenCalled();
  });
});

