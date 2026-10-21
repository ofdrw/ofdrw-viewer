/**
 * T6a Paint 绑定单测：渐变归一化/MapType/Extend band、底纹、径向降级与缓存。
 */

import { describe, expect, it } from 'vitest';
import type {
  AxialGradientSpec,
  GradientStop,
  PaintSpec,
  PatternSpec,
  ResolvedPaint,
} from '../../../src/common/types';
import { DisplayListBuilder } from '../../../src/render/display-list';
import {
  MAX_GRADIENT_STOPS,
  MAX_PATTERN_TILES,
  countPatternTiles,
  createPaintBinder,
  getAxialExtendBand,
  type PatternTileResolver,
} from '../../../src/render/paint';
import { BASE_STYLE, FakeRenderer, warningCollector } from '../path/fake-renderer';

function stop(position: number, r: number, g: number, b: number, a = 255): GradientStop {
  return { position, color: { r, g, b, a } };
}

function axial(overrides: Partial<AxialGradientSpec> = {}): Extract<PaintSpec, { kind: 'gradient' }> {
  return {
    kind: 'gradient',
    spec: {
      kind: 'axial',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      mapType: 'Direct',
      extend: 0,
      segments: [stop(0, 255, 0, 0), stop(1, 0, 0, 255)],
      ...overrides,
    },
  };
}

function tile(): ReturnType<DisplayListBuilder['build']> {
  return new DisplayListBuilder({ x: 0, y: 0, w: 10, h: 5 })
    .beginPath()
    .moveTo(0, 0)
    .lineTo(10, 5)
    .stroke(BASE_STYLE, { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } })
    .build();
}

function patternSpec(overrides: Partial<PatternSpec> = {}): PatternSpec {
  return {
    width: 10,
    height: 5,
    xStep: 10,
    yStep: 5,
    reflect: 'Normal',
    relativeTo: 'Object',
    cell: { kind: 'block', children: [] },
    styleRoot: BASE_STYLE,
    tile: tile(),
    ...overrides,
  };
}

function pattern(overrides: Partial<PatternSpec> = {}): Extract<PaintSpec, { kind: 'pattern' }> {
  return { kind: 'pattern', spec: patternSpec(overrides) };
}

function bind(paint: PaintSpec | undefined, options?: Parameters<typeof createPaintBinder>[1]): {
  resolved: ResolvedPaint | undefined;
  renderer: FakeRenderer;
  binder: ReturnType<typeof createPaintBinder>;
} {
  const renderer = new FakeRenderer();
  const binder = createPaintBinder(renderer, options);
  return { resolved: binder.bind(paint), renderer, binder };
}

describe('PaintBinder：颜色', () => {
  it('归一化并 clamp RGBA', () => {
    const { resolved } = bind({ kind: 'color', rgba: { r: 300, g: -5, b: 10.6, a: 255 } });
    expect(resolved).toEqual({ kind: 'color', rgba: { r: 255, g: 0, b: 11, a: 255 } });
  });

  it('undefined spec 返回 undefined', () => {
    expect(bind(undefined).resolved).toBeUndefined();
  });
});

describe('PaintBinder：轴向渐变', () => {
  it('缺失 Segment 位置按区间均分', () => {
    const { resolved } = bind(
      axial({
        segments: [stop(Number.NaN, 255, 0, 0), stop(Number.NaN, 0, 255, 0), stop(Number.NaN, 0, 0, 255)],
      }),
    );
    const spec = (resolved as Extract<ResolvedPaint, { kind: 'gradient' }>).spec;
    expect(spec.kind).toBe('axial');
    if (spec.kind !== 'axial') return;
    expect(spec.segments.map((segment) => segment.position)).toEqual([0, 0.5, 1]);
  });

  it('位置递减时 warning 并修正为单调不减', () => {
    const warnings = warningCollector();
    const { resolved } = bind(axial({ segments: [stop(0.8, 255, 0, 0), stop(0.2, 0, 0, 255)] }), {
      onWarning: warnings.warnings,
    });
    const spec = (resolved as Extract<ResolvedPaint, { kind: 'gradient' }>).spec;
    if (spec.kind !== 'axial') return;
    const positions = spec.segments.map((segment) => segment.position);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThanOrEqual(positions[index - 1]!);
    }
    expect(positions[0]).toBe(0);
    expect(positions.at(-1)).toBe(1);
    expect(warnings.codes).toContain('W_UNSUPPORTED_PAINT');
  });

  it('Repeat 按 MapUnit 展开为多个周期', () => {
    const { resolved } = bind(
      axial({
        mapType: 'Repeat',
        mapUnit: 2.5,
        segments: [stop(0, 255, 0, 0), stop(1, 0, 0, 255)],
      }),
    );
    const spec = (resolved as Extract<ResolvedPaint, { kind: 'gradient' }>).spec;
    if (spec.kind !== 'axial') throw new Error('expected axial');
    expect(spec.segments.length).toBeGreaterThan(2);
    expect(spec.segments[0]!.position).toBe(0);
    expect(spec.segments.at(-1)!.position).toBe(1);
    expect(spec.mapType).toBe('Repeat');
  });

  it('Reflect 同样展开且颜色回折', () => {
    const { resolved } = bind(
      axial({
        mapType: 'Reflect',
        mapUnit: 2.5,
        segments: [stop(0, 255, 0, 0), stop(1, 0, 0, 255)],
      }),
    );
    const spec = (resolved as Extract<ResolvedPaint, { kind: 'gradient' }>).spec;
    if (spec.kind !== 'axial') throw new Error('expected axial');
    expect(spec.segments.length).toBeGreaterThan(2);
    const positions = spec.segments.map((segment) => segment.position);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThanOrEqual(positions[index - 1]!);
    }
  });

  it('Stop 数超过 512 时截断并 warning', () => {
    const warnings = warningCollector();
    const { resolved } = bind(
      axial({
        end: { x: 1000, y: 0 },
        mapType: 'Repeat',
        mapUnit: 1,
        segments: [
          stop(0, 255, 0, 0),
          stop(0.5, 0, 255, 0),
          stop(1, 0, 0, 255),
        ],
      }),
      { onWarning: warnings.warnings },
    );
    const spec = (resolved as Extract<ResolvedPaint, { kind: 'gradient' }>).spec;
    if (spec.kind !== 'axial') throw new Error('expected axial');
    expect(spec.segments.length).toBeLessThanOrEqual(MAX_GRADIENT_STOPS);
    expect(warnings.codes).toContain('W_UNSUPPORTED_PAINT');
  });

  it('Extend band：0/1/2 返回多边形，3 与退化轴返回 null', () => {
    const bounds = { x: 0, y: 0, w: 20, h: 20 };
    for (const extend of [0, 1, 2] as const) {
      const spec = (axial({ extend }).spec as AxialGradientSpec);
      expect(getAxialExtendBand(spec, bounds)).toHaveLength(4);
    }
    expect(getAxialExtendBand(axial({ extend: 3 }).spec as AxialGradientSpec, bounds)).toBeNull();
    expect(
      getAxialExtendBand(
        axial({ end: { x: 0, y: 0 } }).spec as AxialGradientSpec,
        bounds,
      ),
    ).toBeNull();
  });
});

describe('PaintBinder：径向渐变降级', () => {
  it('径向渐变 warning 并降级为平均色', () => {
    const warnings = warningCollector();
    const { resolved } = bind(
      {
        kind: 'gradient',
        spec: {
          kind: 'radial',
          start: { x: 0, y: 0 },
          startRadius: 0,
          end: { x: 10, y: 0 },
          endRadius: 10,
          mapType: 'Direct',
          extend: 0,
          segments: [stop(0, 255, 0, 0), stop(1, 0, 0, 255)],
        },
      },
      { onWarning: warnings.warnings },
    );
    expect(warnings.codes).toContain('W_RADIAL_UNSUPPORTED');
    expect(resolved).toEqual({
      kind: 'color',
      rgba: { r: 128, g: 0, b: 128, a: 255 },
    });
  });
});

describe('PaintBinder：网格渐变', () => {
  it('shading 原样交给渲染器', () => {
    const shading = {
      kind: 'gouraud' as const,
      points: [
        { x: 0, y: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
        { x: 10, y: 0, color: { r: 0, g: 255, b: 0, a: 255 } },
        { x: 0, y: 10, color: { r: 0, g: 0, b: 255, a: 255 } },
      ],
      extend: 0 as const,
    };
    const { resolved } = bind({ kind: 'shading', spec: shading });
    expect(resolved).toEqual({ kind: 'shading', spec: shading });
  });
});

describe('PaintBinder：底纹', () => {
  it('内联 tile 绑定为 PatternPaint，XStep/YStep 小于尺寸时按尺寸处理', () => {
    const { resolved } = bind(pattern({ xStep: 2, yStep: 1 }));
    expect(resolved?.kind).toBe('pattern');
    const paint = resolved as Extract<ResolvedPaint, { kind: 'pattern' }>;
    expect(paint.width).toBe(10);
    expect(paint.height).toBe(5);
    expect(paint.xStep).toBe(10);
    expect(paint.yStep).toBe(5);
    expect(paint.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    expect(paint.tile.commands.length).toBeGreaterThan(0);
  });

  it('Reflect 与 CTM 透传，CTM 作用于整个平铺排列', () => {
    const { resolved } = bind(
      pattern({ reflect: 'RowAndColumn', ctm: [2, 0, 0, 2, 1, 2] }),
    );
    const paint = resolved as Extract<ResolvedPaint, { kind: 'pattern' }>;
    expect(paint.reflect).toBe('RowAndColumn');
    expect(paint.ctm).toEqual([2, 0, 0, 2, 1, 2]);
  });

  it('通过 patternId 从 resolver 取 tile', () => {
    const resolver: PatternTileResolver = {
      resolvePatternTile: () => tile(),
    };
    const { resolved } = bind(
      pattern({ patternId: '7', tile: undefined }),
      { patterns: resolver },
    );
    expect(resolved?.kind).toBe('pattern');
  });

  it('缺少 tile 时警告并返回 undefined', () => {
    const warnings = warningCollector();
    const { resolved } = bind(pattern({ patternId: '7', tile: undefined }), {
      onWarning: warnings.warnings,
    });
    expect(resolved).toBeUndefined();
    expect(warnings.codes).toContain('W_UNSUPPORTED_PAINT');
  });

  it('tile 数超过上限时按 W_PATTERN_LIMIT 降级', () => {
    const warnings = warningCollector();
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer, { onWarning: warnings.warnings });
    const resolved = binder.bind(pattern(), { x: 0, y: 0, w: 100_000, h: 100_000 });
    expect(resolved).toBeUndefined();
    expect(warnings.codes).toContain('W_PATTERN_LIMIT');
    expect(countPatternTiles(
      patternSpec(),
      { x: 0, y: 0, w: 100_000, h: 100_000 },
    )).toBeGreaterThan(MAX_PATTERN_TILES);
  });

  it('RelativeTo=Page 缺少对象变换时警告并按 Object 处理', () => {
    const warnings = warningCollector();
    const { resolved } = bind(pattern({ relativeTo: 'Page' }), {
      onWarning: warnings.warnings,
    });
    expect(resolved?.kind).toBe('pattern');
    expect(warnings.codes).toContain('W_UNSUPPORTED_PAINT');
  });

  it('RelativeTo=Page 用逆对象变换把页面原点换到对象空间', () => {
    const { resolved } = bind(pattern({ relativeTo: 'Page' }), {
      objectToPage: () => [1, 0, 0, 1, 100, 50],
    });
    const paint = resolved as Extract<ResolvedPaint, { kind: 'pattern' }>;
    expect(paint.ctm[4]).toBe(-100);
    expect(paint.ctm[5]).toBe(-50);
  });

  it('相同 PaintSpec 命中缓存，返回同一对象', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const spec = axial();
    const first = binder.bind(spec);
    const second = binder.bind(spec);
    expect(second).toBe(first);
    binder.clear();
    const third = binder.bind(spec);
    expect(third).not.toBe(first);
  });
});