/**
 * 工具栏验证面板（设计 §6.4）。
 *
 * 数据只来自 `VerificationReport`；时间戳固定展示“已解析，未验证”，不参与
 * overall。面板不读取 SignedValue/Seal 原始 ASN.1，也不保留第二套验签路径。
 */

import type {
  CertificateChainVerification,
  CertificateSummary,
  SignatureVerification,
  VerificationReport,
  VerificationStatus,
} from '@ofdrw/ofdrw-viewer-crypto';
import { OFDViewerError, isOFDViewerError } from '../errors';
import type { UIShell } from '../ui/ui-shell';
import type { CryptoService, CryptoServiceHost } from './service';
import { createSealImageElement } from './seal-image';
import type { SealImageHandle } from './seal-image';
import type { CryptoText } from './text';
import { formatShanghaiDateTime } from './time';

/** 面板实例序号，用于生成跨实例唯一的控件 id。 */
let verificationPanelSequence = 0;

/** 验证面板。 */
export class VerificationPanel {
  private readonly doc: Document;
  private readonly idPrefix: string;
  private liveRegion: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private isOpen = false;
  private destroyed = false;
  /** 渲染代次；异步图片加载完成时用于丢弃过期结果。 */
  private renderGeneration = 0;
  /** 按签名 ID 保存图片句柄，重新渲染/关闭时释放 Blob URL。 */
  private readonly sealImageHandles = new Map<string, SealImageHandle>();

  /**
   * @param host 阅读器宿主。
   * @param service 密码服务。
   * @param shell 内置 UI 外壳。
   */
  constructor(
    private readonly host: CryptoServiceHost,
    private readonly service: CryptoService,
    private readonly shell: UIShell,
  ) {
    this.doc = shell.root.ownerDocument;
    verificationPanelSequence += 1;
    this.idPrefix = `ofd-verification-${verificationPanelSequence}`;
  }

  /** 打开或刷新面板。 */
  open(): void {
    if (this.destroyed) return;
    if (this.isOpen && this.shell.dialogs.currentName === 'verification') {
      this.render();
      return;
    }
    const body = this.doc.createElement('div');
    body.className = 'ofd-verification-panel';
    this.body = body;
    this.isOpen = true;
    this.shell.openDialog({
      name: 'verification',
      title: this.service.strings.panelTitle,
      content: body,
      actions: [{ label: this.service.strings.close }],
      onClose: () => {
        this.isOpen = false;
        this.body = null;
        this.liveRegion = null;
        this.disposeSealImages();
      },
    });
    this.render();
  }

  /** 关闭面板。 */
  close(restoreFocus = true): void {
    this.isOpen = false;
    this.body = null;
    this.liveRegion = null;
    this.disposeSealImages();
    if (this.shell.dialogs.currentName === 'verification') {
      this.shell.closeDialog(restoreFocus);
    }
  }

  /** 重新渲染；面板未打开时无操作。 */
  render(): void {
    if (this.destroyed || !this.isOpen || !this.body) return;
    this.renderGeneration += 1;
    this.disposeSealImages();
    const active = this.doc.activeElement;
    const focusedControl =
      active instanceof HTMLElement && this.body.contains(active)
        ? active.getAttribute('data-ofd-control')
        : null;
    this.ensureLiveRegion();
    this.body.replaceChildren(...this.buildContent(), this.liveRegion!);
    this.updateLiveText();
    if (focusedControl) {
      this.body
        .querySelector<HTMLElement>(
          `[data-ofd-control="${focusedControl.replaceAll('"', '\"')}"]`,
        )
        ?.focus({ preventScroll: true });
    }
  }

  /** 销毁面板并移除监听。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close(false);
  }

  // -------------------------------------------------------------------------
  // 内容
  // -------------------------------------------------------------------------

  /** 构造面板内容。 */
  private buildContent(): Node[] {
    const { text, host, service } = this;
    const nodes: Node[] = [];
    const report = service.getReport();
    const error = service.getError();

    const header = this.doc.createElement('div');
    header.className = 'ofd-verification-header';
    if (report) {
      header.append(
        this.statusBadge(report.overall, `${text.overall}：`),
        this.createText(
          'span',
          'ofd-verification-header__time',
          `${text.panelVerifiedAt}：${report.startedAt}（${report.durationMs}ms）`,
        ),
      );
    } else {
      header.append(
        this.createText('span', 'ofd-verification-badge', text.panelNotVerified),
      );
    }
    const actions = this.doc.createElement('div');
    actions.className = 'ofd-verification-actions';
    const reverify = this.doc.createElement('button');
    reverify.type = 'button';
    reverify.className = 'ofd-button ofd-verification-reverify';
    reverify.dataset.ofdControl = 'verification-reverify';
    reverify.textContent = text.panelReverify;
    reverify.disabled = service.isLoading || !host.isFeatureEnabled('verification');
    reverify.addEventListener('click', () => {
      void host.verify().catch((error: unknown) => {
        // 入口失败必须显示，不能吞掉 OFD_FEATURE_DISABLED 等错误。
        this.service.setVerificationError(this.toPanelError(error));
        this.render();
      });
    });
    actions.appendChild(reverify);
    header.appendChild(actions);
    nodes.push(header);

    if (service.isLoading) {
      nodes.push(this.createText('p', 'ofd-verification-loading', text.panelLoading));
    }
    if (error) {
      const box = this.createText('p', 'ofd-verification-error', error.message);
      box.setAttribute('role', 'alert');
      nodes.push(box);
    }
    if (!report) {
      if (!service.isLoading) {
        nodes.push(this.createText('p', 'ofd-verification-empty', text.panelNotVerified));
      }
      nodes.push(this.buildRoots());
      return nodes;
    }

    const guidance = this.buildGuidance(report);
    if (guidance) nodes.push(guidance);
    nodes.push(this.buildPackage(report));
    const integrity = this.buildIntegrity(report);
    if (integrity) nodes.push(integrity);
    for (const signature of report.signatures) {
      nodes.push(this.buildSignature(signature));
    }
    nodes.push(this.buildRoots());
    if (report.warnings.length > 0) {
      const warning = this.doc.createElement('ul');
      warning.className = 'ofd-verification-warnings';
      for (const item of report.warnings) {
        const line = this.doc.createElement('li');
        line.textContent = `${item.code}：${item.message}`;
        warning.appendChild(line);
      }
      nodes.push(warning);
    }
    return nodes;
  }

  /** 包级信息。 */
  private buildPackage(report: VerificationReport): HTMLElement {
    const { text } = this;
    const card = this.createCard('ofd-verification-package', text.packageInfo);
    const openInfo = this.service.getOpenEncryptionInfo();
    const encrypted = openInfo?.encrypted ?? report.package.encrypted;
    const decrypted = openInfo?.decrypted ?? report.package.decrypted;
    const rows: [string, string][] = [];
    // 明文文档不展示“是否加密/是否已解密”这类恒为否的无关行。
    if (encrypted) rows.push([text.packageEncrypted, text.present]);
    if (decrypted) rows.push([text.packageDecrypted, text.present]);
    rows.push(
      [text.packagePages, String(this.host.getState().document.pageCount)],
      [text.packageSignatures, String(report.package.signatureCount)],
      [text.packageIntegrity, report.package.integrityPresent ? text.present : text.absent],
    );
    this.appendPairs(card, rows);
    return card;
  }

  /** 完整性卡片；无完整性保护时整块不渲染。 */
  private buildIntegrity(report: VerificationReport): HTMLElement | null {
    const { text } = this;
    const integrity = report.integrity;
    if (!integrity) return null;
    const card = this.createCard('ofd-verification-integrity', text.integrity);
    card.dataset.status = integrity.status;
    card.appendChild(this.statusBadge(integrity.status, ''));
    this.appendPairs(card, [
      [text.integrityFiles, String(integrity.fileListCount)],
      [text.integrityMissing, this.listText(integrity.missingFiles)],
      [text.integrityExtra, this.listText(integrity.extraFiles)],
      [text.math, this.statusText(integrity.signature.status)],
      [text.chain, this.chainText(integrity.certificate)],
    ]);
    this.appendIssues(card, integrity.issues);
    return card;
  }

  /**
   * 信任根缺失/不匹配时的解释性引导。
   *
   * 只解释报告已有状态，不改变 overall，也不提供“忽略证书链”操作。
   */
  private buildGuidance(report: VerificationReport): HTMLElement | null {
    const { text } = this;
    const chainUnknown =
      report.overall === 'unknown' &&
      !report.rootsConfigured &&
      report.signatures.some((signature) => signature.certificate.status === 'unknown');
    const mismatch = report.signatures.some((signature) =>
      signature.certificate.issues.some((issue) => issue.code === 'CHAIN_SIGNATURE_INVALID'),
    );
    if (!chainUnknown && !mismatch) return null;

    const box = this.doc.createElement('div');
    box.className = 'ofd-verification-guidance';
    box.dataset.status = mismatch ? 'invalid' : 'unknown';
    box.setAttribute('role', 'note');
    const title = this.createText(
      'p',
      'ofd-verification-guidance__title',
      mismatch ? text.trustRootMismatch : text.trustRootMissing,
    );
    const math = this.createText('p', 'ofd-verification-guidance__note', text.signatureMathNotTrust);
    const guidance = this.createText(
      'p',
      'ofd-verification-guidance__note',
      mismatch ? text.trustRootMismatchGuidance : text.trustRootGuidance,
    );
    box.append(title, math, guidance);
    return box;
  }

  /** 单个签名卡片。 */
  private buildSignature(signature: SignatureVerification): HTMLElement {
    const { text } = this;
    const card = this.createCard('ofd-verification-signature', `${text.signatureCard} ${signature.id}`);
    card.dataset.signatureId = signature.id;
    card.dataset.status = signature.status;
    card.dataset.signatureType = signature.type;
    const type = this.createText(
      'span',
      'ofd-verification-signature__type',
      signature.type === 'Seal' ? text.seal : signature.type === 'Sign' ? text.signatureCard : signature.type,
    );
    type.dataset.ofdControl = 'verification-signature-type';
    card.appendChild(type);
    card.appendChild(this.statusBadge(signature.status, ''));
    this.appendPairs(card, [
      [text.sesVersion, signature.version],
      [text.dataHash, `${this.statusText(signature.dataHash.status)}（${signature.dataHash.expected ?? text.none}）`],
      [
        text.references,
        `${this.statusText(signature.references.status)} ${signature.references.checked}/${signature.references.total}`,
      ],
      [text.math, this.statusText(signature.signature.status)],
      [text.chain, this.chainText(signature.certificate)],
      [
        text.seal,
        signature.seal
          ? `${signature.seal.name ?? signature.seal.esId ?? text.none}（${this.statusText(signature.seal.status)}）`
          : text.none,
      ],
    ]);

    if (signature.seal) {
      const sealImage = this.doc.createElement('div');
      sealImage.className = 'ofd-verification-signature__seal';
      sealImage.dataset.ofdControl = 'verification-signature-seal-image';
      card.appendChild(sealImage);
      void this.loadSignatureSeal(signature, sealImage, this.renderGeneration);
    }

    if (signature.references.failures.length > 0) {
      const failures = this.doc.createElement('ul');
      failures.className = 'ofd-verification-failures';
      for (const failure of signature.references.failures) {
        const item = this.doc.createElement('li');
        item.textContent = `${failure.fileRef}：${failure.reason}`;
        failures.appendChild(item);
      }
      card.appendChild(failures);
    }

    const timestamp = this.doc.createElement('p');
    timestamp.className = 'ofd-verification-timestamp';
    if (signature.timestamp.status === 'parsed-not-verified') {
      // 固定文案：只解析、不验证，不参与 overall；时间固定按 UTC+8 展示。
      timestamp.textContent = `${text.timestamp}：${text.timestampParsedNotVerified}（${text.timestampNotInOverall}）`;
      timestamp.dataset.status = 'parsed-not-verified';
      const timestampValue = signature.timestamp;
      const rows: readonly (readonly [string, string])[] = [
        [
          text.timestampGenTime,
          formatShanghaiDateTime(timestampValue.genTime) ?? text.timestampUnparsable,
        ],
        [text.timestampTsa, timestampValue.tsa?.subject ?? text.none],
        [text.timestampSerial, timestampValue.serialNumber ?? text.none],
        ...(timestampValue.policy
          ? ([[text.timestampPolicy, timestampValue.policy]] as const)
          : []),
      ];
      for (const [label, value] of rows) {
        const line = this.doc.createElement('span');
        line.className = 'ofd-verification-timestamp__field';
        line.textContent = `${label}：${value}`;
        timestamp.appendChild(line);
      }
    } else if (signature.timestamp.status === 'parse-error') {
      const detail = signature.timestamp.parseError?.message;
      timestamp.textContent = `${text.timestamp}：${text.timestampUnparsable}${
        detail ? `（${detail}）` : ''
      }`;
      timestamp.dataset.status = 'parse-error';
    } else {
      timestamp.textContent = `${text.timestamp}：${text.timestampMissing}`;
      timestamp.dataset.status = 'not-present';
    }
    card.appendChild(timestamp);
    this.appendIssues(card, signature.issues);
    return card;
  }

  /**
   * 异步加载签章详情中的印章图片。
   *
   * 复用签章服务的 `getSignatureDetail`，只读取 SignedValue 内嵌 `picture.data`；
   * 过期渲染或节点已移除时丢弃结果，避免把图片挂到旧面板。
   */
  private async loadSignatureSeal(
    signature: SignatureVerification,
    container: HTMLElement,
    generation: number,
  ): Promise<void> {
    const getDetail = this.host.getSignatureDetail;
    if (!getDetail) {
      container.remove();
      return;
    }
    try {
      const detail = await getDetail.call(this.host, signature.id);
      if (generation !== this.renderGeneration || !container.isConnected) return;
      const handle = createSealImageElement(this.doc, detail.seal?.image, {
        label:
          signature.seal?.name ??
          detail.seal?.name ??
          signature.seal?.esId ??
          signature.id,
      });
      if (!handle) {
        container.remove();
        return;
      }
      this.sealImageHandles.get(signature.id)?.revoke();
      this.sealImageHandles.set(signature.id, handle);
      container.replaceChildren(handle.element);
    } catch {
      if (generation === this.renderGeneration) container.remove();
    }
  }

  /** 释放全部印章图片 Blob URL；面板重建/关闭时调用。 */
  private disposeSealImages(): void {
    for (const handle of this.sealImageHandles.values()) handle.revoke();
    this.sealImageHandles.clear();
  }

  /** 根证书区。 */
  private buildRoots(): HTMLElement {
    const { text, service } = this;
    const card = this.createCard('ofd-verification-roots', text.roots);
    const items = service.getRootItems();
    if (items.length === 0) {
      const none = this.createText('p', 'ofd-verification-muted', text.rootsNone);
      card.appendChild(none);
      const note = this.createText('p', 'ofd-verification-muted', text.rootsUnknownNote);
      card.appendChild(note);
    } else {
      const list = this.doc.createElement('ul');
      list.className = 'ofd-verification-root-list';
      for (const [index, item] of items.entries()) {
        for (const summary of item.summaries) {
          const row = this.doc.createElement('li');
          row.className = 'ofd-verification-root';
          row.dataset.fingerprint = summary.fingerprintSha256;
          row.appendChild(this.summaryText(summary));
          const remove = this.doc.createElement('button');
          remove.type = 'button';
          remove.className = 'ofd-button ofd-verification-root__remove';
          remove.dataset.ofdControl = 'verification-root-remove';
          remove.textContent = text.rootsRemove;
          remove.addEventListener('click', () => {
            void this.removeRoot(index).catch(() => undefined);
          });
          row.appendChild(remove);
          list.appendChild(row);
        }
      }
      card.appendChild(list);
    }

    const hint = this.createText('p', 'ofd-verification-muted', text.rootsHint);
    card.appendChild(hint);
    const file = this.doc.createElement('input');
    file.type = 'file';
    file.multiple = true;
    file.accept = '.pem,.der,.cer';
    file.className = 'ofd-verification-root-input';
    file.id = `${this.idPrefix}-root-input`;
    file.dataset.ofdControl = 'verification-root-input';
    file.setAttribute('aria-label', text.rootsAdd);
    file.addEventListener('change', () => {
      void this.addRoots(file).catch(() => undefined);
    });
    const label = this.doc.createElement('label');
    label.className = 'ofd-button ofd-verification-root-add';
    label.htmlFor = file.id;
    label.textContent = text.rootsAdd;
    card.append(file, label);
    return card;
  }

  /** 添加选中的根证书。 */
  private async addRoots(input: HTMLInputElement): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    let sources: Array<{ data: Uint8Array; name: string }>;
    try {
      sources = await Promise.all(
        files.map(async (file) => ({
          data: new Uint8Array(await file.arrayBuffer()),
          name: file.name,
        })),
      );
    } catch (error) {
      this.service.setVerificationError(this.toRootError(error));
      this.render();
      return;
    }
    try {
      await this.service.addRoots(sources);
    } catch (error) {
      this.service.setVerificationError(this.toRootError(error));
      this.render();
      return;
    }
    if (this.host.getDocument()) {
      try {
        await this.host.verify();
      } catch {
        // 验证错误由 service 记录并渲染。
      }
    }
    this.render();
  }

  /** 删除指定条目并重新验证。 */
  private async removeRoot(index: number): Promise<void> {
    try {
      await this.service.removeRoot(index);
    } catch (error) {
      this.service.setVerificationError(this.toRootError(error));
      this.render();
      return;
    }
    if (this.host.getDocument()) {
      try {
        await this.host.verify();
      } catch {
        // 验证错误由 service 记录并渲染。
      }
    }
    this.render();
  }

  /** 验证入口失败映射为面板错误；已是 UI 错误时原样保留。 */
  private toPanelError(error: unknown): OFDViewerError {
    if (isOFDViewerError(error)) return error;
    return new OFDViewerError(
      'OFD_CRYPTO_FAILED',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  /** 文件读取或根证书变更失败映射为面板错误。 */
  private toRootError(error: unknown): OFDViewerError {
    if (isOFDViewerError(error)) return error;
    return new OFDViewerError('OFD_CRYPTO_FAILED', this.text.rootsInvalid, {
      cause: error,
    });
  }

  /** 创建/复用 overall 与错误变化的礼貌播报区域。 */
  private ensureLiveRegion(): void {
    if (this.liveRegion) return;
    const live = this.doc.createElement('p');
    live.className = 'ofd-sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.dataset.ofdControl = 'verification-live';
    this.liveRegion = live;
  }

  /** 更新播报文本；不获取焦点。 */
  private updateLiveText(): void {
    if (!this.liveRegion) return;
    const { text } = this;
    const error = this.service.getError();
    const report = this.service.getReport();
    if (error) {
      this.liveRegion.textContent = `${text.overall}：${error.message}`;
    } else if (this.service.isLoading) {
      this.liveRegion.textContent = text.panelLoading;
    } else if (report) {
      this.liveRegion.textContent = `${text.overall}：${this.statusText(report.overall)}`;
    } else {
      this.liveRegion.textContent = text.panelNotVerified;
    }
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  private get text(): CryptoText {
    return this.service.strings;
  }

  /** 创建卡片。 */
  private createCard(className: string, title: string): HTMLElement {
    const card = this.doc.createElement('section');
    card.className = `ofd-verification-card ${className}`;
    const heading = this.doc.createElement('h3');
    heading.className = 'ofd-verification-card__title';
    heading.textContent = title;
    card.appendChild(heading);
    return card;
  }

  /** 创建文本节点。 */
  private createText(tag: string, className: string, value: string): HTMLElement {
    const element = this.doc.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  }

  /** 追加“标签：值”列表。 */
  private appendPairs(
    card: HTMLElement,
    pairs: readonly (readonly [string, string])[],
  ): void {
    const list = this.doc.createElement('dl');
    list.className = 'ofd-verification-pairs';
    for (const [label, value] of pairs) {
      const term = this.doc.createElement('dt');
      term.textContent = label;
      const description = this.doc.createElement('dd');
      description.textContent = value;
      list.append(term, description);
    }
    card.appendChild(list);
  }

  /** 追加问题列表。 */
  private appendIssues(
    card: HTMLElement,
    issues: readonly { readonly code: string; readonly message: string }[],
  ): void {
    if (issues.length === 0) return;
    const box = this.doc.createElement('div');
    box.className = 'ofd-verification-issues';
    const heading = this.doc.createElement('p');
    heading.textContent = this.text.issues;
    heading.className = 'ofd-verification-issues__title';
    box.appendChild(heading);
    const list = this.doc.createElement('ul');
    for (const issue of issues) {
      const item = this.doc.createElement('li');
      item.textContent = `${issue.code}：${issue.message}`;
      list.appendChild(item);
    }
    box.appendChild(list);
    card.appendChild(box);
  }

  /** 状态徽标：aria-hidden 图标 + 文字，不只依赖颜色。 */
  private statusBadge(status: VerificationStatus, prefix: string): HTMLElement {
    const badge = this.doc.createElement('span');
    badge.className = 'ofd-verification-badge';
    badge.dataset.status = status;
    const icon = this.doc.createElement('span');
    icon.className = 'ofd-verification-badge__icon';
    icon.dataset.ofdControl = 'verification-status-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.marginInlineEnd = '4px';
    icon.textContent = this.statusIcon(status);
    const label = this.doc.createElement('span');
    label.className = 'ofd-verification-badge__text';
    label.textContent = `${prefix}${this.statusText(status)}`;
    badge.append(icon, label);
    return badge;
  }

  /** 状态图标字符；仅视觉提示，语义由相邻文字承担。 */
  private statusIcon(status: VerificationStatus): string {
    switch (status) {
      case 'valid':
        return '✓';
      case 'invalid':
        return '✕';
      case 'unknown':
        return '?';
      case 'unsupported':
        return '!';
      case 'not-applicable':
        return '–';
      default:
        return '·';
    }
  }

  /** 状态文案。 */
  private statusText(status: VerificationStatus): string {
    const { text } = this;
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
        return String(status);
    }
  }

  /** 证书链文案。 */
  private chainText(chain: CertificateChainVerification): string {
    const { text } = this;
    switch (chain.status) {
      case 'valid':
        return text.overallValid;
      case 'invalid':
        return text.overallInvalid;
      case 'unknown':
        return text.overallUnknown;
      case 'untrusted':
        return text.chainUntrusted;
      case 'incomplete':
        return text.chainIncomplete;
      case 'expired':
        return text.chainExpired;
      case 'not-yet-valid':
        return text.chainNotYetValid;
      case 'not-present':
        return text.chainNotPresent;
      case 'unsupported':
        return text.overallUnsupported;
      default:
        return String(chain.status);
    }
  }

  /** 证书摘要文本。 */
  private summaryText(summary: CertificateSummary): HTMLElement {
    const { text } = this;
    const box = this.doc.createElement('div');
    box.className = 'ofd-verification-root__summary';
    const lines = [
      `${text.rootsSubject}：${summary.subject}`,
      `${text.rootsFingerprint}：${summary.fingerprintSha256}`,
      `${text.rootsValidity}：${summary.notBefore} — ${summary.notAfter}`,
    ];
    for (const line of lines) {
      const item = this.doc.createElement('span');
      item.textContent = line;
      box.appendChild(item);
    }
    return box;
  }

  /** 列表文本。 */
  private listText(values: readonly string[]): string {
    return values.length > 0 ? values.join('、') : this.text.none;
  }
}