/**
 * 准备阶段编排（实现由 T10/dev-pipeline 完成）。
 *
 * 只做 I/O、解析、解码、样式结算，不碰目标 Canvas/渲染器；结果供同步绘制阶段只读。
 */

import type { IndependentBlock, PageModel, PreparedPage } from '../model/types';
import type { PageResourceScope } from '../resource/types';
import type { WarningHandler } from '../warnings';
import { notImplemented } from '../common/not-implemented';

/** 准备阶段输入。 */
export interface PreparePageInput {
  /** 页面模型（已由 T3 解析）。 */
  page: PageModel;
  /** 页级资源作用域（已合并 PageRes/模板/文档资源）。 */
  resources: PageResourceScope;
  /** 图片缺 CTM 时是否严格 identity，默认 true。 */
  strictImageCtm?: boolean;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** warning 回调。 */
  onWarning?: WarningHandler;
}

/** 准备阶段产物：页面样式 + 可复用的独立块（底纹 tile/复合/注释）。 */
export interface PreparedPageBundle {
  page: PreparedPage;
  /** 以底纹资源 ID / 复合资源 ID / 注释 ID 为键的独立块。 */
  blocks: ReadonlyMap<string, IndependentBlock>;
}

/**
 * 准备页面：解析尺寸、建立作用域、加载字体/图片/复合资源、结算样式、构建独立块。
 *
 * @param input 页模型、资源作用域、取消信号与 warning 回调。
 * @returns 准备阶段产物。
 */
export async function preparePage(input: PreparePageInput): Promise<PreparedPageBundle> {
  void input;
  return notImplemented('render.preparePage');
}