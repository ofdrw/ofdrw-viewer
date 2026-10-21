/**
 * T6a 路径解析与绘制单测。
 */

import { describe, expect, it } from 'vitest';
import type { PathCommand } from '../../../src/common/types';
import type { PathObject } from '../../../src/model/types';
import type { ResolvedStyle } from '../../../src/style/types';
import {
  PATH_CHUNK_SIZE,
  drawPathObject,
  emitPathCommands,
  getPathBounds,
  parseAbbreviatedData,
} from '../../../src/render/path';
import { createPaintBinder } from '../../../src/render/paint';
import { BASE_STYLE, FakeRenderer, warningCollector } from './fake-renderer';

function pathObject(data: string): PathObject {
  return {
    kind: 'path',
    boundary: { x: 0, y: 0, w: 100, h: 100 },
    alpha: 255,
    visible: true,
    data,
    fill: true,
    stroke: false,
    rule: 'nonzero',
  };
}

describe('parseAbbreviatedData', () => {
  it('解析 S/M/L/Q/B/A/C，支持空白/逗号/负数/小数/科学计数', () => {
    const commands = parseAbbreviatedData(
      'M10,20 L-30 40.5 Q1 2 3 4 B1 2 3 4 5 6 C',
    );
    expect(commands.map((command) => command.type)).toEqual([
      'moveTo',
      'lineTo',
      'quadraticCurveTo',
      'bezierCurveTo',
      'closePath',
    ]);
    expect(commands[0]).toEqual({ type: 'moveTo', x: 10, y: 20 });
    expect(commands[1]).toEqual({ type: 'lineTo', x: -30, y: 40.5 });

    const scientific = parseAbbreviatedData('M 1e2 -2.5e-1 L .5 1.');
    expect(scientific[0]).toEqual({ type: 'moveTo', x: 100, y: -0.25 });
    expect(scientific[1]).toEqual({ type: 'lineTo', x: 0.5, y: 1 });
  });

  it('操作符大小写不敏感，S 等价于 M', () => {
    const commands = parseAbbreviatedData('s 1 2 l 3 4');
    expect(commands[0]).toEqual({ type: 'moveTo', x: 1, y: 2 });
    expect(commands[1]).toEqual({ type: 'lineTo', x: 3, y: 4 });
  });

  it('坏 token 跳过并 warning，但不丢弃已有路径', () => {
    const warnings = warningCollector();
    const commands = parseAbbreviatedData('M 0 0 L 10 % 20', warnings.warnings);
    expect(warnings.codes).toContain('W_BAD_PATH');
    expect(commands[0]).toEqual({ type: 'moveTo', x: 0, y: 0 });
    expect(commands[1]).toEqual({ type: 'lineTo', x: 10, y: 20 });
  });

  it('参数不足跳过该命令并 warning，保留前序命令', () => {
    const warnings = warningCollector();
    const commands = parseAbbreviatedData('M 0 0 L 10', warnings.warnings);
    expect(commands).toEqual([{ type: 'moveTo', x: 0, y: 0 }]);
    expect(warnings.codes.filter((code) => code === 'W_BAD_PATH').length).toBeGreaterThan(0);
  });

  it('多余参数忽略并 warning', () => {
    const warnings = warningCollector();
    const commands = parseAbbreviatedData('M 0 0 L 1 2 3 4', warnings.warnings);
    expect(commands).toEqual([
      { type: 'moveTo', x: 0, y: 0 },
      { type: 'lineTo', x: 1, y: 2 },
    ]);
    expect(warnings.codes).toContain('W_BAD_PATH');
  });

  it('未知命令 warning 并继续解析后续命令', () => {
    const warnings = warningCollector();
    const commands = parseAbbreviatedData('M 0 0 Z 1 2 L 3 4', warnings.warnings);
    expect(warnings.codes).toContain('W_BAD_PATH');
    expect(commands.at(-1)).toEqual({ type: 'lineTo', x: 3, y: 4 });
  });

  it('未以 M/S 开头时按 (0,0) 隐式起点处理', () => {
    const warnings = warningCollector();
    const commands = parseAbbreviatedData('L 10 20', warnings.warnings);
    expect(commands[0]).toEqual({ type: 'moveTo', x: 0, y: 0 });
    expect(commands[1]).toEqual({ type: 'lineTo', x: 10, y: 20 });
    expect(warnings.codes).toContain('W_BAD_PATH');
  });

  it('零长度子路径保留 lineTo', () => {
    const commands = parseAbbreviatedData('M 5 5 L 5 5');
    expect(commands).toEqual([
      { type: 'moveTo', x: 5, y: 5 },
      { type: 'lineTo', x: 5, y: 5 },
    ]);
  });
});

describe('parseAbbreviatedData：圆弧', () => {
  it('半圆转成两段三次贝塞尔并落到终点', () => {
    const commands = parseAbbreviatedData('M 0 0 A 10 10 0 0 1 20 0');
    const curves = commands.filter((command) => command.type === 'bezierCurveTo');
    expect(curves).toHaveLength(2);
    const last = curves.at(-1) as Extract<PathCommand, { type: 'bezierCurveTo' }>;
    expect(last.x).toBeCloseTo(20, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });

  it('large/sweep 四种组合都生成合法贝塞尔段', () => {
    for (const large of [0, 1]) {
      for (const sweep of [0, 1]) {
        const commands = parseAbbreviatedData(`M 0 0 A 10 5 30 ${large} ${sweep} 20 0`);
        const curves = commands.filter((command) => command.type === 'bezierCurveTo');
        expect(curves.length).toBeGreaterThan(0);
        const last = curves.at(-1) as Extract<PathCommand, { type: 'bezierCurveTo' }>;
        expect(Number.isFinite(last.x)).toBe(true);
        expect(last.x).toBeCloseTo(20, 6);
      }
    }
  });

  it('半径包含 0 或起终点重合时退化为直线', () => {
    expect(parseAbbreviatedData('M 0 0 A 0 10 0 0 1 20 0')).toEqual([
      { type: 'moveTo', x: 0, y: 0 },
      { type: 'lineTo', x: 20, y: 0 },
    ]);
    expect(parseAbbreviatedData('M 5 5 A 10 10 0 1 1 5 5')).toEqual([
      { type: 'moveTo', x: 5, y: 5 },
      { type: 'lineTo', x: 5, y: 5 },
    ]);
  });
});

describe('emitPathCommands', () => {
  it('按命令映射到 Renderer 立即路径 API', () => {
    const renderer = new FakeRenderer();
    emitPathCommands(renderer, [
      { type: 'moveTo', x: 1, y: 2 },
      { type: 'lineTo', x: 3, y: 4 },
      { type: 'quadraticCurveTo', cpx: 5, cpy: 6, x: 7, y: 8 },
      { type: 'bezierCurveTo', cp1x: 9, cp1y: 10, cp2x: 11, cp2y: 12, x: 13, y: 14 },
      { type: 'closePath' },
    ]);
    expect(renderer.ops()).toEqual([
      'moveTo',
      'lineTo',
      'quadraticCurveTo',
      'cubicCurveTo',
      'closePath',
    ]);
  });
});

describe('getPathBounds', () => {
  it('控制点也计入保守包围盒', () => {
    const bounds = getPathBounds([
      { type: 'moveTo', x: 0, y: 0 },
      { type: 'bezierCurveTo', cp1x: 10, cp1y: -5, cp2x: 20, cp2y: 15, x: 30, y: 5 },
    ]);
    expect(bounds).toEqual({ x: 0, y: -5, w: 30, h: 20 });
  });
});

describe('drawPathObject', () => {
  it('填充/描边、FillRule、Cap/Join/MiterLimit 与 hairline 线宽传递正确', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const style: ResolvedStyle = {
      ...BASE_STYLE,
      lineWidth: 0,
      lineCap: 'Round',
      lineJoin: 'Bevel',
      miterLimit: 2,
      fillRule: 'evenodd',
    };
    drawPathObject({ renderer, binder }, pathObject('M 0 0 L 10 0 L 10 10 C'), style);
    expect(renderer.ops().filter((op) => op === 'beginPath')).toHaveLength(1);
    const fill = renderer.callsOf('fill')[0]!;
    expect((fill.args[0] as ResolvedStyle).lineWidth).toBe(0);
    expect((fill.args[0] as ResolvedStyle).lineCap).toBe('Round');
    expect((fill.args[0] as ResolvedStyle).lineJoin).toBe('Bevel');
    expect((fill.args[0] as ResolvedStyle).miterLimit).toBe(2);
    expect(fill.args[2]).toBe('evenodd');
    expect(renderer.callsOf('stroke')).toHaveLength(1);
  });

  it('虚线至少两段正数才生效；DashOffset 只在虚线时保留', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    drawPathObject(
      { renderer, binder },
      pathObject('M 0 0 L 10 10'),
      { ...BASE_STYLE, dashPattern: [5], dashOffset: 3 },
    );
    let style = renderer.callsOf('stroke')[0]!.args[0] as ResolvedStyle;
    expect(style.dashPattern).toEqual([]);
    expect(style.dashOffset).toBe(0);

    renderer.calls.length = 0;
    drawPathObject(
      { renderer, binder },
      pathObject('M 0 0 L 10 10'),
      { ...BASE_STYLE, dashPattern: [5, 2], dashOffset: 3 },
    );
    style = renderer.callsOf('stroke')[0]!.args[0] as ResolvedStyle;
    expect(style.dashPattern).toEqual([5, 2]);
    expect(style.dashOffset).toBe(3);
  });

  it('透明填充不调用 fill，描边仍执行', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    drawPathObject(
      { renderer, binder },
      pathObject('M 0 0 L 10 10'),
      { ...BASE_STYLE, fillPaint: { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 0 } } },
    );
    expect(renderer.callsOf('fill')).toHaveLength(0);
    expect(renderer.callsOf('stroke')).toHaveLength(1);
  });

  it('空路径不产生任何渲染调用', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    drawPathObject({ renderer, binder }, pathObject(''), BASE_STYLE);
    expect(renderer.calls).toHaveLength(0);
  });

  it('超过 50k 命令分块构建/绘制并 warning', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const warnings = warningCollector();
    const data = `M 0 0 ${'L 1 1 '.repeat(PATH_CHUNK_SIZE + 2)}`;
    drawPathObject(
      { renderer, binder, onWarning: warnings.warnings },
      pathObject(data),
      BASE_STYLE,
    );
    expect(renderer.callsOf('beginPath').length).toBeGreaterThan(1);
    expect(renderer.callsOf('fill').length).toBeGreaterThan(1);
    expect(warnings.codes).toContain('W_BAD_PATH');
  });

  it('渐变/底纹描边 v1 降级为平均色并 warning', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const warnings = warningCollector();
    const style: ResolvedStyle = {
      ...BASE_STYLE,
      fill: false,
      strokePaint: {
        kind: 'gradient',
        spec: {
          kind: 'axial',
          start: { x: 0, y: 0 },
          end: { x: 10, y: 0 },
          mapType: 'Direct',
          extend: 3,
          segments: [
            { position: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
            { position: 1, color: { r: 0, g: 0, b: 255, a: 255 } },
          ],
        },
      },
    };
    drawPathObject(
      { renderer, binder, onWarning: warnings.warnings },
      pathObject('M 0 0 L 10 0 L 10 10 C'),
      style,
    );
    expect(warnings.codes).toContain('W_UNSUPPORTED_PAINT');
    const paint = renderer.callsOf('stroke')[0]!.args[1] as {
      kind: string;
      rgba: { r: number; g: number; b: number; a: number };
    };
    expect(paint.kind).toBe('color');
    expect(paint.rgba).toEqual({ r: 128, g: 0, b: 128, a: 255 });
  });

  it('轴向渐变 Extend=3 不裁剪，0/1/2 构造 band 裁剪', () => {
    for (const extend of [0, 1, 2, 3] as const) {
      const renderer = new FakeRenderer();
      const binder = createPaintBinder(renderer);
      const style: ResolvedStyle = {
        ...BASE_STYLE,
        stroke: false,
        fillPaint: {
          kind: 'gradient',
          spec: {
            kind: 'axial',
            start: { x: 0, y: 0 },
            end: { x: 10, y: 0 },
            mapType: 'Direct',
            extend,
            segments: [
              { position: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
              { position: 1, color: { r: 0, g: 0, b: 255, a: 255 } },
            ],
          },
        },
      };
      drawPathObject({ renderer, binder }, pathObject('M 0 0 L 10 0 L 10 10 C'), style);
      expect(renderer.callsOf('clip')).toHaveLength(extend === 3 ? 0 : 1);
    }
  });

  it('轴向渐变 Extend=0 时按路径包围盒构造 band 裁剪', () => {
    const renderer = new FakeRenderer();
    const binder = createPaintBinder(renderer);
    const style: ResolvedStyle = {
      ...BASE_STYLE,
      stroke: false,
      fillPaint: {
        kind: 'gradient',
        spec: {
          kind: 'axial',
          start: { x: 0, y: 0 },
          end: { x: 10, y: 0 },
          mapType: 'Direct',
          extend: 0,
          segments: [
            { position: 0, color: { r: 255, g: 0, b: 0, a: 255 } },
            { position: 1, color: { r: 0, g: 0, b: 255, a: 255 } },
          ],
        },
      },
    };
    drawPathObject({ renderer, binder }, pathObject('M 0 -5 L 10 -5 L 10 5 L 0 5 C'), style);
    const clips = renderer.callsOf('clip');
    expect(clips).toHaveLength(1);
    expect(renderer.callsOf('fill')).toHaveLength(1);
    // band 多边形在 clip 之前：moveTo + 3 lineTo + closePath。
    const clipIndex = renderer.calls.findIndex((call) => call.op === 'clip');
    const bandLineTo = renderer.calls
      .slice(0, clipIndex)
      .filter((call) => call.op === 'lineTo');
    expect(bandLineTo).toHaveLength(3);
  });
});