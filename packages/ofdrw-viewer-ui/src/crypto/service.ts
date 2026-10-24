/**
 * 密码能力服务：加密检测、解密容器、验证、信任根与凭据交互。
 *
 * 本模块是 UI 访问 `@ofdrw/ofdrw-viewer-crypto` 的唯一入口：
 * - 打开流程 `inspect` → `openDecryptingContainer` → 明文容器；
 * - 验证只调用 `verifyOfd`，不保留第二套验签路径；
 * - 凭据、口令与私钥只在调用栈/当前弹窗中存在，不写入状态、存储或日志。
 */

import { flatMapArray } from '../compat';

import {
  certificatesToDer,
  inspect,
  isCryptoError,
  loadCertificates,
  openDecryptingContainer,
  toCertificateSummary,
  verifyOfd,
} from '@ofdrw/ofdrw-viewer-crypto';
import type {
  CertificateDer,
  CertificateSummary,
  CryptoCredential,
  CryptoSource,
  CryptoWarning,
  DecryptionLayerSummary,
  OfdInspection,
  VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import type { OFDSource, VirtualContainer } from '@ofdrw/ofdrw-viewer-engine';
import type { EngineDocument } from '../document-controller';
import { createFeatureDisabledError, OFDViewerError, isOFDViewerError } from '../errors';
import type { ViewerFeature } from '../features';
import type { CertificateSource, CryptoViewerOptions } from '../options';
import type { SignatureDetail, ViewerSource } from '../types';
import type { UIShellHost } from '../ui';
import { getUIShell } from '../ui';
import { CredentialDialog } from './credentials-dialog';
import { VerificationPanel } from './panel';
import { createCryptoText, type CryptoText } from './text';

/**
 * 验证报告失效事件名。
 *
 * 由 CryptoService 在开始验证、文档切换或根证书变更时派发；签章服务监听后
 * 必须立即剥离旧报告派生内容。
 */
export const VERIFICATION_RESET_EVENT = 'ofd-verification-reset';

/** 打开阶段的检测结果。 */
export type CryptoOpenPreparation =
  | {
      /** 明文或未执行检测；按原路径打开。 */
      readonly kind: 'plain';
      /** 规范化后的来源；关闭密码能力时省略。 */
      readonly source?: CryptoSource;
      /** 检测得到的明文包信息；检测失败时省略。 */
      readonly inspection?: OfdInspection;
      /** 检测失败原因；仅用于打开失败时映射错误。 */
      readonly inspectionError?: unknown;
    }
  | {
      /** 已解密的明文容器；所有权交给阅读器。 */
      readonly kind: 'decrypted';
      readonly source: CryptoSource;
      readonly container: VirtualContainer;
      readonly inspection: OfdInspection;
      readonly layers: readonly DecryptionLayerSummary[];
    };

/** 验证目标：密文来源或已解密容器。 */
export type VerificationTarget =
  | { readonly kind: 'source'; readonly source: CryptoSource }
  | { readonly kind: 'container'; readonly container: VirtualContainer };

/** 单个根证书条目。 */
export interface TrustRootItem {
  /** 原始输入；用于展示与重新加载。 */
  readonly input: CertificateSource;
  /** 该来源转换出的逐张证书 DER；验证时交给 crypto。 */
  readonly ders: readonly CertificateDer[];
  /** 该输入解析出的证书摘要（PEM 可有多张）。 */
  readonly summaries: readonly CertificateSummary[];
}

/** 阅读器提供的最小宿主能力。 */
export interface CryptoServiceHost extends UIShellHost {
  /** 当前引擎文档；未打开为 null。 */
  getDocument(): EngineDocument | null;
  /** 功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean;
  /**
   * 读取签章详情（含 SignedValue 内嵌印章图片字节）。
   *
   * 面板只读复用签章服务已解析的数据，不新增第二套验签路径。
   */
  getSignatureDetail?(signatureId: string): Promise<SignatureDetail>;
  /** 上报密码能力 warning。 */
  warnCrypto(code: string, message: string): void;
  /** 触发一次验证；由阅读器实现状态与事件。 */
  verify(options?: {
    readonly signatureIds?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<VerificationReport>;
}

/** 验证选项。 */
export interface CryptoVerifyOptions {
  /** 只验证指定签名 ID。 */
  readonly signatureIds?: readonly string[];
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 验证结果包装；用于区分“未验证”和“验证失败”。 */
export interface CryptoVerificationState {
  /** 是否正在验证。 */
  readonly loading: boolean;
  /** 最近一次成功报告。 */
  readonly report?: VerificationReport;
  /** 最近一次入口失败。 */
  readonly error?: OFDViewerError;
}

/** 本次打开实际发生的加解密情况；用于面板隐藏明文文档的无关行。 */
export interface OpenEncryptionInfo {
  /** 原始来源是否为加密包。 */
  readonly encrypted: boolean;
  /** 打开过程中是否执行了解密。 */
  readonly decrypted: boolean;
}

/**
 * 密码能力服务。
 */
export class CryptoService {
  private readonly text: CryptoText;
  private readonly enabled: boolean;
  private readonly autoPrompt: boolean;
  private readonly autoVerify: boolean;
  private readonly options: CryptoViewerOptions;

  private target: VerificationTarget | null = null;
  private report: VerificationReport | undefined;
  private verificationError: OFDViewerError | undefined;
  private loading = false;
  /** 本次打开的实际加解密情况；关闭/重新打开时更新。 */
  private openEncryptionInfo: OpenEncryptionInfo | undefined;

  private rootItems: TrustRootItem[] = [];
  private rootsPromise: Promise<void> | null = null;
  /** 初始根加载结果；即使代次过期也保留，供并发 addRoots/removeRoot 合并。 */
  private initialRootItems: TrustRootItem[] | null = null;
  private rootsLoaded = false;
  private readonly offs: Array<() => void> = [];

  private panel: VerificationPanel | null = null;
  private destroyed = false;
  /** 验证请求的单调代次；旧请求完成后不得回写。 */
  private verifyGeneration = 0;
  /** 根证书变更的单调代次；后发变更优先。 */
  private rootsGeneration = 0;
  /** 当前验证请求的内部取消器。 */
  private verifyAbort: AbortController | null = null;

  /**
   * @param host 阅读器宿主。
   * @param options 密码能力选项。
   */
  constructor(
    private readonly host: CryptoServiceHost,
    options: CryptoViewerOptions | undefined,
  ) {
    this.options = options ?? {};
    this.enabled = options?.enabled !== false;
    this.autoPrompt = options?.autoPrompt !== false;
    this.autoVerify = options?.autoVerify !== false;
    this.text = createCryptoText(host.getState().ui.locale);
    this.offs.push(
      host.on('featureschange', () => {
        if (this.destroyed) return;
        // 关闭验证功能必须立即让旧报告失效并取消在途请求；重新开启时
        // 重新渲染面板以恢复“重新验证”按钮可用状态。
        if (!this.host.isFeatureEnabled('verification')) this.invalidateVerification();
        this.panel?.render();
      }),
    );
  }

  /** 是否启用密码能力。 */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 当前语言文案。 */
  get strings(): CryptoText {
    return this.text;
  }

  /** 最近一次验证报告；未验证/已关闭时 undefined。 */
  getReport(): VerificationReport | undefined {
    return this.report;
  }

  /** 最近一次入口失败。 */
  getError(): OFDViewerError | undefined {
    return this.verificationError;
  }

  /** 是否正在验证。 */
  get isLoading(): boolean {
    return this.loading;
  }

  /**
   * 本次打开的实际加解密情况。
   *
   * 容器内部报告对“已解密文档”仍可能显示 encrypted=false/decrypted=false，
   * 面板展示必须使用打开阶段记录的值，避免把加密文档误标为明文。
   *
   * @returns 加解密信息；尚未打开时为 undefined。
   */
  getOpenEncryptionInfo(): OpenEncryptionInfo | undefined {
    return this.openEncryptionInfo;
  }

  /** 当前根证书条目。 */
  getRootItems(): readonly TrustRootItem[] {
    return this.rootItems;
  }

  /** 当前根证书摘要。 */
  getRoots(): readonly CertificateSummary[] {
    return flatMapArray(this.rootItems, (item) => item.summaries);
  }

  /**
   * 设置验证目标；打开文档后由阅读器调用。
   *
   * @param target 验证目标；关闭文档时传 null。
   */
  setTarget(target: VerificationTarget | null): void {
    this.invalidateVerification();
    this.target = target;
    this.report = undefined;
    this.verificationError = undefined;
    this.loading = false;
    if (!target) this.openEncryptionInfo = undefined;
  }

  /** 文档关闭时清理报告与面板。 */
  reset(): void {
    this.setTarget(null);
    this.panel?.close(false);
  }

  /** 标记验证开始/结束，供面板展示。 */
  setLoading(loading: boolean): void {
    this.loading = loading;
    this.panel?.render();
  }

  /** 记录验证入口错误。 */
  setVerificationError(error: OFDViewerError | undefined): void {
    this.verificationError = error;
    this.panel?.render();
  }

  /** 记录成功报告。 */
  setReport(report: VerificationReport | undefined): void {
    this.report = report;
    this.verificationError = undefined;
    this.panel?.render();
  }

  /**
   * 打开前检测并（按需）解密。
   *
   * 检测非取消失败时抛 `OFD_CRYPTO_FAILED` 并保留 cause；加密检测成功但
   * 凭据缺失/取消/解密失败时抛 UI 错误，不打开文档。
   *
   * @param source 已规范化的引擎来源；调用方负责 URL → 字节源，仅规范化一次。
   * @param signal 取消信号。
   * @returns 打开准备结果。
   */
  async prepareOpen(source: OFDSource, signal: AbortSignal): Promise<CryptoOpenPreparation> {
    this.openEncryptionInfo = undefined;
    if (!this.enabled) return { kind: 'plain' };
    await this.ensureRoots();
    const cryptoSource = toCryptoSource(source);
    if (!cryptoSource) {
      throw new OFDViewerError('OFD_CRYPTO_UNSUPPORTED', this.text.cryptoUnsupported);
    }

    let inspection: OfdInspection;
    try {
      inspection = await inspect(cryptoSource, {
        signal,
        ...this.cryptoOptions(),
      });
      this.forwardWarnings(inspection.warnings);
    } catch (error) {
      if (signal.aborted || isAbortCryptoError(error)) {
        throw new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled, {
          cause: error,
        });
      }
      // inspect 非取消失败一律作为 crypto 打开失败暴露；不再把未知包回退给
      // 引擎，避免畸形 ZIP/加密元数据错误被通用包错误覆盖。
      const detail = error instanceof Error ? error.message : String(error);
      throw new OFDViewerError(
        'OFD_CRYPTO_FAILED',
        `${this.text.credentialDecryptFailed}：${detail}`,
        { cause: error },
      );
    }

    if (!inspection.encrypted) {
      this.openEncryptionInfo = { encrypted: false, decrypted: false };
      return { kind: 'plain', source: cryptoSource, inspection };
    }

    const credentials = this.options.credentials;
    if (credentials !== undefined) {
      return this.decryptWithCredentials(cryptoSource, credentials, signal, inspection);
    }
    if (!this.autoPrompt) {
      throw new OFDViewerError(
        'OFD_CRYPTO_CREDENTIAL_REQUIRED',
        this.text.credentialRequired,
      );
    }
    const handler = this.options.onCredentialRequired;
    if (handler) {
      let credential: CryptoCredential | null;
      try {
        credential = await handler(inspection);
      } catch (error) {
        throw new OFDViewerError('OFD_CRYPTO_FAILED', this.text.credentialDecryptFailed, {
          cause: error,
        });
      }
      if (!credential) {
        throw new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled);
      }
      return this.decryptWithCredentials(cryptoSource, credential, signal, inspection);
    }
    return this.decryptWithPrompt(cryptoSource, inspection, signal);
  }

  /**
   * 执行一次验证。
   *
   * @param options 签名筛选与取消信号。
   * @returns 验证报告。
   * @throws {OFDViewerError} 未打开、密码能力禁用或入口失败时。
   */
  async verify(options: CryptoVerifyOptions = {}): Promise<VerificationReport> {
    if (!this.enabled) {
      throw new OFDViewerError('OFD_CRYPTO_UNSUPPORTED', this.text.cryptoDisabled);
    }
    if (!this.host.isFeatureEnabled('verification')) {
      throw createFeatureDisabledError('verification');
    }
    if (!this.target) {
      throw new OFDViewerError('OFD_NOT_OPENED', this.text.notOpened);
    }
    const generation = this.beginVerification();
    const controller = new AbortController();
    this.verifyAbort = controller;
    const forwardAbort = (): void => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    this.loading = true;
    this.panel?.render();
    try {
      // 根证书可能在等待期间被替换；先复核代次，避免旧 verify 抢占新配置。
      await this.ensureRoots();
      if (!this.isCurrent(generation, controller)) {
        throw new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled);
      }
      const report = await verifyOfd({
        ...this.targetOptions(this.target),
        ...this.cryptoOptions(),
        roots: flatMapArray(this.rootItems, (item) => item.ders),
        ...(options.signatureIds ? { signatureIds: options.signatureIds } : {}),
        signal: controller.signal,
      });
      if (!this.isCurrent(generation, controller)) {
        throw new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled);
      }
      this.report = report;
      this.forwardWarnings(report.warnings);
      this.loading = false;
      this.panel?.render();
      return report;
    } catch (error) {
      // 仅“代次已被更新的验证/根变更超越”时静默丢弃；外部 signal 主动取消
      // 仍属于当前操作，需要把取消错误写入面板。
      if (generation !== this.verifyGeneration) {
        throw new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled, {
          cause: error,
        });
      }
      this.loading = false;
      const wrapped = this.toVerificationError(error);
      this.verificationError = wrapped;
      this.panel?.render();
      throw wrapped;
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
      if (this.verifyAbort === controller) this.verifyAbort = null;
    }
  }

  /**
   * 开始一次验证：递增代次并取消旧请求。
   *
   * @returns 新验证代次。
   */
  private beginVerification(): number {
    const generation = (this.verifyGeneration += 1);
    this.abortVerification();
    this.loading = false;
    this.report = undefined;
    this.verificationError = undefined;
    this.closeStalePopovers();
    this.notifyVerificationReset();
    this.panel?.render();
    return generation;
  }

  /**
   * 开始一次根证书变更：根代次递增并立即失效在途验证。
   *
   * @returns 新根证书代次。
   */
  private beginRootChange(): number {
    const generation = (this.rootsGeneration += 1);
    this.beginVerification();
    return generation;
  }

  /** 中止正在进行的验证请求。 */
  private abortVerification(): void {
    this.verifyAbort?.abort();
    this.verifyAbort = null;
  }

  /** 仅失效验证状态，不直接渲染密码面板；用于文档切换/销毁。 */
  private invalidateVerification(): void {
    this.verifyGeneration += 1;
    this.abortVerification();
    this.loading = false;
    this.report = undefined;
    this.verificationError = undefined;
    this.closeStalePopovers();
    this.notifyVerificationReset();
  }

  /** 通知签章服务：旧验证报告已失效，必须剥离派生内容。 */
  private notifyVerificationReset(): void {
    this.host
      .getElements()
      .root.dispatchEvent(new CustomEvent(VERIFICATION_RESET_EVENT));
  }

  /** 当前请求是否仍可回写状态。 */
  private isCurrent(generation: number, controller: AbortController): boolean {
    return generation === this.verifyGeneration && !controller.signal.aborted;
  }

  /** 关闭依赖旧报告的印章浮层；没有则无操作。 */
  private closeStalePopovers(): void {
    const shell = getUIShell(this.host);
    const root = shell?.root;
    if (!root) return;
    for (const popover of root.querySelectorAll<HTMLElement>('.ofd-signature-popover')) {
      popover
        .querySelector<HTMLButtonElement>('[data-ofd-control="signature-popover-close"]')
        ?.click();
    }
  }

  /**
   * 替换信任根；文档打开时由调用方决定是否重新验证。
   *
   * @param roots 根证书来源。
   * @returns 解析后的摘要。
   */
  async setRoots(roots: readonly CertificateSource[]): Promise<readonly CertificateSummary[]> {
    const generation = this.beginRootChange();
    const items = await this.loadRoots(roots);
    if (generation !== this.rootsGeneration) return this.getRoots();
    // 加载期间可能已有 verify 使用旧根；应用新根前再次失效。
    this.invalidateVerification();
    this.rootItems = items;
    this.rootsLoaded = true;
    this.updateConfig();
    return this.getRoots();
  }

  /**
   * 追加信任根并按指纹去重。
   *
   * @param roots 根证书来源。
   * @returns 解析后的全部摘要。
   */
  async addRoots(
    roots: readonly CertificateSource[],
  ): Promise<readonly CertificateSummary[]> {
    const generation = this.beginRootChange();
    await this.ensureRoots();
    this.adoptInitialRoots();
    const items = await this.loadRoots([
      ...this.rootItems.map((item) => item.input),
      ...roots,
    ]);
    if (generation !== this.rootsGeneration) return this.getRoots();
    this.invalidateVerification();
    this.rootItems = items;
    this.rootsLoaded = true;
    this.updateConfig();
    return this.getRoots();
  }

  /**
   * 删除一个根证书条目。
   *
   * @param index 条目下标。
   * @returns 剩余摘要。
   */
  async removeRoot(index: number): Promise<readonly CertificateSummary[]> {
    const generation = this.beginRootChange();
    await this.ensureRoots();
    if (generation !== this.rootsGeneration) return this.getRoots();
    this.adoptInitialRoots();
    if (index < 0 || index >= this.rootItems.length) return this.getRoots();
    this.invalidateVerification();
    this.rootItems = this.rootItems.filter((_, itemIndex) => itemIndex !== index);
    this.rootsLoaded = true;
    this.updateConfig();
    return this.getRoots();
  }

  /**
   * 在初始加载因代次变化被丢弃后，把已加载的初始根并入当前状态。
   *
   * 仅当 rootsLoaded 仍为 false 时调用；不会覆盖 setRoots 已应用的新根。
   */
  private adoptInitialRoots(): void {
    if (this.rootsLoaded || this.initialRootItems === null) return;
    this.rootItems = this.initialRootItems;
    this.rootsLoaded = true;
  }

  /**
   * 读取初始根证书；只执行一次。
   *
   * @returns 初始化完成的 promise。
   */
  async ensureRoots(): Promise<void> {
    if (this.rootsLoaded || this.destroyed) return;
    if (!this.rootsPromise) {
      // 初始根加载期间可能发生 setRoots/addRoots；加载完成后仅当根代次未变
      // 且服务仍存活时才允许写入，避免旧默认值覆盖新配置。
      const generation = this.rootsGeneration;
      const destroyed = this.destroyed;
      this.rootsPromise = (async () => {
        const configured = this.options.rootCertificates ?? [];
        const items = configured.length > 0 ? await this.loadRoots(configured) : [];
        if (destroyed || this.destroyed) return;
        // 代次已变化时不能覆盖新配置，但结果仍需保留给并发 addRoots 合并。
        this.initialRootItems = items;
        if (generation !== this.rootsGeneration) return;
        this.rootItems = items;
        this.rootsLoaded = true;
      })().finally(() => {
        this.rootsPromise = null;
      });
    }
    await this.rootsPromise;
  }

  /** 打开验证面板；验证中/未验证由面板负责展示。 */
  openPanel(): void {
    if (this.destroyed) {
      throw new OFDViewerError('OFD_DESTROYED', '阅读器已销毁');
    }
    if (!this.enabled) {
      throw new OFDViewerError('OFD_CRYPTO_UNSUPPORTED', this.text.cryptoDisabled);
    }
    const shell = getUIShell(this.host);
    if (!shell) {
      throw new OFDViewerError('OFD_UNSUPPORTED', '内置 UI 未挂载，无法打开验证面板');
    }
    if (!this.panel) this.panel = new VerificationPanel(this.host, this, shell);
    this.panel.open();
  }

  /** 文档切换/关闭时关闭面板。 */
  closePanel(): void {
    this.panel?.close(false);
  }

  /** 是否应自动验证；无签名且无完整性保护时跳过。 */
  shouldAutoVerify(preparation: CryptoOpenPreparation): boolean {
    if (!this.enabled || !this.autoVerify || !this.host.isFeatureEnabled('verification')) {
      return false;
    }
    if (preparation.kind === 'decrypted') {
      return (
        preparation.inspection.signatures.length > 0 || preparation.inspection.integrityPresent
      );
    }
    const inspection = preparation.inspection;
    return Boolean(
      inspection && (inspection.signatures.length > 0 || inspection.integrityPresent),
    );
  }

  /** 释放面板与缓存。 */
  destroy(): void {
    if (this.destroyed) return;
    for (const off of this.offs.splice(0)) off();
    this.invalidateVerification();
    this.destroyed = true;
    this.panel?.destroy();
    this.panel = null;
    this.rootItems = [];
    this.initialRootItems = null;
    this.report = undefined;
    this.target = null;
  }

  // -------------------------------------------------------------------------
  // 内部：打开与解密
  // -------------------------------------------------------------------------

  /** 共享 crypto 选项。 */
  private cryptoOptions(): {
    limits?: CryptoViewerOptions['limits'];
    signal?: AbortSignal;
    onWarning?: (warning: CryptoWarning) => void;
    sm2UserId?: string;
    now?: Date;
  } {
    return {
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(this.options.onWarning ? { onWarning: this.options.onWarning } : {}),
      ...(this.options.sm2UserId !== undefined ? { sm2UserId: this.options.sm2UserId } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    };
  }

  /** 验证目标参数。 */
  private targetOptions(target: VerificationTarget): {
    source?: CryptoSource;
    container?: VirtualContainer;
  } {
    return target.kind === 'source'
      ? { source: target.source }
      : { container: target.container };
  }

  /** 转发 crypto warning。 */
  private forwardWarnings(warnings: readonly CryptoWarning[]): void {
    for (const warning of warnings) this.host.warnCrypto(warning.code, warning.message);
  }

  /**
   * 用已知凭据解密。
   *
   * @param source 密文来源。
   * @param credentials 凭据。
   * @param signal 取消信号。
   * @param inspection 检测结果。
   * @returns 解密准备结果。
   */
  private async decryptWithCredentials(
    source: CryptoSource,
    credentials: CryptoCredential | readonly CryptoCredential[],
    signal: AbortSignal,
    inspection: OfdInspection,
  ): Promise<CryptoOpenPreparation> {
    try {
      const result = await openDecryptingContainer({
        source,
        credentials,
        signal,
        ...this.cryptoOptions(),
      });
      this.forwardWarnings(result.warnings);
      this.openEncryptionInfo = { encrypted: true, decrypted: true };
      return {
        kind: 'decrypted',
        source,
        container: result.container,
        inspection: result.inspection ?? inspection,
        layers: result.layers,
      };
    } catch (error) {
      throw this.mapOpenError(error, signal);
    }
  }

  /**
   * 弹出内置登录框并重试解密。
   *
   * @param source 密文来源。
   * @param inspection 检测结果。
   * @param signal 外部取消信号。
   * @returns 解密准备结果。
   */
  private async decryptWithPrompt(
    source: CryptoSource,
    inspection: OfdInspection,
    signal: AbortSignal,
  ): Promise<CryptoOpenPreparation> {
    const shell = getUIShell(this.host);
    if (!shell) {
      throw new OFDViewerError('OFD_UNSUPPORTED', '内置 UI 未挂载，无法收集解密凭据');
    }
    const internal = new AbortController();
    return new Promise<CryptoOpenPreparation>((resolve, reject) => {
      let settled = false;
      let dialog: CredentialDialog | null = null;
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        dialog?.close();
        dialog = null;
      };
      const cancel = (cause?: unknown): void => {
        if (settled) return;
        settled = true;
        internal.abort();
        cleanup();
        reject(
          new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled, {
            ...(cause !== undefined ? { cause } : {}),
          }),
        );
      };
      const onAbort = (): void => cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }

      dialog = new CredentialDialog({
        shell,
        inspection,
        text: this.text,
        onSubmit: async (credential) => {
          try {
            const result = await this.decryptWithCredentials(
              source,
              credential,
              internal.signal,
              inspection,
            );
            // 外部取消与解密完成可能竞争：已取消时必须丢弃刚打开的容器。
            if (settled || internal.signal.aborted) {
              if (result.kind === 'decrypted') {
                await closeDecryptedContainer(result.container);
              }
              return;
            }
            settled = true;
            cleanup();
            resolve(result);
          } catch (error) {
            if (settled) return;
            if (internal.signal.aborted) {
              cancel(error);
              return;
            }
            throw error;
          }
        },
        onCancel: () => cancel(),
      });
      dialog.open();
    });
  }

  /** 把解密错误映射为 UI 错误。 */
  private mapOpenError(error: unknown, signal: AbortSignal): OFDViewerError {
    if (isOFDViewerError(error)) return error;
    if (signal.aborted || isAbortCryptoError(error)) {
      return new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled, {
        cause: error,
      });
    }
    if (isCryptoError(error)) {
      if (error.code === 'CRYPTO_CREDENTIALS_REQUIRED') {
        return new OFDViewerError(
          'OFD_CRYPTO_CREDENTIAL_REQUIRED',
          this.text.credentialRequired,
          { cause: error },
        );
      }
      if (error.code === 'CRYPTO_WRONG_PASSWORD') {
        return new OFDViewerError('OFD_CRYPTO_FAILED', this.text.credentialWrongPassword, {
          cause: error,
        });
      }
      if (error.code === 'CRYPTO_UNSUPPORTED_ENCRYPTION') {
        return new OFDViewerError('OFD_CRYPTO_UNSUPPORTED', this.text.cryptoUnsupported, {
          cause: error,
        });
      }
    }
    return new OFDViewerError('OFD_CRYPTO_FAILED', this.text.credentialDecryptFailed, {
      cause: error,
    });
  }

  /** 把验证错误映射为 UI 错误。 */
  private toVerificationError(error: unknown): OFDViewerError {
    if (isOFDViewerError(error)) return error;
    if (isAbortCryptoError(error)) {
      return new OFDViewerError('OFD_CRYPTO_CANCELLED', this.text.cryptoCancelled, {
        cause: error,
      });
    }
    return new OFDViewerError('OFD_CRYPTO_FAILED', this.text.verifyFailed, { cause: error });
  }

  // -------------------------------------------------------------------------
  // 内部：信任根
  // -------------------------------------------------------------------------

  /**
   * 把 UI 的四态根证书来源读取为原始字节并转换为逐张 DER。
   *
   * `data` 直接使用；`url` 由浏览器 `fetch` 读取；`path`/`filePath` 交给宿主
   * `certificateLoader`。转换统一调用 crypto 的 `certificatesToDer`，crypto
   * 证书接口只接收 DER，不感知 UI 的路径/URL 形态。
   *
   * @param root UI 根证书来源。
   * @returns 逐张证书 DER。
   * @throws {Error} 缺少加载器、网络失败或加载结果为空。
   */
  private async resolveRootDers(root: CertificateSource): Promise<readonly CertificateDer[]> {
    let bytes: Uint8Array;
    if ('data' in root) {
      bytes = root.data instanceof ArrayBuffer ? new Uint8Array(root.data) : root.data;
    } else if ('url' in root) {
      const response = await fetch(root.url, {
        headers: root.headers,
        signal: this.options.signal,
      });
      if (!response.ok) throw new Error(`加载根证书失败：HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      const loader = this.options.certificateLoader;
      if (!loader) throw new Error('没有配置 certificateLoader，无法读取根证书路径');
      const loaded = await loader(root);
      if (!loaded) throw new Error('certificateLoader 未返回证书字节');
      bytes = loaded instanceof ArrayBuffer ? new Uint8Array(loaded) : loaded;
    }
    return certificatesToDer(bytes, this.certificateLimits());
  }

  /**
   * 加载根证书。
   *
   * URL/解析失败只 warning；path/filePath 的 loader 异常向上抛出并保留 cause，
   * 由 setRoots/addRoots 统一包装为 OFD_CRYPTO_FAILED。
   *
   * @param roots 根证书来源。
   * @returns 成功解析的根证书条目。
   * @throws {OFDViewerError} path/filePath loader 抛错或返回空时。
   */
  private async loadRoots(roots: readonly CertificateSource[]): Promise<TrustRootItem[]> {
    const items: TrustRootItem[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      let ders: readonly CertificateDer[];
      if ('path' in root || 'filePath' in root) {
        const loader = this.options.certificateLoader;
        if (!loader) {
          // Web 默认不支持 path/filePath；没有 loader 只 warning，不阻塞。
          this.warnRootSource(root);
          continue;
        }
        let loaded: Uint8Array | ArrayBuffer | null;
        try {
          loaded = await loader(root);
        } catch (error) {
          throw new OFDViewerError('OFD_CRYPTO_FAILED', this.text.rootsInvalid, {
            cause: error,
          });
        }
        if (!loaded) {
          this.warnRootSource(root);
          continue;
        }
        try {
          ders = certificatesToDer(loaded, this.certificateLimits());
        } catch {
          this.warnRootSource(root);
          continue;
        }
      } else {
        try {
          ders = await this.resolveRootDers(root);
        } catch {
          // url/data 读取或转换失败只 warning，继续加载其余根。
          this.warnRootSource(root);
          continue;
        }
      }
      try {
        const certificates = await loadCertificates(ders, {
          ...this.certificateLimits(),
          ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
        const fresh = certificates
          .map((certificate) => toCertificateSummary(certificate))
          .filter((summary) => {
            if (seen.has(summary.fingerprintSha256)) return false;
            seen.add(summary.fingerprintSha256);
            return true;
          });
        if (fresh.length === 0) continue;
        items.push({ input: root, ders, summaries: fresh });
      } catch {
        this.warnRootSource(root);
      }
    }
    return items;
  }

  /**
   * 根证书转换/加载共用的字节上限。
   *
   * @returns crypto 证书加载选项；`maxBytes` 单位 byte。
   */
  private certificateLimits(): { maxBytes?: number } {
    return this.options.limits?.maxAsn1Bytes
      ? { maxBytes: this.options.limits.maxAsn1Bytes }
      : {};
  }

  /** 根证书单项失败只 warning。 */
  private warnRootSource(root: CertificateSource): void {
    this.host.warnCrypto(
      'W_CRYPTO_CERT_SOURCE_UNSUPPORTED',
      `${this.text.rootsInvalid}：${describeRootSource(root)}`,
    );
  }

  /** 根证书变化后刷新面板；报告已由根变更流程失效。 */
  private updateConfig(): void {
    this.panel?.render();
  }
}

/**
 * 把引擎来源收窄为 crypto 支持的来源。
 *
 * @param source 规范化来源。
 * @returns crypto 来源；不支持时 null。
 */
function toCryptoSource(source: OFDSource): CryptoSource | null {
  switch (source.kind) {
    case 'arraybuffer':
      return { kind: 'arraybuffer', data: source.data };
    case 'blob':
      return { kind: 'blob', blob: source.blob };
    case 'custom':
      // UI 的 HttpByteSource 交给 crypto 按需读取；crypto 会隔离为不转发 close
      // 的视图，因此关闭 crypto 容器不会误关 UI 的字节源。
      return { kind: 'byte-source', source: source.source };
    default: {
      // engine 新 API 已移除 url 变体；保留运行期兼容，旧调用方仍可传 URL。
      const legacy = source as {
        readonly kind?: unknown;
        readonly url?: unknown;
        readonly headers?: Record<string, string>;
      };
      if (legacy.kind === 'url' && typeof legacy.url === 'string') {
        return {
          kind: 'url',
          url: legacy.url,
          ...(legacy.headers ? { headers: legacy.headers } : {}),
        };
      }
      return null;
    }
  }
}

/** 判断 crypto 取消错误。 */
function isAbortCryptoError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (isCryptoError(error) && error.code === 'CRYPTO_ABORTED')
  );
}

/** 关闭已解密但尚未移交阅读器的容器；关闭失败不覆盖原始取消错误。 */
async function closeDecryptedContainer(container: VirtualContainer): Promise<void> {
  try {
    await container.close();
  } catch {
    // 取消路径只保证尝试释放；容器实现应保证 close 幂等。
  }
}

/** 根证书来源的可读描述；不包含证书内容。 */
function describeRootSource(root: CertificateSource): string {
  if ('name' in root && root.name) return root.name;
  if ('url' in root) return root.url;
  if ('path' in root) return root.path;
  if ('filePath' in root) return root.filePath;
  return 'data';
}

/**
 * 把凭据错误映射为面向用户的提示；不输出底层密文/密钥。
 *
 * @param error 原始错误。
 * @param text 文案。
 * @returns 提示文本。
 */
export function describeCredentialError(error: unknown, text: CryptoText): string {
  if (isCryptoError(error)) {
    switch (error.code) {
      case 'CRYPTO_WRONG_PASSWORD':
      case 'CRYPTO_DECRYPT_FAILED':
      case 'CRYPTO_USER_NOT_FOUND':
      case 'CRYPTO_USER_AMBIGUOUS':
        return text.credentialWrongPassword;
      case 'CRYPTO_PRIVATE_KEY_INVALID':
      case 'CRYPTO_PRIVATE_KEY_MISMATCH':
      case 'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION':
        return text.credentialPrivateKeyInvalid;
      case 'CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED':
        return text.credentialPassphraseRequired;
      case 'CRYPTO_UNSUPPORTED_ENCRYPTION':
        return text.cryptoUnsupported;
      default:
        break;
    }
  }
  if (isOFDViewerError(error)) return error.message;
  return text.credentialDecryptFailed;
}
