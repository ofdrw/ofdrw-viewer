/**
 * 页面公共入口（对应设计方案 15.1 / 10.6）。
 *
 * `OFDPage` 持有页尺寸与文档注入的渲染/导出/准备驱动：`getSize`/`getViewport`
 * 是纯计算，`render` 创建 `RenderTask` 并交由 `OFDDocument` 执行真正的准备/绘制。
 */

import type { PageSize } from '../model/types';
import type { Viewport } from '../common/types';
import type {
  PageImageExportOptions,
  PageImageResult,
  PageRenderParameters,
  ViewportOptions,
} from './types';
import type { OFDPageApi, PagePrepareOptions } from './ui-types';
import { OFDError } from '../errors';
import { createRenderTask } from './render-task';
import type { RenderTask } from './render-task';
import { getPageViewport } from './viewport';

/**
 * 页面渲染驱动；由 `OFDDocument` 注入，负责串行锁、校验与准备/绘制编排。
 *
 * @param params 宿主渲染参数。
 * @param signal 合并后的取消信号。
 * @returns 渲染完成时 resolve。
 */
export type PageRenderDriver = (
  params: PageRenderParameters,
  signal: AbortSignal,
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

  /**
   * 创建页面句柄；由 `OFDDocument.getPage()` 返回，宿主不应直接构造。
   *
   * @param index 页索引，从 0 开始。
   * @param pageSize 页尺寸，单位 mm。
   * @param driver 渲染驱动。
   * @param exportDriver 可选图片导出驱动；未注入时 exportImage 报不支持。
   * @param prepareDriver 可选页面准备驱动；未注入时 prepare 报不支持。
   */
  constructor(
    index: number,
    pageSize: PageSize,
    driver: PageRenderDriver,
    exportDriver?: PageExportDriver,
    prepareDriver?: PagePrepareDriver,
  ) {
    this.index = index;
    this.pageSize = { width: pageSize.width, height: pageSize.height };
    this.driver = driver;
    this.exportDriver = exportDriver;
    this.prepareDriver = prepareDriver;
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
   * @param params canvas 上下文、viewport 与可选取消信号。
   * @returns 渲染任务句柄。
   */
  render(params: PageRenderParameters): RenderTask {
    return createRenderTask(
      (signal) => this.driver(params, signal),
      params?.signal,
    );
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
}

/**
 * UI API 类型声明合并。
 *
 * `getTextContent` 的实现由 t68/t71 落到 `OFDPage`；`prepare` 由 t67 实现。
 */
export interface OFDPage extends OFDPageApi {}
