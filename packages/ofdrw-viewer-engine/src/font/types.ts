/**
 * 字体层类型（对应设计方案 12.1）。
 *
 * 渲染器永远看不到 fontkit 对象；文字层只消费 FontFace/Glyph。
 */

import type { PathCommand } from '../common/types';
import type { WarningCode } from '../warnings';
import type { FontAliasTable } from './aliases';

/** 字形。 */
export interface Glyph {
  /** 字形 ID。 */
  id: number;
  /** 字体单位下的 advance width。 */
  advanceWidth: number;
  /** 字体单位下的轮廓，y 向上；使用方负责缩放与 y 翻转。 */
  path: PathCommand[];
}

/** 字体面；一个字体文件中的一个字体（TTC 需要先选面）。 */
export interface FontFace {
  /** 字体缓存键（通常为 文件路径#index）。 */
  key: string;
  /** 字族名。 */
  family: string;
  /** PostScript 名（若存在）。 */
  postscriptName?: string;
  /** 每 em 字体单位。 */
  unitsPerEm: number;
  /** 字形数量。 */
  numGlyphs: number;
  /** 是否存在可用的 cmap。 */
  hasCmap: boolean;
  /** OS/2.usWeightClass（若存在）。 */
  weightClass?: number;
  /** post.italicAngle（若存在）。 */
  italicAngle?: number;
  /** 字体本身是否已是粗体（OS/2、macStyle 或字体名判定）。 */
  bold?: boolean;
  /** 字体本身是否已是斜体（macStyle、italicAngle 或字体名判定）。 */
  italic?: boolean;
  /**
   * 按 Unicode 码点取字形；无 cmap 或缺失时返回 null。
   *
   * @param codePoint Unicode 码点。
   * @returns 字形或 null。
   */
  glyphForCodePoint(codePoint: number): Glyph | null;
  /**
   * 按字形 ID 取字形；显式 gid 路径，不依赖 cmap。
   *
   * @param glyphId 字形 ID。
   * @returns 字形或 null。
   */
  glyph(glyphId: number): Glyph | null;
}

/** 主字体 + 按顺序回退的字体链。 */
export interface FontFaceSet {
  primary: FontFace;
  fallbacks: FontFace[];
}

/** 字体层 warning 回调；上下文只携带资源 ID，去重由上层 WarningCollector 负责。 */
export type FontWarningCallback = (
  code: WarningCode,
  message: string,
  context?: { resourceId?: string },
) => void;

/** 字体面创建选项。 */
export interface FontFaceCreateOptions {
  /** 缓存键；缺省由实现生成。 */
  key?: string;
  /** 期望的 FontName，用于 TTC 选面。 */
  fontName?: string;
  /** 期望的 FamilyName，用于 TTC 选面。 */
  familyName?: string;
  /** TTC 面索引；缺省按名称匹配，匹配不到取 0。 */
  index?: number;
  /** 宿主扩展字体别名表；缺省使用内置表。 */
  aliases?: FontAliasTable;
  /** 字体资源 ID，仅用于 warning 上下文。 */
  resourceId?: string;
  /** 字体资源声明的粗体标志；与字体内部检测结果取并集。 */
  bold?: boolean;
  /** 字体资源声明的斜体标志；与字体内部检测结果取并集。 */
  italic?: boolean;
  /** 字体层 warning 回调（例如 TTC 未匹配到期望字体面）。 */
  onWarning?: FontWarningCallback;
}
