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

import { replaceChildren } from '../compat';

import type {
  Box,
  SignatureEntryInfo,
  SignatureStampInfo,
  SignedValueFile,
} from '@ofdrw/ofdrw-viewer-engine';
import { parseSignedValue } from '@ofdrw/ofdrw-viewer-crypto';
import type {
  CertificateChainVerification,
  CertificateSummary,
  SignatureVerification,
  VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import { createFeatureDisabledError, OFDViewerError } from '../errors';
import { MM_TO_CSS_PX } from '../page-layout';
import type { PageView } from '../page-view';
import type { ViewerWarning } from '../state';
import type { CertificateInfo, SealInfo, SignatureDetail, SignerInfo } from '../types';
import { getUIShell } from '../ui';
import { createGlyph } from '../ui/glyphs';
import type { GlyphName } from '../ui/glyphs';
import type { OFDViewer, ViewerSignatureService } from '../viewer';
import { certificateFileName, chainStatusText, createCryptoText, downloadCertificateDer } from '../crypto';
import type { CryptoText } from '../crypto';
import { openSignaturePopover } from '../crypto';
import { createSealImageElement } from '../crypto/seal-image';
import type { SealImageHandle } from '../crypto/seal-image';
import { formatShanghaiDateTime, formatSigningTime } from '../crypto/time';
import { VERIFICATION_RESET_EVENT } from '../crypto/service';
import { subjectCN, toSealInfo, toSignerInfo } from './mapping';
import { UI_WARNING_CODES } from '../diagnostics';

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
  private fallbackSealId: string | null = null;
  private fallbackSealHandle: SealImageHandle | null = null;
  private detailToken = 0;
  private openDetailId: string | null = null;
  /** 正在用新内容替换已打开的详情对话框；避免旧对话框的 onClose 清掉新状态。 */
  private replacingDetailDialog = false;
  /** 签章详情中的印章图片句柄；按签名 ID 释放 Blob URL。 */
  private readonly sealImageHandles = new Map<string, SealImageHandle>();
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
    await this.findEntry(id);
    this.scrollToSignature(id);
    this.highlight(id);
    await this.openDetail(id);
  }

  /**
   * 平滑滚动主区域到签章覆盖层。
   *
   * 只发一次滚动：页顶与页内偏移由 `goToPage` 的 `offsetPx` 合并成同一次补间，
   * 避免「先到页顶、再对齐覆盖层」两段动画互相打断。戳记只在单页时把覆盖层对齐
   * 到视口中心；跨页签章分处不同页，不强行对齐，只落到离当前位置最近的戳记页。
   *
   * @param id 签章 ID。
   * @returns 是否由本方法接管了滚动。
   */
  scrollToSignature(id: string): boolean {
    if (this.destroyed) return false;
    if (!this.viewer.isFeatureEnabled('pageNavigation')) return false;
    this.syncOverlays();
    const stamps = this.overlays.filter((record) => record.signatureId === id);
    if (stamps.length === 0) return false;
    const current = this.viewer.getPageNumber();
    const primary =
      stamps.find((record) => record.pageNumber === current) ??
      stamps.reduce((best, record) =>
        Math.abs(record.pageNumber - current) < Math.abs(best.pageNumber - current) ? record : best,
      );
    const single = stamps.length === 1;
    // 已在目标页且覆盖层就在视口内时不滚动，避免原地小幅跳动。
    if (primary.pageNumber === current && single && this.isOverlayVisible(primary.element)) {
      return false;
    }
    const offsetPx = single ? this.overlayCenterOffset(primary) : 0;
    this.viewer.goToPage(primary.pageNumber, { smooth: true, offsetPx });
    return true;
  }

  /**
   * 计算覆盖层对齐到视口中心所需的页内偏移。
   *
   * @param overlay 覆盖层记录。
   * @returns 页内偏移，单位 px；正数表示向下滚动。
   */
  private overlayCenterOffset(overlay: OverlayRecord): number {
    const pxPerMm = MM_TO_CSS_PX * this.viewer.getScale();
    const boxTop = overlay.boundary.y * pxPerMm;
    const boxHeight = overlay.boundary.h * pxPerMm;
    const viewport = this.viewer.getElements().main.getBoundingClientRect().height;
    return boxTop + boxHeight / 2 - Math.max(0, viewport) / 2;
  }

  /**
   * 判断覆盖层当前是否完整落在主区域视口内。
   *
   * @param element 覆盖层按钮。
   * @returns 是否可见；无布局信息（如离屏环境）时返回 false。
   */
  private isOverlayVisible(element: HTMLElement): boolean {
    if (!element.isConnected) return false;
    const main = this.viewer.getElements().main;
    const viewport = main.getBoundingClientRect();
    if (viewport.height <= 0) return false;
    const box = element.getBoundingClientRect();
    return box.top >= viewport.top && box.bottom <= viewport.bottom;
  }

  /** 销毁服务：移除监听、覆盖层、面板内容与对话框。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.detailToken += 1;
    this.clearOverlays();
    this.closeAnyDialog();
    this.revokeAllSealImages();
    if (this.panelHost) {
      replaceChildren(this.panelHost);
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
    this.revokeAllSealImages();
    this.renderPanel();
  }

  /** 状态变化时的轻量同步：面板、覆盖层与功能门控。 */
  private sync(): void {
    if (this.destroyed) return;
    this.ensurePanel();
    if (!this.viewer.isFeatureEnabled('signatures')) {
      this.clearOverlays();
      this.closeAnyDialog();
      if (this.panelHost) replaceChildren(this.panelHost);
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

  /** 当前验证报告；验证功能关闭时视为没有报告。 */
  private currentReport(): VerificationReport | undefined {
    if (!this.viewer.isFeatureEnabled('verification')) return undefined;
    return this.viewer.getVerificationReport();
  }

  /** 读取当前报告中该签名的验证结果；验证功能不可用时强制视为未验证。 */
  private findVerification(id: string): SignatureVerification | undefined {
    return this.currentReport()?.signatures.find((item) => item.id === id);
  }

  /** 读取并解析详情。 */
  private async loadDetail(id: string): Promise<SignatureDetail> {
    const entry = await this.findEntry(id);
    const warnings: ViewerWarning[] = [];
    let seal: SealInfo | undefined;
    let signer: SignerInfo | undefined;

    if (!entry.hasSignedValue) {
      warnings.push({
        code: UI_WARNING_CODES.W_SIGNATURE_RESOURCE,
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
          code: UI_WARNING_CODES.W_SIGNATURE_RESOURCE,
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
              code: UI_WARNING_CODES.W_SIGNATURE_TIMESTAMP,
              message: `时间戳解析失败：${parsed.timestamp.parseError?.message ?? '结构非法'}`,
            });
          }
        } catch (error) {
          warnings.push({
            code: UI_WARNING_CODES.W_SIGNATURE_ASN1,
            message: `签章信息不完整：无法解析签名值文件（${errorText(error)}）`,
          });
        }
      } else if (!warnings.some((warning) => warning.code === UI_WARNING_CODES.W_SIGNATURE_RESOURCE)) {
        warnings.push({
          code: UI_WARNING_CODES.W_SIGNATURE_RESOURCE,
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
    const report = this.currentReport();
    for (const [id, detail] of this.details) {
      const verification = report?.signatures.find((item) => item.id === id);
      this.details.set(id, verification ? { ...detail, verification } : omitVerification(detail));
    }
    this.updateOverlayTitles();
    const detailId = this.openDetailId;
    const detail = detailId ? this.details.get(detailId) : undefined;
    // 先校验详情是否仍真正打开，再渲染侧栏；否则 renderPanel 会按过期的
    // openDetailId 把已关闭详情对应的卡片重新标记为选中。
    if (detailId && (!this.isDetailDialogOpen() || !detail)) this.openDetailId = null;
    this.renderPanel();
    if (!this.openDetailId || !detail) return;
    this.openDialog(this.buildDetailContent(detail), false, detail);
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
      const status = this.findVerification(record.signatureId)?.status;
      const label = `${this.overlayLabel(record.signatureId, record.pageNumber)}（${this.overlayStatus(record.signatureId)}）`;
      record.element.title = label;
      record.element.setAttribute('aria-label', label);
      record.element.setAttribute('aria-expanded', 'false');
      if (status) record.element.dataset.status = status;
      else delete record.element.dataset.status;
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
   * 打开验证面板；尚无报告时先触发一次验证。
   *
   * 与详情里的“验证结果”一致，都指向同一份报告，避免两处结论不同。
   */
  private readonly openVerificationPanel = (): void => {
    if (this.viewer.getVerificationReport() === undefined) {
      void this.viewer.verify().catch(() => undefined);
    }
    try {
      this.viewer.openVerificationPanel();
    } catch {
      // 验证功能关闭时入口不可用，保持浮层关闭即可。
    }
  };

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
          const detail = await this.getSignatureDetail(id).catch(() => undefined);
          if (this.viewer.getVerificationReport() !== report) {
            await this.showSignature(id);
            return;
          }
          openSignaturePopover({
            document: this.doc,
            anchor,
            container,
            signature,
            text: createCryptoText(this.viewer.getState().ui.locale),
            ...(detail?.seal?.image ? { sealImage: detail.seal.image } : {}),
            ...(detail?.seal
              ? { sealLabel: detail.seal.name ?? detail.seal.esId ?? id }
              : {}),
            onOpenDetails: () => {
              void this.showSignature(id).catch(() => undefined);
            },
            onOpenPanel: this.openVerificationPanel,
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

  /** 同步侧栏卡片的选中态；对话框打开/关闭时调用。 */
  private markSelectedSummary(id: string | null): void {
    const host = this.panelHost;
    if (!host) return;
    for (const item of host.querySelectorAll<HTMLElement>('.ofd-signature-summary-item')) {
      if (item.dataset.signatureId === id) {
        item.dataset.selected = 'true';
        item.setAttribute('aria-current', 'true');
      } else {
        delete item.dataset.selected;
        item.removeAttribute('aria-current');
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
        replaceChildren(host);
      };
    });
  }

  /** 渲染签章列表；按页分组并显示“未验证”徽标。 */
  private renderPanel(): void {
    const host = this.panelHost;
    if (!host || this.destroyed) return;
    replaceChildren(host);
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
    button.setAttribute('aria-haspopup', 'dialog');
    if (item.pageNumber !== undefined) {
      button.dataset.pageNumber = String(item.pageNumber);
    }
    if (this.openDetailId === entry.id) {
      button.dataset.selected = 'true';
      button.setAttribute('aria-current', 'true');
    }
    button.addEventListener('click', () => {
      void this.showSignature(entry.id).catch(() => undefined);
    });

    const title = this.doc.createElement('div');
    title.className = 'ofd-signature-summary-item__title';
    const name = this.doc.createElement('span');
    name.className = 'ofd-signature-summary-item__name';
    name.textContent = detail?.seal?.name ?? '未命名签章';
    // 卡片较窄时会省略，用 title 补充完整名称。
    name.title = name.textContent;
    // 验证状态只用图标表达：颜色区分结果，hover/读屏由 title 给出具体含义。
    const verified = verificationInfo(this.findVerification(entry.id)?.status);
    const badge = this.doc.createElement('span');
    badge.className = 'ofd-signature-status';
    badge.dataset.status = verified.key;
    badge.dataset.ofdControl = 'signature-status-icon';
    badge.title = verified.meaning;
    badge.setAttribute('aria-label', verified.meaning);
    badge.setAttribute('role', 'img');
    badge.appendChild(createGlyph(verified.glyph, this.doc));
    title.append(name, badge);

    const meta = this.doc.createElement('div');
    meta.className = 'ofd-signature-summary-item__meta';
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
    button.setAttribute(
      'aria-label',
      [
        name.textContent,
        signatureTypeLabel(entry.type),
        signatureTimeText(detail, entry),
        signerText(detail),
        item.pageNumber !== undefined ? `第 ${item.pageNumber} 页` : '',
        verified.meaning,
      ]
        .filter((part) => part.length > 0)
        .join('，'),
    );
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
      this.markSelectedSummary(id);
      this.openDialog(this.buildDetailContent(detail), false, detail);
      this.updateSummaryRefs(id);
      this.updateOverlayTitles();
    } catch (error) {
      if (this.destroyed || token !== this.detailToken) return;
      this.dismissDetail();
      this.openDialog(this.buildError(error));
    }
  }

  /** 打开对话框；优先复用内置 UI 外壳，独立使用时回退到简单对话框。 */
  private openDialog(content: Node, loading = false, detail?: SignatureDetail): void {
    const title = detailTitle(detail);
    const detailId = detail?.entry.id;
    const sealHandle = detailId ? this.sealImageHandles.get(detailId) : undefined;
    const shell = getUIShell(this.viewer);
    if (shell) {
      this.closeFallbackDialog();
      this.replacingDetailDialog = true;
      try {
        shell.openDialog({
          name: 'signatureDetail',
          title,
          content,
          dismissible: !loading,
          actions: loading ? [] : [{ label: '关闭', primary: true }],
          onClose: () => {
            // 只释放本次对话框持有的图片；重新渲染已被新句柄替换时不能误释放。
            if (detailId && sealHandle && this.sealImageHandles.get(detailId) === sealHandle) {
              this.revokeSealImage(detailId);
            }
            // 用新内容替换旧详情时，旧对话框的 onClose 不能清掉新状态。
            if (!this.replacingDetailDialog) this.dismissDetail();
          },
        });
      } finally {
        this.replacingDetailDialog = false;
      }
      return;
    }
    this.openFallbackDialog(content, loading, title);
  }

  /** 清除详情打开状态与侧栏选中态。 */
  private dismissDetail(): void {
    this.openDetailId = null;
    this.markSelectedSummary(null);
  }

  /** 关闭任意详情对话框。 */
  private closeAnyDialog(): void {
    this.dismissDetail();
    this.closeFallbackDialog();
    getUIShell(this.viewer)?.closeDialog(false);
  }

  /** 回退对话框：不依赖 UI 外壳，仍保留遮罩、Esc 关闭与焦点。 */
  private openFallbackDialog(content: Node, loading = false, title = '签章信息（未验证）'): void {
    this.closeFallbackDialog();
    this.fallbackSealId = this.openDetailId;
    this.fallbackSealHandle = this.openDetailId
      ? (this.sealImageHandles.get(this.openDetailId) ?? null)
      : null;
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
    replaceChildren(layer, backdrop, dialog);
    layer.hidden = false;
    this.fallbackDialog = dialog;
    this.fallbackBackdrop = backdrop;

    const closeDialog = (): void => {
      this.dismissDetail();
      this.closeFallbackDialog();
    };
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
    const sealId = this.fallbackSealId;
    const sealHandle = this.fallbackSealHandle;
    this.fallbackSealId = null;
    this.fallbackSealHandle = null;
    if (sealId && sealHandle && this.sealImageHandles.get(sealId) === sealHandle) {
      this.revokeSealImage(sealId);
    }
    const layer = this.viewer.getElements().dialogLayer;
    if (layer && layer.childElementCount === 0) layer.hidden = true;
  }

  /** 释放指定签章详情的印章图片 Blob URL。 */
  private revokeSealImage(id: string): void {
    const handle = this.sealImageHandles.get(id);
    if (!handle) return;
    this.sealImageHandles.delete(id);
    handle.revoke();
  }

  /** 释放全部详情的印章图片 Blob URL。 */
  private revokeAllSealImages(): void {
    for (const handle of this.sealImageHandles.values()) handle.revoke();
    this.sealImageHandles.clear();
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
    this.revokeSealImage(detail.entry.id);
    const root = this.createContentRoot();
    const status = this.doc.createElement('div');
    // chrome67: flex gap 不生效，改用 Chrome 57 起可用的 grid gap（行内两列）。
    Object.assign(status.style, {
      display: 'grid',
      gridAutoFlow: 'column',
      justifyContent: 'start',
      alignItems: 'center',
      gridColumnGap: '8px',
      marginBottom: '10px',
    } satisfies Partial<CSSStyleDeclaration>);
    const badge = this.doc.createElement('span');
    badge.className = 'ofd-signature-badge';
    const verification = detail.verification;
    badge.textContent = verificationStatusLabel(verification?.status);
    badge.dataset.status = verification?.status ?? 'not-verified';
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
    const text = createCryptoText(this.viewer.getState().ui.locale);
    const signerValue = this.doc.createElement('span');
    signerValue.textContent = signer?.certificate
      ? certificateSignerText(signer.certificate)
      : text.signerCertificateMissing;
    signerValue.appendChild(this.createTrustTag(verification?.certificate));
    const certificateDownload = this.createSignerCertificateDownload(detail);
    root.appendChild(
      this.createSection('基本信息', [
        ['签章类型', signatureTypeLabel(entry.type)],
        ['签章 ID', entry.id],
        [
          text.signingTime,
          formatSigningTime(
            verification?.signingTime ?? signer?.signedAt ?? entry.signatureDateTime,
          ) ?? text.signingTimeMissing,
        ],
        ['签章时间', signatureTimeText(detail, entry)],
        ['签章提供者', providerText(entry)],
        ['保护范围', entry.references.map((reference) => reference.fileRef).join('、')],
      ]),
    );
    // 以下“验证结果”区块与验证面板逐项一致，入口统一后用户不必再到工具栏核对。
    root.appendChild(this.createVerificationCard(detail));

    const sealSection = this.createSection(
      '印章信息',
      seal ? sealRows(seal) : [['印章信息', '未获取到印章信息']],
    );
    root.appendChild(sealSection);
    if (seal?.image) {
      const handle = createSealImageElement(this.doc, seal.image, {
        label: seal.name ?? seal.esId ?? detail.entry.id,
      });
      if (handle) {
        this.sealImageHandles.set(detail.entry.id, handle);
        sealSection.after(handle.element);
      }
    }

    root.appendChild(
      this.createSection(
        '签章者',
        signer
          ? signerRows(signer, verification?.timestamp, signerValue, certificateDownload, text)
          : [['签章者信息', '未获取到签章者信息']],
      ),
    );

    root.appendChild(this.createChainSection(detail));
    root.appendChild(this.createPositions(entry));
    root.appendChild(this.createTechnical(detail));
    return root;
  }

  /** 签章者可信 tag：仅链 valid 显示“可信”，其余一律显示“可信状态未知”。 */
  private createTrustTag(chain: CertificateChainVerification | undefined): HTMLElement {
    const text = createCryptoText(this.viewer.getState().ui.locale);
    const trusted = isChainTrusted(chain);
    const tag = this.doc.createElement('span');
    tag.className = 'ofd-trust-tag';
    tag.dataset.trust = trusted ? 'trusted' : 'unknown';
    tag.dataset.ofdControl = 'signature-trust-tag';
    tag.textContent = trusted ? text.trusted : text.trustUnknown;
    return tag;
  }

  /** 签章者证书下载按钮；没有 DER 字节时不渲染。 */
  private createSignerCertificateDownload(detail: SignatureDetail): HTMLElement | null {
    const signer = detail.signer;
    const certificate = signer?.certificate;
    if (!signer?.certificateDer || !certificate) return null;
    const text = createCryptoText(this.viewer.getState().ui.locale);
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'ofd-button ofd-signature-cert-download';
    button.dataset.ofdControl = 'signature-signer-cert-download';
    button.textContent = text.downloadCertificate;
    button.title = certificateFileName(
      { subject: certificate.subject, serialNumber: certificate.serialNumber },
      'signer',
    );
    button.addEventListener('click', () => {
      downloadCertificateDer(
        this.doc,
        signer.certificateDer,
        { subject: certificate.subject, serialNumber: certificate.serialNumber },
        'signer',
      );
    });
    return button;
  }

  /** 根证书链验证区；与签名/完整性总体状态独立。 */
  private createChainSection(detail: SignatureDetail): HTMLElement {
    const text = createCryptoText(this.viewer.getState().ui.locale);
    const chain = detail.verification?.certificate;
    const section = this.doc.createElement('section');
    section.className = 'ofd-signature-chain';
    section.dataset.ofdControl = 'signature-chain-section';
    const heading = this.doc.createElement('h3');
    heading.textContent = text.chainSectionTitle;
    Object.assign(heading.style, { margin: '0 0 6px', fontSize: '14px' } satisfies Partial<CSSStyleDeclaration>);
    const note = this.doc.createElement('p');
    note.className = 'ofd-signature-chain__note';
    note.textContent = text.chainIndependentNote;
    section.append(heading, note);
    if (!chain) {
      const unverified = this.doc.createElement('p');
      unverified.className = 'ofd-signature-chain__unverified';
      unverified.textContent = text.chainNotVerified;
      section.appendChild(unverified);
      return section;
    }

    const rows: Array<readonly [string, string | Node]> = [
      [text.chainStatus, chainStatusText(text, chain.status)],
      [text.chainRootsConfigured, chain.trustRootConfigured ? text.yes : text.no],
      [
        text.chainSignerCertificate,
        chain.signer
          ? this.certificateSummaryNode(chain.signer, text)
          : text.none,
      ],
      [
        text.chainTrustAnchor,
        chain.trustAnchor
          ? this.certificateSummaryNode(chain.trustAnchor, text)
          : text.chainTrustAnchorMissing,
      ],
      [text.chainMembers, this.chainMembersNode(chain.chain, text)],
    ];
    if (chain.issues.length > 0) {
      rows.push([text.issues, this.issuesNode(chain.issues)]);
    }
    section.appendChild(this.createSection(undefined, rows));
    return section;
  }

  /** 证书摘要节点：主题、颁发者、序列号、有效期、指纹。 */
  private certificateSummaryNode(
    summary: CertificateSummary,
    text: ReturnType<typeof createCryptoText>,
  ): HTMLElement {
    const box = this.doc.createElement('div');
    box.className = 'ofd-signature-chain__certificate';
    const lines = [
      `${text.rootsSubject}：${summary.subject}`,
      `${text.rootsIssuer}：${summary.issuer}`,
      `${text.rootsSerial}：${summary.serialNumber}`,
      `${text.rootsValidity}：${formatShanghaiDateTime(summary.notBefore) ?? summary.notBefore} — ${
        formatShanghaiDateTime(summary.notAfter) ?? summary.notAfter
      }`,
      `${text.rootsFingerprint}：${summary.fingerprintSha256}`,
    ];
    for (const line of lines) {
      const item = this.doc.createElement('span');
      item.textContent = line;
      box.appendChild(item);
    }
    return box;
  }

  /** 链成员列表。 */
  private chainMembersNode(
    members: readonly CertificateSummary[],
    text: ReturnType<typeof createCryptoText>,
  ): HTMLElement {
    if (members.length === 0) {
      const none = this.doc.createElement('span');
      none.textContent = text.none;
      return none;
    }
    const list = this.doc.createElement('ul');
    list.className = 'ofd-signature-chain__members';
    for (const member of members) {
      const item = this.doc.createElement('li');
      item.appendChild(this.certificateSummaryNode(member, text));
      list.appendChild(item);
    }
    return list;
  }

  /** 链问题列表。 */
  private issuesNode(
    issues: readonly { readonly code: string; readonly message: string }[],
  ): HTMLElement {
    const list = this.doc.createElement('ul');
    list.className = 'ofd-signature-chain__issues';
    for (const issue of issues) {
      const item = this.doc.createElement('li');
      item.textContent = `${issue.code}：${issue.message}`;
      list.appendChild(item);
    }
    return list;
  }

  /** 创建详情内容根节点。 */
  private createContentRoot(): HTMLElement {
    const root = this.doc.createElement('div');
    root.className = 'ofd-signature-detail';
    // chrome67: flex gap 不生效，改用 Chrome 57 起可用的 grid gap（纵向单列）。
    Object.assign(root.style, {
      display: 'grid',
      gridAutoFlow: 'row',
      gridRowGap: '12px',
    } satisfies Partial<CSSStyleDeclaration>);
    return root;
  }

  /** 创建“标题 + 键值表”区块。 */
  /**
   * 详情内的“验证结果”卡片。
   *
   * 字段与措辞逐项复用验证面板，保证“点印章”“点签章列表”“验证面板”三处结论一致；
   * 这里只读展示，重新验证等操作仍留在验证面板。
   *
   * @param detail 已解析的签章详情。
   * @returns 验证结果区块。
   */
  private createVerificationCard(detail: SignatureDetail): HTMLElement {
    const text = createCryptoText(this.viewer.getState().ui.locale);
    const verification = detail.verification;
    if (!verification) {
      return this.createSection(text.panelTitle, [
        [text.overall, `${text.panelNotVerified}（${verificationStatusLabel(undefined)}）`],
        ['说明', SIGNATURE_NOT_VERIFIED_NOTE],
      ]);
    }
    const report = this.currentReport();
    const rows: Array<readonly [string, string | Node | undefined]> = [
      [text.overall, overallStatusText(text, verification.status)],
    ];
    rows.push(
      [text.sesVersion, verification.version],
      [
        text.signingTime,
        formatSigningTime(verification.signingTime) ?? text.signingTimeMissing,
      ],
      [
        text.dataHash,
        `${overallStatusText(text, verification.dataHash.status)}（${
          verification.dataHash.expected ?? text.none
        }）`,
      ],
      [
        text.references,
        `${overallStatusText(text, verification.references.status)} ${
          verification.references.checked
        }/${verification.references.total}`,
      ],
      [text.math, overallStatusText(text, verification.signature.status)],
      // 证书链状态独立展示，不影响上面的签名/完整性总体状态。
      [text.chainIndependent, chainStatusText(text, verification.certificate.status)],
      [
        text.seal,
        verification.seal
          ? `${verification.seal.name ?? verification.seal.esId ?? text.none}（${overallStatusText(
              text,
              verification.seal.status,
            )}）`
          : text.none,
      ],
      [text.timestamp, timestampText(verification, text)],
    );
    if (report) {
      if (report.package.encrypted) rows.push([text.packageEncrypted, text.present]);
      if (report.package.decrypted) rows.push([text.packageDecrypted, text.present]);
      rows.push(
        [text.packagePages, String(this.viewer.getState().document.pageCount)],
        [text.packageSignatures, String(report.package.signatureCount)],
        [
          text.packageIntegrity,
          report.package.integrityPresent ? text.present : text.absent,
        ],
      );
      const integrity = report.integrity;
      if (integrity) {
        rows.push(
          [text.integrity, overallStatusText(text, integrity.status)],
          [text.integrityFiles, String(integrity.fileListCount)],
          [text.integrityMissing, listText(integrity.missingFiles, text)],
          [text.integrityExtra, listText(integrity.extraFiles, text)],
        );
      }
    }
    const section = this.createSection(text.panelTitle, rows);
    section.classList.add('ofd-signature-verification');
    section.dataset.ofdControl = 'signature-verification-card';
    const issues = [...(report?.integrity?.issues ?? []), ...verification.issues];
    if (issues.length > 0) {
      const box = this.doc.createElement('div');
      box.className = 'ofd-signature-verification__issues';
      const heading = this.doc.createElement('p');
      heading.className = 'ofd-signature-verification__issues-title';
      heading.textContent = text.issues;
      const list = this.doc.createElement('ul');
      for (const issue of issues) {
        const item = this.doc.createElement('li');
        item.textContent = `${issue.code}：${issue.message}`;
        list.appendChild(item);
      }
      box.append(heading, list);
      section.appendChild(box);
    }
    return section;
  }

  private createSection(
    title: string | undefined,
    rows: ReadonlyArray<readonly [string, string | Node | undefined]>,
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
    list.className = 'ofd-signature-detail__pairs';
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
      if (typeof value === 'string') description.textContent = value;
      else description.appendChild(value);
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

/** 签章类型文案。 */
function signatureTypeLabel(type: string): string {
  const normalized = type.trim();
  if (normalized.toLowerCase() === 'seal') return '盖章';
  if (normalized.toLowerCase() === 'sign') return '签名';
  return normalized || '签章';
}

/** 列表/详情中的签章时间；优先验证报告的签发时间。 */
function signatureTimeText(
  detail: SignatureDetail | undefined,
  entry: SignatureEntryInfo,
): string {
  return (
    formatSigningTime(
      detail?.verification?.signingTime ??
        detail?.signer?.signedAt ??
        entry.signatureDateTime,
    ) ?? '时间未知'
  );
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

/** 详情标题：与验证面板一致的状态措辞，未验证时标注“未验证”。 */
function detailTitle(detail?: SignatureDetail): string {
  return `签章信息（${verificationStatusLabel(detail?.verification?.status)}）`;
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
      return '签名数学、dataHash、引用完整性与印章结构/数学校验通过。';
    case 'invalid':
      return '存在签名/完整性校验失败项，详见工具栏验证面板。';
    case 'unknown':
      return '有签名/完整性校验项未能确认，详见工具栏验证面板。';
    case 'unsupported':
      return '当前环境不支持签名验证。';
    default:
      return '未执行签名验证。';
  }
}

/** 是否为链验证通过（唯一允许显示“可信”分支）。 */
function isChainTrusted(chain: CertificateChainVerification | undefined): boolean {
  return chain?.status === 'valid';
}

/**
 * 与验证面板完全一致的总体状态措辞。
 *
 * @param status 验证报告中的签名状态；未验证时省略。
 * @returns 例如“有效”“无效”“未知”。
 */
function verificationStatusLabel(status: SignatureVerification['status'] | undefined): string {
  switch (status) {
    case 'valid':
      return '有效';
    case 'invalid':
      return '无效';
    case 'not-applicable':
      return '不适用';
    case 'unsupported':
      return '不支持';
    case 'unknown':
      return '未知';
    default:
      return '未验证';
  }
}

/**
 * 与验证面板相同的总体状态文案（有效/无效/未知/不支持/不适用）。
 *
 * @param text 密码 UI 文案。
 * @param status 验证状态；未知状态回退为原文。
 * @returns 状态文案。
 */
function overallStatusText(text: CryptoText, status: string): string {
  switch (status) {
    case 'valid':
      return text.overallValid;
    case 'invalid':
      return text.overallInvalid;
    case 'unknown':
      return text.overallUnknown;
    case 'not-applicable':
      return text.overallNotApplicable;
    case 'unsupported':
      return text.overallUnsupported;
    default:
      return status;
  }
}

/**
 * 验证状态信息：数据键（DOM `data-status`）、图标与 hover 含义。
 *
 * `data-status` 沿用验证报告的状态值；`not-verified` 表示尚未得到报告。
 *
 * @param status 验证报告中的签名状态；未验证时省略。
 * @returns 状态键、图标名与含义文案。
 */
function verificationInfo(status: SignatureVerification['status'] | undefined): {
  readonly key: string;
  readonly glyph: GlyphName;
  readonly meaning: string;
} {
  switch (status) {
    case 'valid':
      return { key: 'valid', glyph: 'status-valid', meaning: '验证有效：签名与完整性校验通过' };
    case 'invalid':
      return { key: 'invalid', glyph: 'status-invalid', meaning: '验证无效：存在校验失败项' };
    case 'unknown':
      return { key: 'unknown', glyph: 'status-unknown', meaning: '验证未知：部分校验项未确认' };
    case 'unsupported':
      return {
        key: 'unsupported',
        glyph: 'status-unsupported',
        meaning: '不支持验证：当前环境无法验证',
      };
    case 'not-applicable':
      return { key: 'not-applicable', glyph: 'status-not-applicable', meaning: '不适用验证' };
    default:
      return { key: 'not-verified', glyph: 'status-pending', meaning: '未验证' };
  }
}

/**
 * 列表文本；空列表给出“无”。
 *
 * @param values 取值列表。
 * @param text 密码 UI 文案。
 * @returns 以顿号连接的文本。
 */
function listText(values: readonly string[], text: CryptoText): string {
  return values.length > 0 ? values.join('、') : text.none;
}

/**
 * 时间戳文案：固定“已解析，未验证”，并说明不参与总体状态。
 *
 * @param verification 签名验证结果。
 * @param text 密码 UI 文案。
 * @returns 时间戳说明文本。
 */
function timestampText(verification: SignatureVerification, text: CryptoText): string {
  if (verification.timestamp.status === 'parsed-not-verified') {
    return `${text.timestampParsedNotVerified}（${text.timestampNotInOverall}）`;
  }
  if (verification.timestamp.status === 'parse-error') return text.timestampUnparsable;
  return text.timestampMissing;
}

/** 签章者信息行。 */
function signerRows(
  signer: SignerInfo,
  timestamp: SignatureVerification['timestamp'] | undefined,
  signerValue: Node,
  certificateDownload: Node | null,
  text: CryptoText,
): ReadonlyArray<readonly [string, string | Node | undefined]> {
  const certificate = signer.certificate;
  const rows: Array<readonly [string, string | Node | undefined]> = [
    ['签章者', signerValue],
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
    [text.signerCertificate, certificateDownload ?? undefined],
  ];
  if (timestamp?.status === 'parsed-not-verified') {
    rows.push(
      ['时间戳', '已解析，未验证（不参与总体状态）'],
      [
        '时间戳时间',
        `${formatShanghaiDateTime(timestamp.genTime) ?? '不可解析'}（UTC+08:00）`,
      ],
      ['TSA', timestamp.tsa?.subject ?? '未找到'],
      ['时间戳序列号', timestamp.serialNumber ?? '未找到'],
    );
  } else if (timestamp?.status === 'parse-error') {
    rows.push(['时间戳', `不可解析${timestamp.parseError ? `（${timestamp.parseError.message}）` : ''}`]);
  } else {
    rows.push([
      '时间戳',
      signer.timestampPresent ? '含时间戳（未解析、未验证）' : '未包含',
    ]);
  }
  return rows;
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