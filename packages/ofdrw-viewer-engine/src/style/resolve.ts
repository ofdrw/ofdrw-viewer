/**
 * 样式作用域合并与最终结算。
 *
 * 优先级：对象类型默认值 < 继承（作用域）< DrawParam 链 < 内联属性 < 子元素颜色；
 * `Fill`/`Stroke` 开关与 `Alpha` 不从父作用域继承。
 * 结算结果在准备阶段写入 `PreparedPage.styles`，绘制阶段只读。
 */

import type { FillRule, LineCap, LineJoin, PaintSpec } from '../common/types';
import type { CompositeObject, GraphicUnitBase, ImageObject, Paint, PathObject, ResourceId, TextObject } from '../model/types';
import type { ResolvedStyle } from './types';
import type { DrawParamGraph, ResolvedStylePatch } from './draw-param';
import { resolvePaint } from './paint';

export { createDefaultStyle } from './defaults';
export type { DefaultStyleOptions } from './defaults';

/** 样式作用域；从图层到对象逐层嵌套。 */
export interface StyleScope {
  /** 作用域类型。 */
  kind: 'document' | 'layer' | 'pageblock' | 'composite' | 'annotation' | 'pattern' | 'object';
  /** 该作用域引用的 DrawParam。 */
  drawParamId?: ResourceId;
  /** 父作用域。 */
  parent?: StyleScope;
  /** 内联覆盖（来自 XML 属性或已结算的块根样式）。 */
  inline?: Partial<ResolvedStyle>;
  /**
   * 块根样式：注释外观、复合对象、底纹 tile 等独立空间的继承起点。
   * 仅用于独立块/注释；普通图层链请用 parent。
   */
  baseStyle?: ResolvedStyle;
}

/** 可结算样式的图元（PageBlock 只作为容器，不参与样式结算）。 */
export type StyledObject = TextObject | PathObject | ImageObject | CompositeObject;

/** 单个对象的结算输入。 */
export interface ResolveStyleInput {
  /** 图元；提供 alpha/inline 线型/clips 等内联字段。 */
  object: StyledObject;
  /** 图元所在作用域。 */
  scope: StyleScope;
  /** 图元自己的填充色（子元素颜色优先级最高）。 */
  fillPaint?: Paint;
  /** 图元自己的描边色。 */
  strokePaint?: Paint;
}

/** 继承层内部表示；不包含 Fill/Stroke 开关与 Alpha。 */
interface InheritedStyle {
  lineWidth: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  miterLimit: number;
  dashOffset: number;
  dashPattern: number[];
  fillPaint?: PaintSpec;
  strokePaint?: PaintSpec;
}

/** 对象类型默认值。 */
interface KindDefaults {
  fill: boolean;
  stroke: boolean;
  fillPaint?: PaintSpec;
  strokePaint?: PaintSpec;
  fillRule: FillRule;
}

/** 黑色 PaintSpec（每次返回新对象，避免调用方误改共享数据）。 */
function blackPaint(): PaintSpec {
  return { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } };
}

/** 透明 PaintSpec。 */
function transparentPaint(): PaintSpec {
  return { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 0 } };
}

/**
 * 按对象类型取内置默认值（设计方案附录 A）。
 *
 * @param kind 图元类型。
 * @returns 类型默认；Text 默认黑填充，Path 默认透明填充/黑描边。
 */
function kindDefaults(kind: StyledObject['kind']): KindDefaults {
  if (kind === 'text') {
    return { fill: true, stroke: false, fillPaint: blackPaint(), strokePaint: transparentPaint(), fillRule: 'nonzero' };
  }
  if (kind === 'path') {
    return { fill: false, stroke: true, fillPaint: transparentPaint(), strokePaint: blackPaint(), fillRule: 'nonzero' };
  }
  return { fill: false, stroke: false, fillRule: 'nonzero' };
}

/** 从默认样式复制线型字段（不复制 Paint/开关/Alpha）。 */
function initialInherited(defaultStyle: ResolvedStyle): InheritedStyle {
  return {
    lineWidth: defaultStyle.lineWidth,
    lineCap: defaultStyle.lineCap,
    lineJoin: defaultStyle.lineJoin,
    miterLimit: defaultStyle.miterLimit,
    dashOffset: defaultStyle.dashOffset,
    dashPattern: [...defaultStyle.dashPattern],
  };
}

/** 合并 patch/内联样式到继承层；忽略 Fill/Stroke/Alpha/FillRule。 */
function mergeInherited(target: InheritedStyle, source: Partial<ResolvedStyle> | ResolvedStylePatch): void {
  if (source.lineWidth !== undefined) target.lineWidth = source.lineWidth;
  if (source.lineCap !== undefined) target.lineCap = source.lineCap;
  if (source.lineJoin !== undefined) target.lineJoin = source.lineJoin;
  if (source.miterLimit !== undefined) target.miterLimit = source.miterLimit;
  if (source.dashOffset !== undefined) target.dashOffset = source.dashOffset;
  if (source.dashPattern !== undefined) target.dashPattern = [...source.dashPattern];
  if (source.fillPaint !== undefined) target.fillPaint = source.fillPaint;
  if (source.strokePaint !== undefined) target.strokePaint = source.strokePaint;
}

/** 复制继承层。 */
function cloneInherited(source: InheritedStyle): InheritedStyle {
  return { ...source, dashPattern: [...source.dashPattern] };
}

/** 样式结算器。 */
export class StyleResolver {
  /** 每个作用域的继承层缓存；避免同一作用域重复展开。 */
  private readonly scopeCache = new WeakMap<StyleScope, InheritedStyle>();

  /**
   * @param drawParams 已构建的 DrawParam 图。
   * @param defaultStyle 文档默认样式。
   * @param onWarning warning 回调。
   */
  constructor(
    private readonly drawParams: DrawParamGraph,
    readonly defaultStyle: ResolvedStyle,
    private readonly onWarning?: (code: string, message: string, resourceId?: ResourceId) => void,
  ) {}

  /**
   * 结算单个图元样式。
   *
   * @param input 图元、作用域与子元素颜色。
   * @returns 最终不可变样式；长度单位 mm，alpha 为 0..1。
   */
  resolveStyle(input: ResolveStyleInput): ResolvedStyle {
    const { object, scope } = input;
    const inherited = this.resolveScope(scope);
    const drawParam: ResolvedStylePatch = object.drawParam
      ? this.drawParams.resolve(object.drawParam)
      : {};
    const kind = kindDefaults(object.kind);

    const lineWidth = object.lineWidth ?? drawParam.lineWidth ?? inherited.lineWidth;
    const lineCap = object.cap ?? drawParam.lineCap ?? inherited.lineCap;
    const lineJoin = object.join ?? drawParam.lineJoin ?? inherited.lineJoin;
    const miterLimit = object.miterLimit ?? drawParam.miterLimit ?? inherited.miterLimit;
    const dashOffset = object.dashOffset ?? drawParam.dashOffset ?? inherited.dashOffset;
    const dashPattern = [...(object.dashPattern ?? drawParam.dashPattern ?? inherited.dashPattern)];

    let fillPaint = inherited.fillPaint ?? kind.fillPaint;
    if (drawParam.fillPaint !== undefined) fillPaint = drawParam.fillPaint;
    if (input.fillPaint) {
      const resolved = resolvePaint(input.fillPaint, this.onWarning, this.defaultStyle);
      if (resolved) fillPaint = resolved;
    }
    let strokePaint = inherited.strokePaint ?? kind.strokePaint;
    if (drawParam.strokePaint !== undefined) strokePaint = drawParam.strokePaint;
    if (input.strokePaint) {
      const resolved = resolvePaint(input.strokePaint, this.onWarning, this.defaultStyle);
      if (resolved) strokePaint = resolved;
    }

    let fill = kind.fill;
    let stroke = kind.stroke;
    let fillRule: FillRule = kind.fillRule;
    if (object.kind === 'text') {
      fill = object.fill;
      stroke = object.stroke;
    } else if (object.kind === 'path') {
      fill = object.fill;
      stroke = object.stroke;
      fillRule = object.rule ?? kind.fillRule;
    }

    let alpha = (object.alpha ?? 255) / 255;
    if (drawParam.alpha !== undefined) alpha *= drawParam.alpha;
    alpha = Math.max(0, Math.min(1, alpha));

    const style: ResolvedStyle = {
      lineWidth,
      lineCap,
      lineJoin,
      miterLimit,
      dashOffset,
      dashPattern,
      ...(fillPaint ? { fillPaint } : {}),
      ...(strokePaint ? { strokePaint } : {}),
      fill,
      stroke,
      fillRule,
      alpha,
    };
    return Object.freeze(style);
  }

  /**
   * 解析作用域继承层。
   *
   * @param scope 当前作用域。
   * @returns 作用域的继承层（线型 + 显式 Paint）。
   */
  private resolveScope(scope: StyleScope): InheritedStyle {
    const cached = this.scopeCache.get(scope);
    if (cached) return cached;
    const base = scope.parent ? this.resolveScope(scope.parent) : initialInherited(this.defaultStyle);
    const result = cloneInherited(base);
    if (scope.baseStyle) mergeInherited(result, scope.baseStyle);
    if (scope.drawParamId) mergeInherited(result, this.drawParams.resolve(scope.drawParamId));
    if (scope.inline) mergeInherited(result, scope.inline);
    this.scopeCache.set(scope, result);
    return result;
  }
}

/**
 * 便捷函数：结算单个图元样式。
 *
 * @param resolver 结算器。
 * @param object 图元。
 * @param scope 作用域。
 * @param fillPaint 子元素填充色。
 * @param strokePaint 子元素描边色。
 * @returns 不可变样式。
 */
export function resolveObjectStyle(
  resolver: StyleResolver,
  object: StyledObject,
  scope: StyleScope,
  fillPaint?: Paint,
  strokePaint?: Paint,
): ResolvedStyle {
  const input: ResolveStyleInput = { object, scope };
  if (fillPaint) input.fillPaint = fillPaint;
  if (strokePaint) input.strokePaint = strokePaint;
  return resolver.resolveStyle(input);
}
