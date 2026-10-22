/**
 * 阅读器构造选项与默认值（设计方案 §4.1）。
 *
 * 这里只处理纯数据解析，不访问 DOM/`window`，便于在模块顶层安全导入。
 */

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

/** 阅读器构造选项。 */
export interface OFDViewerOptions {
  /** 挂载点；字符串按 CSS 选择器解析。 */
  readonly container: HTMLElement | string;
  /** 文档来源。 */
  readonly source: ViewerSource;
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
}

/** 展开默认值后的构造选项；由 `OFDViewer` 内部持有。 */
export interface ResolvedViewerOptions {
  readonly container: HTMLElement | string;
  readonly source: ViewerSource;
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
 * 构造/打开阶段完成，以便本函数可在测试与模块顶层安全调用。
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