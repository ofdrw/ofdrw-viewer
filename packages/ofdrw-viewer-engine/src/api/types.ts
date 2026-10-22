/**
 * 公共 API 冻结契约（对应设计方案 15.1）。
 *
 * 这里只放 API 级类型与默认限制常量；实现类位于 api/document.ts、api/page.ts、
 * api/render-task.ts、api/viewport.ts。`Viewport` 定义在 common/types，避免渲染器反向依赖 API。
 */

import type { ResourceId, PageSize } from '../model/types';
import type { ByteSource } from '../platform/byte-source';
import type { FontInput, FontProvider } from '../platform/font-provider';
import type { ImageDecoderPlugin } from '../platform/image-decoder';
import type { Canvas2DLike, CanvasRenderingContext2DLike, Renderer } from '../renderer/types';
import type { OFDWarning } from '../warnings';
import type { Viewport } from '../common/types';

export type { FontInput } from '../platform/font-provider';
export type { OFDWarning } from '../warnings';
export type { PageSize } from '../model/types';
export type { Viewport } from '../common/types';

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
});

/** 文档字节来源；Node/微信来源本轮只保留类型，Web 实现 arraybuffer/blob/url/custom。 */
export type OFDSource =
  | { kind: 'arraybuffer'; data: ArrayBuffer | Uint8Array }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'url'; url: string; headers?: Record<string, string> }
  | { kind: 'node-file'; path: string }
  | { kind: 'wechat-file'; filePath: string }
  | { kind: 'custom'; source: ByteSource };

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
  /** 取消信号；中止后 promise 以 `OFD_ABORTED` 拒绝。 */
  signal?: AbortSignal;
}

/** 打开文档参数。 */
export interface OFDOpenOptions {
  /** 文档字节来源。 */
  source: OFDSource;
  /** 多文档包时的文档索引，默认 0。 */
  documentIndex?: number;
  /** 资源限制覆盖；未提供的字段使用 DEFAULT_RESOURCE_LIMITS。 */
  limits?: Partial<ResourceLimits>;
  /** 宿主补充字体，按需用于缺字/缺字体回退。 */
  supplementaryFonts?: FontInput[];
  /** 宿主字体提供者。 */
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
   * 临时画布工厂；仅当未提供 `renderer` 时由 engine 内部 H5Canvas2DRenderer 使用。
   * 未注入时保持 H5 默认的 document/OffscreenCanvas 兜底；Node/小程序宿主应注入。
   *
   * @param width 画布宽度，像素。
   * @param height 画布高度，像素。
   * @returns 宿主画布。
   */
  createCanvas?: (width: number, height: number) => Canvas2DLike;
  /** 渲染器扩展点；不传时由 engine 内部创建 H5Canvas2DRenderer。自定义 renderer 时本项优先，createCanvas 不参与。 */
  renderer?: Renderer;
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