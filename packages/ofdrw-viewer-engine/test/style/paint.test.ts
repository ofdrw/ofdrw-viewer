import { describe, expect, it, vi } from 'vitest';
import type { Paint } from '../../src/model/types';
import { resolvePaint } from '../../src/style/paint';

describe('resolvePaint', () => {
  it('径向渐变 v1 降级为平均色并 warning', () => {
    const onWarning = vi.fn();
    const paint: Paint = {
      type: 'radial',
      shade: {
        start: { x: 0, y: 0 },
        startRadius: 1,
        end: { x: 10, y: 10 },
        endRadius: 20,
        mapType: 'Direct',
        extend: 0,
        segments: [
          { position: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
          { position: 1, color: { r: 0, g: 0, b: 255, a: 255 } },
        ],
      },
    };
    expect(resolvePaint(paint, onWarning)).toEqual({
      kind: 'color',
      rgba: { r: 128, g: 0, b: 128, a: 255 },
    });
    expect(onWarning).toHaveBeenCalledWith('W_RADIAL_UNSUPPORTED', expect.any(String));
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
});