/**
 * 准备阶段样式遍历：把页面/独立块内所有可绘制对象结算到 `WeakMap`。
 *
 * 纯粹遍历模型与样式层；不构建显示列表、不访问资源二进制、不调用渲染器。
 */

import type { PaintSpec } from '../common/types';
import type {
  CompositeGraphicUnit,
  GraphicUnitBase,
  PageBlock,
  PageModel,
  PageObject,
  Pattern,
  ResourceId,
} from '../model/types';
import type { ResolvedStyle } from './types';
import type { StyleResolver, StyleScope } from './resolve';
import { resolveObjectStyle } from './resolve';

/** 样式遍历需要的资源查询接口。 */
export interface StyleResourceLookup {
  /** 按 ID 取复合图形资源。 */
  getComposite(id: ResourceId): CompositeGraphicUnit | undefined;
  /** 按 ID 取底纹资源（可选；内联底纹不需要）。 */
  getPattern?(id: ResourceId): Pattern | undefined;
}

/** 样式遍历选项。 */
export interface StyleTraversalOptions {
  /** 复合资源查询。 */
  lookup?: StyleResourceLookup;
  /** warning 回调。 */
  onWarning?: (code: string, message: string, resourceId?: ResourceId) => void;
  /** 复合/底纹最大嵌套深度，默认 16。 */
  maxDepth?: number;
}

/** 页面样式遍历结果。 */
export interface ResolvedPageStyles {
  /** 全部可绘制对象的结算样式（含不可见对象、复合内容、底纹 cell）。 */
  styles: WeakMap<GraphicUnitBase, ResolvedStyle>;
  /** 文档默认样式。 */
  defaultStyle: ResolvedStyle;
}

/** 独立块遍历作用域类型。 */
export type BlockStyleKind = 'annotation' | 'composite' | 'pattern-cell' | 'pageblock';

/**
 * 遍历页面并结算所有对象样式。
 *
 * @param page 页面模型。
 * @param resolver 样式结算器。
 * @param options 资源查询/深度/warning。
 * @returns `PreparedPage.styles` 所需映射。
 */
export function resolvePageStyles(
  page: PageModel,
  resolver: StyleResolver,
  options: StyleTraversalOptions = {},
): ResolvedPageStyles {
  const styles = new WeakMap<GraphicUnitBase, ResolvedStyle>();
  const documentScope: StyleScope = { kind: 'document' };
  for (const layer of page.layers) {
    const layerScope: StyleScope = {
      kind: 'layer',
      parent: documentScope,
      ...(layer.drawParam ? { drawParamId: layer.drawParam } : {}),
    };
    walkObjects(layer.children, layerScope, styles, resolver, options, new Set(), new WeakSet(), 0);
  }
  return { styles, defaultStyle: resolver.defaultStyle };
}

/**
 * 遍历独立块内容并结算样式（注释外观、复合内容、底纹 cell）。
 *
 * @param content 独立块 PageBlock。
 * @param styleRoot 块内对象继承起点。
 * @param resolver 样式结算器。
 * @param options 资源查询/深度/warning。
 * @param kind 根作用域类型，默认 `pageblock`。
 * @returns 块内对象的样式映射。
 */
export function resolveBlockStyles(
  content: PageBlock,
  styleRoot: ResolvedStyle,
  resolver: StyleResolver,
  options: StyleTraversalOptions = {},
  kind: BlockStyleKind = 'pageblock',
): WeakMap<GraphicUnitBase, ResolvedStyle> {
  const styles = new WeakMap<GraphicUnitBase, ResolvedStyle>();
  const rootScope: StyleScope = { kind: kind === 'pattern-cell' ? 'pattern' : kind, baseStyle: styleRoot };
  walkObjects(content.children, rootScope, styles, resolver, options, new Set(), new WeakSet(), 0);
  return styles;
}

/** 遍历对象列表。 */
function walkObjects(
  objects: readonly PageObject[],
  scope: StyleScope,
  styles: WeakMap<GraphicUnitBase, ResolvedStyle>,
  resolver: StyleResolver,
  options: StyleTraversalOptions,
  activeComposites: Set<ResourceId>,
  visitedPatternCells: WeakSet<PageBlock>,
  depth: number,
): void {
  const maxDepth = options.maxDepth ?? 16;
  for (const object of objects) {
    if (object.kind === 'block') {
      walkObjects(
        object.children,
        { kind: 'pageblock', parent: scope },
        styles,
        resolver,
        options,
        activeComposites,
        visitedPatternCells,
        depth,
      );
      continue;
    }
    const style = resolveObjectStyle(
      resolver,
      object,
      scope,
      object.kind === 'text' || object.kind === 'path' ? object.fillColor : undefined,
      object.kind === 'text' || object.kind === 'path' ? object.strokeColor : undefined,
    );
    styles.set(object, style);
    walkPatternPaints(style, resolver, styles, options, visitedPatternCells, depth);

    if (object.kind !== 'composite') continue;
    if (!options.lookup) continue;
    if (depth >= maxDepth) {
      options.onWarning?.('W_COMPOSITE_DEPTH', `复合对象嵌套超过 ${maxDepth} 层，已截断`, object.resourceId);
      continue;
    }
    if (activeComposites.has(object.resourceId)) {
      options.onWarning?.('W_COMPOSITE_DEPTH', `复合对象出现环：${object.resourceId}`, object.resourceId);
      continue;
    }
    const resource = options.lookup.getComposite(object.resourceId);
    if (!resource) {
      options.onWarning?.('W_BAD_NUMBER', `复合资源不存在：${object.resourceId}`, object.resourceId);
      continue;
    }
    activeComposites.add(object.resourceId);
    const compositeScope: StyleScope = {
      kind: 'composite',
      parent: scope,
      ...(object.drawParam ? { drawParamId: object.drawParam } : {}),
      ...(inlineOf(object) ? { inline: inlineOf(object) } : {}),
    };
    walkObjects(
      resource.content.children,
      compositeScope,
      styles,
      resolver,
      options,
      activeComposites,
      visitedPatternCells,
      depth + 1,
    );
    activeComposites.delete(object.resourceId);
  }
}

/** 遍历样式中的底纹 Paint，并结算 CellContent。 */
function walkPatternPaints(
  style: ResolvedStyle,
  resolver: StyleResolver,
  styles: WeakMap<GraphicUnitBase, ResolvedStyle>,
  options: StyleTraversalOptions,
  visitedPatternCells: WeakSet<PageBlock>,
  depth: number,
): void {
  const paints: (PaintSpec | undefined)[] = [style.fillPaint, style.strokePaint];
  for (const paint of paints) {
    if (paint?.kind !== 'pattern') continue;
    const cell = paint.spec.cell;
    if (visitedPatternCells.has(cell)) continue;
    const maxDepth = options.maxDepth ?? 16;
    if (depth >= maxDepth) {
      options.onWarning?.('W_PATTERN_LIMIT', `底纹嵌套超过 ${maxDepth} 层，已截断`);
      continue;
    }
    visitedPatternCells.add(cell);
    walkObjects(
      cell.children,
      { kind: 'pattern', baseStyle: paint.spec.styleRoot },
      styles,
      resolver,
      options,
      new Set(),
      visitedPatternCells,
      depth + 1,
    );
  }
}

/** 从图元提取内联线型字段，供复合子作用域继承。 */
function inlineOf(object: GraphicUnitBase): Partial<ResolvedStyle> | undefined {
  const inline: Partial<ResolvedStyle> = {};
  if (object.lineWidth !== undefined) inline.lineWidth = object.lineWidth;
  if (object.cap !== undefined) inline.lineCap = object.cap;
  if (object.join !== undefined) inline.lineJoin = object.join;
  if (object.miterLimit !== undefined) inline.miterLimit = object.miterLimit;
  if (object.dashOffset !== undefined) inline.dashOffset = object.dashOffset;
  if (object.dashPattern !== undefined) inline.dashPattern = [...object.dashPattern];
  return Object.keys(inline).length > 0 ? inline : undefined;
}
