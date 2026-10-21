import { describe, expect, it, vi } from 'vitest';
import type { DrawParam, ResourceId } from '../../src/model/types';
import { DrawParamGraph, flattenDrawParam } from '../../src/style/draw-param';
import { createDefaultStyle } from '../../src/style/defaults';

/** 构造一个最小 DrawParam。 */
function dp(id: string, extra: Partial<DrawParam> = {}): DrawParam {
  return { id, ...extra };
}

/** 红色 Paint。 */
const RED = { type: 'color' as const, color: { r: 255, g: 0, b: 0, a: 255 } };
/** 蓝色 Paint。 */
const BLUE = { type: 'color' as const, color: { r: 0, g: 0, b: 255, a: 255 } };

describe('flattenDrawParam', () => {
  it('按 Relative 链从远到近合并，近端覆盖远端', () => {
    const params = new Map<ResourceId, DrawParam>([
      ['1', dp('1', { lineWidth: 1, cap: 'Butt', fillColor: RED })],
      ['2', dp('2', { relative: '1', lineWidth: 2, join: 'Round' })],
      ['3', dp('3', { relative: '2', lineWidth: 3, fillColor: BLUE, alpha: 128 })],
    ]);
    const patch = flattenDrawParam(params, '3');
    expect(patch.lineWidth).toBe(3);
    expect(patch.lineCap).toBe('Butt');
    expect(patch.lineJoin).toBe('Round');
    expect(patch.alpha).toBeCloseTo(128 / 255, 6);
    expect(patch.fillPaint).toEqual({ kind: 'color', rgba: { r: 0, g: 0, b: 255, a: 255 } });
  });

  it('归一化 #/前导零 ID 后查找', () => {
    const params = new Map<ResourceId, DrawParam>([['12', dp('12', { lineWidth: 7 })]]);
    expect(flattenDrawParam(params, '#00012').lineWidth).toBe(7);
  });

  it('环检测：上报 warning 并保留已展开部分', () => {
    const onWarning = vi.fn();
    const params = new Map<ResourceId, DrawParam>([
      ['1', dp('1', { relative: '2', lineWidth: 1 })],
      ['2', dp('2', { relative: '1', lineWidth: 2 })],
    ]);
    const patch = flattenDrawParam(params, '1', { onWarning });
    expect(patch.lineWidth).toBe(1);
    expect(onWarning).toHaveBeenCalledWith(
      'W_COMPOSITE_DEPTH',
      expect.stringContaining('环'),
      expect.any(String),
    );
  });

  it('缺失 Relative 引用时 warning，并继续用自身字段', () => {
    const onWarning = vi.fn();
    const params = new Map<ResourceId, DrawParam>([['1', dp('1', { relative: '99', lineWidth: 4 })]]);
    const patch = flattenDrawParam(params, '1', { onWarning });
    expect(patch.lineWidth).toBe(4);
    expect(onWarning).toHaveBeenCalledWith('W_BAD_NUMBER', expect.stringContaining('99'), '99');
  });

  it('超过最大深度时 warning 并截断', () => {
    const onWarning = vi.fn();
    const params = new Map<ResourceId, DrawParam>([
      ['1', dp('1', { relative: '2' })],
      ['2', dp('2', { relative: '3' })],
      ['3', dp('3', { relative: '4' })],
      ['4', dp('4', { lineWidth: 9 })],
    ]);
    const patch = flattenDrawParam(params, '1', { maxDepth: 2, onWarning });
    expect(patch.lineWidth).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith(
      'W_COMPOSITE_DEPTH',
      expect.stringContaining('深度'),
      expect.any(String),
    );
  });
});

describe('DrawParamGraph', () => {
  it('同一 DrawParam 被多次引用只展开一次（缓存同一对象）', () => {
    const params = new Map<ResourceId, DrawParam>([['1', dp('1', { lineWidth: 1 })]]);
    const graph = new DrawParamGraph(params);
    const first = graph.resolve('1');
    const second = graph.resolve('#0001');
    expect(second).toBe(first);
    graph.clear();
    expect(graph.resolve('1')).not.toBe(first);
  });
});

describe('createDefaultStyle', () => {
  it('附录 A 默认值', () => {
    const style = createDefaultStyle();
    expect(style.lineWidth).toBe(0.353);
    expect(style.lineCap).toBe('Butt');
    expect(style.lineJoin).toBe('Miter');
    expect(style.miterLimit).toBe(4.234);
    expect(style.dashOffset).toBe(0);
    expect(style.dashPattern).toEqual([]);
    expect(style.fill).toBe(false);
    expect(style.stroke).toBe(false);
    expect(style.fillRule).toBe('nonzero');
    expect(style.alpha).toBe(1);
    expect(style.fillPaint).toEqual({ kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } });
    expect(Object.isFrozen(style)).toBe(true);
  });
});