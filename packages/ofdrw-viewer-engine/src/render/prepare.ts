/**
 * 准备阶段编排（实现由 T10/dev-pipeline 完成）。
 *
 * 通过 loader 获取字体/图片/模板/注释运行时，完成样式结算与独立块构建；
 * 不解析 XML、不碰目标 Canvas/渲染器，结果供同步绘制阶段只读。
 */

import type {
  Annotation,
  FontResource,
  ImageResource,
  IndependentBlock,
  PageModel,
  PreparedPage,
  ResourceId,
  TemplateRef,
} from '../model/types';
import type { DecodedImage } from '../common/types';
import type { FontFaceSet } from '../font/types';
import type { PageResourceScope } from '../resource/types';
import type { WarningHandler } from '../warnings';
import { notImplemented } from '../common/not-implemented';

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
 * 准备页面：解析尺寸、建立作用域、加载字体/图片/复合资源、结算样式、构建独立块。
 *
 * @param input 页模型、资源作用域、取消信号与 warning 回调。
 * @returns 准备阶段产物。
 */
export async function preparePage(input: PreparePageInput): Promise<PreparedPageBundle> {
  void input;
  return notImplemented('render.preparePage');
}