/**
 * 附件侧栏视图（设计方案 §6.2）。
 *
 * 列表展示附件元信息，提供单个下载与批量 ZIP 导出。安全约束：
 * - 附件内容一律不进入 DOM，不使用 innerHTML/srcdoc；
 * - 未知格式只提供下载，不提供预览；
 * - 单附件声明大小超过阈值时不读取内容，改为提示下载整个 OFD 原文件；
 * - 文件名过滤路径分隔符与控制字符，避免路径穿越。
 */

import { replaceChildren } from '../compat';

import type { AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import {
  ATTACHMENT_LARGE_THRESHOLD_BYTES,
  buildAttachmentFilename,
  concatChunks,
  formatAttachmentDate,
  formatAttachmentSize,
  isLargeAttachment,
  triggerAttachmentDownload,
  uniqueAttachmentEntryName,
} from '../attachment-utils';
import { createStoreZip } from '../export/zip';
import type { ZipEntry } from '../export/zip';
import type { ViewerFeature } from '../features';
import type { Translator } from '../i18n';
import type { ViewerOrigin, ViewerState } from '../state';
import { createEmptyState, ensureNavigationStyle, reportNavigationWarning } from './shared';
import { UI_WARNING_CODES } from '../diagnostics';

/** 附件视图依赖的阅读器接口；`OFDViewer` 结构兼容。 */
export interface AttachmentViewer {
  /** 最新状态快照。 */
  getState(): ViewerState;
  /** 读取阅读器 DOM 根节点；诊断 warning 从此节点派发。 */
  getElements(): { readonly root: HTMLElement };
  /** 判断功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean;
  /** 订阅阅读器事件。 */
  on(event: 'statechange', handler: (state: ViewerState) => void): () => void;
  /** 读取文档信息快照；核心未提供时视为无附件。 */
  getDocumentInfo?(): Promise<{ readonly attachments: readonly AttachmentInfo[] }>;
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
  private readonly exportButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly offs: Array<() => void> = [];
  private attachments: readonly AttachmentInfo[] | undefined;
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
    this.exportButton = doc.createElement('button');
    this.exportButton.type = 'button';
    this.exportButton.className = 'ofd-button ofd-attachments__export';
    this.exportButton.addEventListener('click', () => void this.exportAll());
    this.toolbar.append(this.exportButton);

    this.status = doc.createElement('p');
    this.status.className = 'ofd-attachments__status';
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;

    this.root = doc.createElement('ul');
    this.root.className = 'ofd-attachments';
    this.root.setAttribute('role', 'list');
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

  /** 释放监听与 DOM。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.attachments = undefined;
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
      const chunks: Uint8Array[] = [];
      await source.saveAttachment(attachment.id, (chunk) => {
        // 引擎可能复用缓冲区，必须立即拷贝。
        chunks.push(chunk.slice());
      });
      triggerAttachmentDownload(
        this.host.ownerDocument,
        new Blob([concatChunks(chunks) as unknown as BlobPart], {
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
   * 批量导出全部附件为 ZIP（store 模式）。
   *
   * 超过阈值的附件与读取失败的条目被跳过，完成后统一汇总提示，不静默丢弃。
   */
  async exportAll(): Promise<void> {
    if (this.destroyed || this.busy) return;
    const translator = this.getTranslator();
    const items = this.attachments ?? [];
    if (items.length === 0) {
      this.showStatus(translator.t('attachments.empty'), 'info');
      return;
    }
    const source = asAttachmentSource(this.viewer.getDocument());
    if (!source?.saveAttachment) {
      this.reportError(translator.t('attachments.unsupported'));
      return;
    }
    this.setBusy(true);
    const entries: ZipEntry[] = [];
    const used = new Set<string>();
    const names: AttachmentInfo[] = [];
    const skippedLarge: string[] = [];
    const failed: string[] = [];
    try {
      for (const attachment of items) {
        if (!attachment.name) continue;
        if (isLargeAttachment(attachment)) {
          skippedLarge.push(attachment.name);
          continue;
        }
        try {
          const chunks: Uint8Array[] = [];
          await source.saveAttachment(attachment.id, (chunk) => {
            chunks.push(chunk.slice());
          });
          entries.push({
            name: uniqueAttachmentEntryName(buildAttachmentFilename(attachment), used),
            data: concatChunks(chunks),
          });
          names.push(attachment);
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

  /** 重新读取附件元信息并渲染。 */
  private async reload(state: ViewerState): Promise<void> {
    if (this.destroyed) return;
    this.updateLabels();
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
      const info = await this.viewer.getDocumentInfo();
      if (this.destroyed) return;
      this.attachments = info.attachments;
    } catch (error) {
      if (this.destroyed) return;
      this.attachments = undefined;
      this.reportError(this.describeError(this.getTranslator(), undefined, error));
    }
    this.render();
  }

  /** 更新常驻文案与忙碌态。 */
  private updateLabels(): void {
    const translator = this.getTranslator();
    this.exportButton.textContent = translator.t('attachments.exportAll');
    this.exportButton.setAttribute('aria-label', translator.t('attachments.exportAll'));
    this.root.setAttribute('aria-label', translator.t('attachments.title'));
    this.exportButton.disabled = this.busy;
  }

  /** 设置忙碌态（禁用导出按钮）。 */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.exportButton.disabled = busy;
    this.exportButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /** 渲染列表或空态。 */
  private render(): void {
    if (this.destroyed) return;
    const doc = this.host.ownerDocument;
    const translator = this.getTranslator();
    replaceChildren(this.root);
    const enabled = this.viewer.getState().ui.features.attachments.enabled;
    this.toolbar.hidden = !enabled;
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
      const item = doc.createElement('li');
      item.className = 'ofd-attachment';
      item.dataset.attachmentId = attachment.id;

      const name = doc.createElement('span');
      name.className = 'ofd-attachment__name';
      name.textContent = attachment.name;

      const meta = doc.createElement('span');
      meta.className = 'ofd-attachment__meta';
      meta.textContent = [
        attachment.format ?? translator.t('attachments.missing'),
        formatAttachmentSize(translator, attachment.size),
        formatAttachmentDate(attachment, translator),
      ].join(' · ');

      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ofd-button ofd-attachment__download';
      button.textContent = translator.t('attachments.download');
      button.setAttribute(
        'aria-label',
        translator.t('attachments.downloadNamed', { name: attachment.name }),
      );
      if (isLargeAttachment(attachment)) button.dataset.large = 'true';
      button.addEventListener('click', () => void this.download(attachment));

      item.append(name, meta, button);
      this.root.append(item);
    }
    if (rendered === 0) {
      this.root.append(createEmptyState(doc, translator.t('attachments.empty')));
    }
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
