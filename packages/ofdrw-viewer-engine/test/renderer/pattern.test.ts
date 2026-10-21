/**
 * 底纹（pattern）测试：tile 生命周期、ReflectMethod、间隙、CTM、嵌套与降级。
 */

import { describe, expect, it } from 'vitest';
import { H5Canvas2DRenderer } from '../../src/renderer/canvas2d';
import { isOFDError } from '../../src/errors';
import type { DisplayList, DrawCommand } from '../../src/common/display-list';
import type {
  DrawStyle,
  ResolvedPaint,
  Rgba,
  Viewport,
} from '../../src/common/types';
import { createCountingFactory, createNodeCanvas, readPixel } from './helpers';

/** 测试用线型。 */
const STYLE: DrawStyle = {
  lineWidth: 1,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 10,
  dashOffset: 0,
  dashPattern: [],
};

/** 红色。 */
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 透明填充命令。 */
const FILL_RED = {
  op: 'fill' as const,
  style: STYLE,
  paint: { kind: 'color' as const, rgba: RED },
  rule: 'nonzero' as const,
};

/** 96 DPI viewport。 */
function viewport(width: number, height: number): Viewport {
  return { width, height, dpi: 96 };
}

/**
 * 构造 tile：左半边红色、右半边透明。
 *
 * @param width tile 宽（对象空间单位）。
 * @param height tile 高（对象空间单位）。
 * @returns DisplayList。
 */
function leftHalfTile(width: number, height: number): DisplayList {
  return {
    bounds: { x: 0, y: 0, w: width, h: height },
    commands: [
      { op: 'beginPath' },
      { op: 'rect', x: 0, y: 0, w: width / 2, h: height },
      FILL_RED,
    ],
  };
}

/**
 * 构造纯红 tile。
 *
 * @param width tile 宽。
 * @param height tile 高。
 * @returns DisplayList。
 */
function solidTile(width: number, height: number): DisplayList {
  return {
    bounds: { x: 0, y: 0, w: width, h: height },
    commands: [{ op: 'beginPath' }, { op: 'rect', x: 0, y: 0, w: width, h: height }, FILL_RED],
  };
}

/**
 * 构造 PatternPaint。
 *
 * @param tile tile 列表。
 * @param width tile 宽，对象空间单位。
 * @param height tile 高，对象空间单位。
 * @param xStep 水平步进。
 * @param yStep 垂直步进。
 * @param reflect 反射方式。
 * @param ctm 排列矩阵。
 * @returns ResolvedPaint。
 */
function patternPaint(
  tile: DisplayList,
  width: number,
  height: number,
  xStep: number,
  yStep: number,
  reflect: 'Normal' | 'Column' | 'Row' | 'RowAndColumn',
  ctm: readonly [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0],
): ResolvedPaint {
  return { kind: 'pattern', tile, width, height, xStep, yStep, reflect, ctm };
}

describe('H5Canvas2DRenderer pattern', () => {
  it('Normal 平铺：createPattern(repeat) 路径正确重复 tile', () => {
    const { context } = createNodeCanvas(20, 10);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(20, 10));

    renderer.beginPath();
    renderer.rect(0, 0, 8, 2);
    renderer.fill(STYLE, patternPaint(leftHalfTile(2, 2), 2, 2, 2, 2, 'Normal'), 'nonzero');

    expect(readPixel(context, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 2, 0)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 3, 0)).toEqual([0, 0, 0, 0]);

    // tile 由 renderer 内部创建并在 fill 后销毁，engine 不接触 surface。
    expect(factory.created.length).toBe(1);
    expect(factory.created[0]!.width).toBe(0);
    renderer.endPage();
    renderer.close();
  });

  it('ReflectMethod=Column：奇数列水平翻转', () => {
    const { context } = createNodeCanvas(20, 10);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(20, 10));

    renderer.beginPath();
    renderer.rect(0, 0, 4, 2);
    renderer.fill(STYLE, patternPaint(leftHalfTile(2, 2), 2, 2, 2, 2, 'Column'), 'nonzero');

    // 第 0 列：红在左；第 1 列翻转后：红在右。
    expect(readPixel(context, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 3, 0)).toEqual([255, 0, 0, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('ReflectMethod=Row：奇数行垂直翻转', () => {
    const { context } = createNodeCanvas(10, 20);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(10, 20));

    // tile 上半红、下半透明。
    const tile: DisplayList = {
      bounds: { x: 0, y: 0, w: 2, h: 2 },
      commands: [
        { op: 'beginPath' },
        { op: 'rect', x: 0, y: 0, w: 2, h: 1 },
        FILL_RED,
      ],
    };
    renderer.beginPath();
    renderer.rect(0, 0, 2, 4);
    renderer.fill(STYLE, patternPaint(tile, 2, 2, 2, 2, 'Row'), 'nonzero');

    // 第 0 行红在上；第 1 行翻转后红在下。
    expect(readPixel(context, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 0, 1)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 0, 2)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 0, 3)).toEqual([255, 0, 0, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('XStep/YStep 大于 tile 尺寸时手动平铺并留出间隙', () => {
    const { context } = createNodeCanvas(10, 10);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(10, 10));

    renderer.beginPath();
    renderer.rect(0, 0, 4, 2);
    renderer.fill(STYLE, patternPaint(solidTile(1, 1), 1, 1, 2, 2, 'Normal'), 'nonzero');

    expect(readPixel(context, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 2, 0)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 3, 0)).toEqual([0, 0, 0, 0]);
    renderer.endPage();
    renderer.close();
  });

  it('Pattern.CTM 作用于整个平铺排列，而不是单个 tile', () => {
    const { context } = createNodeCanvas(10, 10);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(10, 10));

    renderer.beginPath();
    renderer.rect(0, 0, 4, 2);
    renderer.fill(
      STYLE,
      patternPaint(leftHalfTile(2, 2), 2, 2, 2, 2, 'Normal', [1, 0, 0, 1, 1, 0]),
      'nonzero',
    );

    // 排列整体平移 1：tile 左半红，所以对象 x∈[0,1) 落在上一 tile 的透明半区。
    expect(readPixel(context, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(readPixel(context, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(readPixel(context, 3, 0)).toEqual([255, 0, 0, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('超过 10,000 tile 时按平均色降级并上报 W_PATTERN_LIMIT', () => {
    const { context } = createNodeCanvas(420, 420);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    const warnings: string[] = [];
    renderer.onWarning = (code) => warnings.push(code);
    renderer.beginPage(context, viewport(420, 420));

    renderer.beginPath();
    renderer.rect(0, 0, 400, 400);
    renderer.fill(STYLE, patternPaint(solidTile(1, 1), 1, 1, 2, 2, 'Normal'), 'nonzero');

    expect(warnings).toContain('W_PATTERN_LIMIT');
    expect(readPixel(context, 5, 5)).toEqual([255, 0, 0, 255]);
    renderer.endPage();
    renderer.close();
  });

  it('未注入 createCanvas 时 pattern 抛 OFD_RENDERER_UNSUPPORTED', () => {
    const { context } = createNodeCanvas(20, 20);
    const renderer = new H5Canvas2DRenderer();
    renderer.beginPage(context, viewport(20, 20));
    renderer.beginPath();
    renderer.rect(0, 0, 4, 4);
    try {
      renderer.fill(STYLE, patternPaint(solidTile(1, 1), 1, 1, 1, 1, 'Normal'), 'nonzero');
      throw new Error('expected fill to throw');
    } catch (error) {
      expect(isOFDError(error)).toBe(true);
      if (isOFDError(error)) expect(error.code).toBe('OFD_RENDERER_UNSUPPORTED');
    }
    renderer.endPage();
    renderer.close();
  });

  it('pattern 嵌套超过深度上限时降级而不是无限递归', () => {
    const { context } = createNodeCanvas(20, 20);
    const factory = createCountingFactory();
    const renderer = new H5Canvas2DRenderer({ createCanvas: factory.createCanvas });
    renderer.beginPage(context, viewport(20, 20));

    // 构造自引用的 tile：fill 使用同一个 pattern。
    const commands: DrawCommand[] = [
      { op: 'beginPath' },
      { op: 'rect', x: 0, y: 0, w: 1, h: 1 },
    ];
    const tile: DisplayList = { bounds: { x: 0, y: 0, w: 1, h: 1 }, commands };
    const nested = patternPaint(tile, 1, 1, 1, 1, 'Normal');
    commands.push({ op: 'fill', style: STYLE, paint: nested, rule: 'nonzero' });

    renderer.beginPath();
    renderer.rect(0, 0, 2, 2);
    expect(() => renderer.fill(STYLE, nested, 'nonzero')).not.toThrow();
    renderer.endPage();
    renderer.close();
  });

  it('不向 engine 暴露 surface 方法', () => {
    const renderer = new H5Canvas2DRenderer({ createCanvas: createCountingFactory().createCanvas });
    expect('createSurface' in renderer).toBe(false);
    expect('beginSurface' in renderer).toBe(false);
    expect('drawSurface' in renderer).toBe(false);
  });
});