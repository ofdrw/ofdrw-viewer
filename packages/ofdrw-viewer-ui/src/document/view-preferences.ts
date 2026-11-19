/**
 * Document.xml 视图首选项（VPreferences）解码与应用值推导（GB/T 33190-2016 表 9）。
 *
 * 引擎当前不解码该节点，阅读器需要按文档声明设置初始缩放、侧栏、工具栏与标题栏。
 * 本模块只做“XML 节点 → 期望值”的换算与合法性校验；实际设置阅读器状态由
 * `viewer.ts` 在打开流程中完成。
 */

import type { ZoomMode } from '../state';
import { childNode, nodeText, type DeclarationsXmlNode } from './xml-node';

// ---------------------------------------------------------------------------
// 取值类型（表 9）
// ---------------------------------------------------------------------------

/** `PageMode` 取值：窗口模式。 */
export type ViewPageMode =
  | 'None'
  | 'FullScreen'
  | 'UseOutlines'
  | 'UseThumbs'
  | 'UseCustomTags'
  | 'UseLayers'
  | 'UseAttaches'
  | 'UseBookmarks';

/** `PageLayout` 取值：页面布局模式。 */
export type ViewPageLayout =
  | 'OnePage'
  | 'OneColumn'
  | 'TwoPageL'
  | 'TwoColumnL'
  | 'TwoPageR'
  | 'TwoColumnR';

/** `TabDisplay` 取值：标题栏显示模式。 */
export type ViewTabDisplay = 'FileName' | 'DocTitle';

/** `ZoomMode` 取值：自动缩放模式。 */
export type ViewZoomMode = 'Default' | 'FitHeight' | 'FitWidth' | 'FitRect';

/** 视图首选项；字段缺失表示文档未声明。 */
export interface ViewPreferences {
  /** 窗口模式；默认 `None`。 */
  pageMode?: ViewPageMode;
  /** 页面布局模式；默认 `OneColumn`。 */
  pageLayout?: ViewPageLayout;
  /** 标题栏显示模式；默认 `FileName`。 */
  tabDisplay?: ViewTabDisplay;
  /** 是否隐藏工具栏；默认 false。 */
  hideToolbar?: boolean;
  /** 是否隐藏菜单栏；默认 false。 */
  hideMenuBar?: boolean;
  /** 是否隐藏主窗口之外的其他窗体组件；默认 false。 */
  hideWindowUI?: boolean;
  /** 自动缩放模式；默认 `Default`。 */
  zoomMode?: ViewZoomMode;
  /** 缩放率；1 = 100%。 */
  zoom?: number;
}

/** 各枚举字段的合法取值。 */
const PAGE_MODES: readonly ViewPageMode[] = [
  'None',
  'FullScreen',
  'UseOutlines',
  'UseThumbs',
  'UseCustomTags',
  'UseLayers',
  'UseAttaches',
  'UseBookmarks',
];
const PAGE_LAYOUTS: readonly ViewPageLayout[] = [
  'OnePage',
  'OneColumn',
  'TwoPageL',
  'TwoColumnL',
  'TwoPageR',
  'TwoColumnR',
];
const TAB_DISPLAYS: readonly ViewTabDisplay[] = ['FileName', 'DocTitle'];
const ZOOM_MODES: readonly ViewZoomMode[] = ['Default', 'FitHeight', 'FitWidth', 'FitRect'];

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

/**
 * 解码 `VPreferences` 节点。
 *
 * 枚举取值大小写不敏感；非法取值与非法数值上报 warning 后忽略（按未声明处理）。
 *
 * @param node `VPreferences` 节点。
 * @param options warning 回调。
 * @returns 视图首选项；节点内没有任何有效字段时 undefined。
 */
export function readViewPreferences(
  node: DeclarationsXmlNode | undefined,
  options: { readonly onWarning?: (message: string) => void } = {},
): ViewPreferences | undefined {
  if (!node) return undefined;
  const warn = options.onWarning;
  const result: ViewPreferences = {};
  const pageMode = readEnum(node, 'PageMode', PAGE_MODES, warn);
  if (pageMode) result.pageMode = pageMode;
  const pageLayout = readEnum(node, 'PageLayout', PAGE_LAYOUTS, warn);
  if (pageLayout) result.pageLayout = pageLayout;
  const tabDisplay = readEnum(node, 'TabDisplay', TAB_DISPLAYS, warn);
  if (tabDisplay) result.tabDisplay = tabDisplay;
  const hideToolbar = readBoolean(node, 'HideToolbar', warn);
  if (hideToolbar !== undefined) result.hideToolbar = hideToolbar;
  // 标准写作 `HideMenubar`，部分实现写作 `HideMenuBar`；两种拼写都接受。
  const hideMenuBar =
    readBoolean(node, 'HideMenubar', warn) ?? readBoolean(node, 'HideMenuBar', warn);
  if (hideMenuBar !== undefined) result.hideMenuBar = hideMenuBar;
  const hideWindowUI = readBoolean(node, 'HideWindowUI', warn);
  if (hideWindowUI !== undefined) result.hideWindowUI = hideWindowUI;
  const zoomMode = readEnum(node, 'ZoomMode', ZOOM_MODES, warn);
  if (zoomMode) result.zoomMode = zoomMode;
  const zoom = readZoom(node, warn);
  if (zoom !== undefined) result.zoom = zoom;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 读取枚举子节点；缺失或非法返回 undefined。 */
function readEnum<T extends string>(
  node: DeclarationsXmlNode,
  name: string,
  allowed: readonly T[],
  onWarning: ((message: string) => void) | undefined,
): T | undefined {
  const raw = nodeText(childNode(node, name));
  if (raw === '') return undefined;
  const match = allowed.find((value) => value.toLowerCase() === raw.toLowerCase());
  if (match) return match;
  onWarning?.(`VPreferences.${name} 取值非法：${JSON.stringify(raw)}，已忽略`);
  return undefined;
}

/** 读取布尔子节点；缺失或非法返回 undefined。 */
function readBoolean(
  node: DeclarationsXmlNode,
  name: string,
  onWarning: ((message: string) => void) | undefined,
): boolean | undefined {
  const raw = nodeText(childNode(node, name)).toLowerCase();
  if (raw === '') return undefined;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  onWarning?.(`VPreferences.${name} 取值非法：${JSON.stringify(raw)}，已忽略`);
  return undefined;
}

/** 读取缩放率；非正数/非有限数视为非法。 */
function readZoom(
  node: DeclarationsXmlNode,
  onWarning: ((message: string) => void) | undefined,
): number | undefined {
  const raw = nodeText(childNode(node, 'Zoom'));
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    onWarning?.(`VPreferences.Zoom 取值非法：${JSON.stringify(raw)}，已忽略`);
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 应用值换算
// ---------------------------------------------------------------------------

/** 可由视图首选项自动打开的侧栏视图。 */
export type PreferenceSidebarView =
  | 'thumbnails'
  | 'outline'
  | 'bookmarks'
  | 'attachments'
  | 'layers'
  | 'signatures';

/**
 * 视图首选项换算出的阅读器初始视图要求。
 *
 * 字段为 undefined 表示文档未声明该侧要求，阅读器回落到宿主配置。
 */
export interface ViewPreferenceIntents {
  /** 初始缩放模式。 */
  zoomMode?: ZoomMode;
  /** 固定初始倍率；1 = 100%，已按阅读器倍率上下限（0.25–10）夹取。 */
  zoom?: number;
  /** 需要自动打开的侧栏视图。 */
  sidebar?: PreferenceSidebarView;
  /** 进入全屏（`PageMode=FullScreen`）。 */
  fullscreen?: boolean;
  /** 隐藏工具栏（`HideToolbar`）。 */
  hideToolbar?: boolean;
  /** 隐藏主窗口之外的窗体组件（`HideWindowUI`）。 */
  hideWindowUI?: boolean;
  /** 标题栏使用文档标题（`TabDisplay=DocTitle` 且文档存在标题）。 */
  useDocumentTitle?: boolean;
  /** 文档声明的页面布局模式。 */
  pageLayout?: ViewPageLayout;
}

/**
 * 把视图首选项换算为阅读器的初始视图。
 *
 * 换算规则：
 * - `FitWidth` → 适合宽度；`FitHeight`/`FitRect` → 适合页面；
 * - `Zoom` 只在 `ZoomMode` 为 `Default` 或未声明时作为固定倍率生效；
 * - `UseOutlines`/`UseThumbs`/`UseBookmarks`/`UseAttaches`/`UseLayers` 打开对应
 *   侧栏；`FullScreen` 进入全屏；`None`/`UseCustomTags` 不施加要求；
 * - `TabDisplay=DocTitle` 且文档存在 `DocInfo/Title` 时使用文档标题（表 9 规定无
 *   标题时按 `FileName` 处理，因此需要调用方传入 `hasTitle`）。
 *
 * @param preferences 视图首选项。
 * @param hasTitle 文档是否存在 `DocInfo/Title`。
 * @returns 初始视图要求；无有效字段时为空对象。
 */
export function resolveViewPreferenceIntents(
  preferences: ViewPreferences | undefined,
  hasTitle: boolean,
): ViewPreferenceIntents {
  const intents: ViewPreferenceIntents = {};
  if (!preferences) return intents;
  const zoomMode = preferences.zoomMode;
  if (zoomMode === 'FitWidth') intents.zoomMode = 'page-width';
  else if (zoomMode === 'FitHeight' || zoomMode === 'FitRect') intents.zoomMode = 'page-fit';
  if (preferences.zoom !== undefined && (zoomMode === undefined || zoomMode === 'Default')) {
    intents.zoom = Math.min(10, Math.max(0.25, preferences.zoom));
  }
  switch (preferences.pageMode) {
    case 'UseOutlines':
      intents.sidebar = 'outline';
      break;
    case 'UseThumbs':
      intents.sidebar = 'thumbnails';
      break;
    case 'UseBookmarks':
      intents.sidebar = 'bookmarks';
      break;
    case 'UseAttaches':
      intents.sidebar = 'attachments';
      break;
    case 'UseLayers':
      intents.sidebar = 'layers';
      break;
    case 'FullScreen':
      intents.fullscreen = true;
      break;
    default:
      // `None` 是默认值、`UseCustomTags`（语义结构）阅读器未实现：均不施加要求。
      break;
  }
  if (preferences.hideToolbar === true) intents.hideToolbar = true;
  if (preferences.hideWindowUI === true) intents.hideWindowUI = true;
  if (preferences.tabDisplay === 'DocTitle' && hasTitle) intents.useDocumentTitle = true;
  if (preferences.pageLayout) intents.pageLayout = preferences.pageLayout;
  return intents;
}

// ---------------------------------------------------------------------------
// 权限生效判定（表 8）
// ---------------------------------------------------------------------------

/** 权限声明中与阅读器行为相关的输入子集。 */
export interface PermissionEffectsInput {
  readonly print?: { readonly printable: boolean; readonly copies?: number };
  readonly printScreen?: boolean;
  readonly signature?: boolean;
  readonly watermark?: boolean;
  readonly validPeriod?: { readonly start?: string; readonly end?: string };
}

/** 权限声明的生效结论。 */
export interface PermissionEffects {
  /** 是否禁止打印（`Printable=false` 或 `Copies=0`）。 */
  printBlocked: boolean;
  /** 允许的打印份数；省略表示不限。 */
  printCopies?: number;
  /** 是否允许复制文本/截屏（`PrintScreen`）；默认 true。 */
  allowCopy: boolean;
  /** 是否允许电子签章/数字签名（`Signature`）；默认 true。 */
  allowSignature: boolean;
  /** 是否允许添加水印（`Watermark`）；默认 true。 */
  allowWatermark: boolean;
  /** 有效期是否已过期（`ValidPeriod@EndDate` 早于当前时间）。 */
  expired: boolean;
}

/**
 * 由权限声明推导生效结论。
 *
 * `Copies` 语义（表 8）：未声明表示不限；负数表示不限；`0` 表示不允许打印；正数为
 * 实际可打印份数。未声明 `Permissions` 节点时全部按允许处理。
 *
 * @param permissions 文档权限声明；包含 `printable`（引擎权限）与补全的声明字段。
 * @param now 当前时间，单位毫秒；默认 `Date.now()`。
 * @returns 生效结论。
 */
export function resolvePermissionEffects(
  permissions: PermissionEffectsInput | undefined,
  now: number = Date.now(),
): PermissionEffects {
  const copies = permissions?.print?.copies;
  const printBlocked = permissions?.print?.printable === false || copies === 0;
  return {
    printBlocked,
    ...(copies !== undefined && copies > 0 ? { printCopies: copies } : {}),
    allowCopy: permissions?.printScreen !== false,
    allowSignature: permissions?.signature !== false,
    allowWatermark: permissions?.watermark !== false,
    expired: isExpired(permissions?.validPeriod?.end, now),
  };
}

/** 一天对应的毫秒数。 */
const MS_PER_DAY = 86_400_000;

/**
 * 判断有效期是否已过期。
 *
 * 结束日期按 `xs:dateTime` 解析；只给日期（`YYYY-MM-DD`）时按当天 23:59:59.999 结束，
 * 与 `xs:date` 的“含当天”语义一致。无法解析时按未过期处理。
 *
 * @param end 结束日期原文。
 * @param now 当前时间，单位毫秒。
 * @returns 已过期返回 true。
 */
function isExpired(end: string | undefined, now: number): boolean {
  const raw = (end ?? '').trim();
  if (raw === '') return false;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return false;
  const endMs = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? timestamp + MS_PER_DAY - 1 : timestamp;
  return now > endMs;
}
