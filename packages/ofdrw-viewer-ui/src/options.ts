/**
 * 阅读器构造选项与默认值（设计方案 §4.1）。
 *
 * 这里只处理纯数据解析，不访问 DOM/`window`，便于在模块顶层安全导入。
 */

import type {
  CryptoCredential,
  CryptoOptions,
  OfdInspection,
  VerificationReport,
} from '@ofdrw/ofdrw-viewer-crypto';
import type { FeatureDisplay, ViewerFeatures } from './features';
import type { DiagnosticLevel } from './diagnostics';
import type { ViewerFontOptions } from './font';
import {
  resolveLayerPanelOptions,
  type LayerPanelOptions,
  type ResolvedLayerPanelOptions,
} from './layers/content-filter';
import {
  DEFAULT_LOCALE,
  DEFAULT_THEME,
  type Rotation,
  type ScaleValue,
  type SidebarView,
  type Theme,
  type ViewerErrorInfo,
  type ViewerWarning,
} from './state';
import type { ViewerSource } from './types';

/**
 * 桌面端单页 canvas 像素上限（width × height），默认 256MP。
 *
 * A4 纸在 DPR=1 下的画布像素数随倍率平方增长：800% 约 57MP、1600% 约 228MP、
 * 2500% 约 557MP。256MP 让 A4 在 DPR=1 下到约 1700%（DPR=2 下约 850%）按屏幕像素
 * 1:1 渲染；2500% 时为 0.56 个后备像素/CSS 像素（相比 32MP 的 0.24 提升 2.4 倍）。
 * 要做到 2500% 完全 1:1 需要 557MP、单页约 2.2GB 显存，超出浏览器可稳定分配的
 * 范围，宿主确需时可经 {@link OFDViewerOptions.maxCanvasPixels} 显式提高。
 *
 * 分配失败时由渲染层按 {@link CANVAS_RETRY_PIXEL_STEPS} 逐级收紧重试，不会直接报错。
 */
export const DEFAULT_MAX_CANVAS_PIXELS = 256_000_000;

/**
 * 已渲染页 canvas 的总像素预算，默认 512MP。
 *
 * 单页上限很高时，缓存里若留着多张高倍率画布会迅速耗尽内存；可见页始终保留，
 * 其余缓存页按预算裁剪。
 */
export const DEFAULT_PAGE_CACHE_PIXEL_BUDGET = 512_000_000;

/**
 * 画布尺寸超限或分配失败时的回退比例序列。
 *
 * 与 pdf.js 逐级降低 DPI 的做法一致：先尝试按原始倍率渲染，失败后按 0.75 逐级
 * 回退，直到成功或走完序列。
 */
export const CANVAS_RETRY_PIXEL_STEPS: readonly number[] = Object.freeze([
  1, 0.75, 0.5625, 0.421875, 0.31640625, 0.2373046875, 0.177978515625,
  0.13348388671875,
]);

/**
 * 移动端单页 canvas 像素上限（width × height），默认 32MP。
 *
 * 移动设备的显存与内存都更紧，高倍率下用 32MP 换稳定性；宿主可经
 * `ViewerOptions.maxCanvasPixels` 显式覆盖。
 */
export const DEFAULT_MOBILE_MAX_CANVAS_PIXELS = 32_000_000;

/** 桌面端已渲染页 canvas 缓存数量。 */
export const DEFAULT_PAGE_CACHE_SIZE = 10;

/** 移动端已渲染页 canvas 缓存数量。 */
export const DEFAULT_MOBILE_PAGE_CACHE_SIZE = 4;

/** 桌面端文本层滚动 span 总预算（不含 pin 页）。 */
export const DEFAULT_TEXT_SPAN_BUDGET = 30_000;

/** 移动端文本层滚动 span 总预算（不含 pin 页）。 */
export const DEFAULT_MOBILE_TEXT_SPAN_BUDGET = 12_000;

/** 桌面端选区端点页 pin 的 span 预算。 */
export const DEFAULT_SELECTION_PIN_SPAN_BUDGET = 50_000;

/** 移动端选区端点页 pin 的 span 预算。 */
export const DEFAULT_MOBILE_SELECTION_PIN_SPAN_BUDGET = 20_000;

/** 单页文本层 span 上限；超限先降级 item 级，仍超限则截断。 */
export const DEFAULT_TEXT_LAYER_MAX_SPANS = 100_000;

/** 缩略图缓存数量。 */
export const DEFAULT_THUMBNAIL_CACHE_SIZE = 100;

/** 桌面端同时渲染页数。 */
export const DEFAULT_RENDER_CONCURRENCY = 2;

/** 移动端同时渲染页数。 */
export const DEFAULT_MOBILE_RENDER_CONCURRENCY = 1;

/** 默认初始页，1-based。 */
export const DEFAULT_INITIAL_PAGE = 1;

/** 默认初始缩放：适合宽度。 */
export const DEFAULT_INITIAL_SCALE: ScaleValue = 'auto';

/** 默认初始旋转。 */
export const DEFAULT_ROTATION: Rotation = 0;

/**
 * 最小缩放倍率（25%）。
 *
 * 低于主画布最低渲染倍率（见 {@link MAX_CANVAS_BASE_DPR}）时画布不再降低分辨率，
 * 只由 CSS 缩小；缩放到底后不再继续缩小。缩略图使用独立尺寸，不受此限制。
 */
export const MIN_SCALE = 0.25;

/** 最大缩放倍率（2500%）。 */
export const MAX_SCALE = 25;

/**
 * 主画布基准渲染密度上限（2×）。
 *
 * 画布后备尺寸不低于页面 100% CSS 尺寸的 `min(devicePixelRatio, 2)` 倍；等价于
 * 最低渲染倍率为 `min(1, 2 / dpr)`。缩放倍率低于该值时不再重绘画布、也不改变
 * canvas 尺寸，只由 CSS 缩小显示，避免小图按低分辨率重绘后出现色块。
 *
 * 上限取 2 是为了在 3×/4× 高 DPR 移动设备上限制内存；与缩略图渲染的 DPR 上限一致。
 */
export const MAX_CANVAS_BASE_DPR = 2;

/**
 * 默认超采样倍率（1×，即不超采样）。
 *
 * 画布按“显示倍率 × 设备像素比 × 本值”渲染。默认 1 表示后备像素与屏幕物理像素
 * 一一对应——这是最锐利且最省算力的口径：设备像素比已经由浏览器表达，再放大只会
 * 多填充像素，滚动与缩放明显变卡（2× 使单页像素数变 4 倍）。
 *
 * 宿主若需要更高抗锯齿过渡（例如投影/截图场景），可显式传入 1.5 或 2；上限由
 * `ViewerOptions.maxCanvasPixels` 约束，超限时按 0.75 逐级回退 DPI。
 */
/**
 * 自动超采样的面积分档，单位 设备像素²（px²）。
 *
 * 页面设备像素面积不超过第一档时取 2 倍超采样（默认倍率约 2.3M px²，最需要清晰度）；
 * 超出后依次降到 1.5 倍、1 倍，避免高倍率下画布像素数爆炸。
 */
export const SUPERSAMPLE_FULL_AREA = 4_000_000;

/** 超采样降到 1.5 倍的面积上限，单位 设备像素²（px²）。 */
export const SUPERSAMPLE_HALF_AREA = 10_000_000;

/** 自动超采样在低倍率下使用的最大倍率。 */
export const SUPERSAMPLE_MAX = 2;

/** 自动超采样在中等倍率下使用的倍率。 */
export const SUPERSAMPLE_MID = 1.5;

/**
 * 超采样预设名。
 *
 * - `off`：固定 1 倍；
 * - `auto`：按页面设备像素面积自适应（默认）；
 * - `high`：在 `auto` 的每个档位上再加 1 倍；
 * - `max`：固定 3 倍。
 */
export type SupersamplePreset = 'off' | 'auto' | 'high' | 'max';

/** 默认超采样预设。 */
export const DEFAULT_SUPERSAMPLE: SupersamplePreset | number = 'auto';

/** `high` 预设相对 `auto` 每个档位额外增加的倍数。 */
export const SUPERSAMPLE_HIGH_BOOST = 1;

/** `max` 预设的固定倍率。 */
export const SUPERSAMPLE_MAX_FACTOR = 3;

/** 预置缩放档位；UI 的 +/- 与下拉菜单共用，最低档与 {@link MIN_SCALE} 一致。 */
export const ZOOM_LEVELS: readonly number[] = Object.freeze([
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 25,
]);

/**
 * 根证书来源；UI 宿主层保留 data/url/path/filePath 四态。
 *
 * `url` 由浏览器 `fetch` 读取；`path`/`filePath` 必须由宿主
 * `certificateLoader` 读取。读取到的原始字节（可为 DER/CER/PEM/Base64，
 * 也可含多张证书）统一经 crypto 的 `certificatesToDer` 转换为 DER 数组，
 * 再传给只接收 DER 的 crypto 证书接口。
 */
export type CertificateSource =
  | { readonly data: ArrayBuffer | Uint8Array; readonly name?: string }
  | {
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly name?: string;
    }
  | { readonly path: string; readonly name?: string }
  | { readonly filePath: string; readonly name?: string };

/**
 * 宿主证书加载器；`path`/`filePath` 由宿主平台实现。
 *
 * 返回值是原始字节（可含 PEM/Base64/多证书），由 UI 调用
 * `certificatesToDer` 转换后再传给 crypto；加载器不得自行解析证书。
 */
export type CertificateInputLoader = (
  source: CertificateSource,
) => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>;

/** 阅读器密码能力选项（设计 §6.1）。 */
export interface CryptoViewerOptions extends CryptoOptions {
  /** 是否启用密码能力；默认 true。 */
  readonly enabled?: boolean;
  /** 预置凭据；提供时不弹内置登录框。 */
  readonly credentials?: CryptoCredential | readonly CryptoCredential[];
  /** 无预置凭据时是否弹登录框；默认 true。 */
  readonly autoPrompt?: boolean;
  /** 初始信任根；默认 []，即链状态 unknown。 */
  readonly rootCertificates?: readonly CertificateSource[];
  /** path/filePath/url 根证书字节加载器。 */
  readonly certificateLoader?: CertificateInputLoader;
  /** 打开成功后是否自动验证；默认 true。 */
  readonly autoVerify?: boolean;
  /** 验证完成回调；实现不得记录凭据。 */
  readonly onVerification?: (report: VerificationReport) => void;
  /** 自定义凭据获取；返回 null 表示取消。 */
  readonly onCredentialRequired?: (
    inspection: OfdInspection,
  ) => Promise<CryptoCredential | null>;
}

/** 调试与诊断选项。 */
export interface DebugViewerOptions {
  /**
   * 是否把 warning/错误打印到浏览器控制台。
   *
   * 默认 true（整体开关，false 时完全不打印，回调与事件不受影响）；输出格式为
   * `[ofd-viewer] warning <code> <message> {pageIndex, resourceId}`，错误为
   * `[ofd-viewer] error <code> ...`。同一 `code` + `pageIndex` + `resourceId`（错误为
   * `code` + `pageIndex`）在同一文档会话内只打印一次，打开文档时重置。
   */
  readonly console?: boolean;
  /**
   * 只打印这些级别；可选。
   *
   * 缺省时按级别默认行为输出：`warn` → `console.warn`、`error` → `console.error`、
   * `info` 不打印。提供后只有列表内的级别会打印（过滤发生在去重之前，被过滤的诊断
   * 不占用去重键）。`console: false` 时该选项不生效。
   */
  readonly levels?: readonly DiagnosticLevel[];
  /**
   * 只打印这些诊断码（例如 `['W_FONT_MISSING', 'W_GLYPH_MISSING']`）；可选。
   *
   * 缺省时不过滤码；提供后其余码（含引擎/crypto 码）一律不打印，且不占用去重键。
   * `console: false` 时该选项不生效。
   */
  readonly codes?: readonly string[];
}

/** 阅读器构造选项。 */
export interface OFDViewerOptions {
  /** 挂载点；字符串按 CSS 选择器解析。 */
  readonly container: HTMLElement | string;
  /** 文档来源；省略时读取页面查询参数 `?file=` / `?base64=`。 */
  readonly source?: ViewerSource;
  /** 初始页，1-based；默认 1。 */
  readonly initialPage?: number;
  /** 初始缩放；数字为倍率，默认 `auto`（适合宽度）。 */
  readonly initialScale?: ScaleValue;
  /** 初始旋转；默认 0。 */
  readonly rotation?: Rotation;
  /** 初始侧栏；默认关闭（null）。 */
  readonly sidebar?: SidebarView | null;
  /** 功能开关补丁；false 表示不可用，默认全部开启。 */
  readonly features?: ViewerFeatures;
  /** 被关闭功能的展示方式；默认全局 `hide`。 */
  readonly featureDisplay?: FeatureDisplay;
  /** 主题；默认 `auto`。 */
  readonly theme?: Theme;
  /** 语言；默认 `zh-CN`，内置 `zh-CN`/`en-US`。 */
  readonly locale?: string;
  /**
   * 单页 canvas 像素上限。
   *
   * 省略时桌面端 256,000,000、移动端 32,000,000。上限决定高倍率下画面是否按屏幕
   * 像素 1:1 渲染：超出后按 0.75 逐级回退 DPI，画面由浏览器放大并出现锯齿。
   */
  readonly maxCanvasPixels?: number;
  /**
   * 画布超采样倍率，默认 `auto`。
   *
   * - `'off'`：固定 1 倍，按设备像素 1:1 渲染，最省内存；
   * - `'auto'`：按页面设备像素面积自适应，低倍率取 2、面积变大后降到 1.5、1；
   * - `'high'`：在 `auto` 的每个档位上额外加 1 倍（2→3、1.5→2.5），文字更平滑；
   * - `'max'`：固定 3 倍，极限清晰度，代价是像素数约 9 倍；
   * - 数字：固定该倍率，范围 1..4，非法值回退 `auto`。
   *
   * 超采样按更高分辨率渲染再由 CSS 缩小，边缘更平滑，代价是像素数按倍率平方增长。
   * 移动端默认固定 1；显式传入 `'high'`、`'max'` 或数字时以传入值为准。
   */
  readonly supersample?: SupersamplePreset | number;
  /** 已渲染页 canvas 缓存数量；默认桌面 10、移动 4。 */
  readonly pageCacheSize?: number;
  /**
   * 已渲染页 canvas 的总像素预算，默认 512,000,000。
   *
   * 缓存页的 `width × height` 之和超过该值时会提前释放离可见区最远的页；可见页始终
   * 保留。高倍率下这是防止内存膨胀的主要手段。
   */
  readonly pageCachePixelBudget?: number;
  /** 缩略图缓存数量，默认 100。 */
  readonly thumbnailCacheSize?: number;
  /**
   * 文本层滚动 span 总预算（不含选区 pin 页），默认桌面 30,000、移动 12,000。
   *
   * 缓存页的 span 总数超过该值时会淘汰离可见区最远的页；可见页与选区 pin 页
   * 永不淘汰。`0` 表示不限制。
   */
  readonly textSpanBudget?: number;
  /**
   * 选区端点页 pin 的 span 预算，默认桌面 50,000、移动 20,000。
   *
   * 选区 pin 页的 span 不计入 {@link textSpanBudget}；超过该预算时清空选区并
   * 告警，避免为了保住高亮而无限占用 DOM。
   */
  readonly selectionPinSpanBudget?: number;
  /**
   * 单页文本层 span 上限，默认 100,000；`0` 表示不限制。
   *
   * 超限时先降级为 item 级 span，仍超限则截断并发出文字层告警，不崩溃。
   */
  readonly textLayerMaxSpans?: number;
  /** 同时渲染页数；默认桌面 2、移动 1。 */
  readonly renderConcurrency?: number;
  /** 是否把页码/缩放/旋转写入 URL hash；默认 false。 */
  readonly updateHash?: boolean;
  /** URL 来源的额外请求参数；credentials 默认 `same-origin`。 */
  readonly requestInit?: RequestInit;
  /**
   * 调试与诊断选项。
   *
   * `console` 控制是否把引擎/UI 的 warning 与错误打印到浏览器控制台（默认 true）；
   * 关闭后只保留 `onWarning`/`onError` 回调与事件。
   */
  readonly debug?: DebugViewerOptions;
  /** 引擎/UI warning 回调。 */
  readonly onWarning?: (warning: ViewerWarning) => void;
  /** 打开/渲染等错误回调。 */
  readonly onError?: (error: ViewerErrorInfo) => void;
  /** 密码能力选项；省略时按默认启用。 */
  readonly crypto?: CryptoViewerOptions;
  /**
   * 字体配置：默认字体、补充字体、自定义加载器与额外别名组。
   *
   * 只在实例创建时生效，修改后需重新 `open()`；字体读取失败只产生 `W_FONT_MISSING`
   * warning，不阻断文档打开。
   */
  readonly fonts?: ViewerFontOptions;
  /**
   * 图层侧栏配置：`enabled`（默认 true，false 时不渲染 tab）、`disabled`（默认 false，
   * true 时保留 tab 但禁用并给出原因提示）、`defaultVisibility`（每页六项可见性默认值，
   * 缺省六项全可见）。
   *
   * 只在实例创建时生效，修改后需重新构造。
   */
  readonly layerPanel?: LayerPanelOptions;
}

/** 图层侧栏配置；类型定义在 `layers/content-filter.ts`，这里再导出供子路径使用。 */
export type { LayerPanelOptions } from './layers/content-filter';

/** 展开默认值后的构造选项；由 `OFDViewer` 内部持有。 */
export interface ResolvedViewerOptions {
  readonly container: HTMLElement | string;
  readonly source?: ViewerSource;
  readonly initialPage: number;
  readonly initialScale: ScaleValue;
  readonly rotation: Rotation;
  readonly sidebar: SidebarView | null;
  readonly features: ViewerFeatures;
  readonly featureDisplay: FeatureDisplay;
  readonly theme: Theme;
  readonly locale: string;
  readonly maxCanvasPixels: number;
  /** 已规范化的超采样设置：预设名或固定倍率。 */
  readonly supersample: SupersamplePreset | number;
  readonly pageCacheSize: number;
  /** 已渲染页 canvas 的总像素预算。 */
  readonly pageCachePixelBudget: number;
  readonly thumbnailCacheSize: number;
  /** 文本层滚动 span 总预算（不含 pin 页）。 */
  readonly textSpanBudget: number;
  /** 选区端点页 pin 的 span 预算。 */
  readonly selectionPinSpanBudget: number;
  /** 单页文本层 span 上限；0 表示不限。 */
  readonly textLayerMaxSpans: number;
  readonly renderConcurrency: number;
  readonly updateHash: boolean;
  readonly requestInit?: RequestInit;
  /** 调试与诊断选项；省略时按默认值（控制台打印开启）。 */
  readonly debug?: DebugViewerOptions;
  readonly onWarning?: (warning: ViewerWarning) => void;
  readonly onError?: (error: ViewerErrorInfo) => void;
  readonly crypto?: CryptoViewerOptions;
  /** 原样透传的字体配置；未提供时为 undefined，行为与未引入 `fonts` 时一致。 */
  readonly fonts?: ViewerFontOptions;
  /** 已解析的图层侧栏配置（六项齐全的默认可见性）。 */
  readonly layerPanel: ResolvedLayerPanelOptions;
}

/** 解析默认值时可用的宿主环境信息。 */
export interface ResolveOptionsEnvironment {
  /** 是否按移动端默认值解析（缓存/并发更小）。 */
  readonly mobile?: boolean;
}

/**
 * 合并构造选项与默认值。
 *
 * 不校验 `container`/`source` 是否存在或合法，也不访问 DOM；这些由 `OFDViewer` 在
 * 构造/打开阶段完成，以便本函数可在测试与模块顶层安全调用。`source` 省略时由阅读器
 * 在打开阶段读取页面查询参数。
 *
 * @param options 宿主传入的选项。
 * @param environment 环境信息；默认按桌面端解析。
 * @returns 带默认值的完整选项。
 */
export function resolveViewerOptions(
  options: OFDViewerOptions,
  environment: ResolveOptionsEnvironment = {},
): ResolvedViewerOptions {
  const mobile = environment.mobile ?? false;
  const featureDisplay =
    typeof options.featureDisplay === 'object' && options.featureDisplay !== null
      ? { ...options.featureDisplay }
      : (options.featureDisplay ?? 'hide');

  return {
    container: options.container,
    source: options.source,
    initialPage: normalizePageNumber(options.initialPage ?? DEFAULT_INITIAL_PAGE),
    initialScale: options.initialScale ?? DEFAULT_INITIAL_SCALE,
    rotation: options.rotation ?? DEFAULT_ROTATION,
    sidebar: options.sidebar ?? null,
    features: { ...options.features },
    featureDisplay,
    theme: options.theme ?? DEFAULT_THEME,
    locale: options.locale ?? DEFAULT_LOCALE,
    maxCanvasPixels:
      options.maxCanvasPixels ??
      (mobile ? DEFAULT_MOBILE_MAX_CANVAS_PIXELS : DEFAULT_MAX_CANVAS_PIXELS),
    supersample: normalizeSupersample(options.supersample),
    pageCacheSize:
      options.pageCacheSize ??
      (mobile ? DEFAULT_MOBILE_PAGE_CACHE_SIZE : DEFAULT_PAGE_CACHE_SIZE),
    pageCachePixelBudget:
      options.pageCachePixelBudget ?? DEFAULT_PAGE_CACHE_PIXEL_BUDGET,
    thumbnailCacheSize: options.thumbnailCacheSize ?? DEFAULT_THUMBNAIL_CACHE_SIZE,
    textSpanBudget:
      Math.max(
        0,
        options.textSpanBudget ??
          (mobile ? DEFAULT_MOBILE_TEXT_SPAN_BUDGET : DEFAULT_TEXT_SPAN_BUDGET),
      ),
    selectionPinSpanBudget:
      Math.max(
        0,
        options.selectionPinSpanBudget ??
          (mobile ? DEFAULT_MOBILE_SELECTION_PIN_SPAN_BUDGET : DEFAULT_SELECTION_PIN_SPAN_BUDGET),
      ),
    textLayerMaxSpans: Math.max(
      0,
      options.textLayerMaxSpans ?? DEFAULT_TEXT_LAYER_MAX_SPANS,
    ),
    renderConcurrency:
      options.renderConcurrency ??
      (mobile ? DEFAULT_MOBILE_RENDER_CONCURRENCY : DEFAULT_RENDER_CONCURRENCY),
    updateHash: options.updateHash ?? false,
    requestInit: options.requestInit,
    debug: options.debug,
    onWarning: options.onWarning,
    onError: options.onError,
    crypto: options.crypto,
    fonts: options.fonts,
    layerPanel: resolveLayerPanelOptions(options.layerPanel),
  };
}

/**
 * 规范化页码：取整且不小于 1。
 *
 * @param value 原始页码，1-based。
 * @returns 合法页码。
 */
function normalizePageNumber(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INITIAL_PAGE;
  return Math.max(1, Math.trunc(value));
}

/**
 * 规范化超采样倍率：限制在 1..4，非法或非正回退默认值。
 *
 * @param value 调用方传入的倍率。
 * @returns 合法倍率。
 */
function normalizeSupersample(
  value: SupersamplePreset | number | undefined,
): SupersamplePreset | number {
  if (value === 'auto' || value === 'off' || value === 'high' || value === 'max') {
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUPERSAMPLE;
  }
  return Math.min(4, Math.max(1, value));
}
