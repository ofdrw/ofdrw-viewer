/**
 * Goto / GotoA 的缓存与索引单测（UI 动作处理机制设计 §8.2 / §8.4）。
 *
 * 覆盖：
 * - 附件清单尚未读完时点击（Promise 未 resolve）不会误判附件不存在；
 * - 附件清单读取失败（resolve 为空）时按附件不存在处理；
 * - Goto 按书签名解析走名称索引，来源数组变化后重建，同名书签先到先得。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionInfo, AttachmentInfo, BookmarkItem } from '@ofdrw/ofdrw-viewer-engine';
import { createGotoAttachmentHandler } from '../../../src/actions/handlers/goto-attachment';
import { createGotoHandler } from '../../../src/actions/handlers/goto';
import { createInitialViewerState } from '../../../src/state';
import type { NavigationViewer } from '../../../src/views/shared';

const CONTEXT = { trigger: 'CLICK' as const, pageIndex: 0 };

/** 构造 GotoA 动作。 */
function gotoAttachmentAction(attachId: string): ActionInfo {
  return {
    event: 'CLICK',
    type: 'gotoa',
    owner: { kind: 'page', pageIndex: 0 },
    payload: { type: 'gotoa', attachId, newWindow: false },
  } as ActionInfo;
}

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
    getElements: () =>
      ({ root: document.createElement('div'), main: document.createElement('div') }) as never,
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

const attachment: AttachmentInfo = {
  id: 'att-1',
  name: '报表.xlsx',
  contentType: 'application/vnd.ms-excel',
};

describe('GotoA 附件清单按需等待', () => {
  it('附件清单尚未就绪时等待其完成再查找，不误判不存在', async () => {
    let resolveAttachments: (value: readonly AttachmentInfo[]) => void = () => undefined;
    const pending = new Promise<readonly AttachmentInfo[]>((resolve) => {
      resolveAttachments = resolve;
    });
    const download = vi.fn();
    const handler = createGotoAttachmentHandler({
      getAttachments: () => pending,
      getDocument: () => ({
        saveAttachment: async (_id: string, sink: (chunk: Uint8Array) => void) => {
          sink(new Uint8Array([7]));
          return 1;
        },
      }),
      download,
      buildFilename: () => '报表.xlsx',
    });

    const task = handler(CONTEXT, gotoAttachmentAction('att-1'));
    // 附件清单完成前不出结果，但也不会提前失败。
    await Promise.resolve();
    expect(download).not.toHaveBeenCalled();
    resolveAttachments([attachment]);
    const result = await task;
    expect(result.outcome).toBe('executed');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('附件清单读取失败（空清单）时按附件不存在处理', async () => {
    const download = vi.fn();
    const handler = createGotoAttachmentHandler({
      getAttachments: () => Promise.resolve([]),
      getDocument: () => ({ saveAttachment: async () => 0 }),
      download,
      buildFilename: () => 'a.bin',
    });
    const result = await handler(CONTEXT, gotoAttachmentAction('att-1'));
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe('target-missing');
    expect(download).not.toHaveBeenCalled();
  });

  it('同步数组形式的清单同样可用', async () => {
    const download = vi.fn();
    const handler = createGotoAttachmentHandler({
      getAttachments: () => [attachment],
      getDocument: () => ({ saveAttachment: async () => 0 }),
      download,
      buildFilename: () => 'a.bin',
    });
    const result = await handler(CONTEXT, gotoAttachmentAction('att-1'));
    expect(result.outcome).toBe('executed');
  });
});

describe('Goto 书签名索引', () => {
  it('按书签名解析走索引并跳转', async () => {
    const viewer = createNavigationViewer();
    const bookmarks: BookmarkItem[] = [
      { name: '第一章', dest: { type: 'XYZ', pageIndex: 0 } },
      { name: '第二章', dest: { type: 'XYZ', pageIndex: 1 } },
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

  it('同名书签先到先得（XML 顺序首次出现者生效）', async () => {
    const viewer = createNavigationViewer();
    const bookmarks: BookmarkItem[] = [
      { name: '重复', dest: { type: 'XYZ', pageIndex: 0 } },
      { name: '重复', dest: { type: 'XYZ', pageIndex: 2 } },
    ];
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks: () => bookmarks,
      smoothGoto: () => true,
    });
    await handler(CONTEXT, gotoAction({ bookmarkName: '重复' }));
    expect(viewer.goToPage.mock.calls[0]![0]).toBe(1);
  });

  it('来源数组引用变化后重建索引', async () => {
    const viewer = createNavigationViewer();
    let bookmarks: BookmarkItem[] = [{ name: '旧', dest: { type: 'XYZ', pageIndex: 0 } }];
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks: () => bookmarks,
      smoothGoto: () => true,
    });
    expect((await handler(CONTEXT, gotoAction({ bookmarkName: '旧' }))).outcome).toBe('executed');

    bookmarks = [{ name: '新', dest: { type: 'XYZ', pageIndex: 2 } }];
    const missing = await handler(CONTEXT, gotoAction({ bookmarkName: '旧' }));
    expect(missing.outcome).toBe('skipped');
    const found = await handler(CONTEXT, gotoAction({ bookmarkName: '新' }));
    expect(found.outcome).toBe('executed');
    expect(viewer.goToPage.mock.calls[1]![0]).toBe(3);
  });

  it('优先使用引擎文档自身的书签快照', async () => {
    const viewer = createNavigationViewer();
    const getBookmarks = vi.fn(() => [] as readonly BookmarkItem[]);
    const handler = createGotoHandler({
      navigationViewer: viewer,
      getBookmarks,
      // 引擎书签不受 bookmarks 功能开关影响，且不必等状态同步。
      getDocumentBookmarks: () => [{ name: '正文', dest: { type: 'XYZ', pageIndex: 2 } }],
      smoothGoto: () => true,
    });
    const result = await handler(CONTEXT, gotoAction({ bookmarkName: '正文' }));
    expect(result.outcome).toBe('executed');
    expect(viewer.goToPage.mock.calls[0]![0]).toBe(3);
    expect(getBookmarks).not.toHaveBeenCalled();
  });
});