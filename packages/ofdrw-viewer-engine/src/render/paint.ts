/**
 * PaintSpec → ResolvedPaint 绑定。
 *
 * 绑定发生在样式结算之后、绘制之前：样式层只产出 PaintSpec，本层把渐变段归一化、
 * 把底纹 cell 显示列表挂到 PatternPaint 上、把径向渐变降级为纯色。渲染器不接触
 * OFD 结构，也不负责判断 Extend band。
 */

import type {
  AxialGradientSpec,
  Box,
  GradientExtend,
  GradientSpec,
  GradientStop,
  Matrix,
  PaintSpec,
  PatternPaint,
  PatternSpec,
  Point,
  ResolvedPaint,
  Rgba,
} from '../common/types';
import type { DisplayList } from '../common/display-list';
import type { Renderer } from '../renderer/types';
import { IDENTITY_MATRIX, invertMatrix, translateMatrix } from '../common/matrix';

/** 渐变 stop 上限；超过后截断并 warning（设计方案 13.2）。 */
export const MAX_GRADIENT_STOPS = 512;

/** 单次填充的底纹 tile 上限；超过后按纯色近似（设计方案 13.4）。 */
export const MAX_PATTERN_TILES = 10_000;

/** 默认输出 DPI，用于缓存分桶。 */
const DEFAULT_DPI = 96;

/** 缓存分桶宽度（dpi）；32 的桶宽足以覆盖 96/144/300 三种常用精度。 */
const DPI_BUCKET_SIZE = 32;

/** 底纹 tile 解析器；由 prepare 阶段的 BlockStore 提供。 */
export interface PatternTileResolver {
  /**
   * 按底纹资源 ID 取预构建的 tile 显示列表。
   *
   * @param patternId 底纹资源 ID。
   * @returns tile DisplayList；缺失时返回 undefined。
   */
  resolvePatternTile(patternId: string): DisplayList | undefined;
}

/** PaintBinder 创建参数。 */
export interface PaintBindingContext {
  /** 底纹 tile 解析器；没有底纹时可省略。 */
  patterns?: PatternTileResolver;
  /** warning 回调（例如底纹 tile 超限降级）。 */
  onWarning?: (code: string, message: string, patternId?: string) => void;
  /** 输出 DPI，默认 96；只用于缓存分桶与替换图判断（后者在 image 层）。 */
  dpi?: number;
  /**
   * 当前对象到页面的变换（对象空间 → 页面空间）。
   *
   * `RelativeTo=Page` 的底纹需要把页面原点换算回对象空间；缺失时按 Object 处理
   * 并 warning。绘制每个对象时由 T10 更新该闭包返回的矩阵。
   */
  objectToPage?: () => Matrix | null;
}

/** per-renderer 的 Paint 绑定器；按 PaintSpec 规范哈希 + dpiBucket 缓存。 */
export interface PaintBinder {
  /**
   * 绑定 PaintSpec。
   *
   * @param spec 样式层 PaintSpec。
   * @param bounds 可选对象包围盒（对象空间，通常 mm）；底纹 tile 上限需要它。
   * @returns 渲染器可消费的 ResolvedPaint；无法绑定时返回 undefined。
   */
  bind(spec: PaintSpec | undefined, bounds?: Box): ResolvedPaint | undefined;
  /** 清空内部绑定缓存。 */
  clear(): void;
}

/**
 * 创建 PaintBinder。
 *
 * @param renderer 目标渲染器；渐变/底纹能力最终由渲染器消费。
 * @param context 底纹解析、DPI、对象变换与 warning 回调。
 * @returns PaintBinder。
 */
export function createPaintBinder(
  renderer: Renderer,
  context: PaintBindingContext = {},
): PaintBinder {
  void renderer;
  const cache = new Map<string, ResolvedPaint | null>();

  const warn = (code: string, message: string, patternId?: string): void => {
    context.onWarning?.(code, message, patternId);
  };

  const resolve = (spec: PaintSpec, bounds?: Box): ResolvedPaint | undefined => {
    switch (spec.kind) {
      case 'color':
        return { kind: 'color', rgba: normalizeRgba(spec.rgba) };
      case 'gradient':
        return resolveGradient(spec.spec, warn);
      case 'shading':
        return { kind: 'shading', spec: spec.spec };
      case 'pattern':
        return resolvePattern(spec.spec, bounds, context, warn);
      default: {
        const exhaustive: never = spec;
        void exhaustive;
        return undefined;
      }
    }
  };

  return {
    bind(spec, bounds) {
      if (!spec) return undefined;
      const key = paintCacheKey(spec, dpiBucket(context.dpi), bounds);
      if (cache.has(key)) return cache.get(key) ?? undefined;
      const resolved = resolve(spec, bounds);
      cache.set(key, resolved ?? null);
      return resolved;
    },
    clear() {
      cache.clear();
    },
  };
}

/**
 * 把 DPI 映射为缓存桶。
 *
 * @param dpi 输出精度；省略按 96。
 * @returns 非负整数桶号。
 */
function dpiBucket(dpi: number | undefined): number {
  const value = Number.isFinite(dpi) && dpi! > 0 ? dpi! : DEFAULT_DPI;
  return Math.floor(value / DPI_BUCKET_SIZE);
}

/**
 * 归一化 RGBA 到 0..255 整数，避免样式层出现越界/小数。
 *
 * @param color 输入颜色。
 * @returns 新的 RGBA 对象。
 */
function normalizeRgba(color: Rgba): Rgba {
  const channel = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : 0;
  return { r: channel(color.r), g: channel(color.g), b: channel(color.b), a: channel(color.a) };
}

/**
 * 解析渐变；径向渐变 v1 降级为平均色 + `W_RADIAL_UNSUPPORTED`。
 *
 * @param spec 渐变描述。
 * @param warn warning 回调。
 * @returns 渲染器可消费的渐变 Paint。
 */
function resolveGradient(
  spec: GradientSpec,
  warn: (code: string, message: string) => void,
): ResolvedPaint {
  if (spec.kind === 'radial') {
    warn('W_RADIAL_UNSUPPORTED', '径向渐变 v1 未实现，已降级为平均色');
    const average = averageColor(spec.segments);
    return { kind: 'color', rgba: average };
  }
  return { kind: 'gradient', spec: resolveAxialGradient(spec, warn) };
}

/**
 * 归一化轴向渐变：补齐/排序 stop、处理 MapType，并保证 stop 数不超过上限。
 *
 * @param spec 原始轴向渐变。
 * @param warn warning 回调。
 * @returns 位置单调、带两端点的渐变描述。
 */
function resolveAxialGradient(
  spec: AxialGradientSpec,
  warn: (code: string, message: string) => void,
): AxialGradientSpec {
  const base = normalizeStops(spec.segments, warn);
  if (base.length === 0) return { ...spec, segments: [] };

  const axisLength = Math.hypot(spec.end.x - spec.start.x, spec.end.y - spec.start.y);
  const mapUnit =
    Number.isFinite(spec.mapUnit) && (spec.mapUnit as number) > 0
      ? (spec.mapUnit as number)
      : axisLength;

  if (spec.mapType === 'Direct' || !(axisLength > 0) || !(mapUnit > 0)) {
    return { ...spec, segments: withEndpoints(base) };
  }

  const cycles = axisLength / mapUnit;
  if (!Number.isFinite(cycles) || cycles <= 0) {
    return { ...spec, segments: withEndpoints(base) };
  }

  const segments: GradientStop[] = [];
  const maxCycles = Math.min(Math.ceil(cycles) + 1, MAX_GRADIENT_STOPS);
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    for (const stop of base) {
      const folded = spec.mapType === 'Reflect' && cycle % 2 === 1 ? 1 - stop.position : stop.position;
      const t = (cycle + folded) / cycles;
      if (t < 0 || t > 1) continue;
      segments.push({ position: t, color: stop.color });
      if (segments.length > MAX_GRADIENT_STOPS) break;
    }
    if (segments.length > MAX_GRADIENT_STOPS) break;
  }
  // 用 sample 补齐两端，保证 Canvas 在 t∈[0,1] 内不会因端点缺失而错误 clamp。
  const firstColor = sampleGradientColor(base, 0, spec.mapType);
  const lastColor = sampleGradientColor(base, cycles, spec.mapType);
  if (segments.length === 0 || segments[0]!.position > 0) {
    segments.unshift({ position: 0, color: firstColor });
  }
  if (segments[segments.length - 1]!.position < 1) {
    segments.push({ position: 1, color: lastColor });
  }
  segments.sort((a, b) => a.position - b.position);
  if (segments.length > MAX_GRADIENT_STOPS) {
    warn(
      'W_UNSUPPORTED_PAINT',
      `渐变 stop 数超过 ${MAX_GRADIENT_STOPS}，已截断（MapType=${spec.mapType}）`,
    );
    const last = segments[segments.length - 1]!;
    segments.length = MAX_GRADIENT_STOPS - 1;
    segments.push(last);
  }
  return { ...spec, segments };
}

/**
 * 归一化 stop 列表：缺失位置按区间均分、位置 clamp 到 0..1 并保证单调不减。
 *
 * @param segments 原始颜色段。
 * @param warn warning 回调。
 * @returns 位置已完成归一化的颜色段。
 */
function normalizeStops(
  segments: readonly GradientStop[],
  warn: (code: string, message: string) => void,
): GradientStop[] {
  if (segments.length === 0) return [];
  const stops: { position?: number; color: Rgba }[] = segments.map((segment) => ({
    position: Number.isFinite(segment.position)
      ? Math.max(0, Math.min(1, segment.position))
      : undefined,
    color: normalizeRgba(segment.color),
  }));
  if (stops[0]!.position === undefined) stops[0]!.position = 0;
  const lastIndex = stops.length - 1;
  if (stops[lastIndex]!.position === undefined) stops[lastIndex]!.position = 1;

  // 填补中间缺失位置：在左右已知位置之间均分。
  let cursor = 0;
  while (cursor < stops.length) {
    if (stops[cursor]!.position !== undefined) {
      cursor += 1;
      continue;
    }
    const left = cursor - 1;
    let right = cursor;
    while (right < stops.length && stops[right]!.position === undefined) right += 1;
    const from = stops[left]!.position as number;
    const to =
      right < stops.length ? (stops[right]!.position as number) : 1;
    const count = right - left;
    for (let index = cursor; index < right; index += 1) {
      stops[index]!.position = from + ((to - from) * (index - left)) / count;
    }
    cursor = right;
  }

  const result: GradientStop[] = [];
  let previous = 0;
  for (const stop of stops) {
    let position = stop.position as number;
    if (position < previous) {
      warn('W_UNSUPPORTED_PAINT', '渐变 Segment 位置递减，已按单调不减修正');
      position = previous;
    }
    previous = position;
    result.push({ position, color: stop.color });
  }
  return result;
}

/**
 * 在渐变两端补 stop。
 *
 * @param stops 已归一化的 stop。
 * @returns 位置覆盖 [0,1] 的 stop（新数组）。
 */
function withEndpoints(stops: readonly GradientStop[]): GradientStop[] {
  if (stops.length === 0) return [];
  const result = stops.map((stop) => ({ position: stop.position, color: stop.color }));
  if (result[0]!.position > 0) result.unshift({ position: 0, color: result[0]!.color });
  const last = result[result.length - 1]!;
  if (last.position < 1) result.push({ position: 1, color: last.color });
  return result;
}

/**
 * 按 MapType 在参数 u 处采样颜色。
 *
 * @param stops 已归一化 stop。
 * @param u 未折叠的渐变参数（可超出 0..1）。
 * @param mapType 映射方式。
 * @returns 采样颜色。
 */
function sampleGradientColor(
  stops: readonly GradientStop[],
  u: number,
  mapType: AxialGradientSpec['mapType'],
): Rgba {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  let position: number;
  if (mapType === 'Repeat') {
    position = u - Math.floor(u);
  } else if (mapType === 'Reflect') {
    const wrapped = ((u % 2) + 2) % 2;
    position = wrapped <= 1 ? wrapped : 2 - wrapped;
  } else {
    position = Math.max(0, Math.min(1, u));
  }
  const clamped = Math.max(0, Math.min(1, position));
  let right = 0;
  while (right < stops.length && stops[right]!.position < clamped) right += 1;
  if (right === 0) return stops[0]!.color;
  if (right >= stops.length) return stops[stops.length - 1]!.color;
  const left = stops[right - 1]!;
  const next = stops[right]!;
  const span = next.position - left.position;
  if (span <= 0) return next.color;
  const ratio = (clamped - left.position) / span;
  return mixColor(left.color, next.color, ratio);
}

/**
 * 线性混合两个颜色。
 *
 * @param from 起点颜色。
 * @param to 终点颜色。
 * @param ratio 0..1 的插值比例。
 * @returns 混合后的 RGBA。
 */
function mixColor(from: Rgba, to: Rgba, ratio: number): Rgba {
  const r = Math.max(0, Math.min(1, ratio));
  return {
    r: Math.round(from.r + (to.r - from.r) * r),
    g: Math.round(from.g + (to.g - from.g) * r),
    b: Math.round(from.b + (to.b - from.b) * r),
    a: Math.round(from.a + (to.a - from.a) * r),
  };
}

/**
 * 计算已绑定 Paint 的平均色。
 *
 * v1 的“渐变/底纹描边”与径向渐变降级都使用平均色；底纹取 tile 内所有纯色
 * 填充/描边命令的平均值，没有纯色时返回黑色。
 *
 * @param paint 已绑定 Paint。
 * @returns 平均 RGBA。
 */
export function getAveragePaintColor(paint: ResolvedPaint): Rgba {
  switch (paint.kind) {
    case 'color':
      return normalizeRgba(paint.rgba);
    case 'gradient':
      return averageColor(paint.spec.segments);
    case 'shading':
      return averageColor(
        paint.spec.points.map((point) => ({ position: 0, color: point.color })),
      );
    case 'pattern': {
      const colors: Rgba[] = [];
      for (const command of paint.tile.commands) {
        if (command.op === 'fill' || command.op === 'stroke') {
          if (command.paint.kind === 'color') colors.push(command.paint.rgba);
        }
      }
      return colors.length > 0 ? averageColor(colors.map((color) => ({ position: 0, color }))) : { r: 0, g: 0, b: 0, a: 255 };
    }
  }
}

/**
 * 计算颜色段平均色；径向渐变降级与底纹超限降级使用。
 *
 * @param segments 颜色段。
 * @returns 平均 RGBA；空段返回透明。
 */
function averageColor(segments: readonly GradientStop[]): Rgba {
  if (segments.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const segment of segments) {
    const color = normalizeRgba(segment.color);
    r += color.r;
    g += color.g;
    b += color.b;
    a += color.a;
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
 * 构造轴向渐变的 Extend band 多边形（对象空间）。
 *
 * Extend 语义：0=仅 t∈[0,1]，1=t≤1，2=t≥0，3=不裁剪。返回的多边形用于
 * `clip()`，比在渲染器里硬编码渐变边界更贴近设计图 32/33。
 *
 * @param spec 轴向渐变；使用 start/end 与 extend。
 * @param bounds 对象包围盒，用于确定 band 的垂直/轴向延展范围；单位同坐标。
 * @returns 多边形顶点；`null` 表示不需要裁剪（Extend=3 或轴退化）。
 */
export function getAxialExtendBand(
  spec: AxialGradientSpec,
  bounds: Box,
): Point[] | null {
  if (spec.extend === 3) return null;
  const dx = spec.end.x - spec.start.x;
  const dy = spec.end.y - spec.start.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const reach = Math.max(1, Math.hypot(bounds.w, bounds.h) + length);
  const vertex = (origin: Point, along: number, across: number): Point => ({
    x: origin.x + ux * along + nx * across,
    y: origin.y + uy * along + ny * across,
  });
  const start = spec.start;
  const end = spec.end;
  const extend: GradientExtend = spec.extend;
  if (extend === 0) {
    // 两条垂线之间的带状区域：start 到 end，宽度 ±reach。
    return [
      vertex(start, 0, reach),
      vertex(end, 0, reach),
      vertex(end, 0, -reach),
      vertex(start, 0, -reach),
    ];
  }
  if (extend === 1) {
    // 只保留终点内侧（t≤1）的半平面。
    return [
      vertex(end, 0, reach),
      vertex(end, 0, -reach),
      vertex(end, -reach, -reach),
      vertex(end, -reach, reach),
    ];
  }
  // extend === 2：只保留起点外侧（t≥0）的半平面。
  return [
    vertex(start, 0, reach),
    vertex(start, 0, -reach),
    vertex(start, reach, -reach),
    vertex(start, reach, reach),
  ];
}

/**
 * 解析底纹 PaintSpec。
 *
 * @param spec 底纹几何描述（cell 已在建块阶段转成 tile）。
 * @param bounds 可选对象包围盒；用于 tile 数量上限判断。
 * @param context 绑定上下文。
 * @param warn warning 回调。
 * @returns PatternPaint；tile 缺失/超限时返回 undefined。
 */
function resolvePattern(
  spec: PatternSpec,
  bounds: Box | undefined,
  context: PaintBindingContext,
  warn: (code: string, message: string, patternId?: string) => void,
): PatternPaint | undefined {
  if (!(spec.width > 0) || !(spec.height > 0)) {
    warn('W_UNSUPPORTED_PAINT', '底纹 Width/Height 非正，已跳过填充', spec.patternId);
    return undefined;
  }
  const tile =
    spec.tile ??
    (spec.patternId ? context.patterns?.resolvePatternTile(spec.patternId) : undefined);
  if (!tile || tile.commands.length === 0) {
    warn('W_UNSUPPORTED_PAINT', '底纹 tile DisplayList 缺失，已跳过填充', spec.patternId);
    return undefined;
  }
  const xStep = Number.isFinite(spec.xStep) && spec.xStep > 0 ? Math.max(spec.xStep, spec.width) : spec.width;
  const yStep = Number.isFinite(spec.yStep) && spec.yStep > 0 ? Math.max(spec.yStep, spec.height) : spec.height;
  let ctm: Matrix = spec.ctm ?? IDENTITY_MATRIX;
  if (spec.relativeTo === 'Page') {
    const objectToPage = context.objectToPage?.() ?? null;
    const inverse = objectToPage ? invertMatrix(objectToPage) : null;
    if (inverse) {
      // 页面原点在对象空间的位置 = inv(M)[e,f]；把平铺排列平移到该参考点。
      ctm = translateMatrix(ctm, inverse[4], inverse[5]);
    } else {
      warn(
        'W_UNSUPPORTED_PAINT',
        '底纹 RelativeTo=Page 缺少对象变换，已按 Object 处理',
        spec.patternId,
      );
    }
  }
  if (bounds) {
    const tiles = countPatternTiles({ ...spec, xStep, yStep }, bounds);
    if (tiles > MAX_PATTERN_TILES) {
      warn(
        'W_PATTERN_LIMIT',
        `底纹 tile 数 ${tiles} 超过上限 ${MAX_PATTERN_TILES}，已跳过填充`,
        spec.patternId,
      );
      return undefined;
    }
  }
  return {
    kind: 'pattern',
    tile,
    width: spec.width,
    height: spec.height,
    xStep,
    yStep,
    reflect: spec.reflect,
    ctm,
  };
}

/**
 * 估算对象包围盒内需要平铺的 tile 数。
 *
 * @param spec 底纹描述（使用已校正的 xStep/yStep）。
 * @param bounds 对象包围盒，对象空间单位。
 * @returns tile 数量；底纹尺寸非法时返回 Number.POSITIVE_INFINITY。
 */
export function countPatternTiles(spec: PatternSpec, bounds: Box): number {
  const xStep = spec.xStep > 0 ? spec.xStep : spec.width;
  const yStep = spec.yStep > 0 ? spec.yStep : spec.height;
  if (!(xStep > 0) || !(yStep > 0) || !(bounds.w > 0) || !(bounds.h > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(bounds.w / xStep) * Math.ceil(bounds.h / yStep);
}

/**
 * 生成 PaintSpec 的稳定缓存 key。
 *
 * 只序列化影响绘制结果的字段；Pattern 的 cell/styleRoot 属于构建期输入，
 * 其变化会体现在 tile 内容/资源 ID 上，不直接参与 key，避免大对象/环引用。
 *
 * @param spec PaintSpec。
 * @param dpi 缓存桶。
 * @param bounds 可选包围盒；只影响底纹 tile 上限判断，纳入 key 防止串用。
 * @returns 稳定字符串 key。
 */
function paintCacheKey(spec: PaintSpec, dpi: number, bounds?: Box): string {
  const boundsKey = bounds
    ? `${roundKey(bounds.x)},${roundKey(bounds.y)},${roundKey(bounds.w)},${roundKey(bounds.h)}`
    : '';
  switch (spec.kind) {
    case 'color':
      return `c|${spec.rgba.r},${spec.rgba.g},${spec.rgba.b},${spec.rgba.a}|${dpi}`;
    case 'gradient': {
      const gradient = spec.spec;
      const stops = gradient.segments
        .map((stop) => `${roundKey(stop.position)}:${stop.color.r},${stop.color.g},${stop.color.b},${stop.color.a}`)
        .join(';');
      if (gradient.kind === 'radial') {
        return `gr|${roundKey(gradient.start.x)},${roundKey(gradient.start.y)},${roundKey(gradient.startRadius)},${roundKey(gradient.end.x)},${roundKey(gradient.end.y)},${roundKey(gradient.endRadius)}|${gradient.mapType}|${roundKey(gradient.mapUnit ?? 0)}|${gradient.extend}|${stops}|${dpi}`;
      }
      return `ga|${roundKey(gradient.start.x)},${roundKey(gradient.start.y)},${roundKey(gradient.end.x)},${roundKey(gradient.end.y)}|${gradient.mapType}|${roundKey(gradient.mapUnit ?? 0)}|${gradient.extend}|${stops}|${dpi}`;
    }
    case 'pattern': {
      const pattern = spec.spec;
      const ctm = pattern.ctm
        ? pattern.ctm.map((value) => roundKey(value)).join(',')
        : '';
      return `p|${pattern.patternId ?? ''}|${roundKey(pattern.width)},${roundKey(pattern.height)},${roundKey(pattern.xStep)},${roundKey(pattern.yStep)}|${pattern.reflect}|${pattern.relativeTo}|${ctm}|${pattern.tile?.commands.length ?? 0}|${boundsKey}|${dpi}`;
    }
    case 'shading': {
      const shading = spec.spec;
      const points = shading.points
        .map(
          (point) =>
            `${roundKey(point.x)},${roundKey(point.y)}:${point.color.r},${point.color.g},${point.color.b},${point.color.a}:${point.edgeFlag ?? ''}`,
        )
        .join(';');
      return `s|${shading.kind}|${shading.verticesPerRow ?? ''}|${shading.extend}|${shading.backColor ? `${shading.backColor.r},${shading.backColor.g},${shading.backColor.b},${shading.backColor.a}` : ''}|${points}|${dpi}`;
    }
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      return '';
    }
  }
}

/**
 * 缓存 key 中的数值格式：保留 4 位小数，避免浮点尾差造成键抖动。
 *
 * @param value 数值。
 * @returns 字符串形式。
 */
function roundKey(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10_000) / 10_000) : 'NaN';
}