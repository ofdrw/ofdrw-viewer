/**
 * 字形轮廓缓存与坐标转换（对应设计方案 12.5/12.7）。
 *
 * 缓存按 (face.key, gid) 计数上限；轮廓为字体单位、y 向上。
 * 缓存的是与目标无关的路径命令，不缓存 Path2D，保证小程序/Node 可用。
 */

import type { Matrix, PathCommand } from '../common/types';
import { transformPoint } from '../common/matrix';
import type { FontFace, Glyph } from './types';

/** LRU 统计。 */
export interface LruStats {
  /** 当前条目数。 */
  size: number;
  /** 命中次数。 */
  hits: number;
  /** 未命中次数。 */
  misses: number;
  /** 因容量淘汰的条目数。 */
  evictions: number;
}

/**
 * 基于 Map 插入顺序的 LRU 缓存。
 *
 * `get` 命中时把条目移到队尾；`set` 超限时淘汰队首。
 * 值允许为 `null`（用于缓存“字形不存在”），`undefined` 只表示未命中。
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  /**
   * @param maxEntries 条目上限；小于 1 时按 1 处理。
   */
  constructor(private readonly maxEntries: number = 20_000) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      throw new RangeError('LruCache maxEntries 必须为正数');
    }
  }

  /**
   * 读取并刷新最近使用顺序。
   *
   * @param key 键。
   * @returns 命中值；未命中返回 undefined。
   */
  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      this.missCount += 1;
      return undefined;
    }
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    this.hitCount += 1;
    return value;
  }

  /**
   * 写入缓存；键已存在时刷新顺序。
   *
   * @param key 键。
   * @param value 值。
   */
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictionCount += 1;
    }
  }

  /**
   * 删除一个条目。
   *
   * @param key 键。
   * @returns 是否删除成功。
   */
  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** 清空缓存与统计。 */
  clear(): void {
    this.map.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  /** 当前条目数。 */
  get size(): number {
    return this.map.size;
  }

  /** 读取统计快照。 */
  get stats(): LruStats {
    return {
      size: this.map.size,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
    };
  }
}

/**
 * 字形轮廓缓存（字体单位，y 向上）。
 *
 * 键为 `face.key + '#' + glyphId`；容量默认 20,000，符合设计方案 12.7。
 */
export class GlyphOutlineCache {
  private readonly cache: LruCache<string, PathCommand[] | null>;

  /**
   * @param maxEntries 条目上限，默认 20,000。
   */
  constructor(maxEntries = 20_000) {
    this.cache = new LruCache<string, PathCommand[] | null>(maxEntries);
  }

  /**
   * 取字形轮廓（字体单位，y 向上）。
   *
   * @param face 字体面。
   * @param glyphId 字形 ID。
   * @returns 轮廓；字体缺失字形时返回 null。
   */
  get(face: FontFace, glyphId: number): PathCommand[] | null {
    const key = `${face.key}#${glyphId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let path: PathCommand[] | null = null;
    try {
      path = face.glyph(glyphId)?.path ?? null;
    } catch {
      path = null;
    }
    this.cache.set(key, path);
    return path;
  }

  /** 清空缓存。 */
  clear(): void {
    this.cache.clear();
  }

  /** 当前条目数。 */
  get size(): number {
    return this.cache.size;
  }

  /** 缓存统计快照。 */
  get stats(): LruStats {
    return this.cache.stats;
  }
}

/**
 * 变换一条路径命令中的所有坐标点。
 *
 * @param commands 源路径命令。
 * @param matrix 2×3 仿射矩阵。
 * @returns 新路径命令数组（不修改输入）。
 */
export function transformPathCommands(
  commands: readonly PathCommand[],
  matrix: Matrix,
): PathCommand[] {
  return commands.map((command): PathCommand => {
    switch (command.type) {
      case 'moveTo': {
        const p = transformPoint(matrix, command);
        return { type: 'moveTo', x: p.x, y: p.y };
      }
      case 'lineTo': {
        const p = transformPoint(matrix, command);
        return { type: 'lineTo', x: p.x, y: p.y };
      }
      case 'quadraticCurveTo': {
        const cp = transformPoint(matrix, { x: command.cpx, y: command.cpy });
        const p = transformPoint(matrix, command);
        return { type: 'quadraticCurveTo', cpx: cp.x, cpy: cp.y, x: p.x, y: p.y };
      }
      case 'bezierCurveTo': {
        const cp1 = transformPoint(matrix, { x: command.cp1x, y: command.cp1y });
        const cp2 = transformPoint(matrix, { x: command.cp2x, y: command.cp2y });
        const p = transformPoint(matrix, command);
        return {
          type: 'bezierCurveTo',
          cp1x: cp1.x,
          cp1y: cp1.y,
          cp2x: cp2.x,
          cp2y: cp2.y,
          x: p.x,
          y: p.y,
        };
      }
      case 'closePath':
        return { type: 'closePath' };
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  });
}

/**
 * 把字体单位轮廓转换为对象空间路径命令。
 *
 * 变换顺序：`Scale(size / unitsPerEm × hScale, -size / unitsPerEm)`（y 翻转）。
 * 不含旋转与 pen 平移；需要时由调用方继续右乘矩阵。
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
  const upem = Number.isFinite(unitsPerEm) && unitsPerEm > 0 ? unitsPerEm : 1000;
  const sx = (size / upem) * (Number.isFinite(hScale) && hScale > 0 ? hScale : 1);
  const sy = -size / upem;
  return transformPathCommands(glyph.path, [sx, 0, 0, sy, 0, 0]);
}