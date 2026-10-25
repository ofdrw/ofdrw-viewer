/**
 * Web Component、React、Vue 三种薄适配共用的桥接工具。
 *
 * 本模块只做事件名映射、属性解析与轻量类型收窄，不复制阅读器逻辑；所有实例
 * 行为仍由公共入口导出的 `OFDViewer` 提供。
 */
import type {
  FontSource,
  OFDViewer,
  ViewerEventMap,
  ViewerEventName,
  ViewerSource,
  ViewerState,
} from '../index';
import { SIDEBAR_VIEWS } from '../state';

/** 旋转角度；与核心 `Rotation` 同构。 */
export type Rotation = ViewerState['view']['rotation'];

/** 侧栏视图；与核心 `SidebarView` 同构。 */
export type SidebarView = NonNullable<ViewerState['view']['sidebarView']>;

/** 主题；与核心 `Theme` 同构。 */
export type Theme = ViewerState['ui']['theme'];

/** 缩放模式；与核心 `ZoomMode` 同构。 */
export type ZoomMode = ViewerState['view']['zoomMode'];

/** 缩放值：数字倍率或自适应模式。 */
export type ScaleValue = number | ZoomMode;

/** 功能开关补丁。 */
export type ViewerFeatures = Partial<Record<keyof ViewerState['ui']['features'], boolean>>;

/** 功能展示方式。 */
export type FeatureDisplay =
  | 'hide'
  | 'disable'
  | Partial<Record<keyof ViewerState['ui']['features'], 'hide' | 'disable'>>;

/** 一条事件在核心/Web Component/React/Vue 中的命名。 */
export interface ViewerEventBridge {
  /** 核心事件名。 */
  readonly event: ViewerEventName;
  /** Web Component 派发的 CustomEvent 名称。 */
  readonly dom: string;
  /** React 回调属性名。 */
  readonly react: string;
  /** Vue emits 名称（kebab-case）。 */
  readonly vue: string;
}

/**
 * 全部核心事件到各适配层命名的映射。
 *
 * 页面变化统一映射为 `page-change`（而不是核心的 `pagechanging`），其余事件按
 * 单词边界拆分为 kebab-case，保持设计方案 §4.4 / §14.6.1 的语义。
 */
export const VIEWER_EVENT_BRIDGES = [
  { event: 'documentopen', dom: 'ofd-document-open', react: 'onDocumentOpen', vue: 'document-open' },
  { event: 'documentclose', dom: 'ofd-document-close', react: 'onDocumentClose', vue: 'document-close' },
  { event: 'pagechanging', dom: 'ofd-page-change', react: 'onPageChange', vue: 'page-change' },
  { event: 'pagerendered', dom: 'ofd-page-rendered', react: 'onPageRendered', vue: 'page-rendered' },
  { event: 'pagesloaded', dom: 'ofd-pages-loaded', react: 'onPagesLoaded', vue: 'pages-loaded' },
  { event: 'scalechanging', dom: 'ofd-scale-change', react: 'onScaleChange', vue: 'scale-change' },
  {
    event: 'rotationchanging',
    dom: 'ofd-rotation-change',
    react: 'onRotationChange',
    vue: 'rotation-change',
  },
  {
    event: 'sidebarviewchanged',
    dom: 'ofd-sidebar-view-change',
    react: 'onSidebarViewChange',
    vue: 'sidebar-view-change',
  },
  { event: 'findstart', dom: 'ofd-find-start', react: 'onFindStart', vue: 'find-start' },
  { event: 'findmatches', dom: 'ofd-find-matches', react: 'onFindMatches', vue: 'find-matches' },
  { event: 'findcurrent', dom: 'ofd-find-current', react: 'onFindCurrent', vue: 'find-current' },
  {
    event: 'selectionchange',
    dom: 'ofd-selection-change',
    react: 'onSelectionChange',
    vue: 'selection-change',
  },
  {
    event: 'signatureclick',
    dom: 'ofd-signature-click',
    react: 'onSignatureClick',
    vue: 'signature-click',
  },
  {
    event: 'verificationcompleted',
    dom: 'ofd-verification-completed',
    react: 'onVerificationCompleted',
    vue: 'verification-completed',
  },
  { event: 'printstart', dom: 'ofd-print-start', react: 'onPrintStart', vue: 'print-start' },
  {
    event: 'printprogress',
    dom: 'ofd-print-progress',
    react: 'onPrintProgress',
    vue: 'print-progress',
  },
  { event: 'printend', dom: 'ofd-print-end', react: 'onPrintEnd', vue: 'print-end' },
  {
    event: 'exportprogress',
    dom: 'ofd-export-progress',
    react: 'onExportProgress',
    vue: 'export-progress',
  },
  { event: 'warning', dom: 'ofd-warning', react: 'onWarning', vue: 'warning' },
  { event: 'error', dom: 'ofd-error', react: 'onError', vue: 'error' },
  {
    event: 'featureschange',
    dom: 'ofd-features-change',
    react: 'onFeaturesChange',
    vue: 'features-change',
  },
  // 本机字体开关/权限/加载状态变化；Web Component 直接派发，React/Vue 由同一张表生成。
  {
    event: 'local-fonts:change',
    dom: 'ofd-local-fonts-change',
    react: 'onLocalFontsChange',
    vue: 'local-fonts-change',
  },
  { event: 'statechange', dom: 'ofd-state-change', react: 'onStateChange', vue: 'state-change' },
] as const satisfies readonly ViewerEventBridge[];

/** React 事件回调属性名联合。 */
export type ReactViewerEventName = (typeof VIEWER_EVENT_BRIDGES)[number]['react'];

/** Vue emits 名称联合。 */
export type VueViewerEventName = (typeof VIEWER_EVENT_BRIDGES)[number]['vue'];

/**
 * 由核心事件名读取桥接信息。
 *
 * @param event 核心事件名。
 * @returns 桥接信息；未知事件返回 undefined。
 */
export function findEventBridge(event: ViewerEventName): ViewerEventBridge | undefined {
  return VIEWER_EVENT_BRIDGES.find((bridge) => bridge.event === event);
}

/**
 * 把核心事件名转换为 Web Component 的 CustomEvent 名称。
 *
 * @param event 核心事件名。
 * @returns `ofd-*` 名称；未知事件回退为 `ofd-<event>`。
 */
export function toDomEventName(event: ViewerEventName): string {
  return findEventBridge(event)?.dom ?? `ofd-${event}`;
}

/** 仅暴露订阅能力的最小结构；用于绕开联合事件名的泛型限制。 */
interface ViewerEventSource {
  on(event: string, handler: (payload: unknown) => void): () => void;
}

/**
 * 把核心全部事件桥接到一个监听函数。
 *
 * @param viewer 阅读器实例。
 * @param listener 事件名与原始载荷的回调。
 * @returns 取消全部订阅的函数。
 */
export function bindViewerEvents(
  viewer: OFDViewer,
  listener: (event: ViewerEventName, payload: unknown) => void,
): () => void {
  const source = viewer as unknown as ViewerEventSource;
  const cleanups = VIEWER_EVENT_BRIDGES.map((bridge) =>
    source.on(bridge.event, (payload) => listener(bridge.event, payload)),
  );
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * 为 React 的属性类型生成逐事件回调映射。
 *
 * 不额外导出运行时代码，仅用于 `OFDViewerProps` 的类型声明。
 */
export type ViewerEventHandlers = {
  [Bridge in (typeof VIEWER_EVENT_BRIDGES)[number] as Bridge['react']]?: (
    payload: ViewerEventMap[Bridge['event']],
  ) => void;
};

/**
 * 解析数字属性。
 *
 * @param value 属性值或属性名。
 * @param element 可选的元素；提供时按属性名读取。
 * @returns 有限数字；缺失或非法时返回 undefined。
 */
export function readNumber(
  value: string | null | undefined,
  element?: HTMLElement,
  attribute?: string,
): number | undefined {
  const raw = element && attribute ? element.getAttribute(attribute) : value;
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 解析缩放属性；支持数字倍率与四种缩放模式。
 *
 * @param element 自定义元素。
 * @param attribute 属性名，默认 `scale`。
 * @returns 缩放值；非法时返回 undefined。
 */
export function readScaleAttribute(
  element: HTMLElement,
  attribute = 'scale',
): ScaleValue | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null || raw.trim() === '') return undefined;
  if (isZoomMode(raw)) return raw;
  return readNumber(raw);
}

/**
 * 判断值是否为缩放模式。
 *
 * @param value 待判断值。
 * @returns 是缩放模式时 true。
 */
export function isZoomMode(value: unknown): value is ZoomMode {
  return (
    value === 'auto' || value === 'page-actual' || value === 'page-fit' || value === 'page-width'
  );
}

/**
 * 判断值是否为主题。
 *
 * @param value 待判断值。
 * @returns 是主题时 true。
 */
export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'auto';
}

/**
 * 判断值是否为侧栏视图。
 *
 * @param value 待判断值。
 * @returns 是侧栏视图时 true。
 */
export function isSidebarView(value: unknown): value is SidebarView {
  // 复用 state.ts 的单一清单，避免适配层与核心各维护一份视图白名单。
  return typeof value === 'string' && (SIDEBAR_VIEWS as readonly string[]).includes(value);
}

/**
 * 把任意数字规范为 0/90/180/270。
 *
 * @param value 角度，单位度。
 * @returns 合法旋转角度；非法时返回 undefined。
 */
export function toRotation(value: unknown): Rotation | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = ((Math.trunc(value / 90) * 90) % 360 + 360) % 360;
  return normalized as Rotation;
}

/**
 * 读取旋转属性。
 *
 * @param element 自定义元素。
 * @returns 旋转角度；缺失或非法时返回 undefined。
 */
export function readRotationAttribute(element: HTMLElement): Rotation | undefined {
  return toRotation(readNumber(element.getAttribute('rotation')));
}

/**
 * 读取侧栏属性；空字符串表示关闭。
 *
 * @param element 自定义元素。
 * @returns 侧栏视图、null（关闭）或 undefined（未配置/非法）。
 */
export function readSidebarAttribute(element: HTMLElement): SidebarView | null | undefined {
  const raw = element.getAttribute('sidebar');
  if (raw === null) return undefined;
  const normalized = raw.trim();
  if (normalized === '' || normalized === 'none' || normalized === 'off') return null;
  return isSidebarView(normalized) ? normalized : undefined;
}

/**
 * 解析逗号分隔的字体 URL 属性。
 *
 * 用于 `<ofd-viewer font-default="..." font-supplementary="...">`：按英文逗号切分，
 * 逐项去除首尾空白并丢弃空项，最终映射为 `[{ url }]`。
 *
 * @param element 自定义元素。
 * @param attribute 属性名，例如 `font-default`。
 * @returns 字体来源数组；属性缺失或没有任何有效 URL 时返回 undefined。
 */
export function readFontAttribute(
  element: HTMLElement,
  attribute: string,
): FontSource[] | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null) return undefined;
  const urls = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (urls.length === 0) return undefined;
  return urls.map((url) => ({ url }));
}

/**
 * 合并功能补丁。
 *
 * @param current 当前功能对象。
 * @param patch 新补丁。
 * @returns 新对象，不修改入参。
 */
export function mergeFeatures(
  current: ViewerFeatures | undefined,
  patch: ViewerFeatures,
): ViewerFeatures {
  return { ...current, ...patch };
}

/**
 * 判断来源是否可直接打开。
 *
 * @param source 宿主来源。
 * @returns 非空时 true。
 */
export function isUsableSource(source: ViewerSource | null | undefined): source is ViewerSource {
  if (source === null || source === undefined) return false;
  if (typeof source === 'string') return source.trim() !== '';
  return true;
}