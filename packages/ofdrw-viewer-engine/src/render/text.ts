/**
 * 文字布局与绘制（实现由 T4/dev-text 完成）。
 *
 * 文字统一走“字形轮廓 → 路径 → fill/stroke”，禁止使用 Canvas 文字 API。
 */

import type { PathCommand } from '../common/types';
import type { TextObject } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import type { FontFace, FontFaceSet } from '../font/types';
import type { PaintBinder } from './paint';
import { notImplemented } from '../common/not-implemented';

/** 一个字形 run：同一字体/同一轮廓来源的连续字形。 */
export interface GlyphRun {
  face: FontFace;
  gid: number;
  /** 字体单位下的 advance。 */
  advanceWidth: number;
  /** 字体单位下的轮廓，y 向上。 */
  path: PathCommand[];
}

/** 一个 TextCode 内的布局单元（对应 CGTransform 的 run-based 语义）。 */
export interface TextLayoutUnit {
  /** 起始字符位置（码点索引）。 */
  cpStart: number;
  /** 覆盖字符数。 */
  codeCount: number;
  /** 该单元的字形序列，按绘制顺序。 */
  glyphs: GlyphRun[];
  /** 单元结束后 pen 的 X 步进，对象空间单位。 */
  deltaX: number;
  /** 单元结束后 pen 的 Y 步进，对象空间单位。 */
  deltaY: number;
}

/** 一个 TextObject 的布局结果。 */
export interface TextLayout {
  units: TextLayoutUnit[];
  /** 累计 pen 位置，对象空间单位。 */
  endX: number;
  endY: number;
}

/** 文字绘制上下文。 */
export interface TextDrawContext {
  renderer: Renderer;
  binder: PaintBinder;
  /** 主字体与回退链。 */
  faces: FontFaceSet;
  /** warning 回调；缺字使用 `W_GLYPH_MISSING`。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/**
 * 计算文字布局。
 *
 * 处理 DeltaX/DeltaY、CGTransform、ReadDirection/CharDirection、HScale；
 * 具体算法见设计方案 12.3/12.4。
 *
 * @param object 文字对象。
 * @param faces 主字体与回退链。
 * @returns 字形 run 与 pen 结果。
 */
export function layoutText(object: TextObject, faces: FontFaceSet): TextLayout {
  void object;
  void faces;
  return notImplemented('render.layoutText');
}

/**
 * 绘制文字对象。
 *
 * @param context 渲染器、PaintBinder 与字体。
 * @param object 文字对象。
 * @param style 已结算样式。
 */
export function drawTextObject(
  context: TextDrawContext,
  object: TextObject,
  style: ResolvedStyle,
): void {
  void context;
  void object;
  void style;
  return notImplemented('render.drawTextObject');
}