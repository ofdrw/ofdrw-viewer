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

import type { CanvasRenderingContext2DLike, PageInfo } from 'ofdrw-viewer-engine';
import type { PageBox } from './page-layout';
import type { Rotation, ViewerErrorInfo } from './state';

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
  private readonly errorLayer: HTMLElement;
  private readonly errorMessage: HTMLElement;
  private canvasElement: HTMLCanvasElement | null = null;
  private stateValue: PageRenderState = 'empty';
  private generationValue = 0;
  private renderedKeyValue: string | null = null;
  private currentRotation: Rotation = 0;
  private currentScale = 1;
  private destroyed = false;

  /**
   * @param options 页码、页信息、总页数与重试回调。
   */
  constructor(options: PageViewOptions) {
    this.options = options;
    this.pageNumber = options.pageNumber;
    this.pageIndex = options.pageIndex;
    this.doc = options.ownerDocument ?? document;
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
      inset: '0',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.surface.appendChild(this.canvasWrapper);

    this.textLayer = this.createElement('div', 'ofd-page__text-layer');
    Object.assign(this.textLayer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.textLayer.setAttribute('aria-hidden', 'false');
    this.surface.appendChild(this.textLayer);

    this.signatureLayer = this.createElement('div', 'ofd-page__signature-layer');
    Object.assign(this.signatureLayer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'visible',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.surface.appendChild(this.signatureLayer);

    this.loading = this.createElement('div', 'ofd-page__loading');
    this.loading.setAttribute('aria-hidden', 'true');
    this.loading.hidden = true;
    this.element.appendChild(this.loading);

    this.errorLayer = this.createElement('div', 'ofd-page__error');
    this.errorLayer.setAttribute('role', 'alert');
    this.errorLayer.hidden = true;
    this.errorMessage = this.createElement('span', 'ofd-page__error-message');
    const retry = this.createElement('button', 'ofd-page__retry');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.addEventListener('click', () => {
      if (!this.destroyed) this.options.onRetry?.(this.pageNumber);
    });
    this.errorLayer.append(this.errorMessage, retry);
    this.element.appendChild(this.errorLayer);
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

  /** 当前 canvas；未创建为 null。 */
  get canvas(): HTMLCanvasElement | null {
    return this.canvasElement;
  }

  /** 是否已销毁。 */
  get isDestroyed(): boolean {
    return this.destroyed;
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
   * @param renderKey 渲染参数键（scale/rotation/dpr）。
   * @returns 本次渲染代次号。
   */
  beginRender(renderKey: string): number {
    this.generationValue += 1;
    this.renderedKeyValue = null;
    this.stateValue = 'queued';
    this.element.dataset.pageState = 'queued';
    this.errorLayer.hidden = true;
    if (!this.canvasElement) this.loading.hidden = false;
    if (this.canvasElement) this.canvasElement.dataset.stale = 'true';
    this.element.dataset.renderKey = renderKey;
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
   * 只在真正渲染时创建 canvas；尺寸取设备像素（可能因上限降低 DPI）。
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
    let canvas = this.canvasElement;
    if (!canvas) {
      canvas = this.doc.createElement('canvas');
      canvas.className = 'ofd-page__canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      this.canvasElement = canvas;
      this.canvasWrapper.appendChild(canvas);
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

  /**
   * 取消一次渲染；若已有旧 canvas 则继续展示（CSS 拉伸过渡）。
   *
   * @param generation 代次号。
   */
  cancelRender(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.loading.hidden = true;
    this.errorLayer.hidden = true;
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
    this.stateValue = 'rendered';
    this.renderedKeyValue = renderKey;
    this.loading.hidden = true;
    this.errorLayer.hidden = true;
    this.element.dataset.pageState = 'rendered';
    this.element.dataset.renderedScale = String(this.currentScale);
    this.element.dataset.rotation = String(this.currentRotation);
    if (this.canvasElement) {
      delete this.canvasElement.dataset.stale;
      this.canvasElement.dataset.renderKey = renderKey;
    }
  }

  /**
   * 渲染失败；显示页内错误卡片，不阻断其他页。
   *
   * @param generation 代次号。
   * @param info 错误信息。
   */
  failRender(generation: number, info: ViewerErrorInfo): void {
    if (!this.isCurrent(generation)) return;
    this.stateValue = 'error';
    this.loading.hidden = true;
    this.errorLayer.hidden = false;
    this.errorMessage.textContent = info.message;
    this.element.dataset.pageState = 'error';
    this.element.dataset.errorCode = info.code;
    this.canvasWrapper.hidden = true;
  }

  /** 释放 canvas；用于 LRU 淘汰与关闭。 */
  releaseCanvas(): void {
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
    this.loading.hidden = true;
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
    this.destroyed = true;
    this.generationValue += 1;
    if (this.canvasElement) {
      this.canvasElement.width = 0;
      this.canvasElement.height = 0;
      this.canvasElement.remove();
      this.canvasElement = null;
    }
    this.element.remove();
    this.textLayer.replaceChildren();
    this.signatureLayer.replaceChildren();
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