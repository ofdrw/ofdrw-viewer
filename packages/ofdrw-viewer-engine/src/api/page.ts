/**
 * 页面公共入口（对应设计方案 15.1）。
 *
 * T1 只冻结形状；`getViewport`/`render` 实现由 T12（dev-api）完成。
 */

import type { PageSize } from '../model/types';
import type { Viewport } from '../common/types';
import type { PageRenderParameters, ViewportOptions } from './types';
import type { RenderTask } from './render-task';
import { notImplemented } from '../common/not-implemented';

/** OFD 页面；渲染只画页面内容，不设置 canvas 尺寸、不清屏。 */
export class OFDPage {
  /** 页索引，从 0 开始。 */
  readonly index: number;

  /**
   * 创建页面句柄；由 `OFDDocument.getPage()` 返回。
   *
   * @param index 页索引。
   */
  constructor(index: number) {
    this.index = index;
  }

  /**
   * 页尺寸。
   *
   * @returns 宽高，单位 mm。
   */
  getSize(): PageSize {
    return notImplemented('OFDPage.getSize');
  }

  /**
   * 页面在指定 DPI 下的像素尺寸；用户据此设置 canvas。
   *
   * @param options DPI 选项，默认 96。
   * @returns 设备像素尺寸。
   */
  getViewport(options?: ViewportOptions): Viewport {
    void options;
    return notImplemented('OFDPage.getViewport');
  }

  /**
   * 渲染到宿主提供的 canvasContext。
   *
   * 会以 `M_page` 重置变换（覆盖预置 CTM），但不会设置 canvas 宽高或清屏。
   *
   * @param params canvas 上下文、viewport 与可选取消信号。
   * @returns 渲染任务句柄。
   */
  render(params: PageRenderParameters): RenderTask {
    void params;
    return notImplemented('OFDPage.render');
  }
}