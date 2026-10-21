/**
 * 字形轮廓转换与 LRU 缓存测试（设计方案 12.5/12.7）。
 */

import { describe, expect, it } from 'vitest';
import type { PathCommand } from '../../src/common/types';
import type { Glyph } from '../../src/font/types';
import {
  GlyphOutlineCache,
  LruCache,
  glyphToObjectPath,
  transformPathCommands,
} from '../../src/font/glyph';
import { createFakeFace } from '../text-layout/fake-font';

describe('glyphToObjectPath', () => {
  it('按 size/upem 缩放、HScale 只缩放 x、y 取反', () => {
    const path: PathCommand[] = [
      { type: 'moveTo', x: 100, y: 200 },
      { type: 'lineTo', x: 100, y: 0 },
      { type: 'quadraticCurveTo', cpx: 10, cpy: 20, x: 30, y: 40 },
      { type: 'bezierCurveTo', cp1x: 20, cp1y: 30, cp2x: 40, cp2y: 50, x: 60, y: 70 },
      { type: 'closePath' },
    ];
    const glyph: Glyph = { id: 1, advanceWidth: 1000, path };
    const result = glyphToObjectPath(glyph, 1000, 10, 0.5);

    expect(result[0]).toEqual({ type: 'moveTo', x: 0.5, y: -2 });
    expect(result[1]).toMatchObject({ type: 'lineTo', x: 0.5 });
    expect((result[1] as { y: number }).y).toBeCloseTo(0, 12);
    expect(result[2]).toEqual({
      type: 'quadraticCurveTo',
      cpx: 0.05,
      cpy: -0.2,
      x: 0.15,
      y: -0.4,
    });
    expect(result[3]).toMatchObject({ type: 'bezierCurveTo' });
    const bezier = result[3] as Extract<PathCommand, { type: 'bezierCurveTo' }>;
    expect(bezier.cp1x).toBeCloseTo(0.1, 12);
    expect(bezier.cp1y).toBeCloseTo(-0.3, 12);
    expect(bezier.cp2x).toBeCloseTo(0.2, 12);
    expect(bezier.cp2y).toBeCloseTo(-0.5, 12);
    expect(bezier.x).toBeCloseTo(0.3, 12);
    expect(bezier.y).toBeCloseTo(-0.7, 12);
    expect(result[4]).toEqual({ type: 'closePath' });
  });

  it('upem 非法时回退 1000，不产生 NaN', () => {
    const glyph: Glyph = { id: 1, advanceWidth: 10, path: [{ type: 'moveTo', x: 100, y: 0 }] };
    const result = glyphToObjectPath(glyph, 0, 10, 1);
    expect(result[0]).toMatchObject({ type: 'moveTo', x: 1 });
    expect((result[0] as { y: number }).y).toBeCloseTo(0, 12);
  });
});

describe('transformPathCommands', () => {
  it('变换所有控制点，不修改输入', () => {
    const source: PathCommand[] = [
      { type: 'quadraticCurveTo', cpx: 1, cpy: 2, x: 3, y: 4 },
    ];
    const result = transformPathCommands(source, [2, 0, 0, 3, 5, 7]);
    expect(result[0]).toEqual({ type: 'quadraticCurveTo', cpx: 7, cpy: 13, x: 11, y: 19 });
    expect(source[0]).toEqual({ type: 'quadraticCurveTo', cpx: 1, cpy: 2, x: 3, y: 4 });
  });
});

describe('LruCache', () => {
  it('按最近使用顺序淘汰', () => {
    const cache = new LruCache<number, string>(2);
    cache.set(1, 'a');
    cache.set(2, 'b');
    expect(cache.get(1)).toBe('a');
    cache.set(3, 'c');
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBe('a');
    expect(cache.get(3)).toBe('c');
    expect(cache.stats).toMatchObject({ size: 2, evictions: 1 });
  });

  it('delete/clear 生效', () => {
    const cache = new LruCache<number, number>(2);
    cache.set(1, 1);
    expect(cache.delete(1)).toBe(true);
    expect(cache.get(1)).toBeUndefined();
    cache.set(2, 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('GlyphOutlineCache', () => {
  it('缓存轮廓并限制条目数', () => {
    const face = createFakeFace({
      glyphs: [
        { gid: 1, path: [{ type: 'moveTo', x: 1, y: 1 }] },
        { gid: 2, path: [{ type: 'moveTo', x: 2, y: 2 }] },
        { gid: 4, path: [{ type: 'moveTo', x: 4, y: 4 }] },
      ],
    });
    const cache = new GlyphOutlineCache(2);

    expect(cache.get(face, 1)).toEqual([{ type: 'moveTo', x: 1, y: 1 }]);
    expect(cache.get(face, 2)).toEqual([{ type: 'moveTo', x: 2, y: 2 }]);
    expect(face.calls.glyph).toBe(2);
    // 命中缓存，不再调用字体面。
    expect(cache.get(face, 1)).toEqual([{ type: 'moveTo', x: 1, y: 1 }]);
    expect(face.calls.glyph).toBe(2);
    expect(cache.size).toBe(2);

    // 写入第 3 条会淘汰最久未使用的 gid=2。
    expect(cache.get(face, 4)).toEqual([{ type: 'moveTo', x: 4, y: 4 }]);
    expect(cache.size).toBe(2);
    expect(cache.get(face, 2)).toEqual([{ type: 'moveTo', x: 2, y: 2 }]);
    expect(face.calls.glyph).toBe(4);
  });

  it('缺失字形缓存 null，重复查询不重复提取', () => {
    const face = createFakeFace({ glyphs: [] });
    const cache = new GlyphOutlineCache(4);
    expect(cache.get(face, 99)).toBeNull();
    expect(cache.get(face, 99)).toBeNull();
    expect(face.calls.glyph).toBe(1);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});