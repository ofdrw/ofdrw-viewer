/**
 * 签章服务（设计方案 §11，不验签）。
 *
 * 职责：
 * - 消费引擎 `getSignatureEntries()` 的 XML 摘要与 `getSignedValue()` 的原始字节；
 * - 在签章侧栏按页分组展示；
 * - 在页面上按 `StampAnnot.Boundary/Clip`（mm→px）绘制覆盖层；
 * - 按需动态解析 `SignedValue.dat` 并展示详情。
 *
 * 明确不做：验签、证书链/有效期校验、CRL/OCSP、时间戳验证；不读取 `Seal.esl`。
 */

import type {
  Box,
  SignatureEntryInfo,
  SignatureStampInfo,
  SignedValueFile,
} from '@ofdrw/ofdrw-viewer-engine';
import { parseSignedValue } from '@ofdrw/ofdrw-viewer-crypto';
import type { SignatureVerification } from '@ofdrw/ofdrw-viewer-crypto';
import { createFeatureDisabledError, OFDViewerError } from '../errors';
import { MM_TO_CSS_PX } from '../page-layout';
import type { PageView } from '../page-view';
import type { ViewerWarning } from '../state';
import type { CertificateInfo, SealInfo, SignatureDetail, SignerInfo } from '../types';
import { getUIShell } from '../ui';
import type { OFDViewer, ViewerSignatureService } from '../viewer';
import { createCryptoText } from '../crypto';
import { openSignaturePopover } from '../crypto';
import { VERIFICATION_RESET_EVENT } from '../crypto/service';
import { subjectCN, toSealInfo, toSignerInfo } from './mapping';

/** 未验证声明文案。 */
export const SIGNATURE_NOT_VERIFIED_NOTE =
  '本面板仅展示签章信息，未进行签名验证/证书链校验。';

/** 未验证状态；固定值，UI 不得改成“有效/验签通过”。 */
const NOT_VERIFIED = Object.freeze({
  status: 'not-verified' as const,
  note: SIGNATURE_NOT_VERIFIED_NOTE,
});

/** 单页覆盖层记录。 */
interface OverlayRecord {
  /** 覆盖层按钮。 */
  readonly element: HTMLButtonElement;
  /** 签章 ID。 */
  readonly signatureId: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 页内位置，mm。 */
  readonly boundary: Box;
  /** 裁剪区域（相对 Boundary），mm。 */
  readonly clip?: Box;
}

/** 列表项可更新文本节点。 */
interface SummaryRefs {
  /** 印章名称。 */
  readonly name: HTMLElement;
  /** 签章时间。 */
  readonly time: HTMLElement;
  /** 签章者 CN。 */
  readonly signer: HTMLElement;
}

/** 按页分组的列表项。 */
interface SummaryItem {
  /** 签章条目。 */
  readonly entry: SignatureEntryInfo;
  /** 戳记；无戳记时省略。 */
  readonly stamp?: SignatureStampInfo;
  /** 页码，1-based；未定位时省略。 */
  readonly pageNumber?: number;
}

/** 按页分组。 */
interface SummaryGroup {
  /** 页码，1-based；未定位时为 undefined。 */
  readonly pageNumber?: number;
  /** 页面标识或空。 */
  readonly pageId?: string;
  /** 组内条目。 */
  readonly items: readonly SummaryItem[];
}

/**
 * 签章服务实例。
 *
 * 由 `src/views/signatures.ts` 通过 `registerViewerExtension` 挂载；一个阅读器实例
 * 对应一个服务，`destroy()` 时释放全部 DOM 与缓存。
 */
export class SignatureService implements ViewerSignatureService {
  private readonly viewer: OFDViewer;
  private readonly doc: Document;
  private readonly offs: Array<() => void> = [];

  private entries: readonly SignatureEntryInfo[] = [];
  private summaryRef: readonly SignatureEntryInfo[] | null = null;
  private entriesAttempted = false;
  private entriesPromise: Promise<readonly SignatureEntryInfo[]> | null = null;

  private readonly details = new Map<string, SignatureDetail>();
  private readonly detailPromises = new Map<string, Promise<SignatureDetail>>();

  private pageViews: readonly PageView[] = [];
  private overlays: OverlayRecord[] = [];
  private overlayDirty = true;
  private lastScale = 1;
  private lastRotation = 0;
  private highlightedId: string | null = null;

  private panelMounted = false;
  private panelHost: HTMLElement | null = null;
  private readonly summaryRefs = new Map<string, SummaryRefs[]>();
  private hydrated = false;
  private hydrating = false;

  private fallbackDialog: HTMLElement | null = null;
  private fallbackBackdrop: HTMLElement | null = null;
  private fallbackDialogCleanup: (() => void) | null = null;
  private detailToken = 0;
  private openDetailId: string | null = null;
  private destroyed = false;

  /**
   * @param viewer 阅读器实例。
   */
  constructor(viewer: OFDViewer) {
    this.viewer = viewer;
    this.doc = viewer.getRoot().ownerDocument;
    this.lastScale = viewer.getScale();
    this.lastRotation = viewer.getRotation();
    this.offs.push(viewer.on('statechange', () => this.sync()));
    this.offs.push(
      viewer.on('documentopen', () => {
        this.resetDocumentState();
        this.sync();
      }),
    );
    this.offs.push(viewer.on('documentclose', () => this.resetDocumentState()));
    this.offs.push(
      viewer.on('featureschange', () => {
        this.reconcileVerification();
        this.sync();
      }),
    );
    this.offs.push(viewer.on('verificationcompleted', () => this.reconcileVerification()));
    const root = this.viewer.getRoot();
    const onVerificationReset = (): void => this.reconcileVerification();
    root.addEventListener(VERIFICATION_RESET_EVENT, onVerificationReset);
    this.offs.push(() => root.removeEventListener(VERIFICATION_RESET_EVENT, onVerificationReset));
    this.sync();
  }

  // -------------------------------------------------------------------------
  // ViewerSignatureService
  // -------------------------------------------------------------------------

  /**
   * 当前签章摘要列表；不解析 ASN.1。
   *
   * @returns 引擎返回的 XML 摘要。
   * @throws {OFDViewerError} `features.signatures=false` 时抛 `OFD_FEATURE_DISABLED`。
   */
  getSignatures(): readonly SignatureEntryInfo[] {
    this.assertEnabled();
    this.syncEntriesFromViewer();
    if (!this.entriesAttempted && this.entries.length === 0) void this.ensureEntries();
    return this.entries;
  }

  /**
   * 读取单个签章详情；按需动态加载 ASN.1 解析器并缓存结果。
   *
   * @param id 签章 ID。
   * @returns 详情；字段缺失时通过 warnings 降级，不抛解析错误。
   * @throws {OFDViewerError} 功能关闭、文档未打开或签章不存在时抛出。
   */
  async getSignatureDetail(id: string): Promise<SignatureDetail> {
    this.assertEnabled();
    const cached = this.details.get(id);
    if (cached) {
      // 缓存只复用解析结果；验证状态必须以当前报告为准，报告失效即剥离。
      const verification = this.findVerification(id);
      if (verification) {
        if (cached.verification === verification) return cached;
        const next = { ...cached, verification };
        this.details.set(id, next);
        return next;
      }
      if (!cached.verification) return cached;
      const next = omitVerification(cached);
      this.details.set(id, next);
      return next;
    }
    let pending = this.detailPromises.get(id);
    if (pending) return pending;

    pending = this.loadDetail(id)
      .then((detail) => {
        // 解析期间报告可能已失效/更新；返回前按当前报告再校准一次。
        const verification = this.findVerification(id);
        if (detail.verification === verification) return detail;
        const next = verification ? { ...detail, verification } : omitVerification(detail);
        this.details.set(id, next);
        return next;
      })
      .finally(() => {
        this.detailPromises.delete(id);
      });
    this.detailPromises.set(id, pending);
    return pending;
  }

  /**
   * 定位签章：滚动到首个戳记页、高亮覆盖层并打开详情。
   *
   * @param id 签章 ID。
   * @throws {OFDViewerError} 功能关闭或签章不存在时抛出。
   */
  async showSignature(id: string): Promise<void> {
    this.assertEnabled();
    const entry = await this.findEntry(id);
    const stamp = entry.stamps.find((item) => item.pageIndex !== undefined);
    if (stamp?.pageIndex !== undefined && this.viewer.isFeatureEnabled('pageNavigation')) {
      this.viewer.goToPage(stamp.pageIndex + 1);
    }
    this.highlight(id);
    await this.openDetail(id);
  }

  /** 销毁服务：移除监听、覆盖层、面板内容与对话框。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.detailToken += 1;
    this.clearOverlays();
    this.closeAnyDialog();
    if (this.panelHost) {
      this.panelHost.replaceChildren();
      this.panelHost = null;
    }
    this.summaryRefs.clear();
    this.details.clear();
    this.detailPromises.clear();
  }

  // -------------------------------------------------------------------------
  // 数据同步
  // -------------------------------------------------------------------------

  /**
   * 断言签章功能可用且服务未销毁。
   *
   * @throws {OFDViewerError} 服务销毁或 `features.signatures=false` 时抛出。
   */
  private assertEnabled(): void {
    if (this.destroyed) {
      throw new OFDViewerError('OFD_DESTROYED', '签章服务已销毁');
    }
    if (!this.viewer.isFeatureEnabled('signatures')) {
      throw createFeatureDisabledError('signatures');
    }
  }

  /** 文档切换时清理摘要、详情与覆盖层。 */
  private resetDocumentState(): void {
    if (this.destroyed) return;
    this.detailToken += 1;
    this.entries = [];
    this.summaryRef = null;
    this.entriesAttempted = false;
    this.entriesPromise = null;
    this.details.clear();
    this.detailPromises.clear();
    this.hydrated = false;
    this.hydrating = false;
    this.summaryRefs.clear();
    this.overlayDirty = true;
    this.highlightedId = null;
    this.clearOverlays();
    this.closeAnyDialog();
    this.renderPanel();
  }

  /** 状态变化时的轻量同步：面板、覆盖层与功能门控。 */
  private sync(): void {
    if (this.destroyed) return;
    this.ensurePanel();
    if (!this.viewer.isFeatureEnabled('signatures')) {
      this.clearOverlays();
      this.closeAnyDialog();
      this.panelHost?.replaceChildren();
      return;
    }
    this.syncEntriesFromViewer();
    this.syncOverlays();
    if (!this.panelHost) this.ensurePanel();
    if (this.panelHost && !this.hydrated && !this.hydrating) void this.hydrate();
  }

  /** 把核心状态里的签章摘要同步到本地。 */
  private syncEntriesFromViewer(): void {
    const summary = this.viewer.getSignatures();
    if (summary === this.summaryRef) return;
    const previousCount = this.summaryRef?.length ?? 0;
    this.summaryRef = summary;
    if (summary.length > 0) this.setEntries(summary);
    else if (previousCount > 0) this.setEntries([]);
  }

  /**
   * 替换摘要列表并清理派生缓存。
   *
   * @param next 新摘要。
   */
  private setEntries(next: readonly SignatureEntryInfo[]): void {
    if (this.entries === next) return;
    this.entries = next;
    this.details.clear();
    this.detailPromises.clear();
    this.hydrated = false;
    this.summaryRefs.clear();
    this.overlayDirty = true;
    this.renderPanel();
    this.syncOverlays();
  }

  /** 懒加载摘要：优先核心状态，必要时直接向引擎读取一次。 */
  private ensureEntries(): Promise<readonly SignatureEntryInfo[]> {
    if (this.entries.length > 0) return Promise.resolve(this.entries);
    if (this.entriesPromise) return this.entriesPromise;
    this.entriesAttempted = true;
    this.entriesPromise = (async () => {
      const summary = this.viewer.getSignatures();
      if (summary.length > 0) {
        this.setEntries(summary);
        return this.entries;
      }
      const engine = this.viewer.getDocument();
      if (!engine) return this.entries;
      try {
        const entries = await engine.getSignatureEntries();
        if (!this.destroyed && entries.length > 0) this.setEntries(entries);
      } catch {
        // 读取失败由核心的 warning 通道报告；这里保持空列表，不阻断阅读。
      }
      return this.entries;
    })().finally(() => {
      this.entriesPromise = null;
    });
    return this.entriesPromise;
  }

  /** 查找签章条目；不存在时抛明确错误。 */
  private async findEntry(id: string): Promise<SignatureEntryInfo> {
    const entries = await this.ensureEntries();
    const entry = entries.find((item) => item.id === id);
    if (entry) return entry;
    if (!this.viewer.getDocument()) {
      throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开，无法读取签章信息');
    }
    throw new OFDViewerError('OFD_INVALID_OPTION', `未找到签章：${id}`);
  }

  /** 读取当前报告中该签名的验证结果；验证功能不可用时强制视为未验证。 */
  private findVerification(id: string): SignatureVerification | undefined {
    if (!this.viewer.isFeatureEnabled('verification')) return undefined;
    return this.viewer.getVerificationReport()?.signatures.find((item) => item.id === id);
  }

  /** 读取并解析详情。 */
  private async loadDetail(id: string): Promise<SignatureDetail> {
    const entry = await this.findEntry(id);
    const warnings: ViewerWarning[] = [];
    let seal: SealInfo | undefined;
    let signer: SignerInfo | undefined;

    if (!entry.hasSignedValue) {
      warnings.push({
        code: 'W_SIGNATURE_RESOURCE',
        message: '缺少签名值文件（SignedValue.dat），签章信息不完整',
      });
    } else {
      const engine = this.viewer.getDocument();
      if (!engine) throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开');
      let file: SignedValueFile | undefined;
      try {
        file = await engine.getSignedValue(entry.id);
      } catch (error) {
        warnings.push({
          code: 'W_SIGNATURE_RESOURCE',
          message: `签名值文件读取失败：${errorText(error)}`,
        });
      }
      if (file) {
        try {
          const parsed = parseSignedValue(file.data);
          seal = toSealInfo(parsed.seal);
          signer = toSignerInfo(parsed, entry.signatureDateTime);
          if (parsed.timestamp.status === 'parse-error') {
            warnings.push({
              code: 'W_SIGNATURE_TIMESTAMP',
              message: `时间戳解析失败：${parsed.timestamp.parseError?.message ?? '结构非法'}`,
            });
          }
        } catch (error) {
          warnings.push({
            code: 'W_SIGNATURE_ASN1',
            message: `签章信息不完整：无法解析签名值文件（${errorText(error)}）`,
          });
        }
      } else if (!warnings.some((warning) => warning.code === 'W_SIGNATURE_RESOURCE')) {
        warnings.push({
          code: 'W_SIGNATURE_RESOURCE',
          message: '缺少签名值文件（SignedValue.dat），签章信息不完整',
        });
      }
    }

    if (!signer?.signedAt && entry.signatureDateTime) {
      signer = {
        ...(signer ?? {}),
        signedAt: entry.signatureDateTime,
        signedAtSource: 'signatureDateTime',
      };
    }

    const verification = this.findVerification(id);
    const detail: SignatureDetail = {
      entry,
      ...(seal ? { seal } : {}),
      ...(signer ? { signer } : {}),
      validation: NOT_VERIFIED,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(verification ? { verification } : {}),
    };
    this.details.set(id, detail);
    return detail;
  }

  /**
   * 同步验证状态：删除/刷新 details 中的 verification，更新覆盖层与侧栏，
   * 并重渲染仍打开的签章详情。
   */
  private reconcileVerification(): void {
    if (this.destroyed) return;
    const report = this.viewer.isFeatureEnabled('verification')
      ? this.viewer.getVerificationReport()
      : undefined;
    for (const [id, detail] of this.details) {
      const verification = report?.signatures.find((item) => item.id === id);
      this.details.set(id, verification ? { ...detail, verification } : omitVerification(detail));
    }
    this.updateOverlayTitles();
    this.renderPanel();
    if (!this.openDetailId) return;
    if (!this.isDetailDialogOpen()) {
      this.openDetailId = null;
      return;
    }
    const detail = this.details.get(this.openDetailId);
    if (detail) this.openDialog(this.buildDetailContent(detail), false, detail);
  }

  /** 当前是否仍有签章详情对话框（内置或回退）处于打开状态。 */
  private isDetailDialogOpen(): boolean {
    if (this.fallbackDialog) return true;
    return getUIShell(this.viewer)?.dialogs.currentName === 'signatureDetail';
  }

  // -------------------------------------------------------------------------
  // 页面覆盖层
  // -------------------------------------------------------------------------

  /** 同步覆盖层：页面/缩放/旋转变化时更新位置。 */
  private syncOverlays(): void {
    if (this.destroyed) return;
    if (!this.viewer.isFeatureEnabled('signatures')) {
      this.clearOverlays();
      return;
    }
    const pages = this.viewer.getPageViews();
    const scale = this.viewer.getScale();
    const rotation = this.viewer.getRotation();
    const pagesChanged = pages !== this.pageViews;
    const geometryChanged = scale !== this.lastScale || rotation !== this.lastRotation;
    if (pagesChanged) {
      this.clearOverlays();
      this.pageViews = pages;
      this.overlayDirty = true;
    }
    if (pagesChanged || this.overlayDirty) this.rebuildOverlays();
    else if (geometryChanged) this.updateOverlayGeometry();
    this.lastScale = scale;
    this.lastRotation = rotation;
  }

  /** 重建全部覆盖层；只为存在戳记的页创建 DOM。 */
  private rebuildOverlays(): void {
    for (const record of this.overlays) record.element.remove();
    this.overlays = [];
    for (const entry of this.entries) {
      for (const stamp of entry.stamps) {
        if (stamp.pageIndex === undefined) continue;
        const pageNumber = stamp.pageIndex + 1;
        const pageView = this.viewer.getPageView(pageNumber);
        if (!pageView) continue;
        const record = this.createOverlay(entry, stamp, pageNumber);
        pageView.signatureLayer.appendChild(record.element);
        this.applyOverlayGeometry(record);
        this.overlays.push(record);
      }
    }
    this.overlayDirty = false;
    this.updateOverlayTitles();
  }

  /** 创建单个覆盖层按钮。 */
  private createOverlay(
    entry: SignatureEntryInfo,
    stamp: SignatureStampInfo,
    pageNumber: number,
  ): OverlayRecord {
    const element = this.doc.createElement('button');
    element.type = 'button';
    element.className = 'ofd-signature-box';
    element.dataset.signatureId = entry.id;
    element.dataset.pageNumber = String(pageNumber);
    if (stamp.id) element.dataset.stampId = stamp.id;
    element.title = `${this.overlayLabel(entry.id, pageNumber)}（未验证）`;
    element.setAttribute('aria-label', `${this.overlayLabel(entry.id, pageNumber)}（未验证）`);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.activateOverlay(entry.id, element).catch(() => undefined);
    });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      void this.activateOverlay(entry.id, element).catch(() => undefined);
    });
    return {
      element,
      signatureId: entry.id,
      pageNumber,
      boundary: stamp.boundary,
      ...(stamp.clip ? { clip: stamp.clip } : {}),
    };
  }

  /** 按当前缩放/旋转把 mm 换算为 CSS px 并应用裁剪。 */
  private applyOverlayGeometry(record: OverlayRecord): void {
    const scale = this.viewer.getScale();
    const pxPerMm = MM_TO_CSS_PX * scale;
    const { boundary } = record;
    const width = Math.max(0, boundary.w);
    const height = Math.max(0, boundary.h);
    Object.assign(record.element.style, {
      left: `${boundary.x * pxPerMm}px`,
      top: `${boundary.y * pxPerMm}px`,
      width: `${width * pxPerMm}px`,
      height: `${height * pxPerMm}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    const insets = clipInsets(boundary, record.clip);
    if (insets) {
      record.element.style.clipPath = `inset(${formatPercent(insets.top)} ${formatPercent(
        insets.right,
      )} ${formatPercent(insets.bottom)} ${formatPercent(insets.left)})`;
      record.element.dataset.clip = 'true';
    } else {
      record.element.style.removeProperty('clip-path');
      delete record.element.dataset.clip;
    }
    record.element.dataset.scale = String(scale);
  }

  /** 缩放/旋转变化时只更新位置，不重建 DOM。 */
  private updateOverlayGeometry(): void {
    for (const record of this.overlays) this.applyOverlayGeometry(record);
  }

  /** 更新覆盖层 tooltip；详情/验证结果变化后调用。 */
  private updateOverlayTitles(): void {
    for (const record of this.overlays) {
      const label = `${this.overlayLabel(record.signatureId, record.pageNumber)}（${this.overlayStatus(record.signatureId)}）`;
      record.element.title = label;
      record.element.setAttribute('aria-label', label);
      record.element.setAttribute('aria-expanded', 'false');
    }
  }

  /** 覆盖层可读名称：印章名 + 签名者 + 页码。 */
  private overlayLabel(id: string, pageNumber: number): string {
    const detail = this.details.get(id);
    const name = detail?.seal?.name ?? id;
    const signer = subjectCN(detail?.signer?.certificate?.subject);
    return `签章：${name}${signer ? `，签名者：${signer}` : ''}，第 ${pageNumber} 页`;
  }

  /** 覆盖层状态文案；无报告时固定“未验证”。 */
  private overlayStatus(id: string): string {
    const status = this.findVerification(id)?.status;
    if (status === 'valid') return '验证有效';
    if (status === 'invalid') return '验证无效';
    if (status === 'unknown') return '验证未知';
    if (status === 'unsupported') return '不支持验证';
    return '未验证';
  }

  /**
   * 激活覆盖层：优先验证并打开浮层；验证能力不可用时回退详情。
   *
   * @param id 签名 ID。
   * @param anchor 覆盖层按钮。
   */
  private async activateOverlay(id: string, anchor: HTMLButtonElement): Promise<void> {
    this.highlight(id);
    if (this.viewer.isFeatureEnabled('verification')) {
      try {
        let report = this.viewer.getVerificationReport();
        let signature = report?.signatures.find((item) => item.id === id);
        if (!signature) {
          report = await this.viewer.verify({ signatureIds: [id] });
          signature = report.signatures.find((item) => item.id === id);
          // 验证期间宿主可能关闭 verification 或触发新的验证；等待恢复后
          // 必须复核功能状态与当前报告，不能使用过期的本地 report 打开浮层。
          if (
            !this.viewer.isFeatureEnabled('verification') ||
            this.viewer.getVerificationReport() !== report
          ) {
            await this.showSignature(id);
            return;
          }
        }
        const container = anchor.parentElement;
        if (signature && container) {
          openSignaturePopover({
            document: this.doc,
            anchor,
            container,
            signature,
            text: createCryptoText(this.viewer.getState().ui.locale),
            onOpenPanel: () => this.viewer.openVerificationPanel(),
          });
          return;
        }
      } catch {
        // 验证能力不可用或入口失败时回退原有详情面板。
      }
    }
    await this.showSignature(id);
  }

  /** 高亮指定签章的全部覆盖层。 */
  private highlight(id: string): void {
    this.highlightedId = id;
    for (const record of this.overlays) {
      if (record.signatureId === id) {
        record.element.dataset.selected = 'true';
        record.element.style.outline = '2px solid var(--ofd-accent, #0b66d0)';
        record.element.style.outlineOffset = '1px';
      } else {
        delete record.element.dataset.selected;
        record.element.style.removeProperty('outline');
        record.element.style.removeProperty('outline-offset');
      }
    }
  }

  /** 移除全部覆盖层 DOM。 */
  private clearOverlays(): void {
    for (const record of this.overlays) record.element.remove();
    this.overlays = [];
    this.pageViews = [];
    this.overlayDirty = true;
    this.highlightedId = null;
  }

  // -------------------------------------------------------------------------
  // 侧栏列表
  // -------------------------------------------------------------------------

  /** 注册签章侧栏面板；UI 外壳可能晚于本扩展创建，因此每次同步都尝试。 */
  private ensurePanel(): void {
    if (this.panelMounted || this.destroyed) return;
    const shell = getUIShell(this.viewer);
    if (!shell) return;
    this.panelMounted = true;
    shell.registerSidebarPanel('signatures', (host) => {
      this.panelHost = host;
      this.renderPanel();
      return () => {
        if (this.panelHost === host) this.panelHost = null;
        host.replaceChildren();
      };
    });
  }

  /** 渲染签章列表；按页分组并显示“未验证”徽标。 */
  private renderPanel(): void {
    const host = this.panelHost;
    if (!host || this.destroyed) return;
    host.replaceChildren();
    this.summaryRefs.clear();

    if (!this.viewer.isFeatureEnabled('signatures')) return;

    if (this.entries.length === 0) {
      const empty = this.doc.createElement('p');
      empty.className = 'ofd-sidebar__empty';
      empty.textContent = this.viewer.getState().document.status === 'ready'
        ? '本文档未发现签章'
        : '正在读取签章…';
      host.appendChild(empty);
      if (!this.entriesAttempted) void this.ensureEntries();
      return;
    }

    for (const group of groupEntries(this.entries)) {
      const heading = this.doc.createElement('h3');
      heading.className = 'ofd-signature-group-title';
      heading.textContent = group.pageNumber !== undefined
        ? `第 ${group.pageNumber} 页`
        : group.pageId
          ? `页面 ${group.pageId}（未定位）`
          : '未定位页面';
      Object.assign(heading.style, {
        margin: '10px 0 6px',
        fontSize: '12px',
        fontWeight: '600',
      } satisfies Partial<CSSStyleDeclaration>);
      host.appendChild(heading);
      for (const item of group.items) host.appendChild(this.createSummaryItem(item));
    }
  }

  /** 创建单个签章列表项。 */
  private createSummaryItem(item: SummaryItem): HTMLElement {
    const { entry } = item;
    const detail = this.details.get(entry.id);
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'ofd-signature-summary-item';
    button.dataset.signatureId = entry.id;
    if (item.pageNumber !== undefined) {
      button.dataset.pageNumber = String(item.pageNumber);
    }
    button.addEventListener('click', () => {
      void this.showSignature(entry.id).catch(() => undefined);
    });

    const title = this.doc.createElement('div');
    Object.assign(title.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      marginBottom: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    const icon = this.doc.createElement('span');
    icon.textContent = isSignType(entry.type) ? '✎' : '▣';
    icon.setAttribute('aria-hidden', 'true');
    const name = this.doc.createElement('span');
    name.textContent = detail?.seal?.name ?? '未命名签章';
    Object.assign(name.style, {
      flex: '1 1 auto',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontWeight: '600',
    } satisfies Partial<CSSStyleDeclaration>);
    const badge = this.doc.createElement('span');
    badge.className = 'ofd-signature-badge';
    const status = this.findVerification(entry.id)?.status;
    badge.textContent = status ? verificationLabel(status) : '未验证';
    if (status) badge.dataset.status = status;
    title.append(icon, name, badge);

    const meta = this.doc.createElement('div');
    Object.assign(meta.style, {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px 8px',
      fontSize: '12px',
      color: 'var(--ofd-text-secondary)',
    } satisfies Partial<CSSStyleDeclaration>);
    const type = this.doc.createElement('span');
    type.textContent = signatureTypeLabel(entry.type);
    const time = this.doc.createElement('span');
    time.textContent = signatureTimeText(detail, entry);
    const signer = this.doc.createElement('span');
    signer.textContent = signerText(detail);
    meta.append(type, time, signer);
    if (item.pageNumber !== undefined) {
      const page = this.doc.createElement('span');
      page.textContent = `第 ${item.pageNumber} 页`;
      meta.appendChild(page);
    }

    button.append(title, meta);
    const refs = this.summaryRefs.get(entry.id) ?? [];
    refs.push({ name, time, signer });
    this.summaryRefs.set(entry.id, refs);
    return button;
  }

  /** 按需解析列表项详情；只在签章面板已挂载时触发。 */
  private async hydrate(): Promise<void> {
    if (this.hydrating || this.hydrated || this.destroyed) return;
    this.hydrating = true;
    try {
      const entries = await this.ensureEntries();
      const unique = new Map(entries.map((entry) => [entry.id, entry]));
      for (const entry of unique.values()) {
        if (this.destroyed) return;
        if (!entry.hasSignedValue) continue;
        try {
          await this.getSignatureDetail(entry.id);
          this.updateSummaryRefs(entry.id);
        } catch {
          // 单个签章失败不影响其他条目。
        }
      }
      this.hydrated = true;
      this.updateOverlayTitles();
    } finally {
      this.hydrating = false;
    }
  }

  /** 详情就绪后原位更新列表文本。 */
  private updateSummaryRefs(id: string): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    const detail = this.details.get(id);
    for (const refs of this.summaryRefs.get(id) ?? []) {
      refs.name.textContent = detail?.seal?.name ?? '未命名签章';
      refs.time.textContent = signatureTimeText(detail, entry);
      refs.signer.textContent = signerText(detail);
    }
  }

  // -------------------------------------------------------------------------
  // 详情面板
  // -------------------------------------------------------------------------

  /** 打开详情：先显示加载态，再按解析结果替换内容。 */
  private async openDetail(id: string): Promise<void> {
    this.detailToken += 1;
    const token = this.detailToken;
    this.openDialog(this.buildLoading(), true);
    try {
      const detail = await this.getSignatureDetail(id);
      if (this.destroyed || token !== this.detailToken) return;
      this.openDetailId = id;
      this.openDialog(this.buildDetailContent(detail), false, detail);
      this.updateSummaryRefs(id);
      this.updateOverlayTitles();
    } catch (error) {
      if (this.destroyed || token !== this.detailToken) return;
      this.openDetailId = null;
      this.openDialog(this.buildError(error));
    }
  }

  /** 打开对话框；优先复用内置 UI 外壳，独立使用时回退到简单对话框。 */
  private openDialog(content: Node, loading = false, detail?: SignatureDetail): void {
    const title = detailTitle(detail);
    const shell = getUIShell(this.viewer);
    if (shell) {
      this.closeFallbackDialog();
      shell.openDialog({
        name: 'signatureDetail',
        title,
        content,
        dismissible: !loading,
        actions: loading ? [] : [{ label: '关闭', primary: true }],
      });
      return;
    }
    this.openFallbackDialog(content, loading, title);
  }

  /** 关闭任意详情对话框。 */
  private closeAnyDialog(): void {
    this.openDetailId = null;
    this.closeFallbackDialog();
    getUIShell(this.viewer)?.closeDialog(false);
  }

  /** 回退对话框：不依赖 UI 外壳，仍保留遮罩、Esc 关闭与焦点。 */
  private openFallbackDialog(content: Node, loading = false, title = '签章信息（未验证）'): void {
    this.closeFallbackDialog();
    const layer = this.viewer.getElements().dialogLayer;
    const backdrop = this.doc.createElement('div');
    backdrop.className = 'ofd-dialog__backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    const dialog = this.doc.createElement('div');
    dialog.className = 'ofd-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);
    dialog.tabIndex = -1;

    const header = this.doc.createElement('div');
    header.className = 'ofd-dialog__header';
    const heading = this.doc.createElement('h2');
    heading.className = 'ofd-dialog__title';
    heading.textContent = title;
    header.appendChild(heading);
    const close = loading ? null : this.doc.createElement('button');
    if (close) {
      close.type = 'button';
      close.className = 'ofd-button ofd-dialog__close';
      close.setAttribute('aria-label', '关闭');
      close.textContent = '×';
      header.appendChild(close);
    }

    const body = this.doc.createElement('div');
    body.className = 'ofd-dialog__body';
    body.appendChild(content);

    const footer = this.doc.createElement('div');
    footer.className = 'ofd-dialog__footer';
    const action = loading ? null : this.doc.createElement('button');
    if (action) {
      action.type = 'button';
      action.className = 'ofd-button ofd-dialog__action ofd-dialog__action--primary';
      action.textContent = '关闭';
      footer.appendChild(action);
    }

    dialog.append(header, body);
    if (action) dialog.appendChild(footer);
    layer.replaceChildren(backdrop, dialog);
    layer.hidden = false;
    this.fallbackDialog = dialog;
    this.fallbackBackdrop = backdrop;

    const closeDialog = (): void => this.closeFallbackDialog();
    if (!loading) {
      backdrop.addEventListener('click', closeDialog);
    }
    close?.addEventListener('click', closeDialog);
    action?.addEventListener('click', closeDialog);
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !loading) {
        event.preventDefault();
        closeDialog();
      }
    };
    dialog.addEventListener('keydown', onKeydown);
    this.fallbackDialogCleanup = () => {
      backdrop.removeEventListener('click', closeDialog);
      close?.removeEventListener('click', closeDialog);
      action?.removeEventListener('click', closeDialog);
      dialog.removeEventListener('keydown', onKeydown);
    };
    dialog.focus();
  }

  /** 关闭回退对话框并清理监听。 */
  private closeFallbackDialog(): void {
    this.fallbackDialogCleanup?.();
    this.fallbackDialogCleanup = null;
    this.fallbackDialog?.remove();
    this.fallbackDialog = null;
    this.fallbackBackdrop?.remove();
    this.fallbackBackdrop = null;
    const layer = this.viewer.getElements().dialogLayer;
    if (layer && layer.childElementCount === 0) layer.hidden = true;
  }

  /** 加载态内容。 */
  private buildLoading(): HTMLElement {
    const root = this.createContentRoot();
    const text = this.doc.createElement('p');
    text.textContent = '正在解析签章信息…';
    root.appendChild(text);
    return root;
  }

  /** 解析失败兜底内容。 */
  private buildError(error: unknown): HTMLElement {
    const root = this.createContentRoot();
    const heading = this.doc.createElement('p');
    heading.textContent = '签章信息不完整';
    heading.style.fontWeight = '600';
    const text = this.doc.createElement('p');
    text.textContent = errorText(error);
    const note = this.doc.createElement('p');
    note.textContent = SIGNATURE_NOT_VERIFIED_NOTE;
    root.append(heading, text, note);
    return root;
  }

  /** 构造详情面板内容。 */
  private buildDetailContent(detail: SignatureDetail): HTMLElement {
    const root = this.createContentRoot();
    const status = this.doc.createElement('div');
    Object.assign(status.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '10px',
    } satisfies Partial<CSSStyleDeclaration>);
    const badge = this.doc.createElement('span');
    badge.className = 'ofd-signature-badge';
    const verification = detail.verification;
    badge.textContent = verification ? verificationLabel(verification.status) : '未验证';
    if (verification) badge.dataset.status = verification.status;
    const statusText = this.doc.createElement('span');
    statusText.textContent = verification
      ? verificationNote(verification.status)
      : detail.validation.note;
    Object.assign(statusText.style, {
      fontSize: '12px',
      color: 'var(--ofd-text-secondary)',
    } satisfies Partial<CSSStyleDeclaration>);
    status.append(badge, statusText);
    root.appendChild(status);

    if (detail.warnings && detail.warnings.length > 0) {
      const warningBox = this.doc.createElement('div');
      warningBox.className = 'ofd-signature-detail__warnings';
      Object.assign(warningBox.style, {
        marginBottom: '10px',
        padding: '8px',
        border: '1px solid var(--ofd-warning, #b26a00)',
        borderRadius: '4px',
      } satisfies Partial<CSSStyleDeclaration>);
      const heading = this.doc.createElement('p');
      heading.textContent = '签章信息不完整';
      heading.style.fontWeight = '600';
      warningBox.appendChild(heading);
      for (const warning of detail.warnings) {
        const line = this.doc.createElement('p');
        line.textContent = `${warning.code}：${warning.message}`;
        line.style.fontSize = '12px';
        warningBox.appendChild(line);
      }
      root.appendChild(warningBox);
    }

    const { entry, seal, signer } = detail;
    root.appendChild(
      this.createSection('基本信息', [
        ['签章类型', signatureTypeLabel(entry.type)],
        ['签章 ID', entry.id],
        ['签章时间', signatureTimeText(detail, entry)],
        ['签章提供者', providerText(entry)],
        ['保护范围', entry.references.map((reference) => reference.fileRef).join('、')],
      ]),
    );

    root.appendChild(
      this.createSection(
        '印章信息',
        seal ? sealRows(seal) : [['印章信息', '未获取到印章信息']],
      ),
    );

    root.appendChild(
      this.createSection(
        '签章者',
        signer
          ? signerRows(signer, detail.verification?.timestamp.status)
          : [['签章者信息', '未获取到签章者信息']],
      ),
    );

    root.appendChild(this.createPositions(entry));
    root.appendChild(this.createTechnical(detail));
    return root;
  }

  /** 创建详情内容根节点。 */
  private createContentRoot(): HTMLElement {
    const root = this.doc.createElement('div');
    root.className = 'ofd-signature-detail';
    Object.assign(root.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    } satisfies Partial<CSSStyleDeclaration>);
    return root;
  }

  /** 创建“标题 + 键值表”区块。 */
  private createSection(
    title: string | undefined,
    rows: ReadonlyArray<readonly [string, string | undefined]>,
  ): HTMLElement {
    const section = this.doc.createElement('section');
    if (title) {
      const heading = this.doc.createElement('h3');
      heading.textContent = title;
      Object.assign(heading.style, {
        margin: '0 0 6px',
        fontSize: '14px',
      } satisfies Partial<CSSStyleDeclaration>);
      section.appendChild(heading);
    }
    const list = this.doc.createElement('dl');
    Object.assign(list.style, {
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      gap: '4px 10px',
      margin: '0',
      fontSize: '13px',
    } satisfies Partial<CSSStyleDeclaration>);
    for (const [label, value] of rows) {
      if (value === undefined || value === '') continue;
      const term = this.doc.createElement('dt');
      term.textContent = label;
      term.style.color = 'var(--ofd-text-secondary)';
      const description = this.doc.createElement('dd');
      description.textContent = value;
      description.style.margin = '0';
      description.style.wordBreak = 'break-all';
      list.append(term, description);
    }
    section.appendChild(list);
    return section;
  }

  /** 页面位置区块。 */
  private createPositions(entry: SignatureEntryInfo): HTMLElement {
    const section = this.doc.createElement('section');
    const heading = this.doc.createElement('h3');
    heading.textContent = '页面位置';
    Object.assign(heading.style, { margin: '0 0 6px', fontSize: '14px' } satisfies Partial<CSSStyleDeclaration>);
    section.appendChild(heading);
    if (entry.stamps.length === 0) {
      const empty = this.doc.createElement('p');
      empty.textContent = '未记录页面戳记';
      empty.style.margin = '0';
      empty.style.fontSize = '13px';
      section.appendChild(empty);
      return section;
    }
    for (const stamp of entry.stamps) {
      const line = this.doc.createElement('p');
      Object.assign(line.style, {
        margin: '0 0 4px',
        fontSize: '13px',
        wordBreak: 'break-all',
      } satisfies Partial<CSSStyleDeclaration>);
      const page = stamp.pageIndex !== undefined
        ? `第 ${stamp.pageIndex + 1} 页`
        : `页 ID ${stamp.pageId}（未匹配）`;
      const boundary = boxText(stamp.boundary);
      const clip = stamp.clip ? `；Clip：${boxText(stamp.clip)}` : '';
      line.textContent = `${page}；Boundary：${boundary} mm${clip}`;
      section.appendChild(line);
    }
    return section;
  }

  /** 技术细节（折叠）。 */
  private createTechnical(detail: SignatureDetail): HTMLElement {
    const details = this.doc.createElement('details');
    const summary = this.doc.createElement('summary');
    summary.textContent = '技术细节';
    Object.assign(summary.style, {
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: '600',
    } satisfies Partial<CSSStyleDeclaration>);
    const rows: Array<readonly [string, string | undefined]> = [
      ['ASN.1 版本', detail.seal?.version],
      ['签章时间来源', detail.signer?.signedAtSource],
      ['签名算法 OID', detail.signer?.algorithm?.oid],
      ['公钥算法 OID', detail.signer?.certificate?.publicKeyAlgorithm?.oid],
      ['dataHash', detail.signer?.dataHash],
      ['propertyInfo', detail.signer?.propertyInfo],
      ['warning', detail.warnings?.map((warning) => warning.code).join('、')],
    ];
    details.append(summary, this.createSection(undefined, rows));
    return details;
  }
}

// ---------------------------------------------------------------------------
// 文案与格式化
// ---------------------------------------------------------------------------

/** 复制详情并移除验证字段；不修改缓存对象。 */
function omitVerification(detail: SignatureDetail): SignatureDetail {
  const next = { ...detail };
  delete next.verification;
  return next;
}

/** 是否为签名类型。 */
function isSignType(type: string): boolean {
  return type.trim().toLowerCase() === 'sign';
}

/** 签章类型文案。 */
function signatureTypeLabel(type: string): string {
  const normalized = type.trim();
  if (normalized.toLowerCase() === 'seal') return '盖章';
  if (normalized.toLowerCase() === 'sign') return '签名';
  return normalized || '签章';
}

/** 列表/详情中的签章时间。 */
function signatureTimeText(
  detail: SignatureDetail | undefined,
  entry: SignatureEntryInfo,
): string {
  return detail?.signer?.signedAt ?? entry.signatureDateTime ?? '时间未知';
}

/** 签章者 CN；无证书时给出明确提示。 */
function signerText(detail: SignatureDetail | undefined): string {
  const certificate = detail?.signer?.certificate;
  if (!certificate) return '签章者未知';
  return certificate.subjectAttributes?.cn ?? (certificate.subject || '签章者未知');
}

/** 证书 CN 优先的签章者文案。 */
function certificateSignerText(certificate: CertificateInfo): string {
  return certificate.subjectAttributes?.cn ?? (certificate.subject || '签章者未知');
}

/** 提供者文案。 */
function providerText(entry: SignatureEntryInfo): string | undefined {
  const provider = entry.provider;
  if (!provider) return undefined;
  const text = [provider.name, provider.company, provider.version]
    .filter((value): value is string => !!value)
    .join(' / ');
  return text || undefined;
}

/** 印章信息行。 */
function sealRows(seal: SealInfo): ReadonlyArray<readonly [string, string]> {
  return [
    ['印章名称', seal.name ?? '未命名签章'],
    [
      '印章类型',
      seal.typeCode === undefined
        ? seal.typeLabel ?? '未知'
        : `${seal.typeLabel ?? '未知'}（type=${seal.typeCode}）`,
    ],
    ['印章编码', seal.esId ?? '未知'],
    ['制章日期', seal.createDate ?? '未知'],
    [
      '印章有效期',
      `${seal.validStart ?? '未知'} 至 ${seal.validEnd ?? '未知'}`,
    ],
    ['印章属性证书', seal.certificate ? certificateBrief(seal.certificate) : '无'],
    [
      '印章图片',
      seal.image
        ? `${seal.image.format}，${seal.image.widthMm} × ${seal.image.heightMm} mm`
        : '未提供',
    ],
  ];
}

/** 详情标题：有验证结果时展示状态。 */
function detailTitle(detail?: SignatureDetail): string {
  const status = detail?.verification?.status;
  return status ? `签章信息（${verificationLabel(status)}）` : '签章信息（未验证）';
}

/** 验证状态中文文案。 */
function verificationLabel(status: SignatureVerification['status']): string {
  switch (status) {
    case 'valid':
      return '验证有效';
    case 'invalid':
      return '验证无效';
    case 'unknown':
      return '验证未知';
    case 'unsupported':
      return '不支持验证';
    case 'not-applicable':
      return '不适用验证';
    default:
      return '未验证';
  }
}

/** 验证状态说明。 */
function verificationNote(status: SignatureVerification['status']): string {
  switch (status) {
    case 'valid':
      return '签名、引用完整性、证书链与印章校验通过。';
    case 'invalid':
      return '存在校验失败项，详见工具栏验证面板。';
    case 'unknown':
      return '未配置信任根或无法确认证书链，详见工具栏验证面板。';
    case 'unsupported':
      return '当前环境不支持签名验证。';
    default:
      return '未执行签名验证。';
  }
}

/** 签章者信息行。 */
function signerRows(
  signer: SignerInfo,
  timestampStatus?: SignatureVerification['timestamp']['status'],
): ReadonlyArray<readonly [string, string]> {
  const certificate = signer.certificate;
  return [
    ['签章者', certificate ? certificateSignerText(certificate) : '未找到签章者证书'],
    ['证书主题', certificate?.subject ?? '未找到或无法解析'],
    ['颁发者', certificate?.issuer ?? '未找到或无法解析'],
    ['序列号', certificate?.serialNumber ?? '未找到或无法解析'],
    [
      '证书有效期',
      certificate
        ? `${certificate.notBefore ?? '未知'} 至 ${certificate.notAfter ?? '未知'}（仅展示）`
        : '未知',
    ],
    ['签名算法', signer.algorithm ? algorithmText(signer.algorithm) : '未知'],
    [
      '公钥算法',
      certificate?.publicKeyAlgorithm
        ? algorithmText(certificate.publicKeyAlgorithm)
        : '未知',
    ],
    [
      '时间戳',
      timestampStatus === 'parsed-not-verified'
        ? '已解析，未验证'
        : signer.timestampPresent
          ? '含时间戳（未解析、未验证）'
          : '未包含',
    ],
  ];
}

/** 证书摘要。 */
function certificateBrief(certificate: CertificateInfo): string {
  const cn = certificate.subjectAttributes?.cn;
  return cn ? `${cn}（${certificate.subject}）` : certificate.subject || '无法解析';
}

/** 算法文案。 */
function algorithmText(algorithm: { readonly oid: string; readonly name?: string }): string {
  return algorithm.name ? `${algorithm.name}（${algorithm.oid}）` : algorithm.oid;
}

/** Box 格式化，单位 mm。 */
function boxText(box: Box): string {
  return `x=${round2(box.x)}, y=${round2(box.y)}, w=${round2(box.w)}, h=${round2(box.h)}`;
}

/** 保留两位小数。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// 列表分组与几何
// ---------------------------------------------------------------------------

/**
 * 按页分组：每个 `StampAnnot` 一项；无戳记的签章归入“未定位页面”。
 *
 * @param entries 签章摘要。
 * @returns 按页码升序的组。
 */
export function groupEntries(entries: readonly SignatureEntryInfo[]): readonly SummaryGroup[] {
  const groups = new Map<string, { pageNumber?: number; pageId?: string; items: SummaryItem[] }>();
  for (const entry of entries) {
    if (entry.stamps.length === 0) {
      const key = 'unknown';
      const group = groups.get(key) ?? { items: [] };
      group.items.push({ entry });
      groups.set(key, group);
      continue;
    }
    for (const stamp of entry.stamps) {
      const pageNumber = stamp.pageIndex !== undefined ? stamp.pageIndex + 1 : undefined;
      const key = pageNumber !== undefined ? `page:${pageNumber}` : `id:${stamp.pageId}`;
      const group = groups.get(key) ?? {
        ...(pageNumber !== undefined ? { pageNumber } : {}),
        ...(pageNumber === undefined ? { pageId: stamp.pageId } : {}),
        items: [],
      };
      group.items.push({
        entry,
        stamp,
        ...(pageNumber !== undefined ? { pageNumber } : {}),
      });
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      const left = a.pageNumber ?? Number.MAX_SAFE_INTEGER;
      const right = b.pageNumber ?? Number.MAX_SAFE_INTEGER;
      return left - right;
    })
    .map((group) => ({
      ...(group.pageNumber !== undefined ? { pageNumber: group.pageNumber } : {}),
      ...(group.pageId ? { pageId: group.pageId } : {}),
      items: group.items,
    }));
}

/** 裁剪区域相对 Boundary 的百分比内边距；无效时返回 undefined。 */
function clipInsets(
  boundary: Box,
  clip: Box | undefined,
): { top: number; right: number; bottom: number; left: number } | undefined {
  if (!clip) return undefined;
  if (!(boundary.w > 0) || !(boundary.h > 0)) return undefined;
  if (!(clip.w > 0) || !(clip.h > 0)) return undefined;
  const tolerance = 0.001;
  if (
    clip.x < -tolerance ||
    clip.y < -tolerance ||
    clip.x + clip.w > boundary.w + tolerance ||
    clip.y + clip.h > boundary.h + tolerance
  ) {
    return undefined;
  }
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return {
    top: clamp(clip.y / boundary.h),
    left: clamp(clip.x / boundary.w),
    right: clamp(1 - (clip.x + clip.w) / boundary.w),
    bottom: clamp(1 - (clip.y + clip.h) / boundary.h),
  };
}

/** 百分比文本。 */
function formatPercent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}

/** 读取错误信息。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}