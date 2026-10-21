/**
 * 模型 Paint → 渲染器可消费的 `PaintSpec`（纯函数，不依赖 Canvas/DOM）。
 *
 * 径向渐变 v1 降级为平均色；底纹只产出 `PatternSpec`，tile 由准备阶段构建。
 */

import type { Rgba } from '../common/types';
import type { Paint, Pattern } from '../model/types';
import type { PaintSpec } from '../common/types';
import type { ResolvedStyle } from './types';

/** warning 回调。 */
export type StyleWarningHandler = (code: string, message: string, resourceId?: string) => void;

/** 模式 tile 的默认继承起点；与 createDefaultStyle 的线型/颜色保持一致。 */
const DEFAULT_BLACK: PaintSpec = Object.freeze({
  kind: 'color',
  rgba: Object.freeze({ r: 0, g: 0, b: 0, a: 255 }),
});

const DEFAULT_STYLE_ROOT: ResolvedStyle = Object.freeze({
  lineWidth: 0.353,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 4.234,
  dashOffset: 0,
  dashPattern: [],
  fillPaint: DEFAULT_BLACK,
  strokePaint: DEFAULT_BLACK,
  fill: false,
  stroke: false,
  fillRule: 'nonzero',
  alpha: 1,
});

/** 复制 RGBA，避免调用方修改模型对象。 */
function cloneRgba(color: Rgba): Rgba {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

/**
 * 计算平均色，用于径向渐变降级。
 *
 * @param segments 颜色段，颜色为 RGBA8。
 * @returns 平均 RGBA；无颜色段时返回黑色不透明。
 */
function averageColor(segments: readonly { color: Rgba }[]): Rgba {
  if (segments.length === 0) return { r: 0, g: 0, b: 0, a: 255 };
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const segment of segments) {
    r += segment.color.r;
    g += segment.color.g;
    b += segment.color.b;
    a += segment.color.a;
  }
  const count = segments.length;
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
    a: Math.round(a / count),
  };
}

/**
 * 底纹模型转 `PatternSpec`。
 *
 * @param pattern 底纹模型；宽度/步进单位与对象空间一致（通常 mm）。
 * @param styleRoot tile 内对象的继承起点。
 * @returns PatternSpec。
 */
function toPatternSpec(pattern: Pattern, styleRoot: ResolvedStyle): PaintSpec {
  const spec = {
    width: pattern.width,
    height: pattern.height,
    xStep: Math.max(pattern.xStep, pattern.width),
    yStep: Math.max(pattern.yStep, pattern.height),
    reflect: pattern.reflectMethod,
    relativeTo: pattern.relativeTo,
    cell: pattern.cell,
    styleRoot,
    ...(pattern.ctm ? { ctm: pattern.ctm } : {}),
  };
  return { kind: 'pattern', spec };
}

/**
 * 把模型层 Paint 归一化为渲染器可绑定的 PaintSpec。
 *
 * 径向渐变 v1 降级：返回平均色并上报 `W_RADIAL_UNSUPPORTED`；
 * 底纹在此只生成 PatternSpec，tile 由 PaintBinder 填充。
 *
 * @param paint 模型 Paint。
 * @param onWarning warning 回调。
 * @param styleRoot 底纹 tile 的继承起点；缺省使用标准文档默认样式。
 * @returns PaintSpec；无法表达时返回 undefined。
 */
export function resolvePaint(
  paint: Paint,
  onWarning?: StyleWarningHandler,
  styleRoot: ResolvedStyle = DEFAULT_STYLE_ROOT,
): PaintSpec | undefined {
  switch (paint.type) {
    case 'color':
      return { kind: 'color', rgba: cloneRgba(paint.color) };
    case 'axial': {
      const shade = paint.shade;
      if (shade.segments.length === 0) {
        onWarning?.('W_UNSUPPORTED_PAINT', '轴向渐变没有颜色段，已忽略');
        return undefined;
      }
      return {
        kind: 'gradient',
        spec: {
          kind: 'axial',
          start: { ...shade.start },
          end: { ...shade.end },
          mapType: shade.mapType,
          ...(shade.mapUnit !== undefined ? { mapUnit: shade.mapUnit } : {}),
          extend: shade.extend,
          segments: shade.segments.map((segment) => ({
            position: segment.position,
            color: cloneRgba(segment.color),
          })),
        },
      };
    }
    case 'radial': {
      // v1 不实现径向渐变；按设计方案 13.3 用平均色降级，不用 Canvas 径向渐变近似。
      const shade = paint.shade;
      onWarning?.('W_RADIAL_UNSUPPORTED', '径向渐变 v1 降级为平均色');
      return { kind: 'color', rgba: cloneRgba(averageColor(shade.segments)) };
    }
    case 'gouraud': {
      const shade = paint.shade;
      if (shade.points.length < 3) {
        onWarning?.('W_GOURAUD_APPROX', '网格渐变控制点不足，已忽略');
        return undefined;
      }
      return {
        kind: 'shading',
        spec: {
          kind: shade.verticesPerRow === undefined ? 'gouraud' : 'lagouraud',
          points: shade.points.map((point) => ({
            x: point.x,
            y: point.y,
            color: cloneRgba(point.color),
            ...(point.edgeFlag !== undefined ? { edgeFlag: point.edgeFlag } : {}),
          })),
          ...(shade.verticesPerRow !== undefined ? { verticesPerRow: shade.verticesPerRow } : {}),
          extend: shade.extend,
          ...(shade.backColor ? { backColor: cloneRgba(shade.backColor) } : {}),
        },
      };
    }
    case 'pattern':
      return toPatternSpec(paint.pattern, styleRoot);
    default:
      return undefined;
  }
}

/**
 * 计算径向渐变降级平均色（保留给需要直接取色的准备阶段调用）。
 *
 * @param paint 模型 Paint。
 * @returns 平均 RGBA；非径向渐变时返回其主色/黑色。
 */
export function resolveAverageColor(paint: Paint): Rgba {
  if (paint.type === 'color') return cloneRgba(paint.color);
  if (paint.type === 'radial') return averageColor(paint.shade.segments);
  if (paint.type === 'axial') return averageColor(paint.shade.segments);
  if (paint.type === 'gouraud') return averageColor(paint.shade.points);
  return { r: 0, g: 0, b: 0, a: 255 };
}