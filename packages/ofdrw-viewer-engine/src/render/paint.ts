/**
 * PaintSpec → ResolvedPaint 绑定（实现由 T7/dev-pipeline 完成）。
 *
 * 绑定发生在样式结算之后、绘制之前：样式层只产出 PaintSpec，本层把底纹 cell
 * 转成 DisplayList tile、把渐变/网格描述原样交给渲染器。渲染器不接触 OFD 结构。
 */

import type { PaintSpec, ResolvedPaint } from '../common/types';
import type { DisplayList } from '../common/display-list';
import type { Renderer } from '../renderer/types';
import { notImplemented } from '../common/not-implemented';

/** 底纹 tile 解析器；由 prepare 阶段的 BlockStore 提供。 */
export interface PatternTileResolver {
  /**
   * 按底纹资源 ID 取预构建的 tile 显示列表。
   *
   * @param patternId 底纹资源 ID。
   * @returns tile DisplayList；缺失时返回 undefined。
   */
  resolvePatternTile(patternId: string): DisplayList | undefined;
}

/** PaintBinder 创建参数。 */
export interface PaintBindingContext {
  /** 底纹 tile 解析器；没有底纹时可省略。 */
  patterns?: PatternTileResolver;
  /** warning 回调（例如底纹 tile 超限降级）。 */
  onWarning?: (code: string, message: string, patternId?: string) => void;
}

/** per-renderer 的 Paint 绑定器；可按 PaintSpec 规范哈希 + dpiBucket 缓存。 */
export interface PaintBinder {
  /**
   * 绑定 PaintSpec。
   *
   * @param spec 样式层 PaintSpec。
   * @returns 渲染器可消费的 ResolvedPaint；无法绑定时返回 undefined。
   */
  bind(spec: PaintSpec | undefined): ResolvedPaint | undefined;
  /** 清空内部绑定缓存。 */
  clear(): void;
}

/**
 * 创建 PaintBinder。
 *
 * @param renderer 目标渲染器；底纹/渐变能力探测通过它进行。
 * @param context 底纹解析与 warning 回调。
 * @returns PaintBinder。
 */
export function createPaintBinder(
  renderer: Renderer,
  context: PaintBindingContext = {},
): PaintBinder {
  void renderer;
  void context;
  return notImplemented('render.createPaintBinder');
}