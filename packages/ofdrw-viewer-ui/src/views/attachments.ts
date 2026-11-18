/**
 * 附件侧栏视图（设计方案 §6.2）。
 *
 * 卡片式列表展示附件元信息（文件类型图标 + 勾选框 + 名称 + 元信息 + 图标按钮），
 * 支持单个下载、勾选多选后打包 ZIP 下载，以及图片/视频/音频/纯文本的弹框预览。
 *
 * 安全与行为约束：
 * - 附件内容一律不进入 DOM，不使用 innerHTML/srcdoc（文本预览只用 textContent）；
 * - 未知格式只提供下载，不提供预览；
 * - 预览超过 `ATTACHMENT_PREVIEW_THRESHOLD_BYTES` 或单附件超过
 *   `ATTACHMENT_LARGE_THRESHOLD_BYTES` 时都不读取内容，改为提示下载；
 * - 文档 `Permissions/Export` 为 false 时禁用下载与 ZIP 导出（预览不落盘，不受限）；
 * - 文件名过滤路径分隔符与控制字符，避免路径穿越。
 */

import { replaceChildren } from '../compat';

import type { AttachmentInfo, DocumentPermissions } from '@ofdrw/ofdrw-viewer-engine';
import { FocusTrap } from '../a11y';
import {
  ATTACHMENT_LARGE_THRESHOLD_BYTES,
  ATTACHMENT_PREVIEW_THRESHOLD_BYTES,
  attachmentIconKind,
  attachmentMimeType,
  attachmentPreviewKind,
  buildAttachmentFilename,
  concatChunks,
  formatAttachmentDate,
  formatAttachmentSize,
  isPreviewTooLargeAttachment,
  isLargeAttachment,
  triggerAttachmentDownload,
  uniqueAttachmentEntryName,
} from '../attachment-utils';
import type { AttachmentIconKind, AttachmentPreviewKind } from '../attachment-utils';
import { createGlyph, setButtonGlyph } from '../ui/glyphs';
import type { GlyphName } from '../ui/glyphs';
import { createStoreZip } from '../export/zip';
import type { ZipEntry } from '../export/zip';
import type { ViewerFeature } from '../features';
import type { Translator } from '../i18n';
import type { ViewerOrigin, ViewerState } from '../state';
import { createEmptyState, ensureNavigationStyle, reportNavigationWarning } from './shared';
import { UI_WARNING_CODES } from '../diagnostics';

/** 文本预览最多渲染的字符数，防止超长文本把弹框卡死。 */
const TEXT_PREVIEW_MAX_CHARS = 200_000;

/** 附件视图依赖的阅读器接口；`OFDViewer` 结构兼容。 */
export interface AttachmentViewer {
  /** 最新状态快照。 */
  getState(): ViewerState;
  /** 读取阅读器 DOM 根节点；诊断 warning 从此节点派发。 */
  getElements(): { readonly root: HTMLElement; readonly dialogLayer?: HTMLElement };
  /** 判断功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean;
  /** 订阅阅读器事件。 */
  on(event: 'statechange', handler: (state: ViewerState) => void): () => void;
  /** 读取文档信息快照；核心未提供时视为无附件。 */
  getDocumentInfo?(): Promise<{ readonly attachments: readonly AttachmentInfo[] }>;
  /** 读取当前文档权限声明；核心未提供时按允许处理。 */
  getPermissions?(): Promise<DocumentPermissions>;
  /** 读取当前打开文档的原始字节；用于下载整个 OFD 原文件。 */
  readSourceBytes?(signal?: AbortSignal): Promise<Uint8Array>;
  /** 底层引擎文档；存在 `saveAttachment` 时用于读取附件内容。 */
  getDocument(): object | null;
}

/** 附件字节读取能力；`OFDDocument` 结构兼容。 */
export interface AttachmentSource {
  /** 流式写出附件内容，返回写入字节总数。 */
  saveAttachment?(
    attachmentId: string,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    options?: { signal?: AbortSignal; chunkSize?: number },
  ): Promise<number>;
}

/** 确认请求。 */
export interface AttachmentConfirmRequest {
  /** 标题。 */
  readonly title: string;
  /** 正文。 */
  readonly message: string;
  /** 确认按钮文案。 */
  readonly confirmLabel: string;
  /** 取消按钮文案。 */
  readonly cancelLabel: string;
}

/** 确认对话框实现；宿主可注入自定义实现（例如使用内置外壳对话框）。 */
export type AttachmentConfirm = (request: AttachmentConfirmRequest) => Promise<boolean>;

/** 附件视图选项。 */
export interface AttachmentViewOptions {
  /** 阅读器。 */
  readonly viewer: AttachmentViewer;
  /** 面板容器。 */
  readonly host: HTMLElement;
  /** 读取当前翻译器。 */
  readonly getTranslator: () => Translator;
  /** 确认对话框；省略时使用 `window.confirm`。 */
  readonly confirm?: AttachmentConfirm;
}

/**
 * 由来源信息推导文档名，用于命名 ZIP 与 OFD 原文件。
 *
 * @param origin 打开来源；内存字节打开时省略。
 * @returns 清洗后的文档名；无法推导时为 `document`。
 */
function documentNameFromOrigin(origin: ViewerOrigin | undefined): string {
  const path = origin?.kind === 'url' ? origin.url : origin?.kind === 'file' ? origin.name : '';
  const segment = path.split('?')[0]?.split('#')[0]?.split(/[\\/]/).pop() ?? '';
  const stem = segment.replace(/\.[^.]+$/, '');
  const cleaned = stem.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'document';
}

/** 图标类别到文件图标名称。 */
const ICON_BY_KIND: Readonly<Record<AttachmentIconKind, GlyphName>> = Object.freeze({
  pdf: 'file-pdf',
  doc: 'file-doc',
  sheet: 'file-sheet',
  slide: 'file-slide',
  image: 'file-image',
  text: 'file-text',
  xml: 'file-xml',
  archive: 'file-archive',
  video: 'file-video',
  audio: 'file-audio',
  code: 'file-code',
  other: 'file',
});

/** 预览弹框内可复用的一个已打开预览。 */
interface OpenPreview {
  /** 弹框根节点。 */
  readonly element: HTMLElement;
  /** 焦点陷阱。 */
  readonly trap: FocusTrap;
  /** 触发前获得焦点的元素；关闭后焦点回到它。 */
  readonly trigger: HTMLElement | null;
  /** 媒体/文本预览的对象 URL；无需释放时为 undefined。 */
  readonly objectUrl?: string;
}

/**
 * 附件侧栏视图。
 */
export class AttachmentView {
  private readonly viewer: AttachmentViewer;
  private readonly host: HTMLElement;
  private readonly getTranslator: () => Translator;
  private readonly confirm: AttachmentConfirm;
  private readonly root: HTMLUListElement;
  private readonly toolbar: HTMLElement;
  private readonly selectAllButton: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly offs: Array<() => void> = [];
  private attachments: readonly AttachmentInfo[] | undefined;
  /** 已勾选的附件 ID；文档切换或列表刷新时清空。 */
  private readonly selected = new Set<string>();
  /** 文档 `Permissions/Export`；未读取时为 undefined，按允许处理。 */
  private exportAllowed = true;
  private preview: OpenPreview | null = null;
  private lastDocumentIdentity: OFDSourceLike = null;
  private lastLocale = '';
  private lastEnabled = true;
  private busy = false;
  private destroyed = false;

  /**
   * @param options 阅读器与面板容器。
   */
  constructor(options: AttachmentViewOptions) {
    this.viewer = options.viewer;
    this.host = options.host;
    this.getTranslator = options.getTranslator;
    this.confirm = options.confirm ?? defaultConfirm(this.host.ownerDocument);
    ensureNavigationStyle(this.host.ownerDocument);

    const doc = this.host.ownerDocument;
    this.toolbar = doc.createElement('div');
    this.toolbar.className = 'ofd-attachments__toolbar';
    this.selectAllButton = doc.createElement('button');
    this.selectAllButton.type = 'button';
    this.selectAllButton.className = 'ofd-button ofd-attachments__select-all';
    this.selectAllButton.addEventListener('click', () => this.toggleSelectAll());
    this.exportButton = doc.createElement('button');
    this.exportButton.type = 'button';
    this.exportButton.className = 'ofd-button ofd-attachments__export';
    // 导出按钮按勾选状态下载：未勾选时导出全部，勾选后只处理选中项。
    this.exportButton.addEventListener('click', () => void this.exportSelection());
    this.toolbar.append(this.selectAllButton, this.exportButton);

    this.status = doc.createElement('p');
    this.status.className = 'ofd-attachments__status';
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;

    this.root = doc.createElement('ul');
    this.root.className = 'ofd-attachments';
    this.root.setAttribute('role', 'list');
    this.root.setAttribute('aria-multiselectable', 'true');
    replaceChildren(this.host, this.toolbar, this.status, this.root);

    const state = this.viewer.getState();
    this.lastDocumentIdentity = state.document.source;
    this.lastLocale = state.ui.locale;
    this.lastEnabled = state.ui.features.attachments.enabled;
    this.offs.push(this.viewer.on('statechange', (next) => this.handleStateChange(next)));
    void this.reload(state);
  }

  /** 当前展示的附件列表；未加载时为 undefined。 */
  getAttachments(): readonly AttachmentInfo[] | undefined {
    return this.attachments;
  }

  /** 当前勾选的附件 ID 列表（按列表顺序）。 */
  getSelectedIds(): readonly string[] {
    return (this.attachments ?? [])
      .filter((attachment) => this.selected.has(attachment.id))
      .map((attachment) => attachment.id);
  }

  /** 释放监听、预览弹框与 DOM。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.closePreview();
    this.attachments = undefined;
    this.selected.clear();
    replaceChildren(this.host);
  }

  /**
   * 下载单个附件。
   *
   * 声明大小超过阈值的附件不读取内容，改为询问是否下载整个 OFD 原文件。
   *
   * @param attachment 附件元信息。
   */
  async download(attachment: AttachmentInfo): Promise<void> {
    if (this.destroyed || this.busy) return;
    if (!this.exportAllowed) {
      this.reportError(this.getTranslator().t('attachments.exportDenied'));
      return;
    }
    if (isLargeAttachment(attachment)) {
      await this.downloadWholeOfd(attachment);
      return;
    }
    const translator = this.getTranslator();
    const source = asAttachmentSource(this.viewer.getDocument());
    if (!source?.saveAttachment) {
      this.reportError(translator.t('attachments.unsupported'));
      return;
    }
    this.setBusy(true);
    try {
      const bytes = await readAttachmentBytes(source, attachment);
      triggerAttachmentDownload(
        this.host.ownerDocument,
        new Blob([bytes as unknown as BlobPart], {
          type: attachment.contentType ?? 'application/octet-stream',
        }),
        buildAttachmentFilename(attachment),
      );
      this.status.hidden = true;
    } catch (error) {
      this.reportError(this.describeError(translator, attachment, error));
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 切换单个附件的勾选状态。
   *
   * @param attachmentId 附件 ID。
   */
  toggleSelection(attachmentId: string): void {
    if (this.destroyed) return;
    if (this.selected.has(attachmentId)) this.selected.delete(attachmentId);
    else this.selected.add(attachmentId);
    this.render();
  }

  /** 全选 / 取消全选。 */
  toggleSelectAll(): void {
    if (this.destroyed) return;
    const items = this.selectableAttachments();
    if (items.length === 0) return;
    const allSelected = items.every((item) => this.selected.has(item.id));
    this.selected.clear();
    if (!allSelected) for (const item of items) this.selected.add(item.id);
    this.render();
  }

  /**
   * 导出：勾选多项时打包 ZIP，勾选一项时直接下载，未勾选时导出全部。
   *
   * 超过阈值的附件与读取失败的条目被跳过，完成后统一汇总提示，不静默丢弃。
   */
  async exportSelection(): Promise<void> {
    if (this.destroyed || this.busy) return;
    if (!this.exportAllowed) {
      this.reportError(this.getTranslator().t('attachments.exportDenied'));
      return;
    }
    const all = (this.attachments ?? []).filter((item) => item.name);
    const picked = all.filter((item) => this.selected.has(item.id));
    const items = picked.length > 0 ? picked : all;
    if (items.length === 0) {
      this.showStatus(this.getTranslator().t('attachments.empty'), 'info');
      return;
    }
    // 单选且不是大附件：直接下载原文件，不额外套一层 ZIP。
    if (items.length === 1) {
      await this.download(items[0] as AttachmentInfo);
      return;
    }
    await this.exportAsZip(items);
  }

  /**
   * 导出附件：等价于 {@link exportSelection}，保留旧调用入口。
   */
  async exportAll(): Promise<void> {
    await this.exportSelection();
  }

  /**
   * 批量打包下载为 ZIP（store 模式）。
   *
   * @param items 要打包的附件；调用方保证非空。
   */
  private async exportAsZip(items: readonly AttachmentInfo[]): Promise<void> {
    const translator = this.getTranslator();
    const source = asAttachmentSource(this.viewer.getDocument());
    if (!source?.saveAttachment) {
      this.reportError(translator.t('attachments.unsupported'));
      return;
    }
    this.setBusy(true);
    const entries: ZipEntry[] = [];
    const used = new Set<string>();
    const skippedLarge: string[] = [];
    const failed: string[] = [];
    try {
      for (const attachment of items) {
        if (isLargeAttachment(attachment)) {
          skippedLarge.push(attachment.name);
          continue;
        }
        try {
          const bytes = await readAttachmentBytes(source, attachment);
          entries.push({
            name: uniqueAttachmentEntryName(buildAttachmentFilename(attachment), used),
            data: bytes,
          });
        } catch {
          failed.push(attachment.name);
        }
      }
      const skipped = skippedLarge.length + failed.length;
      if (entries.length === 0) {
        this.showStatus(
          translator.t('attachments.exportSummary', { exported: 0, skipped }),
          'warning',
        );
        return;
      }
      const origin = this.viewer.getState().document.origin;
      // 复用图片导出的 store 模式 ZIP（fflate，按需动态导入），不另写打包实现。
      const zip = await createStoreZip(entries);
      if (this.destroyed) return;
      triggerAttachmentDownload(
        this.host.ownerDocument,
        zip,
        `${documentNameFromOrigin(origin)}-attachments.zip`,
      );
      this.showStatus(
        translator.t('attachments.exportSummary', { exported: entries.length, skipped }),
        skipped > 0 ? 'warning' : 'info',
      );
    } catch (error) {
      this.reportError(
        translator.t('attachments.error', {
          name: 'ZIP',
          size: '',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 预览附件：图片/视频/音频/纯文本走弹框，其余格式直接下载。
   *
   * 超过预览阈值的附件不读取内容，改为提示下载。
   *
   * @param attachment 附件元信息。
   */
  async previewAttachment(attachment: AttachmentInfo): Promise<void> {
    if (this.destroyed || this.busy) return;
    const translator = this.getTranslator();
    const kind = attachmentPreviewKind(attachment);
    if (!kind) {
      await this.download(attachment);
      return;
    }
    if (isPreviewTooLargeAttachment(attachment) || isLargeAttachment(attachment)) {
      this.showStatus(
        translator.t('attachments.previewTooLarge', {
          name: attachment.name,
          size: formatAttachmentSize(translator, attachment.size),
          threshold: formatAttachmentSize(translator, ATTACHMENT_PREVIEW_THRESHOLD_BYTES),
        }),
        'warning',
      );
      return;
    }
    const source = asAttachmentSource(this.viewer.getDocument());
    if (!source?.saveAttachment) {
      this.reportError(translator.t('attachments.unsupported'));
      return;
    }
    this.setBusy(true);
    try {
      const bytes = await readAttachmentBytes(source, attachment);
      if (this.destroyed) return;
      this.openPreview(attachment, kind, bytes);
    } catch (error) {
      this.reportError(
        translator.t('attachments.previewLoadFailed', {
          name: attachment.name,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 打开预览弹框。
   *
   * 图片/音视频通过 Blob 对象 URL 交给原生元素渲染；文本走 textContent，
   * 不经过任何 HTML 解析，避免附件内容被当作标记执行。
   *
   * @param attachment 附件元信息。
   * @param kind 预览类型。
   * @param bytes 已读取的附件内容。
   */
  private openPreview(
    attachment: AttachmentInfo,
    kind: AttachmentPreviewKind,
    bytes: Uint8Array,
  ): void {
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    this.closePreview();

    const trigger = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const element = doc.createElement('div');
    element.className = 'ofd-attachment-preview';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    element.setAttribute('aria-label', translator.t('attachments.previewTitle'));

    const header = doc.createElement('div');
    header.className = 'ofd-attachment-preview__header';
    const heading = doc.createElement('h2');
    heading.className = 'ofd-attachment-preview__title';
    heading.textContent = attachment.name;
    heading.title = attachment.name;
    const closeButton = doc.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'ofd-button ofd-attachment-preview__close';
    const closeLabel = translator.t('attachments.previewClose');
    closeButton.setAttribute('aria-label', closeLabel);
    closeButton.title = closeLabel;
    closeButton.textContent = '×';
    header.append(heading, closeButton);

    const body = doc.createElement('div');
    body.className = 'ofd-attachment-preview__body';
    body.dataset.kind = kind;

    let objectUrl: string | undefined;
    const view = doc.defaultView;
    if (kind === 'text') {
      const pre = doc.createElement('pre');
      pre.className = 'ofd-attachment-preview__text';
      const text = new TextDecoder('utf-8').decode(bytes);
      pre.textContent =
        text.length > TEXT_PREVIEW_MAX_CHARS ? text.slice(0, TEXT_PREVIEW_MAX_CHARS) : text;
      body.append(pre);
      if (text.length > TEXT_PREVIEW_MAX_CHARS) {
        const note = doc.createElement('p');
        note.className = 'ofd-attachment-preview__note';
        note.textContent = translator.t('attachments.previewTextTruncated', {
          length: TEXT_PREVIEW_MAX_CHARS,
        });
        body.append(note);
      }
    } else if (view?.URL?.createObjectURL) {
      objectUrl = view.URL.createObjectURL(
        new Blob([bytes as unknown as BlobPart], { type: attachmentMimeType(attachment) }),
      );
      if (kind === 'image') {
        const image = doc.createElement('img');
        image.className = 'ofd-attachment-preview__image';
        image.alt = attachment.name;
        image.src = objectUrl;
        body.append(image);
      } else {
        const media = doc.createElement(kind === 'video' ? 'video' : 'audio');
        media.className = `ofd-attachment-preview__${kind}`;
        media.controls = true;
        media.autoplay = kind === 'audio';
        media.src = objectUrl;
        media.setAttribute(
          'aria-label',
          translator.t(kind === 'video' ? 'media.video' : 'media.audio'),
        );
        body.append(media);
      }
    } else {
      // 环境不支持 Blob URL：预览无法进行，提示下载。
      this.reportError(
        translator.t('attachments.previewLoadFailed', {
          name: attachment.name,
          message: 'Blob URL unsupported',
        }),
      );
      return;
    }

    element.append(header, body);
    const layer = this.viewer.getElements().dialogLayer ?? this.viewer.getElements().root;
    layer.appendChild(element);

    const trap = new FocusTrap(element, {
      onEscape: () => this.closePreview(),
      restoreFocus: false,
    });
    trap.activate({ moveFocus: false });
    closeButton.focus();
    closeButton.addEventListener('click', () => this.closePreview());
    // 点击遮罩关闭；弹框内部点击不冒泡到遮罩。
    element.addEventListener('click', (event) => {
      if (event.target === element) this.closePreview();
    });

    this.preview = { element, trap, trigger, objectUrl };
  }

  /** 关闭预览弹框并释放对象 URL、归还焦点。 */
  closePreview(): void {
    const current = this.preview;
    if (!current) return;
    this.preview = null;
    current.trap.deactivate({ restoreFocus: false });
    current.element.remove();
    if (current.objectUrl) {
      const view = this.host.ownerDocument.defaultView;
      try {
        view?.URL?.revokeObjectURL?.(current.objectUrl);
      } catch {
        // 释放失败不影响关闭。
      }
    }
    current.trigger?.focus?.();
  }

  /** 大附件：不读内容，提示改为下载整个 OFD 原文件。 */
  private async downloadWholeOfd(attachment: AttachmentInfo): Promise<void> {
    const translator = this.getTranslator();
    const confirmed = await this.confirm({
      title: translator.t('attachments.confirmLargeTitle'),
      message: translator.t('attachments.confirmLarge', {
        name: attachment.name,
        size: formatAttachmentSize(translator, attachment.size),
        threshold: formatAttachmentSize(translator, ATTACHMENT_LARGE_THRESHOLD_BYTES),
      }),
      confirmLabel: translator.t('attachments.downloadOfd'),
      cancelLabel: translator.t('attachments.cancel'),
    });
    if (!confirmed || this.destroyed) return;
    if (!this.viewer.readSourceBytes) {
      this.reportError(translator.t('attachments.ofdUnavailable'));
      return;
    }
    this.setBusy(true);
    try {
      const bytes = await this.viewer.readSourceBytes();
      const name = documentNameFromOrigin(this.viewer.getState().document.origin);
      const filename = name.toLowerCase().endsWith('.ofd') ? name : `${name}.ofd`;
      triggerAttachmentDownload(
        this.host.ownerDocument,
        new Blob([bytes as unknown as BlobPart], { type: 'application/ofd' }),
        filename,
      );
      this.status.hidden = true;
    } catch (error) {
      this.reportError(this.describeError(translator, attachment, error));
    } finally {
      this.setBusy(false);
    }
  }

  /** 处理状态变化：文档切换/语言/功能开关。 */
  private handleStateChange(state: ViewerState): void {
    if (this.destroyed) return;
    const enabled = state.ui.features.attachments.enabled;
    const documentChanged = state.document.source !== this.lastDocumentIdentity;
    const localeChanged = state.ui.locale !== this.lastLocale;
    this.lastDocumentIdentity = state.document.source;
    if (documentChanged || localeChanged || enabled !== this.lastEnabled) {
      this.lastLocale = state.ui.locale;
      this.lastEnabled = enabled;
      void this.reload(state);
      return;
    }
    this.updateLabels();
  }

  /** 重新读取附件元信息与导出权限并渲染。 */
  private async reload(state: ViewerState): Promise<void> {
    if (this.destroyed) return;
    this.updateLabels();
    // 文档切换后旧勾选与预览都不再有效。
    this.selected.clear();
    this.closePreview();
    if (!state.ui.features.attachments.enabled) {
      this.attachments = undefined;
      replaceChildren(this.root);
      this.toolbar.hidden = true;
      return;
    }
    if (state.document.status !== 'ready' || typeof this.viewer.getDocumentInfo !== 'function') {
      this.attachments = undefined;
      this.render();
      return;
    }
    try {
      const [info, permissions] = await Promise.all([
        this.viewer.getDocumentInfo(),
        this.viewer.getPermissions?.().catch(() => undefined),
      ]);
      if (this.destroyed) return;
      this.attachments = info.attachments;
      // 未提供权限能力或读取失败时按允许处理，保持原有可用性。
      this.exportAllowed = permissions ? permissions.export !== false : true;
    } catch (error) {
      if (this.destroyed) return;
      this.attachments = undefined;
      this.reportError(this.describeError(this.getTranslator(), undefined, error));
    }
    this.render();
  }

  /** 可勾选的附件（有名称的条目）。 */
  private selectableAttachments(): readonly AttachmentInfo[] {
    return (this.attachments ?? []).filter((attachment) => attachment.name);
  }

  /** 更新常驻文案与忙碌态。 */
  private updateLabels(): void {
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    const selectedCount = this.getSelectedIds().length;
    const allLabel = translator.t('attachments.selectAll');
    const clearLabel = translator.t('attachments.clearSelection');
    // 全选按钮只用文字：勾选后切换为“取消全选”，动作与文案保持一致。
    this.selectAllButton.textContent = selectedCount > 0 ? clearLabel : allLabel;
    this.selectAllButton.setAttribute('aria-label', allLabel);
    this.selectAllButton.title = allLabel;

    // 有勾选时按钮切换为“下载选中”，否则沿用“导出全部”。
    const exportLabel =
      selectedCount > 0
        ? translator.t('attachments.downloadSelectedNamed', { count: selectedCount })
        : translator.t('attachments.exportAll');
    setButtonGlyph(this.exportButton, 'export', exportLabel, doc);
    this.exportButton.setAttribute('aria-label', exportLabel);
    this.exportButton.title = exportLabel;
    this.root.setAttribute('aria-label', translator.t('attachments.title'));
    this.updateDisabledState();
  }

  /** 按忙碌态与权限刷新按钮禁用状态。 */
  private updateDisabledState(): void {
    const hasSelection = this.getSelectedIds().length > 0;
    const exportDisabled = this.busy || !this.exportAllowed;
    this.exportButton.disabled = exportDisabled;
    this.selectAllButton.disabled = this.busy || !this.exportAllowed;
    this.selectAllButton.setAttribute('aria-pressed', hasSelection ? 'true' : 'false');
  }

  /** 设置忙碌态（禁用工具按钮与卡片按钮）。 */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.exportButton.setAttribute('aria-busy', busy ? 'true' : 'false');
    this.updateDisabledState();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = busy;
    }
  }

  /** 渲染列表或空态。 */
  private render(): void {
    if (this.destroyed) return;
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    replaceChildren(this.root);
    const enabled = this.viewer.getState().ui.features.attachments.enabled;
    this.toolbar.hidden = !enabled;
    // 列表变化后勾选可能指向已不存在的条目，按当前列表裁剪。
    const present = new Set((this.attachments ?? []).map((attachment) => attachment.id));
    for (const id of [...this.selected]) {
      if (!present.has(id)) this.selected.delete(id);
    }
    this.updateLabels();
    if (!enabled) return;
    const items = this.attachments ?? [];
    if (items.length === 0) {
      this.root.append(createEmptyState(doc, translator.t('attachments.empty')));
      return;
    }
    let rendered = 0;
    for (const attachment of items) {
      // 无名称的条目无法展示也无法命名下载文件，直接跳过。
      if (!attachment.name) continue;
      rendered += 1;
      this.root.append(this.createAttachmentCard(attachment));
    }
    if (rendered === 0) {
      this.root.append(createEmptyState(doc, translator.t('attachments.empty')));
    }
  }

  /**
   * 创建单个附件卡片：勾选框 + 文件图标 + 名称 + 元信息 + 图标按钮（预览/下载）。
   *
   * @param attachment 附件元信息。
   * @returns 卡片元素。
   */
  private createAttachmentCard(attachment: AttachmentInfo): HTMLLIElement {
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    // 无名称的条目已被过滤；`name` 在此为非空字符串。
    const name = attachment.name as string;
    const kind = attachmentIconKind(attachment);
    const large = isLargeAttachment(attachment);
    const previewKind = attachmentPreviewKind(attachment);
    const checked = this.selected.has(attachment.id);

    const item = doc.createElement('li');
    item.className = 'ofd-attachment';
    item.dataset.attachmentId = attachment.id;
    item.dataset.kind = kind;
    if (checked) item.dataset.selected = 'true';

    const selectLabel = translator.t('attachments.select', { name });
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ofd-attachment__check';
    checkbox.checked = checked;
    checkbox.disabled = this.busy;
    checkbox.setAttribute('aria-label', selectLabel);
    checkbox.addEventListener('change', () => this.toggleSelection(attachment.id));

    const icon = doc.createElement('span');
    icon.className = 'ofd-attachment__icon';
    icon.dataset.kind = kind;
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(createGlyph(ICON_BY_KIND[kind], doc));

    const body = doc.createElement('div');
    body.className = 'ofd-attachment__body';
    const nameElement = doc.createElement('span');
    nameElement.className = 'ofd-attachment__name';
    nameElement.textContent = name;
    nameElement.title = name;
    const meta = doc.createElement('span');
    meta.className = 'ofd-attachment__meta';
    // 侧栏较窄：类型/大小与日期分两行，缺失值显示 -，完整信息由 title 提供。
    const sizeText = [
      attachment.format ?? translator.t('attachments.missing'),
      formatAttachmentSize(translator, attachment.size),
    ].join(' · ');
    const dateText = formatAttachmentDate(attachment, translator);
    const sizeLine = doc.createElement('span');
    sizeLine.className = 'ofd-attachment__meta-size';
    sizeLine.textContent = sizeText;
    const dateLine = doc.createElement('span');
    dateLine.className = 'ofd-attachment__meta-date';
    dateLine.textContent = dateText;
    meta.append(sizeLine, dateLine);
    meta.title = `${sizeText} · ${dateText}`;
    body.append(nameElement, meta);

    const actions = doc.createElement('span');
    actions.className = 'ofd-attachment__actions';

    // 只有可预览类型才给预览按钮；超过预览阈值时点击会提示并引导下载。
    if (previewKind) {
      const previewButton = doc.createElement('button');
      previewButton.type = 'button';
      previewButton.className = 'ofd-button ofd-attachment__preview';
      previewButton.disabled = this.busy;
      const label = translator.t('attachments.previewNamed', { name });
      setButtonGlyph(previewButton, previewIcon(kind), undefined, doc);
      previewButton.setAttribute('aria-label', label);
      previewButton.title = label;
      if (isPreviewTooLargeAttachment(attachment)) previewButton.dataset.large = 'true';
      previewButton.addEventListener('click', () => void this.previewAttachment(attachment));
      actions.append(previewButton);
    }

    // 图标按钮：只保留图标，名称/动作由 aria-label 与 title 提供，避免挤压卡片正文。
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ofd-button ofd-attachment__download';
    button.disabled = this.busy || !this.exportAllowed;
    setButtonGlyph(button, 'download', undefined, doc);
    const label = translator.t('attachments.downloadNamed', { name });
    button.setAttribute('aria-label', label);
    button.title = this.exportAllowed ? label : translator.t('attachments.exportDenied');
    if (large) button.dataset.large = 'true';
    button.addEventListener('click', () => void this.download(attachment));
    actions.append(button);

    item.append(checkbox, icon, body, actions);
    return item;
  }

  /** 组装失败文案。 */
  private describeError(
    translator: Translator,
    attachment: AttachmentInfo | undefined,
    error: unknown,
  ): string {
    return translator.t('attachments.error', {
      name: attachment?.name ?? '-',
      size: attachment ? formatAttachmentSize(translator, attachment.size) : '',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /** 展示状态提示。 */
  private showStatus(message: string, level: 'info' | 'warning'): void {
    this.status.textContent = message;
    this.status.dataset.level = level;
    this.status.hidden = false;
  }

  /** 上报失败：面板内提示 + `W_ATTACHMENT_RESOURCE` 诊断，不抛给宿主。 */
  private reportError(message: string): void {
    if (this.destroyed) return;
    this.showStatus(message, 'warning');
    reportNavigationWarning(this.viewer, UI_WARNING_CODES.W_ATTACHMENT_RESOURCE, message);
  }
}

/**
 * 读取附件全部内容。
 *
 * 引擎可能复用分块缓冲区，因此每次回调都立刻拷贝。
 *
 * @param source 附件源。
 * @param attachment 附件元信息。
 * @returns 附件完整字节。
 */
async function readAttachmentBytes(
  source: AttachmentSource,
  attachment: AttachmentInfo,
): Promise<Uint8Array> {
  const save = source.saveAttachment;
  if (!save) throw new Error('当前引擎不支持流式读取附件');
  const chunks: Uint8Array[] = [];
  await save.call(source, attachment.id, (chunk) => {
    chunks.push(chunk.slice());
  });
  return concatChunks(chunks);
}

/**
 * 预览按钮使用的图标：按附件类型选择，未覆盖的类型回退为文件图标。
 *
 * @param kind 附件图标类别。
 * @returns 图标名称。
 */
function previewIcon(kind: AttachmentIconKind): GlyphName {
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'text') return 'file-media';
  return 'file';
}

/**
 * 判断引擎文档是否具备附件流式读取能力。
 *
 * 旧版引擎没有 `saveAttachment`，此时返回 null，由调用方提示不支持。
 *
 * @param document 引擎文档。
 * @returns 具备能力时返回附件源；否则返回 null。
 */
function asAttachmentSource(document: object | null): AttachmentSource | null {
  if (!document) return null;
  const candidate = document as AttachmentSource;
  return typeof candidate.saveAttachment === 'function' ? candidate : null;
}

/** 文档来源的标识类型；仅用于判断是否切换了文档。 */
type OFDSourceLike = ViewerState['document']['source'];

/**
 * 默认确认实现：使用 `window.confirm`；不可用时按取消处理。
 *
 * @param doc 宿主文档。
 * @returns 确认函数。
 */
function defaultConfirm(doc: Document): AttachmentConfirm {
  return async (request) => {
    const confirmFn = doc.defaultView?.confirm;
    if (typeof confirmFn !== 'function') return false;
    return confirmFn.call(doc.defaultView, `${request.title}\n\n${request.message}`);
  };
}

/**
 * 挂载附件面板。
 *
 * @param options 阅读器与面板容器。
 * @returns 附件视图实例。
 */
export function mountAttachmentView(options: AttachmentViewOptions): AttachmentView {
  return new AttachmentView(options);
}