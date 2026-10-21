/**
 * 资源存储与作用域合并。
 *
 * 打开文档时只建立“资源 ID → 定义”的索引，不加载字体/图片二进制；页级作用域是
 * 文档级索引 + 模板级索引 + 页级索引的只读合并视图，查找顺序为页级 → 模板级 → 文档级。
 */

import type {
  ColorSpaceDef,
  CompositeGraphicUnit,
  DrawParam,
  FontResource,
  ImageResource,
  Pattern,
  ResourceDefinitionSet,
  ResourceId,
} from '../model/types';
import type { OFDWarning } from '../warnings';
import type { CreatePageScopeInput, DocumentResourceIndex, PageResourceScope, ResourceIndex } from './types';
import { normalizeResourceId } from '../model/ids';

/** 资源覆盖 warning 回调。 */
export type ResourceWarningHandler = (warning: OFDWarning) => void;

/** 空资源索引。 */
export const EMPTY_RESOURCE_INDEX: Readonly<ResourceIndex> = Object.freeze({
  fonts: new Map(),
  images: new Map(),
  drawParams: new Map(),
  compositeGraphicUnits: new Map(),
  patterns: new Map(),
  colorSpaces: new Map(),
});

/** 单个资源 XML 的定义集合转索引。 */
export function resourceSetToIndex(set: ResourceDefinitionSet): ResourceIndex {
  return {
    fonts: new Map(set.fonts.map((font) => [font.id, font])),
    images: new Map(set.images.map((image) => [image.id, image])),
    drawParams: new Map(set.drawParams.map((param) => [param.id as ResourceId, param])),
    compositeGraphicUnits: new Map(set.compositeGraphicUnits.map((item) => [item.id, item])),
    patterns: new Map(set.patterns),
    colorSpaces: new Map(set.colorSpaces.map((space) => [space.id, space])),
  };
}

/** 合并输入：低优先级层在前，高优先级层在后。 */
export interface MergeResourceIndexInput {
  /** 资源层，按低→高优先级排列；后出现者覆盖前出现者。 */
  layers: readonly Partial<ResourceIndex>[];
  /** 每层的来源标签，用于 warning。 */
  labels?: readonly string[];
  /** warning 回调。 */
  onWarning?: ResourceWarningHandler;
}

/**
 * 按优先级合并资源索引。
 *
 * @param input 资源层（低→高）与 warning 回调。
 * @returns 合并后的只读索引；同 ID 被覆盖时上报 `W_DUPLICATE_RESOURCE`。
 */
export function mergeResourceIndexes(input: MergeResourceIndexInput): ResourceIndex {
  const fonts = new Map<ResourceId, FontResource>();
  const images = new Map<ResourceId, ImageResource>();
  const drawParams = new Map<ResourceId, DrawParam>();
  const compositeGraphicUnits = new Map<ResourceId, CompositeGraphicUnit>();
  const patterns = new Map<ResourceId, Pattern>();
  const colorSpaces = new Map<ResourceId, ColorSpaceDef>();
  let defaultColorSpace: ResourceId | undefined;

  const mergeMap = <V>(
    target: Map<ResourceId, V>,
    source: ReadonlyMap<ResourceId, V> | undefined,
    label: string,
    category: string,
  ): void => {
    if (!source) return;
    for (const [rawId, value] of source) {
      const id = normalizeResourceId(rawId);
      if (!id) continue;
      if (target.has(id)) {
        input.onWarning?.({
          code: 'W_DUPLICATE_RESOURCE',
          message: `${category} 资源 ID ${id} 被${label}覆盖，保留高优先级定义`,
          resourceId: id,
        });
      }
      target.set(id, value);
    }
  };

  input.layers.forEach((layer, index) => {
    const label = input.labels?.[index] ?? `第 ${index + 1} 层`;
    mergeMap(fonts, layer.fonts, label, 'Font');
    mergeMap(images, layer.images, label, 'Image');
    mergeMap(drawParams, layer.drawParams, label, 'DrawParam');
    mergeMap(compositeGraphicUnits, layer.compositeGraphicUnits, label, 'CompositeGraphicUnit');
    mergeMap(patterns, layer.patterns, label, 'Pattern');
    mergeMap(colorSpaces, layer.colorSpaces, label, 'ColorSpace');
    if (layer.defaultColorSpace) defaultColorSpace = normalizeResourceId(layer.defaultColorSpace);
  });

  return {
    fonts,
    images,
    drawParams,
    compositeGraphicUnits,
    patterns,
    colorSpaces,
    ...(defaultColorSpace ? { defaultColorSpace } : {}),
  };
}

/** 文档级资源索引构建输入。 */
export interface BuildDocumentResourceIndexInput {
  /** PublicRes.xml 包内路径列表。 */
  publicRes?: readonly string[];
  /** DocumentRes.xml 包内路径列表。 */
  documentRes?: readonly string[];
  /** 已解码的资源定义集合，顺序与 publicRes + documentRes 一致。 */
  sets?: readonly ResourceDefinitionSet[];
  /** 已解码的资源索引；与 `sets` 二选一。 */
  indexes?: readonly Partial<ResourceIndex>[];
  /** CommonData/DefaultCS。 */
  defaultColorSpace?: ResourceId;
  /** warning 回调。 */
  onWarning?: ResourceWarningHandler;
}

/**
 * 构建文档级资源索引。
 *
 * PublicRes 先合并、DocumentRes 后合并；两者同 ID 时 DocumentRes 覆盖并 warning。
 *
 * @param input 资源路径、定义集合与默认颜色空间。
 * @returns 文档级索引。
 */
export function buildDocumentResourceIndex(input: BuildDocumentResourceIndexInput): DocumentResourceIndex {
  const layers: Partial<ResourceIndex>[] = [];
  const labels: string[] = [];
  const sets = input.sets ?? [];
  const indexes = input.indexes ?? [];
  if (indexes.length > 0) {
    for (let index = 0; index < indexes.length; index += 1) {
      layers.push(indexes[index] as Partial<ResourceIndex>);
      labels.push(index < (input.publicRes?.length ?? 0) ? 'PublicRes' : 'DocumentRes');
    }
  } else {
    for (let index = 0; index < sets.length; index += 1) {
      layers.push(resourceSetToIndex(sets[index] as ResourceDefinitionSet));
      labels.push(index < (input.publicRes?.length ?? 0) ? 'PublicRes' : 'DocumentRes');
    }
  }
  const merged = mergeResourceIndexes({
    layers,
    labels,
    ...(input.onWarning ? { onWarning: input.onWarning } : {}),
  });
  return {
    ...merged,
    ...(input.defaultColorSpace ? { defaultColorSpace: normalizeResourceId(input.defaultColorSpace) } : {}),
    publicRes: [...(input.publicRes ?? [])],
    documentRes: [...(input.documentRes ?? [])],
  };
}

/** 文档级资源存储；打开时只解析索引，不加载字体/图片二进制。 */
export class ResourceStore {
  /**
   * @param index 文档级资源索引。
   */
  constructor(
    private readonly index: DocumentResourceIndex = {
      ...EMPTY_RESOURCE_INDEX,
      publicRes: [],
      documentRes: [],
    },
  ) {}

  /**
   * 按 ID 查字体。
   *
   * @param id 资源 ID。
   * @returns 字体定义或 undefined。
   */
  getFont(id: ResourceId): FontResource | undefined {
    return this.index.fonts.get(normalizeResourceId(id));
  }

  /**
   * 按 ID 查图片。
   *
   * @param id 资源 ID。
   * @returns 图片定义或 undefined。
   */
  getImage(id: ResourceId): ImageResource | undefined {
    return this.index.images.get(normalizeResourceId(id));
  }

  /**
   * 按 ID 查 DrawParam。
   *
   * @param id 资源 ID。
   * @returns DrawParam 或 undefined。
   */
  getDrawParam(id: ResourceId): DrawParam | undefined {
    return this.index.drawParams.get(normalizeResourceId(id));
  }

  /**
   * 按 ID 查复合图形资源。
   *
   * @param id 资源 ID。
   * @returns 复合资源或 undefined。
   */
  getComposite(id: ResourceId): CompositeGraphicUnit | undefined {
    return this.index.compositeGraphicUnits.get(normalizeResourceId(id));
  }

  /**
   * 按 ID 查底纹。
   *
   * @param id 资源 ID。
   * @returns 底纹或 undefined。
   */
  getPattern(id: ResourceId): Pattern | undefined {
    return this.index.patterns.get(normalizeResourceId(id));
  }

  /**
   * 创建页级资源作用域（页级 → 模板级 → 文档级）。
   *
   * @param input 页模型与各级资源索引。
   * @returns 只读页级作用域。
   */
  createPageScope(input: CreatePageScopeInput): PageResourceScope {
    const pageResources = [...(input.pageResources ?? [])].reverse();
    const templateResources = [...(input.templateResources ?? [])].reverse();
    const layers: Partial<ResourceIndex>[] = [input.document, ...templateResources, ...pageResources];
    const labels = ['DocumentRes', ...templateResources.map((_, index) => `TemplateRes[${index}]`), ...pageResources.map((_, index) => `PageRes[${index}]`)];
    const merged = mergeResourceIndexes({
      layers,
      labels,
      ...(input.onWarning ? { onWarning: input.onWarning } : {}),
    });
    let defaultColorSpace = input.document.defaultColorSpace;
    for (const layer of input.pageResources ?? []) {
      if (layer.defaultColorSpace) {
        defaultColorSpace = layer.defaultColorSpace;
        break;
      }
    }
    if (!defaultColorSpace) {
      for (const layer of input.templateResources ?? []) {
        if (layer.defaultColorSpace) {
          defaultColorSpace = layer.defaultColorSpace;
          break;
        }
      }
    }
    const templateIds = input.page.templates.map((template) => template.id);
    return Object.freeze({
      ...merged,
      ...(defaultColorSpace ? { defaultColorSpace: normalizeResourceId(defaultColorSpace) } : {}),
      pageId: input.page.id,
      templateIds,
      getFont: (id: ResourceId) => merged.fonts.get(normalizeResourceId(id)),
      getImage: (id: ResourceId) => merged.images.get(normalizeResourceId(id)),
      getDrawParam: (id: ResourceId) => merged.drawParams.get(normalizeResourceId(id)),
      getComposite: (id: ResourceId) => merged.compositeGraphicUnits.get(normalizeResourceId(id)),
      getPattern: (id: ResourceId) => merged.patterns.get(normalizeResourceId(id)),
    });
  }
}
