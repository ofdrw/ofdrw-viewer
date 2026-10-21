/**
 * 页面公共入口（对应设计方案 15.1 / 10.6）。
 *
 * `OFDPage` 只持有页尺寸与渲染驱动：`getSize`/`getViewport` 是纯计算，
 * `render` 创建 `RenderTask` 并交由 `OFDDocument` 执行真正的准备/绘制。
 */

import type { PageSize } from '../model/types';
import type { Viewport } from '../common/types';
import type { PageRenderParameters, ViewportOptions } from './types';
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

/** OFD 页面；渲染只画页面内容，不设置 canvas 尺寸、不清屏。 */
export class OFDPage {
  /** 页索引，从 0 开始。 */
  readonly index: number;
  /** 页尺寸，单位 mm；`getPage` 阶段已按回退链解析。 */
  private readonly pageSize: PageSize;
  /** 渲染驱动；由文档实例注入。 */
  private readonly driver: PageRenderDriver;

  /**
   * 创建页面句柄；由 `OFDDocument.getPage()` 返回，宿主不应直接构造。
   *
   * @param index 页索引，从 0 开始。
   * @param pageSize 页尺寸，单位 mm。
   * @param driver 渲染驱动。
   */
  constructor(index: number, pageSize: PageSize, driver: PageRenderDriver) {
    this.index = index;
    this.pageSize = { width: pageSize.width, height: pageSize.height };
    this.driver = driver;
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
}