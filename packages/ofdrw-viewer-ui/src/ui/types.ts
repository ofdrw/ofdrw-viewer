/**
 * UI 外壳内部/对外类型。
 *
 * 外壳不实现阅读逻辑：所有交互通过 `UIShellCommand` 交给核心；核心通过
 * `update()`/`setFeatureStates()` 反向刷新控件。
 */
import type {
  FeatureState,
  ViewerFeature,
  ViewerFeatureStates,
} from '../features';
import type { LocalFontsStatus } from '../local-fonts-state';
import type {
  DialogName,
  FindState,
  Rotation,
  SidebarView,
  Theme,
  ToastLevel,
  ViewerToast,
  ZoomMode,
} from '../state';

/** 断点模式：>=1024 / 768–1023 / 480–767 / <480。 */
export type ViewportMode = 'desktop' | 'compact' | 'mobile' | 'narrow';

/** 侧栏布局：常驻 / 覆盖（带遮罩）/ 抽屉。 */
export type SidebarMode = 'inline' | 'overlay' | 'drawer';

/** 工具栏/菜单控件命令；由核心映射到实例方法。 */
export type UIShellCommand =
  | { readonly type: 'sidebar.toggle' }
  | { readonly type: 'sidebar.open'; readonly view: SidebarView }
  | { readonly type: 'sidebar.close' }
  | { readonly type: 'page.go'; readonly page: number }
  | { readonly type: 'page.next' }
  | { readonly type: 'page.previous' }
  | { readonly type: 'zoom.in' }
  | { readonly type: 'zoom.out' }
  | { readonly type: 'zoom.set'; readonly scale: number | ZoomMode }
  | { readonly type: 'rotate.clockwise' }
  | { readonly type: 'find.open' }
  | { readonly type: 'find.close' }
  | {
      readonly type: 'find.query';
      readonly query: string;
      readonly caseSensitive: boolean;
      readonly wholeWord: boolean;
      readonly highlightAll: boolean;
    }
  | { readonly type: 'find.next' }
  | { readonly type: 'find.previous' }
  | { readonly type: 'find.clear' }
  | { readonly type: 'print.open' }
  | { readonly type: 'export.open' }
  | { readonly type: 'signatures.open' }
  | { readonly type: 'fullscreen.set'; readonly value: boolean }
  | { readonly type: 'localFonts.set'; readonly value: boolean }
  | { readonly type: 'document.properties' }
  | { readonly type: 'about.open' };

/** 命令处理器。 */
export type UIShellCommandHandler = (command: UIShellCommand) => void;

/**
 * 外壳需要的最小视图状态。
 *
 * 与 `ViewerState` 的 `view`/`ui` 子集对应；核心在 `statechange` 时把最新快照交给
 * `UIShell.update()`。
 */
export interface UIShellViewState {
  /** 当前页，1-based。 */
  readonly pageNumber: number;
  /** 总页数；未打开时为 0。 */
  readonly pageCount: number;
  /** 实际缩放倍率。 */
  readonly scale: number;
  /** 缩放模式。 */
  readonly zoomMode: ZoomMode;
  /** 旋转角度。 */
  readonly rotation: Rotation;
  /** 打开的侧栏；关闭时为 null。 */
  readonly sidebarView: SidebarView | null;
  /** 是否全屏/沉浸。 */
  readonly fullscreen: boolean;
  /** 查找状态。 */
  readonly find: FindState;
  /** 当前主题。 */
  readonly theme: Theme;
  /** 当前语言。 */
  readonly locale: string;
  /** 文档状态；用于错误/空态提示。 */
  readonly documentStatus?: 'idle' | 'opening' | 'ready' | 'error' | 'closed';
  /** 文档标题。 */
  readonly documentTitle?: string;
  /** 本地字体状态；省略表示宿主未启用该能力（设置面板不出现字体分组）。 */
  readonly localFonts?: LocalFontsStatus;
  /** 图层面板可用性；省略时按可见、可用处理。 */
  readonly layerPanel?: { readonly enabled: boolean; readonly disabled: boolean };
}

/** 外壳结构元素；核心创建的必存在元素可原样传入。 */
export interface UIShellElements {
  readonly root: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly body: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly sidebarMask: HTMLElement;
  readonly main: HTMLElement;
  readonly findbar: HTMLElement;
  readonly dialogLayer: HTMLElement;
  readonly toastLayer: HTMLElement;
  /**
   * 首屏加载占位；可选，缺失时由核心按需补建。
   *
   * 文档已打开但首个可见页尚未画完时覆盖正文区，避免关闭全屏 loading 后留下空白正文。
   */
  readonly loadingArea?: HTMLElement;
}

/** 对话框按钮。 */
export interface UIDialogAction {
  /** 按钮文本。 */
  readonly label: string;
  /** 是否主按钮。 */
  readonly primary?: boolean;
  /** 点击后是否关闭对话框；默认 true。 */
  readonly closeOnClick?: boolean;
  /**
   * 点击回调。
   *
   * 返回 Promise 时对话框会等它 settle 后再关闭，且等待期间按钮不可重复触发
   * （用于「点击后先完成异步授权再关闭」的流程）。
   */
  readonly onClick?: () => void | Promise<unknown>;
}

/** 对话框内容。 */
export interface UIDialogOptions {
  /** 对话框名称，与 `DialogName` 对齐。 */
  readonly name: DialogName;
  /** 标题；省略时使用“提示”。 */
  readonly title?: string;
  /** 描述文本；用于 `aria-describedby`。 */
  readonly description?: string;
  /** 内容节点或纯文本。 */
  readonly content?: Node | string;
  /** 底部按钮；默认只有“关闭”。 */
  readonly actions?: readonly UIDialogAction[];
  /** 是否允许 Esc/遮罩关闭；默认 true。 */
  readonly dismissible?: boolean;
  /** 关闭回调。 */
  readonly onClose?: () => void;
}

/** Toast 选项。 */
export interface UIToastOptions {
  /** 级别；默认 info。 */
  readonly level?: ToastLevel;
  /** 自动关闭时间，单位毫秒；0 表示不自动关闭。默认 5000。 */
  readonly durationMs?: number;
  /** 消息 ID；相同 ID 会替换现有 Toast。 */
  readonly id?: string;
}

/** 侧栏面板上下文；面板渲染函数只读使用。 */
export interface SidebarPanelContext {
  /** 面板对应的视图。 */
  readonly view: SidebarView;
  /** 当前语言。 */
  readonly locale: string;
  /** 读取最新外壳视图状态。 */
  readonly getState: () => Readonly<UIShellViewState>;
}

/** 侧栏面板挂载函数；返回清理函数。 */
export type SidebarPanelMount = (
  host: HTMLElement,
  context: SidebarPanelContext,
) => void | (() => void);

/** 外壳构造选项。 */
export interface UIShellOptions {
  /** 已存在的阅读器根节点（`.ofd-viewer`）。 */
  readonly root: HTMLElement;
  /** 核心提供的结构元素；省略时按 class 查找，仍缺失则补建。 */
  readonly elements?: Partial<UIShellElements>;
  /** 初始语言；默认 `zh-CN`。 */
  readonly locale?: string;
  /** 初始主题；默认沿用根节点 `data-theme`，否则 `auto`。 */
  readonly theme?: Theme;
  /** 功能有效状态；默认全部开启。 */
  readonly featureStates?: ViewerFeatureStates;
  /** 图层面板可用性；省略时按可见、可用处理。 */
  readonly layerPanel?: { readonly enabled: boolean; readonly disabled: boolean };
  /** 初始侧栏；默认 null。 */
  readonly sidebarView?: SidebarView | null;
  /** 初始视图状态补丁。 */
  readonly state?: Partial<UIShellViewState>;
  /** 命令回调。 */
  readonly onCommand?: UIShellCommandHandler;
  /** 断点变化回调；核心可据此调整缓存/并发。 */
  readonly onViewportChange?: (mode: ViewportMode, previous: ViewportMode) => void;
  /** 主题变化回调。 */
  readonly onThemeChange?: (
    theme: Theme,
    resolved: 'light' | 'dark',
  ) => void;
  /** 语言变化回调。 */
  readonly onLocaleChange?: (locale: string) => void;
  /**
   * 是否由 UI 写 `data-viewport` / `data-sidebar-layout`。
   *
   * 集成场景由核心的 ResizeObserver 负责（默认 false）；独立挂载/测试可设 true。
   */
  readonly manageViewport?: boolean;
  /**
   * 是否由 UI 维护侧栏与遮罩的 `hidden`。
   *
   * 集成场景由核心维护（默认 false）；独立挂载/测试可设 true。
   */
  readonly manageSidebarVisibility?: boolean;
}

/** 判断功能是否对内置 UI 可见。 */
export function isFeatureVisible(state: FeatureState | undefined): boolean {
  return state ? state.visible : true;
}

/** 判断功能是否可用。 */
export function isFeatureUsable(
  state: FeatureState | undefined,
): state is FeatureState & { enabled: true } {
  return state ? state.enabled : true;
}

/** 功能状态集合读取；缺失按开启处理。 */
export function readFeatureState(
  states: ViewerFeatureStates,
  feature: ViewerFeature,
): FeatureState | undefined {
  return states[feature];
}