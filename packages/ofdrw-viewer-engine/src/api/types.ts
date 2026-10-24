/**
 * 公共 API 冻结契约（对应设计方案 15.1）。
 *
 * 这里只放 API 级类型与默认限制常量；实现类位于 api/document.ts、api/page.ts、
 * api/render-task.ts、api/viewport.ts。`Viewport` 定义在 common/types，避免渲染器反向依赖 API。
 */

import type { ResourceId, PageSize } from '../model/types';
import type { FontInput, FontProvider } from '../platform/font-provider';
import type { ImageDecoderPlugin } from '../platform/image-decoder';
import type { VirtualContainer, VirtualContainerFactory } from '../platform/virtual-container';
import type { OFDSource } from '../platform/source';
import type { Canvas2DLike, CanvasRenderingContext2DLike, Renderer } from '../renderer/types';
import type { OFDWarning } from '../warnings';
import type { Viewport } from '../common/types';
import type { PageContentFilter } from '../render/content-filter';
import type { OFDEventBus } from './events';

export type { FontInput } from '../platform/font-provider';
export type { OFDSource } from '../platform/source';
export type { OFDWarning } from '../warnings';
export type { PageSize } from '../model/types';
export type { Viewport } from '../common/types';
// 页级绘制内容过滤类型：与 `render`/`exportImage`/`getTextContent` 的 `contentFilter` 参数配套导出。
export type {
  AnnotationType,
  DrawLayerOptions,
  KnownAnnotationType,
  PageContentFilter,
} from '../render/content-filter';
export { KNOWN_ANNOTATION_TYPES } from '../render/content-filter';

/** 资源限制；单位除特别说明外均为 byte，设 0 表示不限制（仅测试建议）。 */
export interface ResourceLimits {
  /** 压缩包大小上限，byte，默认 256 MiB。 */
  maxPackageBytes: number;
  /** ZIP 条目数上限，默认 20,000。 */
  maxEntries: number;
  /** 单条目解压大小上限，byte，默认 64 MiB。 */
  maxEntryBytes: number;
  /** 总解压大小上限，byte，默认 512 MiB。 */
  maxTotalUncompressedBytes: number;
  /** 单条目最大压缩比，默认 200。 */
  maxCompressionRatio: number;
  /** 单个 XML 大小上限，byte，默认 32 MiB。 */
  maxXmlBytes: number;
  /** 单个字体大小上限，byte，默认 64 MiB。 */
  maxFontBytes: number;
  /** 图片像素上限，默认 100,000,000。 */
  maxImagePixels: number;
  /** Canvas 像素上限，默认 64,000,000。 */
  maxCanvasPixels: number;
  /** 递归深度上限（复合对象/资源引用），默认 16。 */
  maxRecursionDepth: number;
}

/** 缓存预算；字节类字段单位为 byte。 */
export interface CacheOptions {
  /** 解压后 XML 缓存上限，byte，默认 16 MiB。 */
  xmlBytes: number;
  /** 字体二进制缓存上限，byte，默认 64 MiB。 */
  fontBytes: number;
  /** 解码图片缓存上限，byte，默认 64 MiB。 */
  imageBytes: number;
  /** 字形轮廓缓存条目数，默认 20,000。 */
  glyphCount: number;
  /** 页面模型缓存页数，默认 8。 */
  pageModels: number;
  /** 文本层 mm 数据缓存页数，默认 4；t71 实现消费。 */
  textPages?: number;
}

/** 资源限制默认值（设计方案 7.4 / 15.1）。 */
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxPackageBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxXmlBytes: 32 * 1024 * 1024,
  maxFontBytes: 64 * 1024 * 1024,
  maxImagePixels: 100_000_000,
  maxCanvasPixels: 64_000_000,
  maxRecursionDepth: 16,
});

/** 缓存默认值（设计方案 15.1）。 */
export const DEFAULT_CACHE_OPTIONS: Readonly<CacheOptions> = Object.freeze({
  xmlBytes: 16 * 1024 * 1024,
  fontBytes: 64 * 1024 * 1024,
  imageBytes: 64 * 1024 * 1024,
  glyphCount: 20_000,
  pageModels: 8,
  textPages: 4,
});

/** Viewport 选项。 */
export interface ViewportOptions {
  /** 输出精度 DPI，默认 96；144/300 用于高精度输出。 */
  dpi?: number;
}

/** `page.render` 参数；engine 不设置 canvas 尺寸、不清屏。 */
export interface PageRenderParameters {
  /** 宿主提供的 2D 上下文；engine 会以 M_page 覆盖其预置 CTM。 */
  canvasContext: CanvasRenderingContext2DLike;
  /** 页面在指定 DPI 下的像素尺寸。 */
  viewport: Viewport;
  /**
   * 页级绘制内容白名单；不传表示全部绘制。
   *
   * 只作用于本次渲染：引擎不保存“当前过滤”，`exportImage`/`getTextContent`
   * 也不会继承上一次 `render` 的过滤。
   */
  contentFilter?: PageContentFilter;
  /** 取消信号；中止后 promise 以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
}

/** 页面图片导出格式。 */
export type PageImageFormat = 'png' | 'jpeg' | 'webp';

/** 页面图片导出结果的 MIME 类型。 */
export type PageImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** 页面图片导出参数；整页导出，不包含阅读器缩放；可选导出旋转。 */
export interface PageImageExportOptions {
  /** 输出精度 DPI，默认 96；非有限或 <=0 时回退 96。 */
  dpi?: number;
  /** 输出格式，默认 `png`。 */
  format?: PageImageFormat;
  /** JPEG/WebP 质量，0..1，默认 0.92；PNG 忽略。 */
  quality?: number;
  /**
   * 导出旋转角度，默认 0；仅改变导出图片方向，不改变页面模型或正常渲染。
   * 90/270 时输出宽高互换。
   */
  rotation?: 0 | 90 | 180 | 270;
  /**
   * 背景色 CSS 字符串，默认 `#ffffff`。
   * PNG 可传 `null` 得到透明背景；JPEG/WebP 不支持透明，`null` 按白底处理。
   */
  background?: string | null;
  /**
   * 页级绘制内容白名单；不传表示全部绘制。
   *
   * 只作用于本次导出，不继承页面最近一次 `render` 的过滤；需要与显示一致时显式传同一对象。
   */
  contentFilter?: PageContentFilter;
  /** 取消信号；中止后 promise 以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
}

/** 页面图片导出结果。 */
export interface PageImageResult {
  /** 编码后的图片字节；归调用方所有。 */
  data: Uint8Array;
  /** 与所选 format 对应的 MIME 类型。 */
  mime: PageImageMime;
  /** 输出宽度，设备像素。 */
  width: number;
  /** 输出高度，设备像素。 */
  height: number;
  /** 实际使用的输出 DPI。 */
  dpi: number;
}

/**
 * 浏览器 Canvas 的可选编码能力。
 *
 * engine 默认编码器优先用 `convertToBlob`，其次 `toBlob`；Node/小程序宿主可
 * 通过 `OFDOpenOptions.encodeImage` 注入自己的编码器。
 */
export interface CanvasImageEncodeSource extends Canvas2DLike {
  /** 浏览器原生编码入口；返回 Blob。 */
  convertToBlob?(options?: { type?: string; quality?: number }): Promise<Blob>;
  /** 传统 Canvas 编码入口；回调参数为 null 表示编码失败。 */
  toBlob?(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

/**
 * 页面图片编码钩子。
 *
 * @param canvas 已绘制整页的 Canvas，设备像素。
 * @param format 请求的编码格式。
 * @param quality 0..1；PNG 固定 1，JPEG/WebP 缺省 0.92。
 * @returns 编码后的图片字节；不得返回空数组。
 */
export type EncodeImage = (
  canvas: CanvasImageEncodeSource,
  format: PageImageFormat,
  quality: number,
) => Promise<Uint8Array>;

/** 打开文档的公共选项（不含 source/container/containerFactory）。 */
export interface OFDOpenBaseOptions {
  /** 多文档包时的文档索引，默认 0。 */
  documentIndex?: number;
  /** 资源限制覆盖；未提供的字段使用 DEFAULT_RESOURCE_LIMITS。 */
  limits?: Partial<ResourceLimits>;
  /**
   * 用户默认字体：文档字体完全缺省时使用的替代字体，优先级高于 `supplementaryFonts`。
   *
   * 用于"没有字体就用这些字"的简单兜底；内嵌字体或 `fontProvider` 命中时不会被选为主字体。
   * 仅作替代来源，不可信任显式 GID（忽略 CGTransform 的 GID，走 cmap）；
   * 多个来源按字体名/别名评分选择主字体。只接受已读好的 `data`。
   * 需要按需读取 URL/本地字体时，请实现 `fontProvider` 并在 `match()` 内读取。
   * 不传时行为与未引入本参数时一致。
   */
  readonly defaultFonts?: readonly FontInput[];
  /** 宿主补充字体，按需用于缺字/缺字体回退；只接受已读好的 `data`。 */
  supplementaryFonts?: FontInput[];
  /** 宿主字体提供者；`match()` 是字体按需读取的唯一入口。 */
  fontProvider?: FontProvider;
  /** JBIG2/TIFF 等图片解码插件。 */
  imageDecoders?: ImageDecoderPlugin[];
  /** warning 回调；默认不打印。 */
  onWarning?: (warning: OFDWarning) => void;
  /** 缓存预算覆盖。 */
  cache?: Partial<CacheOptions>;
  /** 图片缺 CTM 时是否严格按 identity 1×1 绘制，默认 true。 */
  strictImageCtm?: boolean;
  /** 图层顺序：默认 `type`（设计方案图 16），`document` 为严格 XML 顺序。 */
  layerOrder?: 'document' | 'type';
  /**
   * 临时画布工厂；供默认 H5 渲染器和 `page.exportImage` 使用。
   * 页面 render 传了 `renderer` 时以 renderer 为准；exportImage 仍使用本工厂。
   * 未注入时保持 H5 默认的 document/OffscreenCanvas 兜底；Node/小程序宿主应注入。
   *
   * @param width 画布宽度，像素。
   * @param height 画布高度，像素。
   * @returns 宿主画布。
   */
  createCanvas?: (width: number, height: number) => Canvas2DLike;
  /**
   * 页面图片编码钩子，供 `OFDPage.exportImage` 使用。
   * 不传时浏览器默认用 `canvas.convertToBlob`/`canvas.toBlob`；Node/小程序宿主应注入。
   */
  encodeImage?: EncodeImage;
  /** 页面渲染器扩展点；不传时由 engine 内部创建 H5Canvas2DRenderer。自定义 renderer 只接管 render，exportImage 仍用 createCanvas。 */
  renderer?: Renderer;
  /**
   * 打开阶段与后续文档生命周期使用的事件总线。
   *
   * 需要在 open 完成前监听 `document:open:*` 时传入；省略时由引擎创建，
   * 并通过 `document.events` 访问。一个总线只对应一个文档实例。
   */
  eventBus?: OFDEventBus;
  /** 打开取消信号；中止时 open 以 OFD_ABORTED 拒绝并派发 `document:open:abort`。 */
  signal?: AbortSignal;
}

/**
 * 默认 ZIP / 容器工厂打开参数。
 *
 * `source` 必填，保持既有调用方（UI/CLI 等）的类型兼容；只以已构造容器打开
 * 时改用 `OFDOpenFromContainerOptions`。
 */
export interface OFDOpenOptions extends OFDOpenBaseOptions {
  /**
   * 文档字节来源。
   *
   * 走默认 ZIP 容器或 `containerFactory` 时必填；提供 `container` 时 engine
   * 不打开该来源，仅作为宿主上下文。
   */
  source: OFDSource;
  /**
   * 已构造好的明文容器；与 `containerFactory` 互斥。
   *
   * 容器必须 `encrypted=false` 且 `read()` 返回明文；engine 对
   * `encrypted=true` 的容器抛 `OFD_ENCRYPTED`。
   *
   * 宿主借用语义：engine 不关闭该容器，宿主必须在 `doc.close()` 后自行
   * `await container.close()`；同一容器可被多个文档复用。
   */
  container?: VirtualContainer;
  /**
   * 由 engine 调用并拥有的容器工厂；与 `container` 互斥，`source` 作为工厂输入。
   *
   * 工厂返回的容器在打开失败或 `doc.close()` 时由 engine 关闭；来源所有权
   * 随工厂/容器。
   */
  containerFactory?: VirtualContainerFactory;
}

/**
 * 纯容器打开参数：直接注入已构造好的明文容器，不需要 `source`。
 *
 * `source` 可选，仅作为宿主上下文，engine 不打开、不关闭；纯容器模式不提供
 * 容器工厂，需要工厂时使用 `OFDOpenOptions`。
 */
export interface OFDOpenFromContainerOptions extends OFDOpenBaseOptions {
  /**
   * 已构造好的明文容器；必须 `encrypted=false` 且 `read()` 返回明文。
   *
   * 宿主借用语义：engine 不关闭该容器，宿主在 `doc.close()` 后自行关闭。
   */
  container: VirtualContainer;
  /** 可选宿主上下文来源；engine 不打开、不关闭。 */
  source?: OFDSource;
  /** 纯容器模式不支持容器工厂；需要工厂时使用 `OFDOpenOptions`。 */
  containerFactory?: never;
}

/** 文档模型的最小公开视图（用于 API 层内部与测试断言）。 */
export interface OFDDocumentInfo {
  /** OFD 版本。 */
  version: string;
  /** 页数。 */
  pageCount: number;
  /** 每页标识；索引从 0 开始。 */
  pageIds: ResourceId[];
}

/** 页尺寸/Viewport 的公共类型别名（便于 API 消费者引用）。 */
export type { PageSize as OFDPageSize };
export type { Viewport as OFDViewport };