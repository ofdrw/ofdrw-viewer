/**
 * `getDocumentInfo()` 聚合接口（设计方案 §6.1）。
 *
 * 覆盖：聚合字段、未打开抛 `OFD_NOT_OPENED`、并发读取命中缓存、快照不进入
 * `ViewerState.document`、引擎缺少附件能力时返回空数组。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { isOFDViewerError } from '../../../src/errors';
import { OFDViewer } from '../../../src/viewer';
import { createMockDocument } from '../../helpers/document';

/**
 * 创建阅读器；`source` 固定，打开失败由 mock 决定。
 *
 * @returns 阅读器实例。
 */
function createViewer(): OFDViewer {
  return new OFDViewer({
    crypto: { enabled: false },
    container: document.body,
    source: new ArrayBuffer(8),
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('getDocumentInfo()', () => {
  it('聚合元数据、页信息、权限、附件与各类计数', async () => {
    const engineDocument = createMockDocument({
      pageCount: 2,
      metadata: {
        version: '1.0',
        pageCount: 2,
        title: '合同',
        docType: 'OFD',
        docUsage: 'Normal',
      },
      attachments: [
        { id: 'att-1', name: '说明.pdf', format: 'PDF', size: 2048 },
        { id: 'att-2', name: '附件.png', format: 'PNG' },
      ],
      signatures: [],
      outline: [
        { title: '第一章', children: [] },
        { title: '第二章', children: [] },
      ],
      bookmarks: [{ name: '标记', dest: { type: 'XYZ', pageIndex: 0 } }],
    });
    engineMocks.open.mockResolvedValue(engineDocument);
    const viewer = createViewer();
    await viewer.ready;

    const info = await viewer.getDocumentInfo();
    expect(info.metadata.title).toBe('合同');
    expect(info.metadata.docType).toBe('OFD');
    expect(info.metadata.docUsage).toBe('Normal');
    expect(info.pageCount).toBe(2);
    expect(info.pageInfos).toHaveLength(2);
    expect(info.pageInfos[0]).toMatchObject({ index: 0, widthMm: 210, heightMm: 297 });
    expect(info.permissions.export).toBe(true);
    expect(info.attachments).toHaveLength(2);
    expect(info.attachments[0]!.name).toBe('说明.pdf');
    expect(info.attachments[0]!.size).toBe(2048);
    expect(info.signatureCount).toBe(0);
    expect(info.outlineCount).toBe(2);
    expect(info.bookmarkCount).toBe(1);
    viewer.destroy();
  });

  it('未打开时抛 OFD_NOT_OPENED，而 getPermissions() 仍返回宽松默认值', async () => {
    // 打开失败后 controller 不含文档，等价于“从未成功打开”。
    engineMocks.open.mockRejectedValue(new Error('打开失败'));
    const viewer = createViewer();
    await viewer.ready.catch(() => undefined);
    await expect(viewer.getDocumentInfo()).rejects.toSatisfy(
      (error: unknown) => isOFDViewerError(error) && error.code === 'OFD_NOT_OPENED',
    );
    const permissions = await viewer.getPermissions();
    expect(permissions).toEqual({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    });
    viewer.destroy();
  });

  it('多次调用命中引擎缓存，不重复读取包内容', async () => {
    const engineDocument = createMockDocument({ pageCount: 1 });
    const spyMetadata = vi.spyOn(engineDocument, 'getMetadata');
    const spyAttachments = vi.spyOn(engineDocument, 'getAttachments');
    engineMocks.open.mockResolvedValue(engineDocument);
    const viewer = createViewer();
    await viewer.ready;

    await viewer.getDocumentInfo();
    await viewer.getDocumentInfo();
    expect(spyMetadata).toHaveBeenCalledTimes(1);
    expect(spyAttachments).toHaveBeenCalledTimes(1);
    viewer.destroy();
  });

  it('快照不写入 ViewerState.document', async () => {
    engineMocks.open.mockResolvedValue(
      createMockDocument({
        pageCount: 1,
        metadata: { version: '2.0', pageCount: 1, docType: 'OFD', docUsage: 'Normal' },
        attachments: [{ id: 'att-1', name: 'a.pdf' }],
      }),
    );
    const viewer = createViewer();
    await viewer.ready;
    await viewer.getDocumentInfo();
    const { document: documentState } = viewer.getState();
    expect(Object.keys(documentState)).not.toContain('permissions');
    expect(Object.keys(documentState)).not.toContain('attachments');
    viewer.destroy();
  });

  it('引擎未实现 getAttachments 时附件为空数组而不是报错', async () => {
    engineMocks.open.mockResolvedValue(
      createMockDocument({ pageCount: 1, omit: { attachments: true } }),
    );
    const viewer = createViewer();
    await viewer.ready;
    const info = await viewer.getDocumentInfo();
    expect(info.attachments).toEqual([]);
    viewer.destroy();
  });
});
