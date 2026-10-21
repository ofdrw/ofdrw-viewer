/**
 * 资源层类型（实现由 T3/dev-model 完成）。
 *
 * 资源作用域：文档级（PublicRes + DocumentRes）与页级（PageRes + 模板 PageRes）；
 * 查找顺序为页级 → 文档级，同 ID 页级覆盖文档级并 warning。
 */

import type {
  ColorSpaceDef,
  CompositeGraphicUnit,
  DrawParam,
  FontResource,
  ImageResource,
  PageModel,
  Pattern,
  ResourceId,
} from '../model/types';

/** 一个资源 XML 建立后的索引；Map 的键为归一化后的十进制资源 ID。 */
export interface ResourceIndex {
  fonts: ReadonlyMap<ResourceId, FontResource>;
  images: ReadonlyMap<ResourceId, ImageResource>;
  drawParams: ReadonlyMap<ResourceId, DrawParam>;
  compositeGraphicUnits: ReadonlyMap<ResourceId, CompositeGraphicUnit>;
  patterns: ReadonlyMap<ResourceId, Pattern>;
  colorSpaces: ReadonlyMap<ResourceId, ColorSpaceDef>;
  /** 资源 XML 的 DefaultCS 资源 ID；缺省回退 RGB。 */
  defaultColorSpace?: ResourceId;
}

/** 页级资源作用域；文档级索引 + 页级索引 + 模板页索引合并后的只读视图。 */
export interface PageResourceScope extends ResourceIndex {
  /** 页 ID。 */
  readonly pageId: ResourceId;
  /** 该页关联的模板页 ID。 */
  readonly templateIds: readonly ResourceId[];
  /** 找不到时返回 undefined，不抛错。 */
  getFont(id: ResourceId): FontResource | undefined;
  getImage(id: ResourceId): ImageResource | undefined;
  getDrawParam(id: ResourceId): DrawParam | undefined;
  getComposite(id: ResourceId): CompositeGraphicUnit | undefined;
  getPattern(id: ResourceId): Pattern | undefined;
}

/** 文档级资源索引。 */
export interface DocumentResourceIndex extends ResourceIndex {
  /** PublicRes.xml 的包内路径列表。 */
  publicRes: readonly string[];
  /** DocumentRes.xml 的包内路径列表。 */
  documentRes: readonly string[];
}

/** 建立页级作用域的输入。 */
export interface CreatePageScopeInput {
  page: PageModel;
  document: DocumentResourceIndex;
  /** 页级资源（多个 PageRes.xml 按顺序合并；先出现者优先）。 */
  pageResources?: readonly Partial<ResourceIndex>[];
  /** 模板页资源（按 Template 引用顺序；先出现者优先）。 */
  templateResources?: readonly Partial<ResourceIndex>[];
  /** 同 ID 覆盖 warning 回调。 */
  onWarning?: (warning: import('../warnings').OFDWarning) => void;
}