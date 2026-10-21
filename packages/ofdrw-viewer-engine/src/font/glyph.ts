/**
 * 字形轮廓缓存与坐标转换（实现由 T4/dev-text 完成）。
 *
 * 缓存按 (face.key, gid) 计数上限；轮廓为字体单位、y 向上。
 */

import type { PathCommand } from '../common/types';
import type { FontFace, Glyph } from './types';
import { notImplemented } from '../common/not-implemented';

/** 字形轮廓缓存。 */
export class GlyphOutlineCache {
  /**
   * @param maxEntries 条目上限，默认 20,000。
   */
  constructor(private readonly maxEntries = 20_000) {
    void this.maxEntries;
  }

  /**
   * 取字形轮廓（字体单位，y 向上）。
   *
   * @param face 字体面。
   * @param glyphId 字形 ID。
   * @returns 轮廓；字体缺失字形时返回 null。
   */
  get(face: FontFace, glyphId: number): PathCommand[] | null {
    void face;
    void glyphId;
    return notImplemented('GlyphOutlineCache.get');
  }

  /** 清空缓存。 */
  clear(): void {
    return notImplemented('GlyphOutlineCache.clear');
  }

  /** 当前条目数。 */
  get size(): number {
    return notImplemented('GlyphOutlineCache.size');
  }
}

/**
 * 把字体单位轮廓转换为对象空间路径命令。
 *
 * 变换顺序：`Scale(size / unitsPerEm × hScale, -size / unitsPerEm)`（y 翻转），
 * 再按 CharDirection 旋转、按阅读方向放置。
 *
 * @param glyph 字形。
 * @param unitsPerEm 每 em 字体单位。
 * @param size 字号，对象空间单位（通常 mm）。
 * @param hScale 水平缩放，1 表示正常。
 * @returns 对象空间路径命令。
 */
export function glyphToObjectPath(
  glyph: Glyph,
  unitsPerEm: number,
  size: number,
  hScale: number,
): PathCommand[] {
  void glyph;
  void unitsPerEm;
  void size;
  void hScale;
  return notImplemented('font.glyphToObjectPath');
}