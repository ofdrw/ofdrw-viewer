/**
 * 媒体呈现层（音视频与动作方案设计 §7.2 / §7.3 / §7.10）。
 *
 * 负责给播放器元素找地方放：
 * - **内联**：放入目标页的 `.ofd-page__media-layer`，坐标取图元矩形的 96 DPI 页面 px；
 * - **弹出式**：在阅读器根节点的对话框层里放模态浮层（焦点陷阱 + Esc 关闭）；
 * - **超限下载**：提示用户下载整个 OFD 原文件（复用附件大文件降级的既有路径）。
 *
 * 定位沿用文本层的坐标模型：媒体层自身已 `transform: scale(--scale-factor)`，
 * 因此子元素坐标就是**未缩放的 96 DPI 页面 px**，这里不做任何缩放计算。
 */

import type { MediaResource } from '@ofdrw/ofdrw-viewer-engine';
import { FocusTrap, restoreFocus } from '../../a11y';
import type { Translator } from '../../i18n';
import type { ActionAnchor, ActionExecutionContext } from '../types';
import type { MediaPlayerHandle } from './media-player';

/** 呈现层选项。 */
export interface MediaPresenterOptions {
  /** 阅读器根节点（弹出层挂在它下面，而不是页面内）。 */
  readonly root: HTMLElement;
  /**
   * 取对话框层容器。
   *
   * 惰性获取：actions 扩展可能在 UI shell 挂载前注册，构造时捕获的节点会失效。
   *
   * @returns 浮层挂载容器；不可用时回退根节点。
   */
  readonly getDialogLayer: () => HTMLElement;
  /** 读取页视图；用于取媒体层。 */
  readonly getPageView: (pageNumber: number) => { mediaLayer: HTMLElement } | undefined;
  /** 当前翻译器。 */
  readonly getTranslator: () => Translator;
  /** 读取打开来源，用于下载原文件的文件名。 */
  readonly getOrigin: () => { readonly kind: 'url'; readonly url: string } | { readonly kind: 'file'; readonly name: string } | { readonly kind: 'blob' } | undefined;
  /** 读取文档原始字节；超限媒体「下载原文件」使用。 */
  readonly readSourceBytes?: () => Promise<Uint8Array>;
  /** 触发下载。 */
  readonly downloadWholeOfd: (bytes: Uint8Array, filename: string) => void;
  /**
   * 内联播放器关闭回调。
   *
   * 内联模式没有浮层容器，关闭按钮点击后由调用方停止并移除播放器。
   *
   * @param handle 播放器句柄。
   */
  readonly onInlineClose?: (handle: MediaPlayerHandle) => void;
  /**
   * 弹出式浮层关闭回调（浮层内关闭按钮或替换旧浮层时触发）。
   *
   * 浮层移除后播放器元素已脱离文档，调用方需销毁对应实例，否则媒体会在后台继续播放。
   *
   * @param handle 被关闭浮层承载的播放器句柄。
   */
  readonly onPopupClose?: (handle: MediaPlayerHandle) => void;
}

/** 关闭浮层的选项。 */
export interface ClosePopupOptions {
  /**
   * 是否回调 `onPopupClose` 由调用方销毁播放器；默认 true。
   *
   * 文档关闭时播放器由 `destroyAll()` 统一销毁，传 false。
   */
  readonly dispose?: boolean;
}

/** 一个已打开的弹出式浮层。 */
interface PopupState {
  /** 浮层根节点。 */
  readonly element: HTMLElement;
  /** 焦点陷阱。 */
  readonly trap: FocusTrap;
  /** 触发前获得焦点的元素；关闭后焦点回到它。 */
  readonly trigger: HTMLElement | null;
  /** 承载的媒体元素；关闭时归还给管理器销毁。 */
  readonly handle: MediaPlayerHandle;
}

/**
 * 媒体呈现层。
 */
export class MediaPresenter {
  private readonly options: MediaPresenterOptions;
  /** 当前打开的弹出浮层；同一时刻只允许一个（避免声音叠加与焦点混乱）。 */
  private popup: PopupState | null = null;

  /**
   * @param options 呈现选项。
   */
  constructor(options: MediaPresenterOptions) {
    this.options = options;
  }

  /**
   * 把播放器嵌入页面媒体层。
   *
   * GB/T 33190-2016 §12：图元对象关联的视频播放时，"宜使用图元的外观区域大小
   * 作为嵌入式播放窗口"。因此只有拿到**有效的外观区域**（宽高均为正）才内联，
   * 否则回退弹出式，避免出现零尺寸播放窗口。
   *
   * @param handle 播放器句柄。
   * @param context 执行上下文（含图元锚点）。
   * @returns 是否成功嵌入；false 时应改用弹出式。
   */
  presentInline(handle: MediaPlayerHandle, context: ActionExecutionContext): boolean {
    const pageIndex = handle.pageIndex ?? context.pageIndex;
    if (pageIndex === undefined || pageIndex < 0) return false;
    const pageView = this.options.getPageView(pageIndex + 1);
    if (!pageView) return false;
    const anchor = context.anchor;
    if (!anchor) return false;
    // 外观区域必须可用：零宽高（图元缺失或退化为点）时内联不可见，改用弹出式。
    const { bbox } = anchor;
    if (!(bbox.width > 0) || !(bbox.height > 0)) return false;

    const element = handle.element;
    // 从弹出式切回内联时先摘掉浮层样式，否则 width:100%/static 定位会覆盖内联几何。
    element.classList.remove('ofd-media--popup');
    // 坐标即 96 DPI 页面 px；媒体层容器已承担缩放与旋转。
    // 几何必须写在 wrapper 上：内部 `.ofd-media` 是 `position: static`，只填满 wrapper。
    const wrapper = this.ensureInlineWrapper(handle, pageView.mediaLayer);
    applyBox(wrapper, anchor);
    element.setAttribute(
      'aria-label',
      this.options.getTranslator().t('media.video'),
    );
    wrapper.appendChild(element);
    // 媒体层默认 `aria-hidden="true"`（空容器无语义）；挂入含原生控件的播放器后
    // 必须移除，否则辅助技术被禁止访问，浏览器会发出 aria-hidden 焦点冲突警告。
    pageView.mediaLayer.removeAttribute('aria-hidden');
    // 内联播放器没有浮层可关闭：提供浮层角标式关闭按钮，确保用户随时能停止播放。
    this.ensureInlineClose(wrapper, handle);
    return true;
  }

  /**
   * 确保内联播放器的关闭按钮存在。
   *
   * 内联模式下播放器嵌在页面里，没有浮层的关闭入口；若不提供按钮，用户只能靠
   * 再次执行其它动作才能停下视频。按钮固定在容器右上角，`pointer-events: auto`。
   *
   * @param wrapper 内联容器。
   * @param handle 播放器句柄。
   */
  private ensureInlineClose(wrapper: HTMLElement, handle: MediaPlayerHandle): void {
    if (wrapper.querySelector('.ofd-media__close')) return;
    const doc = wrapper.ownerDocument;
    const translator = this.options.getTranslator();
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ofd-button ofd-media__close';
    button.setAttribute('aria-label', translator.t('media.close'));
    button.textContent = '×';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      this.options.onInlineClose?.(handle);
    });
    wrapper.appendChild(button);
  }

  /**
   * 确保内联容器存在并已定位。
   *
   * @param handle 播放器句柄。
   * @param layer 媒体层。
   * @returns 内联容器。
   */
  private ensureInlineWrapper(handle: MediaPlayerHandle, layer: HTMLElement): HTMLElement {
    const existing = layer.querySelector<HTMLElement>(
      `[data-ofd-media-wrapper="${cssEscape(handle.resourceId)}"]`,
    );
    if (existing) return existing;
    const doc = layer.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.className = 'ofd-media-wrapper';
    wrapper.setAttribute('data-ofd-media-wrapper', handle.resourceId);
    layer.appendChild(wrapper);
    return wrapper;
  }

  /**
   * 移除内联播放器，让页面上的封面帧重新可见。
   *
   * @param handle 播放器句柄。
   */
  removeInline(handle: MediaPlayerHandle): void {
    const element = handle.element;
    const wrapper = element.parentElement;
    const layer = wrapper?.parentElement;
    element.remove();
    // 清掉内联几何，避免实例被复用到弹出式时残留绝对定位。
    element.removeAttribute('style');
    if (wrapper && wrapper.classList.contains('ofd-media-wrapper')) wrapper.remove();
    // 媒体层回到空容器状态，恢复对辅助技术隐藏。
    if (layer && layer.childElementCount === 0) {
      layer.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * 打开弹出式播放器。
   *
   * 音频无画面，需要浮层承载控件；文档级/页级/大纲级视频也没有图元矩形可依附。
   *
   * @param handle 播放器句柄。
   * @param title 浮层标题。
   */
  presentPopup(handle: MediaPlayerHandle, title: string): void {
    const current = this.popup;
    if (current && current.handle === handle && current.element.isConnected) {
      // 同一实例已在浮层中：复用现有浮层，重复执行 `Play` 不再叠加浮层。
      return;
    }
    // 已有浮层：先关闭旧的，避免多个播放器同时出声。
    if (current) this.closePopup();

    const doc = this.options.root.ownerDocument;
    const translator = this.options.getTranslator();
    const trigger = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

    const element = doc.createElement('div');
    element.className = 'ofd-media-popup';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    element.setAttribute('aria-label', title);

    const header = doc.createElement('div');
    header.className = 'ofd-media-popup__header';
    const heading = doc.createElement('h2');
    heading.className = 'ofd-media-popup__title';
    heading.textContent = title;
    const closeButton = doc.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'ofd-button ofd-media-popup__close';
    closeButton.setAttribute('aria-label', translator.t('media.close'));
    closeButton.textContent = '×';
    header.append(heading, closeButton);

    const bodyNode = doc.createElement('div');
    bodyNode.className = 'ofd-media-popup__body';
    // 实例可能正内联在页面里：迁移前清掉它的内联容器，否则媒体层会留下空壳。
    this.removeInline(handle);
    // 弹出式里视频需要占满浮层宽度；音频用原生控件（iOS 无 UI）。
    handle.element.classList.add('ofd-media--popup');
    handle.element.removeAttribute('style');
    if (handle.kind === 'video') {
      handle.element.setAttribute('aria-label', translator.t('media.video'));
    } else {
      handle.element.setAttribute('aria-label', translator.t('media.audio'));
    }
    bodyNode.appendChild(handle.element);

    // 自动播放被拦截时静音重试留下 muted=true，这里提供「取消静音」入口。
    const muteRow = this.createMuteToggle(handle);
    element.append(header, bodyNode, muteRow);
    this.mountPopup(element);

    const trap = new FocusTrap(element, {
      onEscape: () => this.closePopup(),
      restoreFocus: false,
    });
    trap.activate({ moveFocus: false });
    closeButton.focus();

    this.popup = { element, trap, trigger, handle };
    closeButton.addEventListener('click', () => this.closePopup());

    // 视频结束自动关浮层，避免留下静止黑框，且让页面封面帧重新可见。
    // 音频不自动关闭：声音播完后用户往往还要重播或确认，浮层应保留原生控件。
    if (handle.kind === 'video') {
      handle.element.addEventListener('ended', () => this.closePopup(), { once: true });
    }
  }

  /**
   * 把浮层挂到对话框层，并确保它真的可见。
   *
   * 对话框层在为空时 `display: none`，且可能尚未挂载或尺寸为 0；一旦挂载后仍无
   * 可见尺寸，就回退挂到阅读器根节点，避免"声音在响但看不到任何界面"。
   *
   * @param element 浮层根节点。
   */
  private mountPopup(element: HTMLElement): void {
    const layer = this.options.getDialogLayer();
    layer.appendChild(element);
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return;
    const root = this.options.root;
    if (root === layer || element.parentElement !== layer) return;
    root.appendChild(element);
  }

  /**
   * 创建「静音/取消静音」切换控件。
   *
   * @param handle 播放器句柄。
   * @returns 控件元素。
   */
  private createMuteToggle(handle: MediaPlayerHandle): HTMLElement {
    const doc = this.options.root.ownerDocument;
    const translator = this.options.getTranslator();
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ofd-button ofd-media-popup__mute';
    const refresh = (): void => {
      const muted = handle.element.muted;
      button.textContent = muted ? translator.t('media.unmute') : translator.t('media.mute');
      button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    };
    refresh();
    button.addEventListener('click', () => {
      handle.element.muted = !handle.element.muted;
      refresh();
    });
    // 元素自身的静音状态可能被原生控件改变，播放时同步一次。
    handle.element.addEventListener('volumechange', refresh);
    return button;
  }

  /**
   * 关闭当前弹出式浮层并把焦点还给触发元素。
   *
   * @param options `dispose` 为 true 时回调 `onPopupClose` 请调用方销毁播放器实例；
   *   文档关闭时由调用方统一销毁，传 false 避免重复销毁。
   */
  closePopup(options: ClosePopupOptions = {}): void {
    const current = this.popup;
    if (!current) return;
    this.popup = null;
    current.trap.deactivate({ restoreFocus: false });
    // 媒体元素归还给管理器（由调用方销毁实例与 ObjectURL）。
    current.handle.element.remove();
    current.element.remove();
    if (options.dispose !== false) this.options.onPopupClose?.(current.handle);
    restoreFocus(current.trigger);
  }

  /**
   * 关闭全部浮层；文档关闭时调用。
   *
   * 播放器实例由调用方的批量销毁统一处理，这里只清理浮层 DOM 与焦点。
   */
  destroy(): void {
    this.closePopup({ dispose: false });
  }

  /**
   * 超限媒体的下载提示：询问后下载整个 OFD 原文件。
   *
   * 与附件大文件降级同一套路径（`readSourceBytes()`），不新增下载逻辑。
   *
   * @param resource 媒体资源。
   */
  async offerDownload(resource: MediaResource): Promise<void> {
    const translator = this.options.getTranslator();
    const doc = this.options.root.ownerDocument;
    const confirmed = await this.confirmLargeMedia(doc, translator, resource);
    if (!confirmed) return;
    if (!this.options.readSourceBytes) return;
    const bytes = await this.options.readSourceBytes();
    this.options.downloadWholeOfd(bytes, this.resolveOfdFilename());
  }

  /**
   * 询问用户是否下载整个 OFD 原文件。
   *
   * @param doc 宿主文档。
   * @param translator 翻译器。
   * @param resource 超出播放上限的媒体资源。
   * @returns 用户确认时 true。
   */
  private confirmLargeMedia(
    doc: Document,
    translator: Translator,
    resource: MediaResource,
  ): Promise<boolean> {
    const view = doc.defaultView;
    if (!view?.confirm) return Promise.resolve(false);
    const size = formatBytes(resource.sizeBytes ?? 0);
    return Promise.resolve(
      view.confirm(
        `${translator.t('media.tooLargeTitle')}\n\n${translator.t('media.tooLarge', { size })}`,
      ),
    );
  }

  /**
   * 推导 OFD 原文件下载名。
   *
   * @returns 文件名（含 `.ofd`）。
   */
  private resolveOfdFilename(): string {
    const origin = this.options.getOrigin();
    const path = origin?.kind === 'url' ? origin.url : origin?.kind === 'file' ? origin.name : '';
    const segment = path.split('?')[0]?.split('#')[0]?.split(/[\\/]/).pop() ?? '';
    const stem = segment.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const name = stem || 'document';
    return name.toLowerCase().endsWith('.ofd') ? name : `${name}.ofd`;
  }
}

/**
 * 把图元矩形写到媒体元素的内联样式。
 *
 * 坐标单位是 96 DPI 页面 px（未旋转、未缩放），由媒体层容器统一缩放与旋转。
 *
 * @param element 媒体元素。
 * @param anchor 图元锚点（含 bbox）。
 */
function applyBox(element: HTMLElement, anchor: ActionAnchor): void {
  const { bbox } = anchor;
  element.style.left = `${bbox.left}px`;
  element.style.top = `${bbox.top}px`;
  element.style.width = `${bbox.width}px`;
  element.style.height = `${bbox.height}px`;
}

/**
 * 格式化字节数为可读文本。
 *
 * @param bytes 字节数。
 * @returns 例如 `12.5 MB`。
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * CSS 属性选择器转义；资源 ID 来自文档，可能含特殊字符。
 *
 * @param value 原始字符串。
 * @returns 转义后可直接放进 `[attr="..."]` 的值。
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}