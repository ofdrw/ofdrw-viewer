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

/** 单页 canvas 像素上限（width × height），默认 32MP。 */
export const DEFAULT_MAX_CANVAS_PIXELS = 32_000_000;

/** 桌面端已渲染页 canvas 缓存数量。 */
export const DEFAULT_PAGE_CACHE_SIZE = 10;

/** 移动端已渲染页 canvas 缓存数量。 */
export const DEFAULT_MOBILE_PAGE_CACHE_SIZE = 4;

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
export const DEFAULT_SUPERSAMPLE = 1;

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
  /** 单页 canvas 像素上限，默认 32,000,000。 */
  readonly maxCanvasPixels?: number;
  /**
   * 画布超采样倍率，默认 1（不超采样，按设备像素比 1:1 渲染）。
   *
   * 取值 1 时渲染 DPI = 显示倍率 × DPR，与屏幕物理像素一一对应，流畅且锐利；
   * 大于 1 时按更高分辨率渲染再由 CSS 缩小（像素数按平方增长，会明显增加渲染
   * 耗时与内存，仅在确有需要时开启）。范围 1..4，非法值回退默认。
   */
  readonly supersample?: number;
  /** 已渲染页 canvas 缓存数量；默认桌面 10、移动 4。 */
  readonly pageCacheSize?: number;
  /** 缩略图缓存数量，默认 100。 */
  readonly thumbnailCacheSize?: number;
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
}

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
  /** 已规范化到 1..4 的超采样倍率。 */
  readonly supersample: number;
  readonly pageCacheSize: number;
  readonly thumbnailCacheSize: number;
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
    maxCanvasPixels: options.maxCanvasPixels ?? DEFAULT_MAX_CANVAS_PIXELS,
    supersample: normalizeSupersample(options.supersample),
    pageCacheSize:
      options.pageCacheSize ??
      (mobile ? DEFAULT_MOBILE_PAGE_CACHE_SIZE : DEFAULT_PAGE_CACHE_SIZE),
    thumbnailCacheSize: options.thumbnailCacheSize ?? DEFAULT_THUMBNAIL_CACHE_SIZE,
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
function normalizeSupersample(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUPERSAMPLE;
  }
  return Math.min(4, Math.max(1, value));
}
