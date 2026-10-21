/**
 * 样式层冻结契约。
 *
 * `ResolvedStyle` 是准备阶段的最终产物、绘制阶段唯一的样式输入：只含渲染所需字段，
 * 不再包含资源 ID、继承关系或 DrawParam 引用。
 */

import type { DrawStyle, FillRule, PaintSpec } from '../common/types';

/**
 * 已结算的最终绘制样式。
 *
 * 所有长度字段位于对象空间（通常 mm）；`alpha` 为 0..1，已与对象/图层透明度合并。
 * 绘制阶段只读，不得再修改。
 */
export interface ResolvedStyle extends DrawStyle {
  /** 填充 Paint；`fill=false` 时仍可为 undefined。 */
  fillPaint?: PaintSpec;
  /** 描边 Paint；`stroke=false` 时仍可为 undefined。 */
  strokePaint?: PaintSpec;
  /** 是否填充。 */
  fill: boolean;
  /** 是否描边。 */
  stroke: boolean;
  /** 填充规则，对应 Canvas `fill(rule)`。 */
  fillRule: FillRule;
  /** 对象最终透明度，0..1。 */
  alpha: number;
}