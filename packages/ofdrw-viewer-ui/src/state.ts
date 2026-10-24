/**
 * 阅读器状态模型（设计方案 §3.3）。
 *
 * 状态是只读快照：所有变更由 `OFDViewer` 内部完成，UI 组件只读并触发事件。
 * 页面级渲染状态（generation、Task、canvas）不进入全局状态。
 */

import type {
  BookmarkItem,
  DocumentMetadata,
  OFDSource,
  OutlineNode,
  PageInfo,
  SignatureEntryInfo,
} from '@ofdrw/ofdrw-viewer-engine';
import { createDefaultFeatureStates } from './features';
import type { ViewerFeatureStates } from './features';

/** 文档生命周期状态。 */
export type DocumentStatus = 'idle' | 'opening' | 'ready' | 'error' | 'closed';

/**
 * 原始文档来源信息。
 *
 * URL 与 File 只保留命名所需的信息，不进入网络读取；`blob` 表示没有文件名的
 * 内存 Blob。用于导出命名与后续下载能力。
 */
export type ViewerOrigin =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly name: string }
  | { readonly kind: 'blob' };

/** 缩放模式；`auto` 等价于适合宽度。 */
export type ZoomMode = 'auto' | 'page-actual' | 'page-fit' | 'page-width';

/** 缩放值：数字倍率，或自适应模式。 */
export type ScaleValue = number | ZoomMode;

/** 页面旋转角度，顺时针。 */
export type Rotation = 0 | 90 | 180 | 270;

/** 侧栏视图。 */
export type SidebarView = 'thumbnails' | 'outline' | 'bookmarks' | 'signatures' | 'attachments';

/** 主题。 */
export type Theme = 'light' | 'dark' | 'auto';

/** 内置对话框名称；允许宿主扩展自定义名称。 */
export type DialogName =
  | 'print'
  | 'export'
  | 'documentProperties'
  | 'signatureDetail'
  | (string & {});

/** Toast 级别。 */
export type ToastLevel = 'info' | 'warning' | 'error';

/** 一条 Toast 消息。 */
export interface ViewerToast {
  /** 消息 ID，用于去重与关闭。 */
  readonly id: string;
  /** 展示文案。 */
  readonly message: string;
  /** 级别，决定样式与 aria 角色。 */
  readonly level: ToastLevel;
}

/** 不阻断阅读的诊断信息（引擎 warning 与 UI warning）。 */
export interface ViewerWarning {
  /** 诊断码，例如 `W_SIGNATURE_ASN1`；字符串允许扩展。 */
  readonly code: string;
  /** 人类可读信息。 */
  readonly message: string;
  /** 关联页索引，0-based；与页面无关时省略。 */
  readonly pageIndex?: number;
  /** 关联资源/对象 ID（引擎 `OFDWarning.resourceId`）；与资源无关时省略。 */
  readonly resourceId?: string;
}

/** 打开/渲染等失败信息。 */
export interface ViewerErrorInfo extends ViewerWarning {
  /** 原始错误。 */
  readonly cause?: unknown;
}

/**
 * 可见页范围。
 *
 * 采用内部页索引：`start`/`end` 均为 0-based 且包含端点。
 * 无可见页时 `end < start`。
 */
export interface VisiblePageRange {
  /** 首个可见页索引，0-based。 */
  readonly start: number;
  /** 末个可见页索引，0-based，包含端点。 */
  readonly end: number;
}

/** 查找状态。 */
export interface FindState {
  /** 当前查询；空字符串表示未查找。 */
  readonly query: string;
  /** 当前匹配序号，1-based；无当前匹配时为 0。 */
  readonly current: number;
  /** 匹配总数。 */
  readonly total: number;
  /** 是否仍在搜索。 */
  readonly searching: boolean;
  /** 是否区分大小写。 */
  readonly caseSensitive: boolean;
  /** 是否全词匹配（仅对拉丁文有效）。 */
  readonly wholeWord: boolean;
  /** 是否高亮全部匹配。 */
  readonly highlightAll: boolean;
}

/** 文档状态。 */
export interface DocumentState {
  /** 规范化后的引擎来源；未打开时为 null。 */
  readonly source: OFDSource | null;
  /** 原始来源信息；URL/File 打开时保留，供标题与导出命名。 */
  readonly origin?: ViewerOrigin;
  /** 总页数。 */
  readonly pageCount: number;
  /** 全部页尺寸信息，按页索引升序。 */
  readonly pageInfos: readonly PageInfo[];
  /** 文档属性；未获取或不可用时省略。 */
  readonly metadata?: DocumentMetadata;
  /** 签章摘要（引擎 XML 元数据，不解析 ASN.1）。 */
  readonly signaturesSummary: readonly SignatureEntryInfo[];
  /** 大纲；未加载或为空时省略。 */
  readonly outline?: readonly OutlineNode[];
  /** 书签；未加载或为空时省略。 */
  readonly bookmarks?: readonly BookmarkItem[];
  /** 生命周期状态。 */
  readonly status: DocumentStatus;
}

/** 视图状态。 */
export interface ViewState {
  /** 当前页，1-based。 */
  readonly pageNumber: number;
  /** 当前实际缩放倍率。 */
  readonly scale: number;
  /** 当前缩放模式。 */
  readonly zoomMode: ZoomMode;
  /** 当前旋转角度。 */
  readonly rotation: Rotation;
  /** 打开的侧栏；关闭时为 null。 */
  readonly sidebarView: SidebarView | null;
  /** 是否处于全屏/沉浸模式。 */
  readonly fullscreen: boolean;
  /** 主区域滚动位置，单位 px。 */
  readonly scrollTop: number;
  /** 可见页范围。 */
  readonly visiblePageRange: VisiblePageRange;
  /** 当前选中的文本。 */
  readonly selectedText: string;
  /** 查找状态。 */
  readonly findState: FindState;
}

/** UI 状态。 */
export interface UIState {
  /** 当前主题。 */
  readonly theme: Theme;
  /** 当前语言。 */
  readonly locale: string;
  /** 工具栏是否折叠。 */
  readonly toolbarCollapsed: boolean;
  /** 当前打开的对话框；无对话框时为 null。 */
  readonly dialog: DialogName | null;
  /** 当前 Toast；无 Toast 时为 null。 */
  readonly toast: ViewerToast | null;
  /** 诊断信息列表。 */
  readonly warnings: readonly ViewerWarning[];
  /** 全部功能的有效状态。 */
  readonly features: ViewerFeatureStates;
}

/** 对外只读的阅读器状态快照。 */
export interface ViewerState {
  /** 文档状态。 */
  readonly document: DocumentState;
  /** 视图状态。 */
  readonly view: ViewState;
  /** UI 状态。 */
  readonly ui: UIState;
}

/** 默认主题。 */
export const DEFAULT_THEME: Theme = 'auto';

/** 默认语言。 */
export const DEFAULT_LOCALE = 'zh-CN';

/** 创建空的查找状态。 */
export function createFindState(overrides: Partial<FindState> = {}): FindState {
  return {
    query: '',
    current: 0,
    total: 0,
    searching: false,
    caseSensitive: false,
    wholeWord: false,
    highlightAll: true,
    ...overrides,
  };
}

/** 初始化状态时的可覆盖项。 */
export interface InitialViewerStateOptions {
  /** 当前页，1-based；默认 1。 */
  pageNumber?: number;
  /** 实际缩放倍率；默认 1。 */
  scale?: number;
  /** 缩放模式；默认 `auto`。 */
  zoomMode?: ZoomMode;
  /** 初始旋转；默认 0。 */
  rotation?: Rotation;
  /** 初始侧栏；默认关闭。 */
  sidebarView?: SidebarView | null;
  /** 主题；默认 `auto`。 */
  theme?: Theme;
  /** 语言；默认 `zh-CN`。 */
  locale?: string;
  /** 功能状态；默认全部开启。 */
  features?: ViewerFeatureStates;
}

/**
 * 创建初始状态快照。
 *
 * @param options 初始视图/UI 覆盖项。
 * @returns 未打开文档时的状态。
 */
export function createInitialViewerState(
  options: InitialViewerStateOptions = {},
): ViewerState {
  return {
    document: {
      source: null,
      pageCount: 0,
      pageInfos: [],
      signaturesSummary: [],
      status: 'idle',
    },
    view: {
      pageNumber: options.pageNumber ?? 1,
      scale: options.scale ?? 1,
      zoomMode: options.zoomMode ?? 'auto',
      rotation: options.rotation ?? 0,
      sidebarView: options.sidebarView ?? null,
      fullscreen: false,
      scrollTop: 0,
      visiblePageRange: { start: 0, end: -1 },
      selectedText: '',
      findState: createFindState(),
    },
    ui: {
      theme: options.theme ?? DEFAULT_THEME,
      locale: options.locale ?? DEFAULT_LOCALE,
      toolbarCollapsed: false,
      dialog: null,
      toast: null,
      warnings: [],
      features: options.features ?? createDefaultFeatureStates(),
    },
  };
}