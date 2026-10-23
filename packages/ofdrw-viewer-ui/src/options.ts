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

/** 最小缩放倍率（10%）。 */
export const MIN_SCALE = 0.1;

/** 最大缩放倍率（2500%）。 */
export const MAX_SCALE = 25;

/** 预置缩放档位；UI 的 +/- 与下拉菜单共用。 */
export const ZOOM_LEVELS: readonly number[] = Object.freeze([
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 7.5, 10, 15,
  20, 25,
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
  /** 引擎/UI warning 回调。 */
  readonly onWarning?: (warning: ViewerWarning) => void;
  /** 打开/渲染等错误回调。 */
  readonly onError?: (error: ViewerErrorInfo) => void;
  /** 密码能力选项；省略时按默认启用。 */
  readonly crypto?: CryptoViewerOptions;
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
  readonly pageCacheSize: number;
  readonly thumbnailCacheSize: number;
  readonly renderConcurrency: number;
  readonly updateHash: boolean;
  readonly requestInit?: RequestInit;
  readonly onWarning?: (warning: ViewerWarning) => void;
  readonly onError?: (error: ViewerErrorInfo) => void;
  readonly crypto?: CryptoViewerOptions;
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
    pageCacheSize:
      options.pageCacheSize ??
      (mobile ? DEFAULT_MOBILE_PAGE_CACHE_SIZE : DEFAULT_PAGE_CACHE_SIZE),
    thumbnailCacheSize: options.thumbnailCacheSize ?? DEFAULT_THUMBNAIL_CACHE_SIZE,
    renderConcurrency:
      options.renderConcurrency ??
      (mobile ? DEFAULT_MOBILE_RENDER_CONCURRENCY : DEFAULT_RENDER_CONCURRENCY),
    updateHash: options.updateHash ?? false,
    requestInit: options.requestInit,
    onWarning: options.onWarning,
    onError: options.onError,
    crypto: options.crypto,
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