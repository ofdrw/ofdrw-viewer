/**
 * 注释/签章外观。
 *
 * v1 只渲染 Appearance 静态外观；`Visible=false` 跳过；NoZoom/NoRotate/Print
 * 属于阅读器提示，不参与内容变换。Appearance 统一构建为独立块，由页面管线在
 * 所有图层之后按 PageAnnot 文件顺序绘制。
 */

import type { Annotation, IndependentBlock, PageBlock } from '../model/types';
import type { Box } from '../common/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { PaintBinder } from './paint';
import { normalizeBox } from '../common/matrix';
import { drawIndependentBlock } from './block';

/** 注释块构建上下文。 */
export interface AnnotationBuildContext {
  /** 注释外观继承的文档默认样式。 */
  styleRoot: ResolvedStyle;
  /** 注释 XML 所在目录，用于解析相对文件路径。 */
  baseDir: string;
  /** warning 回调；空外观使用 `W_ANNOT_EMPTY`。 */
  onWarning?: (code: string, message: string, annotationId?: string) => void;
  /**
   * 由页面准备阶段注入的独立块构建器。
   *
   * 构建器负责结算 Appearance 内样式、构建显示列表并复用复合/底纹块。
   */
  buildBlock?: (
    annotation: Annotation,
    appearance: PageBlock,
    boundary: Box,
  ) => IndependentBlock;
}

/**
 * 构建注释外观独立块；`boundary` 取 Appearance.Boundary。
 *
 * 空外观/无 Boundary/不可见注释直接跳过；Appearance 的 Boundary 作为块放置边界，
 * 不把内容拉伸到边界。
 *
 * @param annotations 注释列表（按 PageAnnot 文件顺序）。
 * @param context 构建上下文。
 * @returns 可直接绘制的独立块；不可见/空外观的注释被跳过。
 */
export function buildAnnotationBlocks(
  annotations: readonly Annotation[],
  context: AnnotationBuildContext,
): IndependentBlock[] {
  const warn = context.onWarning;
  const blocks: IndependentBlock[] = [];
  for (const annotation of annotations) {
    if (!annotation.visible) continue;
    const appearance = annotation.appearance;
    if (!appearance || appearance.children.length === 0) {
      warn?.('W_ANNOT_EMPTY', `注释 ${annotation.id} 的 Appearance 为空，已跳过`, annotation.id);
      continue;
    }
    if (!annotation.boundary) {
      warn?.('W_ANNOT_EMPTY', `注释 ${annotation.id} 的 Appearance 缺少 Boundary，已跳过`, annotation.id);
      continue;
    }
    const boundary = normalizeBox(annotation.boundary);
    if (!(boundary.w > 0) || !(boundary.h > 0)) {
      warn?.('W_ANNOT_EMPTY', `注释 ${annotation.id} 的 Appearance Boundary 非正，已跳过`, annotation.id);
      continue;
    }
    if (!context.buildBlock) {
      warn?.('W_ANNOT_EMPTY', `注释 ${annotation.id} 缺少块构建器，已跳过`, annotation.id);
      continue;
    }
    try {
      blocks.push(context.buildBlock(annotation, appearance, boundary));
    } catch (error) {
      warn?.(
        'W_UNSUPPORTED_PAINT',
        `注释 ${annotation.id} 外观构建失败：${error instanceof Error ? error.message : String(error)}`,
        annotation.id,
      );
    }
  }
  return blocks;
}

/**
 * 按文件顺序绘制注释块。
 *
 * 该重载只用于没有字体/图片运行时缓存的简单场景；页面绘制应走
 * `drawPage`，由它提供完整 bundle 与图片物化回调。
 *
 * @param renderer 目标渲染器。
 * @param binder PaintBinder。
 * @param blocks 注释独立块。
 * @param onWarning warning 回调。
 */
export function drawAnnotationBlocks(
  renderer: Renderer,
  binder: PaintBinder,
  blocks: readonly IndependentBlock[],
  onWarning?: (code: string, message: string, objectId?: string) => void,
): void {
  for (const block of blocks) {
    renderer.save();
    try {
      if (block.boundary) renderer.translate(block.boundary.x, block.boundary.y);
      drawIndependentBlock({ renderer, binder, onWarning }, block);
    } catch (error) {
      onWarning?.(
        'W_UNSUPPORTED_PAINT',
        `注释块绘制失败：${error instanceof Error ? error.message : String(error)}`,
        block.id,
      );
    } finally {
      try {
        renderer.restore();
      } catch {
        // 忽略 restore 失败，继续后续注释。
      }
    }
  }
}