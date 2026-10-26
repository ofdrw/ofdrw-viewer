/**
 * 附件下载流程（设计方案 §6.2.3 / §6.2.4）。
 *
 * 覆盖：分块收集后生成 Blob 下载、文件名清洗、阈值 500 MB（524288000 byte）
 * 判定与边界、超阈值提示改下整个 OFD 且绝不读取附件内容、ZIP 导出条目/重名、
 * 跳过超阈值与失败条目并汇总提示。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import { resolveFeatureStates } from '../../../src/features';
import { createTranslator } from '../../../src/i18n';
import type { Translator } from '../../../src/i18n';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import { AttachmentView } from '../../../src/views/attachments';
import type { AttachmentConfirm, AttachmentViewer } from '../../../src/views/attachments';

/** 500 MB 阈值常量。 */
const THRESHOLD = 524288000;

/** 当前挂载的视图。 */
const views: AttachmentView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 一次下载记录。 */
interface DownloadRecord {
  /** 文件名。 */
  readonly name: string;
  /** Blob 内容。 */
  readonly blob: Blob;
}

/** 拦截 a[download] 与 objectURL，记录下载。 */
function stubDownloads(): DownloadRecord[] {
  const records: DownloadRecord[] = [];
  let pending: Blob | null = null;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      pending = blob;
      return 'blob:mock';
    },
    revokeObjectURL: () => undefined,
  });
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (pending) records.push({ name: this.download, blob: pending });
    pending = null;
  };
  return records;
}

/** 附件读取记录。 */
interface ReadLog {
  /** 被读取的附件 ID。 */
  readonly ids: string[];
}

/**
 * 构造宿主。
 *
 * @param attachments 附件列表。
 * @param options 覆盖项。
 * @returns 宿主、读取记录与 OFD 读取计数。
 */
function createViewer(
  attachments: readonly AttachmentInfo[],
  options: {
    readonly content?: Uint8Array;
    readonly failIds?: readonly string[];
    readonly noSourceBytes?: boolean;
    readonly origin?: ViewerState['document']['origin'];
  } = {},
): { viewer: AttachmentViewer; log: ReadLog; ofdReads: () => number } {
  const log: ReadLog = { ids: [] };
  let ofdReads = 0;
  const content = options.content ?? new Uint8Array([1, 2, 3, 4, 5]);
  const saveAttachment = vi.fn(
    async (id: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
      log.ids.push(id);
      if (options.failIds?.includes(id)) throw new Error('读取失败');
      // 分两块回调，验证按顺序拼接。
      await sink(content.slice(0, 2));
      await sink(content.slice(2));
      return content.length;
    },
  );
  const base = createInitialViewerState();
  const state: ViewerState = {
    ...base,
    document: {
      ...base.document,
      pageCount: 1,
      status: 'ready',
      ...(options.origin ? { origin: options.origin } : {}),
    },
    ui: { ...base.ui, features: resolveFeatureStates({}) },
  };
  const viewer: AttachmentViewer = {
    getState: () => state,
    getElements: () => ({ root: document.body }),
    isFeatureEnabled: (feature) => state.ui.features[feature].enabled,
    on: () => () => undefined,
    getDocumentInfo: async () => ({ attachments }),
    getDocument: () => ({ saveAttachment }),
  };
  if (!options.noSourceBytes) {
    viewer.readSourceBytes = async () => {
      ofdReads += 1;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    };
  }
  return { viewer, log, ofdReads: () => ofdReads };
}

/** 挂载视图。 */
function mount(
  viewer: AttachmentViewer,
  confirm: boolean | AttachmentConfirm = false,
  translator: Translator = createTranslator('zh-CN'),
): { view: AttachmentView; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new AttachmentView({
    viewer,
    host,
    getTranslator: () => translator,
    confirm: typeof confirm === 'boolean' ? async () => confirm : confirm,
  });
  views.push(view);
  return { view, host };
}

/** 等待异步流程（含 fflate 动态 import）。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

/** 使用 fflate 解压 ZIP Blob。 */
async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe('单个附件下载', () => {
  it('分块收集后生成 Blob 并以清洗后的文件名触发下载', async () => {
    const records = stubDownloads();
    const { viewer, log } = createViewer([{ id: 'a1', name: '说明.pdf', format: 'PDF' }], {
      content: new Uint8Array([9, 8, 7]),
    });
    const { view, host } = mount(viewer);
    await flush();

    await view.download({ id: 'a1', name: '说明.pdf', format: 'PDF' });

    expect(log.ids).toEqual(['a1']);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('说明.pdf');
    expect([...new Uint8Array(await (records[0]!.blob as Blob).arrayBuffer())]).toEqual([9, 8, 7]);
    expect(host.querySelector<HTMLElement>('.ofd-attachments__status')?.hidden).toBe(true);
  });

  it('文件名去除路径分隔符与 .. 段，避免路径穿越', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer([{ id: 'a1', name: '../../etc/passwd.txt' }]);
    const { view } = mount(viewer);
    await flush();

    await view.download({ id: 'a1', name: '../../etc/passwd.txt' });

    expect(records[0]?.name).not.toContain('..');
    expect(records[0]?.name).not.toContain('/');
    expect(records[0]?.name).toBe('etc_passwd.txt');
  });

  it('名称为空时回退用 ID 命名', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer([{ id: 'att-9', name: '' }]);
    const { view } = mount(viewer);
    await flush();

    await view.download({ id: 'att-9', name: '' });

    expect(records[0]?.name).toBe('att-9');
  });
});

describe('大附件阈值边界', () => {
  it('声明大小恰好等于 524288000 byte 时仍按普通下载（不确认、不读 OFD）', async () => {
    const records = stubDownloads();
    const confirm = vi.fn(async () => true);
    const { viewer, log, ofdReads } = createViewer([
      { id: 'edge', name: '边界.pdf', size: THRESHOLD },
    ]);
    const { view } = mount(viewer, confirm);
    await flush();

    await view.download({ id: 'edge', name: '边界.pdf', size: THRESHOLD });

    expect(confirm).not.toHaveBeenCalled();
    expect(log.ids).toEqual(['edge']);
    expect(ofdReads()).toBe(0);
    expect(records).toHaveLength(1);
  });

  it('声明大小超过阈值 1 byte 时弹出确认，且不读取附件内容', async () => {
    const records = stubDownloads();
    const confirm = vi.fn(async () => true);
    const { viewer, log, ofdReads } = createViewer([
      { id: 'big', name: '超大.pdf', size: THRESHOLD + 1 },
    ]);
    const { view } = mount(viewer, confirm);
    await flush();

    await view.download({ id: 'big', name: '超大.pdf', size: THRESHOLD + 1 });

    // 关键契约：确认框出现，附件内容一次都没有被读取。
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(log.ids).toEqual([]);
    // 确认后下载的是整个 OFD 原文件，而不是附件。
    expect(ofdReads()).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]!.blob.type).toBe('application/ofd');
  });

  it('确认框文案提示“不读取该附件内容”并给出阈值大小', async () => {
    stubDownloads();
    const requests: Array<{ title: string; message: string; confirmLabel: string }> = [];
    const { viewer } = createViewer([{ id: 'big', name: '超大.pdf', size: 600_000_000 }]);
    const { view } = mount(viewer, async (request) => {
      requests.push(request);
      return false;
    });
    await flush();

    await view.download({ id: 'big', name: '超大.pdf', size: 600_000_000 });

    expect(requests).toHaveLength(1);
    const message = requests[0]!.message;
    expect(message).toContain('超大.pdf');
    // 明确说明不会读取附件内容，改为下载整个 OFD。
    expect(message).toContain('不会读取');
    expect(message).toContain('OFD');
    expect(requests[0]!.confirmLabel).toBe(createTranslator('zh-CN').t('attachments.downloadOfd'));
  });

  it('用户取消时既不读附件内容，也不读 OFD 原文件', async () => {
    const records = stubDownloads();
    const { viewer, log, ofdReads } = createViewer([
      { id: 'big', name: '超大.pdf', size: 900_000_000 },
    ]);
    const { view } = mount(viewer, false);
    await flush();

    await view.download({ id: 'big', name: '超大.pdf', size: 900_000_000 });

    expect(log.ids).toEqual([]);
    expect(ofdReads()).toBe(0);
    expect(records).toHaveLength(0);
  });

  it('未声明大小的附件一律走普通下载，不触发大附件确认', async () => {
    const records = stubDownloads();
    const confirm = vi.fn(async () => true);
    const { viewer, log, ofdReads } = createViewer([{ id: 'unknown', name: '未知.pdf' }]);
    const { view } = mount(viewer, confirm);
    await flush();

    await view.download({ id: 'unknown', name: '未知.pdf' });

    expect(confirm).not.toHaveBeenCalled();
    expect(log.ids).toEqual(['unknown']);
    expect(ofdReads()).toBe(0);
    expect(records).toHaveLength(1);
  });

  it('超阈值但环境不支持读取原文件时给出提示，不产生下载', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer(
      [{ id: 'big', name: '超大.pdf', size: THRESHOLD + 1 }],
      { noSourceBytes: true },
    );
    const { view, host } = mount(viewer, true);
    await flush();

    await view.download({ id: 'big', name: '超大.pdf', size: THRESHOLD + 1 });

    expect(records).toHaveLength(0);
    expect(host.querySelector('.ofd-attachments__status')?.textContent).toBe(
      createTranslator('zh-CN').t('attachments.ofdUnavailable'),
    );
  });
});

describe('ZIP 批量导出', () => {
  it('导出全部附件为 application/zip，条目名可解压校验', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer([
      { id: 'a1', name: '甲.pdf', format: 'PDF' },
      { id: 'a2', name: '乙.txt', format: 'txt' },
    ]);
    const { view } = mount(viewer);
    await flush();

    await view.exportAll();
    await flush();

    expect(records).toHaveLength(1);
    const blob = records[0]!.blob;
    expect(blob.type).toBe('application/zip');
    expect(records[0]!.name.endsWith('-attachments.zip')).toBe(true);
    const entries = await unzip(blob);
    expect(Object.keys(entries).sort()).toEqual(['乙.txt', '甲.pdf']);
    expect([...entries['甲.pdf']!]).toEqual([1, 2, 3, 4, 5]);
  });

  it('重名附件在 ZIP 内追加序号后缀', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer([
      { id: 'a1', name: '重复.pdf' },
      { id: 'a2', name: '重复.pdf' },
      { id: 'a3', name: '重复.pdf' },
    ]);
    const { view } = mount(viewer);
    await flush();

    await view.exportAll();
    await flush();

    const entries = await unzip(records[0]!.blob);
    expect(Object.keys(entries).sort()).toEqual(['重复-2.pdf', '重复-3.pdf', '重复.pdf']);
    // 三个条目内容都写入，未因重名互相覆盖。
    expect(Object.values(entries)).toHaveLength(3);
  });

  it('跳过超阈值附件，不读取其内容，并汇总“已导出 N，跳过 M”', async () => {
    const records = stubDownloads();
    const { viewer, log } = createViewer([
      { id: 'ok1', name: '正常.pdf' },
      { id: 'huge', name: '超大.zip', size: THRESHOLD + 1 },
      { id: 'ok2', name: '另一个.txt' },
    ]);
    const { view, host } = mount(viewer);
    await flush();

    await view.exportAll();
    await flush();

    // 超阈值条目完全没被读取。
    expect(log.ids).toEqual(['ok1', 'ok2']);
    const entries = await unzip(records[0]!.blob);
    expect(Object.keys(entries).sort()).toEqual(['另一个.txt', '正常.pdf']);

    const status = host.querySelector<HTMLElement>('.ofd-attachments__status');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBe('已导出 2 个附件，跳过 1 个（过大或读取失败）');
    expect(status?.dataset.level).toBe('warning');
  });

  it('读取失败的条目被跳过并计入汇总，其余条目照常导出', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer(
      [
        { id: 'ok', name: '正常.pdf' },
        { id: 'bad', name: '损坏.pdf' },
      ],
      { failIds: ['bad'] },
    );
    const { view, host } = mount(viewer);
    await flush();

    await view.exportAll();
    await flush();

    const entries = await unzip(records[0]!.blob);
    expect(Object.keys(entries)).toEqual(['正常.pdf']);
    expect(host.querySelector('.ofd-attachments__status')?.textContent).toBe(
      '已导出 1 个附件，跳过 1 个（过大或读取失败）',
    );
  });

  it('超阈值与读取失败同时存在时一起计入跳过数，且不产生 ZIP 时不下载', async () => {
    const records = stubDownloads();
    const { viewer, log } = createViewer(
      [
        { id: 'huge', name: '超大.pdf', size: THRESHOLD + 1 },
        { id: 'bad', name: '损坏.pdf' },
      ],
      { failIds: ['bad'] },
    );
    const { view, host } = mount(viewer);
    await flush();

    await view.exportAll();
    await flush();

    expect(log.ids).toEqual(['bad']);
    expect(records).toHaveLength(0);
    expect(host.querySelector('.ofd-attachments__status')?.textContent).toBe(
      '已导出 0 个附件，跳过 2 个（过大或读取失败）',
    );
  });

  it('全部条目正常时不出现跳过提示', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer([{ id: 'a1', name: '唯一.pdf' }]);
    const { view, host } = mount(viewer);
    await flush();

    await view.exportAll();
    await flush();

    expect(records).toHaveLength(1);
    const status = host.querySelector<HTMLElement>('.ofd-attachments__status');
    expect(status?.textContent).toBe('已导出 1 个附件，跳过 0 个（过大或读取失败）');
    expect(status?.dataset.level).toBe('info');
  });
});

describe('安全约束', () => {
  it('附件内容不进入 DOM，列表中只出现文本节点', async () => {
    stubDownloads();
    const { viewer } = createViewer([{ id: 'xss', name: '<img src=x onerror=alert(1)>.html' }]);
    const { host } = mount(viewer);
    await flush();

    // 名称按文本渲染，不解析为元素。
    expect(host.querySelectorAll('img').length).toBe(0);
    expect(host.querySelector('.ofd-attachment__name')?.textContent).toBe(
      '<img src=x onerror=alert(1)>.html',
    );
  });

  it('下载失败时面板提示并上报诊断，不向宿主抛错', async () => {
    stubDownloads();
    const { viewer } = createViewer([{ id: 'bad', name: '坏.pdf' }], { failIds: ['bad'] });
    const { view, host } = mount(viewer);
    await flush();

    await expect(view.download({ id: 'bad', name: '坏.pdf' })).resolves.toBeUndefined();

    const status = host.querySelector<HTMLElement>('.ofd-attachments__status');
    expect(status?.hidden).toBe(false);
    expect(status?.dataset.level).toBe('warning');
    expect(status?.textContent).toContain('坏.pdf');
  });
});
