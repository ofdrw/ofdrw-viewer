/**
 * `<ofd-viewer>` Web Component 薄壳（设计方案 §4.4）。
 *
 * 使用 light DOM 挂载核心阅读器：属性映射到 `OFDViewer` 方法，复杂配置走
 * `features` property；组件只负责实例生命周期与事件桥接，不复制任何阅读器逻辑。
 */
import { OFDViewer } from '../index';
import {
  bindViewerEvents,
  isTheme,
  isUsableSource,
  mergeFeatures,
  readNumber,
  readRotationAttribute,
  readScaleAttribute,
  readSidebarAttribute,
  toDomEventName,
  toRotation,
  type FeatureDisplay,
  type SidebarView,
  type ViewerFeatures,
} from './support';
import type { ViewerSource } from '../index';

/** 需要监听并写回实例的属性。 */
const OBSERVED_ATTRIBUTES = [
  'src',
  'page',
  'scale',
  'rotation',
  'theme',
  'locale',
  'sidebar',
] as const;

/** 自定义元素标签名。 */
export const OFD_VIEWER_TAG = 'ofd-viewer';

/**
 * `<ofd-viewer>` 自定义元素。
 *
 * 无 `src` 时不创建实例；设置 `src`/`source` 后再创建。断开连接会销毁实例，
 * 重新连接时按当前属性重建，确保不残留 canvas、事件与渲染任务。
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

  /** 打开文档；实例不存在时先创建。 */
  async open(source: ViewerSource): Promise<void> {
    this.sourceValue = source;
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

  /** 销毁实例；可重复调用。 */
  destroy(): void {
    this.destroyViewer();
  }

  /** 按当前属性创建实例。 */
  private ensureViewer(): OFDViewer | null {
    if (this.instance || !this.isConnected) return this.instance;
    const source = this.resolveSource();
    if (!source) return null;
    const page = readNumber(this.getAttribute('page'));
    const scale = readScaleAttribute(this);
    const rotation = readRotationAttribute(this);
    const theme = this.getAttribute('theme');
    const locale = this.getAttribute('locale');
    const sidebar = readSidebarAttribute(this);
    this.instance = new OFDViewer({
      container: this,
      source,
      ...(page === undefined ? {} : { initialPage: page }),
      ...(scale === undefined ? {} : { initialScale: scale }),
      ...(rotation === undefined ? {} : { rotation }),
      ...(isTheme(theme) ? { theme } : {}),
      ...(locale ? { locale } : {}),
      ...(sidebar === undefined ? {} : { sidebar }),
      ...(Object.keys(this.featurePatch).length > 0 ? { features: this.featurePatch } : {}),
      ...(this.display === undefined ? {} : { featureDisplay: this.display }),
    });
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

export type { FeatureDisplay, SidebarView, ViewerFeatures, ViewerSource };