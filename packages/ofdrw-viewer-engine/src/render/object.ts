/**
 * 对象绘制分发（实现由 T10/dev-pipeline 完成）。
 *
 * 严格按设计方案 10.3：save → Boundary translate/clip → Clips（CTM 前）→ CTM →
 * multiplyAlpha → 按 kind 分发 → restore（finally）。样式来自 `PreparedPage.styles`。
 */

import type { GraphicUnitBase, PageObject, PreparedPage } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { PaintBinder } from './paint';
import { notImplemented } from '../common/not-implemented';

/** 对象绘制上下文。 */
export interface DrawObjectContext {
  prepared: PreparedPage;
  renderer: Renderer;
  binder: PaintBinder;
  /** 图片缺 CTM 时是否严格 identity，默认 true。 */
  strictImageCtm: boolean;
  pageIndex: number;
  /** warning 回调；对象失败后继续下一个对象。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/**
 * 绘制单个对象/块。
 *
 * @param context 绘制上下文。
 * @param object 对象。
 * @param style 已结算样式；调用方应传 `prepared.styles.get(object)`。
 */
export function drawObject(
  context: DrawObjectContext,
  object: PageObject,
  style: ResolvedStyle,
): void {
  void context;
  void object;
  void style;
  return notImplemented('render.drawObject');
}

/**
 * 按顺序绘制一组对象。
 *
 * @param context 绘制上下文。
 * @param objects 对象列表。
 */
export function drawObjects(context: DrawObjectContext, objects: readonly PageObject[]): void {
  void context;
  void objects;
  return notImplemented('render.drawObjects');
}

/**
 * 从 PreparedPage 取样式；缺失时返回 undefined。
 *
 * @param prepared 准备阶段产物。
 * @param object 图元。
 * @returns 最终样式或 undefined。
 */
export function getPreparedStyle(
  prepared: PreparedPage,
  object: GraphicUnitBase,
): ResolvedStyle | undefined {
  void prepared;
  void object;
  return notImplemented('render.getPreparedStyle');
}