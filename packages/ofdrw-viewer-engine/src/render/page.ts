/**
 * 页面绘制入口（实现由 T10/dev-pipeline 完成）。
 *
 * 绘制阶段同步执行：beginPage → identity → setTransform(M_page) → 图层/模板顺序 →
 * 注释 → endPage。不解析 DrawParam、不查资源、不直接调用 Canvas（除透传 ctx）。
 */

import type { PreparedPage } from '../model/types';
import type { Renderer, CanvasRenderingContext2DLike } from '../renderer/types';
import type { Viewport } from '../common/types';
import type { WarningHandler } from '../warnings';
import { notImplemented } from '../common/not-implemented';

/** 页面绘制选项。 */
export interface DrawPageOptions {
  /** 图层顺序：默认 `type`，`document` 为严格 XML 顺序。 */
  layerOrder?: 'document' | 'type';
  /** 图片缺 CTM 时是否严格 identity，默认 true。 */
  strictImageCtm?: boolean;
  /** 取消信号；每个对象检查一次。 */
  signal?: AbortSignal;
  /** warning 回调。 */
  onWarning?: WarningHandler;
}

/**
 * 绘制已准备的页面。
 *
 * @param prepared 准备阶段产物。
 * @param renderer 目标渲染器。
 * @param canvasContext 宿主 2D 上下文，仅透传给 renderer。
 * @param viewport 页面像素尺寸与 DPI。
 * @param options 图层顺序、取消与 warning 选项。
 */
export function drawPage(
  prepared: PreparedPage,
  renderer: Renderer,
  canvasContext: CanvasRenderingContext2DLike,
  viewport: Viewport,
  options: DrawPageOptions = {},
): void {
  void prepared;
  void renderer;
  void canvasContext;
  void viewport;
  void options;
  return notImplemented('render.drawPage');
}