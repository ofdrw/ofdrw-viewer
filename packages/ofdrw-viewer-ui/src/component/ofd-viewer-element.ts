/**
 * `<ofd-viewer>` Web Component 薄壳（设计方案 §4.4）。
 *
 * 使用 light DOM 挂载核心阅读器：属性映射到 `OFDViewer` 方法，复杂配置走
 * `features` property；组件只负责实例生命周期与事件桥接，不复制任何阅读器逻辑。
 */

import '../compat';
import { OFDViewer } from '../index';
import {
  bindViewerEvents,
  isTheme,
  isUsableSource,
  mergeFeatures,
  readFontAttribute,
  readLayerPanelOptions,
  readNumber,
  readRotationAttribute,
  readScaleAttribute,
  readSidebarAttribute,
  readSupersampleAttribute,
  toDomEventName,
  toRotation,
  type FeatureDisplay,
  type SidebarView,
  type ViewerFeatures,
} from './support';
import type {
  CertificateSource,
  CertificateSummary,
  CryptoViewerOptions,
  SupersamplePreset,
  ExportOfdOptions,
  ExportOfdResult,
  FontSource,
  LocalFontsStatus,
  VerificationReport,
  ViewerFontOptions,
  ViewerSource,
} from '../index';

/** 需要监听并写回实例的属性。 */
const OBSERVED_ATTRIBUTES = [
  'src',
  'page',
  'scale',
  'rotation',
  'theme',
  'locale',
  'sidebar',
  'layer-panel',
  'font-default',
  'font-supplementary',
  'supersample',
] as const;

/** 自定义元素标签名。 */
export const OFD_VIEWER_TAG = 'ofd-viewer';

/**
 * 实例尚未创建时的本机字体状态。
 *
 * 元素未连接或已销毁时没有底层阅读器，按「能力不可见、开关关闭、尚未表态」返回，
 * 使 `getLocalFontsStatus()` 在任何时刻都能给出完整快照而不抛错。
 */
const DISABLED_LOCAL_FONTS_STATUS: LocalFontsStatus = Object.freeze({
  supported: false,
  enabled: false,
  userState: 'undecided',
  permission: 'unsupported',
  visible: false,
  loading: false,
});

/**
 * `<ofd-viewer>` 自定义元素。
 *
 * 无 `src`/`source` 时仍创建实例，以便读取页面查询参数 `?file=` / `?base64=`；
 * 设置 `src`/`source` 后打开对应文档。断开连接会销毁实例，重新连接时按当前
 * 属性重建，确保不残留 canvas、事件与渲染任务。
 */
export class OFDViewerElement extends HTMLElement {
  /** 需要观察的属性。 */
  static get observedAttributes(): readonly string[] {
    return OBSERVED_ATTRIBUTES;
  }

  /** 底层阅读器；未创建时为 null。 */
  private instance: OFDViewer | null = null;

  /** 已配置的功能补丁；在实例创建前也可设置。 */
  private featurePatch: ViewerFeatures = {};

  /** 功能展示方式；在实例创建前也可设置。 */
  private display: FeatureDisplay | undefined;

  /** 通过 property 传入的复杂来源（Blob/ArrayBuffer 等）。 */
  private sourceValue: ViewerSource | null = null;

  /** 密码能力配置；创建实例时读取，实例存在后修改不重建。 */
  private cryptoValue: CryptoViewerOptions | undefined;

  /** 字体配置；创建实例时读取，实例存在后修改不重建。 */
  private fontValue: ViewerFontOptions | undefined;

  /** 取消核心事件订阅。 */
  private unbindEvents: (() => void) | null = null;

  /**
   * 构造函数不访问 DOM 属性/子节点：自定义元素规范禁止在构造阶段添加属性。
   * 默认尺寸在 `connectedCallback` 中设置。
   */
  constructor() {
    super();
  }

  /** 底层阅读器；只读。 */
  get viewer(): OFDViewer | null {
    return this.instance;
  }

  /** 当前功能补丁；返回副本。 */
  get features(): ViewerFeatures {
    return { ...this.featurePatch };
  }

  /**
   * 设置功能补丁。
   *
   * 设置时立即调用 `setFeatures`，不会重建实例。
   */
  set features(value: ViewerFeatures) {
    this.featurePatch = { ...value };
    this.instance?.setFeatures(this.featurePatch);
  }

  /** 密码能力配置；实例创建前设置生效。 */
  get crypto(): CryptoViewerOptions | undefined {
    return this.cryptoValue;
  }

  set crypto(value: CryptoViewerOptions | undefined) {
    this.cryptoValue = value;
  }

  /** 字体配置；实例创建前设置生效。 */
  get fonts(): ViewerFontOptions | undefined {
    return this.fontValue;
  }

  set fonts(value: ViewerFontOptions | undefined) {
    this.fontValue = value;
  }

  /** 当前复杂来源 property；未设置时为 null。 */
  get source(): ViewerSource | null {
    return this.sourceValue;
  }

  /**
   * 设置复杂来源；设置后立即打开文档，不会重建实例。
   */
  set source(value: ViewerSource | null) {
    this.sourceValue = value;
    if (value && isUsableSource(value)) this.openSource(value);
    else if (value === null) void this.instance?.close();
  }

  /** 组件连接时设置宿主尺寸并按当前属性创建阅读器。 */
  connectedCallback(): void {
    if (!this.style.display) this.style.display = 'block';
    if (!this.style.height) this.style.height = '100%';
    if (!this.style.minHeight) this.style.minHeight = '0';
    this.ensureViewer();
  }

  /** 组件断开时销毁阅读器与全部监听。 */
  disconnectedCallback(): void {
    this.destroyViewer();
  }

  /**
   * 属性变化时映射到实例方法。
   *
   * @param name 属性名。
   * @param oldValue 旧值。
   * @param newValue 新值。
   */
  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    if (oldValue === newValue) return;
    // 只在创建实例时生效的属性：变更后销毁并按新属性重建（与 src 行为一致）。
    if (
      name === 'font-default' ||
      name === 'font-supplementary' ||
      name === 'supersample' ||
      name === 'layer-panel'
    ) {
      this.destroyViewer();
      this.ensureViewer();
      return;
    }
    if (name === 'src') {
      if (newValue === null || newValue.trim() === '') {
        this.sourceValue = null;
        void this.instance?.close();
        return;
      }
      this.sourceValue = newValue;
      this.openSource(newValue);
      return;
    }
    const viewer = this.instance;
    if (!viewer) return;
    try {
      switch (name) {
        case 'page': {
          const page = readNumber(newValue);
          if (page !== undefined) viewer.goToPage(page);
          break;
        }
        case 'scale': {
          const scale = readScaleAttribute(this);
          if (typeof scale === 'number') viewer.setScale(scale);
          else if (scale) viewer.setZoomMode(scale);
          break;
        }
        case 'rotation': {
          const rotation = toRotation(readNumber(newValue));
          if (rotation !== undefined) viewer.setRotation(rotation);
          break;
        }
        case 'theme': {
          if (isTheme(newValue)) viewer.setTheme(newValue);
          break;
        }
        case 'locale': {
          if (newValue) viewer.setLocale(newValue);
          break;
        }
        case 'sidebar': {
          const sidebar = readSidebarAttribute(this);
          if (sidebar === null) viewer.closeSidebar();
          else if (sidebar) viewer.openSidebar(sidebar);
          break;
        }
        default:
          break;
      }
    } catch {
      // 功能被关闭等同步错误不应冒泡到自定义元素回调。
    }
  }

  /**
   * 合并功能补丁；等价于设置 `features` property。
   *
   * @param patch 功能补丁。
   * @param options 展示方式。
   */
  setFeatures(patch: ViewerFeatures, options: { display?: FeatureDisplay } = {}): void {
    this.featurePatch = mergeFeatures(this.featurePatch, patch);
    if (options.display !== undefined) this.display = options.display;
    this.instance?.setFeatures(patch, options);
  }

  /** 打开文档；实例不存在时先创建。省略来源时按页面查询参数解析。 */
  async open(source?: ViewerSource): Promise<void> {
    if (source !== undefined) this.sourceValue = source;
    if (!this.instance) {
      const created = this.ensureViewer();
      if (created) await created.ready;
      return;
    }
    await this.instance.open(source);
  }

  /** 关闭文档，保留元素与实例。 */
  async close(): Promise<void> {
    this.sourceValue = null;
    this.removeAttribute('src');
    await this.instance?.close();
  }

  /**
   * 重新验证当前文档。
   *
   * @param options 签名筛选与取消信号。
   * @returns 验证报告。
   */
  async verify(options?: {
    readonly signatureIds?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<VerificationReport> {
    if (!this.instance) throw new Error('阅读器尚未创建');
    return this.instance.verify(options);
  }

  /** 最近一次验证报告。 */
  getVerificationReport(): VerificationReport | undefined {
    return this.instance?.getVerificationReport();
  }

  /**
   * 设置/替换信任根并重新验证。
   *
   * @param roots 根证书来源。
   * @returns 解析后的证书摘要。
   */
  async setRootCertificates(
    roots: readonly CertificateSource[],
  ): Promise<readonly CertificateSummary[]> {
    if (!this.instance) return [];
    return this.instance.setRootCertificates(roots);
  }

  /** 当前信任根摘要。 */
  getRootCertificates(): readonly CertificateSummary[] {
    return this.instance?.getRootCertificates() ?? [];
  }

  /** 打开工具栏验证面板。 */
  openVerificationPanel(): void {
    this.instance?.openVerificationPanel();
  }

  /**
   * 读取本机字体状态快照。
   *
   * 只做纯查询（能力探测 + 权限状态），**不触发**任何权限申请，元素尚未创建实例时
   * 返回未启用的默认状态。
   *
   * @returns 本机字体状态。
   */
  getLocalFontsStatus(): LocalFontsStatus {
    return this.instance?.getLocalFontsStatus() ?? DISABLED_LOCAL_FONTS_STATUS;
  }

  /**
   * 设置「使用本机字体」开关。
   *
   * 传入 `true` 时核心会先申请浏览器授权，并**要求调用发生在用户点击事件的同步栈内**
   * （浏览器只接受用户手势内的权限申请）；在定时器或挂载回调中调用不会弹出授权框，
   * 开关会保持关闭。
   *
   * @param enabled 目标开关值。
   * @throws {Error} 元素尚未创建阅读器实例时。
   */
  async setLocalFontsEnabled(enabled: boolean): Promise<void> {
    if (!this.instance) throw new Error('阅读器尚未创建');
    return this.instance.setLocalFontsEnabled(enabled);
  }

  /**
   * 订阅本机字体状态变化。
   *
   * @param handler 状态回调。
   * @returns 退订函数；重复订阅互不影响。
   */
  onLocalFontsStatusChange(handler: (status: LocalFontsStatus) => void): () => void {
    return this.instance?.onLocalFontsStatusChange(handler) ?? (() => undefined);
  }

  /**
   * 导出当前 OFD 原文件。
   *
   * @param options 文件名与取消信号。
   * @returns 原文件结果；实例尚未创建时为 null。
   */
  async exportOfd(options?: ExportOfdOptions): Promise<ExportOfdResult | null> {
    if (!this.instance) return null;
    return this.instance.exportOfd(options);
  }

  /** 销毁实例；可重复调用。 */
  destroy(): void {
    this.destroyViewer();
  }

  /** 按当前属性创建实例。 */
  private ensureViewer(): OFDViewer | null {
    if (this.instance || !this.isConnected) return this.instance;
    const source = this.resolveSource();
    const page = readNumber(this.getAttribute('page'));
    const scale = readScaleAttribute(this);
    const rotation = readRotationAttribute(this);
    const theme = this.getAttribute('theme');
    const locale = this.getAttribute('locale');
    const sidebar = readSidebarAttribute(this);
    const fonts = this.resolveFonts();
    const supersample = readSupersampleAttribute(this);
    const layerPanel = readLayerPanelOptions(this);
    this.instance = new OFDViewer({
      container: this,
      ...(source === null ? {} : { source }),
      ...(page === undefined ? {} : { initialPage: page }),
      ...(scale === undefined ? {} : { initialScale: scale }),
      ...(rotation === undefined ? {} : { rotation }),
      ...(isTheme(theme) ? { theme } : {}),
      ...(locale ? { locale } : {}),
      ...(sidebar === undefined ? {} : { sidebar }),
      ...(Object.keys(this.featurePatch).length > 0 ? { features: this.featurePatch } : {}),
      ...(this.display === undefined ? {} : { featureDisplay: this.display }),
      ...(this.cryptoValue === undefined ? {} : { crypto: this.cryptoValue }),
      ...(fonts === undefined ? {} : { fonts }),
      ...(supersample === undefined ? {} : { supersample }),
      ...(layerPanel === undefined ? {} : { layerPanel }),
    });
    // 省略来源且页面无查询参数时 ready 会拒绝；错误卡已由核心展示，这里避免
    // 未处理的 Promise rejection。
    void this.instance.ready.catch(() => undefined);
    this.unbindEvents = bindViewerEvents(this.instance, (event, payload) => {
      this.dispatchEvent(
        new CustomEvent(toDomEventName(event), {
          detail: payload,
          bubbles: true,
          composed: true,
        }),
      );
    });
    return this.instance;
  }

  /** 读取 property 优先的文档来源。 */
  private resolveSource(): ViewerSource | null {
    if (isUsableSource(this.sourceValue)) return this.sourceValue;
    const attribute = this.getAttribute('src');
    return attribute && attribute.trim() !== '' ? attribute : null;
  }

  /**
   * 合并 `fonts` property 与两个字体简写属性。
   *
   * property 的 `default`/`supplementary` 由属性覆盖（属性是更具体的配置入口），
   * `loader`/`aliases` 只来自 property；两者都没有时返回 undefined，保持未引入
   * `fonts` 时的行为。
   *
   * @returns 字体配置；没有任何字体配置时 undefined。
   */
  private resolveFonts(): ViewerFontOptions | undefined {
    const defaults = readFontAttribute(this, 'font-default');
    const supplementary = readFontAttribute(this, 'font-supplementary');
    const base = this.fontValue;
    if (defaults === undefined && supplementary === undefined) return base;
    return {
      ...base,
      ...(defaults === undefined ? {} : { default: defaults }),
      ...(supplementary === undefined ? {} : { supplementary }),
    };
  }

  /** 打开来源；未连接时等待连接后由 `ensureViewer` 读取。 */
  private openSource(source: ViewerSource): void {
    if (!this.instance) {
      this.ensureViewer();
      return;
    }
    void this.instance.open(source).catch(() => {
      // 失败通过核心 error 事件与 onError 暴露。
    });
  }

  /** 销毁实例并解除事件。 */
  private destroyViewer(): void {
    this.unbindEvents?.();
    this.unbindEvents = null;
    this.instance?.destroy();
    this.instance = null;
  }
}

/**
 * 注册 `<ofd-viewer>`；重复调用安全。
 *
 * @param tagName 自定义元素标签名，默认 `ofd-viewer`。
 */
export function defineOFDViewerElement(tagName = OFD_VIEWER_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) customElements.define(tagName, OFDViewerElement);
}

// 作为 `./element` 入口时自动注册；核心入口不引用本模块。
defineOFDViewerElement();

export type {
  FeatureDisplay,
  SidebarView,
  SupersamplePreset,
  ViewerFeatures,
  ViewerSource,
};