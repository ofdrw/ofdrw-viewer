/**
 * 附件侧栏视图（设计方案 §6.2）。
 *
 * 覆盖：列表列与缺失占位、无名称条目跳过、无附件空态、功能关闭不渲染、
 * 单个下载走 saveAttachment→Blob、大附件改为下载整个 OFD、ZIP 导出跳过并汇总、
 * 失败上报 W_ATTACHMENT_RESOURCE 不抛给宿主、附件内容不进入 DOM。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import { ATTACHMENT_LARGE_THRESHOLD_BYTES } from '../../../src/attachment-utils';
import { resolveFeatureStates } from '../../../src/features';
import { createTranslator } from '../../../src/i18n';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import { AttachmentView } from '../../../src/views/attachments';
import type { AttachmentConfirm, AttachmentViewer } from '../../../src/views/attachments';
import { UI_WARNING_CODES } from '../../../src/diagnostics';

/** 当前挂载的视图；用例结束统一释放。 */
const views: AttachmentView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * 构造最小阅读器宿主。
 *
 * @param attachments 附件列表。
 * @param options 覆盖项。
 * @returns 宿主与调用记录。
 */
function createViewer(
  attachments: readonly AttachmentInfo[],
  options: {
    readonly enabled?: boolean;
    readonly content?: Uint8Array;
    readonly failIds?: readonly string[];
    readonly noSourceBytes?: boolean;
    readonly noSaveAttachment?: boolean;
  } = {},
): {
  viewer: AttachmentViewer;
  calls: { saved: string[]; ofd: number };
  saveCalls: ReturnType<typeof vi.fn>;
} {
  const calls = { saved: [] as string[], ofd: 0 };
  const saveCalls = vi.fn(async (id: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
    calls.saved.push(id);
    if (options.failIds?.includes(id)) throw new Error('读取失败');
    const content = options.content ?? new Uint8Array([1, 2, 3]);
    // 分两块回调，验证顺序拼接。
    await sink(content.slice(0, 1));
    await sink(content.slice(1));
    return content.length;
  });
  const state: ViewerState = {
    ...createInitialViewerState(),
    document: { ...createInitialViewerState().document, pageCount: 1, status: 'ready' },
    ui: {
      ...createInitialViewerState().ui,
      features: resolveFeatureStates(options.enabled === false ? { attachments: false } : {}),
    },
  };
  const viewer: AttachmentViewer = {
    getState: () => state,
    getElements: () => ({ root: document.body }),
    isFeatureEnabled: (feature) => state.ui.features[feature].enabled,
    on: () => () => undefined,
    getDocumentInfo: async () => ({ attachments }),
    getDocument: () =>
      options.noSaveAttachment ? {} : { saveAttachment: saveCalls },
  };
  if (!options.noSourceBytes) {
    viewer.readSourceBytes = async () => {
      calls.ofd += 1;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    };
  }
  return { viewer, calls, saveCalls };
}

/**
 * 挂载附件视图。
 *
 * @param viewer 宿主。
 * @param confirm 确认结果。
 * @returns 视图与容器。
 */
function mount(
  viewer: AttachmentViewer,
  confirm: boolean | AttachmentConfirm = false,
): { view: AttachmentView; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new AttachmentView({
    viewer,
    host,
    getTranslator: () => createTranslator('zh-CN'),
    confirm: typeof confirm === 'boolean' ? async () => confirm : confirm,
  });
  views.push(view);
  return { view, host };
}

/** 等待视图异步加载完成（含 `createStoreZip` 的动态 import fflate）。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

/**
 * 等待条件成立；动态 import 的首个用例会显著慢于后续用例。
 *
 * @param predicate 条件。
 * @param timeoutMs 超时时间，单位毫秒；默认 3000。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flush();
    if (predicate()) return;
  }
  throw new Error('等待超时');
}

/**
 * 解压 ZIP Blob 并读取条目名与内容。
 *
 * @param blob ZIP 内容。
 * @returns 条目名到字节的映射。
 */
async function readZip(blob: Blob): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return unzipSync(bytes);
}

/** 拦截 createObjectURL，用于断言下载。 */
function stubBlobUrl(): { urls: string[]; blobs: Blob[]; names: string[] } {
  const urls: string[] = [];
  const blobs: Blob[] = [];
  const names: string[] = [];
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    names.push(this.download);
  };
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      urls.push(`blob:mock/${urls.length}`);
      return `blob:mock/${urls.length - 1}`;
    },
    revokeObjectURL: () => undefined,
  });
  return { urls, blobs, names };
}

describe('附件列表', () => {
  it('展示名称/格式/大小/日期与下载按钮，缺失显示 -', async () => {
    const { viewer } = createViewer([
      { id: 'a1', name: '说明.pdf', format: 'PDF', size: 2048, modDate: '2024-03-03' },
      { id: 'a2', name: '图片.png' },
    ]);
    const { host } = mount(viewer);
    await flush();
    const items = host.querySelectorAll('.ofd-attachment');
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector('.ofd-attachment__name')?.textContent).toBe('说明.pdf');
    expect(items[0]!.querySelector('.ofd-attachment__meta')?.textContent).toBe(
      'PDF · 2 KB · 2024-03-03',
    );
    expect(items[1]!.querySelector('.ofd-attachment__meta')?.textContent).toBe(
      '- · - · -',
    );
    expect(items[0]!.querySelector('button')?.textContent).toBe('下载');
    // 附件内容不进入 DOM。
    expect(host.innerHTML).not.toContain('srcdoc');
    expect(host.innerHTML).not.toContain('<iframe');
  });

  it('跳过没有名称的条目', async () => {
    const { viewer } = createViewer([
      { id: 'a1', name: '' },
      { id: 'a2', name: 'ok.pdf' },
    ]);
    const { host } = mount(viewer);
    await flush();
    const items = host.querySelectorAll('.ofd-attachment');
    expect(items).toHaveLength(1);
    expect(items[0]!.getAttribute('data-attachment-id')).toBe('a2');
  });

  it('无附件时展示空态且禁用导出提示', async () => {
    const { viewer } = createViewer([]);
    const { host } = mount(viewer);
    await flush();
    expect(host.querySelectorAll('.ofd-attachment')).toHaveLength(0);
    expect(host.querySelector('.ofd-nav__empty')?.textContent).toBe('本文档没有附件');
  });

  it('功能关闭时不渲染列表与导出按钮', async () => {
    const { viewer } = createViewer([{ id: 'a1', name: 'a.pdf' }], { enabled: false });
    const { host } = mount(viewer);
    await flush();
    expect(host.querySelectorAll('.ofd-attachment')).toHaveLength(0);
    expect(host.querySelector<HTMLElement>('.ofd-attachments__toolbar')?.hidden).toBe(true);
  });
});

describe('单个下载', () => {
  it('经 saveAttachment 分块收集后生成 Blob 下载', async () => {
    const api = stubBlobUrl();
    const { viewer, calls } = createViewer([{ id: 'a1', name: '说明.pdf', size: 3 }], {
      content: new Uint8Array([1, 2, 3]),
    });
    const { host } = mount(viewer);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.click();
    await flush();
    expect(calls.saved).toEqual(['a1']);
    expect(api.urls).toHaveLength(1);
    expect(api.names[0]).toBe('说明.pdf');
    expect(new Uint8Array(await api.blobs[0]!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('大附件不读取内容，确认后下载整个 OFD', async () => {
    const api = stubBlobUrl();
    const { viewer, calls } = createViewer(
      [{ id: 'big', name: '大文件.zip', size: ATTACHMENT_LARGE_THRESHOLD_BYTES + 1 }],
    );
    let message = '';
    const { host } = mount(viewer, async (request) => {
      message = request.message;
      return true;
    });
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.click();
    await flush();
    // 未读取附件内容，改为读取整个 OFD。
    expect(calls.saved).toEqual([]);
    expect(calls.ofd).toBe(1);
    expect(api.names[0]).toBe('document.ofd');
    expect(message).toContain('大文件.zip');
    expect(message).toContain('500 MB');
    expect(message).toContain('下载整个 OFD');
  });

  it('大附件确认被取消时不读取任何内容', async () => {
    stubBlobUrl();
    const { viewer, calls } = createViewer([
      { id: 'big', name: '大文件.zip', size: ATTACHMENT_LARGE_THRESHOLD_BYTES + 1 },
    ]);
    const { host } = mount(viewer, false);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.click();
    await flush();
    expect(calls.saved).toEqual([]);
    expect(calls.ofd).toBe(0);
  });

  it('未声明大小的附件走普通下载', async () => {
    stubBlobUrl();
    const { viewer, calls } = createViewer([{ id: 'a1', name: 'unknown.bin' }]);
    const { host } = mount(viewer);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.click();
    await flush();
    expect(calls.saved).toEqual(['a1']);
    expect(calls.ofd).toBe(0);
  });

  it('读取失败上报 W_ATTACHMENT_RESOURCE 且不抛给宿主', async () => {
    stubBlobUrl();
    const events: string[] = [];
    const listener = (event: Event): void => {
      events.push((event as CustomEvent<{ code: string }>).detail.code);
    };
    document.body.addEventListener('ofdviewerwarning', listener);
    const { viewer } = createViewer([{ id: 'bad', name: 'bad.pdf' }], { failIds: ['bad'] });
    const { host } = mount(viewer);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.click();
    await flush();
    expect(events).toContain(UI_WARNING_CODES.W_ATTACHMENT_RESOURCE);
    expect(host.querySelector('.ofd-attachments__status')?.textContent).toContain('读取失败');
    document.body.removeEventListener('ofdviewerwarning', listener);
  });
});

describe('批量导出', () => {
  it('打包成功的条目，跳过超阈值与失败条目并汇总提示', async () => {
    const api = stubBlobUrl();
    const { viewer, calls } = createViewer(
      [
        { id: 'a1', name: 'ok.pdf', size: 10 },
        { id: 'big', name: 'big.bin', size: ATTACHMENT_LARGE_THRESHOLD_BYTES + 1 },
        { id: 'bad', name: 'bad.pdf', size: 10 },
        { id: 'a2', name: 'ok.pdf', size: 10 },
      ],
      { failIds: ['bad'] },
    );
    const { host } = mount(viewer);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachments__export')!.click();
    await waitFor(() => api.names.length > 0);
    expect(calls.saved).toEqual(['a1', 'bad', 'a2']);
    expect(api.names[0]).toMatch(/-attachments\.zip$/);
    // ZIP 由 export/zip.ts 的 createStoreZip（fflate store 模式）产出。
    expect(api.blobs[0]!.type).toBe('application/zip');
    const entries = await readZip(api.blobs[0]!);
    const names = Object.keys(entries).sort();
    // 两个 ok.pdf 重名，第二条由 uniqueEntryName 追加序号；超阈值与失败条目被跳过。
    expect(names).toEqual(['ok-2.pdf', 'ok.pdf']);
    expect([...entries['ok.pdf']!]).toEqual([1, 2, 3]);
    const status = host.querySelector('.ofd-attachments__status');
    expect(status?.textContent).toContain('已导出 2 个附件');
    expect(status?.textContent).toContain('跳过 2 个');
    expect(status?.getAttribute('data-level')).toBe('warning');
  });

  it('全部附件都超阈值时导出不产生 ZIP，并汇总跳过数量', async () => {
    const api = stubBlobUrl();
    const { viewer, calls } = createViewer([
      { id: 'big1', name: 'a.bin', size: ATTACHMENT_LARGE_THRESHOLD_BYTES + 1 },
      { id: 'big2', name: 'b.bin', size: ATTACHMENT_LARGE_THRESHOLD_BYTES + 1 },
    ]);
    const { host } = mount(viewer);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachments__export')!.click();
    await flush();
    expect(calls.saved).toEqual([]);
    expect(api.urls).toHaveLength(0);
    const status = host.querySelector('.ofd-attachments__status');
    expect(status?.textContent).toContain('已导出 0 个附件');
    expect(status?.textContent).toContain('跳过 2 个');
    expect(status?.getAttribute('data-level')).toBe('warning');
  });

  it('无附件时导出给出空态提示而不产生下载', async () => {
    const api = stubBlobUrl();
    const { viewer } = createViewer([]);
    const { host } = mount(viewer);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachments__export')!.click();
    await flush();
    expect(api.urls).toHaveLength(0);
  });

  it('引擎不支持流式读取时给出不支持提示', async () => {
    const { viewer } = createViewer([{ id: 'a1', name: 'a.pdf' }], { noSaveAttachment: true });
    const { host } = mount(viewer);
    await flush();
    host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.click();
    await flush();
    expect(host.querySelector('.ofd-attachments__status')?.textContent).toContain('不支持');
  });
});
