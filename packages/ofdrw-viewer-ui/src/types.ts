/**
 * `@ofdrw/ofdrw-viewer-ui` 公共类型。
 *
 * 本文件只放跨模块共享的公共契约：来源、缩放/旋转、命令选项、事件、签章详情等。
 * 内部实现类型（PageView、RenderQueue、FindController 状态等）不得从这里导出。
 * 引擎已经公开的页面/大纲/书签/签章/文本类型直接复用，避免 UI 另造模型。
 */

import type {
  SignatureVerification,
  VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import type {
  AttachmentInfo,
  DocumentMetadata,
  DocumentPermissions,
  PageImageFormat,
  PageInfo,
  SignatureEntryInfo,
} from '@ofdrw/ofdrw-viewer-engine';
import type { ViewerFeatureStates } from './features';
import type {
  Rotation,
  SidebarView,
  ViewerErrorInfo,
  ViewerOrigin,
  ViewerState,
  ViewerWarning,
  ZoomMode,
} from './state';

// ---------------------------------------------------------------------------
// 引擎公共类型（UI 公共 API 会原样透出）
// ---------------------------------------------------------------------------
export type {
  AttachmentInfo,
  BookmarkItem,
  DocumentDestination,
  DocumentMetadata,
  DocumentPermissions,
  OutlineNode,
  PageImageFormat,
  PageInfo,
  SignatureEntryInfo,
  SignatureProvider,
  SignatureReferenceInfo,
  SignatureStampInfo,
  SignedValueFile,
  TextChar,
  TextContent,
  TextItem,
  TextQuad,
  TextRect,
} from '@ofdrw/ofdrw-viewer-engine';

// ---------------------------------------------------------------------------
// 功能开关与状态
// ---------------------------------------------------------------------------
export type {
  FeatureAvailability,
  FeatureDisplay,
  FeatureDisplayMode,
  FeatureReason,
  FeatureState,
  ViewerFeature,
  ViewerFeatureStates,
  ViewerFeatures,
} from './features';
export type {
  DialogName,
  DocumentState,
  FindState,
  InitialViewerStateOptions,
  Rotation,
  ScaleValue,
  SidebarView,
  Theme,
  ToastLevel,
  UIState,
  ViewState,
  ViewerErrorInfo,
  ViewerOrigin,
  ViewerState,
  ViewerToast,
  ViewerWarning,
  VisiblePageRange,
  ZoomMode,
} from './state';

/**
 * 阅读器接受的文档来源。
 *
 * 字符串按公开 URL 处理；对象形式用于企业系统附加请求头（MVP 预留）。
 */
export type ViewerSource =
  | ArrayBuffer
  | Uint8Array
  | Blob
  | string
  | { readonly url: string; readonly headers?: Record<string, string> };

/** 图片导出格式。 */
export type ImageFormat = PageImageFormat;

/**
 * 页码范围。
 *
 * 页码均为 1-based：`current` 表示当前页，`all` 表示全部页，
 * 数字数组按升序去重后使用，`{ from, to }` 为闭区间。
 */
export type PageRange =
  | 'all'
  | 'current'
  | { readonly from: number; readonly to: number }
  | readonly number[];

/** `goToPage` 选项。 */
export interface GoToPageOptions {
  /** 是否平滑滚动；大跨度跳转建议关闭。 */
  readonly smooth?: boolean;
}

/** 查找选项。 */
export interface FindOptions {
  /** 是否区分大小写；默认 false。 */
  readonly caseSensitive?: boolean;
  /** 是否全词匹配（仅对拉丁文有效）；默认 false。 */
  readonly wholeWord?: boolean;
  /** 是否高亮全部匹配；默认 true。 */
  readonly highlightAll?: boolean;
  /** 是否从当前页开始查找；默认 true。 */
  readonly fromCurrentPage?: boolean;
}

/** 打印选项。 */
export interface PrintOptions {
  /** 打印范围；默认 `current`。 */
  readonly pages?: PageRange;
  /** 输出 DPI；`auto` 按页数自适应，默认 `auto`。 */
  readonly dpi?: number | 'auto';
  /** 是否包含页面背景；默认 false（打印白底）。 */
  readonly includeBackground?: boolean;
  /** 打印方向；`current` 沿用当前阅读旋转，默认 `current`。 */
  readonly rotation?: Rotation | 'current';
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 单页图片导出选项。 */
export interface ExportImageOptions {
  /** 页码，1-based；默认当前页。 */
  readonly page?: number;
  /** 图片格式；默认 `png`。 */
  readonly format?: ImageFormat;
  /** 输出 DPI；`auto` 按页数自适应，默认 `auto`。 */
  readonly dpi?: number | 'auto';
  /** JPEG/WebP 质量，0..1；默认 0.92，PNG 忽略。 */
  readonly quality?: number;
  /** 背景色；PNG 传 null 得到透明背景，JPEG/WebP 强制白底。 */
  readonly background?: string | null;
  /** 导出旋转；默认 0。 */
  readonly rotation?: Rotation;
  /** 自定义文件名（不含扩展名）；默认按文档名与页码生成。 */
  readonly filename?: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 多页图片导出选项；多页默认打包为 ZIP。 */
export interface ExportImagesOptions extends Omit<ExportImageOptions, 'page'> {
  /** 导出范围；默认 `current`。 */
  readonly pages?: PageRange;
  /** 自定义 ZIP 文件名（不含扩展名）。 */
  readonly zipFilename?: string;
}

/** 单页导出结果。 */
export interface ExportImageResult {
  /** 图片数据。 */
  readonly blob: Blob;
  /** 下载文件名（含扩展名）。 */
  readonly filename: string;
  /** 页号，1-based。 */
  readonly pageNumber: number;
  /** 实际格式；WebP 不支持时可能回退为 PNG。 */
  readonly format: ImageFormat;
}

/** 原 OFD 导出选项。 */
export interface ExportOfdOptions {
  /** 自定义文件名（不含扩展名）；默认按文档名生成。 */
  readonly filename?: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 原 OFD 导出结果。 */
export interface ExportOfdResult {
  /** 原文件 Blob；加密文档为原始加密字节。 */
  readonly blob: Blob;
  /** 下载文件名（含 `.ofd` 扩展名）。 */
  readonly filename: string;
  /** 字节数，单位 byte。 */
  readonly size: number;
}

/** 导出进度。 */
export interface ExportProgressEvent {
  /** 已完成页数。 */
  readonly current: number;
  /** 总页数。 */
  readonly total: number;
}

// ---------------------------------------------------------------------------
// 文档信息快照
// ---------------------------------------------------------------------------

/**
 * 当前文档的完整信息快照，由 `OFDViewer.getDocumentInfo()` 按需聚合。
 *
 * 不进入 `ViewerState.document`：快照较重，铺进状态会让每次状态提交都携带
 * 全量数据并触发订阅者重渲染。需要时调用一次即可，内部全部命中引擎缓存。
 */
export interface ViewerDocumentInfo {
  /** 引擎完整元数据，含文档属性与包级结构信息。 */
  readonly metadata: DocumentMetadata;
  /** 总页数。 */
  readonly pageCount: number;
  /** 全部页尺寸，按页索引升序。 */
  readonly pageInfos: readonly PageInfo[];
  /** 文档权限声明；不含 DRM 强制。 */
  readonly permissions: DocumentPermissions;
  /** 附件元信息列表，保持 XML 顺序；无附件时为空数组。 */
  readonly attachments: readonly AttachmentInfo[];
  /** 签章条目数。 */
  readonly signatureCount: number;
  /** 大纲顶层条目数。 */
  readonly outlineCount: number;
  /** 书签条目数。 */
  readonly bookmarkCount: number;
  /** 打开来源；内存字节打开时省略。 */
  readonly origin?: ViewerOrigin;
}

// ---------------------------------------------------------------------------
// 签章详情（UI 解析 SignedValue.dat 后构造，不是引擎返回值）
// ---------------------------------------------------------------------------

/** 算法标识。 */
export interface AlgorithmInfo {
  /** OID。 */
  readonly oid: string;
  /** 友好名称；未知时省略。 */
  readonly name?: string;
}

/** 证书主题 DN 的常用属性。 */
export interface CertificateAttributes {
  /** CN。 */
  readonly cn?: string;
  /** O。 */
  readonly o?: string;
  /** OU。 */
  readonly ou?: string;
  /** C。 */
  readonly c?: string;
  /** ST。 */
  readonly st?: string;
  /** L。 */
  readonly l?: string;
  /** emailAddress。 */
  readonly email?: string;
  /** serialNumber。 */
  readonly serialNumber?: string;
}

/** 只读展示的 X.509 证书信息。 */
export interface CertificateInfo {
  /** 格式化后的主题 DN。 */
  readonly subject: string;
  /** 格式化后的颁发者 DN。 */
  readonly issuer: string;
  /** 序列号（十六进制字符串）。 */
  readonly serialNumber: string;
  /** 生效时间（ISO 8601）。 */
  readonly notBefore?: string;
  /** 失效时间（ISO 8601）。 */
  readonly notAfter?: string;
  /** 主题属性。 */
  readonly subjectAttributes?: CertificateAttributes;
  /** 证书签名算法。 */
  readonly signatureAlgorithm?: AlgorithmInfo;
  /** 公钥算法。 */
  readonly publicKeyAlgorithm?: AlgorithmInfo;
}

/** 印章图片元信息与可渲染的原始字节。 */
export interface SealImageInfo {
  /** 图片格式，例如 `png`/`jpg`。 */
  readonly format: string;
  /** 图片宽，mm。 */
  readonly widthMm: number;
  /** 图片高，mm。 */
  readonly heightMm: number;
  /**
   * 图片原始字节（来自 SignedValue.dat 内嵌 SESeal 的 picture.data）。
   *
   * 仅用于 UI 以 Blob URL 渲染；不进入 state、不写日志、不上传。缺失时 UI
   * 显示明确降级文案，不能伪造图片。
   */
  readonly data?: Uint8Array;
}

/** 印章信息（来自 `SignedValue.dat` 的 `TBS_Sign.eseal`）。 */
export interface SealInfo {
  /** 印章结构版本。 */
  readonly version: 'v1' | 'v4' | 'v5' | 'unknown';
  /** 印章编码。 */
  readonly esId?: string;
  /** 印章名称。 */
  readonly name?: string;
  /** 原始类型整数。 */
  readonly typeCode?: number;
  /** 类型文案：单位印章/个人印章/未知。 */
  readonly typeLabel?: string;
  /** 制章日期。 */
  readonly createDate?: string;
  /** 有效期开始。 */
  readonly validStart?: string;
  /** 有效期结束。 */
  readonly validEnd?: string;
  /** 印章属性 certList 中可解析的证书（不保证存在）。 */
  readonly certificate?: CertificateInfo;
  /** 印章图片元信息。 */
  readonly image?: SealImageInfo;
}

/** 签章时间的来源。 */
export type SignedAtSource = 'timeInfo' | 'signatureDateTime' | 'timestamp-token';

/** 签章者/签名信息（UI 解析 `SignedValue.dat` 得到）。 */
export interface SignerInfo {
  /** 签章者证书。 */
  readonly certificate?: CertificateInfo;
  /** 签章者证书 DER；仅用于下载，不进入持久状态。 */
  readonly certificateDer?: Uint8Array;
  /** 签章时间。 */
  readonly signedAt?: string;
  /** 签章时间来源。 */
  readonly signedAtSource?: SignedAtSource;
  /** 签名算法。 */
  readonly algorithm?: AlgorithmInfo;
  /** 原文摘要，hex；可选展示。 */
  readonly dataHash?: string;
  /** 签章属性信息。 */
  readonly propertyInfo?: string;
  /** 是否含时间戳；只展示有无，不解析、不验证。 */
  readonly timestampPresent?: boolean;
}

/** 签章展示状态：仅展示信息，未验签。 */
export interface SignatureValidation {
  /** 固定为 `not-verified`，UI 不得出现“有效/验签通过”措辞。 */
  readonly status: 'not-verified';
  /** 面向用户的声明文案。 */
  readonly note: string;
}

/** 单个签章的完整详情。 */
export interface SignatureDetail {
  /** 引擎返回的签章条目。 */
  readonly entry: SignatureEntryInfo;
  /** 印章信息。 */
  readonly seal?: SealInfo;
  /** 签章者信息。 */
  readonly signer?: SignerInfo;
  /** 固定的未验证状态。 */
  readonly validation: SignatureValidation;
  /** 非致命解析降级信息。 */
  readonly warnings?: readonly ViewerWarning[];
  /** 最近一次验证中该签名的结果；未验证时省略。 */
  readonly verification?: SignatureVerification;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/** 文档打开、页数已知。 */
export interface DocumentOpenEvent {
  /** 总页数。 */
  readonly pageCount: number;
}

/** 文档关闭完成。 */
export type DocumentCloseEvent = Record<string, never>;

/** 当前页变化中。 */
export interface PageChangingEvent {
  /** 新页码，1-based。 */
  readonly pageNumber: number;
  /** 旧页码，1-based。 */
  readonly previous: number;
}

/** 单页渲染完成。 */
export interface PageRenderedEvent {
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 渲染缩放倍率。 */
  readonly scale: number;
  /** 渲染旋转角度。 */
  readonly rotation: Rotation;
}

/** 初始可见页加载完成。 */
export interface PagesLoadedEvent {
  /** 总页数。 */
  readonly pageCount: number;
}

/** 缩放变化。 */
export interface ScaleChangingEvent {
  /** 新缩放倍率。 */
  readonly scale: number;
  /** 新缩放模式。 */
  readonly zoomMode: ZoomMode;
  /** 旧缩放倍率。 */
  readonly previous: number;
}

/** 旋转变化。 */
export interface RotationChangingEvent {
  /** 新角度。 */
  readonly rotation: Rotation;
  /** 旧角度。 */
  readonly previous: Rotation;
}

/** 侧栏切换。 */
export interface SidebarViewChangedEvent {
  /** 当前侧栏；关闭时为 null。 */
  readonly view: SidebarView | null;
}

/** 查找开始。 */
export interface FindStartEvent {
  /** 归一化后的查询。 */
  readonly query: string;
  /** 已知匹配总数；开始搜索时为 0。 */
  readonly total: number;
  /** 当前匹配序号，1-based；无匹配为 0。 */
  readonly current: number;
}

/** 查找匹配集合更新。 */
export type FindMatchesEvent = FindStartEvent;

/** 当前匹配变化。 */
export type FindCurrentEvent = FindStartEvent;

/** 选区变化。 */
export interface SelectionChangeEvent {
  /** 选区文本。 */
  readonly text: string;
  /** 是否为空选区。 */
  readonly isEmpty: boolean;
}

/** 签章覆盖层被点击。 */
export interface SignatureClickEvent {
  /** 签章 ID。 */
  readonly id: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
}

/** 打印进度。 */
export interface PrintProgressEvent {
  /** 已完成页数。 */
  readonly current: number;
  /** 总页数。 */
  readonly total: number;
}

/** 打印开始。 */
export type PrintStartEvent = PrintProgressEvent;

/** 打印结束。 */
export type PrintEndEvent = PrintProgressEvent;

/** 验证完成；只包含报告，不含凭据。 */
export type VerificationCompletedEvent = VerificationReport;

/** 诊断 warning。 */
export type WarningEvent = ViewerWarning;

/** 诊断 error。 */
export type ErrorEvent = ViewerErrorInfo;

/** 功能开关或有效能力变化。 */
export type FeaturesChangeEvent = ViewerFeatureStates;

/** 任意视图状态变化。 */
export type StateChangeEvent = ViewerState;

/** 全部事件名与载荷。 */
export type ViewerEventMap = {
  documentopen: DocumentOpenEvent;
  documentclose: DocumentCloseEvent;
  pagechanging: PageChangingEvent;
  pagerendered: PageRenderedEvent;
  pagesloaded: PagesLoadedEvent;
  scalechanging: ScaleChangingEvent;
  rotationchanging: RotationChangingEvent;
  sidebarviewchanged: SidebarViewChangedEvent;
  findstart: FindStartEvent;
  findmatches: FindMatchesEvent;
  findcurrent: FindCurrentEvent;
  selectionchange: SelectionChangeEvent;
  signatureclick: SignatureClickEvent;
  verificationcompleted: VerificationCompletedEvent;
  printstart: PrintStartEvent;
  printprogress: PrintProgressEvent;
  printend: PrintEndEvent;
  exportprogress: ExportProgressEvent;
  warning: WarningEvent;
  error: ErrorEvent;
  featureschange: FeaturesChangeEvent;
  statechange: StateChangeEvent;
};

/** 事件名。 */
export type ViewerEventName = keyof ViewerEventMap & string;

/** 事件载荷。 */
export type ViewerEventPayload<K extends ViewerEventName> = ViewerEventMap[K];

/** 事件监听器。 */
export type ViewerEventHandler<K extends ViewerEventName> = (
  payload: ViewerEventPayload<K>,
) => void;