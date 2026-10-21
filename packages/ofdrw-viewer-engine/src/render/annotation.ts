/**
 * 注释/签章外观（实现由 T10/dev-pipeline 完成）。
 *
 * v1 只渲染 Appearance 静态外观；`Visible=false` 跳过；NoZoom/NoRotate/Print
 * 属于阅读器提示，不参与内容变换。
 */

import type { Annotation, IndependentBlock } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { PaintBinder } from './paint';
import { notImplemented } from '../common/not-implemented';

/** 注释块构建上下文。 */
export interface AnnotationBuildContext {
  /** 注释外观继承的文档默认样式。 */
  styleRoot: ResolvedStyle;
  /** 注释 XML 所在目录，用于解析相对文件路径。 */
  baseDir: string;
  /** warning 回调；空外观使用 `W_ANNOT_EMPTY`。 */
  onWarning?: (code: string, message: string, annotationId?: string) => void;
}

/**
 * 构建注释外观独立块；`boundary` 取 Appearance.Boundary。
 *
 * @param annotations 注释列表（按 PageAnnot 文件顺序）。
 * @param context 构建上下文。
 * @returns 可直接绘制的独立块；不可见/空外观的注释被跳过。
 */
export function buildAnnotationBlocks(
  annotations: readonly Annotation[],
  context: AnnotationBuildContext,
): IndependentBlock[] {
  void annotations;
  void context;
  return notImplemented('render.buildAnnotationBlocks');
}

/**
 * 按文件顺序绘制注释块。
 *
 * @param renderer 目标渲染器。
 * @param binder PaintBinder。
 * @param blocks 注释独立块。
 */
export function drawAnnotationBlocks(
  renderer: Renderer,
  binder: PaintBinder,
  blocks: readonly IndependentBlock[],
): void {
  void renderer;
  void binder;
  void blocks;
  return notImplemented('render.drawAnnotationBlocks');
}