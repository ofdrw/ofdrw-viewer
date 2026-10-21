import { describe, expect, it, vi } from 'vitest';
import type { ColorSpaceDef, ResourceId } from '../../src/model/types';
import { decodeBasicColor, decodePaint } from '../../src/model/paint';
import { decodePageBlockNode } from '../../src/model/content';
import { leaf, node } from './xml';

/** 构造颜色空间表。 */
function spaces(...items: ColorSpaceDef[]): Map<ResourceId, ColorSpaceDef> {
  return new Map(items.map((item) => [item.id, item]));
}

describe('颜色解析', () => {
  it('GRAY/RGB(16 位)/CMYK 位深换算', () => {
    const gray = decodeBasicColor(node('FillColor', { Value: '128', ColorSpace: '1', Alpha: '200' }), {
      colorSpaces: spaces({ id: '1', type: 'GRAY', bitsPerComponent: 8 }),
    });
    expect(gray).toEqual({ r: 128, g: 128, b: 128, a: 200 });

    const rgb = decodeBasicColor(node('FillColor', { Value: '65535 0 32768', ColorSpace: '1' }), {
      colorSpaces: spaces({ id: '1', type: 'RGB', bitsPerComponent: 16 }),
    });
    expect(rgb).toEqual({ r: 255, g: 0, b: 128, a: 255 });

    const cmyk = decodeBasicColor(node('FillColor', { Value: '0 255 255 0', ColorSpace: '1' }), {
      colorSpaces: spaces({ id: '1', type: 'CMYK', bitsPerComponent: 8 }),
    });
    expect(cmyk).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('#RRGGBB 与逐通道 #hex', () => {
    const rgb = decodeBasicColor(node('FillColor', { Value: '#12AB34' }), {});
    expect(rgb).toEqual({ r: 0x12, g: 0xab, b: 0x34, a: 255 });
    const channels = decodeBasicColor(node('FillColor', { Value: '#FF #80 0', ColorSpace: '1' }), {
      colorSpaces: spaces({ id: '1', type: 'RGB', bitsPerComponent: 8 }),
    });
    expect(channels).toEqual({ r: 255, g: 128, b: 0, a: 255 });
  });

  it('调色板 Index 从 0 开始，越界 warning 回退黑色', () => {
    const space: ColorSpaceDef = {
      id: '5',
      type: 'RGB',
      bitsPerComponent: 8,
      palette: [
        { r: 255, g: 0, b: 0, a: 255 },
        { r: 0, g: 255, b: 0, a: 255 },
      ],
    };
    const context = { colorSpaces: spaces(space) };
    expect(decodeBasicColor(node('FillColor', { Index: '1', ColorSpace: '5' }), context)).toEqual({
      r: 0,
      g: 255,
      b: 0,
      a: 255,
    });
    const onWarning = vi.fn();
    expect(
      decodeBasicColor(node('FillColor', { Index: '9', ColorSpace: '5' }), { ...context, onWarning }),
    ).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_BAD_NUMBER' }));
  });

  it('DefaultCS 生效；未知 ColorSpace 回退 RGB 并 warning', () => {
    const gray: ColorSpaceDef = { id: '7', type: 'GRAY', bitsPerComponent: 8 };
    const color = decodeBasicColor(node('FillColor', { Value: '64' }), {
      colorSpaces: spaces(gray),
      defaultColorSpaceId: '7',
    });
    expect(color).toEqual({ r: 64, g: 64, b: 64, a: 255 });
    const onWarning = vi.fn();
    expect(decodeBasicColor(node('FillColor', { Value: '1 2 3', ColorSpace: '404' }), { onWarning })).toEqual({
      r: 1,
      g: 2,
      b: 3,
      a: 255,
    });
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'W_BAD_NUMBER' }));
  });
});

describe('复杂 Paint', () => {
  it('轴向渐变：补齐位置、MapType/Extend', () => {
    const fill = node('FillColor', {}, [
      node('AxialShd', { StartPoint: '0 0', EndPoint: '10 0', MapType: 'Repeat', Extend: '1' }, [
        node('Segment', { Position: '0.2' }, [node('Color', { Value: '#FF0000' })]),
        node('Segment', {}, [node('Color', { Value: '#00FF00' })]),
        node('Segment', { Position: '0.8' }, [node('Color', { Value: '#0000FF' })]),
      ]),
    ]);
    const paint = decodePaint(fill, {});
    expect(paint.type).toBe('axial');
    if (paint.type !== 'axial') return;
    expect(paint.shade.mapType).toBe('Repeat');
    expect(paint.shade.extend).toBe(1);
    expect(paint.shade.segments.map((segment) => segment.position)).toEqual([0.2, 0.5, 0.8]);
    expect(paint.shade.segments[1]?.color).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it('底纹：xStep 小于 width 时按 width，CellContent 解码，ID 收集', () => {
    const patterns = new Map<ResourceId, import('../../src/model/types').Pattern>();
    const fill = node('FillColor', {}, [
      node('Pattern', {
        ID: '#20',
        Width: '10',
        Height: '20',
        XStep: '5',
        YStep: '10',
        ReflectMethod: 'Row',
        RelativeTo: 'Page',
      }, [
        node('CellContent', {}, [
          node('PathObject', { Boundary: '0 0 10 20' }, [leaf('AbbreviatedData', 'M 0 0 L 1 1')]),
        ]),
      ]),
    ]);
    const paint = decodePaint(fill, {
      patterns,
      decodePageBlock: (cell, context) => decodePageBlockNode(cell, context),
    });
    expect(paint.type).toBe('pattern');
    if (paint.type !== 'pattern') return;
    expect(paint.pattern.xStep).toBe(10);
    expect(paint.pattern.yStep).toBe(20);
    expect(paint.pattern.reflectMethod).toBe('Row');
    expect(paint.pattern.relativeTo).toBe('Page');
    expect(paint.pattern.cell.children[0]?.kind).toBe('path');
    expect(patterns.get('20')).toBe(paint.pattern);
  });

  it('Gouraud 点与颜色', () => {
    const fill = node('FillColor', {}, [
      node('GouraudShd', { Extend: '1' }, [
        node('Point', { X: '0', Y: '0' }, [node('Color', { Value: '#FF0000' })]),
        node('Point', { X: '10', Y: '0' }, [node('Color', { Value: '#00FF00' })]),
        node('Point', { X: '0', Y: '10' }, [node('Color', { Value: '#0000FF' })]),
      ]),
    ]);
    const paint = decodePaint(fill, {});
    expect(paint.type).toBe('gouraud');
    if (paint.type !== 'gouraud') return;
    expect(paint.shade.points).toHaveLength(3);
    expect(paint.shade.points[1]?.color).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(paint.shade.extend).toBe(1);
  });
});