/**
 * 附件侧栏：多选、权限与预览（设计方案 §6.2）。
 *
 * 覆盖：类型图标分类（含音视频/代码）、可预览类型判定、预览上限 20 MB、
 * 勾选与全选、多选打包 ZIP / 单选直接下载、`Permissions/Export` 禁止导出、
 * 图片/视频/音频/文本弹框预览与关闭释放、超限与不可预览回退下载。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentInfo, DocumentPermissions } from '@ofdrw/ofdrw-viewer-engine';
import {
  ATTACHMENT_PREVIEW_THRESHOLD_BYTES,
  attachmentIconKind,
  attachmentMimeType,
  attachmentPreviewKind,
  isPreviewTooLargeAttachment,
} from '../../../src/attachment-utils';
import { resolveFeatureStates } from '../../../src/features';
import { createTranslator } from '../../../src/i18n';
import type { Translator } from '../../../src/i18n';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import { AttachmentView } from '../../../src/views/attachments';
import type { AttachmentViewer } from '../../../src/views/attachments';

/** 当前挂载的视图；用例结束统一释放。 */
const views: AttachmentView[] = [];

/** 允许导出的权限声明。 */
const ALLOW_EXPORT: DocumentPermissions = {
  edit: true,
  annot: true,
  export: true,
  signature: true,
  watermark: true,
  printScreen: true,
};

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 构造附件元信息。 */
function makeAttachment(patch: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return { id: 'a1', name: '说明.pdf', ...patch };
}

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

/** 构造宿主。 */
function createViewer(
  attachments: readonly AttachmentInfo[],
  options: {
    readonly content?: Uint8Array;
    readonly permissions?: DocumentPermissions;
    readonly dialogLayer?: HTMLElement;
  } = {},
): { viewer: AttachmentViewer; log: { ids: string[] } } {
  const log = { ids: [] as string[] };
  const content = options.content ?? new Uint8Array([104, 105]);
  const saveAttachment = vi.fn(
    async (id: string, sink: (chunk: Uint8Array) => void | Promise<void>) => {
      log.ids.push(id);
      await sink(content.slice());
      return content.length;
    },
  );
  const base = createInitialViewerState();
  const state: ViewerState = {
    ...base,
    document: { ...base.document, pageCount: 1, status: 'ready' },
    ui: { ...base.ui, features: resolveFeatureStates({}) },
  };
  const viewer: AttachmentViewer = {
    getState: () => state,
    getElements: () => ({
      root: document.body,
      ...(options.dialogLayer ? { dialogLayer: options.dialogLayer } : {}),
    }),
    isFeatureEnabled: (feature) => state.ui.features[feature].enabled,
    on: () => () => undefined,
    getDocumentInfo: async () => ({ attachments }),
    getPermissions: async () => options.permissions ?? ALLOW_EXPORT,
    getDocument: () => ({ saveAttachment }),
  };
  return { viewer, log };
}

/** 挂载视图。 */
function mount(
  viewer: AttachmentViewer,
  translator: Translator = createTranslator('zh-CN'),
): { view: AttachmentView; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new AttachmentView({
    viewer,
    host,
    getTranslator: () => translator,
  });
  views.push(view);
  return { view, host };
}

/** 等待异步流程。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('附件类型图标分类', () => {
  it('音视频与代码各自独立分类', () => {
    expect(attachmentIconKind(makeAttachment({ name: 'a.mp4' }))).toBe('video');
    expect(attachmentIconKind(makeAttachment({ name: 'a.webm' }))).toBe('video');
    expect(attachmentIconKind(makeAttachment({ name: 'a.mp3' }))).toBe('audio');
    expect(attachmentIconKind(makeAttachment({ name: 'a.wav' }))).toBe('audio');
    expect(attachmentIconKind(makeAttachment({ name: 'a.json' }))).toBe('code');
    expect(attachmentIconKind(makeAttachment({ name: 'a.ts' }))).toBe('code');
  });

  it('沿用既有分类，未知扩展名归入 other', () => {
    expect(attachmentIconKind(makeAttachment({ name: 'a.pdf' }))).toBe('pdf');
    expect(attachmentIconKind(makeAttachment({ name: 'a.txt' }))).toBe('text');
    expect(attachmentIconKind(makeAttachment({ name: 'a.png' }))).toBe('image');
    expect(attachmentIconKind(makeAttachment({ name: 'a.zip' }))).toBe('archive');
    expect(attachmentIconKind(makeAttachment({ name: 'a.bin' }))).toBe('other');
    // 名称无扩展名时回退 XML 声明的格式。
    expect(attachmentIconKind(makeAttachment({ name: 'naked', format: 'wav' }))).toBe('audio');
  });

  it('演示文稿独立成类，不再与表格共用图标', () => {
    expect(attachmentIconKind(makeAttachment({ name: 'a.ppt' }))).toBe('slide');
    expect(attachmentIconKind(makeAttachment({ name: 'a.pptx' }))).toBe('slide');
    expect(attachmentIconKind(makeAttachment({ name: 'a.ppsx' }))).toBe('slide');
    expect(attachmentIconKind(makeAttachment({ name: 'a.odp' }))).toBe('slide');
    expect(attachmentIconKind(makeAttachment({ name: 'a.xlsx' }))).toBe('sheet');
  });

  it('XML 独立成类，与纯文本区分', () => {
    expect(attachmentIconKind(makeAttachment({ name: 'a.xml' }))).toBe('xml');
    expect(attachmentIconKind(makeAttachment({ name: 'a.xsl' }))).toBe('xml');
    expect(attachmentIconKind(makeAttachment({ name: 'a.txt' }))).toBe('text');
    expect(attachmentIconKind(makeAttachment({ name: 'a.json' }))).toBe('code');
  });
});

describe('可预览类型判定', () => {
  it('图片/视频/音频/纯文本可预览', () => {
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.png' }))).toBe('image');
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.mp4' }))).toBe('video');
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.mp3' }))).toBe('audio');
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.txt' }))).toBe('text');
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.csv' }))).toBe('text');
  });

  it('PDF/Office/压缩包/代码不提供预览', () => {
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.pdf' }))).toBeUndefined();
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.docx' }))).toBeUndefined();
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.zip' }))).toBeUndefined();
    expect(attachmentPreviewKind(makeAttachment({ name: 'a.js' }))).toBeUndefined();
  });

  it('预览上限为 20 MB，正好等于阈值不算超限', () => {
    expect(ATTACHMENT_PREVIEW_THRESHOLD_BYTES).toBe(20 * 1024 * 1024);
    expect(
      isPreviewTooLargeAttachment(makeAttachment({ size: ATTACHMENT_PREVIEW_THRESHOLD_BYTES })),
    ).toBe(false);
    expect(
      isPreviewTooLargeAttachment(
        makeAttachment({ size: ATTACHMENT_PREVIEW_THRESHOLD_BYTES + 1 }),
      ),
    ).toBe(true);
    expect(isPreviewTooLargeAttachment(makeAttachment())).toBe(false);
  });

  it('MIME 优先取声明值，其次按扩展名推断', () => {
    expect(attachmentMimeType(makeAttachment({ name: 'a.png', contentType: 'image/webp' }))).toBe(
      'image/webp',
    );
    expect(attachmentMimeType(makeAttachment({ name: 'a.mp4' }))).toBe('video/mp4');
    expect(attachmentMimeType(makeAttachment({ name: 'a.bin' }))).toBe('application/octet-stream');
  });
});

describe('勾选与全选', () => {
  const items: readonly AttachmentInfo[] = [
    { id: 'a1', name: '甲.pdf' },
    { id: 'a2', name: '乙.txt' },
    { id: 'a3', name: '丙.mp3' },
  ];

  it('卡片带勾选框，勾选后写入 data-selected 与选中列表', async () => {
    const { viewer } = createViewer(items);
    const { view, host } = mount(viewer);
    await flush();

    const checkboxes = host.querySelectorAll<HTMLInputElement>('.ofd-attachment__check');
    expect(checkboxes).toHaveLength(3);
    expect(view.getSelectedIds()).toEqual([]);

    checkboxes[1]!.checked = true;
    checkboxes[1]!.dispatchEvent(new Event('change'));
    await flush();

    expect(view.getSelectedIds()).toEqual(['a2']);
    const cards = host.querySelectorAll<HTMLElement>('.ofd-attachment');
    expect(cards[1]!.dataset.selected).toBe('true');
    expect(cards[0]!.dataset.selected).toBeUndefined();
  });

  it('全选按钮先全选再取消，并同步按钮文案', async () => {
    const { viewer } = createViewer(items);
    const { view, host } = mount(viewer);
    await flush();

    const selectAll = host.querySelector<HTMLButtonElement>('.ofd-attachments__select-all')!;
    expect(selectAll.textContent).toBe('全选');

    selectAll.click();
    await flush();
    expect(view.getSelectedIds()).toEqual(['a1', 'a2', 'a3']);
    expect(selectAll.textContent).toBe('取消全选');
    expect(selectAll.getAttribute('aria-pressed')).toBe('true');

    selectAll.click();
    await flush();
    expect(view.getSelectedIds()).toEqual([]);
    expect(selectAll.textContent).toBe('全选');
  });

  it('有勾选时导出按钮切换为“下载选中”文案', async () => {
    const { viewer } = createViewer(items);
    const { view, host } = mount(viewer);
    await flush();

    const exportButton = host.querySelector<HTMLButtonElement>('.ofd-attachments__export')!;
    expect(exportButton.getAttribute('aria-label')).toBe('导出全部');

    view.toggleSelection('a1');
    await flush();
    expect(exportButton.getAttribute('aria-label')).toBe('下载选中的 1 个附件');
  });
});

describe('卡片结构（窄侧栏布局前提）', () => {
  it('图标与正文包在主体区内，操作按钮独立成区', async () => {
    const { viewer } = createViewer([
      { id: 'a1', name: '甲.mp4', format: 'mp4' },
      { id: 'a2', name: '乙.pdf', format: 'pdf' },
    ]);
    const { host } = mount(viewer);
    await flush();

    const cards = host.querySelectorAll<HTMLElement>('.ofd-attachment');
    for (const card of cards) {
      const main = card.querySelector('.ofd-attachment__main');
      expect(main).not.toBeNull();
      // 图标与正文都在主体区内，保证正文能独立收缩。
      expect(main?.querySelector('.ofd-attachment__icon')).not.toBeNull();
      expect(main?.querySelector('.ofd-attachment__body')).not.toBeNull();
      // 操作区是主体区的兄弟节点，不参与正文收缩。
      expect(main?.querySelector('.ofd-attachment__actions')).toBeNull();
      expect(card.querySelector('.ofd-attachment__actions')).not.toBeNull();
      // 勾选框在最外层，不进主体区。
      expect(card.querySelector(':scope > .ofd-attachment__check')).not.toBeNull();
      expect(main?.querySelector('.ofd-attachment__check')).toBeNull();
    }
  });

  it('元信息为单行文本：类型、大小与日期共用一个节点', async () => {
    const { viewer } = createViewer([
      { id: 'a1', name: '甲.mp4', format: 'mp4', size: 2048, modDate: '2026-01-01' },
    ]);
    const { host } = mount(viewer);
    await flush();

    const meta = host.querySelector('.ofd-attachment__meta')!;
    expect(meta.querySelector('.ofd-attachment__meta-size')?.textContent).toBe('mp4 · 2 KB');
    expect(meta.querySelector('.ofd-attachment__meta-date')?.textContent).toBe('2026-01-01');
    // 完整信息仍由 title 提供，窄侧栏下靠省略号收尾。
    expect(meta.getAttribute('title')).toBe('mp4 · 2 KB · 2026-01-01');
  });
});

describe('权限控制', () => {
  it('Export 为 false 时禁用下载与导出按钮，并提示禁止导出', async () => {
    const records = stubDownloads();
    const { viewer } = createViewer([{ id: 'a1', name: '甲.pdf' }], {
      permissions: { ...ALLOW_EXPORT, export: false },
    });
    const { view, host } = mount(viewer);
    await flush();

    const download = host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!;
    const exportButton = host.querySelector<HTMLButtonElement>('.ofd-attachments__export')!;
    const selectAll = host.querySelector<HTMLButtonElement>('.ofd-attachments__select-all')!;
    expect(download.disabled).toBe(true);
    expect(exportButton.disabled).toBe(true);
    expect(selectAll.disabled).toBe(true);

    // 直接调用下载入口也不产生任何下载。
    await view.download({ id: 'a1', name: '甲.pdf' });
    await flush();
    expect(records).toHaveLength(0);
    expect(host.querySelector('.ofd-attachments__status')?.textContent).toBe(
      '文档权限禁止导出附件',
    );
  });

  it('Export 为 true 时按钮可用；未提供权限能力时按允许处理', async () => {
    const { viewer } = createViewer([{ id: 'a1', name: '甲.pdf' }]);
    const { host } = mount(viewer);
    await flush();
    expect(host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.disabled).toBe(
      false,
    );

    const bare = createViewer([{ id: 'a1', name: '甲.pdf' }]).viewer;
    delete (bare as { getPermissions?: unknown }).getPermissions;
    const second = mount(bare);
    await flush();
    expect(
      second.host.querySelector<HTMLButtonElement>('.ofd-attachment__download')!.disabled,
    ).toBe(false);
  });

  it('权限禁止导出时仍可预览图片内容', async () => {
    const { viewer } = createViewer([{ id: 'a1', name: '图.png' }], {
      permissions: { ...ALLOW_EXPORT, export: false },
    });
    const { host } = mount(viewer);
    await flush();

    const dialog = document.createElement('div');
    document.body.appendChild(dialog);
    const previewButton = host.querySelector<HTMLButtonElement>('.ofd-attachment__preview')!;
    expect(previewButton.disabled).toBe(false);
  });
});

describe('预览弹框', () => {
  it('图片预览生成 img 并挂到对话框层，关闭后移除并回收对象 URL', async () => {
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:preview',
      revokeObjectURL: (url: string) => revoked.push(url),
    });

    const { viewer } = createViewer([{ id: 'a1', name: '图.png' }], { dialogLayer });
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'a1', name: '图.png' });
    await flush();

    const dialog = dialogLayer.querySelector<HTMLElement>('.ofd-attachment-preview')!;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelector('.ofd-attachment-preview__title')?.textContent).toBe('图.png');
    const image = dialog.querySelector<HTMLImageElement>('img.ofd-attachment-preview__image')!;
    expect(image.src).toBe('blob:preview');
    expect(image.alt).toBe('图.png');

    view.closePreview();
    expect(dialogLayer.querySelector('.ofd-attachment-preview')).toBeNull();
    expect(revoked).toEqual(['blob:preview']);
  });

  it('视频用 video[controls]，音频用 audio[controls]', async () => {
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:media',
      revokeObjectURL: () => undefined,
    });

    const { viewer } = createViewer([{ id: 'v', name: '片.mp4' }, { id: 'a', name: '音.mp3' }], {
      dialogLayer,
    });
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'v', name: '片.mp4' });
    const video = dialogLayer.querySelector<HTMLVideoElement>('video')!;
    expect(video.controls).toBe(true);
    expect(video.getAttribute('aria-label')).toBe('视频');
    view.closePreview();

    await view.previewAttachment({ id: 'a', name: '音.mp3' });
    const audio = dialogLayer.querySelector<HTMLAudioElement>('audio')!;
    expect(audio.controls).toBe(true);
    expect(audio.getAttribute('aria-label')).toBe('音频');
    view.closePreview();
  });

  it('文本预览走 textContent，HTML 不被解析执行', async () => {
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);
    const payload = '<img src=x onerror="alert(1)">纯文本';
    const { viewer } = createViewer([{ id: 't', name: '注.txt' }], {
      dialogLayer,
      content: new TextEncoder().encode(payload),
    });
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 't', name: '注.txt' });
    await flush();

    const pre = dialogLayer.querySelector<HTMLElement>('.ofd-attachment-preview__text')!;
    expect(pre.textContent).toBe(payload);
    // 内容只作为文本节点存在，没有生成 img 元素。
    expect(pre.querySelector('img')).toBeNull();
    view.closePreview();
  });

  it('超过 20 MB 的附件不读取内容，提示改为下载', async () => {
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);
    const { viewer, log } = createViewer(
      [{ id: 'big', name: '大.mp4', size: ATTACHMENT_PREVIEW_THRESHOLD_BYTES + 1 }],
      { dialogLayer },
    );
    const { view, host } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'big', name: '大.mp4', size: ATTACHMENT_PREVIEW_THRESHOLD_BYTES + 1 });
    await flush();

    expect(log.ids).toEqual([]);
    expect(dialogLayer.querySelector('.ofd-attachment-preview')).toBeNull();
    const status = host.querySelector('.ofd-attachments__status')!;
    expect(status.textContent).toContain('超过');
    expect(status.textContent).toContain('预览上限');
  });

  it('不可预览的类型调用预览入口时改为下载', async () => {
    const records = stubDownloads();
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);
    const { viewer } = createViewer([{ id: 'p', name: '文档.pdf' }], { dialogLayer });
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'p', name: '文档.pdf' });
    await flush();

    expect(dialogLayer.querySelector('.ofd-attachment-preview')).toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe('文档.pdf');
  });

  it('弹框打开时解除对话框层的 hidden，关闭后在层空时恢复', async () => {
    const dialogLayer = document.createElement('div');
    // 复刻外壳的初始状态：层为空时被隐藏。
    dialogLayer.hidden = true;
    document.body.appendChild(dialogLayer);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:layer',
      revokeObjectURL: () => undefined,
    });

    const { viewer } = createViewer([{ id: 'a1', name: '图.png' }], { dialogLayer });
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'a1', name: '图.png' });
    await flush();
    // 层必须可见，否则弹框继承 display:none 用户看不到。
    expect(dialogLayer.hidden).toBe(false);
    expect(dialogLayer.querySelector('.ofd-attachment-preview')).not.toBeNull();

    view.closePreview();
    await flush();
    expect(dialogLayer.childElementCount).toBe(0);
    expect(dialogLayer.hidden).toBe(true);
  });

  it('对话框层内还有其它内容时不回收集合状态', async () => {
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);
    const other = document.createElement('div');
    other.className = 'ofd-dialog';
    dialogLayer.appendChild(other);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:other',
      revokeObjectURL: () => undefined,
    });

    const { viewer } = createViewer([{ id: 'a1', name: '图.png' }], { dialogLayer });
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'a1', name: '图.png' });
    await flush();
    view.closePreview();
    await flush();

    expect(dialogLayer.querySelector('.ofd-dialog')).not.toBeNull();
    expect(dialogLayer.hidden).toBe(false);
  });

  it('预览弹框标题栏提供下载按钮，点击下载当前附件', async () => {
    const records = stubDownloads();
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);

    const { viewer } = createViewer(
      [{ id: 'a1', name: '图.png' }],
      { dialogLayer, content: new Uint8Array([7, 7, 7]) },
    );
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'a1', name: '图.png' });
    await flush();

    const button = dialogLayer.querySelector<HTMLButtonElement>(
      '.ofd-attachment-preview__download',
    );
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute('aria-label')).toBe('下载附件 图.png');

    button!.click();
    await flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe('图.png');
    view.closePreview();
  });

  it('导出权限禁止时预览内下载按钮禁用', async () => {
    const dialogLayer = document.createElement('div');
    document.body.appendChild(dialogLayer);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:denied',
      revokeObjectURL: () => undefined,
    });

    const { viewer } = createViewer([{ id: 'a1', name: '图.png' }], {
      dialogLayer,
      permissions: { ...ALLOW_EXPORT, export: false },
    });
    const { view } = mount(viewer);
    await flush();

    await view.previewAttachment({ id: 'a1', name: '图.png' });
    await flush();

    const button = dialogLayer.querySelector<HTMLButtonElement>(
      '.ofd-attachment-preview__download',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe('文档权限禁止导出附件');
    view.closePreview();
  });

  it('只有可预览类型渲染预览按钮', async () => {
    const { viewer } = createViewer([
      { id: 'p', name: '文档.pdf' },
      { id: 'i', name: '图.png' },
      { id: 'v', name: '片.mp4' },
    ]);
    const { host } = mount(viewer);
    await flush();

    const cards = host.querySelectorAll<HTMLElement>('.ofd-attachment');
    expect(cards[0]!.querySelector('.ofd-attachment__preview')).toBeNull();
    expect(cards[1]!.querySelector('.ofd-attachment__preview')).not.toBeNull();
    expect(cards[2]!.querySelector('.ofd-attachment__preview')).not.toBeNull();
    // 图标按类型区分。
    expect(cards[2]!.dataset.kind).toBe('video');
    expect(cards[2]!.querySelector('.ofd-attachment__icon')?.getAttribute('data-kind')).toBe(
      'video',
    );
  });
});