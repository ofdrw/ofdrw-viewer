/**
 * `OFDViewer`：框架无关的 OFD 阅读器核心。
 *
 * 负责 DOM 外壳、文档生命周期、连续滚动排版、可见页渲染调度、缩放/旋转、页码、
 * 功能门控与扩展注册；文本层、查找、缩略图、签章、打印/导出由扩展模块挂载，
 * 核心不直接 import 这些模块，避免并行目录互相依赖。
 */

import { getGlobalObject, replaceChildren } from './compat';

import type {
  DocumentFontResource,
  DocumentPermissions,
  DocumentOpenAbortEvent,
  DocumentOpenErrorEvent,
  DocumentOpenStartEvent,
  PageImageFormat,
  PageInfo,
  PageRenderAbortEvent,
  PageRenderEndEvent,
  PageRenderErrorEvent,
  PageRenderStartEvent,
  SignatureEntryInfo,
  VirtualContainer,
} from '@ofdrw/ofdrw-viewer-engine';
import * as engineApi from '@ofdrw/ofdrw-viewer-engine';
import type {
  CertificateSummary,
  VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import {
  DocumentController,
  normalizeViewerSourceDetailed,
  type EngineDocument,
  type EnginePage,
  type NormalizedViewerSource,
} from './document-controller';
import {
  createFeatureDisabledError,
  isOFDViewerError,
  OFDViewerError,
  type ViewerErrorCode,
} from './errors';
import { DiagnosticPrinter, resolveDiagnosticLevel } from './diagnostics';
import { EventBus, type ViewerEventBus } from './event-bus';
import { FeatureGate } from './feature-gate';
import {
  cloneFeatureStates,
  type FeatureGateOptions,
} from './feature-gate';
import type {
  FeatureDisplay,
  FeatureState,
  ViewerFeature,
  ViewerFeatureStates,
  ViewerFeatures,
} from './features';
import { ViewerHistory, type ViewerHashState } from './history';
import { createTranslator, type MessageKey, type Translator } from './i18n';
import { KeyboardController } from './keyboard';
import {
  CANVAS_RETRY_PIXEL_STEPS,
  DEFAULT_MOBILE_RENDER_CONCURRENCY,
  DEFAULT_RENDER_CONCURRENCY,
  MAX_CANVAS_BASE_DPR,
  MAX_SCALE,
  MIN_SCALE,
  SUPERSAMPLE_FULL_AREA,
  SUPERSAMPLE_HALF_AREA,
  SUPERSAMPLE_MAX,
  SUPERSAMPLE_MID,
  resolveViewerOptions,
  ZOOM_LEVELS,
  type OFDViewerOptions,
  type ResolvedViewerOptions,
} from './options';
import {
  DEFAULT_PAGE_GAP,
  DEFAULT_PAGE_PADDING,
  PageLayout,
  scrollTopForZoomAnchor,
  type ContentPoint,
  type ScrollAnchor,
} from './page-layout';
import { PageView } from './page-view';
import { RenderQueue, type RenderQueueStats } from './render-queue';
import {
  createInitialViewerState,
  type FindState,
  type Rotation,
  type ScaleValue,
  type SidebarView,
  type Theme,
  type ViewerErrorInfo,
  type ViewerOrigin,
  type ViewerState,
  type ViewerWarning,
  type ZoomMode,
} from './state';
import type {
  ExportImageOptions,
  ExportImageResult,
  ExportImagesOptions,
  ExportOfdOptions,
  ExportOfdResult,
  FindOptions,
  PageRange,
  PrintOptions,
  SignatureDetail,
  ViewerDocumentInfo,
  ViewerEventMap,
  ViewerEventName,
  ViewerEventHandler,
  ViewerSource,
} from './types';
import { composeFontAliases } from './font';
import {
  MAX_CANDIDATES_PER_DECLARATION,
  expandLocalFontCandidates,
} from './local-font-names';
import { askLocalFontsGrant, getUIShell } from './ui';
import type { UIDialogOptions, UIShellElements } from './ui/types';
import type { UIShellHost } from './ui';
import type { CertificateSource } from './options';
import { HttpByteSource } from './source/http-byte-source';
import { readOFDSourceBytes, readViewerSourceBytes } from './source/read-source';
import { readPreviewSourceFromLocation } from './source/query-source';
import {
  CryptoService,
  type CryptoOpenPreparation,
  type CryptoServiceHost,
  type CryptoVerifyOptions,
  type VerificationTarget,
} from './crypto';
import { UI_WARNING_CODES } from './diagnostics';
import {
  queryLocalFontFaces,
  queryLocalFontsPermission,
  requestLocalFontsGrant,
  supportsLocalFonts,
} from './local-fonts';
import {
  clearLocalFontsPreference,
  readLocalFontsPreference,
  resolveLocalFontsConfig,
  writeLocalFontsPreference,
  type LocalFontStatus,
  type LocalFontsPreference,
  type LocalFontsStatus,
  type LocalFontsUserState,
  type ResolvedLocalFontsConfig,
} from './local-fonts-state';

/** 手势缩放停止后提交重绘的延迟，单位毫秒；手指静止超过 180 ms 即按最终倍率重绘。 */
const PREVIEW_COMMIT_DELAY_MS = 180;

/** 缩放预览结束后等待滚动停稳的时长，单位毫秒。 */
const PINCH_SETTLE_DELAY_MS = 120;

/** 浏览器页面缩放（visualViewport）稳定后处理滚动的延迟，单位毫秒。 */
const BROWSER_ZOOM_SETTLE_MS = 120;

/** 捏合倍率与已提交倍率视为相同的容差，单位：倍。 */
const PINCH_SCALE_EPSILON = 0.01;

/** 判定双击的两点间隔上限，单位毫秒；超出即按两次单击处理。 */
const TAP_ZOOM_INTERVAL_MS = 300;

/** 判定双击的两点位置容差，单位 px。 */
const TAP_ZOOM_SLOP_PX = 24;

/** 阅读器扩展：在实例创建/注册时执行，返回清理函数。 */
export type ViewerExtension = (viewer: OFDViewer) => void | (() => void);

/** 查找/选区服务；由文本模块实现。 */
export interface ViewerFindService {
  /** 执行查找。 */
  find(query: string, options?: FindOptions): void | Promise<void>;
  /** 下一个匹配。 */
  findNext?(): void | Promise<void>;
  /** 上一个匹配。 */
  findPrevious?(): void | Promise<void>;
  /** 清除查找。 */
  clearFind?(): void;
  /** 读取当前选区文本。 */
  getSelectedText?(): string;
  /** 复制当前选区。 */
  copySelection?(): void | Promise<void>;
  /** 清除选区。 */
  clearSelection?(): void;
}

/** 文本层服务；由文本模块实现。 */
export interface ViewerTextLayerService {
  /** 页面创建/布局变化时刷新文本层。 */
  refresh?(): void;
  /** 销毁。 */
  destroy?(): void;
}

/** 签章服务；由签章模块实现。 */
export interface ViewerSignatureService {
  /** 当前签章摘要。 */
  getSignatures?(): readonly SignatureEntryInfo[];
  /** 读取单个签章详情。 */
  getSignatureDetail?(id: string): SignatureDetail | Promise<SignatureDetail>;
  /** 打开/定位签章。 */
  showSignature?(id: string): void | Promise<void>;
  /**
   * 滚动到签章覆盖层的位置。
   *
   * 详情面板等调用方在打开面板之前调用它，保证出现面板时正文已经停在签章附近；
   * 返回是否由它接管了滚动。
   */
  scrollToSignature?(id: string): boolean;
  /** 销毁。 */
  destroy?(): void;
}

/** 打印服务；由输出模块实现。 */
export interface ViewerPrintService {
  /** 执行打印。 */
  print(options?: PrintOptions): void | Promise<void>;
}

/** 导出服务；由输出模块实现。 */
export interface ViewerExportService {
  /** 导出单页图片。 */
  exportImage(options?: ExportImageOptions): Promise<ExportImageResult>;
  /** 导出多页图片。 */
  exportImages(options?: ExportImagesOptions): Promise<void>;
  /** 导出当前 OFD 原文件。 */
  exportOfd(options?: ExportOfdOptions): Promise<ExportOfdResult>;
}

/** 扩展服务集合。 */
interface ViewerServices {
  find?: ViewerFindService;
  textLayer?: ViewerTextLayerService;
  signature?: ViewerSignatureService;
  print?: ViewerPrintService;
  export?: ViewerExportService;
}

/** 模块级扩展；先注册后创建的实例会在构造时应用。 */
const extensions = new Set<ViewerExtension>();
/** 活跃实例；后注册的扩展会补应用到这些实例。 */
const activeViewers = new Set<OFDViewer>();

/** 浮点页顶的舍入容差，避免整数页顶因浮点误差多进 1px。单位：px。 */
const SCROLL_TOP_EPSILON = 1e-6;

/** 平滑滚动的最短时长，单位：毫秒。 */
export const MIN_SMOOTH_SCROLL_MS = 150;

/** 平滑滚动的最长时长，单位：毫秒；单次跳转不允许拖得比这更久。 */
export const MAX_SMOOTH_SCROLL_MS = 360;

/**
 * 平滑滚动的距离基准，单位 px。
 *
 * 滚动距离达到该值时使用 {@link MAX_SMOOTH_SCROLL_MS}；约等于一个 A4 页高，
 * 即跨页跳转与远距离跳转的分界。
 */
const SMOOTH_SCROLL_DISTANCE_REFERENCE_PX = 1123;

/**
 * 将排版偏移量转换为浏览器可稳定保存的整数 scrollTop。
 *
 * 浏览器按整数像素读写 scrollTop；小数页顶（如 2285.039）直接写入会被截断为
 * 2285，导致 `getPageAtOffset` 回落到上一页，因此统一向上取整。单位：px。
 *
 * @param offset 排版偏移量，单位 px。
 * @returns 非负整数滚动位置，单位 px。
 */
function toIntegerScrollTop(offset: number): number {
  return Math.max(0, Math.ceil(offset - SCROLL_TOP_EPSILON));
}

/**
 * 解析平滑滚动时长。
 *
 * 显式传入的时长直接钳到允许区间；省略时按距离估算：起步即
 * {@link MIN_SMOOTH_SCROLL_MS}，距离达到 {@link SMOOTH_SCROLL_DISTANCE_REFERENCE_PX}
 * 时升到 {@link MAX_SMOOTH_SCROLL_MS}，中间线性增长。这样近距跳转干脆利落，
 * 远距跳转也不会长时间遮挡目标内容。单位：毫秒。
 *
 * @param durationMs 显式时长，单位毫秒；非法值视为省略。
 * @param distance 滚动距离，单位 px。
 * @returns 实际时长，单位毫秒。
 */
function resolveSmoothScrollDuration(durationMs: number | undefined, distance: number): number {
  const span = MAX_SMOOTH_SCROLL_MS - MIN_SMOOTH_SCROLL_MS;
  const ratio = Math.min(1, Math.max(0, distance) / SMOOTH_SCROLL_DISTANCE_REFERENCE_PX);
  const derived = MIN_SMOOTH_SCROLL_MS + ratio * span;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return Math.round(derived);
  return Math.round(Math.min(MAX_SMOOTH_SCROLL_MS, Math.max(MIN_SMOOTH_SCROLL_MS, durationMs)));
}

/** 判断是否为 PromiseLike。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function';
}

/** 视口宽度对应的断点。 */
type ViewportMode = 'desktop' | 'compact' | 'mobile' | 'narrow';

/** 带 `webkit` 前缀的全屏访问器；Chrome 67 只有前缀实现。 */
interface PrefixedFullscreenAccess {
  /** 标准请求方法（Chrome 71+）。 */
  readonly requestFullscreen?: () => Promise<void> | void;
  /** `webkit` 前缀请求方法（Chrome 15–70）。 */
  readonly webkitRequestFullscreen?: () => Promise<void> | void;
  /** 标准退出方法。 */
  readonly exitFullscreen?: () => Promise<void> | void;
  /** `webkit` 前缀退出方法。 */
  readonly webkitExitFullscreen?: () => Promise<void> | void;
  /** 标准全屏元素。 */
  readonly fullscreenElement?: Element | null;
  /** `webkit` 前缀全屏元素。 */
  readonly webkitFullscreenElement?: Element | null;
  /** 标准全屏可用性。 */
  readonly fullscreenEnabled?: boolean;
  /** `webkit` 前缀全屏可用性。 */
  readonly webkitFullscreenEnabled?: boolean;
}

/** 捕获阶段忽略的错误；用于区分取消与真实失败。 */
function isAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'OFD_ABORTED') return true;
  return (error as { code?: unknown }).code === 'OFD_ABORTED';
}

/**
 * 判断本机字体是否真正处于「已启用」状态。
 *
 * 开关显示与浏览器授权同步：用户意向为开**且**浏览器已授予 `local-fonts` 权限时才为真。
 * 权限为 `prompt`/`denied` 时一律为假——这样用户拒绝授权后开关会自动回到关闭态，可以
 * 再点一次重新发起申请，而不是停在一个「开着但不起作用」的假象上。
 *
 * @param wanted 用户意向（`fonts.localFonts.defaultEnabled` 或已记住的选择）。
 * @param permission 浏览器权限态。
 * @returns 真正生效时返回 true。
 */
function isLocalFontsActive(wanted: boolean, permission: LocalFontStatus): boolean {
  return wanted && permission === 'granted';
}

/** 创建取消错误。 */
function createAbortError(): Error {
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

/** 关闭解密容器；重复关闭/关闭失败不影响调用方。 */
async function closeContainer(container: VirtualContainer): Promise<void> {
  try {
    await container.close();
  } catch {
    // 容器已关闭或底层释放失败不影响文档状态。
  }
}

/** 关闭尚未移交的 HTTP 字节源；`close()` 幂等，失败不覆盖原始错误。 */
async function closeHttpSource(source: HttpByteSource | null): Promise<void> {
  if (!source) return;
  try {
    await source.close();
  } catch {
    // 字节源已关闭或底层取消失败不影响文档状态。
  }
}

/** 把打开准备结果转为验证目标。 */
function toVerificationTarget(preparation: CryptoOpenPreparation): VerificationTarget | null {
  if (preparation.kind === 'decrypted') {
    return { kind: 'container', container: preparation.container };
  }
  if (preparation.source) return { kind: 'source', source: preparation.source };
  return null;
}

/**
 * 注册阅读器扩展。
 *
 * 可在入口 import 阶段调用（模块顶层注册），也可在实例创建后调用；重复注册同一
 * 函数不会重复执行。返回取消注册函数。
 *
 * @param extension 扩展函数。
 * @returns 取消注册函数。
 */
export function registerViewerExtension(extension: ViewerExtension): () => void {
  if (typeof extension !== 'function') return () => undefined;
  extensions.add(extension);
  for (const viewer of activeViewers) viewer.applyExtension(extension);
  return () => {
    extensions.delete(extension);
  };
}

/** 创建空扩展服务集合。 */
function createServices(): ViewerServices {
  return {};
}

/** 页面渲染用途；用于把共享总线上的事件路由到主页面或缩略图。 */
export type PageRenderPurpose = 'main' | 'thumbnail';

/** 一次 `page.render()` 发起前的用途登记。 */
interface PendingPageRenderStart {
  /** 页索引，0-based。 */
  readonly pageIndex: number;
  /** 渲染用途。 */
  readonly purpose: PageRenderPurpose;
}

/** `trackPageRenderStart` 返回的登记句柄。 */
export interface PageRenderStartHandle {
  /**
   * 移除尚未消费的登记；重复调用无副作用。
   *
   * @returns 调用前登记是否仍未被引擎 `page:render:start` 消费；true 表示引擎
   *   没有派发 start（测试替身或旧引擎），调用方需要自行启动加载计时。
   */
  drop(): boolean;
}

/**
 * 阅读器核心实例。
 *
 * 构造时创建 DOM 并异步打开 `options.source`；`ready` 可用于等待首次打开完成。
 * 同一个实例跨断点、缩放、旋转只重排/重渲染，不重建文档。
 */
export class OFDViewer implements UIShellHost, CryptoServiceHost {
  /** 首次打开完成的 Promise；打开失败会 reject。 */
  readonly ready: Promise<void>;

  private readonly options: ResolvedViewerOptions;
  private readonly root: HTMLElement;
  private readonly elements: UIShellElements;
  private readonly pagesElement: HTMLElement;
  private readonly controller: DocumentController;
  private readonly eventBus: ViewerEventBus;
  private readonly featureGate: FeatureGate;
  /** 密码能力服务；打开检测、解密、验证与信任根的唯一入口。 */
  private readonly cryptoService: CryptoService;
  private readonly layout: PageLayout;
  private readonly queue: RenderQueue;
  private readonly keyboard: KeyboardController;
  private readonly history: ViewerHistory | null;
  private readonly services: ViewerServices = createServices();
  private readonly extensionCleanups: Array<() => void> = [];
  private readonly appliedExtensions = new Set<ViewerExtension>();
  private readonly pageViews: PageView[] = [];
  private readonly renderOrder: number[] = [];
  private readonly ownerDocument: Document;
  /** 引擎事件总线；每个 viewer 独立，打开文档时注入。测试替身未导出总线时为 null。 */
  private readonly engineEvents: InstanceType<typeof engineApi.OFDEventBus> | null;
  /** `page.render()` 前的用途登记；按页索引分组，start 事件同步消费。 */
  private readonly pendingStarts = new Map<number, PendingPageRenderStart[]>();
  /** 已映射的页面操作：`operationId` → 用途与页索引。 */
  private readonly pageOperations = new Map<
    number,
    { readonly purpose: PageRenderPurpose; readonly pageIndex: number }
  >();
  /** 当前 UI 打开流程的引擎 `operationId`；用于过滤旧文档的迟到事件。 */
  private documentOpenOperationId = 0;
  /** `close()` 是否正在执行；防止引擎 abort 事件重入关闭流程。 */
  private closing = false;
  /** 文档全屏 loading / 错误卡控制器。 */
  private readonly documentLoading: DocumentLoadingOverlay;
  /** 首屏加载占位：覆盖正文区，直到首个可见页渲染完成。 */
  private readonly loadingArea: HTMLElement;
  /** 首屏加载占位的文案节点；占位按需建出，未显示时为 null。 */
  private loadingAreaText: HTMLElement | null = null;
  /** 首屏加载占位是否处于显示状态。 */
  private loadingAreaVisible = false;
  /** 当前语言的翻译器；加载文案与页面文案共用。 */
  private translator: Translator;
  private resizeObserver: ResizeObserver | null = null;
  private state: ViewerState;
  private pageInfos: readonly PageInfo[] = [];
  private disposed = false;
  private viewportMode: ViewportMode = 'desktop';
  private sidebarLayout: 'inline' | 'overlay' | 'drawer' = 'inline';
  private openToken = 0;
  private openAbort: AbortController | null = null;
  /** 最近一次 `open()` 的来源；全屏错误卡的“重试”使用。 */
  private lastOpenSource: ViewerSource | null = null;
  /** UI 持有的解密容器；关闭文档后由 UI 关闭，engine 只借用。 */
  private decryptedContainer: VirtualContainer | null = null;
  /** 加密路径下 UI 持有的 HTTP 字节源；明文路径交给 engine，不在此重复关闭。 */
  private activeHttpSource: HttpByteSource | null = null;
  /** 最近一次打开准备结果；用于自动验证与错误映射。 */
  private cryptoPreparation: CryptoOpenPreparation | null = null;
  /** 本地字体状态订阅者（`onLocalFontsStatusChange`）。 */
  private readonly localFontsListeners = new Set<(status: LocalFontsStatus) => void>();
  /** 当前权限态；`prompt` 表示尚未申请或已被浏览器重置（C12：不缓存否定结果）。 */
  private localFontsPermission: LocalFontStatus = 'prompt';
  /** 是否正在读取本机字体；只影响状态展示。 */
  private localFontsLoading = false;
  /**
   * 用户意向（「用户授权开关」本身）：用户是否希望使用本机字体。
   *
   * 与 `localFontsPermission` 一起决定开关的显示值：**两者同时为真才显示为开**。
   * 初值取 `fonts.localFonts.defaultEnabled`，之后由用户操作或持久化记录更新。
   */
  private localFontsWanted = false;
  /**
   * 用户是否已在授权入口表过态（决定 `LocalFontsStatus.userState` 与是否自动请求授权）。
   *
   * 初值为 true 表示宿主通过 `defaultEnabled` 预先打开了开关；用户在任何入口点击授权或
   * 拒绝后置为 true。
   */
  private localFontsDecided = false;
  /** 最近一次广播的本地字体状态；用于去重，保证「一次变化只触发一次」。 */
  private localFontsPublished: LocalFontsStatus | null = null;
  /** 是否正在补「带上本机字体」的重开（防止 open() 再次触发重开）。 */
  private localFontsReopening = false;
  /**
   * 当前文档打开流程是否已经询问过本机字体授权。
   *
   * 一次打开（含授权成功后 / 补注入时的重开）只问一次，避免「提问 → 重开 → 再提问」的循环；
   * `open()` 开始时复位，用户手动点「关于」里的开关不受此限制。
   */
  private localFontsGrantAsked = false;
  private scrollFrame: number | null = null;
  private reflowFrame: number | null = null;
  private lastVisibleRange = { start: 0, end: -1 };
  private scrollListenerBound = false;
  /** 主区域滚动回调；只做 rAF 合并，实际更新在 `handleScroll` 中完成。 */
  private readonly onScroll = (): void => this.scheduleScrollUpdate();
  /** 进行中的平滑滚动；null 表示当前没有滚动。 */
  private smoothScroll: {
    /** 起始滚动位置，单位 px。 */
    readonly start: number;
    /** 目标滚动位置，单位 px。 */
    readonly target: number;
    /** 起始时间戳，单位毫秒；首帧回调时写入。 */
    startedAt: number | undefined;
    /** 总时长，单位毫秒。 */
    readonly duration: number;
  } | null = null;
  /** 平滑滚动的 rAF 句柄。 */
  private smoothScrollFrame: number | null = null;
  /** 触摸屏当前按下的触点；key 为 pointerId，坐标单位 px。 */
  private readonly touchPoints = new Map<number, { x: number; y: number }>();
  /** 是否处于双指捏合；仅在捏合期间拦截双指手势。 */
  private pinching = false;
  /** 捏合开始时的两指距离，单位 px；0 表示未开始。 */
  private pinchStartDistance = 0;
  /** 捏合开始时的缩放倍率。 */
  private pinchStartScale = 1;
  /** 自上次确认为整帧以来，已上报新位置的触点数（0..2）。 */
  private touchPointsChangedCount = 0;
  /** 捏合开始时视口中心对应的内容坐标；整个手势期间固定不动。 */
  private pinchAnchor: ContentPoint | null = null;
  /** 捏合锚点在主区域可视范围内的纵向偏移，单位 px。 */
  private pinchAnchorOffset = 0;
  /** 手势预览的目标倍率；null 表示当前没有进行中的预览。 */
  private previewScale: number | null = null;
  /** 手势预览期间用户想滚到的位置（不受旧布局末尾夹取），单位 px；提交时写回。 */
  /** 手势预览的提交计时器：停止移动 180 ms 后按最终倍率重绘一次。 */
  private previewCommitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次重绘所用的有效渲染倍率；缩放结束时与当前值比较决定是否重新渲染。 */
  private lastRenderScale = 0;
  /** 倍率取整后未用尽的余量，结转到下一次缩放（pdf.js `_accumulateFactor` 同款）。 */
  private unusedScaleFactor = 1;
  /** 浏览器把滚动位置截断到整数像素时丢掉的亚像素余量，单位 px；下次写入补回。 */
  private unusedScrollTop = 0;
  /** 锁定式（滚轮）缩放开始时可视窗口中心的内容锚点；提交时按它精确还原。 */
  private pinnedZoomAnchor: ContentPoint | null = null;
  /** 锁定式缩放开始时该锚点相对主区域可视顶部的偏移，单位 px。 */
  private pinnedZoomAnchorOffset = 0;
  /** 本轮滚轮手势的锚点偏移（手势期间不变），单位 px。 */
  private lockedAnchorOffset = 0;
  /** 最近一次缩放锚点相对可视窗口左缘的偏移，单位 px。 */
  private anchorClientX = 0;
  /**
   * 是否接管触摸手势（捏合缩放与双指平移）。
   *
   * 仅触屏主设备（手机、平板）为 true；桌面端即使带触摸屏也按“滚轮 + 滚动条”处理，
   * 鼠标拖动不做平移。
   */
  private readonly touchGesturesEnabled = detectTouchPrimary();
  /** 是否按移动端默认值处理（自适应超采样在移动端固定为 1）。 */
  private readonly mobileDevice = detectMobile();
  /** 捏合基准倍率：最近一次手势步进时刻的布局倍率。 */
  private pinchBaseScale = 1;
  /** 最近一个手势步进时刻两指中点的视口 x 坐标，单位 px。 */
  private pinchStartMidX = 0;
  /** 最近一个手势步进时刻两指中点的视口 y 坐标，单位 px。 */
  private pinchStartMidY = 0;
  /** 上一帧两指中点对应的内容锚点；pdf.js 捏合以此为缩放中心。 */
  private pinchFrameAnchor: ContentPoint | null = null;
  /** 上一帧两指中点相对可视窗口顶部的偏移，单位 px。 */
  private pinchFrameOffset = 0;
  /** 预览收尾计时器：滚动停止后收起合成层并重绘。 */
  private pinchSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 浏览器可视视口；仅在支持 `visualViewport` 的环境绑定。 */
  private visualViewport: VisualViewport | null = null;
  /** 最近一次记录的浏览器页面缩放比例；null 表示尚未记录。 */
  private browserScale: number | null = null;
  /** 浏览器页面缩放前画面中心对应的内容坐标；缩放变化后据此还原滚动位置。 */
  private browserZoomAnchor: ContentPoint | null = null;
  /** 浏览器页面缩放稳定检查的计时器。 */
  private browserZoomSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一次轻点的位置、时刻与指针类型；用于判定触屏双击缩放。 */
  private lastTap: { at: number; x: number; y: number; type: string } | null = null;
  /** 已执行 pointer capture 的触点，用于手势结束释放。 */
  private readonly capturedPointers = new Set<number>();
  /** 控制台诊断打印机；负责过滤、去重与 `console.warn`/`console.error` 输出。 */
  private readonly diagnostics: DiagnosticPrinter;
  private readonly onWheel = (event: WheelEvent): void => this.handleWheel(event);
  private readonly onTap = (event: PointerEvent): void => this.handleTap(event);
  private readonly onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event);
  private readonly onPointerMove = (event: PointerEvent): void => this.handlePointerMove(event);
  private readonly onPointerUp = (event: PointerEvent): void => this.handlePointerUp(event);
  private readonly onDoubleClick = (event: MouseEvent): void => this.handleDoubleClick(event);
  private readonly onWindowResize = (): void => this.scheduleViewportUpdate();
  private readonly onFullscreenChange = (): void => {
    const value = !!this.getFullscreenElement();
    if (!value) this.applyFullscreenFallback(false);
    if (value !== this.state.view.fullscreen) {
      this.patchView({ fullscreen: value });
      this.commit();
    }
  };
  /**
   * 沉浸式回退下用 document Escape 退出；原生全屏由浏览器处理。
   *
   * 对话框的 FocusTrap 会在捕获阶段 stopPropagation，因此不会误退出；
   * 侧栏打开时先交给侧栏处理，避免同一次按键既关侧栏又退全屏。
   */
  private readonly onFullscreenFallbackEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!this.root.classList.contains('ofd-viewer--fullscreen-fallback')) return;
    if (this.state.view.sidebarView !== null) {
      this.closeSidebar();
      return;
    }
    event.preventDefault();
    void this.setFullscreen(false);
  };

  /**
   * @param options 容器、来源与阅读器选项。
   * @throws {OFDViewerError} 容器不存在或选项非法。
   */
  constructor(options: OFDViewerOptions) {
    this.options = resolveViewerOptions(options, { mobile: detectMobile() });
    const host = resolveContainer(this.options.container);
    this.ownerDocument = host.ownerDocument;
    this.root = this.ownerDocument.createElement('div');
    this.root.className = 'ofd-viewer';
    this.root.dataset.theme = this.options.theme;
    this.root.lang = this.options.locale;
    host.appendChild(this.root);
    this.elements = createStructure(this.root, this.ownerDocument);
    this.pagesElement = this.elements.main.querySelector<HTMLElement>('.ofd-viewer__pages')!;
    this.elements.main.style.padding = '0';
    this.elements.sidebar.hidden = true;
    this.elements.sidebarMask.hidden = true;
    this.translator = createTranslator(this.options.locale);
    const debug = this.options.debug;
    this.diagnostics = new DiagnosticPrinter({
      console: debug?.console !== false,
      ...(debug?.levels ? { levels: debug.levels } : {}),
      ...(debug?.codes ? { codes: debug.codes } : {}),
    });
    this.documentLoading = new DocumentLoadingOverlay({
      root: this.root,
      ownerDocument: this.ownerDocument,
      translator: this.translator,
      background: [this.elements.toolbar, this.elements.body, this.elements.dialogLayer],
      onCancel: () => this.cancelDocumentOpen(),
      onRetry: () => this.retryOpen(),
      onClose: () => void this.close(),
    });
    this.loadingArea = this.elements.loadingArea ?? this.createLoadingArea();
    this.loadingArea.hidden = true;
    this.loadingAreaText = null;

    this.eventBus = new EventBus<ViewerEventMap>({
      onListenerError: (error, event) => {
        this.warn(UI_WARNING_CODES.W_UI_LISTENER, `事件 ${event} 的监听器抛出异常：${String(error)}`);
      },
    });
    // 引擎模块可能被测试替身替换（未导出总线）；此时降级为 Promise 驱动的计时。
    let EngineEventBus: typeof engineApi.OFDEventBus | undefined;
    try {
      EngineEventBus = engineApi.OFDEventBus;
    } catch {
      EngineEventBus = undefined;
    }
    this.engineEvents =
      typeof EngineEventBus === 'function'
        ? new EngineEventBus({
            onListenerError: (error, type) => {
              this.warn(
                UI_WARNING_CODES.W_ENGINE_EVENT,
                `引擎事件 ${type} 的监听器抛出异常：${String(error)}`,
              );
            },
          })
        : null;
    this.bindEngineEvents();
    this.controller = new DocumentController({
      openDocument: (openOptions) =>
        engineApi.OFDDocument.open({
          ...openOptions,
          ...(this.engineEvents ? { eventBus: this.engineEvents } : {}),
        }) as unknown as Promise<EngineDocument>,
      ...(this.options.requestInit ? { requestInit: this.options.requestInit } : {}),
      ...(this.options.fonts ? { font: this.options.fonts } : {}),
      onWarning: (warning) => this.reportWarning(warning),
      // 字体下载期间把全屏 loading 的主文案切换为「正在加载字体…」：
      // 字体读取发生在引擎打开之前，遮罩已由 `open()` 入口显示，这里只切换文案。
      onFontState: (state) =>
        this.documentLoading.setStatusText(state === 'loading' ? 'loading.fonts' : 'loading.document'),
    });
    this.featureGate = new FeatureGate(this.options.features, {
      display: this.options.featureDisplay,
      ...(this.options.crypto?.enabled === false
        ? { availability: { unsupported: { verification: true } } }
        : {}),
    });
    const initialZoomMode: ZoomMode =
      typeof this.options.initialScale === 'string' ? this.options.initialScale : 'page-actual';
    this.layout = new PageLayout({
      pageInfos: [],
      scale: 1,
      zoomMode: initialZoomMode,
      rotation: this.options.rotation,
      gap: DEFAULT_PAGE_GAP,
      padding: DEFAULT_PAGE_PADDING,
      devicePixelRatio: this.devicePixelRatio(),
    });
    this.state = createInitialViewerState({
      pageNumber: this.options.initialPage,
      scale: 1,
      zoomMode: initialZoomMode,
      rotation: this.options.rotation,
      sidebarView: this.options.sidebar,
      theme: this.options.theme,
      locale: this.options.locale,
      features: this.featureGate.getStates(),
    });
    // 用户意向（本机字体开关）在构造时初始化：持久化选择优先于宿主默认值。
    this.initLocalFontsWanted();
    this.cryptoService = new CryptoService(this, this.options.crypto);
    this.queue = new RenderQueue({
      concurrency: this.options.renderConcurrency,
      onTaskError: (error, task) => {
        if (isAbort(error)) return;
        this.reportError({
          code: 'OFD_RENDER_FAILED',
          message: `页面渲染失败：${error instanceof Error ? error.message : String(error)}`,
          pageIndex: task.pageIndex,
          cause: error,
        });
      },
    });
    this.keyboard = new KeyboardController(this.root, {
      nextPage: () => this.nextPage(),
      previousPage: () => this.previousPage(),
      firstPage: () => this.goToPage(1),
      lastPage: () => this.goToPage(this.state.document.pageCount),
      zoomIn: () => this.zoomIn(),
      zoomOut: () => this.zoomOut(),
      resetZoom: () => this.setZoomMode('auto'),
      find: () => this.openFindFromKeyboard(),
      print: () => void this.print(),
      close: () => this.close(),
    }, { enabled: this.featureGate.isEnabled('keyboardShortcuts') });
    this.history = this.options.updateHash
      ? new ViewerHistory({
          enabled: true,
          onChange: (hash) => this.applyHashState(hash),
        })
      : null;
    this.history?.start();

    this.setupViewport();
    this.applyExtensions();
    for (const extension of extensions) this.applyExtension(extension);
    this.applyFeatureStates();
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.state.view.sidebarView !== null) {
        event.preventDefault();
        this.closeSidebar();
      }
    });
    if (typeof this.ownerDocument.addEventListener === 'function') {
      this.ownerDocument.addEventListener('fullscreenchange', this.onFullscreenChange);
      // Chrome 67 只派发前缀事件；同时监听，重复触发时 onFullscreenChange 幂等。
      this.ownerDocument.addEventListener('webkitfullscreenchange', this.onFullscreenChange);
      this.ownerDocument.addEventListener('keydown', this.onFullscreenFallbackEscape);
    }
    this.ready = this.open(this.options.source);
  }

  // -------------------------------------------------------------------------
  // 公共读取
  // -------------------------------------------------------------------------

  /** 最新状态快照。 */
  getState(): ViewerState {
    return this.state;
  }

  /**
   * 当前引擎文档；供密码服务读取验证目标。
   *
   * @returns 文档实例；未打开时为 null。
   */
  /**
   * 上报密码能力 warning。
   *
   * @param code warning 码。
   * @param message 文案。
   */
  warnCrypto(code: string, message: string): void {
    this.warn(code, message);
  }

  /** 阅读器根节点。 */
  getRoot(): HTMLElement {
    return this.root;
  }

  /** 核心创建的结构元素；供 UI/扩展模块挂载。 */
  getElements(): UIShellElements {
    return this.elements;
  }

  /** 当前总页数。 */
  getPageCount(): number {
    return this.state.document.pageCount;
  }

  /** 当前页码，1-based。 */
  getPageNumber(): number {
    return this.state.view.pageNumber;
  }

  /** `getPageNumber` 的别名，便于宿主按设计方案命名调用。 */
  getCurrentPage(): number {
    return this.getPageNumber();
  }

  /** 当前查找状态；未查找时 query 为空。 */
  getFindState(): FindState {
    return this.state.view.findState;
  }

  /** 当前缩放倍率。 */
  getScale(): number {
    return this.state.view.scale;
  }

  /** 当前旋转角度。 */
  getRotation(): Rotation {
    return this.state.view.rotation;
  }

  /** 当前打开的侧栏；关闭时为 null。 */
  getSidebarView(): SidebarView | null {
    return this.state.view.sidebarView;
  }

  /** 当前可见页范围，内部 0-based。 */
  getVisiblePageRange(): ViewerState['view']['visiblePageRange'] {
    return this.state.view.visiblePageRange;
  }

  /** 渲染队列统计；用于诊断。 */
  getRenderStats(): RenderQueueStats {
    return this.queue.stats;
  }

  /** 当前功能状态。 */
  getFeatureState(feature: ViewerFeature): FeatureState {
    return this.featureGate.getState(feature);
  }

  /** 全部功能状态。 */
  getFeatureStates(): ViewerFeatureStates {
    return cloneFeatureStates(this.featureGate.getStates());
  }

  /** 功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean {
    return this.featureGate.isEnabled(feature);
  }

  /** 当前页视图；页码 1-based。 */
  getPageView(pageNumber: number): PageView | undefined {
    return this.pageViews[Math.trunc(pageNumber) - 1];
  }

  /** 全部页视图；只读。 */
  getPageViews(): readonly PageView[] {
    return this.pageViews;
  }

  /** 当前页信息；页码 1-based。 */
  getPageInfo(pageNumber: number): PageInfo | undefined {
    return this.pageInfos[Math.trunc(pageNumber) - 1];
  }

  /** 全部页信息。 */
  getPageInfos(): readonly PageInfo[] {
    return this.pageInfos;
  }

  /** 底层引擎文档；未打开时为 null。 */
  getDocument(): EngineDocument | null {
    return this.controller.document;
  }

  /** 读取指定页引擎对象；页码 1-based。 */
  async getPage(pageNumber: number): Promise<EnginePage> {
    this.assertOpen();
    const index = this.toIndex(pageNumber);
    return this.controller.getPage(index);
  }

  /** 读取当前文档权限；未打开时返回宽松默认值。 */
  async getPermissions(): Promise<DocumentPermissions> {
    if (!this.controller.isOpen) {
      return { edit: true, annot: true, export: true, signature: true, watermark: true, printScreen: true };
    }
    return this.controller.getPermissions();
  }

  /**
   * 读取当前文档的完整信息快照。
   *
   * 需文档已打开；未打开时抛 `OFD_NOT_OPENED`，不返回空壳，避免调用方误判为
   * “文档没有元数据”。内部并发读取元数据、权限、附件、签章、大纲与书签，均命中
   * 打开阶段或首次读取建立的缓存，不额外读取包内容。
   *
   * 与 `getPermissions()` 的区别：`getPermissions()` 在未打开时返回宽松默认值，
   * 本方法是严格接口。
   *
   * @returns 文档信息快照；快照为普通对象，调用方拥有。
   * @throws OFDViewerError 文档尚未打开时抛 `OFD_NOT_OPENED`。
   */
  async getDocumentInfo(): Promise<ViewerDocumentInfo> {
    this.assertNotDisposed();
    this.assertOpen();
    const [metadata, permissions, attachments, signatures, outline, bookmarks] =
      await Promise.all([
        this.controller.getMetadata(),
        this.controller.getPermissions(),
        this.controller.getAttachments(),
        this.controller.getSignatureEntries(),
        this.controller.getOutline(),
        this.controller.getBookmarks(),
      ]);
    const origin = this.state.document.origin;
    return {
      metadata,
      pageCount: this.pageInfos.length || this.controller.pageCount,
      pageInfos: [...this.pageInfos],
      permissions,
      attachments,
      signatureCount: signatures.length,
      outlineCount: outline.length,
      bookmarkCount: bookmarks.length,
      ...(origin === undefined ? {} : { origin }),
    };
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  /** 订阅事件。 */
  on<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): () => void {
    return this.eventBus.on(event, handler);
  }

  /** 订阅一次事件。 */
  once<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): () => void {
    return this.eventBus.once(event, handler);
  }

  /** 退订事件。 */
  off<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): void {
    this.eventBus.off(event, handler);
  }

  // -------------------------------------------------------------------------
  // 文档生命周期
  // -------------------------------------------------------------------------

  /**
   * 打开/切换文档；会关闭旧文档并取消渲染。
   *
   * 来源优先级：显式参数 > 构造参数 `source` > 页面查询参数 `?file=` / `?base64=`。
   * 三者都没有时以 `OFD_INVALID_OPTION` 拒绝。
   *
   * @param source 文档来源；省略时按上述优先级解析。
   */
  async open(source?: ViewerSource): Promise<void> {
    this.assertNotDisposed();
    const resolved = this.resolveOpenSource(source);
    this.lastOpenSource = resolved;
    const previousSource = this.state.document.source;
    const previousOrigin = this.state.document.origin;
    this.openToken += 1;
    const token = this.openToken;
    // 先作废上一轮打开的操作归属：旧打开的 abort/error 可能在新遮罩显示后才到达，
    // 若不在这里清空，`documentOpenOperationId` 仍匹配旧值，旧事件会收起新遮罩。
    this.documentOpenOperationId = 0;
    this.openAbort?.abort();
    const abort = new AbortController();
    this.openAbort = abort;
    // 新文档会话：控制台诊断的去重集合与状态里的 warning 列表都按文档重置，
    // 使 `getState().ui.warnings` 只反映当前这次打开（含本机字体切换后的重开）。
    this.diagnostics.reset();
    this.patchUI({ warnings: [] });
    this.queue.cancelAll();
    const hasPreviousDocument = this.state.document.status === 'ready';
    this.patchDocument({ status: 'opening', source: null, origin: undefined });
    this.commit();
    // 遮罩从 open() 入口起算，而不是等引擎 `document:open:start`：字体下载与容器
    // 获取都发生在引擎打开之前，若只在引擎事件里计时，这段等待完全没有加载反馈。
    this.documentLoading.begin(resolved, hasPreviousDocument);
    /** 尚未移交给阅读器的解密容器；取消/失败时必须关闭。 */
    let pendingContainer: VirtualContainer | null = null;
    /** 本次创建的 HTTP 字节源；明文路径移交给 engine，加密路径由 UI 关闭。 */
    let httpSource: HttpByteSource | null = null;
    /** 本次来源的原始信息；成功后写入状态供导出命名。 */
    let origin: ViewerOrigin | undefined;
    // 本机字体生效值必须在打开文档之前同步给控制器，否则本次打开读不到开关状态。
    // 权限查询是异步的，必须先完成，否则首次授权后本次打开读到的仍是旧权限态。
    await this.prepareLocalFontsForOpen();
    // 授权询问按「一次打开」计：重开（授权成功后 / 补注入）复用本次询问结果，不再追问。
    this.localFontsGrantAsked = false;
    try {
      // URL → HttpByteSource 只在这里做一次；crypto 与 engine 共用同一实例。
      const normalized: NormalizedViewerSource = normalizeViewerSourceDetailed(
        resolved,
        this.options.requestInit,
        { signal: abort.signal },
      );
      httpSource = normalized.httpSource ?? null;
      origin = normalized.origin;
      const preparation = await this.cryptoService.prepareOpen(normalized.source, abort.signal);
      if (token !== this.openToken || abort.signal.aborted) {
        if (preparation.kind === 'decrypted') await closeContainer(preparation.container);
        await closeHttpSource(httpSource);
        httpSource = null;
        throw createAbortError();
      }
      this.cryptoPreparation = preparation;
      let opened;
      if (preparation.kind === 'decrypted') {
        pendingContainer = preparation.container;
        try {
          opened = await this.controller.openContainerNormalized(
            preparation.container,
            normalized,
            abort.signal,
          );
        } catch (error) {
          await closeContainer(preparation.container);
          pendingContainer = null;
          throw error;
        }
      } else {
        opened = await this.controller.openNormalized(normalized, abort.signal);
        // 明文路径：字节源所有权随引擎容器移交，由 engine 在 doc.close() 关闭。
        httpSource = null;
      }
      if (token !== this.openToken || abort.signal.aborted) throw createAbortError();
      // 旧文档已由 controller 关闭；先关旧解密容器，再关旧 HTTP 字节源。
      await this.releaseDecryptedContainer();
      await this.releaseSource();
      this.decryptedContainer =
        preparation.kind === 'decrypted' ? pendingContainer : null;
      pendingContainer = null;
      if (preparation.kind === 'decrypted') {
        this.activeHttpSource = httpSource;
        httpSource = null;
      }
      this.cryptoService.setTarget(toVerificationTarget(preparation));
      const infos = await this.controller.getPageInfos();
      if (token !== this.openToken || abort.signal.aborted) throw createAbortError();
      this.pageInfos = infos;
      this.buildPages();
      this.patchDocument({
        source: opened.source,
        origin,
        pageCount: opened.pageCount,
        pageInfos: infos,
        status: 'ready',
        signaturesSummary: [],
      });
      const initialIndex = this.layout.indexOfPageNumber(this.options.initialPage);
      const initialScale =
        typeof this.options.initialScale === 'number'
          ? clampScale(this.options.initialScale)
          : this.layout.scaleForMode(
              this.options.initialScale,
              this.measureViewport(),
              initialIndex,
            );
      const initialMode: ZoomMode =
        typeof this.options.initialScale === 'string' ? this.options.initialScale : 'page-actual';
      this.layout.setZoom(initialScale, initialMode);
      this.patchView({
        pageNumber: initialIndex + 1,
        scale: initialScale,
        zoomMode: initialMode,
        rotation: this.options.rotation,
      });
      this.reflow();
      this.scrollToPageInternal(initialIndex, { smooth: false });
      await this.applyAvailability(token);
      this.commit();
      this.emit('documentopen', { pageCount: opened.pageCount });
      // 打开完成即接管正文：全屏遮罩继续展示，遮罩下方同时铺好首屏占位，
      // 首个可见页画完后两者一起撤掉，见 `finishDocumentLoading`。
      this.documentLoading.markOpenComplete();
      this.showLoadingArea();
      this.emit('pagesloaded', { pageCount: opened.pageCount });
      this.renderVisible(true);
      void this.loadSideData(token);
      this.syncHash();
      this.maybeAutoVerify();
      // 首次打开时声明未知，读到这里才知道是否要用本机字体。需要时在本轮收尾处补一次
      // 重开：重开会重建字节源（两次打开不能共享同一个已关闭的源），并恢复阅读位置。
      //
      // 为什么一次「打开」可能发生 3 次 `openDocument`（这是设计选择，不是缺陷）：
      //   ① 首屏打开：声明未知，此时若未授权则无法注入，必须存在这一次；
      //   ② 授权成功后重开：以 granted 状态重新打开，让本机字体参与；
      //   ③ 首屏补注入重开：若首次打开时已授权、或 ② 的重开才读到声明，则在此补一次。
      // 三者语义不同（首屏 / 授权 / 补注入），合并会让时序互相纠缠；重开使用的是已缓存
      // 的本机字体字节，没有网络开销，因此接受这个代价。
      const needsReopen = !this.localFontsReopening && this.controller.needsLocalFontsReopen();
      if (needsReopen) {
        this.localFontsReopening = true;
        try {
          await this.open(this.lastOpenSource ?? resolved);
        } finally {
          this.localFontsReopening = false;
        }
        // 补重开后由内层 `open()` 自己完成权限刷新与授权请求；这里不再重复，也不能提前
        // return——否则「首屏补重开」与「打开后授权」两条路径会互斥。
      } else {
        // 会话被打开：用户授权开关开启但浏览器未授权（或已拒绝）时，文档就绪后立即请求
        // 授权，由浏览器弹出原生授权框；授权结果决定是否重开页面或关闭开关。
        void this.refreshLocalFontsPermission().then(() =>
          this.maybeRequestLocalFontsGrantOnOpen(),
        );
      }
    } catch (error) {
      if (token !== this.openToken) {
        // 已有更新的 open 接管 loading，旧操作只做容器/字节源清理。
        if (pendingContainer) {
          await closeContainer(pendingContainer);
          pendingContainer = null;
        }
        await closeHttpSource(httpSource);
        httpSource = null;
        return;
      }
      if (isAbort(error)) {
        if (pendingContainer) {
          await closeContainer(pendingContainer);
          pendingContainer = null;
        }
        await closeHttpSource(httpSource);
        httpSource = null;
        // 用户取消：立即隐藏全屏 loading，回到空态并清理可能已打开的引擎文档。
        this.documentLoading.cancel();
        this.hideLoadingArea();
        this.queue.cancelAll();
        this.destroyPages();
        await this.controller.close();
        await this.releaseDecryptedContainer();
        await this.releaseSource();
        this.pageInfos = [];
        this.patchDocument({
          status: 'closed',
          source: null,
          origin: undefined,
          pageCount: 0,
          pageInfos: [],
          signaturesSummary: [],
        });
        this.commit();
        return;
      }
      if (isOFDViewerError(error) && error.code === 'OFD_CRYPTO_CANCELLED') {
        await closeHttpSource(httpSource);
        httpSource = null;
        this.documentLoading.cancel();
        this.hideLoadingArea();
        this.patchDocument({
          status: this.controller.isOpen ? 'ready' : 'closed',
          source: previousSource,
          origin: previousOrigin,
        });
        this.commit();
        throw error;
      }
      await closeHttpSource(httpSource);
      httpSource = null;
      const mapped = this.mapOpenFailure(error);
      const info = this.toErrorInfo(mapped, 'OFD_OPEN_FAILED', '打开文档失败');
      this.documentLoading.fail(info);
      this.hideLoadingArea();
      this.patchDocument({ status: 'error', origin: undefined });
      this.reportError(info);
      this.commit();
      throw mapped;
    } finally {
      if (this.openAbort === abort) this.openAbort = null;
    }
  }

  /**
   * 解析本次打开来源。
   *
   * 显式参数与构造参数优先；都省略时读取页面查询参数。查询参数同时包含
   * `file`/`base64` 时由解析函数发出 warning。
   *
   * @param explicit 显式传入的来源。
   * @returns 可用于规范化的来源。
   * @throws {OFDViewerError} `OFD_INVALID_OPTION`：无任何来源或查询参数非法。
   */
  private resolveOpenSource(explicit?: ViewerSource): ViewerSource {
    if (explicit !== undefined) return explicit;
    if (this.options.source !== undefined) return this.options.source;
    const location = this.ownerDocument.defaultView?.location;
    if (location) {
      const fromQuery = readPreviewSourceFromLocation(location, {
        onWarning: (warning) => this.reportWarning(warning),
      });
      if (fromQuery !== null) return fromQuery;
    }
    throw new OFDViewerError(
      'OFD_INVALID_OPTION',
      '未提供文档来源：请传入 source，或使用页面查询参数 ?file= / ?base64= 预览',
    );
  }

  /** 关闭文档，保留阅读器实例。 */
  async close(): Promise<void> {
    if (this.disposed || this.closing) return;
    this.closing = true;
    try {
      this.openToken += 1;
      this.openAbort?.abort();
      this.openAbort = null;
      // 关闭后不能残留全屏 loading / 错误卡 / 首屏占位。
      this.documentLoading.close();
      this.hideLoadingArea();
      this.clearRenderTracking();
      this.queue.cancelAll();
      this.destroyPages();
      await this.controller.close();
      await this.releaseDecryptedContainer();
      await this.releaseSource();
      this.cryptoPreparation = null;
      this.cryptoService.reset();
      this.pageInfos = [];
      this.patchDocument({
        status: 'closed',
        source: null,
        origin: undefined,
        pageCount: 0,
        pageInfos: [],
        signaturesSummary: [],
        metadata: undefined,
        outline: undefined,
        bookmarks: undefined,
      });
      this.patchView({
        pageNumber: 1,
        visiblePageRange: { start: 0, end: -1 },
        selectedText: '',
        findState: {
          ...this.state.view.findState,
          query: '',
          current: 0,
          total: 0,
          searching: false,
        },
      });
      this.commit();
      this.emit('documentclose', {});
    } finally {
      this.closing = false;
    }
  }

  // -------------------------------------------------------------------------
  // 引擎事件与加载归属
  // -------------------------------------------------------------------------

  /**
   * 订阅引擎文档/页面事件。
   *
   * 总线缺失（测试替身或旧引擎）时不订阅，加载计时退回 Promise 驱动。
   */
  private bindEngineEvents(): void {
    const events = this.engineEvents;
    if (!events) return;
    events.on('document:open:start', (event) => this.handleDocumentOpenStart(event));
    events.on('document:open:error', (event) => this.handleDocumentOpenError(event));
    events.on('document:open:abort', (event) => this.handleDocumentOpenAbort(event));
    events.on('document:close:start', () => this.handleDocumentCloseStart());
    events.on('page:render:start', (event) => this.handlePageRenderStart(event));
    events.on('page:render:end', (event) => this.handlePageRenderEnd(event));
    events.on('page:render:error', (event) => this.handlePageRenderError(event));
    events.on('page:render:abort', (event) => this.handlePageRenderAbort(event));
  }

  /**
   * 登记一次即将发起的 `page.render()` 用途。
   *
   * 同步的 `page:render:start` 会消费登记并把 `operationId` 映射到用途；
   * 缩略图视图通过结构化扩展调用，不新增公开事件或配置。
   *
   * @param pageIndex 页索引，0-based。
   * @param purpose 渲染用途：主页面或缩略图。
   * @returns 登记句柄；用于入口抛错或未派发 start 时回滚。
   * @internal
   */
  trackPageRenderStart(pageIndex: number, purpose: PageRenderPurpose): PageRenderStartHandle {
    // 总线缺失时页面视图本就按代次号计时，这里只需返回“未消费”。
    if (!this.engineEvents || pageIndex < 0) return { drop: () => true };
    const pending: PendingPageRenderStart = { pageIndex, purpose };
    const queue = this.pendingStarts.get(pageIndex);
    if (queue) queue.push(pending);
    else this.pendingStarts.set(pageIndex, [pending]);
    return { drop: () => this.dropPendingStart(pageIndex, pending) };
  }

  /**
   * 移除一条尚未消费的用途登记。
   *
   * @returns 移除前该登记是否仍在队列中；true 表示引擎没有派发对应的
   *   `page:render:start`。
   */
  private dropPendingStart(pageIndex: number, pending: PendingPageRenderStart): boolean {
    const queue = this.pendingStarts.get(pageIndex);
    // 队列整体被清理（关闭/销毁）时该登记同样未被消费。
    if (!queue) return true;
    const index = queue.indexOf(pending);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.pendingStarts.delete(pageIndex);
    return true;
  }

  /** 消费指定 `operationId` 的页面操作映射；未登记时返回 null。 */
  private takePageOperation(
    operationId: number,
  ): { readonly purpose: PageRenderPurpose; readonly pageIndex: number } | null {
    const operation = this.pageOperations.get(operationId);
    if (!operation) return null;
    this.pageOperations.delete(operationId);
    return operation;
  }

  /**
   * `document:open:start`：记录打开操作标识。
   *
   * 遮罩计时已在 `open()` 入口启动；这里只登记 operationId 供后续终止事件比对，
   * 不再重置计时，避免字体下载结束后倒计时重新开始。
   */
  private handleDocumentOpenStart(event: DocumentOpenStartEvent): void {
    this.documentOpenOperationId = event.operationId;
  }

  /** `document:open:error`：立即切换全屏错误卡（不等 150ms）。 */
  private handleDocumentOpenError(event: DocumentOpenErrorEvent): void {
    if (event.operationId !== this.documentOpenOperationId) return;
    this.documentLoading.fail(
      this.toErrorInfo(event.error, 'OFD_OPEN_FAILED', '打开文档失败'),
    );
    this.hideLoadingArea();
  }

  /** `document:open:abort`：回空态；若文档已打开但 UI 未完成布局则清理。 */
  private handleDocumentOpenAbort(event: DocumentOpenAbortEvent): void {
    if (event.operationId !== this.documentOpenOperationId) return;
    this.documentLoading.cancel();
    this.hideLoadingArea();
    if (this.controller.isOpen && this.state.document.status === 'opening') {
      void this.close();
    }
  }

  /** `document:close:start`：清理全屏覆盖层、页面计时器与 operation 映射。 */
  private handleDocumentCloseStart(): void {
    this.documentLoading.close();
    this.hideLoadingArea();
    this.clearRenderTracking();
  }

  /** `page:render:start`：消费用途登记，主页面启动 150ms 计时。 */
  private handlePageRenderStart(event: PageRenderStartEvent): void {
    const queue = this.pendingStarts.get(event.pageIndex);
    const pending = queue?.shift();
    if (queue && queue.length === 0) this.pendingStarts.delete(event.pageIndex);
    if (!pending) return;
    this.pageOperations.set(event.operationId, {
      purpose: pending.purpose,
      pageIndex: event.pageIndex,
    });
    if (pending.purpose === 'thumbnail') return;
    this.pageViews[event.pageIndex]?.beginLoading(String(event.operationId));
  }

  /** `page:render:end`：主页面满足最短展示后隐藏；pagerendered 仍等 task.promise。 */
  private handlePageRenderEnd(event: PageRenderEndEvent): void {
    const operation = this.takePageOperation(event.operationId);
    if (!operation || operation.purpose === 'thumbnail') return;
    this.pageViews[operation.pageIndex]?.finishLoading(String(event.operationId));
  }

  /** `page:render:error`：主页面立即隐藏 loading 并显示页内错误卡。 */
  private handlePageRenderError(event: PageRenderErrorEvent): void {
    const operation = this.takePageOperation(event.operationId);
    if (!operation || operation.purpose === 'thumbnail') return;
    const info = this.toErrorInfo(
      event.error,
      'OFD_RENDER_FAILED',
      '页面渲染失败',
      event.pageIndex,
    );
    this.pageViews[operation.pageIndex]?.failLoading(String(event.operationId), info);
  }

  /** `page:render:abort`：主页面静默隐藏 loading，不显示错误。 */
  private handlePageRenderAbort(event: PageRenderAbortEvent): void {
    const operation = this.takePageOperation(event.operationId);
    if (!operation || operation.purpose === 'thumbnail') return;
    this.pageViews[operation.pageIndex]?.cancelLoading(String(event.operationId));
  }

  /** 清理全部页面 loading 计时器、覆盖层与 operation 映射。 */
  private clearRenderTracking(): void {
    this.documentOpenOperationId = 0;
    this.pendingStarts.clear();
    this.pageOperations.clear();
    for (const pageView of this.pageViews) pageView.cancelLoading();
  }

  /** 销毁阅读器，释放 DOM、渲染任务、监听与扩展。 */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.openToken += 1;
    this.openAbort?.abort();
    this.openAbort = null;
    this.documentLoading.destroy();
    this.loadingArea.remove();
    this.clearRenderTracking();
    this.queue.dispose();
    this.destroyPages();
    this.keyboard.destroy();
    this.history?.destroy();
    this.unbindScrollListener();
    this.unbindGestureListeners();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.ownerDocument.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.ownerDocument.removeEventListener('webkitfullscreenchange', this.onFullscreenChange);
    this.ownerDocument.removeEventListener('keydown', this.onFullscreenFallbackEscape);
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    if (this.reflowFrame !== null) cancelAnimationFrame(this.reflowFrame);
    this.cancelSmoothScroll();
    for (const cleanup of this.extensionCleanups.splice(0)) this.safeCleanup(cleanup);
    this.appliedExtensions.clear();
    // 先中止进行中的字体读取，再关闭文档。
    this.controller.dispose();
    void this.controller.close();
    void this.releaseDecryptedContainer();
    void this.releaseSource();
    this.cryptoService.destroy();
    this.root.remove();
    activeViewers.delete(this);
    this.engineEvents?.removeAllListeners();
    this.eventBus.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // 翻页/缩放/旋转
  // -------------------------------------------------------------------------

  /**
   * 跳转到指定页。
   *
   * `smooth` 为真时主区域平滑滚动，时长由 `durationMs` 或滚动距离决定，并被限制在
   * {@link MIN_SMOOTH_SCROLL_MS}..{@link MAX_SMOOTH_SCROLL_MS} 之间；系统要求减少
   * 动效时退化为直接定位。`offsetPx` 用于书签/大纲等「页内定位」场景，让整段跳转
   * 由同一次动画完成，避免两段滚动互相打断。
   *
   * @param pageNumber 页码，1-based。
   * @param options 滚动选项。
   */
  goToPage(
    pageNumber: number,
    options: { smooth?: boolean; durationMs?: number; offsetPx?: number } = {},
  ): void {
    this.assertFeature('pageNavigation');
    this.assertOpen();
    const index = this.toIndex(pageNumber);
    this.scrollToPageInternal(index, options);
    this.patchView({ pageNumber: index + 1 });
    this.commit();
    this.renderVisible();
    this.syncHash();
  }

  /** 下一页。 */
  nextPage(): void {
    this.assertFeature('pageNavigation');
    const next = this.state.view.pageNumber + 1;
    if (next <= this.state.document.pageCount) this.goToPage(next);
  }

  /** 上一页。 */
  previousPage(): void {
    this.assertFeature('pageNavigation');
    const previous = this.state.view.pageNumber - 1;
    if (previous >= 1) this.goToPage(previous);
  }

  /** 第一页。 */
  firstPage(): void {
    this.goToPage(1);
  }

  /** 最后一页。 */
  lastPage(): void {
    this.goToPage(Math.max(1, this.state.document.pageCount));
  }

  /**
   * 设置实际缩放倍率。
   *
   * @param scale 倍率，限制在 {@link MIN_SCALE}..{@link MAX_SCALE}（25%..2500%）。
   */
  setScale(scale: number): void {
    this.assertFeature('zoom');
    this.applyScale(clampScale(scale), this.state.view.zoomMode);
  }

  /**
   * 设置缩放模式。
   *
   * @param mode 缩放模式。
   */
  setZoomMode(mode: ZoomMode): void {
    this.assertFeature('zoom');
    const index = this.toIndex(this.state.view.pageNumber);
    const scale = this.layout.scaleForMode(mode, this.measureViewport(), index);
    this.applyScale(scale, mode);
  }

  /** 放大到下一个预置档位。 */
  zoomIn(): void {
    this.assertFeature('zoom');
    const current = this.state.view.scale;
    const next = ZOOM_LEVELS.find((level) => level > current + 0.001) ?? MAX_SCALE;
    this.setScale(next);
  }

  /** 缩小到上一个预置档位；已到最低档位时保持不动。 */
  zoomOut(): void {
    this.assertFeature('zoom');
    const current = this.state.view.scale;
    const next = [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001);
    if (next === undefined || next < MIN_SCALE) return;
    this.setScale(next);
  }

  /** 重置为适合宽度。 */
  resetZoom(): void {
    this.setZoomMode('auto');
  }

  /**
   * 设置旋转角度，顺时针。
   *
   * @param rotation 0/90/180/270。
   */
  setRotation(rotation: Rotation): void {
    this.assertFeature('rotate');
    const normalized = normalizeRotation(rotation);
    if (normalized === this.state.view.rotation) return;
    const previous = this.state.view.rotation;
    const anchor = this.captureAnchor();
    this.layout.setRotation(normalized);
    this.patchView({ rotation: normalized });
    this.reflow(anchor);
    this.emit('rotationchanging', { rotation: normalized, previous });
    this.cancelAllPageTasks();
    this.renderVisible(true);
    this.commit();
    this.syncHash();
  }

  /** 顺时针旋转 90°。 */
  rotateClockwise(): void {
    this.setRotation(((this.state.view.rotation + 90) % 360) as Rotation);
  }

  /** 逆时针旋转 90°。 */
  rotateCounterClockwise(): void {
    this.setRotation(((this.state.view.rotation + 270) % 360) as Rotation);
  }

  // -------------------------------------------------------------------------
  // 侧栏/全屏/主题
  // -------------------------------------------------------------------------

  /** 打开指定侧栏。 */
  openSidebar(view: SidebarView): void {
    this.assertFeature('sidebar');
    if (view === 'thumbnails') this.assertFeature('thumbnails');
    else if (view === 'outline') this.assertFeature('outline');
    else if (view === 'bookmarks') this.assertFeature('bookmarks');
    else if (view === 'signatures') this.assertFeature('signatures');
    else if (view === 'attachments') this.assertFeature('attachments');
    this.patchView({ sidebarView: view });
    this.updateSidebarVisibility();
    this.emit('sidebarviewchanged', { view });
    this.commit();
  }

  /** 关闭侧栏。 */
  closeSidebar(): void {
    if (this.state.view.sidebarView === null) return;
    this.patchView({ sidebarView: null });
    this.updateSidebarVisibility();
    this.emit('sidebarviewchanged', { view: null });
    this.commit();
  }

  /** 切换侧栏。 */
  toggleSidebar(): void {
    this.assertFeature('sidebar');
    if (this.state.view.sidebarView !== null) {
      this.closeSidebar();
      return;
    }
    const first = (
      ['thumbnails', 'outline', 'bookmarks', 'signatures', 'attachments'] as const
    ).find(
      (view) => this.featureGate.isEnabled(view) && this.featureGate.isVisible(view),
    );
    if (first) this.openSidebar(first);
  }

  /**
   * 读取当前全屏元素；优先标准属性，缺失时回退 `webkitFullscreenElement`。
   *
   * @returns 全屏元素；未全屏时为 null。
   */
  private getFullscreenElement(): Element | null {
    const doc = this.ownerDocument as Document & PrefixedFullscreenAccess;
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  /**
   * 解析原生全屏请求方法；标准 API 缺失时回退 `webkitRequestFullscreen`。
   *
   * @returns 已绑定根节点的请求方法；原生全屏不可用时为 null。
   */
  private getFullscreenRequestMethod(): (() => Promise<void> | void) | null {
    if (!this.isFullscreenEnabled()) return null;
    const root = this.root as HTMLElement & PrefixedFullscreenAccess;
    const request =
      (root as { requestFullscreen?: unknown }).requestFullscreen ?? root.webkitRequestFullscreen;
    return typeof request === 'function'
      ? (request as () => Promise<void> | void).bind(root)
      : null;
  }

  /**
   * 判断原生全屏是否可用；标准属性缺失时回退 `webkitFullscreenEnabled`。
   *
   * @returns 可用时 true；显式关闭时 false。
   */
  private isFullscreenEnabled(): boolean {
    const doc = this.ownerDocument as Document & PrefixedFullscreenAccess;
    if (doc.fullscreenEnabled === false) return false;
    if (doc.fullscreenEnabled === true) return true;
    return doc.webkitFullscreenEnabled !== false;
  }

  /**
   * 退出原生全屏；标准 API 缺失时回退 `webkitExitFullscreen`。
   */
  private async exitFullscreen(): Promise<void> {
    const doc = this.ownerDocument as Document & PrefixedFullscreenAccess;
    const exit = (doc as { exitFullscreen?: unknown }).exitFullscreen ?? doc.webkitExitFullscreen;
    if (typeof exit === 'function') await (exit as () => Promise<void> | void).call(doc);
  }

  /**
   * 进入/退出全屏。
   *
   * 主路径仍是无前缀 Fullscreen API；Chrome 67 只有 `webkit` 前缀实现，
   * 两者都不可用时使用沉浸式回退，不抛错。
   *
   * @param value 是否全屏。
   */
  async setFullscreen(value: boolean): Promise<void> {
    this.assertFeature('fullscreen');
    const request = this.getFullscreenRequestMethod();
    if (value && !request) {
      this.applyFullscreenFallback(true);
      this.warn(UI_WARNING_CODES.W_FULLSCREEN_FALLBACK, '当前环境不支持原生全屏，已使用沉浸式回退');
      return;
    }
    try {
      if (value) {
        if (this.getFullscreenElement() !== this.root) {
          await request!();
        }
        this.applyFullscreenFallback(false);
      } else {
        if (this.getFullscreenElement()) {
          await this.exitFullscreen();
        }
        this.applyFullscreenFallback(false);
      }
      this.patchView({ fullscreen: value });
      this.commit();
    } catch (error) {
      if (value) {
        this.applyFullscreenFallback(true);
        this.warn(
          UI_WARNING_CODES.W_FULLSCREEN_FALLBACK,
          `原生全屏失败，已使用沉浸式回退：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      this.reportError(this.toErrorInfo(error, 'OFD_UNSUPPORTED', '退出全屏失败'));
    }
  }

  /** 切换全屏。 */
  toggleFullscreen(): void {
    void this.setFullscreen(!this.state.view.fullscreen);
  }

  /**
   * 切换 position:fixed 沉浸式回退样式。
   *
   * @param enabled 是否启用回退。
   */
  private applyFullscreenFallback(enabled: boolean): void {
    this.root.classList.toggle('ofd-viewer--fullscreen-fallback', enabled);
    this.root.dataset.fullscreenFallback = enabled ? 'true' : 'false';
    if (enabled) {
      this.patchView({ fullscreen: true });
      this.commit();
    }
  }

  /**
   * 打开内置 UI 对话框。
   *
   * @param options 对话框内容；需要内置 UI 已挂载。
   * @returns 对话框元素。
   * @throws {OFDViewerError} 未挂载内置 UI 时抛 `OFD_UNSUPPORTED`。
   */
  showDialog(options: UIDialogOptions): HTMLElement {
    const shell = getUIShell(this);
    if (!shell) {
      throw new OFDViewerError('OFD_UNSUPPORTED', '内置 UI 未挂载，无法打开对话框');
    }
    return shell.openDialog(options);
  }

  /**
   * 关闭内置 UI 当前对话框。
   *
   * @param restoreFocus 是否把焦点还给触发元素；默认 true。
   */
  closeDialog(restoreFocus = true): void {
    getUIShell(this)?.closeDialog(restoreFocus);
  }

  // -------------------------------------------------------------------------
  // 本地字体（本地字体加载方案设计 §3.5 / §4，需求清单 REQ-0220 ~ REQ-0270）
  // -------------------------------------------------------------------------

  /**
   * 读取本地字体状态。
   *
   * 只做纯查询（能力探测 + 权限状态），**不触发**任何权限申请：页面加载路径调用它
   * 不应产生浏览器授权框或 `SecurityError` 噪音。
   *
   * @returns 当前状态快照。
   */
  getLocalFontsStatus(): LocalFontsStatus {
    return this.computeLocalFontsStatus();
  }

  /**
   * 设置「使用本机字体」开关。
   *
   * **开关即用户意向**，浏览器授权是它的前置条件。调用后：
   * - `enabled=true`：先申请授权；**授权成功才重载文档**，失败则开关回到关、不重载；
   * - `enabled=false`：立即置关并重载文档（切回宿主字体），不涉及授权。
   *
   * 必须在用户点击事件的同步栈内调用（浏览器只接受手势内的权限申请）。
   *
   * @param enabled 目标开关值。
   */
  async setLocalFontsEnabled(enabled: boolean): Promise<void> {
    this.assertNotDisposed();
    await this.applyLocalFontsWanted(enabled);
  }

  /**
   * 通过内置对话框请求本机字体授权。
   *
   * 浏览器只接受**用户手势内**的 `local-fonts` 权限申请：页面自动打开时调用
   * `queryLocalFonts` 会抛 `SecurityError` 且不弹授权框，导致「开关想开、浏览器却没授权」
   * 的不一致状态长期存在。此时由内置 UI 弹出确认框，用户点「允许」的 `click` 回调里再走
   * `setLocalFontsEnabled(true)`，授权申请因此带上真实手势。
   *
   * 只在能力可见（宿主启用）且浏览器确实支持时使用；未挂载内置 UI 时返回 false。
   *
   * @returns 用户是否在对话框中点了「允许」。
   */
  async confirmLocalFontsGrant(): Promise<boolean> {
    this.assertNotDisposed();
    if (!this.localFontsSupported() || !this.hasLocalFontsConfig()) return false;
    const shell = getUIShell(this);
    if (!shell) return false;
    return askLocalFontsGrant(shell, this);
  }

  /**
   * 订阅本地字体状态变化。
   *
   * @param handler 状态回调。
   * @returns 退订函数；重复订阅互不影响。
   */
  onLocalFontsStatusChange(handler: (status: LocalFontsStatus) => void): () => void {
    this.localFontsListeners.add(handler);
    return () => {
      this.localFontsListeners.delete(handler);
    };
  }

  /**
   * 计算当前状态；不申请权限、不发起查询。
   *
   * `supported` 只表示**浏览器是否提供 Local Font Access API**；它不再混入「宿主是否
   * 启用配置」，否则宿主未配置时会被误报成「浏览器不支持」，把用户的排查方向带偏。
   * 能力是否整体生效由 `visible`（宿主显式启用）与 `supported` 共同决定，设置面板按
   * 两者分别给出原因文案。
   */
  private computeLocalFontsStatus(): LocalFontsStatus {
    const supported = this.localFontsSupported();
    const available = supported && this.hasLocalFontsConfig();
    // 开关状态与授权状态严格同步：**两者同时为真才算「开」**。
    // 用户拒绝、尚未决定、或浏览器撤销授权时，开关一律显示为关。
    const enabled = available && this.localFontsWanted && this.localFontsPermission === 'granted';
    return {
      supported,
      enabled,
      userState: this.localFontsUserState(),
      permission: available ? this.localFontsPermission : 'unsupported',
      visible: available,
      loading: this.localFontsLoading,
    };
  }

  /**
   * 计算用户授权开关状态。
   *
   * @returns 已表态且为开时 `on`；已表态且为关时 `off`；尚未表态时 `undecided`。
   */
  private localFontsUserState(): LocalFontsUserState {
    if (!this.localFontsDecided) return 'undecided';
    return this.localFontsWanted ? 'on' : 'off';
  }

  /** 宿主是否显式启用了本地字体能力（`fonts.localFonts.enabled === true`）。 */
  private hasLocalFontsConfig(): boolean {
    return this.options.fonts?.localFonts?.enabled === true;
  }

  /**
   * 初始化用户意向。
   *
   * 优先级：持久化的用户选择 > `fonts.localFonts.defaultEnabled`。
   * 只设置意向，不申请授权、不改变 DOM——授权由 `open()` 后的流程推进。
   */
  private initLocalFontsWanted(): void {
    const options = this.options.fonts?.localFonts;
    if (!options || options.enabled !== true) {
      this.localFontsWanted = false;
      return;
    }
    const stored = options.remember === false ? undefined : readLocalFontsPreference();
    this.localFontsWanted = stored ? stored.enabled : options.defaultEnabled === true;
    // 有持久化记录说明用户表过态；否则由宿主默认值打开的开关视为已表态。
    this.localFontsDecided = stored !== undefined || options.defaultEnabled === true;
  }

  /** 浏览器是否提供 `queryLocalFonts`；不依赖 UA 判断。 */
  private localFontsSupported(): boolean {
    return supportsLocalFonts();
  }

  /**
   * 刷新权限态（纯查询，不申请权限）。
   *
   * 每次打开文档后调用，让开关显示与浏览器实际授权保持一致：用户可能在站点设置里
   * 改了权限，或在别的标签页撤销了授权。不做否定结果缓存（需求清单 C12）。
   */
  private async refreshLocalFontsPermission(): Promise<void> {
    if (!this.localFontsSupported()) {
      this.localFontsPermission = 'unsupported';
      this.publishLocalFontsStatus();
      return;
    }
    this.localFontsPermission = await queryLocalFontsPermission();
    // 浏览器撤销授权后，用户意向不应把我们骗成「开」——由 computeLocalFontsStatus
    // 的 `wanted && granted` 判断自动收敛，这里只需把状态广播出去。
    this.publishLocalFontsStatus();
  }

  /**
   * 应用用户授权开关。
   *
   * 开启方向：先申请授权，**授权成功才重开页面**；失败则开关回到关且不重开。
   * 关闭方向：立即置关并切回宿主字体，不涉及授权。
   *
   * @param enabled 目标开关值（用户意向）。
   */
  private async applyLocalFontsWanted(enabled: boolean): Promise<void> {
    this.localFontsDecided = true;
    if (!enabled) {
      // 关闭：只改意向与缓存，**不重载文档**。
      //
      // 重载会把已解析的字体全部丢弃再重新渲染，而本机字体一旦不注入，文档里依赖它的
      // 文字就会逐条产生 `W_FONT_MISSING`（「字体 N 未加载，已跳过文字」），出现刷屏。
      // 关闭开关的语义是「以后不再使用本机字体」：当前画面保留已渲染结果，下次打开
      // 文档时才真正按新意向走宿主字体。
      this.localFontsWanted = false;
      this.persistLocalFontsWanted(false);
      if (this.resolveLocalFontsMaxFonts() !== undefined) this.syncLocalFontsToController();
      this.publishLocalFontsStatus();
      return;
    }
    // 开启：记录意向并立即申请授权（必须在用户手势栈内）。
    this.localFontsWanted = true;
    this.persistLocalFontsWanted(true);
    await this.expandLocalFontsAccess();
  }

  /**
   * 发起浏览器授权申请，并按授权结果收敛用户授权开关。
   *
   * 两条入口共用：open() 后自动请求（仅限用户已表态开启时）、用户点击开关或确认框授权。
   * 调用点必须在用户点击事件的同步栈内，浏览器只接受手势内的权限申请。
   */
  private async expandLocalFontsAccess(): Promise<void> {
    if (!this.localFontsSupported()) return;
    this.localFontsLoading = true;
    this.publishLocalFontsStatus();
    // 候选名优先用文档声明的字体名（展开成 PostScript 写法，设计 §1.3）；声明为空时由
    // 查询层退化为固定的常见中文字体名——目的只是触发浏览器授权框。
    const declarations = this.controller.getDocumentFontDeclarations();
    const names = this.localFontCandidatesForGrant(declarations);
    // 必须同步进入权限申请，不能先 await，否则会被挪出手势栈。
    const permission = await requestLocalFontsGrant(names);
    this.localFontsLoading = false;
    if (permission === 'granted') {
      // 授权成功：开关变为开，重开页面让本机字体真正注入。
      this.localFontsPermission = 'granted';
      this.localFontsWanted = true;
      this.localFontsDecided = true;
      this.persistLocalFontsWanted(true);
      this.syncLocalFontsToController();
      this.publishLocalFontsStatus();
      await this.reopenForLocalFonts();
      return;
    }
    // 授权被拒绝（含浏览器早已拒绝、不会再次弹框的情形）：用户授权开关置关并持久化，
    // 不做任何其它操作——不重开页面、不回退已渲染内容。
    if (permission !== 'unsupported') this.localFontsPermission = permission;
    this.localFontsWanted = false;
    this.localFontsDecided = true;
    this.persistLocalFontsWanted(false);
    this.syncLocalFontsToController();
    this.publishLocalFontsStatus();
  }

  /**
   * 构造用于触发授权框的候选名。
   *
   * 浏览器只在首次真正调用 `queryLocalFonts` 时弹授权框；调用参数本身不影响授权结果。
   * 因此这里优先用文档声明的真实字体名（命中率最高），文档未打开/声明为空时交给查询层
   * 退化为一组常见中文字体名，保证「点授权 → 一定能触发授权」不被文档状态阻断。
   *
   * @param declarations 当前文档的字体声明。
   * @returns 候选 PostScript 名数组；可能为空，由查询层补退化清单。
   */
  private localFontCandidatesForGrant(
    declarations: readonly DocumentFontResource[],
  ): readonly string[] {
    for (const declaration of declarations) {
      const names = this.localFontCandidates(declaration);
      if (names.length > 0) return names;
    }
    return [];
  }

  /**
   * 读取宿主任配置的 `maxFonts`。
   *
   * @returns 配置值；能力未配置时 undefined。
   */
  private resolveLocalFontsMaxFonts(): number | undefined {
    const options = this.options.fonts?.localFonts;
    if (!options || options.enabled !== true) return undefined;
    return options.maxFonts ?? 8;
  }

  /**
   * 持久化用户意向。
   *
   * 只写一个布尔值，不含任何字体信息；`remember === false` 或存储不可用时静默忽略。
   *
   * @param wanted 用户意向。
   */
  private persistLocalFontsWanted(wanted: boolean): void {
    if (this.options.fonts?.localFonts?.remember === false) return;
    writeLocalFontsPreference({ enabled: wanted, notified: true });
  }

  /**
   * 会话被打开（文档就绪）后处理「用户想用本机字体，但浏览器尚未授权」的不一致状态。
   *
   * - 浏览器不支持或宿主未启用：不处理；
   * - 用户已明确拒绝（开关关闭）：尊重选择，不打扰；
   * - 授权状态与意向一致（授权成功，或用户自己关掉了开关）：无需处理；
   * - 其余情况（浏览器未决定、或浏览器已拒绝但用户仍希望使用）：**不能**直接调用
   *   `queryLocalFonts`——页面自动打开时没有用户手势，浏览器会抛 `SecurityError` 且不弹
   *   授权框。改为弹内置确认框，用户点「允许」后再在该点击的手势内申请授权；用户按
   *   「不允许」则什么都不做，本会话不再追问。
   */
  private maybeRequestLocalFontsGrantOnOpen(): void {
    if (!this.localFontsSupported() || !this.hasLocalFontsConfig()) return;
    if (this.localFontsDecided && !this.localFontsWanted) return;
    if (this.localFontsPermission === 'granted' && this.localFontsWanted) return;
    // 本次打开已经问过（含用户点了「不允许」）：不重复追问。
    if (this.localFontsGrantAsked) return;
    this.localFontsGrantAsked = true;
    void this.confirmLocalFontsGrant();
  }

  /**
   * 把一个文档声明展开为候选 PostScript 名。
   *
   * 别名组与 `fonts.aliases` 合并后交给 `expandLocalFontCandidates()`，与重开时
   * resolver 使用的候选口径一致；截断到单声明上限（6）。
   *
   * @param declaration 文档字体声明。
   * @returns 候选名列表；无法展开时为空数组。
   */
  private localFontCandidates(declaration: {
    readonly fontName: string;
    readonly familyName?: string;
    readonly bold?: boolean;
    readonly italic?: boolean;
  }): readonly string[] {
    const expanded = expandLocalFontCandidates(
      declaration,
      composeFontAliases(this.options.fonts?.aliases),
    );
    return expanded.names.slice(0, MAX_CANDIDATES_PER_DECLARATION);
  }

  /**
   * 把当前生效的本机字体配置同步给文档控制器。
   *
   * 控制器据此决定是否按文档声明生成 `{ local }` 来源；开关变化、权限变化与每次打开
   * 文档前都必须调用，否则注入开关会停留在旧值（REQ-007 / REQ-0180）。
   */
  /**
   * 打开文档前刷新权限态，并把生效值同步给控制器。
   *
   * 权限查询是异步的，必须在 `open()` 真正打开文档之前完成。
   */
  private async prepareLocalFontsForOpen(): Promise<void> {
    // 每次打开都重新查询权限：用户可能在站点设置里改过，或别的标签页撤销了授权。
    await this.refreshLocalFontsPermissionQuietly();
    this.syncLocalFontsToController();
  }

  /**
   * 查询权限态但不广播状态（打开前的准备阶段用）。
   *
   * 打开流程尚未完成，此时广播会让 UI 闪一次中间态；打开结束后的
   * `refreshLocalFontsPermission()` 会统一广播。
   */
  private async refreshLocalFontsPermissionQuietly(): Promise<void> {
    if (!this.localFontsSupported()) {
      this.localFontsPermission = 'unsupported';
      return;
    }
    this.localFontsPermission = await queryLocalFontsPermission();
  }

  /**
   * 把生效值同步给文档控制器。
   *
   * 只有「用户意向为开且浏览器已授权」才真正读取本机字体：权限未授予时发起查询必然
   * 失败，也会让「未授权」与「未安装」无法区分（设计 §1.1 / §6.3）。
   */
  private syncLocalFontsToController(): void {
    const maxFonts = this.options.fonts?.localFonts?.maxFonts ?? 8;
    const effective = this.localFontsWanted && this.localFontsPermission === 'granted';
    this.controller.setLocalFonts({ enabled: effective, maxFonts });
  }

  /** 开关/授权变化后重开当前文档并恢复视图；失败只上报，不改开关。 */
  private async reopenForLocalFonts(): Promise<void> {
    const source = this.lastOpenSource;
    if (!source) return;
    const view = this.state.view;
    const snapshot = {
      pageNumber: view.pageNumber,
      scale: view.scale,
      zoomMode: view.zoomMode,
      rotation: view.rotation,
      sidebarView: view.sidebarView,
    };
    try {
      await this.open(source);
      // 重开后恢复阅读位置：页码按 1-based 钳到有效范围。
      const pageCount = this.state.document.pageCount;
      const pageNumber = Math.min(Math.max(1, snapshot.pageNumber), Math.max(1, pageCount));
      if (pageNumber !== this.state.view.pageNumber) this.goToPage(pageNumber);
      // 缩放恢复：以重开前的实测倍率为准。`setZoomMode()` 会按视口重新计算倍率，
      // 先 setScale 再 setZoomMode 会把用户倍率冲掉；因此只有在倍率本来就一致时才
      // 恢复模式，否则直接用 `page-actual` 固定回用户倍率（REQ-0250）。
      if (Math.abs(this.state.view.scale - snapshot.scale) > 1e-6) {
        this.setScale(snapshot.scale);
        if (this.state.view.zoomMode !== 'page-actual') this.setZoomMode('page-actual');
        this.setScale(snapshot.scale);
      } else if (this.state.view.zoomMode !== snapshot.zoomMode) {
        this.setZoomMode(snapshot.zoomMode);
      }
      if (this.state.view.rotation !== snapshot.rotation) this.setRotation(snapshot.rotation);
      if (this.state.view.sidebarView !== snapshot.sidebarView) {
        if (snapshot.sidebarView === null) this.closeSidebar();
        else this.openSidebar(snapshot.sidebarView);
      }
    } catch (error) {
      if (isAbort(error)) return;
      this.reportError(
        this.toErrorInfo(error, 'OFD_OPEN_FAILED', '切换本机字体后重开文档失败'),
      );
    }
  }

  /** 广播本地字体状态：一次变化只触发一次外部通知。 */
  private publishLocalFontsStatus(): void {
    const status = this.computeLocalFontsStatus();
    const previous = this.localFontsPublished;
    if (
      previous &&
      previous.supported === status.supported &&
      previous.enabled === status.enabled &&
      previous.permission === status.permission &&
      previous.visible === status.visible &&
      previous.loading === status.loading
    ) {
      return;
    }
    this.localFontsPublished = status;
    this.emit('local-fonts:change', status);
    for (const listener of [...this.localFontsListeners]) {
      try {
        listener(status);
      } catch (error) {
        this.warn(
          UI_WARNING_CODES.W_UI_LISTENER,
          `本地字体状态监听器抛出异常：${String(error)}`,
        );
      }
    }
  }

  /**
   * 设置主题。
   *
   * @param theme light/dark/auto。
   */
  setTheme(theme: Theme): void {
    this.root.dataset.theme = theme;
    this.patchUI({ theme });
    this.commit();
  }

  /**
   * 设置语言。
   *
   * @param locale 语言标签。
   */
  setLocale(locale: string): void {
    this.root.lang = locale;
    this.patchUI({ locale });
    this.translator = createTranslator(locale);
    this.documentLoading.setLocale(this.translator.locale);
    if (this.loadingAreaText) this.loadingAreaText.textContent = this.translator.t('loading.page');
    for (const pageView of this.pageViews) pageView.setTranslator(this.translator);
    this.commit();
  }

  // -------------------------------------------------------------------------
  // 功能开关
  // -------------------------------------------------------------------------

  /**
   * 合并功能开关补丁；运行时立即生效。
   *
   * @param patch 功能补丁。
   * @param options 可选展示方式。
   */
  setFeatures(
    patch: ViewerFeatures,
    options: { display?: FeatureDisplay } = {},
  ): void {
    const states = this.featureGate.setFeatures(patch, options);
    this.patchUI({ features: cloneFeatureStates(states) });
    this.applyFeatureStates();
    this.emit('featureschange', cloneFeatureStates(states));
    this.commit();
  }

  /**
   * 设置功能展示方式。
   *
   * @param display 展示方式。
   */
  setFeatureDisplay(display: FeatureDisplay): void {
    const states = this.featureGate.setDisplay(display);
    this.patchUI({ features: cloneFeatureStates(states) });
    this.applyFeatureStates();
    this.emit('featureschange', cloneFeatureStates(states));
    this.commit();
  }

  // -------------------------------------------------------------------------
  // 文本/查找/选区（服务扩展）
  // -------------------------------------------------------------------------

  /**
   * 执行查找。
   *
   * @param query 查询文本。
   * @param options 查找选项。
   */
  async find(query: string, options: FindOptions = {}): Promise<void> {
    this.assertFeature('find');
    const service = this.requireService('find', '查找控制器');
    const result = service.find(query, options);
    if (isPromiseLike(result)) await result;
  }

  /** 下一个匹配。 */
  async findNext(): Promise<void> {
    this.assertFeature('find');
    const service = this.requireService('find', '查找控制器');
    if (!service.findNext) throw new OFDViewerError('OFD_UNSUPPORTED', '查找控制器不支持 findNext');
    await service.findNext();
  }

  /** 上一个匹配。 */
  async findPrevious(): Promise<void> {
    this.assertFeature('find');
    const service = this.requireService('find', '查找控制器');
    if (!service.findPrevious) throw new OFDViewerError('OFD_UNSUPPORTED', '查找控制器不支持 findPrevious');
    await service.findPrevious();
  }

  /** 清除查找。 */
  clearFind(): void {
    this.assertFeature('find');
    this.requireService('find', '查找控制器').clearFind?.();
    this.patchView({ findState: { ...this.state.view.findState, query: '', current: 0, total: 0, searching: false } });
    this.commit();
  }

  /** 读取当前选区文本。 */
  getSelectedText(): string {
    this.assertFeature('selection');
    return this.services.find?.getSelectedText?.() ?? this.state.view.selectedText;
  }

  /** 复制当前选区。 */
  async copySelection(): Promise<void> {
    this.assertFeature('selection');
    const service = this.services.find;
    if (service?.copySelection) {
      await service.copySelection();
      return;
    }
    const text = this.getSelectedText();
    if (!text) return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      throw new OFDViewerError('OFD_CLIPBOARD_FAILED', '当前环境不支持剪贴板');
    }
    await clipboard.writeText(text);
  }

  /** 清除选区。 */
  clearSelection(): void {
    this.assertFeature('selection');
    this.services.find?.clearSelection?.();
    this.patchView({ selectedText: '' });
    this.commit();
  }

  // -------------------------------------------------------------------------
  // 签章/打印/导出（服务扩展）
  // -------------------------------------------------------------------------

  /**
   * 重新验证当前文档。
   *
   * @param options 签名筛选与取消信号。
   * @returns 验证报告。
   * @throws {OFDViewerError} 功能关闭、未打开或验证失败时。
   */
  async verify(options: CryptoVerifyOptions = {}): Promise<VerificationReport> {
    this.assertNotDisposed();
    this.assertFeature('verification');
    if (!this.cryptoService.isEnabled) {
      throw new OFDViewerError('OFD_CRYPTO_UNSUPPORTED', this.cryptoService.strings.cryptoDisabled);
    }
    this.assertOpen();
    const report = await this.cryptoService.verify(options);
    this.emit('verificationcompleted', report);
    try {
      this.options.crypto?.onVerification?.(report);
    } catch (error) {
      this.warn(
        UI_WARNING_CODES.W_CRYPTO_VERIFICATION_CALLBACK,
        `验证完成回调抛出异常：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return report;
  }

  /**
   * 当前文档最近一次验证报告。
   *
   * @returns 报告；未验证或文档已关闭时为 undefined。
   */
  getVerificationReport(): VerificationReport | undefined {
    return this.cryptoService.getReport();
  }

  /**
   * 设置/替换信任根并重新验证当前文档。
   *
   * 证书内容无效时按 warning 跳过，可返回空数组；仅密码能力关闭、
   * path/filePath loader 失败等入口错误抛出 `OFDViewerError`。
   *
   * @param roots 根证书来源。
   * @returns 成功解析的证书摘要；全部无效时为空数组。
   * @throws {OFDViewerError} 密码能力关闭或 path/filePath loader 失败时。
   */
  async setRootCertificates(
    roots: readonly CertificateSource[],
  ): Promise<readonly CertificateSummary[]> {
    this.assertNotDisposed();
    if (!this.cryptoService.isEnabled) {
      throw new OFDViewerError('OFD_CRYPTO_UNSUPPORTED', this.cryptoService.strings.cryptoDisabled);
    }
    const summaries = await this.cryptoService.setRoots(roots);
    if (this.controller.isOpen && this.featureGate.isEnabled('verification')) {
      try {
        await this.verify();
      } catch (error) {
        this.warn(
          UI_WARNING_CODES.W_CRYPTO_VERIFY_FAILED,
          `重新验证失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return summaries;
  }

  /**
   * 当前信任根证书摘要。
   *
   * @returns 证书摘要列表；未配置时为空。
   */
  getRootCertificates(): readonly CertificateSummary[] {
    return this.cryptoService.getRoots();
  }

  /**
   * 打开工具栏验证面板。
   *
   * @throws {OFDViewerError} 功能关闭、密码能力关闭或内置 UI 未挂载时。
   */
  openVerificationPanel(): void {
    this.assertNotDisposed();
    this.assertFeature('verification');
    this.cryptoService.openPanel();
  }

  /** 当前签章摘要；未打开时为空。 */
  getSignatures(): readonly SignatureEntryInfo[] {
    this.assertFeature('signatures');
    return this.state.document.signaturesSummary;
  }

  /**
   * 读取签章详情。
   *
   * @param id 签章 ID。
   */
  async getSignatureDetail(id: string): Promise<SignatureDetail> {
    this.assertFeature('signatures');
    const service = this.requireService('signature', '签章服务');
    if (!service.getSignatureDetail) {
      throw new OFDViewerError('OFD_UNSUPPORTED', '签章服务不支持详情读取');
    }
    return service.getSignatureDetail(id);
  }

  /**
   * 打开/定位签章。
   *
   * @param id 签章 ID。
   */
  async showSignature(id: string): Promise<void> {
    this.assertFeature('signatures');
    const service = this.requireService('signature', '签章服务');
    await service.showSignature?.(id);
  }

  /**
   * 聚焦签章；当前实现与 `showSignature` 一致，后续可扩展详情面板定位。
   *
   * @param id 签章 ID。
   */
  async focusSignature(id: string): Promise<void> {
    await this.showSignature(id);
  }

  /**
   * 打印。
   *
   * @param options 打印选项。
   */
  async print(options: PrintOptions = {}): Promise<void> {
    this.assertFeature('print');
    const service = this.requireService('print', '打印服务');
    await service.print(options);
  }

  /**
   * 导出单页图片。
   *
   * @param options 导出选项。
   * @returns 导出结果。
   */
  async exportImage(options: ExportImageOptions = {}): Promise<ExportImageResult> {
    this.assertFeature('export');
    const service = this.requireService('export', '导出服务');
    return service.exportImage(options);
  }

  /**
   * 导出多页图片。
   *
   * @param options 导出选项。
   */
  async exportImages(options: ExportImagesOptions = {}): Promise<void> {
    this.assertFeature('export');
    const service = this.requireService('export', '导出服务');
    await service.exportImages(options);
  }

  /**
   * 导出当前 OFD 原文件（加密文档导出原始加密包）。
   *
   * @param options 文件名与取消信号。
   * @returns 原文件 Blob、文件名与字节数。
   */
  async exportOfd(options: ExportOfdOptions = {}): Promise<ExportOfdResult> {
    this.assertFeature('export');
    const service = this.requireService('export', '导出服务');
    return service.exportOfd(options);
  }

  /**
   * 读取当前文档原始字节；供导出服务与宿主复用。
   *
   * 与 `exportOfd()` 使用同一门控：`export` 功能关闭或文档禁止导出时拒绝。
   *
   * @param signal 取消信号。
   * @returns 原始 OFD 字节；未打开时拒绝。
   * @throws {OFDViewerError} `export` 不可用抛 `OFD_FEATURE_DISABLED`；未打开抛 `OFD_NOT_OPENED`。
   */
  async readSourceBytes(signal?: AbortSignal): Promise<Uint8Array> {
    this.assertFeature('export');
    const permissions = await this.getPermissions().catch(() => null);
    if (permissions?.export === false) {
      throw createFeatureDisabledError('export', '当前文档不允许导出');
    }
    const source = this.lastOpenSource ?? this.options.source;
    if (source !== undefined && source !== null) {
      return readViewerSourceBytes(source, this.options.requestInit, signal);
    }
    const normalized = this.controller.source;
    if (normalized) return readOFDSourceBytes(normalized);
    throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开，无法导出原文件');
  }

  // -------------------------------------------------------------------------
  // 扩展挂载
  // -------------------------------------------------------------------------

  /**
   * 挂载查找控制器。
   *
   * @param service 查找服务。
   * @returns 卸载函数。
   */
  attachFindController(service: ViewerFindService): () => void {
    return this.attachService('find', service);
  }

  /**
   * 挂载文本层服务。
   *
   * @param service 文本层服务。
   * @returns 卸载函数。
   */
  attachTextLayerService(service: ViewerTextLayerService): () => void {
    return this.attachService('textLayer', service);
  }

  /**
   * 挂载签章服务。
   *
   * @param service 签章服务。
   * @returns 卸载函数。
   */
  attachSignatureService(service: ViewerSignatureService): () => void {
    return this.attachService('signature', service);
  }

  /**
   * 挂载打印服务。
   *
   * @param service 打印服务。
   * @returns 卸载函数。
   */
  attachPrintService(service: ViewerPrintService): () => void {
    return this.attachService('print', service);
  }

  /**
   * 挂载导出服务。
   *
   * @param service 导出服务。
   * @returns 卸载函数。
   */
  attachExportService(service: ViewerExportService): () => void {
    return this.attachService('export', service);
  }

  /** 内部：应用扩展；供 registerViewerExtension 调用。 */
  applyExtension(extension: ViewerExtension): void {
    if (this.disposed || this.appliedExtensions.has(extension)) return;
    this.appliedExtensions.add(extension);
    try {
      const cleanup = extension(this);
      if (typeof cleanup === 'function') this.extensionCleanups.push(cleanup);
    } catch (error) {
      this.reportError(this.toErrorInfo(error, 'OFD_UNSUPPORTED', '扩展初始化失败'));
    }
  }

  // -------------------------------------------------------------------------
  // 内部：DOM/排版/渲染
  // -------------------------------------------------------------------------

  /** 建立页壳并挂载全部页视图。 */
  private buildPages(): void {
    this.destroyPages();
    this.layout.setPageInfos(this.pageInfos);
    const total = this.pageInfos.length;
    for (let index = 0; index < total; index += 1) {
      const info = this.pageInfos[index]!;
      const pageView = new PageView({
        pageNumber: index + 1,
        pageIndex: index,
        pageInfo: info,
        totalPages: total,
        ownerDocument: this.ownerDocument,
        translator: this.translator,
        eventDrivenLoading: this.engineEvents !== null,
        onRetry: (pageNumber) => this.renderPage(pageNumber - 1, true),
      });
      this.pageViews.push(pageView);
      this.pagesElement.appendChild(pageView.element);
    }
    this.reflow();
    this.applyFeatureStates();
  }

  /** 全屏 loading 的“取消”：中止本次打开并立即隐藏遮罩。 */
  private cancelDocumentOpen(): void {
    this.documentLoading.cancel();
    this.hideLoadingArea();
    this.openAbort?.abort();
  }

  /** 全屏错误卡的“重试”：用最近一次来源重新打开。 */
  private retryOpen(): void {
    const source = this.lastOpenSource ?? this.options.source;
    void this.open(source).catch(() => {
      // 重试失败已切换到全屏错误卡，这里只吞掉 rejection。
    });
  }

  /** 销毁全部页视图。 */
  private destroyPages(): void {
    for (const pageView of this.pageViews) pageView.destroy();
    this.pageViews.length = 0;
    this.renderOrder.length = 0;
    replaceChildren(this.pagesElement);
    this.pagesElement.style.width = '0px';
    this.pagesElement.style.height = '0px';
  }

  /**
   * 写入文档级缩放变量：页盒宽高由 CSS 按 96 DPI 单位尺寸换算，一次样式计算全部生效。
   *
   * 页面容器同时挂上该变量，兼容未使用变量、仍靠内联尺寸的旧页面实现。
   *
   * @param scale 实际缩放倍率。
   */
  private applyScaleVariable(scale: number): void {
    this.root.style.setProperty('--ofd-scale', String(scale));
    this.pagesElement.style.setProperty('--ofd-scale', String(scale));
    for (const pageView of this.pageViews) pageView.setScaleVariable(scale);
  }

  /**
   * 按锚点内容一次性重设滚动位置（纵向与横向）。
   *
   * 内容不足一屏时滚动位置只能是 0，页面在窗口里居中；否则让锚点内容停在原来的
   * 可视位置。只写一次滚动位置，不再二次修正。
   *
   * @param point 缩放锚点内容。
   * @param offset 锚点内容相对可视窗口顶部的偏移，单位 px。
   */
  private anchorScrollTo(point: ContentPoint, offset: number): void {
    const fits = this.layout.totalHeight <= this.viewportHeight() + 1;
    this.mainScrollTop = fits
      ? 0
      : this.layout.offsetForContentPoint(point) - offset + this.unusedScrollTop;
    this.mainScrollLeftAnchored(point);
  }

  /** 重新排版并更新页定位；可恢复滚动锚点。 */
  private reflow(anchor?: ScrollAnchor): void {
    // 排版变化会让原目标偏移失效，平滑滚动必须先中断。
    this.cancelSmoothScroll();
    const boxes = this.layout.getBoxes();
    this.pagesElement.style.height = `${Math.max(0, this.layout.totalHeight)}px`;
    // 内容比可视区窄时页面水平居中：偏移按当前可视宽度算出并逐页写入左缘；内容比可视区
    // 宽时为 0，此时能看到哪一段由横向滚动位置决定。
    const viewportWidth = this.viewportWidth();
    const offsetLeft = this.layout.centeredOffset(viewportWidth);
    // 页盒是绝对定位，不参与容器的尺寸计算；容器宽度必须显式写出，否则会收缩到 0，
    // 横向滚动范围与内容宽度对不上。内容窄于可视区时取可视宽度，避免多出 15px 的
    // 滚动条槽位撑出无意义的横向滚动。
    this.pagesElement.style.width = `${this.layout.snapToDevicePixel(
      Math.max(this.layout.totalWidth, viewportWidth),
    )}px`;
    const devicePixelRatio = this.devicePixelRatio();
    for (let index = 0; index < this.pageViews.length; index += 1) {
      const box = boxes[index];
      if (!box) continue;
      this.pageViews[index]!.setLayout({
        box,
        rotation: this.state.view.rotation,
        scale: this.state.view.scale,
        offsetLeft,
        devicePixelRatio,
      });
    }
    if (anchor) {
      this.mainScrollTop = this.layout.getOffsetForAnchor(anchor);
    }
    // 纸面尺寸与布局倍率刚写入，同步刷新文字层与查找高亮层：二者的布局框按“纸面尺寸
    // / 布局倍率”换算、再以 scale 放大，必须与 canvas 在同一次样式计算里完成，否则
    // 文字层会晚画布一帧，缩放提交瞬间出现文字错位闪动。
    this.services.textLayer?.refresh?.();
    this.scheduleScrollUpdate();
  }

  /** 主区域滚动位置。 */
  private get mainScrollTop(): number {
    return this.elements.main.scrollTop;
  }

  private set mainScrollTop(value: number) {
    // 浏览器只保留整数 scrollTop；向上取整避免小数页顶被截断后落回上一页。
    const applied = toIntegerScrollTop(value);
    // 与 pdf.js `#panPosition` 同理：记录被截断的亚像素余量，下一次写入补上，避免连续
    // 缩放/平移时内容逐帧向同一方向漂移。
    this.unusedScrollTop = value - applied;
    this.elements.main.scrollTop = applied;
  }

  /** 主区域横向滚动位置，单位 px。 */
  private get mainScrollLeft(): number {
    return this.elements.main.scrollLeft;
  }

  /**
   * 页面在横向上的“居中偏移”：内容比可视区窄时，页面水平居中，左边缘的屏幕位置。
   *
   * 内容坐标 = 设备像素坐标 − 居中偏移：缩放锚点按它换算，页面在窄、宽之间切换时也
   * 不会往左上角跳。
   *
   * @returns 居中偏移，单位 px；内容比可视区宽时为 0。
   */
  private contentLeft(): number {
    return this.layout.centeredOffset(this.viewportWidth());
  }

  /**
   * 横向当前可滚动到的最大值，单位 px。
   *
   * 内容宽度按“可视宽度 × 预览倍率”估算：预览尚未提交时布局宽度仍是旧的，直接用
   * scrollLeftMax 会把还在合成层的横向位移丢掉。
   *
   * @returns 可滚动最大值，单位 px。
   */
  private get mainScrollLeftMax(): number {
    const main = this.elements.main;
    return Math.max(0, main.scrollWidth - main.clientWidth);
  }

  /**
   * 应用缩放并保持画面中心不动。
   *
   * 以画面中心（主区域可视区域正中）对应的内容为锚点：缩放前求出该内容在当前布局中的
   * 坐标，缩放后按新布局换回滚动位置，使中心处的内容停在原地。画面中心本身也不会贴
   * 近可滚动区域的上下边界，因此内容被边缘夹住、缩放时内容漂移的概率远低于页顶锚点。
   *
   * @param nextScale 目标倍率。
   * @param zoomMode 缩放模式。
   * @param anchor 内容锚点；省略时取当前画面中心。
   */
  private applyScale(
    nextScale: number,
    zoomMode: ZoomMode,
    anchor?: ContentPoint,
    anchorOffset?: number,
  ): void {
    if (Math.abs(nextScale - this.state.view.scale) < 0.0001) {
      if (zoomMode !== this.state.view.zoomMode) {
        this.patchView({ zoomMode });
        this.commit();
      }
      return;
    }
    const previous = this.state.view.scale;
    const previousRenderScale = this.effectiveRenderScale();
    const viewportHeight = this.viewportHeight();
    const locked = anchor === undefined ? this.pinnedZoomAnchor : null;
    const point = anchor ?? locked ?? this.captureViewportCenter();
    // 锚点内容相对可视窗口顶部的偏移：缩放前后它停在同一视觉位置。桌面端的滚轮、
    // 按钮、双击都固定为窗口中心；移动端两指捏合固定为两指中点。
    const offset = Math.min(
      Math.max(0, anchorOffset ?? (locked ? this.pinnedZoomAnchorOffset : viewportHeight / 2)),
      viewportHeight,
    );
    if (anchor !== undefined) this.pinnedZoomAnchor = null;
    this.patchView({ scale: nextScale, zoomMode });
    this.layout.setZoom(nextScale, zoomMode);
    // 与 pdf.js `#setScaleUpdatePages()` 同序：先改缩放变量让所有页盒在同一帧按新尺寸
    // 排版，再按“锚点内容坐标 − 锚点偏移”一次性重设滚动位置，最后才安排重绘。
    this.applyScaleVariable(nextScale);
    this.reflow();
    this.anchorScrollTo(point, offset);
    this.updateScrollState();
    this.emit('scalechanging', { scale: nextScale, zoomMode, previous });
    this.renderAfterScaleChange(previousRenderScale);
    this.commit();
    this.syncHash();
  }

  /**
   * 把倍率按两位小数取整，并把取整误差结转到下一次缩放（与 pdf.js `_accumulateFactor`
   * 等价）。
   *
   * 连续小幅缩放时若每次都截断到两位小数，误差会逐次累积、表现为“滚很多下几乎不放大”；
   * 这里把未用尽的余量记下来，下一格补上。
   *
   * @param currentScale 当前倍率。
   * @param factor 本格缩放比。
   * @returns 取整后的目标倍率（不夹取到上下限，由调用方决定）。
   */
  private accumulateScale(currentScale: number, factor: number): number {
    if (!Number.isFinite(factor) || factor <= 0) return currentScale;
    const target = clampScale(currentScale * factor * this.unusedScaleFactor);
    const rounded = Math.round(target * 100) / 100;
    this.unusedScaleFactor = rounded > 0 ? target / rounded : 1;
    return rounded;
  }

  /**
   * 平移画面（与 pdf.js 的 `panBy` 等价）：正数表示内容向左上移动。
   *
   * 纵向与横向直接写滚动位置；已被内容边界夹住的余量留在手势里，松手后不再二次补偿。
   *
   * @param dx 水平位移，单位 px；正数把内容向左推。
   * @param dy 竖直位移，单位 px；正数把内容向上推。
   */
  private panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.elements.main.scrollLeft = this.mainScrollLeft + dx;
    this.mainScrollTop = this.mainScrollTop + dy;
    this.updateScrollState();
  }

  /**
   * 保持锚点内容的横向位置：它相对可视窗口左缘的水平偏移在缩放前后不变。
   *
   * 页面水平居中（内容窄于可视区）时没有横向滚动：缩放后依然居中；内容宽于可视区时
   * 按“锚点内容横向坐标 − 它的可视区偏移”求滚动位置。
   *
   * @param point 缩放锚点内容（含横向坐标）。
   */
  private mainScrollLeftAnchored(point: ContentPoint): void {
    const main = this.elements.main;
    const margin = this.layout.centeredOffset(this.viewportWidth());
    if (this.layout.totalWidth <= this.viewportWidth()) {
      // 内容窄于可视区：页面靠居中偏移摆放，没有横向滚动可言。
      main.scrollLeft = 0;
      return;
    }
    // 内容比可视区宽时页面左缘已经滚到可视区外（居中偏移为 0），锚点内容的屏幕位置
    // 由“内容坐标 − 滚动位置”决定，反解出滚动位置即可让锚点内容停在原处。锚点里记录的
    // 横向坐标是缩放前的值，先按内容宽度比换算到当前布局。
    const anchorX = this.layout.leftForContentPoint(point);
    const target = Math.max(0, anchorX + margin - this.anchorClientX);
    main.scrollLeft = target;
    if (Math.abs(main.scrollLeft - target) > 0.5) {
      void main.offsetWidth;
      main.scrollLeft = target;
    }
  }

  /**
   * 缩放提交后按有效渲染倍率决定重绘范围。
   *
   * 有效渲染倍率不变（缩放仍低于最低渲染倍率）时只更新页盒 CSS 尺寸，不取消
   * 任务、不重绘，避免小图反复重绘导致闪烁和 loading。
   *
   * @param previousRenderScale 缩放前的有效渲染倍率。
   */
  private renderAfterScaleChange(previousRenderScale: number): void {
    if (Math.abs(this.effectiveRenderScale() - previousRenderScale) > 0.0001) {
      this.cancelAllPageTasks();
      this.renderVisible(true);
      return;
    }
    this.renderVisible();
  }

  /**
   * 指针相对主区域内容顶部的偏移。
   *
   * @param clientY 指针在视口中的 y 坐标，单位 px。
   * @returns 相对主区域可视顶部的偏移，单位 px。
   */
  private pointerOffsetY(clientY: number): number {
    const rect = this.elements.main.getBoundingClientRect();
    const height = rect.height > 0 ? rect.height : this.measureViewport().height;
    return Math.min(Math.max(0, clientY - rect.top), height);
  }

  /** 捕获当前滚动锚点。 */
  private captureAnchor(): ScrollAnchor {
    return this.layout.getAnchor(this.mainScrollTop);
  }


  /**
   * 滚动到指定页；保留页顶。
   *
   * @param index 页索引，0-based。
   * @param options 滚动选项。
   */
  private scrollToPageInternal(
    index: number,
    options: { smooth?: boolean; durationMs?: number; offsetPx?: number },
  ): void {
    const offset = options.offsetPx;
    const usable = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
    this.scrollToOffsetInternal(this.layout.getPageTop(index) + usable, options);
  }

  /**
   * 滚动到主区域内的指定偏移；越界值由浏览器钳制。
   *
   * `smooth` 为真时用自实现的 rAF 补间：WebKit 不支持 `scrollTo` 的时长参数，
   * 原生平滑滚动也常超过 400ms；自实现可固定结束时间，并在用户滚动、缩放或
   * 新跳转时立即打断。
   *
   * @param top 目标滚动位置，单位 px。
   * @param options 滚动选项。
   */
  private scrollToOffsetInternal(
    top: number,
    options: { smooth?: boolean; durationMs?: number },
  ): void {
    const target = toIntegerScrollTop(top);
    const animate = options.smooth === true && !this.prefersReducedMotion();
    this.cancelSmoothScroll();
    if (!animate) {
      this.mainScrollTop = target;
      // 直接定位没有后续帧：在这里同步刷新页码与可见范围，避免状态滞后一帧。
      this.handleScroll();
      return;
    }
    const start = this.mainScrollTop;
    const distance = target - start;
    if (Math.abs(distance) < 1) {
      this.mainScrollTop = target;
      return;
    }
    this.smoothScroll = {
      start,
      target,
      startedAt: undefined,
      duration: resolveSmoothScrollDuration(options.durationMs, Math.abs(distance)),
    };
    this.smoothScrollFrame = requestAnimationFrame(this.stepSmoothScroll);
  }

  /**
   * 推进一帧平滑滚动。
   *
   * @param now `requestAnimationFrame` 回调时间戳，单位毫秒。
   */
  private readonly stepSmoothScroll = (now: number): void => {
    this.smoothScrollFrame = null;
    const scroll = this.smoothScroll;
    if (!scroll) return;
    if (scroll.startedAt === undefined) scroll.startedAt = now;
    const progress = Math.min(1, Math.max(0, (now - scroll.startedAt) / scroll.duration));
    // 二次缓出：起步快、收尾稳，短距离也不会显得迟滞。
    const eased = 1 - (1 - progress) * (1 - progress);
    this.mainScrollTop =
      progress >= 1 ? scroll.target : scroll.start + (scroll.target - scroll.start) * eased;
    if (progress >= 1) this.smoothScroll = null;
    else this.smoothScrollFrame = requestAnimationFrame(this.stepSmoothScroll);
    // 每帧都刷新页码/可见范围：动画途经的页要及时进入渲染队列，不能只等 scroll 事件。
    this.scheduleScrollUpdate();
  };

  /**
   * 立即中断平滑滚动并停在中途位置。
   *
   * 用户滚轮/触控接管、缩放旋转重排、新跳转、文档关闭与销毁都调用它。
   */
  private cancelSmoothScroll(): void {
    if (this.smoothScrollFrame !== null) {
      cancelAnimationFrame(this.smoothScrollFrame);
      this.smoothScrollFrame = null;
    }
    this.smoothScroll = null;
  }

  /** 当前环境是否要求减少动效。 */
  private prefersReducedMotion(): boolean {
    const view = this.ownerDocument.defaultView ?? window;
    if (!view || typeof view.matchMedia !== 'function') return false;
    try {
      return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /** 计算当前可见页并调度渲染。 */
  private renderVisible(force = false): void {
    if (this.pageViews.length === 0) return;
    const viewportHeight = this.measureViewport().height;
    const range = this.layout.getVisibleRange(this.mainScrollTop, viewportHeight, 1);
    const visible = this.layout.getVisibleRange(this.mainScrollTop, viewportHeight, 0);
    this.lastVisibleRange = visible;
    this.patchView({ visiblePageRange: visible });
    const wanted = new Set<number>();
    for (let index = range.start; index <= range.end; index += 1) wanted.add(index);
    for (let index = 0; index < this.pageViews.length; index += 1) {
      this.pageViews[index]!.setCurrent(index >= visible.start && index <= visible.end);
    }
    this.queue.cancelWhere((task) => task.key.startsWith('page:') && !wanted.has(task.pageIndex));
    for (let index = range.start; index <= range.end; index += 1) {
      const priority = index >= visible.start && index <= visible.end ? 0 : 1;
      this.renderPage(index, force, priority);
    }
    // 视口内没有任何可渲染页时，页内骨架不会出现，全屏 loading 直接收尾。
    if (range.start > range.end) this.finishDocumentLoading();
    this.trimCache();
  }

  /** 调度单页渲染。 */
  private renderPage(index: number, force: boolean, priority = 0): void {
    const pageView = this.pageViews[index];
    if (!pageView || pageView.isDestroyed) return;
    const renderScale = this.effectiveRenderScale();
    const key = this.renderKey(renderScale);
    if (!force && pageView.renderedKey === key) return;
    // 屏幕外预渲染页不跟随缩小降低渲染 DPI：直接复用已画好的 canvas，
    // 避免一次缩小触发所有缓存页以低质量重绘。
    const offscreen = index < this.lastVisibleRange.start || index > this.lastVisibleRange.end;
    if (!force && offscreen && pageView.renderedScale > renderScale) return;
    const generation = pageView.beginRender(key, renderScale);
    this.queue.enqueue({
      key: `page:${index}`,
      pageIndex: index,
      priority,
      generation,
      run: async (signal) => {
        const page = await this.controller.getPage(index);
        if (signal.aborted) throw createAbortError();
        // 高倍率下单页画布可能大到浏览器无法分配：按 CANVAS_RETRY_PIXEL_STEPS
        // 逐级收紧像素上限后重试，宁可牺牲清晰度也不要让整页渲染失败。
        const budget = Math.max(1, this.options.maxCanvasPixels);
        const { context, size, degraded } = this.prepareCanvasWithinBudget(
          page,
          pageView,
          generation,
          renderScale,
          budget,
        );
        if (!context) throw new OFDViewerError('OFD_UNSUPPORTED', '当前环境不支持 Canvas 2D');
        if (degraded) {
          this.warn(
            UI_WARNING_CODES.W_CANVAS_LIMIT,
            `页面像素超过上限，已降低渲染 DPI 至 ${Math.round(size.dpi)}。`,
            index + 1,
          );
        }
        pageView.markRendering(generation);
        const viewport = page.getViewport({ dpi: size.dpi });
        const pending = this.trackPageRenderStart(index, 'main');
        let task: ReturnType<EnginePage['render']>;
        try {
          task = page.render({
            canvasContext: context,
            viewport,
            signal,
          });
        } catch (error) {
          pending.drop();
          throw error;
        }
        // 引擎未派发 start（测试替身或旧引擎）时退回 beginRender 的代次号计时，
        // 否则该页 spinner 永远没有启动源。
        if (pending.drop()) pageView.beginLoading(String(generation));
        await task.promise;
        if (signal.aborted) throw createAbortError();
        pageView.completeRender(generation, key);
        this.markRendered(index);
        this.finishDocumentLoading();
        this.emit('pagerendered', {
          pageNumber: index + 1,
          scale: this.state.view.scale,
          rotation: this.state.view.rotation,
        });
      },
      onError: (error) => {
        if (isAbort(error)) {
          pageView.cancelRender(generation);
          return;
        }
        const info = this.toErrorInfo(error, 'OFD_RENDER_FAILED', '页面渲染失败', index);
        pageView.failRender(generation, info);
        this.reportError(info);
        // 可见页渲染失败时错误卡已覆盖该页，全屏 loading 不能再压在上面。
        if (this.isVisiblePage(index)) this.finishDocumentLoading();
      },
      onCancel: () => pageView.cancelRender(generation),
    });
  }

  /**
   * 当前设备像素比。
   *
   * 非浏览器环境或非法值回退 1。
   */
  private devicePixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  }

  /**
   * 最低渲染倍率。
   *
   * 画布后备尺寸不低于页面 100% CSS 尺寸的 `min(dpr, 2)` 倍，即低于该倍率时
   * 不再按显示倍率重绘，只由 CSS 缩小画布。下限只由 DPR 决定，窗口尺寸变化
   * 不会改变它。
   */
  private minRenderScale(): number {
    return Math.min(1, MAX_CANVAS_BASE_DPR / this.devicePixelRatio());
  }

  /**
   * 当前有效渲染倍率：显示倍率与最低渲染倍率取大，再乘以可选的超采样倍率。
   *
   * 默认超采样为 1，即按设备像素比 1:1 渲染：画布后备像素与屏幕物理像素一一对应，
   * 既最锐利也不做多余的像素填充。超采样（>1）由宿主显式开启，代价是画布像素数
   * 按平方增长。
   */
  private effectiveRenderScale(): number {
    return Math.max(this.state.view.scale, this.minRenderScale()) * this.supersampleFactor();
  }

  /**
   * 当前超采样倍率。
   *
   * 显式配置时直接使用；`auto` 时按最大页在屏幕上的设备像素面积分档——低倍率文字小、
   * 最需要清晰度，取 2 倍超采样；面积变大后依次降到 1.5 与 1 倍，避免高倍率下画布像素
   * 数按倍率平方膨胀。移动端固定 1，优先保流畅。
   *
   * @returns 超采样倍率，取值 1..4。
   */
  private supersampleFactor(): number {
    const configured = this.options.supersample;
    if (configured !== 'auto') return configured;
    if (this.mobileDevice) return 1;
    const dpr = this.devicePixelRatio();
    const scale = this.state.view.scale;
    // 不超采样时的后备比例 = 基础渲染倍率 × DPR ÷ 显示倍率（每 CSS 像素的后备像素数）。
    const base = Math.max(scale, this.minRenderScale());
    const currentRatio = (base * dpr) / scale;
    // 目标比例按页面设备像素面积分档：面积小（文字小）时补到 2 倍，面积大时逐步回落到 1。
    const deviceScale = base * dpr;
    const area = this.layout.maxPageUnitArea * deviceScale * deviceScale;
    const targetRatio =
      area <= SUPERSAMPLE_FULL_AREA
        ? SUPERSAMPLE_MAX
        : area <= SUPERSAMPLE_HALF_AREA
          ? SUPERSAMPLE_MID
          : 1;
    // 已有后备比例够用时不再额外超采样，避免低倍率下把下限倍率再乘一遍。
    return Math.min(4, Math.max(1, targetRatio / currentRatio));
  }

  /**
   * 在像素预算内为一次渲染准备 canvas；分配失败时按 {@link CANVAS_RETRY_PIXEL_STEPS}
   * 逐级收紧预算重试。
   *
   * @param page 引擎页。
   * @param pageView 页视图。
   * @param generation 渲染代次号。
   * @param renderScale 有效渲染倍率。
   * @param budget 初始像素预算（width × height）。
   * @returns 渲染上下文、最终尺寸，以及是否因超限而降级。
   */
  private prepareCanvasWithinBudget(
    page: EnginePage,
    pageView: PageView,
    generation: number,
    renderScale: number,
    budget: number,
  ): {
    context: CanvasRenderingContext2D | null;
    size: { width: number; height: number; dpi: number };
    degraded: boolean;
  } {
    const idealDpi = 96 * renderScale * this.devicePixelRatio();
    let size = this.computeCanvasSize(page, renderScale, budget);
    let context = pageView.prepareCanvas(size.width, size.height, generation);
    for (const step of CANVAS_RETRY_PIXEL_STEPS) {
      if (context || step >= 1) break;
      size = this.computeCanvasSize(page, renderScale, budget * step);
      context = pageView.prepareCanvas(size.width, size.height, generation);
    }
    // 只有“没拿到期望 DPI”才算降级：正常页面的像素数本来就可能小于预算，
    // 用尺寸和预算比较会误报。
    return { context, size, degraded: size.dpi < idealDpi - 0.5 };
  }

  /**
   * 计算 canvas 设备像素与受上限约束的 DPI。
   *
   * @param page 引擎页。
   * @param renderScale 有效渲染倍率。
   * @param maxPixelsOverride 临时像素上限（分配失败后重试时逐级收紧）；省略时取选项值。
   */
  private computeCanvasSize(
    page: EnginePage,
    renderScale: number,
    maxPixelsOverride?: number,
  ): { width: number; height: number; dpi: number } {
    const dpr = this.devicePixelRatio();
    let dpi = 96 * renderScale * dpr;
    const maxPixels = Math.max(1, maxPixelsOverride ?? this.options.maxCanvasPixels);
    const maxSide = 32767;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const viewport = page.getViewport({ dpi });
      if (
        viewport.width <= maxSide &&
        viewport.height <= maxSide &&
        viewport.width * viewport.height <= maxPixels
      ) {
        return {
          // 必须向上取整：引擎要求画布不小于 viewport，少 1px 会直接报
          // OFD_CANVAS_SIZE_MISMATCH。多出的不足 1px 由 CSS 缩放吸收，不影响清晰度。
          width: Math.max(1, Math.ceil(viewport.width)),
          height: Math.max(1, Math.ceil(viewport.height)),
          dpi,
        };
      }
      dpi *= 0.75;
    }
    const viewport = page.getViewport({ dpi });
    this.warn(
      UI_WARNING_CODES.W_CANVAS_LIMIT,
      `页面像素超过上限，已降低渲染 DPI 至 ${Math.round(dpi)}。`,
    );
    return {
      width: Math.max(1, Math.ceil(viewport.width)),
      height: Math.max(1, Math.ceil(viewport.height)),
      dpi,
    };
  }

  /**
   * 当前渲染参数键。
   *
   * @param renderScale 有效渲染倍率；省略时按当前状态计算。
   */
  private renderKey(renderScale = this.effectiveRenderScale()): string {
    return `${renderScale.toFixed(4)}:${this.state.view.rotation}:${this.devicePixelRatio()}`;
  }

  /** 记录已渲染页并裁剪 LRU。 */
  private markRendered(index: number): void {
    const position = this.renderOrder.indexOf(index);
    if (position >= 0) this.renderOrder.splice(position, 1);
    this.renderOrder.push(index);
    this.trimCache();
  }

  /**
   * 结束全屏 loading 与正文首屏占位。
   *
   * 结束点是「首个可见页渲染完成」而非文档打开完成：两者之间通常还包含字体下载与
   * 首屏绘制，这段时间必须继续由加载态覆盖，否则页面表现为空白。
   */
  private finishDocumentLoading(): void {
    this.documentLoading.finish();
    this.hideLoadingArea();
  }

  /**
   * 补建首屏加载占位。
   *
   * 外壳允许传入自定义 `elements`（含缺失元素），此时按需创建并挂到正文区末尾。
   *
   * @returns 新建的占位元素。
   */
  private createLoadingArea(): HTMLElement {
    const area = this.ownerDocument.createElement('div');
    area.className = 'ofd-viewer__loading-area';
    // 外层已由全屏 loading 的 aria-live 播报状态，占位只做视觉呈现，不再重复播报。
    this.elements.main.appendChild(area);
    return area;
  }

  /**
   * 显示首屏加载占位：文档已打开但首个可见页还没画完。
   *
   * 占位在全屏遮罩之下，遮罩淡出的同时即可见，用户看到的是「全屏遮罩 → 正文区骨架」，
   * 不会先看到空白正文。
   */
  private showLoadingArea(): void {
    if (this.loadingAreaVisible) return;
    this.loadingAreaVisible = true;
    if (this.loadingArea.childElementCount === 0) {
      this.loadingAreaText = this.createLoadingAreaText();
      this.loadingArea.append(
        this.createLoadingAreaSkeleton(),
        this.createLoadingAreaSpinner(),
        this.loadingAreaText,
      );
    }
    this.loadingArea.hidden = false;
  }

  /**
   * 创建占位骨架块。
   *
   * @returns 骨架元素。
   */
  private createLoadingAreaSkeleton(): HTMLElement {
    const skeleton = this.ownerDocument.createElement('div');
    skeleton.className = 'ofd-viewer__loading-area-skeleton';
    return skeleton;
  }

  /**
   * 创建占位 spinner。
   *
   * @returns 复用页内 loading 的 spinner 样式。
   */
  private createLoadingAreaSpinner(): HTMLElement {
    const spinner = this.ownerDocument.createElement('div');
    spinner.className = 'ofd-page__loading-spinner';
    return spinner;
  }

  /**
   * 创建占位文案。
   *
   * @returns 文案元素。
   */
  private createLoadingAreaText(): HTMLElement {
    const text = this.ownerDocument.createElement('p');
    text.className = 'ofd-viewer__loading-area-text';
    text.textContent = this.translator.t('loading.page');
    return text;
  }

  /** 立即隐藏首屏加载占位。 */
  private hideLoadingArea(): void {
    if (!this.loadingAreaVisible) return;
    this.loadingAreaVisible = false;
    this.loadingArea.hidden = true;
  }

  /**
   * 页索引是否落在当前可见页范围内。
   *
   * @param index 页索引，0-based。
   * @returns 可见时 true。
   */
  private isVisiblePage(index: number): boolean {
    return index >= this.lastVisibleRange.start && index <= this.lastVisibleRange.end;
  }

  /**
   * 释放超出缓存数量或超出总像素预算且不可见的 canvas。
   *
   * 高倍率下单页画布可达上百 MP，仅按页数裁剪会让内存迅速膨胀；这里同时对已渲染
   * 页的总像素计数，超预算时先释放离可见区最远的页。
   */
  private trimCache(): void {
    const visible = this.lastVisibleRange;
    const budget = Math.max(1, this.options.pageCachePixelBudget);
    while (this.renderOrder.length > this.options.pageCacheSize) {
      const index = this.renderOrder.find(
        (candidate) => candidate < visible.start || candidate > visible.end,
      );
      if (index === undefined) return;
      this.releaseCachedPage(index);
    }
    let total = this.renderedPixelTotal();
    // 只释放不可见页，可见页即使超预算也必须保留，否则滚动时会反复重绘。
    while (total > budget) {
      const index = this.renderOrder.find(
        (candidate) => candidate < visible.start || candidate > visible.end,
      );
      if (index === undefined) return;
      total -= this.releaseCachedPage(index);
    }
  }

  /**
   * 释放指定页的 canvas 并从缓存顺序中移除。
   *
   * @param index 页索引，0-based。
   * @returns 该页释放的像素数（width × height）。
   */
  private releaseCachedPage(index: number): number {
    const pageView = this.pageViews[index];
    const pixels = pageView ? pageView.canvasPixelCount : 0;
    pageView?.releaseCanvas();
    const position = this.renderOrder.indexOf(index);
    if (position >= 0) this.renderOrder.splice(position, 1);
    return pixels;
  }

  /** 已渲染页 canvas 的总像素数（width × height 之和）。 */
  private renderedPixelTotal(): number {
    let total = 0;
    for (const index of this.renderOrder) {
      total += this.pageViews[index]?.canvasPixelCount ?? 0;
    }
    return total;
  }

  /** 取消全部页渲染任务。 */
  private cancelAllPageTasks(): void {
    this.queue.cancelWhere((task) => task.key.startsWith('page:'));
  }

  /** 按当前滚动位置更新页码/可见范围。 */
  private scheduleScrollUpdate(): void {
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.handleScroll();
    });
  }

  /** 按当前滚动位置立即更新页码/可见范围。 */
  private updateScrollState(): void {
    if (this.pageViews.length === 0) return;
    const scrollTop = this.mainScrollTop;
    const pageIndex = this.layout.getPageAtOffset(scrollTop);
    const pageNumber = pageIndex + 1;
    if (pageNumber !== this.state.view.pageNumber) {
      const previous = this.state.view.pageNumber;
      this.patchView({ pageNumber, scrollTop });
      this.emit('pagechanging', { pageNumber, previous });
    } else {
      this.patchView({ scrollTop });
    }
    this.patchView({
      visiblePageRange: this.layout.getVisibleRange(scrollTop, this.viewportHeight(), 0),
    });
  }

  /** 处理滚动。 */
  private handleScroll(): void {
    if (this.pageViews.length === 0) return;
    // 手动写入滚动位置后浏览器（含 jsdom）会同步回抛 scroll 事件：位置与状态一致时
    // 说明是自身写入的回声，跳过即可，否则会用手势中途的位置覆盖锚点换算结果。
    if (Math.abs(this.mainScrollTop - this.state.view.scrollTop) < 0.5) return;
    this.updateScrollState();
    this.renderVisible();
    this.commit();
    this.syncHash();
  }

  /**
   * 主区域可视宽度。
   *
   * @returns 宽度，单位 px。
   */
  private viewportWidth(): number {
    // 取 clientWidth 而非 rect.width：后者含滚动条槽位（`scrollbar-gutter: stable` 下
    // 即使没有滚动条也保留），用它当内容宽度会多撑出 15px 的横向滚动。
    const width =
      this.elements.main.clientWidth ||
      this.elements.main.getBoundingClientRect().width;
    return width > 0 ? width : this.measureViewport().width;
  }

  /** 主区域可视窗口左上角的视口坐标，单位 px。 */
  private viewportTop(): number {
    return this.elements.main.getBoundingClientRect().top;
  }

  /** 主区域可视窗口左边缘的视口坐标，单位 px。 */
  private viewportLeft(): number {
    return this.elements.main.getBoundingClientRect().left;
  }

  /**
   * 预览中缩放的几何参数：内容倍率与滚动位置的部分兑现。
   *
   * 预览只对页盒做合成层缩放，页间距与留白不跟着变；放大后的内容在屏幕上的长度与
   * 提交后不同，若完全不改滚动位置，下一屏内容会在预览期间铺满可视区。这里按比例
   * 估算预览中可视内容的长度，滚动位置在预览里就兑现到目标位置，提交时画面连续。
   *
   * @param base 未缩放的布局倍率。
   * @returns 预览几何。
   */
  private previewGeometry(base: number): { ratio: number; scale: number } {
    const scale = this.state.view.scale;
    return { ratio: scale / base, scale };
  }

  /**
   * 视口坐标在“预览画面”里对应的内容坐标。
   *
   * 预览中页盒有合成层缩放与位移，直接用滚动位置换算会偏；这里先扣掉页盒在屏幕上的
   * 缩放/位移，换算回布局坐标，再定位到内容。
   *
   * @param clientX 视口 x 坐标，单位 px。
   * @param clientY 视口 y 坐标，单位 px。
   * @param geometry 当前预览几何。
   * @returns 内容锚点。
   */
  private contentPointAtPreviewOffset(
    clientX: number,
    clientY: number,
    geometry: { ratio: number },
  ): ContentPoint {
    void clientX;
    const offsetY = this.pointerOffsetY(clientY);
    const box = this.layout.getBox(this.layout.getPageAtOffset(this.mainScrollTop + offsetY));
    if (!box || box.height <= 0 || geometry.ratio === 1) {
      return this.layout.contentPointAt(this.mainScrollTop + offsetY);
    }
    // 页盒以自身中心为原点缩放到 ratio：屏幕上的点先还原到未缩放布局坐标。
    const center = box.top + box.height / 2;
    const layoutY = center + (this.mainScrollTop + offsetY - center) / geometry.ratio;
    return this.layout.contentPointAt(layoutY);
  }

  /**
   * 按预览几何写到页盒上：缩放倍率 + 位移（让其与滚动位置一致）。
   *
   * @param geometry 预览几何：页盒缩放比例。
   */
  private applyPreviewToPages(geometry: { ratio: number }): void {
    for (const pageView of this.pageViews) pageView.setPreviewScale(geometry.ratio);
  }

  /** 断点/尺寸变化：更新根节点属性并重排。 */
  private scheduleViewportUpdate(): void {
    if (this.reflowFrame !== null) return;
    this.reflowFrame = requestAnimationFrame(() => {
      this.reflowFrame = null;
      this.updateViewport();
    });
  }

  /** 计算并应用视口断点。 */
  private updateViewport(): void {
    const width = this.root.clientWidth || this.measureViewport().width;
    const mode: ViewportMode =
      width >= 1024 ? 'desktop' : width >= 768 ? 'compact' : width >= 480 ? 'mobile' : 'narrow';
    const layout: 'inline' | 'overlay' | 'drawer' =
      mode === 'desktop' ? 'inline' : mode === 'compact' ? 'overlay' : 'drawer';
    if (mode !== this.viewportMode || layout !== this.sidebarLayout) {
      this.viewportMode = mode;
      this.sidebarLayout = layout;
      this.root.dataset.viewport = mode;
      this.root.dataset.sidebarLayout = layout;
      this.updateSidebarVisibility();
    }
    if (
      this.state.view.zoomMode === 'auto' ||
      this.state.view.zoomMode === 'page-width' ||
      this.state.view.zoomMode === 'page-fit'
    ) {
      const index = this.toIndex(this.state.view.pageNumber);
      const next = this.layout.scaleForMode(
        this.state.view.zoomMode,
        this.measureViewport(),
        index,
      );
      if (Math.abs(next - this.state.view.scale) > 0.001) {
        this.applyScale(next, this.state.view.zoomMode);
        return;
      }
    }
    this.reflow(this.layout.getAnchor(this.mainScrollTop));
    this.renderVisible();
  }

  /** 测量主区域；jsdom 中回退窗口尺寸。 */
  private measureViewport(): { width: number; height: number } {
    const width =
      this.elements.main.clientWidth ||
      this.root.clientWidth ||
      (typeof window !== 'undefined' ? window.innerWidth : 1024);
    const height =
      this.elements.main.clientHeight ||
      this.root.clientHeight ||
      (typeof window !== 'undefined' ? window.innerHeight : 800);
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  /** 设置 ResizeObserver/窗口监听与主区域滚动监听。 */
  private setupViewport(): void {
    this.root.dataset.viewport = this.viewportMode;
    this.root.dataset.sidebarLayout = this.sidebarLayout;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.scheduleViewportUpdate());
      observer.observe(this.root);
      this.resizeObserver = observer;
    } else {
      this.resizeObserver = null;
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onWindowResize);
    this.bindScrollListener();
    this.bindGestureListeners();
  }

  /**
   * 绑定滚轮/触摸平移/双指捏合/双击缩放手势。
   *
   * 移动端主区域用 `touch-action: pan-x pan-y`：单指平移完全交给浏览器（纵向与横向都能
   * 自由滑动），浏览器自身的捏合与双击缩放被关闭。桌面端只保留滚轮与滚动条，触摸手势
   * 一律不接管。只有开启 zoom 功能时才注册 `pointerdown`，把触摸触点纳入 pointer
   * capture，保证双指捏合期间事件不丢失；滚轮监听必须非 passive 才能在 Ctrl/Cmd+滚轮时
   * `preventDefault`。
   */
  private bindGestureListeners(): void {
    const main = this.elements.main;
    main.style.touchAction = this.touchGesturesEnabled ? 'pan-x pan-y' : 'auto';
    main.addEventListener('wheel', this.onWheel, { passive: false });
    if (this.featureGate.isEnabled('zoom')) {
      main.addEventListener('pointerdown', this.onTap);
      main.addEventListener('pointerdown', this.onPointerDown);
    }
    main.addEventListener('pointermove', this.onPointerMove);
    main.addEventListener('pointerup', this.onPointerUp);
    main.addEventListener('pointercancel', this.onPointerUp);
    main.addEventListener('dblclick', this.onDoubleClick);
    const view = this.ownerDocument.defaultView;
    if (typeof view?.visualViewport?.addEventListener === 'function') {
      this.visualViewport = view.visualViewport;
      view.visualViewport.addEventListener('resize', this.onVisualViewportChange);
      // 部分浏览器缩放完成后还会触发一次 visualViewport 滚动（视口被顶到边缘），一并处理。
      view.visualViewport.addEventListener('scroll', this.onVisualViewportChange);
    }
  }

  /**
   * 浏览器自身的页面缩放变化（移动端双指、模拟器的 Shift+拖动、桌面端 Ctrl+滚轮）时的
   * 布局保持。
   *
   * `visualViewport.resize` 在缩放过程中持续触发，此时读到的滚动位置仍是旧缩放下的
   * 文档像素值；等缩放稳定后再按缩放前后记录的画面中心内容还原滚动位置，缩放过程中
   * 画面不会先滑走再被拉回。
   */
  private readonly onVisualViewportChange = (): void => {
    const viewport = this.visualViewport;
    if (!viewport) return;
    const scale = viewport.scale;
    if (this.browserScale === null) {
      this.browserScale = scale;
      return;
    }
    if (scale === this.browserScale) return;
    // 缩放开始时记下画面中心的内容；缩放结束后据此整页跟随，避免页面滑出可视区域。
    this.browserZoomAnchor ??= this.pageViews.length > 0 ? this.captureViewportCenter() : null;
    const anchor = this.browserZoomAnchor;
    this.browserZoomSettleTimer = this.cancelTimer(this.browserZoomSettleTimer);
    this.browserZoomSettleTimer = setTimeout(() => {
      this.browserZoomSettleTimer = null;
      const previous = this.browserScale;
      this.browserScale = scale;
      this.browserZoomAnchor = null;
      if (!anchor || this.pageViews.length === 0 || previous === null) return;
      // 滚动位置与页盒偏移都按文档像素保存：浏览器缩放变化后，页面内容在屏幕上的尺寸
      // 变了，但相对滚动位置的布局坐标没变，保持“画面中心的内容”即可。
      this.mainScrollTop = this.layout.offsetForContentPoint(anchor) - this.viewportHeight() / 2;
      this.updateScrollState();
      this.renderVisible();
      this.commit();
    }, BROWSER_ZOOM_SETTLE_MS);
  };

  /** 解绑手势监听并释放残留的 pointer capture。 */
  private unbindGestureListeners(): void {
    const main = this.elements.main;
    this.releaseTouchPointers();
    this.touchPoints.clear();
    this.pinching = false;
    this.pinchAnchor = null;
    this.lastTap = null;
    main.removeEventListener('wheel', this.onWheel);
    if (this.visualViewport) {
      this.visualViewport.removeEventListener('resize', this.onVisualViewportChange);
      this.visualViewport.removeEventListener('scroll', this.onVisualViewportChange);
      this.visualViewport = null;
    }
    this.browserScale = null;
    this.browserZoomAnchor = null;
    this.browserZoomSettleTimer = this.cancelTimer(this.browserZoomSettleTimer);
    main.removeEventListener('pointerdown', this.onTap);
    main.removeEventListener('pointerdown', this.onPointerDown);
    main.removeEventListener('pointermove', this.onPointerMove);
    main.removeEventListener('pointerup', this.onPointerUp);
    main.removeEventListener('pointercancel', this.onPointerUp);
    main.removeEventListener('dblclick', this.onDoubleClick);
  }

  /**
   * Ctrl/Cmd+滚轮缩放；触控板双指捏合通常也以 `ctrlKey=true` 的 wheel 到达。
   *
   * 只有 zoom 功能可用时才拦截浏览器默认缩放；步进 1.1/0.9，按画面中心缩放，
   * 连续滚轮只在停止 {@link PREVIEW_COMMIT_DELAY_MS} 后提交一次。
   *
   * @param event 滚轮事件；clientX/clientY 单位 px。
   */
  private handleWheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) {
      // 普通滚轮只走主区域原生滚动：进行中的程序化滚动必须让位给用户。
      this.cancelSmoothScroll();
      return;
    }
    if (!this.featureGate.isEnabled('zoom')) return;
    event.preventDefault();
    if (Math.abs(event.deltaY) < 1e-6) return;
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    this.scheduleZoom(this.getScale() * factor);
  }

  /**
   * 记录触摸触点；第二个触点按下时开始捏合。
   *
   * `touch-action: pan-x pan-y` 下浏览器可能在第二根手指落下时取消第一根手指的指针，
   * 因此在 `pointerdown` 时就做 pointer capture，保证随后的平移与捏合事件仍派发到主区域。
   *
   * @param event 指针事件；坐标单位 px。
   */
  private handlePointerDown(event: PointerEvent): void {
    this.cancelSmoothScroll();
    // 桌面端（有精确指针的设备）只接受滚轮与滚动条：鼠标按下不做拖拽平移，触摸事件
    // 也不接管，避免把触摸屏笔记本/触控笔当作移动端处理。
    if (!this.touchGesturesEnabled) return;
    if (event.pointerType !== 'touch') return;
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.captureTouchPointers();
    if (this.touchPoints.size > 2) {
      this.endPinch();
      return;
    }
    if (this.touchPoints.size === 1) {
      // 先把滚轮留下的延迟重绘落地，保证捏合起点是一份已定稿的画面。
      if (this.previewCommitTimer !== null) this.finishScaleGesture();
      return;
    }
    if (!this.featureGate.isEnabled('zoom')) return;
    // 第二根手指落下后浏览器不再派发单击/双击，清除待触发的双击缩放以免误触发。
    this.lastTap = null;
    const points = [...this.touchPoints.values()];
    const midX = (points[0]!.x + points[1]!.x) / 2;
    const midY = (points[0]!.y + points[1]!.y) / 2;
    this.pinching = true;
    this.pinchStartScale = this.state.view.scale;
    this.pinchBaseScale = this.state.view.scale;
    this.pinchStartDistance = this.pinchSpan(this.touchPoints);
    this.touchPointsChangedCount = 0;
    // 移动端以两指中点为缩放中心：中点下的内容在整个手势期间停在手指处。
    this.pinchAnchor = this.contentPointAtViewport(midX, midY);
    this.pinchAnchorOffset = this.pointerOffsetY(midY);
    this.pinchStartMidX = midX;
    this.pinchStartMidY = midY;
    this.pinchFrameAnchor = this.exactContentPointAtViewport(midX, midY);
    this.pinchFrameOffset = this.pointerOffsetY(midY);
    event.preventDefault();
  }

  /**
   * 双指捏合：按画面中心缩放，两指整体横移时同步横向平移，两指中点纵移交给原生滚动。
   *
   * 纵向平移与单指滚动继续交给浏览器原生滚动；横向在“不换行”的单列排版里没有可滚动的
   * 原生内容，因此捏合期间由这里直接映射到横向滚动位置。
   *
   * @param event 指针事件；坐标单位 px。
   */
  private handlePointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || !this.touchPoints.has(event.pointerId)) return;
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.touchPointsChangedCount = Math.min(2, this.touchPointsChangedCount + 1);
    if (!this.pinching || this.touchPoints.size !== 2 || !this.pinchAnchor) return;
    event.preventDefault();
    const [first, second] = [...this.touchPoints.values()];
    if (!first || !second) return;
    const midX = (first.x + second.x) / 2;
    const midY = (first.y + second.y) / 2;
    // 一帧内两个触点都上报过新位置时，两指距离才是整帧的真实距离；逐点上报的中间帧不算
    // 缩放，否则整体平移也会被当成缩小（真实触摸的指针事件按触点依次到达）。
    const distance = Math.max(1, this.pinchSpan(this.touchPoints));
    const framing = this.touchPointsChangedCount >= 2;
    // 与 pdf.js 一致：倍率按两位小数取整并结转余量，连续捏合不会因截断而丢失缩放量。
    const spanScale = this.accumulateScale(
      this.pinchBaseScale,
      distance / this.pinchStartDistance,
    );
    const nextScale = framing ? spanScale : this.pinchBaseScale;
    this.pinchBaseScale = spanScale;
    this.pinchStartDistance = distance;
    this.touchPointsChangedCount = 0;
    // 与 pdf.js `panBy` 一致：先按两指整体移动改滚动位置（锚点内容随之留在手指处），
    // 再以“两指中点下的内容”为新锚点做本帧缩放。
    this.panBy(this.pinchStartMidX - midX, this.pinchStartMidY - midY);
    this.pinchStartMidX = midX;
    this.pinchStartMidY = midY;
    // 与 pdf.js 一致：以“上一帧两指中点”为锚点（当前中点会把 (ratio−1)×位移 一起算进去）。
    // 锚点内容坐标按页顶 + 页内像素精确求解，避免页边界 1px 容差逐帧放大成可见漂移。
    const anchor =
      this.pinchFrameAnchor ?? this.exactContentPointAtViewport(midX, midY);
    const anchorOffset = this.pinchFrameOffset;
    this.pinchAnchorOffset = anchorOffset;
    this.previewPinch(nextScale, anchor, anchorOffset);
    // 锚点必须在本帧缩放“之后”重新取：它存的是当前布局下的 CSS 像素坐标，若沿用缩放前
    // 的坐标，下一帧按新旧宽度比换算就会把上一帧的缩放量重复计入，表现为逐帧漂移。
    this.pinchFrameAnchor = this.exactContentPointAtViewport(midX, midY);
    this.pinchFrameOffset = this.pointerOffsetY(midY);
  }

  /**
   * 捏合/滚轮的单步缩放：直接按新倍率排版并按锚点重设滚动位置（与 pdf.js 的
   * `updateScale()` 等价），重绘由 {@link scheduleRenderAfterScale} 节流。
   *
   * @param nextScale 目标倍率。
   * @param anchor 缩放中心对应的内容坐标。
   * @param anchorOffset 锚点内容相对可视窗口顶部的偏移，单位 px。
   */
  private previewPinch(
    nextScale: number,
    anchor: ContentPoint,
    anchorOffset: number,
  ): void {
    const target = clampScale(nextScale);
    if (Math.abs(target - this.state.view.scale) < PINCH_SCALE_EPSILON) return;
    this.previewScale = target;
    this.applyScaleStep(target, anchor, anchorOffset);
  }

  /**
   * 锁定式缩放（Ctrl/Cmd+滚轮）：以本轮手势开始时的可视窗口中心为锚点。
   *
   * @param nextScale 目标倍率。
   */
  private scheduleZoom(nextScale: number): void {
    const current = this.state.view.scale;
    const target = this.accumulateScale(current, nextScale / current);
    if (Math.abs(target - current) < 1e-6) return;
    // 连续滚轮是一次手势：锚点固定在开始时的窗口中心，避免每格都重新取点产生漂移。
    if (this.pinnedZoomAnchor === null) {
      this.pinnedZoomAnchor = this.captureViewportCenter();
      this.pinnedZoomAnchorOffset = this.viewportHeight() / 2;
    }
    this.previewScale = target;
    this.applyScaleStep(target, this.pinnedZoomAnchor, this.pinnedZoomAnchorOffset);
  }

  /**
   * 按“新倍率 + 锚点”更新布局与滚动位置，并安排一次延迟重绘。
   *
   * 这一帧里只有一次几何变更：写缩放变量 → 页盒按 CSS 尺寸重排 → 按锚点重设滚动，
   * 不会出现“先视觉缩放、再恢复 CSS”导致的跳动。
   *
   * @param nextScale 目标倍率。
   * @param anchor 缩放中心对应的内容坐标。
   * @param anchorOffset 锚点内容相对可视窗口顶部的偏移，单位 px。
   */
  private applyScaleStep(nextScale: number, anchor: ContentPoint, anchorOffset: number): void {
    const previous = this.state.view.scale;
    if (Math.abs(nextScale - previous) < 1e-6) return;
    this.layout.setZoom(nextScale, 'page-actual');
    this.patchView({ scale: nextScale, zoomMode: 'page-actual' });
    this.applyScaleVariable(nextScale);
    this.reflow();
    this.anchorScrollTo(anchor, anchorOffset);
    this.updateScrollState();
    this.scheduleRenderAfterScale();
    this.commit();
    this.emit('scalechanging', { scale: nextScale, zoomMode: 'page-actual', previous });
    this.syncHash();
  }

  /**
   * 缩放期间的延迟重绘：手势停顿 {@link PREVIEW_COMMIT_DELAY_MS} 后按最终倍率重绘一次。
   *
   * 与 pdf.js 的 `drawingDelay` 一致：手势进行中只拉伸旧位图，不逐帧重绘 canvas。
   */
  private scheduleRenderAfterScale(): void {
    this.previewCommitTimer = this.cancelTimer(this.previewCommitTimer);
    this.previewCommitTimer = setTimeout(() => {
      this.previewCommitTimer = null;
      this.finishScaleGesture();
    }, PREVIEW_COMMIT_DELAY_MS);
  }

  /** 结束一轮缩放手势：按当前倍率重绘可见页并收起预览状态。 */
  private finishScaleGesture(): void {
    const previousRenderScale = this.lastRenderScale;
    this.lastRenderScale = this.effectiveRenderScale();
    this.previewScale = null;
    this.pinnedZoomAnchor = null;
    for (const pageView of this.pageViews) {
      pageView.setPreviewScale(1);
      pageView.setPreviewTranslate(0);
    }
    if (Math.abs(this.lastRenderScale - previousRenderScale) > 1e-4) this.cancelAllPageTasks();
    this.renderVisible(true);
  }

  /**
   * 结束捏合并释放 pointer capture；剩余单指回归原生滚动。
   */
  private endPinch(): void {
    this.pinching = false;
    this.pinchStartDistance = 0;
    this.releaseTouchPointers();
    // 松手立即按最终倍率重绘，不必等待延迟计时器。
    if (this.previewScale !== null) this.finishScaleGesture();
    this.pinchAnchor = null;
  }

  /**
   * 视口坐标下的内容位置；用于两指中点 / 指针命中。
   *
   * @param clientX 视口 x 坐标，单位 px。
   * @param clientY 视口 y 坐标，单位 px。
   * @returns 内容锚点。
   */
  /**
   * 视口坐标映射到“精确页内位置”：页顶按布局坐标取、页内比例不做容差。
   *
   * 横向同样记录两指中点下的内容坐标，保证放大后手指下的内容停在原处。
   *
   * @param clientX 视口 x 坐标，单位 px。
   * @param clientY 视口 y 坐标，单位 px。
   * @returns 页索引与页内比例；页内比例已换算为绝对内容坐标 `offset`。
   */
  private exactContentPointAtViewport(clientX: number, clientY: number): ContentPoint {
    const absolute = this.mainScrollTop + this.pointerOffsetY(clientY);
    this.anchorClientX = clientX - this.viewportLeft();
    return this.layout.contentPointAt(
      absolute,
      clientX - this.viewportLeft() + this.mainScrollLeft - this.contentLeft(),
    );
  }

  private contentPointAtViewport(clientX: number, clientY: number): ContentPoint {
    // 内容横向坐标 = 视口 x − 主区域左缘 + 滚动位置 − 居中偏移（内容窄于可视区时非 0）。
    const contentX = clientX - this.viewportLeft() + this.mainScrollLeft - this.contentLeft();
    this.anchorClientX = clientX - this.viewportLeft();
    return this.layout.contentPointAt(
      this.mainScrollTop + this.pointerOffsetY(clientY),
      contentX,
    );
  }

  /**
   * 前两个触点的距离。
   *
   * @param points 全部触点；坐标单位 px。
   * @returns 距离，单位 px；不足两个时返回 0。
   */
  private pinchSpan(points: ReadonlyMap<number, { x: number; y: number }>): number {
    const [first, second] = [...points.values()];
    if (!first || !second) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  /**
   * 结束触点并释放 pointer capture；剩余单指不影响普通滚动。
   *
   * @param event 指针事件。
   */
  private handlePointerUp(event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;
    if (!this.touchPoints.has(event.pointerId)) return;
    this.touchPoints.delete(event.pointerId);
    // 任一手指抬起即结束捏合，避免两指一前一后抬起时有一次事件被漏掉。
    this.releaseTouchPointer(event.pointerId);
    if (this.touchPoints.size === 0) this.releaseTouchPointers();
    if (this.touchPoints.size >= 2) return;
    const wasPinching = this.pinching;
    this.pinching = false;
    this.pinchStartDistance = 0;
    // 抬指时按整段触摸手势是否属于捏合（即使已缩小回原倍率、比例锁已撤销）收尾。
    if (wasPinching) this.endPinch();
    this.pinchAnchor = null;
  }

  /** 对全部触摸触点执行 pointer capture；合成事件无活动指针时忽略。 */
  private captureTouchPointers(): void {
    const main = this.elements.main;
    if (typeof main.setPointerCapture !== 'function') return;
    for (const pointerId of this.touchPoints.keys()) {
      if (this.capturedPointers.has(pointerId)) continue;
      try {
        main.setPointerCapture(pointerId);
        this.capturedPointers.add(pointerId);
      } catch {
        // 合成事件没有对应的活动指针，忽略即可。
      }
    }
  }

  /**
   * 释放单个触点的 pointer capture。
   *
   * @param pointerId 触点 id。
   */
  private releaseTouchPointer(pointerId: number): void {
    if (!this.capturedPointers.delete(pointerId)) return;
    const main = this.elements.main;
    try {
      if (typeof main.hasPointerCapture !== 'function' || main.hasPointerCapture(pointerId)) {
        main.releasePointerCapture(pointerId);
      }
    } catch {
      // 指针已失效或从未捕获。
    }
  }

  /** 释放全部触摸 pointer capture。 */
  private releaseTouchPointers(): void {
    for (const pointerId of [...this.capturedPointers]) this.releaseTouchPointer(pointerId);
  }

  /**
   * 双击在适合宽度与 100% 之间切换并清除双击文本选区；鼠标以指针为锚点。
   *
   * 触屏双击由 {@link handleTap} 判定：触摸事件也会带出 `dblclick`，这里统一忽略
   * 触屏与合成触摸事件，避免一次双击缩放两次。
   *
   * @param event 双击事件；clientX/clientY 单位 px。
   */
  private handleDoubleClick(event: MouseEvent): void {
    if (!this.featureGate.isEnabled('zoom')) return;
    if ((event as MouseEvent & { readonly pointerType?: string }).pointerType === 'touch') return;
    if (isSyntheticTouchClick(event)) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('a,button,input,select,textarea,[contenteditable="true"]')
    ) {
      return;
    }
    event.preventDefault();
    this.clearTextSelection();
    this.toggleZoomAt(event.clientX, event.clientY);
  }

  /**
   * 双击缩放命中检测：按两次轻点派发的指针事件判定。
   *
   * 触屏浏览器以 `pointerdown` 派发触摸点击；判定失败时不做任何处理，不影响
   * 单击选中文本与链接跳转。
   *
   * @param event 指针按下事件；坐标单位 px。
   */
  private handleTap(event: PointerEvent): void {
    if (event.button !== 0 || !this.featureGate.isEnabled('zoom')) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('a,button,input,select,textarea,[contenteditable="true"]')
    ) {
      return;
    }
    const now = Date.now();
    const last = this.lastTap;
    const doubled =
      last !== null &&
      last.type === event.pointerType &&
      now - last.at <= TAP_ZOOM_INTERVAL_MS &&
      Math.abs(last.x - event.clientX) <= TAP_ZOOM_SLOP_PX &&
      Math.abs(last.y - event.clientY) <= TAP_ZOOM_SLOP_PX &&
      this.touchPoints.size <= 1;
    this.lastTap = { at: now, x: event.clientX, y: event.clientY, type: event.pointerType };
    if (!doubled) return;
    this.lastTap = null;
    this.clearTextSelection();
    this.toggleZoomAt(event.clientX, event.clientY);
  }

  /**
   * 在适合宽度与 100% 之间切换，以给定视口坐标下的内容为锚点。
   *
   * @param clientX 锚点视口 x 坐标，单位 px。
   * @param clientY 锚点视口 y 坐标，单位 px。
   */
  private toggleZoomAt(clientX: number, clientY: number): void {
    const mode: ZoomMode = this.state.view.zoomMode === 'auto' ? 'page-actual' : 'auto';
    const next =
      mode === 'page-actual'
        ? 1
        : this.layout.scaleForMode(
            'auto',
            this.measureViewport(),
            this.toIndex(this.state.view.pageNumber),
          );
    // 与滚轮一致：以“当前可视窗口中心”为缩放中心；移动端双击按两指点按位置保持。
    const anchor =
      this.viewportMode === 'desktop'
        ? this.captureViewportCenter()
        : this.contentPointAtViewport(clientX, clientY);
    const anchorOffset =
      this.viewportMode === 'desktop'
        ? this.viewportHeight() / 2
        : this.pointerOffsetY(clientY);
    this.pinnedZoomAnchor = anchor;
    this.pinnedZoomAnchorOffset = anchorOffset;
    this.applyScale(next, mode, anchor);
  }

  /** 清除主区域内正在进行中的文本选区。 */
  private clearTextSelection(): void {
    const selection = this.ownerDocument.getSelection?.();
    if (!selection || selection.isCollapsed) return;
    const anchor = selection.anchorNode;
    if (anchor && (anchor === this.elements.main || this.elements.main.contains(anchor))) {
      selection.removeAllRanges();
    }
  }

  /**
   * 画面中心对应的内容坐标。
   *
   * 横向同时记录窗口中心的内容坐标与它在可视区内的偏移：桌面端滚轮、按钮、双击都以
   * 画面中心为缩放中心，放大后窗口中心处的文字必须停在原处。
   *
   * @returns 内容坐标锚点。
   */
  private captureViewportCenter(): ContentPoint {
    const centerX = this.viewportWidth() / 2;
    this.anchorClientX = centerX;
    return this.layout.contentPointAt(
      this.mainScrollTop + this.viewportHeight() / 2,
      centerX + this.mainScrollLeft - this.contentLeft(),
    );
  }

  /**
   * 由内容锚点计算滚动位置。
   *
   * @param anchor 内容锚点。
   * @param offset 锚点在主区域可视范围内的纵向偏移，单位 px。
   * @returns 滚动位置，单位 px。
   */
  private scrollTopForAnchor(anchor: ContentPoint, offset: number): number {
    return this.layout.offsetForContentPoint(anchor) - offset;
  }

  /**
   * 主区域可视高度。
   *
   * @returns 高度，单位 px。
   */
  private viewportHeight(): number {
    const rect = this.elements.main.getBoundingClientRect();
    return rect.height > 0 ? rect.height : this.measureViewport().height;
  }

  /**
   * 清除计时器并返回 null，便于 `field = this.cancelTimer(field)`。
   *
   * @param timer 计时器句柄。
   * @returns 恒为 null。
   */
  private cancelTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer !== null) clearTimeout(timer);
    return null;
  }

  /**
   * 绑定主区域滚动监听；连同 `open`/`close` 只绑一次，避免重复入队。
   *
   * 用户滚轮/触控/滚动条只改变 `main.scrollTop`，必须由该监听触发 rAF 合并后的
   * `handleScroll()`，否则页码、可见范围与后续页渲染都不会更新。
   */
  private bindScrollListener(): void {
    if (this.scrollListenerBound) return;
    this.elements.main.addEventListener('scroll', this.onScroll, { passive: true });
    this.scrollListenerBound = true;
  }

  /** 解绑主区域滚动监听。 */
  private unbindScrollListener(): void {
    if (!this.scrollListenerBound) return;
    this.elements.main.removeEventListener('scroll', this.onScroll);
    this.scrollListenerBound = false;
  }

  /** 核心管理侧栏与遮罩可见性。 */
  private updateSidebarVisibility(): void {
    const open = this.state.view.sidebarView !== null;
    const sidebarEnabled = this.featureGate.isVisible('sidebar');
    this.elements.sidebar.hidden = !open || !sidebarEnabled;
    this.elements.sidebarMask.hidden = !(open && this.sidebarLayout !== 'inline' && sidebarEnabled);
    this.elements.sidebar.dataset.open = open ? 'true' : 'false';
    this.elements.sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    this.elements.sidebarMask.dataset.open = open ? 'true' : 'false';
  }

  /** 应用功能状态到核心 DOM。 */
  private applyFeatureStates(): void {
    const states = this.featureGate.getStates();
    this.elements.toolbar.hidden = !states.toolbar.visible;
    if (!states.sidebar.enabled) {
      this.elements.sidebar.hidden = true;
      this.elements.sidebarMask.hidden = true;
    }
    for (const pageView of this.pageViews) {
      pageView.setTextLayerVisible(states.textLayer.enabled);
      pageView.setSignatureLayerVisible(states.signatures.enabled);
      pageView.textLayer.dataset.selectable = states.selection.enabled ? 'true' : 'false';
    }
    this.keyboard.setEnabled(states.keyboardShortcuts.enabled);
    // 关闭缩放功能时不再接管双指手势：改用浏览器自带的页面缩放（与移动端两指缩放、
    // 模拟器的 Shift+拖动一致），页面会自然滚动到手指附近。触摸手势本身只在触屏主设备
    // 上接管，桌面端始终保留浏览器原生行为，缩放交给滚轮。
    const zoomEnabled = states.zoom.enabled;
    this.root.dataset.browserZoom = zoomEnabled ? 'none' : 'pinch';
    this.elements.main.style.touchAction =
      zoomEnabled && this.touchGesturesEnabled ? 'pan-x pan-y' : 'auto';
    this.updateSidebarVisibility();
  }

  /** 读取文档权限与引擎能力，更新功能可用性。 */
  private async applyAvailability(token: number): Promise<void> {
    if (token !== this.openToken) return;
    const permissions = await this.controller.getPermissions().catch(() => null);
    const documentAvailability: Partial<Record<ViewerFeature, boolean>> = {};
    const unsupported: Partial<Record<ViewerFeature, boolean>> = {};
    if (permissions?.print?.printable === false) documentAvailability.print = false;
    if (permissions?.export === false) documentAvailability.export = false;
    let page: EnginePage | null = null;
    try {
      page = await this.controller.getPage(0);
    } catch {
      page = null;
    }
    if (page && typeof page.getTextContent !== 'function') unsupported.textLayer = true;
    if (page && typeof page.exportImage !== 'function') {
      unsupported.print = true;
      unsupported.export = true;
    }
    if (this.controller.document && typeof this.controller.document.getSignatureEntries !== 'function') {
      unsupported.signatures = true;
    }
    if (!this.cryptoService.isEnabled) unsupported.verification = true;
    // 附件：引擎缺少流式读取能力或文档没有附件时，不渲染附件标签页。
    const attachmentCapable =
      this.controller.document !== null &&
      typeof (this.controller.document as { saveAttachment?: unknown }).saveAttachment ===
        'function';
    if (!attachmentCapable) {
      unsupported.attachments = true;
    } else {
      const attachments = await this.controller.getAttachments().catch(() => undefined);
      if (token !== this.openToken) return;
      if (!attachments || attachments.length === 0) documentAvailability.attachments = false;
    }
    const states = this.featureGate.setAvailability({
      document: documentAvailability,
      unsupported,
    });
    this.patchUI({ features: cloneFeatureStates(states) });
    this.applyFeatureStates();
    this.emit('featureschange', cloneFeatureStates(states));
  }

  /** 异步加载侧栏数据，不阻塞首屏。 */
  private async loadSideData(token: number): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    if (this.featureGate.isEnabled('documentProperties')) {
      jobs.push(
        this.controller
          .getMetadata()
          .then((metadata) => {
            if (token !== this.openToken) return;
            this.patchDocument({ metadata });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, UI_WARNING_CODES.W_METADATA, '文档属性读取失败')),
      );
    }
    if (this.featureGate.isEnabled('outline')) {
      jobs.push(
        this.controller
          .getOutline()
          .then((outline) => {
            if (token !== this.openToken) return;
            this.patchDocument({ outline });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, UI_WARNING_CODES.W_OUTLINE, '大纲读取失败')),
      );
    }
    if (this.featureGate.isEnabled('bookmarks')) {
      jobs.push(
        this.controller
          .getBookmarks()
          .then((bookmarks) => {
            if (token !== this.openToken) return;
            this.patchDocument({ bookmarks });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, UI_WARNING_CODES.W_BOOKMARKS, '书签读取失败')),
      );
    }
    if (this.featureGate.isEnabled('signatures')) {
      jobs.push(
        this.controller
          .getSignatureEntries()
          .then((entries) => {
            if (token !== this.openToken) return;
            this.patchDocument({ signaturesSummary: entries });
            this.commit();
          })
          .catch((error) => this.reportWarningError(error, UI_WARNING_CODES.W_SIGNATURE_ENTRIES, '签章列表读取失败')),
      );
    }
    await Promise.allSettled(jobs);
  }

  /** 应用 URL hash 状态。 */
  private applyHashState(hash: ViewerHashState): void {
    if (this.pageInfos.length === 0) return;
    if (hash.page !== undefined) {
      const index = this.toIndex(hash.page);
      this.mainScrollTop = this.layout.getPageTop(index);
      this.patchView({ pageNumber: index + 1 });
    }
    if (hash.zoom !== undefined) {
      if (typeof hash.zoom === 'number') this.setScale(hash.zoom);
      else this.setZoomMode(hash.zoom);
    }
    if (hash.rotation !== undefined) this.setRotation(hash.rotation);
    if (hash.sidebar !== undefined) {
      if (hash.sidebar === null) this.closeSidebar();
      else this.openSidebar(hash.sidebar);
    }
    this.renderVisible();
    this.commit();
  }

  /** 写入 URL hash；失败不影响阅读。 */
  private syncHash(): void {
    if (!this.history || !this.options.updateHash) return;
    try {
      this.history.sync({
        page: this.state.view.pageNumber,
        zoom:
          this.state.view.zoomMode === 'page-actual'
            ? this.state.view.scale
            : this.state.view.zoomMode,
        rotation: this.state.view.rotation,
        sidebar: this.state.view.sidebarView,
      });
    } catch {
      // 历史写入失败不影响阅读。
    }
  }

  /** 键盘 Ctrl/Cmd+F：复用工具栏查找按钮，避免核心直接依赖 UI。 */
  private openFindFromKeyboard(): void {
    if (!this.featureGate.isEnabled('find')) return;
    this.elements.toolbar
      .querySelector<HTMLButtonElement>('[data-ofd-control="find"]')
      ?.click();
  }

  /** 打开成功后按需自动验证；失败只记 warning，不影响文档打开。 */
  private maybeAutoVerify(): void {
    if (!this.cryptoPreparation || !this.cryptoService.shouldAutoVerify(this.cryptoPreparation)) {
      return;
    }
    void this.verify().catch((error: unknown) => {
      this.warn(
        UI_WARNING_CODES.W_CRYPTO_VERIFY_FAILED,
        `自动验证失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** 映射引擎打开错误；加密文档在密码能力关闭时给出专用错误码。 */
  private mapOpenFailure(error: unknown): unknown {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== 'OFD_ENCRYPTED') return error;
    if (!this.cryptoService.isEnabled) {
      return new OFDViewerError(
        'OFD_CRYPTO_UNSUPPORTED',
        this.cryptoService.strings.cryptoUnsupported,
        { cause: error },
      );
    }
    return new OFDViewerError(
      'OFD_CRYPTO_FAILED',
      this.cryptoService.strings.credentialDecryptFailed,
      { cause: error },
    );
  }

  /** 关闭 UI 持有的解密容器；engine 只借用，不负责关闭。 */
  private async releaseDecryptedContainer(): Promise<void> {
    const container = this.decryptedContainer;
    this.decryptedContainer = null;
    if (container) await closeContainer(container);
  }

  /**
   * 关闭 UI 持有的 HTTP 字节源；只处理加密路径创建的源。
   *
   * 明文路径的字节源随引擎容器生命周期关闭，这里不会重复关闭。
   */
  private async releaseSource(): Promise<void> {
    const source = this.activeHttpSource;
    this.activeHttpSource = null;
    await closeHttpSource(source);
  }

  /** 挂载服务并返回卸载函数。 */
  private attachService<K extends keyof ViewerServices>(
    key: K,
    service: NonNullable<ViewerServices[K]>,
  ): () => void {
    this.services[key] = service;
    return () => {
      if (this.services[key] === service) delete this.services[key];
    };
  }

  /** 读取必需服务；缺失时抛不支持错误。 */
  private requireService<K extends keyof ViewerServices>(
    key: K,
    label: string,
  ): NonNullable<ViewerServices[K]> {
    const service = this.services[key];
    if (!service) throw new OFDViewerError('OFD_UNSUPPORTED', `${label}未挂载`);
    return service as NonNullable<ViewerServices[K]>;
  }

  /** 应用扩展集合；构造时调用。 */
  private applyExtensions(): void {
    for (const extension of extensions) this.applyExtension(extension);
  }

  /** 断言功能可用。 */
  private assertFeature(feature: ViewerFeature): void {
    const state = this.featureGate.getState(feature);
    if (!state.enabled) throw createFeatureDisabledError(feature);
  }

  /** 断言文档已打开。 */
  private assertOpen(): void {
    if (!this.controller.isOpen) throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开');
  }

  /** 断言实例未销毁。 */
  private assertNotDisposed(): void {
    if (this.disposed) throw new OFDViewerError('OFD_DESTROYED', '阅读器已销毁');
  }

  /** 页码转内部索引，并夹取到有效范围。 */
  private toIndex(pageNumber: number): number {
    const count = this.pageInfos.length;
    if (count === 0) return 0;
    const normalized = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1;
    return Math.min(count - 1, Math.max(0, normalized - 1));
  }

  /** 报告 warning。 */
  private reportWarning(warning: ViewerWarning): void {
    this.warn(warning.code, warning.message, warning.pageIndex, warning.resourceId);
  }

  /**
   * 记录 warning 并触发回调/事件。
   *
   * 级别取自 `resolveDiagnosticLevel(code)`；控制台输出由 `DiagnosticPrinter` 过滤/去重，
   * 回调与事件每次都触发。
   *
   * @param code 诊断码，例如 `W_GLYPH_MISSING`。
   * @param message 诊断信息。
   * @param pageIndex 关联页索引，0-based；与页面无关时省略。
   * @param resourceId 关联资源/对象 ID；用于控制台诊断去重与定位。
   */
  private warn(
    code: string,
    message: string,
    pageIndex?: number,
    resourceId?: string,
  ): void {
    const warning: ViewerWarning = {
      code,
      message,
      ...(pageIndex === undefined ? {} : { pageIndex }),
      ...(resourceId === undefined ? {} : { resourceId }),
    };
    this.patchUI({ warnings: [...this.state.ui.warnings, warning].slice(-100) });
    this.options.onWarning?.(warning);
    this.diagnostics.print({
      code,
      level: resolveDiagnosticLevel(code),
      message,
      ...(pageIndex === undefined ? {} : { pageIndex }),
      ...(resourceId === undefined ? {} : { resourceId }),
      source: 'ui',
    });
    this.emit('warning', warning);
    this.commit();
  }

  /** 记录错误并触发回调/事件。 */
  private reportError(info: ViewerErrorInfo): void {
    this.options.onError?.(info);
    this.diagnostics.print({
      code: info.code,
      level: 'error',
      message: info.message,
      ...(info.pageIndex === undefined ? {} : { pageIndex: info.pageIndex }),
      ...(info.resourceId === undefined ? {} : { resourceId: info.resourceId }),
      source: 'ui',
      cause: info.cause,
    });
    this.emit('error', info);
  }

  /** 把任意错误转成 ViewerErrorInfo。 */
  private toErrorInfo(
    error: unknown,
    code: string,
    message: string,
    pageIndex?: number,
  ): ViewerErrorInfo {
    const causeCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    return {
      // 优先保留引擎/UI 错误码；普通 Error 才退回默认码。
      code: typeof causeCode === 'string' && causeCode.length > 0 ? causeCode : code,
      message: error instanceof Error ? error.message : message,
      ...(pageIndex === undefined ? {} : { pageIndex }),
      cause: error,
    };
  }

  /**
   * 把异常包装为一条 warning。
   *
   * 级别由 `code` 决定（`UI_WARNING_LEVELS` 映射，未登记按 `warn`），不随调用点变化；
   * 实际打印统一走 {@link warn} 中的 `DiagnosticPrinter`。
   *
   * @param error 原始异常；文案只取 `message`，不打印堆栈。
   * @param code 诊断码，例如 `W_METADATA`。
   * @param message 失败阶段说明，例如“大纲读取失败”。
   */
  private reportWarningError(error: unknown, code: string, message: string): void {
    this.warn(code, `${message}：${error instanceof Error ? error.message : String(error)}`);
  }

  /** 安全执行清理函数。 */
  private safeCleanup(cleanup: () => void): void {
    try {
      cleanup();
    } catch (error) {
      this.reportWarningError(error, UI_WARNING_CODES.W_UI_CLEANUP, '扩展清理失败');
    }
  }

  /** 更新文档状态。 */
  private patchDocument(patch: Partial<ViewerState['document']>): void {
    this.state = { ...this.state, document: { ...this.state.document, ...patch } };
  }

  /** 更新视图状态。 */
  private patchView(patch: Partial<ViewerState['view']>): void {
    this.state = { ...this.state, view: { ...this.state.view, ...patch } };
  }

  /** 更新 UI 状态。 */
  private patchUI(patch: Partial<ViewerState['ui']>): void {
    this.state = { ...this.state, ui: { ...this.state.ui, ...patch } };
  }

  /** 发出状态变化。 */
  private commit(): void {
    if (!this.disposed) this.eventBus.emit('statechange', this.state);
  }

  /** 类型安全地发出事件。 */
  private emit<K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]): void {
    this.eventBus.emit(event, payload);
  }
}

/** 夹取缩放倍率。 */
function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * 判断点击事件是否由触摸合成而来。
 *
 * 触屏浏览器在触摸轻点后会补发 `click`/`dblclick`，其 `sourceCapabilities` 带有
 * `firesTouchEvents`；不支持该属性时按环境是否同时支持触摸判定。
 *
 * @param event 鼠标/点击事件。
 * @returns 由触摸合成时 true。
 */
function isSyntheticTouchClick(event: MouseEvent): boolean {
  const capabilities = (
    event as MouseEvent & { readonly sourceCapabilities?: { readonly firesTouchEvents?: boolean } }
  ).sourceCapabilities;
  return capabilities?.firesTouchEvents === true;
}

/** 规范化旋转角度。 */
function normalizeRotation(value: number): Rotation {
  const normalized = ((Math.trunc(value / 90) * 90) % 360 + 360) % 360;
  return normalized as Rotation;
}

/** 判断移动端默认环境。 */
function detectMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(max-width: 767px)').matches ?? window.innerWidth < 768;
}

/**
 * 判断当前是否为“触屏主设备”（手机、平板），决定是否接管触摸手势。
 *
 * 以指针精度为准而不是窗口宽度：桌面浏览器即使带触摸屏，`(pointer: fine)` 也成立，
 * 仍按滚轮 + 滚动条的桌面交互处理。媒体查询不可用时退回窗口宽度判定。
 *
 * @returns 触屏主设备返回 true。
 */
function detectTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)');
  if (coarse?.matches) return true;
  const fine = window.matchMedia?.('(pointer: fine)');
  if (fine?.matches) return false;
  return detectMobile();
}

/** 解析容器；字符串按 CSS 选择器处理。 */
function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container === 'string') {
    const found = document.querySelector<HTMLElement>(container);
    if (!found) throw new OFDViewerError('OFD_INVALID_OPTION', `找不到容器：${container}`);
    return found;
  }
  if (!container) throw new OFDViewerError('OFD_INVALID_OPTION', 'container 不能为空');
  return container;
}

/** 文档全屏 loading 延迟显示时长，单位毫秒（设计方案 §5.5 / §6.9.2）。 */
const DOCUMENT_LOADING_DELAY_MS = 150;
/** 文档全屏 loading 显示后的最短展示时长，单位毫秒。 */
const DOCUMENT_LOADING_MIN_VISIBLE_MS = 300;
/** 文档全屏 loading 淡出时长，单位毫秒。 */
const DOCUMENT_LOADING_FADE_MS = 150;

/** 全屏 loading 控制器选项。 */
interface DocumentLoadingOverlayOptions {
  /** 阅读器根节点。 */
  readonly root: HTMLElement;
  /** 宿主文档；默认全局 document。 */
  readonly ownerDocument: Document;
  /** 当前语言翻译器。 */
  readonly translator: Translator;
  /** 遮罩显示期间需要 inert 的背景区域（工具栏、正文、对话框层等）。 */
  readonly background: readonly HTMLElement[];
  /** 点击“取消”。 */
  readonly onCancel: () => void;
  /** 点击“重试”。 */
  readonly onRetry: () => void;
  /** 点击“关闭”。 */
  readonly onClose: () => void;
}

/**
 * 文档全屏 loading / 错误卡（设计方案 §6.9.2）。
 *
 * 只负责视觉、ARIA 与计时：150 ms 延迟显示、最短 300 ms、150 ms 淡出；
 * 取消/错误/关闭立即隐藏。何时开始/结束由 `OFDViewer` 的打开流程
 * （引擎 `document:open:*` 事件 + 首个可见页渲染完成）调用。
 */
class DocumentLoadingOverlay {
  private readonly status: HTMLElement;
  private readonly statusName: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly errorTitle: HTMLElement;
  private readonly errorCode: HTMLElement;
  private readonly errorMessage: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly root: HTMLElement;
  private readonly doc: Document;
  private readonly callbacks: Pick<DocumentLoadingOverlayOptions, 'onCancel' | 'onRetry' | 'onClose'>;
  private readonly background: readonly HTMLElement[];
  /** 背景元素原有的 inert 状态；关闭遮罩时只恢复原本未 inert 的元素。 */
  private readonly savedInert = new Map<HTMLElement, boolean>();
  private translator: Translator;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private shownAt = 0;
  /** 本次打开是否已进入「打开完成」阶段；未完成时 `finish()` 不结束遮罩。 */
  private started = false;
  private cancelling = false;
  private currentSource: ViewerSource | null = null;
  /** 遮罩是否已启用焦点约束；避免重复添加监听器。 */
  private modalActive = false;
  private readonly onModalKeyDown = (event: KeyboardEvent): void => this.handleModalKeyDown(event);

  /**
   * @param options 根节点、宿主文档、翻译器与按钮回调。
   */
  constructor(options: DocumentLoadingOverlayOptions) {
    this.root = options.root;
    this.doc = options.ownerDocument;
    this.translator = options.translator;
    this.background = options.background;
    this.callbacks = options;
    const create = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className: string,
    ): HTMLElementTagNameMap[K] => {
      const element = this.doc.createElement(tag);
      element.className = className;
      return element;
    };

    this.status = create('div', 'ofd-viewer__loading');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-busy', 'true');
    this.status.hidden = true;
    const statusPanel = create('div', 'ofd-viewer__loading-panel');
    const ring = create('div', 'ofd-viewer__loading-ring');
    ring.setAttribute('aria-hidden', 'true');
    this.statusName = create('p', 'ofd-viewer__loading-name');
    this.statusText = create('p', 'ofd-viewer__loading-text');
    this.cancelButton = create('button', 'ofd-button ofd-viewer__loading-button');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.handleCancel());
    statusPanel.append(ring, this.statusName, this.statusText, this.cancelButton);
    this.status.appendChild(statusPanel);

    this.error = create('div', 'ofd-viewer__loading-error');
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    const errorPanel = create('div', 'ofd-viewer__loading-panel');
    this.errorTitle = create('p', 'ofd-viewer__loading-error-title');
    this.errorCode = create('p', 'ofd-viewer__loading-error-code');
    this.errorMessage = create('p', 'ofd-viewer__loading-error-message');
    const actions = create('div', 'ofd-viewer__loading-actions');
    this.retryButton = create(
      'button',
      'ofd-button ofd-viewer__loading-button ofd-viewer__loading-button--primary',
    );
    this.retryButton.type = 'button';
    this.retryButton.addEventListener('click', () => {
      this.hideAll();
      this.callbacks.onRetry();
    });
    this.closeButton = create('button', 'ofd-button ofd-viewer__loading-button');
    this.closeButton.type = 'button';
    this.closeButton.addEventListener('click', () => {
      this.hideAll();
      this.callbacks.onClose();
    });
    actions.append(this.retryButton, this.closeButton);
    errorPanel.append(this.errorTitle, this.errorCode, this.errorMessage, actions);
    this.error.appendChild(errorPanel);

    this.root.append(this.status, this.error);
    this.updateTexts();
  }

  /**
   * 开始一次打开：记录文档名并启动显示计时。
   *
   * @param source 本次打开来源；用于展示文件名。
   * @param delay 是否延迟显示；false 时立刻显示。
   */
  begin(source: ViewerSource, delay = true): void {
    this.currentSource = source;
    this.started = false;
    this.cancelling = false;
    this.cancelButton.disabled = false;
    this.cancelButton.textContent = this.translator.t('loading.cancel');
    this.updateName();
    this.hideError();
    this.clearTimers();
    this.status.removeAttribute('data-fading');
    if (this.visible) return;
    if (!delay) {
      this.show();
      return;
    }
    this.delayTimer = setTimeout(() => {
      this.delayTimer = null;
      this.show();
    }, DOCUMENT_LOADING_DELAY_MS);
  }

  /**
   * 文档打开完成、开始首屏渲染。
   *
   * 打开耗时低于延迟阈值时遮罩还没有出现；由于首屏绘制还要等字体下载，这段空白
   * 不应没有任何加载反馈，因此立即显示并跳过延迟计时。
   */
  markOpenComplete(): void {
    if (this.started) return;
    this.started = true;
    if (!this.visible) this.show();
  }

  /**
   * 首屏渲染完成：满足最短展示后淡出。
   *
   * 文档打开完成前的调用一律忽略：此时页壳已就绪但首屏仍在排队，提前收尾会让
   * 用户看到空白页壳。重复调用无副作用。
   */
  finish(): void {
    if (!this.started) return;
    this.started = false;
    this.clearTimers();
    if (!this.visible) return;
    const elapsed = Date.now() - this.shownAt;
    const remaining = Math.max(0, DOCUMENT_LOADING_MIN_VISIBLE_MS - elapsed);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.fadeOut();
    }, remaining);
  }

  /**
   * 打开失败：立即切换为全屏错误卡，不等延迟/最短展示。
   *
   * @param info 错误码与可读消息。
   */
  fail(info: ViewerErrorInfo): void {
    this.clearTimers();
    this.started = false;
    this.visible = false;
    this.status.hidden = true;
    this.status.removeAttribute('data-fading');
    this.errorCode.textContent = info.code;
    this.errorMessage.textContent = info.message;
    this.error.hidden = false;
    this.activateModal();
  }

  /** 取消：立即隐藏 loading 与错误卡。 */
  cancel(): void {
    this.hideAll();
  }

  /** 关闭文档：立即隐藏 loading 与错误卡。 */
  close(): void {
    this.hideAll();
  }

  /**
   * 切换语言；静态文案立即更新。
   *
   * @param locale 语言标签。
   */
  setLocale(locale: string): void {
    this.translator = createTranslator(locale);
    this.updateTexts();
    this.updateName();
  }

  /** 销毁并移除 DOM。 */
  destroy(): void {
    this.hideAll();
    this.status.remove();
    this.error.remove();
  }

  /** 显示全屏 loading。 */
  private show(): void {
    if (this.visible) return;
    if (this.delayTimer !== null) {
      clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
    this.visible = true;
    this.shownAt = Date.now();
    this.status.hidden = false;
    this.status.removeAttribute('data-fading');
    this.activateModal();
  }

  /** 按最短展示与 reduced-motion 设置淡出。 */
  private fadeOut(): void {
    if (!this.visible) return;
    if (this.prefersReducedMotion()) {
      this.hideAll();
      return;
    }
    this.status.setAttribute('data-fading', 'true');
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      this.hideAll();
    }, DOCUMENT_LOADING_FADE_MS);
  }

  /** 立即隐藏 loading 与错误卡并清理计时器。 */
  private hideAll(): void {
    this.clearTimers();
    this.started = false;
    this.visible = false;
    this.status.hidden = true;
    this.status.removeAttribute('data-fading');
    this.hideError();
    this.deactivateModal();
  }

  /** “取消”按钮：切换为“正在取消…”并禁用，随后交给宿主中止打开。 */
  private handleCancel(): void {
    if (this.cancelling) return;
    this.cancelling = true;
    this.cancelButton.disabled = true;
    this.cancelButton.textContent = this.translator.t('loading.cancelling');
    this.callbacks.onCancel();
  }

  /**
   * 隐藏错误卡；若 loading 也未显示，同步退出模态并恢复背景 inert。
   *
   * 新一次 `open()` 关闭错误卡时可能走不到 `hideAll()`：若文档在 150 ms 内
   * 打开成功，`finish()` 因 loading 从未显示而直接返回，必须在这里恢复。
   */
  private hideError(): void {
    this.error.hidden = true;
    if (this.status.hidden) this.deactivateModal();
  }

  /** 启用模态行为：背景 inert，Tab/Enter 限制在遮罩内。 */
  private activateModal(): void {
    if (this.modalActive) return;
    this.modalActive = true;
    for (const element of this.background) {
      this.savedInert.set(element, element.hasAttribute('inert'));
      element.setAttribute('inert', '');
    }
    this.doc.addEventListener('keydown', this.onModalKeyDown, true);
  }

  /** 关闭模态行为并恢复背景元素原有的 inert 状态。 */
  private deactivateModal(): void {
    if (!this.modalActive) return;
    this.modalActive = false;
    for (const [element, wasInert] of this.savedInert) {
      if (!wasInert) element.removeAttribute('inert');
    }
    this.savedInert.clear();
    this.doc.removeEventListener('keydown', this.onModalKeyDown, true);
  }

  /** 当前可见的遮罩面板；loading 优先于错误卡。 */
  private activePanel(): HTMLElement | null {
    if (!this.status.hidden) return this.status;
    if (!this.error.hidden) return this.error;
    return null;
  }

  /**
   * 遮罩显示期间的键盘约束：Tab 在面板按钮间循环；焦点在背景时 Enter 不触发背景。
   *
   * @param event 键盘事件。
   */
  private handleModalKeyDown(event: KeyboardEvent): void {
    const panel = this.activePanel();
    if (!panel) return;
    const active = this.doc.activeElement;
    if (event.key === 'Tab') {
      const buttons = [
        ...panel.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
      ];
      if (buttons.length === 0) {
        event.preventDefault();
        return;
      }
      const index = buttons.indexOf(active as HTMLButtonElement);
      const next =
        index < 0
          ? event.shiftKey
            ? buttons[buttons.length - 1]!
            : buttons[0]!
          : buttons[
              (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
            ]!;
      event.preventDefault();
      next.focus();
      return;
    }
    if (event.key === 'Enter' && !panel.contains(active)) {
      event.preventDefault();
    }
  }

  /**
   * 切换状态主文案。
   *
   * 用于在打开流程中提示“正在加载字体…”，让用户知道较长的等待来自字体下载。
   *
   * @param key 文案键；由调用方传入 `loading.fonts` 或 `loading.document`。
   */
  setStatusText(key: MessageKey): void {
    this.statusText.textContent = this.translator.t(key);
  }

  /** 刷新错误卡/按钮文案。 */
  private updateTexts(): void {
    this.errorTitle.textContent = this.translator.t('loading.openFailed');
    this.retryButton.textContent = this.translator.t('common.retry');
    this.closeButton.textContent = this.translator.t('common.close');
    if (!this.cancelling) this.cancelButton.textContent = this.translator.t('loading.cancel');
    this.statusText.textContent = this.translator.t('loading.document');
  }

  /** 刷新文档文件名；来源没有名称时显示“文档”。 */
  private updateName(): void {
    this.statusName.textContent = this.currentSource
      ? resolveDocumentName(this.currentSource, this.translator)
      : this.translator.t('loading.untitled');
  }

  /** 清理所有计时器。 */
  private clearTimers(): void {
    if (this.delayTimer !== null) {
      clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  /** 当前环境是否要求减少动效。 */
  private prefersReducedMotion(): boolean {
    const view = this.doc.defaultView;
    if (!view || typeof view.matchMedia !== 'function') return false;
    try {
      return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }
}

/**
 * 解析全屏 loading 展示的文档名。
 *
 * @param source 打开来源。
 * @param translator 当前翻译器。
 * @returns 文件名、URL basename 或“文档”。
 */
function resolveDocumentName(source: ViewerSource, translator: Translator): string {
  const named = source as { name?: unknown };
  if (typeof named.name === 'string' && named.name.trim().length > 0) {
    return named.name.trim();
  }
  let url: string | null = null;
  if (typeof source === 'string') {
    url = source;
  } else if (
    typeof source === 'object' &&
    source !== null &&
    'url' in source &&
    typeof (source as { url?: unknown }).url === 'string'
  ) {
    url = (source as { url: string }).url;
  }
  if (url) {
    const basename = sourceBasename(url);
    if (basename) return basename;
  }
  return translator.t('loading.untitled');
}

/**
 * 读取 URL 路径最后一段，单位无。
 *
 * @param url URL 或相对路径。
 * @returns 解码后的文件名；无路径段时返回空字符串。
 */
function sourceBasename(url: string): string {
  const path = url.split('#')[0]!.split('?')[0]!;
  const segment = path.split('/').filter((part) => part.length > 0).pop();
  if (!segment) return '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** 创建阅读器结构；UI 外壳会复用这些元素。 */
function createStructure(root: HTMLElement, doc: Document): UIShellElements {
  const create = (className: string, tag = 'div'): HTMLElement => {
    const element = doc.createElement(tag);
    element.className = className;
    return element;
  };
  const toolbar = create('ofd-viewer__toolbar');
  const body = create('ofd-viewer__body');
  const sidebar = create('ofd-viewer__sidebar', 'aside');
  const sidebarMask = create('ofd-viewer__sidebar-mask');
  const main = create('ofd-viewer__main');
  const pages = create('ofd-viewer__pages');
  const findbar = create('ofd-viewer__findbar');
  const dialogLayer = create('ofd-viewer__dialog-layer');
  const toastLayer = create('ofd-viewer__toast-layer');
  pages.style.position = 'relative';
  // 宽度在每次 reflow 里按内容宽度显式写入（页盒绝对定位，撑不开容器）。
  pages.style.height = '0px';
  main.appendChild(pages);
  body.append(sidebar, sidebarMask, main);
  root.append(toolbar, body, findbar, dialogLayer, toastLayer);
  sidebar.hidden = true;
  sidebarMask.hidden = true;
  findbar.hidden = true;
  const loadingArea = create('ofd-viewer__loading-area');
  loadingArea.hidden = true;
  main.appendChild(loadingArea);
  return { root, toolbar, body, sidebar, sidebarMask, main, findbar, dialogLayer, toastLayer, loadingArea };
}

export type { PageRange, ViewerSource };
