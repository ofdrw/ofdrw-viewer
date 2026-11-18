/**
 * 动作模块内部类型（UI 动作处理机制设计 §4.2 / §7.1）。
 *
 * 这里只放 `src/actions/` 各文件共享的实现类型；对外公开的事件载荷与状态定义在
 * `../types.ts` 与 `../state.ts`，引擎数据结构直接复用 `@ofdrw/ofdrw-viewer-engine`。
 */

import type { ActionInfo, PageInfo } from '@ofdrw/ofdrw-viewer-engine';
import type { PageView } from '../page-view';
import type { Rotation, ViewerState } from '../state';
import type { MessageKey, Translator } from '../i18n';
import type {
  ActionErrorEvent,
  ActionExecutedEvent,
  ActionSkippedEvent,
  MediaErrorEvent,
  MediaStateEvent,
  ViewerEventMap,
  ViewerEventHandler,
  ViewerEventName,
} from '../types';
import type { ViewerFeature } from '../features';

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

/**
 * 96 DPI 页面像素矩形（原点为页面左上角，y 向下）。
 *
 * 与文本层、`getActionGeometry({ dpi: 96 })` 的输出同一口径；页面旋转与缩放由
 * 页面容器的 CSS transform 承担，这里恒为未旋转的页面像素。
 */
export interface ActionBox {
  /** 左边界，单位 px。 */
  readonly left: number;
  /** 上边界，单位 px。 */
  readonly top: number;
  /** 宽度，单位 px。 */
  readonly width: number;
  /** 高度，单位 px。 */
  readonly height: number;
}

/** 页面 px 坐标点。 */
export interface ActionPoint {
  /** x 坐标，单位 px。 */
  readonly x: number;
  /** y 坐标，单位 px。 */
  readonly y: number;
}

/**
 * 单个可点击动作的命中项。
 *
 * 命中只按 `bbox` 外接矩形判定（设计 §14 决策 6：不做精确路径命中）。`source` 记录
 * 几何来源，便于诊断。
 */
export interface ClickHitItem {
  /** 动作本身。 */
  readonly action: ActionInfo;
  /** 外接矩形（页面像素），命中判定范围。 */
  readonly bbox: ActionBox;
  /** 几何来源：显式区域 / 图元外观 / 页面区域。 */
  readonly source: 'region' | 'object' | 'page';
  /**
   * 宿主绘制序权重，数值越大越靠上。
   *
   * 同一宿主的全部 CLICK 动作共享同一权重：一次点击执行该宿主的全部动作。
   * 命中时从大到小取第一个，使「后绘制者优先」，与视觉层叠一致。
   */
  readonly paintOrder: number;
}

/** 单页的 CLICK 命中项集合。 */
export interface ClickHitTable {
  /** 命中项，按 `paintOrder` 降序（靠上的在前），供线性扫描。 */
  readonly items: readonly ClickHitItem[];
}

// ---------------------------------------------------------------------------
// 页动作集合与缓存
// ---------------------------------------------------------------------------

/** 单页的动作集合（设计 §4.2）。 */
export interface PageActionSet {
  /** `PO` 动作，页面首次可见且渲染完成后执行一次。 */
  readonly pageOpen: readonly ActionInfo[];
  /** `CLICK` 命中表；无 CLICK 动作时省略。 */
  readonly click?: ClickHitTable;
  /**
   * 是否已执行过 `PO`。
   *
   * 缓存内的副本会随页淘汰失效；真正的「每页一次」由服务层的
   * `pageOpenDonePages` 跨淘汰保证。
   */
  readonly pageOpenDone: boolean;
}

/** 同一宿主的动作分组；用于计算绘制序与组内动作顺序。 */
export interface ActionOwnerGroup {
  /** 宿主分组键；同一图元的多个动作共享同一键。 */
  readonly key: string;
  /** 组内动作，按文档顺序。 */
  readonly actions: readonly ActionInfo[];
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/** 动作执行结果（设计 §7.1）。 */
export type ActionOutcome = 'executed' | 'skipped' | 'cancelled' | 'failed';

/** 触发来源；决定呈现模式与是否受自动执行开关控制。 */
export type ActionTrigger = 'DO' | 'PO' | 'CLICK' | 'HOST';

/** 触发图元锚点；用于弹出式窗口定位与高亮。 */
export interface ActionAnchor {
  /** 图元 ID；无 ID 图元省略。 */
  readonly objectId?: string;
  /** 图元矩形（96 DPI 页面像素）。 */
  readonly bbox: ActionBox;
}

/** 动作执行上下文（设计 §7.1）。 */
export interface ActionExecutionContext {
  /** 触发来源。 */
  readonly trigger: ActionTrigger;
  /** 触发页索引，0-based；文档级触发为 0。 */
  readonly pageIndex: number;
  /** 触发图元锚点；页级/文档级触发省略。 */
  readonly anchor?: ActionAnchor;
  /** 取消信号；文档关闭或页淘汰时中止。 */
  readonly signal?: AbortSignal;
}

/**
 * 单个动作的处理结果。
 *
 * handler 返回该结构而不是裸 `ActionOutcome`：跳过/失败需要携带原因，供
 * `action:skipped` / `action:error` 事件使用。
 */
export interface ActionHandlerResult {
  /** 执行结果。 */
  readonly outcome: ActionOutcome;
  /** 跳过原因；`outcome === 'skipped'` 时出现。 */
  readonly skipReason?: ActionSkippedEvent['reason'];
  /** 错误码；`outcome === 'failed'` 时出现。 */
  readonly code?: string;
  /** 失败原因分类；`outcome === 'failed'` 时可省略。 */
  readonly errorReason?: ActionErrorEvent['reason'];
  /** 诊断信息；失败/跳过时可选。 */
  readonly message?: string;
  /** URI 动作的实际打开方式；`action:executed` 事件透出。 */
  readonly target?: string;
  /** 是否需要阻塞后续动作直到播放结束（`Sound@Synchronous`）。 */
  readonly waitForEnd?: Promise<void>;
}

/** 动作 handler；单一动作 → 执行结果。 */
export interface ActionHandler {
  /**
   * 执行单个动作。
   *
   * @param context 执行上下文。
   * @param action 动作。
   * @returns 执行结果；不抛错，失败以 `outcome === 'failed'` 表达。
   */
  (context: ActionExecutionContext, action: ActionInfo): Promise<ActionHandlerResult>;
}

/**
 * URI 外部访问确认请求（UI 动作处理机制设计 §8.3）。
 *
 * 确认框必须展示**完整 URL** 与**主机名**，用 `role="alertdialog"`，默认焦点落在
 * 「取消」上，防误触确认。
 */
export interface UriConfirmRequest {
  /** 完整目标地址（已解析，含协议与查询串）。 */
  readonly url: string;
  /** 主机名，单独强调显示，便于用户判断可信度。 */
  readonly host: string;
  /** 打开方式：`_self` 为当前窗口跳转，`_blank` 为新窗口。 */
  readonly target: '_self' | '_blank';
}

/**
 * URI 外部访问确认函数。
 *
 * @param request 确认请求。
 * @returns 用户确认时 resolve true；取消/关闭时 resolve false。
 */
export type UriConfirmer = (request: UriConfirmRequest) => Promise<boolean>;

// ---------------------------------------------------------------------------
// 宿主能力
// ---------------------------------------------------------------------------

/** 动作模块依赖的阅读器最小能力；`OFDViewer` 结构兼容。 */
export interface ActionViewerHost {
  /** 最新状态快照。 */
  getState(): ViewerState;
  /** 订阅核心事件；返回退订函数。 */
  on<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): () => void;
  /** 阅读器根节点。 */
  getRoot(): HTMLElement;
  /** 核心结构元素。 */
  getElements(): {
    readonly root: HTMLElement;
    readonly main: HTMLElement;
    readonly dialogLayer: HTMLElement;
    readonly toastLayer: HTMLElement;
  };
  /** 底层引擎文档；未打开时为 null。 */
  getDocument(): object | null;
  /** 全部页信息。 */
  getPageInfos(): readonly PageInfo[];
  /** 当前页码，1-based。 */
  getPageNumber(): number;
  /** 当前缩放倍率。 */
  getScale(): number;
  /** 当前旋转角度。 */
  getRotation(): Rotation;
  /** 读取页视图；页码 1-based。 */
  getPageView(pageNumber: number): PageView | undefined;
  /** 全部页视图。 */
  getPageViews(): readonly PageView[];
  /** 跳转到指定页。 */
  goToPage(
    pageNumber: number,
    options?: { readonly smooth?: boolean; readonly offsetPx?: number },
  ): void;
  /** 设置缩放倍率。 */
  setScale(scale: number): void;
  /** 设置缩放模式。 */
  setZoomMode(mode: ViewerState['view']['zoomMode']): void;
  /** 判断功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean;
  /** 读取当前翻译器。 */
  getTranslator(): Translator;
  /** 读取当前打开文档的原始字节；用于超限媒体的「下载原文件」降级。 */
  readSourceBytes?(signal?: AbortSignal): Promise<Uint8Array>;
  /** 读取完整文档信息快照；用于附件下载。 */
  getDocumentInfo?(): Promise<unknown>;
}

/**
 * 动作模块与核心之间的桥接。
 *
 * 核心的 `patchUI` / `emit` / `warn` 是私有方法；动作模块作为内置扩展通过结构化
 * 内部接口复用它们（与 `text/viewer-bridge.ts` 同一做法）。缺失时降级为本地空操作，
 * 便于测试替身与未来公开接口替换。
 */
export interface ActionBridge {
  /** 写入动作状态。 */
  patchActions(patch: Partial<ViewerState['actions']>): void;
  /** 提交状态并派发 `statechange`。 */
  commit(): void;
  /** 派发事件。 */
  emit<K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]): void;
  /** 上报 warning。 */
  warn(code: string, message: string, pageIndex?: number): void;
  /** 读取翻译器。 */
  t: (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;
}

/** 派发事件的便捷类型别名。 */
export type ActionEventPayload =
  | ActionExecutedEvent
  | ActionSkippedEvent
  | ActionErrorEvent
  | MediaStateEvent
  | MediaErrorEvent;