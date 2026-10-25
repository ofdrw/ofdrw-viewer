/**
 * `@ofdrw/ofdrw-viewer-engine` 公共入口。
 *
 * 公共 API 与公共类型只从本文件导出；内部模块（render/model/container/xml 等）
 * 不直接从包根暴露。`CanvasFactory` 是 H5Canvas2DRenderer 内部结构，不在此导出。
 */

// Chrome 67 兼容补丁必须最先求值：后续模块的顶层表达式可能直接使用 globalThis 等
// Chrome 67 缺失的 API。这里只做副作用导入，不从包根导出任何内容。
import './compat';

// ---------------------------------------------------------------------------
// 公共 API 类
// ---------------------------------------------------------------------------
export { OFDDocument } from './api/document';
export { OFDPage } from './api/page';
export { RenderTask } from './api/render-task';
export { OFDEventBus } from './api/events';
export { H5Canvas2DRenderer } from './renderer/canvas2d';

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------
export { VERSION, getVersion } from './version';

// ---------------------------------------------------------------------------
// 事件类型
// ---------------------------------------------------------------------------
export type {
  DocumentCloseEndEvent,
  DocumentCloseStartEvent,
  DocumentOpenAbortEvent,
  DocumentOpenEndEvent,
  DocumentOpenErrorEvent,
  DocumentOpenStartEvent,
  OFDAbortCause,
  OFDAddEventListenerOptions,
  OFDEventBase,
  OFDEventBusOptions,
  OFDEventHandler,
  OFDEventMap,
  OFDEventName,
  OFDOperationEventBase,
  OFDPageEventMap,
  OFDPageEventName,
  OFDPageOperationEventBase,
  PageLoadAbortEvent,
  PageLoadEndEvent,
  PageLoadErrorEvent,
  PageLoadStartEvent,
  PageRenderAbortEvent,
  PageRenderEndEvent,
  PageRenderErrorEvent,
  PageRenderStartEvent,
} from './api/events';

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
export { KNOWN_ANNOTATION_TYPES } from './api/types';
export type {
  CacheOptions,
  CanvasImageEncodeSource,
  EncodeImage,
  FontInput,
  OFDDocumentInfo,
  OFDOpenFromContainerOptions,
  OFDOpenOptions,
  OFDPageSize,
  OFDSource,
  OFDViewport,
  PageImageExportOptions,
  PageImageFormat,
  PageImageMime,
  PageImageResult,
  PageRenderParameters,
  PageSize,
  ResourceLimits,
  ViewportOptions,
} from './api/types';

// ---------------------------------------------------------------------------
// 页级绘制内容过滤
// ---------------------------------------------------------------------------
export type {
  AnnotationType,
  DrawLayerOptions,
  KnownAnnotationType,
  PageContentFilter,
} from './api/types';
export type {
  AttachmentInfo,
  AttachmentOperationOptions,
  AttachmentSink,
  BookmarkItem,
  DestinationType,
  CommonDataSummary,
  DocumentDestination,
  DocumentFontResource,
  DocumentFontResourcesOptions,
  DocumentHeader,
  DocumentMetadata,
  DocumentPageArea,
  DocumentPermissions,
  OfdPackageInfo,
  OFDDocumentApi,
  OFDPageApi,
  OutlineNode,
  PageInfo,
  PageInfoOptions,
  PagePrepareOptions,
  SignatureEntryInfo,
  SignatureProvider,
  SignatureReferenceInfo,
  SignatureStampInfo,
  SignedValueFile,
  TextChar,
  TextContent,
  TextContentOptions,
  TextFontInfo,
  TextItem,
  TextLayer,
  TextPoint,
  TextQuad,
  TextRect,
  TextUnit,
} from './api/ui-types';
export { DEFAULT_DPI, MM_PER_INCH, getPageTransform, getPageViewport } from './api/viewport';

// ---------------------------------------------------------------------------
// 字体别名：内置别名组与扩展入口
// ---------------------------------------------------------------------------
export { DEFAULT_FONT_ALIASES, expandFontName, expandFontNames } from './font/aliases';
export type { FontAliasTable } from './font/aliases';

// ---------------------------------------------------------------------------
// 平台接口
// ---------------------------------------------------------------------------
export type { ByteSource } from './platform/byte-source';
export type {
  VirtualContainer,
  VirtualContainerFactory,
  VirtualFileMeta,
  VirtualReadOptions,
} from './platform/virtual-container';
export type { ImageDecoder, ImageDecoderPlugin } from './platform/image-decoder';
export type { FontMatchRequest, FontProvider } from './platform/font-provider';

// ---------------------------------------------------------------------------
// 容器基础能力
// ---------------------------------------------------------------------------
export { openZipVirtualContainer } from './api/container';
export type { OpenZipVirtualContainerOptions } from './api/container';

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