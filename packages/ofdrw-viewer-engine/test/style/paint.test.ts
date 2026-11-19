import { describe, expect, it, vi } from 'vitest';
import type { Paint } from '../../src/model/types';
import { resolvePaint } from '../../src/style/paint';

describe('resolvePaint', () => {
  it('径向渐变产出 gradient/radial，几何与离心率/倾角原样透传', () => {
    const onWarning = vi.fn();
    const paint: Paint = {
      type: 'radial',
      shade: {
        start: { x: 0, y: 0 },
        startRadius: 1,
        end: { x: 10, y: 10 },
        endRadius: 20,
        eccentricity: 0.6,
        angle: 45,
        mapType: 'Direct',
        extend: 1,
        segments: [
          { position: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
          { position: 1, color: { r: 0, g: 0, b: 255, a: 255 } },
        ],
      },
    };
    expect(resolvePaint(paint, onWarning)).toEqual({
      kind: 'gradient',
      spec: {
        kind: 'radial',
        start: { x: 0, y: 0 },
        startRadius: 1,
        end: { x: 10, y: 10 },
        endRadius: 20,
        eccentricity: 0.6,
        angle: 45,
        mapType: 'Direct',
        extend: 1,
        segments: [
          { position: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
          { position: 1, color: { r: 0, g: 0, b: 255, a: 255 } },
        ],
      },
    });
    // 不再降级为平均色，也不再上报 W_RADIAL_UNSUPPORTED。
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('轴向渐变产出 gradient/axial', () => {
    const paint: Paint = {
      type: 'axial',
      shade: {
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        mapType: 'Direct',
        extend: 3,
        segments: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 255 } }],
      },
    };
    const spec = resolvePaint(paint);
    expect(spec?.kind).toBe('gradient');
    if (spec?.kind !== 'gradient') return;
    expect(spec.spec.kind).toBe('axial');
  });

  it('Gouraud 点数不足时 warning 并忽略', () => {
    const onWarning = vi.fn();
    const paint: Paint = {
      type: 'gouraud',
      shade: {
        points: [{ x: 0, y: 0, color: { r: 0, g: 0, b: 0, a: 255 } }],
        extend: 0,
      },
    };
    expect(resolvePaint(paint, onWarning)).toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith('W_GOURAUD_APPROX', expect.any(String));
  });

  it('Pattern 分支填写 patternId；内联无 ID 时保留缺省', () => {
    const cell = { kind: 'block' as const, children: [] };
    const withId: Paint = {
      type: 'pattern',
      pattern: {
        id: '42',
        width: 10,
        height: 10,
        xStep: 10,
        yStep: 10,
        reflectMethod: 'Normal',
        relativeTo: 'Object',
        cell,
      },
    };
    const spec = resolvePaint(withId);
    expect(spec?.kind).toBe('pattern');
    if (spec?.kind === 'pattern') expect(spec.spec.patternId).toBe('42');

    const withoutId: Paint = {
      type: 'pattern',
      pattern: {
        width: 10,
        height: 10,
        xStep: 10,
        yStep: 10,
        reflectMethod: 'Normal',
        relativeTo: 'Object',
        cell,
      },
    };
    const fallback = resolvePaint(withoutId);
    if (fallback?.kind === 'pattern') expect(fallback.spec.patternId).toBeUndefined();
  });
});