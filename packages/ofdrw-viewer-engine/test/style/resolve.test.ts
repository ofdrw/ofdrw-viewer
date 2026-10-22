import { describe, expect, it } from 'vitest';
import type { DrawParam, Paint, Pattern, ResourceId } from '../../src/model/types';
import { DrawParamGraph } from '../../src/style/draw-param';
import { createDefaultStyle } from '../../src/style/defaults';
import { StyleResolver } from '../../src/style/resolve';
import type { StyleScope } from '../../src/style/resolve';
import { makePath, makeText } from './objects';

/** 构造纯色 Paint。 */
function paint(r: number, g: number, b: number, a = 255): Paint {
  return { type: 'color', color: { r, g, b, a } };
}

/** 构造 DrawParam。 */
function dp(id: string, extra: Partial<DrawParam> = {}): DrawParam {
  return { id, ...extra };
}

/** 构造结算器。 */
function resolverOf(params: DrawParam[] = []): StyleResolver {
  const map = new Map<ResourceId, DrawParam>(params.map((item) => [item.id as ResourceId, item]));
  return new StyleResolver(new DrawParamGraph(map), createDefaultStyle());
}

describe('StyleResolver 类型默认值', () => {
  it('文本默认黑填充、不描边', () => {
    const style = resolverOf().resolveStyle({ object: makeText(), scope: { kind: 'document' } });
    expect(style.fill).toBe(true);
    expect(style.stroke).toBe(false);
    expect(style.fillPaint).toEqual({ kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } });
    expect(style.strokePaint).toEqual({ kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 0 } });
  });

  it('路径默认透明填充、黑描边、NonZero', () => {
    const style = resolverOf().resolveStyle({ object: makePath(), scope: { kind: 'document' } });
    expect(style.fill).toBe(false);
    expect(style.stroke).toBe(true);
    expect(style.fillPaint).toEqual({ kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 0 } });
    expect(style.strokePaint).toEqual({ kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } });
    expect(style.fillRule).toBe('nonzero');
  });

  it('Even-Odd 规则写入结算结果', () => {
    const style = resolverOf().resolveStyle({
      object: makePath({ rule: 'evenodd' }),
      scope: { kind: 'document' },
    });
    expect(style.fillRule).toBe('evenodd');
  });
});

describe('StyleResolver 优先级', () => {
  it('默认 < 继承 < DrawParam < 内联 < 子元素颜色', () => {
    const resolver = resolverOf([
      dp('1', { lineWidth: 1, fillColor: paint(255, 0, 0) }),
      dp('2', { lineWidth: 2, fillColor: paint(0, 0, 255) }),
    ]);
    const scope: StyleScope = { kind: 'layer', drawParamId: '1' };
    const style = resolver.resolveStyle({
      object: makeText({ drawParam: '2', lineWidth: 3 }),
      scope,
      fillPaint: paint(0, 255, 0),
    });
    expect(style.lineWidth).toBe(3);
    expect(style.fillPaint).toEqual({ kind: 'color', rgba: { r: 0, g: 255, b: 0, a: 255 } });
  });

  it('内联属性覆盖对象 DrawParam', () => {
    const resolver = resolverOf([dp('1', { lineWidth: 2, cap: 'Round', join: 'Bevel' })]);
    const style = resolver.resolveStyle({
      object: makePath({ drawParam: '1', lineWidth: 5, cap: 'Square', join: 'Miter', miterLimit: 8, dashOffset: 1, dashPattern: [2, 3] }),
      scope: { kind: 'document' },
    });
    expect(style.lineWidth).toBe(5);
    expect(style.lineCap).toBe('Square');
    expect(style.lineJoin).toBe('Miter');
    expect(style.miterLimit).toBe(8);
    expect(style.dashOffset).toBe(1);
    expect(style.dashPattern).toEqual([2, 3]);
  });

  it('嵌套作用域：图层 DP 被 PageBlock DP 覆盖', () => {
    const resolver = resolverOf([
      dp('1', { lineWidth: 1 }),
      dp('2', { lineWidth: 2 }),
    ]);
    const layer: StyleScope = { kind: 'layer', drawParamId: '1' };
    const block: StyleScope = { kind: 'pageblock', parent: layer, drawParamId: '2' };
    const style = resolver.resolveStyle({ object: makeText(), scope: block });
    expect(style.lineWidth).toBe(2);
  });

  it('Fill/Stroke 开关不从父作用域继承', () => {
    const resolver = resolverOf();
    const scope: StyleScope = { kind: 'layer', inline: { fill: true, stroke: true } };
    const style = resolver.resolveStyle({
      object: makeText({ fill: false, stroke: false }),
      scope,
    });
    expect(style.fill).toBe(false);
    expect(style.stroke).toBe(false);
  });

  it('对象 Alpha 与 DrawParam Alpha 相乘', () => {
    const resolver = resolverOf([dp('1', { alpha: 128 })]);
    const style = resolver.resolveStyle({
      object: makeText({ alpha: 128, drawParam: '1' }),
      scope: { kind: 'document' },
    });
    expect(style.alpha).toBeCloseTo((128 / 255) * (128 / 255), 6);
  });

  it('结算结果不可变', () => {
    const style = resolverOf().resolveStyle({ object: makeText(), scope: { kind: 'document' } });
    expect(Object.isFrozen(style)).toBe(true);
  });

  it('图片/复合对象默认不填充不描边', () => {
    const style = resolverOf().resolveStyle({
      object: { kind: 'composite', boundary: { x: 0, y: 0, w: 1, h: 1 }, alpha: 255, visible: true, resourceId: '1' },
      scope: { kind: 'document' },
    });
    expect(style.fill).toBe(false);
    expect(style.stroke).toBe(false);
    expect(style.fillPaint).toBeUndefined();
  });
});

describe('StyleResolver 底纹', () => {
  it('子元素 Pattern 生成 PatternSpec，styleRoot 为默认样式', () => {
    const cell = { kind: 'block' as const, children: [] };
    const pattern: Pattern = {
      id: 'pat1',
      width: 10,
      height: 10,
      xStep: 5,
      yStep: 5,
      reflectMethod: 'Normal',
      relativeTo: 'Object',
      cell,
    };
    const resolver = resolverOf();
    const style = resolver.resolveStyle({
      object: makeText(),
      scope: { kind: 'document' },
      fillPaint: { type: 'pattern', pattern },
    });
    expect(style.fillPaint?.kind).toBe('pattern');
    if (style.fillPaint?.kind === 'pattern') {
      expect(style.fillPaint.spec.patternId).toBe('pat1');
      expect(style.fillPaint.spec.xStep).toBe(10);
      expect(style.fillPaint.spec.yStep).toBe(10);
      expect(style.fillPaint.spec.cell).toBe(cell);
      expect(style.fillPaint.spec.styleRoot).toEqual(resolver.defaultStyle);
    }
  });
});