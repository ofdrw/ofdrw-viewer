/**
 * Goto / GotoA 动作 handler 单测（UI 动作处理机制设计 §8.2 / §8.4）。
 *
 * 同时覆盖 `goToDestination()` 新增的 `smooth` 选项两个方向：
 * 传 `{smooth:false}` 时下发 `smooth:false`；不传第三参时仍是 `smooth:true`
 * （既有导航视图不传该参数，行为必须保持原样）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionInfo, AttachmentInfo, BookmarkItem } from '@ofdrw/ofdrw-viewer-engine';
import { createGotoHandler } from '../../../src/actions/handlers/goto';
import { createGotoAttachmentHandler } from '../../../src/actions/handlers/goto-attachment';
import { goToDestination } from '../../../src/views/shared';
import type { NavigationViewer } from '../../../src/views/shared';
import { createInitialViewerState } from '../../../src/state';

const CONTEXT = { trigger: 'CLICK' as const, pageIndex: 0 };

/** 构造 Goto 动作。 */
function gotoAction(payload: Record<string, unknown>): ActionInfo {
  return {
    event: 'CLICK',
    type: 'goto',
    owner: { kind: 'page', pageIndex: 0 },
    payload: { type: 'goto', ...payload },
  } as ActionInfo;
}

/** 构造最小导航视图替身。 */
function createNavigationViewer(): NavigationViewer & { goToPage: ReturnType<typeof vi.fn> } {
  const goToPage = vi.fn();
  const state = createInitialViewerState();
  return {
    getState: () => ({ ...state, document: { ...state.document, pageCount: 3 } }),
    getElements: () => ({ root: document.createElement('div') }) as never,
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
    isFeatureEnabled: () => true,
    goToPage,
    setScale: vi.fn(),
    setZoomMode: vi.fn(),
    on: () => () => undefined,
  } as never;
}

describe('goToDestination 的 smooth 选项', () => {
  it('不传第三参时保持平滑滚动（既有导航行为不变）', () => {
    const viewer = createNavigationViewer();
    const dest = { type: 'XYZ', pageIndex: 1, topMm: 0 } as const;
    expect(goToDestination(viewer, dest)).toBe(true);
    expect(viewer.goToPage).toHaveBeenCalledTimes(1);
    expect(viewer.goToPage.mock.calls[0]![1]).toMatchObject({ smooth: true });
  });

  it('传 {smooth:false} 时下发 smooth:false', () => {
    const viewer = createNavigationViewer();
    const dest = { type: 'XYZ', pageIndex: 1, topMm: 0 } as const;
    expect(goToDestination(viewer, dest, { smooth: false })).toBe(true);
    expect(viewer.goToPage.mock.calls[0]![1]).toMatchObject({ smooth: false });
  });

  it('传空对象时仍按平滑滚动处理', () => {
    const viewer = createNavigationViewer();
    goToDestination(viewer, { type: 'XYZ', pageIndex: 1, topMm: 0 } as const, {});
    expect(viewer.goToPage.mock.calls[0]![1]).toMatchObject({ smooth: true });
  });
});

describe('Goto handler', () => {
  it('按 Dest 跳转', async () => {
    const viewer = createNavigationViewer();
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks: () => [],
      smoothGoto: () => true,
    });
    const result = await handler(CONTEXT, gotoAction({ dest: { type: 'XYZ', pageIndex: 2 } }));
    expect(result.outcome).toBe('executed');
    expect(viewer.goToPage).toHaveBeenCalledTimes(1);
    expect(viewer.goToPage.mock.calls[0]![0]).toBe(3);
  });

  it('Dest 缺省时按书签名解析', async () => {
    const viewer = createNavigationViewer();
    const bookmarks: BookmarkItem[] = [
      { name: '第二章', dest: { type: 'XYZ', pageIndex: 1, topMm: 0 } },
    ];
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks: () => bookmarks,
      smoothGoto: () => true,
    });
    const result = await handler(CONTEXT, gotoAction({ bookmarkName: '第二章' }));
    expect(result.outcome).toBe('executed');
    expect(viewer.goToPage.mock.calls[0]![0]).toBe(2);
  });

  it('书签名不存在时返回 target-missing', async () => {
    const viewer = createNavigationViewer();
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks: () => [],
      smoothGoto: () => true,
    });
    const result = await handler(CONTEXT, gotoAction({ bookmarkName: '不存在' }));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('target-missing');
    expect(viewer.goToPage).not.toHaveBeenCalled();
  });

  it('目标页越界时返回 target-missing', async () => {
    const viewer = createNavigationViewer();
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks: () => [],
      smoothGoto: () => true,
    });
    const result = await handler(CONTEXT, gotoAction({ dest: { type: 'XYZ', pageIndex: 99 } }));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('target-missing');
  });

  it('smoothGoto 为 false 时下发 smooth:false', async () => {
    const viewer = createNavigationViewer();
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks: () => [],
      smoothGoto: () => false,
    });
    await handler(CONTEXT, gotoAction({ dest: { type: 'XYZ', pageIndex: 1 } }));
    expect(viewer.goToPage.mock.calls[0]![1]).toMatchObject({ smooth: false });
  });
});

describe('GotoA handler', () => {
  /** 构造 GotoA 动作。 */
  const gotoAttachmentAction = (attachId: string): ActionInfo =>
    ({
      event: 'CLICK',
      type: 'gotoa',
      owner: { kind: 'page', pageIndex: 0 },
      payload: { type: 'gotoa', attachId, newWindow: true },
    }) as ActionInfo;

  const attachment: AttachmentInfo = {
    id: 'att-1',
    name: '报表.xlsx',
    contentType: 'application/vnd.ms-excel',
  };

  it('读取附件并触发下载', async () => {
    const download = vi.fn();
    const saveAttachment = vi.fn(async (_id: string, sink: (chunk: Uint8Array) => void) => {
      sink(new Uint8Array([1, 2, 3]));
      return 3;
    });
    const handler = createGotoAttachmentHandler({
      getAttachments: () => [attachment],
      getDocument: () => ({ saveAttachment }),
      download,
      buildFilename: () => '报表.xlsx',
    });
    const result = await handler(CONTEXT, gotoAttachmentAction('att-1'));
    expect(result.outcome).toBe('executed');
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(download.mock.calls[0]![1]).toBe('报表.xlsx');
  });

  it('忽略 NewWindow：不产生窗口语义，只下载', async () => {
    const download = vi.fn();
    const handler = createGotoAttachmentHandler({
      getAttachments: () => [attachment],
      getDocument: () => ({ saveAttachment: async () => 0 }),
      download,
      buildFilename: () => 'a.bin',
    });
    const result = await handler(CONTEXT, gotoAttachmentAction('att-1'));
    expect(result.outcome).toBe('executed');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('附件不存在时返回 target-missing', async () => {
    const download = vi.fn();
    const handler = createGotoAttachmentHandler({
      getAttachments: () => [],
      getDocument: () => ({ saveAttachment: async () => 0 }),
      download,
      buildFilename: () => 'a.bin',
    });
    const result = await handler(CONTEXT, gotoAttachmentAction('missing'));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('target-missing');
    expect(download).not.toHaveBeenCalled();
  });

  it('引擎不支持 saveAttachment 时返回 unsupported', async () => {
    const handler = createGotoAttachmentHandler({
      getAttachments: () => [attachment],
      getDocument: () => ({}),
      download: vi.fn(),
      buildFilename: () => 'a.bin',
    });
    const result = await handler(CONTEXT, gotoAttachmentAction('att-1'));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('unsupported');
  });
});