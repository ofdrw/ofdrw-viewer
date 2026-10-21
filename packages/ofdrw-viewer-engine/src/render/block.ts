/**
 * 独立空间块构建与绘制（实现由 T7（块构建/绘制）与 T10（编排）完成）。
 *
 * 注释/复合对象/底纹 cell 统一为 IndependentBlock；显示列表与放置分离，
 * 平移不改变缓存内容（设计方案 11.7）。
 */

import type { DisplayList } from '../common/display-list';
import type { Box } from '../common/types';
import type { IndependentBlock, PageBlock } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { PaintBinder } from './paint';
import { notImplemented } from '../common/not-implemented';

/** 已构建显示列表的独立块；`displayList` 必填。 */
export type PreparedBlock = IndependentBlock & { displayList: DisplayList };

/** 独立块构建输入。 */
export interface BuildBlockInput {
  id?: string;
  source: IndependentBlock['source'];
  /** 块内坐标尺寸，单位 mm。 */
  space: { width: number; height: number };
  content: PageBlock;
  styleRoot: ResolvedStyle;
  /** 注释块为 Appearance.Boundary，单位 mm。 */
  boundary?: Box;
  cacheKey: string;
}

/** 独立块绘制上下文。 */
export interface BlockDrawContext {
  renderer: Renderer;
  binder: PaintBinder;
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/**
 * 构建独立块显示列表；函数内部不得套用块的放置平移。
 *
 * @param input 块定义。
 * @param buildDisplayList 由 T10 提供的块内容构建函数。
 * @returns 带 displayList 的块。
 */
export function buildIndependentBlock(
  input: BuildBlockInput,
  buildDisplayList: (input: BuildBlockInput) => DisplayList,
): PreparedBlock {
  void input;
  void buildDisplayList;
  return notImplemented('render.buildIndependentBlock');
}

/**
 * 绘制独立块：先按 boundary 平移，再回放 displayList。
 *
 * @param context 渲染器与 PaintBinder。
 * @param block 独立块。
 */
export function drawIndependentBlock(context: BlockDrawContext, block: IndependentBlock): void {
  void context;
  void block;
  return notImplemented('render.drawIndependentBlock');
}