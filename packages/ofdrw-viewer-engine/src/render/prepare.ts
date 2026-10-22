/**
 * 准备阶段编排。
 *
 * 通过 loader 获取字体/图片/模板/注释运行时，完成资源收集、样式结算与独立块构建；
 * 不解析 XML、不碰目标 Canvas/渲染器，结果供同步绘制阶段只读。
 */

import type { DisplayList } from '../common/display-list';
import type { DecodedImage, PaintSpec } from '../common/types';
import type { FontFaceSet } from '../font/types';
import type {
  Annotation,
  CompositeObject,
  DrawParam,
  FontResource,
  ImageResource,
  IndependentBlock,
  PageBlock,
  PageModel,
  Pattern,
  PreparedPage,
  ResourceId,
  TemplateRef,
} from '../model/types';
import type { PageResourceScope } from '../resource/types';
import type { ResolvedStyle } from '../style/types';
import type { PaintBinder } from './paint';
import type { WarningHandler } from '../warnings';
import { OFDError } from '../errors';
import { createDefaultStyle } from '../style/defaults';
import { DrawParamGraph } from '../style/draw-param';
import { StyleResolver } from '../style/resolve';
import { resolveBlockStyles, resolvePageStyles } from '../style/page-styles';
import {
  buildBlockDisplayList,
  compositeBlockCacheKey,
  markBlockDynamic,
  setBlockStyles,
} from './object';
import { materializeDisplayListImages } from './display-list';
import type { DisplayListImageResolver } from './display-list';
import { createPaintBinder } from './paint';
import { buildAnnotationBlocks } from './annotation';

/** 独立块最大递归深度（与 T6a 一致）。 */
const MAX_BLOCK_DEPTH = 16;

/** 底纹 cell 的显示列表缓存；绘制期由 pattern-aware binder 取用。 */
const PATTERN_TILES = new WeakMap<PageBlock, DisplayList>();

/** 底纹 cell → 资源 ID；由页面资源作用域反查，用于 `PreparedPageBundle.blocks` 键。 */
const PATTERN_CELL_IDS = new WeakMap<PageBlock, ResourceId>();

/**
 * 准备阶段的运行时加载器，由 T12 用 document/font/image 服务实现。
 *
 * render 只调用这些方法，不解析 XML、不 import container，保持分层边界。
 */
export interface PreparePageLoader {
  /**
   * 加载字体面集合。
   *
   * @param resources 本页（含模板/复合/底纹递归）引用的字体资源，已去重。
   * @returns 字体资源 ID → 字体面集合；无可用字体时返回空 Map，不抛整页错误。
   */
  loadFontFaces(resources: readonly FontResource[]): Promise<ReadonlyMap<ResourceId, FontFaceSet>>;
  /**
   * 解码一个图片资源。
   *
   * @param resource 图片资源元数据（含包内 mediaFile 与格式）。
   * @returns 解码后的图片；失败时抛错，由 prepare 捕获并 warning 后跳过。
   */
  decodeImage(resource: ImageResource): Promise<DecodedImage>;
  /**
   * 解码一个模板页。
   *
   * @param ref 页面模型中的模板引用；`loc` 已是包内路径。
   * @returns 模板页模型，用于按图层类型合并绘制。
   */
  loadTemplatePage(ref: TemplateRef): Promise<PageModel>;
  /**
   * 解码页面注释。
   *
   * @param page 页面模型；有 `annotationFile` 时读取 PageAnnot。
   * @returns 注释列表，按文件顺序；无注释返回空数组。
   */
  loadAnnotations(page: PageModel): Promise<readonly Annotation[]>;
}

/** 准备阶段输入。 */
export interface PreparePageInput {
  /** 页面模型（已由 T3 解析）。 */
  page: PageModel;
  /** 页级资源作用域（已合并 PageRes/模板/文档资源）。 */
  resources: PageResourceScope;
  /** 运行时加载器；由 T12 注入字体/图片/模板/注释解码实现。 */
  loader: PreparePageLoader;
  /** 图片缺 CTM 时是否严格 identity，默认 true。 */
  strictImageCtm?: boolean;
  /** 输出精度，单位 DPI；用于替换图选择与缓存分桶。 */
  dpi?: number;
  /** 替换图选择模式，默认 auto。 */
  substitutionMode?: 'auto' | 'always' | 'never';
  /** 取消信号。 */
  signal?: AbortSignal;
  /** warning 回调。 */
  onWarning?: WarningHandler;
}

/** 准备阶段产物：页面样式、模板页与运行时资源。 */
export interface PreparedPageBundle {
  page: PreparedPage;
  /** 按 `page.templates` 引用顺序解码的模板页。 */
  templates: readonly PageModel[];
  /** 字体资源 ID → 字体面集合；绘制文字时直接取用。 */
  fonts: ReadonlyMap<ResourceId, FontFaceSet>;
  /** 图片资源 ID → 解码结果；含主图/替换图/蒙版，绘制时再 createImage。 */
  images: ReadonlyMap<ResourceId, DecodedImage>;
  /** 以复合/底纹资源 ID 为键的独立块（displayList 必填）；注释在 page.annotationBlocks。 */
  blocks: ReadonlyMap<string, IndependentBlock>;
}

/**
 * 准备页面：加载模板/注释/字体/图片，结算样式并构建独立块。
 *
 * @param input 页模型、资源作用域、loader、取消信号与 warning 回调。
 * @returns 准备阶段产物。
 */
export async function preparePage(input: PreparePageInput): Promise<PreparedPageBundle> {
  const { page, resources, loader } = input;
  const warn = (code: string, message: string, objectId?: ResourceId): void => {
    input.onWarning?.({
      code,
      message,
      ...(objectId !== undefined ? { objectId } : {}),
    });
  };
  const throwIfAborted = (): void => {
    if (input.signal?.aborted) throw new OFDError('OFD_ABORTED', '页面准备已取消');
  };

  const templates: PageModel[] = [];
  const templateResults = await Promise.allSettled(
    page.templates.map((ref) => loader.loadTemplatePage(ref)),
  );
  templateResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      templates.push(result.value);
    } else {
      const ref = page.templates[index];
      warn('W_UNSUPPORTED_PAINT', `模板页 ${ref?.id ?? index} 加载失败，已跳过`, ref?.id);
    }
  });
  throwIfAborted();

  let annotations: readonly Annotation[] = [];
  if (page.annotationFile) {
    try {
      annotations = await loader.loadAnnotations(page);
    } catch (error) {
      warn(
        'W_ANNOT_EMPTY',
        `注释文件 ${page.annotationFile} 加载失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throwIfAborted();

  for (const [id, pattern] of resources.patterns) PATTERN_CELL_IDS.set(pattern.cell, id);

  const fonts = new Map<ResourceId, FontResource>();
  const images = new Map<ResourceId, ImageResource>();
  const patterns: Pattern[] = [];
  const patternCells = new WeakSet<PageBlock>();
  const activeComposites = new Set<ResourceId>();
  const compositeIds = new Set<ResourceId>();
  const visitedDrawParams = new Set<ResourceId>();

  const addFont = (id: ResourceId): void => {
    if (fonts.has(id)) return;
    const font = resources.getFont(id);
    if (font) fonts.set(id, font);
    else warn('W_FONT_MISSING', `字体资源 ${id} 不存在`, id);
  };
  const addImage = (id: ResourceId): void => {
    if (images.has(id)) return;
    const image = resources.getImage(id);
    if (image) images.set(id, image);
    else warn('W_IMAGE_DECODE', `图片资源 ${id} 不存在`, id);
  };
  const addPaint = (paint: import('../model/types').Paint | undefined): void => {
    if (!paint || paint.type !== 'pattern') return;
    if (!patternCells.has(paint.pattern.cell)) {
      patternCells.add(paint.pattern.cell);
      patterns.push(paint.pattern);
    }
    collectBlock(paint.pattern.cell, 1);
  };
  const addDrawParam = (id: ResourceId | undefined): void => {
    if (!id || visitedDrawParams.has(id)) return;
    visitedDrawParams.add(id);
    const param: DrawParam | undefined = resources.getDrawParam(id);
    if (!param) return;
    addPaint(param.fillColor);
    addPaint(param.strokeColor);
    addDrawParam(param.relative);
  };

  const collectBlock = (block: PageBlock, depth: number): void => {
    if (depth > MAX_BLOCK_DEPTH) {
      warn('W_COMPOSITE_DEPTH', '资源收集深度超过上限，已停止展开', block.id);
      return;
    }
    for (const child of block.children) {
      switch (child.kind) {
        case 'text':
          addFont(child.font);
          addPaint(child.fillColor);
          addPaint(child.strokeColor);
          addDrawParam(child.drawParam);
          break;
        case 'image':
          addImage(child.resourceId);
          if (child.substitution) addImage(child.substitution);
          if (child.imageMask) addImage(child.imageMask);
          addDrawParam(child.drawParam);
          break;
        case 'path':
          addPaint(child.fillColor);
          addPaint(child.strokeColor);
          addDrawParam(child.drawParam);
          break;
        case 'composite':
          addDrawParam(child.drawParam);
          collectComposite(child.resourceId, depth + 1);
          break;
        case 'block':
          collectBlock(child, depth + 1);
          break;
        default: {
          const exhaustive: never = child;
          void exhaustive;
        }
      }
    }
  };
  const collectComposite = (id: ResourceId, depth: number): void => {
    if (depth > MAX_BLOCK_DEPTH || activeComposites.has(id)) {
      warn('W_COMPOSITE_DEPTH', `复合资源 ${id} 递归/循环超限，已跳过`, id);
      return;
    }
    const unit = resources.getComposite(id);
    if (!unit) {
      warn('W_COMPOSITE_DEPTH', `复合资源 ${id} 不存在`, id);
      return;
    }
    compositeIds.add(id);
    activeComposites.add(id);
    collectBlock(unit.content, depth);
    activeComposites.delete(id);
  };

  for (const template of templates) {
    for (const layer of template.layers) {
      addDrawParam(layer.drawParam);
      collectBlock({ kind: 'block', children: layer.children }, 0);
    }
  }
  for (const layer of page.layers) {
    addDrawParam(layer.drawParam);
    collectBlock({ kind: 'block', children: layer.children }, 0);
  }
  for (const annotation of annotations) {
    if (annotation.appearance) collectBlock(annotation.appearance, 0);
  }

  const [loadedFonts, loadedImages] = await Promise.all([
    loadFontsSafely(loader, [...fonts.values()], warn),
    loadImagesSafely(loader, [...images.values()], warn),
  ]);
  throwIfAborted();

  const defaultStyle = createDefaultStyle();
  const resolver = new StyleResolver(
    new DrawParamGraph(resources.drawParams),
    defaultStyle,
    (code, message, resourceId) => warn(code, message, resourceId),
  );
  const styleOptions = {
    lookup: resources,
    onWarning: (code: string, message: string, resourceId?: ResourceId) => {
      warn(code, message, resourceId);
    },
    maxDepth: MAX_BLOCK_DEPTH,
  };

  const styleLayers = [
    ...templates.flatMap((template) => template.layers),
    ...page.layers,
  ];
  const styleModel: PageModel = { ...page, layers: styleLayers };
  const resolvedStyles = resolvePageStyles(styleModel, resolver, styleOptions);

  const preparedPage: PreparedPage = {
    page,
    styles: resolvedStyles.styles,
    annotationBlocks: [],
  };
  const blocks = new Map<string, IndependentBlock>();
  const bundle: PreparedPageBundle = {
    page: preparedPage,
    templates,
    fonts: loadedFonts,
    images: loadedImages,
    blocks,
  };

  // 准备阶段构建显示列表时没有真实渲染器；PaintBinder 不依赖 renderer 实例。
  const buildBinder = createPaintBinder(undefined as unknown as import('../renderer/types').Renderer, {
    dpi: input.dpi ?? 96,
    onWarning: (code, message, patternId) => warn(code, message, patternId),
  });
  const binder = wrapPatternBinder(buildBinder);

  // 同一复合资源在不同父样式/DrawParam 下需要独立 variant；只按资源 ID 缓存会串样式。
  const compositeVariants = new Map<string, { id: ResourceId; style: ResolvedStyle }>();
  const visitCompositeStyles = (objects: readonly import('../model/types').PageObject[]): void => {
    for (const object of objects) {
      if (object.kind === 'block') {
        visitCompositeStyles(object.children);
      } else if (object.kind === 'composite') {
        const style = preparedPage.styles.get(object);
        if (!style) continue;
        const key = compositeBlockCacheKey(object.resourceId, style);
        if (!compositeVariants.has(key)) {
          compositeVariants.set(key, { id: object.resourceId, style });
        }
      }
    }
  };
  visitCompositeStyles(styleLayers.flatMap((layer) => layer.children));

  const buildingComposites = new Set<string>();
  const buildComposite = (
    id: ResourceId,
    styleRoot: ResolvedStyle,
    depth: number,
  ): IndependentBlock | undefined => {
    const cacheKey = compositeBlockCacheKey(id, styleRoot);
    const cached = blocks.get(cacheKey);
    if (cached) return cached;
    if (depth > MAX_BLOCK_DEPTH || buildingComposites.has(cacheKey)) {
      warn('W_COMPOSITE_DEPTH', `复合资源 ${id} 递归/循环超限，已跳过`, id);
      return undefined;
    }
    const unit = resources.getComposite(id);
    if (!unit) {
      warn('W_COMPOSITE_DEPTH', `复合资源 ${id} 不存在`, id);
      return undefined;
    }
    buildingComposites.add(cacheKey);
    try {
      const space = { width: unit.width * 0.3528, height: unit.height * 0.3528 };
      const styles = resolveBlockStyles(
        unit.content,
        styleRoot,
        resolver,
        styleOptions,
        'composite',
      );
      const block: IndependentBlock = {
        id,
        source: 'composite',
        space,
        content: unit.content,
        styleRoot,
        cacheKey,
        displayList: { commands: [], bounds: { x: 0, y: 0, w: space.width, h: space.height } },
      };
      setBlockStyles(block, styles);
      let dynamic = false;
      block.displayList = buildBlockDisplayList(space, unit.content, {
        prepared: bundle,
        binder,
        styles,
        strictImageCtm: input.strictImageCtm ?? true,
        ...(input.substitutionMode ? { substitutionMode: input.substitutionMode } : {}),
        ...(input.dpi !== undefined ? { dpi: input.dpi } : {}),
        onWarning: warn,
        resolveComposite: (object: CompositeObject) =>
          buildComposite(object.resourceId, styles.get(object) ?? styleRoot, depth + 1),
        markDynamic: () => {
          dynamic = true;
        },
      });
      if (dynamic) markBlockDynamic(block);
      blocks.set(cacheKey, block);
      if (!blocks.has(id)) blocks.set(id, block);
      return block;
    } finally {
      buildingComposites.delete(cacheKey);
    }
  };

  for (const variant of compositeVariants.values()) buildComposite(variant.id, variant.style, 0);
  // 兜底：收集到但未被样式遍历覆盖的复合资源（例如仅出现在底纹/注释中）。
  const variantIds = new Set([...compositeVariants.values()].map((variant) => variant.id));
  for (const id of compositeIds) {
    if (!variantIds.has(id)) buildComposite(id, defaultStyle, 0);
  }

  // 底纹 tile：按 cell 缓存，供各对象绑定时复用。
  const patternStyles = new WeakSet<PageBlock>();
  for (const pattern of patterns) {
    if (patternStyles.has(pattern.cell)) continue;
    patternStyles.add(pattern.cell);
    const styles = resolveBlockStyles(pattern.cell, defaultStyle, resolver, styleOptions, 'pattern-cell');
    let dynamic = false;
    const tile = buildBlockDisplayList(
      { width: pattern.width, height: pattern.height },
      pattern.cell,
      {
        prepared: bundle,
        binder,
        styles,
        strictImageCtm: input.strictImageCtm ?? true,
        ...(input.substitutionMode ? { substitutionMode: input.substitutionMode } : {}),
        ...(input.dpi !== undefined ? { dpi: input.dpi } : {}),
        onWarning: warn,
        resolveComposite: (object: CompositeObject) =>
          buildComposite(object.resourceId, styles.get(object) ?? defaultStyle, 0),
        markDynamic: () => {
          dynamic = true;
          warn('W_UNSUPPORTED_PAINT', '底纹 cell 含需 group 的嵌套复合对象，已跳过该 tile', pattern.cell.id);
        },
      },
    );
    if (!dynamic) {
      PATTERN_TILES.set(pattern.cell, tile);
      const patternId = PATTERN_CELL_IDS.get(pattern.cell);
      if (patternId) {
        const block: IndependentBlock = {
          id: patternId,
          source: 'pattern-cell',
          space: { width: pattern.width, height: pattern.height },
          content: pattern.cell,
          styleRoot: defaultStyle,
          cacheKey: `pattern:${patternId}`,
          displayList: tile,
        };
        setBlockStyles(block, styles);
        if (!blocks.has(patternId)) blocks.set(patternId, block);
      }
    }
  }

  const annotationBlocks = buildAnnotationBlocks(annotations, {
    styleRoot: defaultStyle,
    baseDir: '',
    onWarning: warn,
    buildBlock: (annotation, appearance, boundary) => {
      const space = { width: boundary.w, height: boundary.h };
      const styles = resolveBlockStyles(
        appearance,
        defaultStyle,
        resolver,
        styleOptions,
        'annotation',
      );
      const block: IndependentBlock = {
        id: annotation.id,
        source: 'annotation',
        space,
        content: appearance,
        styleRoot: defaultStyle,
        cacheKey: `annotation:${annotation.id}`,
        boundary,
        displayList: { commands: [], bounds: { x: 0, y: 0, w: space.width, h: space.height } },
      };
      setBlockStyles(block, styles);
      let dynamic = false;
      block.displayList = buildBlockDisplayList(space, appearance, {
        prepared: bundle,
        binder,
        styles,
        strictImageCtm: input.strictImageCtm ?? true,
        ...(input.substitutionMode ? { substitutionMode: input.substitutionMode } : {}),
        ...(input.dpi !== undefined ? { dpi: input.dpi } : {}),
        onWarning: warn,
        resolveComposite: (object: CompositeObject) =>
          buildComposite(object.resourceId, styles.get(object) ?? defaultStyle, 0),
        markDynamic: () => {
          dynamic = true;
        },
      });
      if (dynamic) markBlockDynamic(block);
      return block;
    },
  });
  preparedPage.annotationBlocks = annotationBlocks;

  return bundle;
}

/**
 * 加载字体；单个字体加载失败不阻断整页。
 *
 * @param loader 准备阶段加载器。
 * @param resources 去重后的字体资源。
 * @param warn warning 回调。
 * @returns 字体资源 ID → 字体面集合。
 */
async function loadFontsSafely(
  loader: PreparePageLoader,
  resources: readonly FontResource[],
  warn: (code: string, message: string, objectId?: ResourceId) => void,
): Promise<ReadonlyMap<ResourceId, FontFaceSet>> {
  if (resources.length === 0) return new Map();
  try {
    return await loader.loadFontFaces(resources);
  } catch (error) {
    warn(
      'W_FONT_MISSING',
      `字体批量加载失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return new Map();
  }
}

/**
 * 并行解码图片；单张失败时 warning 并跳过。
 *
 * @param loader 准备阶段加载器。
 * @param resources 去重后的图片资源。
 * @param warn warning 回调。
 * @returns 图片资源 ID → 解码结果。
 */
async function loadImagesSafely(
  loader: PreparePageLoader,
  resources: readonly ImageResource[],
  warn: (code: string, message: string, objectId?: ResourceId) => void,
): Promise<ReadonlyMap<ResourceId, DecodedImage>> {
  const result = new Map<ResourceId, DecodedImage>();
  const settled = await Promise.allSettled(
    resources.map(async (resource) => ({ resource, image: await loader.decodeImage(resource) })),
  );
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      result.set(item.value.resource.id, item.value.image);
    } else {
      warn(
        'W_IMAGE_DECODE',
        `图片解码失败：${item.reason instanceof Error ? item.reason.message : String(item.reason)}`,
      );
    }
  }
  return result;
}

/**
 * 用底纹 cell 缓存包装 PaintBinder。
 *
 * 样式层只产出带 cell 的 PatternSpec，没有 patternId；这里按 cell 补上预构建 tile。
 *
 * @param base 基础绑定器。
 * @returns 能解析内联底纹的绑定器。
 */
export function wrapPatternBinder(
  base: PaintBinder,
  resolveImage?: DisplayListImageResolver,
): PaintBinder {
  const materialized = new WeakMap<DisplayList, DisplayList>();
  return {
    bind(spec: PaintSpec | undefined, bounds) {
      if (spec?.kind !== 'pattern') return base.bind(spec, bounds);
      const patternId = spec.spec.patternId ?? PATTERN_CELL_IDS.get(spec.spec.cell);
      let tile = spec.spec.tile ?? PATTERN_TILES.get(spec.spec.cell);
      if (tile && resolveImage) {
        let resolved = materialized.get(tile);
        if (!resolved) {
          resolved = materializeDisplayListImages(tile, resolveImage);
          materialized.set(tile, resolved);
        }
        tile = resolved;
      }
      if (!tile && !patternId) return base.bind(spec, bounds);
      return base.bind(
        {
          kind: 'pattern',
          spec: {
            ...spec.spec,
            ...(patternId ? { patternId } : {}),
            ...(tile ? { tile } : {}),
          },
        },
        bounds,
      );
    },
    clear() {
      base.clear();
    },
  };
}

/**
 * 取已构建的底纹 tile。
 *
 * @param cell 底纹 cell 内容。
 * @returns 显示列表或 undefined。
 */
export function getPreparedPatternTile(cell: PageBlock): DisplayList | undefined {
  return PATTERN_TILES.get(cell);
}

/** 供测试清理底纹缓存（WeakMap 无法枚举，只能按 cell 删除）。 */
export function clearPreparedPatternTile(cell: PageBlock): void {
  PATTERN_TILES.delete(cell);
}
