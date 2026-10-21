/**
 * `ofdrw-viewer-engine` 公共入口。
 *
 * 公共 API 与公共类型只从本文件导出；内部模块（render/model/container/xml 等）
 * 不直接从包根暴露。`CanvasFactory` 是 H5Canvas2DRenderer 内部结构，不在此导出。
 */

// ---------------------------------------------------------------------------
// 公共 API 类
// ---------------------------------------------------------------------------
export { OFDDocument } from './api/document';
export { OFDPage } from './api/page';
export { RenderTask } from './api/render-task';
export { H5Canvas2DRenderer } from './renderer/canvas2d';

// ---------------------------------------------------------------------------
// 错误与 warning
// ---------------------------------------------------------------------------
export { OFDError, isOFDError, toOFDError } from './errors';
export type { OFDErrorCode, OFDErrorOptions } from './errors';
export { WARNING_CODES, WarningCollector } from './warnings';
export type {
  OFDWarning,
  WarningCode,
  WarningContext,
  WarningEmitter,
  WarningHandler,
} from './warnings';

// ---------------------------------------------------------------------------
// API 类型
// ---------------------------------------------------------------------------
export { DEFAULT_CACHE_OPTIONS, DEFAULT_RESOURCE_LIMITS } from './api/types';
export type {
  CacheOptions,
  FontInput,
  OFDDocumentInfo,
  OFDOpenOptions,
  OFDPageSize,
  OFDSource,
  OFDViewport,
  PageRenderParameters,
  PageSize,
  ResourceLimits,
  ViewportOptions,
} from './api/types';
export { DEFAULT_DPI, MM_PER_INCH, getPageTransform, getPageViewport } from './api/viewport';

// ---------------------------------------------------------------------------
// 平台接口
// ---------------------------------------------------------------------------
export type { ByteSource } from './platform/byte-source';
export type { ImageDecoder, ImageDecoderPlugin } from './platform/image-decoder';
export type { FontMatchRequest, FontProvider } from './platform/font-provider';

// ---------------------------------------------------------------------------
// 渲染器扩展点
// ---------------------------------------------------------------------------
export type {
  Canvas2DLike,
  CanvasGradientLike,
  CanvasPatternLike,
  CanvasRenderingContext2DLike,
  CompositeMode,
  GroupOptions,
  H5Canvas2DRendererOptions,
  Renderer,
} from './renderer/types';

// ---------------------------------------------------------------------------
// 目标无关公共类型
// ---------------------------------------------------------------------------
export type {
  AxialGradientSpec,
  Box,
  CanvasImageSourceLike,
  DecodedImage,
  DrawStyle,
  FillRule,
  GradientExtend,
  GradientMapType,
  GradientSpec,
  GradientStop,
  ImageDataLike,
  ImageHandle,
  LineCap,
  LineJoin,
  Matrix,
  MeshShadingPoint,
  MeshShadingSpec,
  PaintSpec,
  PathCommand,
  PatternPaint,
  PatternReflect,
  PatternSpec,
  Point,
  RadialGradientSpec,
  ResolvedPaint,
  Rgba,
  Viewport,
} from './common/types';
export type { DisplayList, DrawCommand } from './common/display-list';
export type { ResourceId } from './model/types';