/**
 * 单页视图（设计方案 §6.3 / §12.2）。
 *
 * `PageView` 只管理一页的 DOM、canvas 生命周期与加载/错误态，不决定何时渲染；
 * 渲染由 `RenderQueue` + `OFDViewer` 调度。页壳（1000 页）先创建但只有在真正
 * 渲染时才分配 canvas，从而保证 1000 页文档只给可见/预取页创建画布。
 *
 * 旋转通过纸面容器的 CSS transform 完成：外层页盒交换宽高，canvas、文字层、
 * 签章覆盖层一起旋转；文字层坐标不需要重算。
 */

import { replaceChildren } from './compat';

import type { CanvasRenderingContext2DLike, PageInfo } from '@ofdrw/ofdrw-viewer-engine';
import type { Translator } from './i18n';
import type { PageBox } from './page-layout';
import type { Rotation, ViewerErrorInfo } from './state';

/** 页面 loading 延迟显示时长，单位毫秒（设计方案 §5.5 / §6.9.3）。 */
const PAGE_LOADING_DELAY_MS = 150;
/** 页面 loading 显示后的最短展示时长，单位毫秒。 */
const PAGE_LOADING_MIN_VISIBLE_MS = 200;
/** 页面 loading 淡出时长，单位毫秒。 */
const PAGE_LOADING_FADE_MS = 120;

/** 单页生命周期状态。 */
export type PageRenderState =
  | 'empty'
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'rendered'
  | 'error';

/** 单页绘制回调；由 `OFDViewer` 注入引擎调用。 */
export interface PageDrawHandler {
  /**
   * 绘制到 canvas。
   *
   * @param context 2D 上下文。
   * @param signal 取消信号。
   * @returns 完成时 resolve。
   */
  (context: CanvasRenderingContext2DLike, signal: AbortSignal): Promise<void>;
}

/** 单页视图选项。 */
export interface PageViewOptions {
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 页索引，0-based。 */
  readonly pageIndex: number;
  /** 页尺寸信息；用于可访问性文案与尺寸兜底。 */
  readonly pageInfo: PageInfo;
  /** 总页数；用于 aria-label。 */
  readonly totalPages: number;
  /** 宿主文档；默认全局 document。 */
  readonly ownerDocument?: Document;
  /** 翻译器；用于加载文案与错误卡按钮。 */
  readonly translator?: Translator;
  /**
   * 是否由引擎 `page:render:start` 事件启动 loading。
   *
   * 默认 false：`beginRender` 按代次号兜底计时；核心阅读器接入引擎事件后传
   * true，避免排队阶段提前显示。
   */
  readonly eventDrivenLoading?: boolean;
  /**
   * 重试回调；错误卡片按钮触发。
   *
   * @param pageNumber 页码，1-based。
   */
  readonly onRetry?: (pageNumber: number) => void;
}

/** 页面布局输入。 */
export interface PageViewLayout {
  /** 排版盒。 */
  readonly box: PageBox;
  /** 当前旋转。 */
  readonly rotation: Rotation;
  /** 当前缩放倍率。 */
  readonly scale: number;
}

/** 单页视图。 */
export class PageView {
  /** 根节点；`.ofd-page`。 */
  readonly element: HTMLElement;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 页索引，0-based。 */
  readonly pageIndex: number;
  /** 未旋转纸面容器；canvas/文字层/签章层都在其中。 */
  readonly surface: HTMLElement;
  /** canvas 包装层。 */
  readonly canvasWrapper: HTMLElement;
  /** 文字层容器；由文本模块填充。 */
  readonly textLayer: HTMLElement;
  /** 签章覆盖层容器；由签章模块填充。 */
  readonly signatureLayer: HTMLElement;

  private readonly options: PageViewOptions;
  private readonly doc: Document;
  private readonly loading: HTMLElement;
  private readonly loadingSkeleton: HTMLElement;
  private readonly loadingSpinner: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly errorLayer: HTMLElement;
  private readonly errorCode: HTMLElement;
  private readonly errorMessage: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private translator: Translator | null;
  /** 是否由引擎事件启动 loading；false 时由 `beginRender` 兜底。 */
  private readonly eventDrivenLoading: boolean;
  private canvasElement: HTMLCanvasElement | null = null;
  /** 后台绘制中的新 canvas；completeRender 成功后才替换旧 canvas。 */
  private pendingCanvasElement: HTMLCanvasElement | null = null;
  private stateValue: PageRenderState = 'empty';
  private generationValue = 0;
  private renderedKeyValue: string | null = null;
  /** 当前 canvas 实际使用的渲染倍率；0 表示尚未渲染。 */
  private renderedScaleValue = 0;
  /** 本次渲染请求的倍率；由 completeRender 在提交成功后写入。 */
  private pendingRenderScale = 0;
  private currentRotation: Rotation = 0;
  private currentScale = 1;
  private destroyed = false;
  /** 是否已经完成过至少一次绘制；用于区分首次骨架与重渲染遮罩。 */
  private painted = false;
  /** 当前页面 loading 归属的操作标识；同一页以最新一次为准。 */
  private loadingOperationId: string | null = null;
  /** loading 是否已显示。 */
  private loadingVisible = false;
  /** loading 显示时刻，单位毫秒；用于最短展示计时。 */
  private loadingShownAt = 0;
  private loadingShowTimer: ReturnType<typeof setTimeout> | null = null;
  private loadingHideTimer: ReturnType<typeof setTimeout> | null = null;
  private loadingFadeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param options 页码、页信息、总页数与重试回调。
   */
  constructor(options: PageViewOptions) {
    this.options = options;
    this.pageNumber = options.pageNumber;
    this.pageIndex = options.pageIndex;
    this.doc = options.ownerDocument ?? document;
    this.translator = options.translator ?? null;
    this.eventDrivenLoading = options.eventDrivenLoading ?? false;
    this.element = this.createElement('div', 'ofd-page');
    this.element.dataset.pageNumber = String(this.pageNumber);
    this.element.dataset.pageIndex = String(this.pageIndex);
    this.element.dataset.pageState = 'empty';
    this.element.style.position = 'absolute';
    this.element.style.left = '50%';
    this.element.style.transform = 'translateX(-50%)';
    this.updateAccessibility(options.totalPages);

    this.surface = this.createElement('div', 'ofd-page__surface');
    Object.assign(this.surface.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%) rotate(0deg)',
      transformOrigin: 'center center',
    } satisfies Partial<CSSStyleDeclaration>);
    this.element.appendChild(this.surface);

    this.canvasWrapper = this.createElement('div', 'ofd-page__canvas-wrapper');
    Object.assign(this.canvasWrapper.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.surface.appendChild(this.canvasWrapper);

    this.textLayer = this.createElement('div', 'ofd-page__text-layer');
    Object.assign(this.textLayer.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.textLayer.setAttribute('aria-hidden', 'false');
    this.surface.appendChild(this.textLayer);

    this.signatureLayer = this.createElement('div', 'ofd-page__signature-layer');
    Object.assign(this.signatureLayer.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      overflow: 'visible',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.surface.appendChild(this.signatureLayer);

    // 页面加载层：骨架/spinner 只做视觉占位，状态由 `.ofd-page[aria-busy]`
    // 与隐藏文案共同表达，避免逐页创建 aria-live。
    this.loading = this.createElement('div', 'ofd-page__loading');
    this.loading.hidden = true;
    this.loading.dataset.variant = 'skeleton';
    this.loadingSkeleton = this.createElement('div', 'ofd-page__loading-skeleton');
    this.loadingSkeleton.setAttribute('aria-hidden', 'true');
    this.loadingSpinner = this.createElement('div', 'ofd-page__loading-spinner');
    this.loadingSpinner.setAttribute('aria-hidden', 'true');
    this.loadingText = this.createElement('span', 'ofd-page__loading-text ofd-sr-only');
    this.loading.append(this.loadingSkeleton, this.loadingSpinner, this.loadingText);
    this.element.appendChild(this.loading);

    this.errorLayer = this.createElement('div', 'ofd-page__error');
    this.errorLayer.setAttribute('role', 'alert');
    this.errorLayer.hidden = true;
    this.errorCode = this.createElement('span', 'ofd-page__error-code');
    this.errorCode.hidden = true;
    this.errorMessage = this.createElement('span', 'ofd-page__error-message');
    this.retryButton = this.createElement('button', 'ofd-page__retry');
    this.retryButton.type = 'button';
    this.retryButton.addEventListener('click', () => {
      if (!this.destroyed) this.options.onRetry?.(this.pageNumber);
    });
    this.errorLayer.append(this.errorCode, this.errorMessage, this.retryButton);
    this.element.appendChild(this.errorLayer);
    this.updateLoadingText();
  }

  /** 当前生命周期状态。 */
  get state(): PageRenderState {
    return this.stateValue;
  }

  /** 当前代次号；每次重新渲染递增。 */
  get generation(): number {
    return this.generationValue;
  }

  /** 当前 canvas 对应的渲染 key；未渲染为 null。 */
  get renderedKey(): string | null {
    return this.renderedKeyValue;
  }

  /** 当前 canvas 实际使用的渲染倍率；未渲染为 0。 */
  get renderedScale(): number {
    return this.renderedScaleValue;
  }

  /** 当前 canvas；未创建为 null。 */
  get canvas(): HTMLCanvasElement | null {
    return this.canvasElement;
  }

  /** 是否已销毁。 */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * 更新翻译器；用于语言切换后刷新加载文案与错误卡按钮。
   *
   * @param translator 新的翻译器。
   */
  setTranslator(translator: Translator): void {
    this.translator = translator;
    this.updateLoadingText();
    this.retryButton.textContent = translator.t('common.retry');
  }

  /**
   * 开始一次页面 loading 计时。
   *
   * 150 ms 内结束不显示；同一页以最后一次 `operationId` 为准，旧操作晚到的
   * 结束/取消事件不会关闭新操作的 loading。
   *
   * @param operationId 本次渲染操作标识（可为引擎 `operationId` 或内部代次号）。
   */
  beginLoading(operationId: string): void {
    if (this.destroyed) return;
    this.loadingOperationId = operationId;
    this.clearLoadingTimers();
    this.element.setAttribute('aria-busy', 'true');
    this.errorLayer.hidden = true;
    if (this.loadingVisible) {
      this.loading.removeAttribute('data-fading');
      this.updateLoadingVariant();
      return;
    }
    this.loadingShowTimer = setTimeout(() => {
      this.loadingShowTimer = null;
      if (this.loadingOperationId === operationId) this.showLoading();
    }, PAGE_LOADING_DELAY_MS);
  }

  /**
   * 结束一次页面 loading；loading 已显示时满足最短展示后淡出。
   *
   * @param operationId 本次渲染操作标识。
   */
  finishLoading(operationId: string): void {
    if (this.loadingOperationId !== operationId) return;
    this.loadingOperationId = null;
    this.clearLoadingTimers();
    this.element.removeAttribute('aria-busy');
    if (!this.loadingVisible) {
      this.hideLoadingNow();
      return;
    }
    const elapsed = Date.now() - this.loadingShownAt;
    const remaining = Math.max(0, PAGE_LOADING_MIN_VISIBLE_MS - elapsed);
    this.loadingHideTimer = setTimeout(() => {
      this.loadingHideTimer = null;
      this.fadeOutLoading();
    }, remaining);
  }

  /**
   * 页面渲染失败；立即隐藏 loading 并显示页内错误卡。
   *
   * @param operationId 本次渲染操作标识。
   * @param info 错误信息（错误码 + 可读消息）。
   */
  failLoading(operationId: string, info: ViewerErrorInfo): void {
    if (this.loadingOperationId !== operationId) return;
    this.loadingOperationId = null;
    this.hideLoadingNow();
    this.showError(info);
  }

  /**
   * 取消/关闭页面 loading；静默隐藏，不显示错误卡。
   *
   * @param operationId 本次渲染操作标识；省略时强制隐藏。
   */
  cancelLoading(operationId?: string): void {
    if (operationId !== undefined && this.loadingOperationId !== operationId) return;
    this.loadingOperationId = null;
    this.hideLoadingNow();
  }

  /**
   * 更新布局：页盒位置/尺寸与旋转。
   *
   * @param layout 布局输入。
   */
  setLayout(layout: PageViewLayout): void {
    if (this.destroyed) return;
    const { box, rotation, scale } = layout;
    this.currentRotation = rotation;
    this.currentScale = scale;
    this.element.style.top = `${box.top}px`;
    this.element.style.width = `${box.width}px`;
    this.element.style.height = `${box.height}px`;
    this.surface.style.width = `${box.surfaceWidth}px`;
    this.surface.style.height = `${box.surfaceHeight}px`;
    this.surface.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    this.element.style.setProperty('--scale-factor', String(scale));
    this.surface.style.setProperty('--scale-factor', String(scale));
    this.element.dataset.rotation = String(rotation);
    if (this.canvasElement) {
      this.canvasElement.style.width = '100%';
      this.canvasElement.style.height = '100%';
    }
  }

  /**
   * 应用手势预览缩放（不改布局、不触发重绘）。
   *
   * 只通过 CSS `transform: scale()` 缩放页盒，由合成层完成，代价接近零；
   * `scale` 为 1 时清除预览。真正的高清渲染由阅读器在手势结束后执行。
   *
   * @param scale 预览缩放倍率（相对当前已渲染布局）。
   */
  setPreviewScale(scale: number): void {
    if (this.destroyed) return;
    if (scale === 1) {
      this.element.classList.remove('ofd-page--preview');
      this.element.style.removeProperty('--preview-scale');
      return;
    }
    this.element.classList.add('ofd-page--preview');
    this.element.style.setProperty('--preview-scale', String(scale));
  }

  /**
   * 更新总页数以刷新可访问性文案。
   *
   * @param totalPages 总页数。
   */
  updateAccessibility(totalPages: number): void {
    this.element.setAttribute('role', 'document');
    this.element.setAttribute(
      'aria-label',
      `第 ${this.pageNumber} 页，共 ${totalPages} 页`,
    );
  }

  /**
   * 标记当前页高亮。
   *
   * @param current 是否为当前页。
   */
  setCurrent(current: boolean): void {
    if (current) this.element.dataset.current = 'true';
    else delete this.element.dataset.current;
  }

  /**
   * 开始一次渲染；递增 generation，旧任务结果会被丢弃。
   *
   * 默认按代次号启动 150ms 计时作为兜底；`eventDrivenLoading` 为 true 时由
   * 引擎 `page:render:start` 以 `operationId` 启动。
   *
   * @param renderKey 渲染参数键（渲染倍率/rotation/dpr）。
   * @param renderScale 本次实际渲染倍率；省略时取当前布局倍率。
   * @returns 本次渲染代次号。
   */
  beginRender(renderKey: string, renderScale = this.currentScale): number {
    // 上一代未提交的离屏画布直接丢弃；旧显示 canvas 保持可见。
    this.discardPendingCanvas();
    this.generationValue += 1;
    this.renderedKeyValue = null;
    this.pendingRenderScale = renderScale;
    this.stateValue = 'queued';
    this.element.dataset.pageState = 'queued';
    this.errorLayer.hidden = true;
    if (this.canvasElement) this.canvasElement.dataset.stale = 'true';
    this.element.dataset.renderKey = renderKey;
    if (!this.eventDrivenLoading) this.beginLoading(String(this.generationValue));
    return this.generationValue;
  }

  /**
   * 标记进入绘制阶段。
   *
   * @param generation beginRender 返回的代次号。
   */
  markRendering(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.stateValue = 'rendering';
    this.element.dataset.pageState = 'rendering';
  }

  /**
   * 准备 canvas 并返回 2D 上下文。
   *
   * 首次渲染直接创建可见 canvas；重渲染时旧 canvas 保持可见，新内容绘制到
   * 离屏 canvas，等 `completeRender` 成功后再原子替换，避免缩放/旋转闪白。
   * 尺寸取设备像素（可能因上限降低 DPI）。
   *
   * @param width 设备像素宽。
   * @param height 设备像素高。
   * @param generation 代次号。
   * @returns 2D 上下文；环境不支持时 null。
   */
  prepareCanvas(
    width: number,
    height: number,
    generation: number,
  ): CanvasRenderingContext2D | null {
    if (this.destroyed || !this.isCurrent(generation)) return null;
    const pixelWidth = Math.max(1, Math.ceil(width));
    const pixelHeight = Math.max(1, Math.ceil(height));
    let canvas: HTMLCanvasElement;
    if (!this.canvasElement) {
      canvas = this.createRenderCanvas();
      this.canvasElement = canvas;
      this.canvasWrapper.appendChild(canvas);
    } else {
      // 旧 canvas 不动；新内容先画到不挂载的离屏 canvas。
      canvas = this.pendingCanvasElement ?? this.createRenderCanvas();
      this.pendingCanvasElement = canvas;
    }
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    this.canvasWrapper.hidden = false;
    this.element.dataset.canvasWidth = String(pixelWidth);
    this.element.dataset.canvasHeight = String(pixelHeight);
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d');
    } catch {
      context = null;
    }
    if (!context) return null;
    try {
      context.clearRect(0, 0, pixelWidth, pixelHeight);
    } catch {
      // 某些伪上下文不支持 clearRect；绘制阶段会覆盖。
    }
    return context;
  }

  /** 创建渲染用 canvas 元素（样式与可见 canvas 一致）。 */
  private createRenderCanvas(): HTMLCanvasElement {
    const canvas = this.doc.createElement('canvas');
    canvas.className = 'ofd-page__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    return canvas;
  }

  /** 丢弃尚未提交的离屏 canvas，旧画面保持不变。 */
  private discardPendingCanvas(): void {
    const canvas = this.pendingCanvasElement;
    if (!canvas) return;
    this.pendingCanvasElement = null;
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }

  /**
   * 取消一次渲染；若已有旧 canvas 则继续展示（CSS 拉伸过渡）。
   *
   * @param generation 代次号。
   */
  cancelRender(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.discardPendingCanvas();
    // 当前代次已终止；无论 loading 归属哪个 operationId 都应静默隐藏。
    this.cancelLoading();
    this.errorLayer.hidden = true;
    this.canvasWrapper.hidden = this.canvasElement === null;
    this.stateValue = this.canvasElement ? 'rendered' : 'empty';
    this.element.dataset.pageState = this.stateValue;
  }

  /**
   * 渲染成功。
   *
   * @param generation 代次号。
   * @param renderKey 本次渲染 key。
   */
  completeRender(generation: number, renderKey: string): void {
    if (!this.isCurrent(generation)) return;
    if (this.pendingCanvasElement) this.commitPendingCanvas(renderKey);
    this.stateValue = 'rendered';
    this.renderedKeyValue = renderKey;
    this.renderedScaleValue = this.pendingRenderScale;
    this.painted = true;
    this.finishLoading(String(generation));
    this.errorLayer.hidden = true;
    this.element.dataset.pageState = 'rendered';
    this.element.dataset.renderedScale = String(this.renderedScaleValue);
    this.element.dataset.rotation = String(this.currentRotation);
    this.canvasWrapper.hidden = this.canvasElement === null;
    if (this.canvasElement) {
      delete this.canvasElement.dataset.stale;
      this.canvasElement.dataset.renderKey = renderKey;
    }
  }

  /**
   * 用后台画布原子替换可见 canvas；同一任务内完成，浏览器不会绘制中间态。
   *
   * @param renderKey 本次渲染 key。
   */
  private commitPendingCanvas(renderKey: string): void {
    const previous = this.canvasElement;
    const next = this.pendingCanvasElement!;
    this.pendingCanvasElement = null;
    if (previous && previous.parentNode === this.canvasWrapper) {
      previous.replaceWith(next);
    } else {
      this.canvasWrapper.appendChild(next);
    }
    this.canvasElement = next;
    if (previous && previous !== next) {
      previous.width = 0;
      previous.height = 0;
    }
    delete next.dataset.stale;
    next.dataset.renderKey = renderKey;
  }

  /**
   * 渲染失败；显示页内错误卡片，不阻断其他页。
   *
   * @param generation 代次号。
   * @param info 错误信息。
   */
  failRender(generation: number, info: ViewerErrorInfo): void {
    if (!this.isCurrent(generation)) return;
    // 失败可能发生在重渲染；保留旧画面，仅用页内错误卡覆盖。
    this.discardPendingCanvas();
    this.stateValue = 'error';
    this.cancelLoading();
    this.showError(info);
    this.element.dataset.pageState = 'error';
    this.canvasWrapper.hidden = this.canvasElement === null;
  }

  /** 释放 canvas；用于 LRU 淘汰与关闭。 */
  releaseCanvas(): void {
    this.discardPendingCanvas();
    this.cancelLoading();
    this.errorLayer.hidden = true;
    this.painted = false;
    this.renderedScaleValue = 0;
    const canvas = this.canvasElement;
    if (!canvas) {
      this.stateValue = 'empty';
      this.element.dataset.pageState = 'empty';
      return;
    }
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
    this.canvasElement = null;
    this.renderedKeyValue = null;
    this.stateValue = 'empty';
    this.element.dataset.pageState = 'empty';
    this.canvasWrapper.hidden = true;
    delete this.element.dataset.canvasWidth;
    delete this.element.dataset.canvasHeight;
    delete this.element.dataset.renderKey;
  }

  /**
   * 显示/隐藏文字层；features.textLayer=false 时隐藏。
   *
   * @param visible 是否可见。
   */
  setTextLayerVisible(visible: boolean): void {
    this.textLayer.hidden = !visible;
  }

  /**
   * 显示/隐藏签章覆盖层；features.signatures=false 时隐藏。
   *
   * @param visible 是否可见。
   */
  setSignatureLayerVisible(visible: boolean): void {
    this.signatureLayer.hidden = !visible;
  }

  /** 销毁页视图并释放 canvas。 */
  destroy(): void {
    if (this.destroyed) return;
    this.hideLoadingNow();
    this.destroyed = true;
    this.generationValue += 1;
    this.discardPendingCanvas();
    if (this.canvasElement) {
      this.canvasElement.width = 0;
      this.canvasElement.height = 0;
      this.canvasElement.remove();
      this.canvasElement = null;
    }
    this.element.remove();
    replaceChildren(this.textLayer);
    replaceChildren(this.signatureLayer);
  }

  /** 显示 loading 层：首次渲染用骨架，重渲染用半透明遮罩。 */
  private showLoading(): void {
    this.loadingVisible = true;
    this.loadingShownAt = Date.now();
    this.loading.hidden = false;
    this.loading.removeAttribute('data-fading');
    this.updateLoadingVariant();
  }

  /** 按最短展示与 reduced-motion 设置淡出并清理 loading。 */
  private fadeOutLoading(): void {
    if (!this.loadingVisible) return;
    if (this.prefersReducedMotion()) {
      this.hideLoadingNow();
      return;
    }
    this.loading.setAttribute('data-fading', 'true');
    this.loadingFadeTimer = setTimeout(() => {
      this.loadingFadeTimer = null;
      this.hideLoadingNow();
    }, PAGE_LOADING_FADE_MS);
  }

  /** 立即隐藏 loading 并清理所有计时器。 */
  private hideLoadingNow(): void {
    this.clearLoadingTimers();
    this.loadingVisible = false;
    this.loading.hidden = true;
    this.loading.removeAttribute('data-fading');
    this.element.removeAttribute('aria-busy');
  }

  /** 根据是否已有绘制内容切换骨架/遮罩。 */
  private updateLoadingVariant(): void {
    this.loading.dataset.variant = this.painted ? 'overlay' : 'skeleton';
  }

  /** 刷新 loading 的隐藏文案；保证“骨架/spinner 不是唯一状态表达”。 */
  private updateLoadingText(): void {
    this.loadingText.textContent = this.translator
      ? this.translator.t('loading.pageNumber', {
          page: this.translator.formatNumber(this.pageNumber),
        })
      : `第 ${this.pageNumber} 页正在渲染…`;
    this.retryButton.textContent = this.translator?.t('common.retry') ?? '重试';
  }

  /**
   * 显示页内错误卡。
   *
   * @param info 错误信息。
   */
  private showError(info: ViewerErrorInfo): void {
    this.errorCode.textContent = info.code;
    this.errorCode.hidden = info.code.length === 0;
    this.errorMessage.textContent = info.message;
    this.errorLayer.hidden = false;
    this.element.dataset.errorCode = info.code;
  }

  /** 清理 loading 相关计时器。 */
  private clearLoadingTimers(): void {
    if (this.loadingShowTimer !== null) {
      clearTimeout(this.loadingShowTimer);
      this.loadingShowTimer = null;
    }
    if (this.loadingHideTimer !== null) {
      clearTimeout(this.loadingHideTimer);
      this.loadingHideTimer = null;
    }
    if (this.loadingFadeTimer !== null) {
      clearTimeout(this.loadingFadeTimer);
      this.loadingFadeTimer = null;
    }
  }

  /** 当前环境是否要求减少动效。 */
  private prefersReducedMotion(): boolean {
    const view = this.doc.defaultView;
    if (!view || typeof view.matchMedia !== 'function') return false;
    try {
      return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /**
   * 判断代次是否仍为当前。
   *
   * @param generation 代次号。
   * @returns 当前时 true。
   */
  private isCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.generationValue;
  }

  /**
   * 创建带 class 的元素。
   *
   * @param tag 标签名。
   * @param className class 名。
   * @returns 新元素。
   */
  private createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
  ): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag);
    element.className = className;
    return element;
  }
}