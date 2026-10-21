/**
 * 路径解析与绘制（实现由 T7/dev-pipeline 完成）。
 *
 * 路径命令全部通过 Renderer 立即路径 API 输出，不依赖 Path2D；
 * Boundary/Clips/CTM 的责任划分见设计方案 10.3、10.4.1。
 */

import type { PathCommand } from '../common/types';
import type { PathObject } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { PaintBinder } from './paint';
import { notImplemented } from '../common/not-implemented';

/** 路径绘制上下文。 */
export interface PathDrawContext {
  renderer: Renderer;
  binder: PaintBinder;
  /** warning 回调；坏路径命令使用 `W_BAD_PATH`。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
  /** 页索引，仅用于 warning。 */
  pageIndex?: number;
}

/**
 * 解析 OFD AbbreviatedData。
 *
 * 支持 M/L/S/Q/B/A/C 等命令与圆弧；坏 token 跳过并 warning。
 *
 * @param data AbbreviatedData 原文。
 * @returns 目标无关路径命令。
 */
export function parseAbbreviatedData(data: string): PathCommand[] {
  void data;
  return notImplemented('render.parseAbbreviatedData');
}

/**
 * 把路径命令输出到渲染器。
 *
 * @param renderer 目标渲染器。
 * @param commands 路径命令。
 */
export function emitPathCommands(renderer: Renderer, commands: readonly PathCommand[]): void {
  void renderer;
  void commands;
  return notImplemented('render.emitPathCommands');
}

/**
 * 绘制路径对象（填充/描边/规则）。
 *
 * 调用方负责 Boundary 平移、Clips 与对象 CTM；本函数只处理路径数据与最终样式。
 *
 * @param context 渲染器与 PaintBinder。
 * @param object 路径对象。
 * @param style 已结算样式。
 */
export function drawPathObject(
  context: PathDrawContext,
  object: PathObject,
  style: ResolvedStyle,
): void {
  void context;
  void object;
  void style;
  return notImplemented('render.drawPathObject');
}