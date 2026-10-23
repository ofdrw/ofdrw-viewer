/**
 * 页面公共入口（对应设计方案 15.1 / 10.6）。
 *
 * `OFDPage` 持有页尺寸与文档注入的渲染/导出/准备驱动：`getSize`/`getViewport`
 * 是纯计算，`render` 创建 `RenderTask` 并交由 `OFDDocument` 执行真正的准备/绘制。
 *
 * 事件：页面监听器是文档总线的按 `pageIndex` 过滤视图；`page:render:start` 在
 * `render()` 返回前同步派发，终止事件由文档在绘制结束/失败/取消时派发。
 */

import type { PageSize } from '../model/types';
import type { Viewport } from '../common/types';
import type {
  PageImageExportOptions,
  PageImageResult,
  PageRenderParameters,
  ViewportOptions,
} from './types';
import type {
  OFDPageApi,
  PagePrepareOptions,
  TextContent,
  TextContentOptions,
} from './ui-types';
import type {
  OFDAddEventListenerOptions,
  OFDEventBus,
  OFDEventHandler,
  OFDEventName,
  OFDEventMap,
  OFDInternalEventDispatcher,
  OFDPageEventMap,
  OFDPageEventName,
} from './events';
import { OFDError, toOFDError } from '../errors';
import { createAbortError, createRenderTask } from './render-task';
import type { RenderTask } from './render-task';
import { getPageViewport } from './viewport';

/**
 * 一次页面渲染操作的事件上下文。
 *
 * 由 `OFDPage.render()` 在入口校验通过后创建；`startedAt` 用于计算耗时。
 */
export interface PageRenderOperation {
  /** 操作 ID，与 `page:render:*` 事件的 `operationId` 相同。 */
  readonly operationId: number;
  /** 操作开始时间，Unix 毫秒。 */
  readonly startedAt: number;
}

/**
 * 页面渲染驱动；由 `OFDDocument` 注入，负责串行锁、校验与准备/绘制编排。
 *
 * @param params 宿主渲染参数。
 * @param signal 合并后的取消信号。
 * @param operation 事件上下文；未进入操作生命周期时为 undefined。
 * @returns 渲染完成时 resolve。
 */
export type PageRenderDriver = (
  params: PageRenderParameters,
  signal: AbortSignal,
  operation?: PageRenderOperation,
) => Promise<void>;

/**
 * 页面图片导出驱动；由 `OFDDocument` 注入，负责离屏画布、渲染与编码。
 *
 * @param options 导出格式、DPI、背景与取消信号。
 * @returns 编码后的图片与输出信息。
 */
export type PageExportDriver = (options: PageImageExportOptions) => Promise<PageImageResult>;

/**
 * 页面准备驱动；由 `OFDDocument` 注入，复用 preparePage 并缓存 bundle。
 *
 * @param options 取消信号。
 * @returns 准备完成时 resolve。
 */
export type PagePrepareDriver = (options: PagePrepareOptions) => Promise<void>;

/**
 * 页面文本内容驱动；由 `OFDDocument` 注入，负责缓存、准备、取消与 DPI 换算。
 *
 * @param options 文本内容选项（dpi/字符/可见性/上限/取消）。
 * @returns px 坐标的公开文本内容。
 */
export type PageTextDriver = (options: TextContentOptions) => Promise<TextContent>;

/**
 * 页面事件与入口校验运行时；由 `OFDDocument` 注入。
 *
 * 页面监听器直接挂到文档总线并按 `pageIndex` 过滤，因此离开文档后无法单独
 * 构造可用的事件视图。
 */
export interface PageEventContext {
  /** 文档事件总线。 */
  readonly events: OFDEventBus;
  /** 引擎内部派发器；负责 operationId/sequence/timestamp。 */
  readonly dispatcher: OFDInternalEventDispatcher;
  /**
   * 同步校验渲染入口（文档状态、viewport、Canvas 尺寸）。
   *
   * @param params 宿主渲染参数。
   * @throws OFDError 校验失败；调用方不得派生任何事件。
   */
  validateRender(params: PageRenderParameters): void;
}

/** 页面监听器绑定；`handler` 用于精确退订，`detach` 释放总线与 signal 绑定。 */
interface PageListenerBinding {
  /** 原始回调。 */
  handler: (event: never) => void;
  /** 移除当前绑定；幂等。 */
  detach: () => void;
}

/** OFD 页面；渲染只画页面内容，不设置 canvas 尺寸、不清屏。 */
export class OFDPage {
  /** 页索引，从 0 开始。 */
  readonly index: number;
  /** 页尺寸，单位 mm；`getPage` 阶段已按回退链解析。 */
  private readonly pageSize: PageSize;
  /** 渲染驱动；由文档实例注入。 */
  private readonly driver: PageRenderDriver;
  /** 图片导出驱动；由文档实例注入。 */
  private readonly exportDriver: PageExportDriver | undefined;
  /** 页面准备驱动；由文档实例注入。 */
  private readonly prepareDriver: PagePrepareDriver | undefined;
  /** 页面文本内容驱动；由文档实例注入。 */
  private readonly textDriver: PageTextDriver | undefined;
  /** 事件与校验上下文；宿主手工构造页面时为 undefined。 */
  private readonly eventContext: PageEventContext | undefined;
  /** 页面监听器绑定，按事件名分组。 */
  private readonly listenerBindings = new Map<OFDPageEventName, PageListenerBinding[]>();

  /**
   * 创建页面句柄；由 `OFDDocument.getPage()` 返回，宿主不应直接构造。
   *
   * @param index 页索引，从 0 开始。
   * @param pageSize 页尺寸，单位 mm。
   * @param driver 渲染驱动。
   * @param exportDriver 可选图片导出驱动；未注入时 exportImage 报不支持。
   * @param prepareDriver 可选页面准备驱动；未注入时 prepare 报不支持。
   * @param textDriver 可选页面文本内容驱动；未注入时 getTextContent 报不支持。
   * @param eventContext 可选事件与入口校验上下文；文档创建的页面始终提供。
   */
  constructor(
    index: number,
    pageSize: PageSize,
    driver: PageRenderDriver,
    exportDriver?: PageExportDriver,
    prepareDriver?: PagePrepareDriver,
    textDriver?: PageTextDriver,
    eventContext?: PageEventContext,
  ) {
    this.index = index;
    this.pageSize = { width: pageSize.width, height: pageSize.height };
    this.driver = driver;
    this.exportDriver = exportDriver;
    this.prepareDriver = prepareDriver;
    this.textDriver = textDriver;
    this.eventContext = eventContext;
  }

  /**
   * 页尺寸。
   *
   * @returns 宽高，单位 mm。
   */
  getSize(): PageSize {
    return { width: this.pageSize.width, height: this.pageSize.height };
  }

  /**
   * 页面在指定 DPI 下的像素尺寸；用户据此设置 canvas 宽高。
   *
   * 纯计算，不加载字体/图片；非法 DPI 回退到默认 96。
   *
   * @param options DPI 选项，默认 96。
   * @returns 设备像素尺寸。
   */
  getViewport(options?: ViewportOptions): Viewport {
    const dpi = options?.dpi;
    if (dpi === undefined || !Number.isFinite(dpi) || dpi <= 0) {
      return getPageViewport(this.pageSize);
    }
    return getPageViewport(this.pageSize, { dpi });
  }

  /**
   * 渲染到宿主提供的 canvasContext。
   *
   * 会以 `M_page` 重置变换（覆盖预置 CTM），但不会设置 canvas 宽高或清屏。
   * canvas 尺寸不足、像素超限等错误通过 `task.promise` 以 `OFDError` 拒绝。
   *
   * 事件时序：入口校验失败不派发任何事件且直接返回拒绝的任务；
   * 校验通过后在 `render()` 返回前同步派发 `page:render:start`，`end` /
   * `error` / `abort` 由文档在 `task.promise` settle 前派发。
   *
   * @param params canvas 上下文、viewport 与可选取消信号。
   * @returns 渲染任务句柄。
   */
  render(params: PageRenderParameters): RenderTask {
    const context = this.eventContext;
    if (!context) {
      // 宿主手工构造的页面没有事件上下文，保持旧行为：只交给驱动；
      // 取消（含预取消）统一以 OFD_ABORTED 拒绝。
      return createRenderTask(async (signal) => {
        try {
          await this.driver(params, signal);
        } catch (error) {
          if (signal.aborted) throw createAbortError(error);
          throw error;
        }
      });
    }

    try {
      // 入口校验必须同步完成，失败时不进入操作生命周期。
      context.validateRender(params);
    } catch (error) {
      const failure = toOFDError(
        error,
        'OFD_RENDERER_UNSUPPORTED',
        `第 ${this.index} 页渲染参数非法`,
      );
      return createRenderTask(async () => {
        throw failure;
      });
    }

    const operationId = context.dispatcher.allocateOperationId();
    const operation: PageRenderOperation = { operationId, startedAt: Date.now() };
    const viewport = params.viewport;
    context.dispatcher.emit('page:render:start', {
      operationId,
      pageIndex: this.index,
      dpi: viewport.dpi,
      width: viewport.width,
      height: viewport.height,
    });
    return createRenderTask(
      (signal) => this.driver(params, signal, operation),
      params?.signal,
      operationId,
    );
  }

  /**
   * 订阅本页事件；只接收 `pageIndex` 与当前页一致的事件。
   *
   * @param type 页面事件名。
   * @param handler 监听器。
   * @returns 退订函数；可重复调用。
   */
  on<K extends OFDPageEventName>(type: K, handler: OFDEventHandler<K>): () => void {
    return this.addPageListener(type, handler, false);
  }

  /**
   * 订阅一次本页事件。
   *
   * @param type 页面事件名。
   * @param handler 监听器。
   * @returns 退订函数；可重复调用。
   */
  once<K extends OFDPageEventName>(type: K, handler: OFDEventHandler<K>): () => void {
    return this.addPageListener(type, handler, true);
  }

  /**
   * 退订本页事件；同一回调的多次注册全部移除。
   *
   * @param type 页面事件名。
   * @param handler 监听器。
   */
  off<K extends OFDPageEventName>(type: K, handler: OFDEventHandler<K>): void {
    const bindings = this.listenerBindings.get(type);
    if (!bindings) return;
    for (const binding of [...bindings]) {
      if (binding.handler === (handler as (event: never) => void)) binding.detach();
    }
  }

  /**
   * DOM 风格订阅本页事件；支持 `once`/`signal`。
   *
   * @param type 页面事件名。
   * @param handler 监听器。
   * @param options once 与 signal 选项。
   */
  addEventListener<K extends OFDPageEventName>(
    type: K,
    handler: OFDEventHandler<K>,
    options: OFDAddEventListenerOptions = {},
  ): void {
    this.addPageListener(type, handler, options.once === true, options.signal);
  }

  /**
   * DOM 风格退订本页事件；与 `off` 等价。
   *
   * @param type 页面事件名。
   * @param handler 监听器。
   */
  removeEventListener<K extends OFDPageEventName>(type: K, handler: OFDEventHandler<K>): void {
    this.off(type, handler);
  }

  /**
   * 将整页导出为图片字节。
   *
   * 使用文档级 `OFDOpenOptions.createCanvas` 创建独立离屏画布，复用页面渲染
   * 管线；默认 PNG/96 DPI/白底，详细语义见 `PageImageExportOptions`。
   *
   * @param options 导出参数；省略时使用默认值。
   * @returns 编码后的图片、MIME、设备像素宽高与实际 DPI。
   * @throws OFDError 取消、文档已关闭、像素超限、画布/编码器不可用或编码失败。
   */
  async exportImage(options?: PageImageExportOptions): Promise<PageImageResult> {
    if (!this.exportDriver) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', '当前页面未绑定图片导出驱动');
    }
    return this.exportDriver(options ?? {});
  }

  /**
   * 读取页面文本内容（阅读器文字层）。
   *
   * 内部按页缓存与 DPI 无关的 mm 布局，输出按 dpi 换算为 px；不调用 Canvas
   * 文字 API、不改变页面绘制结果。无文本驱动（宿主手工构造）时报不支持。
   *
   * @param options 输出 DPI、字符/可见性/图层/上限与取消信号。
   * @returns px 坐标的文本内容。
   * @throws OFDError OFD_RENDERER_UNSUPPORTED / OFD_CLOSED / OFD_ABORTED。
   */
  async getTextContent(options?: TextContentOptions): Promise<TextContent> {
    if (!this.textDriver) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', '当前页面未绑定文本内容驱动');
    }
    return this.textDriver(options ?? {});
  }

  /**
   * 预取页面模型、字体、图片与模板资源；不创建 canvas、不绘制。
   *
   * 已准备或正在准备时复用同一 bundle；重复调用幂等。取消返回
   * `OFD_ABORTED`，文档关闭返回 `OFD_CLOSED`。
   *
   * @param options 取消信号。
   * @returns 准备完成时 resolve。
   * @throws OFDError 取消、文档已关闭或准备失败。
   */
  async prepare(options?: PagePrepareOptions): Promise<void> {
    if (!this.prepareDriver) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', '当前页面未绑定准备驱动');
    }
    return this.prepareDriver(options ?? {});
  }

  /**
   * 清理本页全部监听器；文档关闭时由引擎调用。
   *
   * @internal
   */
  dispose(): void {
    for (const bindings of this.listenerBindings.values()) {
      for (const binding of [...bindings]) binding.detach();
    }
    this.listenerBindings.clear();
  }

  /**
   * 添加按页过滤的监听器。
   *
   * @param type 页面事件名。
   * @param handler 监听器。
   * @param once 是否只触发一次。
   * @param signal 绑定生命周期。
   * @returns 退订函数。
   */
  private addPageListener<K extends OFDPageEventName>(
    type: K,
    handler: OFDEventHandler<K>,
    once: boolean,
    signal?: AbortSignal,
  ): () => void {
    const events = this.eventContext?.events;
    // 注册时已中止则不注册，与 OFDEventBus.addEventListener 一致。
    if (!events || signal?.aborted) return () => undefined;

    let offBus: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let removed = false;
    const binding: PageListenerBinding = {
      handler: handler as (event: never) => void,
      detach: () => {
        remove();
      },
    };
    const remove = (): void => {
      if (removed) return;
      removed = true;
      offBus?.();
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      this.forgetBinding(type, binding);
    };
    const wrapper = (event: OFDPageEventMap[K]): void => {
      if (event.pageIndex !== this.index) return;
      // once 必须在调用前移除，监听器抛错也不会再次触发。
      if (once) remove();
      (handler as (value: OFDPageEventMap[K]) => void)(event);
    };
    offBus = events.on(
      type as OFDEventName,
      wrapper as (event: OFDEventMap[OFDEventName]) => void,
    );

    let bindings = this.listenerBindings.get(type);
    if (!bindings) {
      bindings = [];
      this.listenerBindings.set(type, bindings);
    }
    bindings.push(binding);

    if (signal) {
      onAbort = () => remove();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    return remove;
  }

  /**
   * 从分组表中移除绑定。
   *
   * @param type 页面事件名。
   * @param binding 监听器绑定。
   */
  private forgetBinding(type: OFDPageEventName, binding: PageListenerBinding): void {
    const bindings = this.listenerBindings.get(type);
    if (!bindings) return;
    const index = bindings.indexOf(binding);
    if (index >= 0) bindings.splice(index, 1);
    if (bindings.length === 0) this.listenerBindings.delete(type);
  }
}

/**
 * UI API 类型声明合并。
 *
 * `getTextContent` 由 t72 实现，`prepare` 由 t67 实现。
 */
export interface OFDPage extends OFDPageApi {}