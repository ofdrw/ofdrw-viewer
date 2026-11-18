/**
 * 动作服务（UI 动作处理机制设计 §3 / §4 / §5 / §9 / §10）。
 *
 * 职责：
 * - **收集与缓存**：文档级动作同步读取（open 阶段已解析）；页级动作按页惰性加载，
 *   缓存到 `Map<pageIndex, PageActionSet>`，随页缓存淘汰失效；
 * - **三种触发**：`DO`（documentopen 后一次）、`PO`（页面首次可见且渲染完成后一次）、
 *   `CLICK`（命中表，见 `pointer-router.ts`）；
 * - **单一入口**：所有执行都经 `execute()`，大纲/书签/宿主 API 不得绕过；
 * - **状态与事件**：维护 `ViewerState.actions`，派发 `action:*` 事件。
 *
 * 自动执行（`DO`/`PO`）受 `actions.autoExecuteActions` 控制，默认 `false`：浏览器禁止
 * 无手势的有声自动播放，自动弹窗/跳转也会打断阅读。
 *
 * **已知限制**：图元所在图层被隐藏时，其 `CLICK` 动作目前仍参与命中。engine 的
 * `ActionInfo` 不携带图层归属，靠 `PageContentFilter` 反推不可靠；该场景罕见，
 * 第一版不处理（见 docs/UI动作处理机制设计.md §11.1）。
 */

import type {
  ActionEvent,
  ActionGeometryEntry,
  ActionInfo,
  PageInfo,
} from '@ofdrw/ofdrw-viewer-engine';
import type { ActionAnchor } from './types';
import { ActionExecutor, eventPageIndex } from './action-executor';
import type {
  ActionBridge,
  ActionExecutionContext,
  ActionHandlerResult,
  ActionOutcome,
  ActionViewerHost,
  ClickHitItem,
  PageActionSet,
} from './types';
import { createClickTable, hitTestTable } from './click-table';
import { toActionBox } from './geometry';
import { PointerRouter } from './pointer-router';
import { UI_WARNING_CODES } from '../diagnostics';

/** 动作执行选项（`ViewerOptions.actions`，设计 §5.2）。 */
export interface ViewerActionsOptions {
  /**
   * 是否自动执行 `DO`/`PO` 动作；默认 `false`。
   *
   * 宿主提供初始值；用户可在「更多 → 关于」中覆盖（不持久化）。
   */
  readonly autoExecuteActions?: boolean;
  /** 是否允许用户通过界面修改自动执行开关；默认 `true`。 */
  readonly allowUserToggleAutoExecute?: boolean;
  /** 最大嵌套动作深度；默认 4。 */
  readonly maxActionDepth?: number;
  /** Goto 跳转是否平滑滚动；默认 `true`。 */
  readonly smoothGoto?: boolean;
}

/** 已解析的动作选项。 */
export interface ResolvedViewerActionsOptions {
  readonly autoExecuteActions: boolean;
  readonly allowUserToggleAutoExecute: boolean;
  readonly maxActionDepth: number;
  readonly smoothGoto: boolean;
}

/** 解析动作选项：补默认值并钳制非法数值。 */
export function resolveViewerActionsOptions(
  options: ViewerActionsOptions | undefined,
): ResolvedViewerActionsOptions {
  const depth = options?.maxActionDepth;
  return {
    autoExecuteActions: options?.autoExecuteActions === true,
    allowUserToggleAutoExecute: options?.allowUserToggleAutoExecute !== false,
    maxActionDepth:
      typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? Math.trunc(depth) : 4,
    smoothGoto: options?.smoothGoto !== false,
  };
}

/** 动作服务构造参数。 */
export interface ActionServiceOptions {
  /** 阅读器宿主。 */
  readonly host: ActionViewerHost;
  /** 核心桥接。 */
  readonly bridge: ActionBridge;
  /** 已解析的动作选项。 */
  readonly options: ResolvedViewerActionsOptions;
  /** 读取页面动作（engine `getPageActionsByEvent`）。 */
  readonly loadPageActions: (
    pageIndex: number,
    event: ActionEvent,
    signal: AbortSignal,
  ) => Promise<readonly ActionInfo[]>;
  /**
   * 读取某页全部可定位动作及其页面像素几何（engine `getPageActionGeometries`）。
   *
   * 几何换算全部由 engine 完成（96 DPI、未旋转页面像素），UI 不得自行换算毫米。
   */
  readonly loadPageGeometries: (
    pageIndex: number,
    signal: AbortSignal,
  ) => Promise<readonly ActionGeometryEntry[]>;
}

/** 动作服务。 */
export class ActionService {
  private readonly host: ActionViewerHost;
  private readonly bridge: ActionBridge;
  private options: ResolvedViewerActionsOptions;
  private readonly loadPageActions: ActionServiceOptions['loadPageActions'];
  private readonly loadPageGeometries: ActionServiceOptions['loadPageGeometries'];
  /** 页动作缓存；key 为页索引（0-based）。 */
  private readonly pages = new Map<number, PageActionSet>();
  /** 正在加载的页，避免重复发起。 */
  private readonly loading = new Map<number, Promise<PageActionSet | undefined>>();
  /**
   * 已执行过 `PO` 的页索引。
   *
   * 独立于页缓存，保证「每页一次」跨页淘汰仍然成立：页被淘汰后重新加载时不会再次执行。
   */
  private readonly pageOpenDonePages = new Set<number>();
  /** 已计入 `pendingAutoActions` 的页 → 该页动作条数；用于页淘汰时精确回收。 */
  private readonly pendingByPage = new Map<number, number>();
  /** 每页独立的中止控制器；页淘汰时中止该页进行中的执行。 */
  private readonly pageAborts = new Map<number, AbortController>();
  /** 文档级动作；documentopen 后缓存。 */
  private documentActions: readonly ActionInfo[] = [];
  /** 是否已执行过 DO（全文档一次）。 */
  private documentOpenDone = false;
  /** 文档级动作计入待执行数的条数；用于文档关闭/重开时精确回收。 */
  private pendingDocumentActions = 0;
  /** 执行器。 */
  readonly executor: ActionExecutor;
  /** 指针路由。 */
  private readonly router: PointerRouter;
  /** 本次文档会话的取消控制器；文档关闭时中止全部执行。 */
  private abortController = new AbortController();
  /** 当前活动播放器数量；由媒体层在创建/销毁时回写。 */
  private activePlayers = 0;
  private destroyed = false;
  private readonly offs: Array<() => void> = [];
  /** 最近一次可见页范围；用于判断范围是否变化。 */
  private lastVisibleRange: { readonly start: number; readonly end: number } | null = null;

  /**
   * @param options 服务参数。
   */
  constructor(options: ActionServiceOptions) {
    this.host = options.host;
    this.bridge = options.bridge;
    this.options = options.options;
    this.loadPageActions = options.loadPageActions;
    this.loadPageGeometries = options.loadPageGeometries;
    this.executor = new ActionExecutor({
      maxActionDepth: this.options.maxActionDepth,
      onResult: (action, result, context) => this.handleResult(action, result, context),
      onError: (action, error, context) => this.handleError(action, error, context),
    });
    this.router = new PointerRouter({
      host: this.host,
      resolveHit: (pageIndex, point) => this.hitTest(pageIndex, point),
      onClick: (pageIndex, actions, anchor) => {
        void this.execute(actions, {
          trigger: 'CLICK',
          pageIndex,
          ...(anchor ? { anchor } : {}),
          signal: this.signalForPage(pageIndex),
        });
      },
    });
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 启动：订阅事件并开始指针路由。 */
  start(): void {
    this.offs.push(
      this.host.on('documentopen', () => this.handleDocumentOpen()),
      this.host.on('documentclose', () => this.handleDocumentClose()),
      this.host.on('pagerendered', (event) => this.handlePageRendered(event.pageNumber)),
      this.host.on('pagechanging', () => this.handleVisiblePagesChanged()),
      this.host.on('statechange', () => this.handleVisiblePagesChanged()),
    );
    this.router.attach();
  }

  /** 销毁：移除监听、中止执行、清理全部缓存与播放器。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    this.router.detach();
    this.abortController.abort();
    this.resetDocumentState();
  }

  /**
   * 设置自动执行开关（「关于」对话框入口）；不持久化。
   *
   * 打开后立即生效：补执行此前因开关关闭而跳过的 `DO`/`PO`。
   *
   * @param enabled 是否自动执行。
   */
  setAutoExecute(enabled: boolean): void {
    if (!this.options.allowUserToggleAutoExecute) return;
    const next = enabled === true;
    if (next === this.options.autoExecuteActions) return;
    this.options = { ...this.options, autoExecuteActions: next };
    if (next) this.runPendingAutoActions();
    else this.syncActionsState();
  }

  /** 当前自动执行开关。 */
  get autoExecute(): boolean {
    return this.options.autoExecuteActions;
  }

  /** 是否允许用户通过界面修改自动执行开关。 */
  get allowUserToggle(): boolean {
    return this.options.allowUserToggleAutoExecute;
  }

  /**
   * 宿主手动执行某页某事件的动作（设计 §14.1）。
   *
   * 与内部触发走同一条路径；`PO` 不会消耗每页一次的自动执行机会。
   *
   * @param pageIndex 页索引，0-based。
   * @param event 动作事件。
   * @param options 取消信号。
   * @returns 每个动作的结果。
   */
  async executeActions(
    pageIndex: number,
    event: ActionEvent,
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly ActionOutcome[]> {
    if (this.destroyed) throw createAbortedError();
    this.assertPageIndex(pageIndex);
    const signal = this.signalForPage(pageIndex);
    const actions = await this.loadPageActions(pageIndex, event, signal);
    if (actions.length === 0) return [];
    return this.execute(actions, {
      trigger: 'HOST',
      pageIndex,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * 直接执行一组给定动作（大纲/书签等导航面板入口，设计 §11.2）。
   *
   * 与内部触发走同一条路径，不经过页缓存，调用方负责给出动作列表。
   *
   * @param actions 待执行动作，按文档顺序。
   * @param context 执行上下文。
   * @returns 每个动作的结果；已销毁时全部为 `cancelled`。
   */
  async runActions(
    actions: readonly ActionInfo[],
    context: ActionExecutionContext,
  ): Promise<readonly ActionOutcome[]> {
    if (this.destroyed || actions.length === 0) return actions.map(() => 'cancelled' as const);
    return this.execute(actions, context);
  }

  /**
   * 判断视口坐标处是否命中可点击动作（用于双击缩放让位，设计 §6.2）。
   *
   * 命中表按需加载：点击不应等页面渲染完成，因此缺缓存时同步返回 false，并由
   * {@link prepareHitTable} 在后台补齐；下一次点击即可命中。
   *
   * @param clientX 视口 x 坐标，单位 px。
   * @param clientY 视口 y 坐标，单位 px。
   * @returns 命中可点击动作时 true。
   */
  hitTestAt(clientX: number, clientY: number): boolean {
    if (this.destroyed) return false;
    const hit = this.router.locate(clientX, clientY);
    if (hit) return true;
    this.prepareHitTable(clientX, clientY);
    return false;
  }

  /**
   * 按视口坐标解析页索引并确保该页命中表已加载。
   *
   * @param clientX 视口 x 坐标，单位 px。
   * @param clientY 视口 y 坐标，单位 px。
   */
  private prepareHitTable(clientX: number, clientY: number): void {
    const host = this.host as ActionViewerHost & {
      getContentPointAtViewport?(
        x: number,
        y: number,
      ): { pageIndex: number; xPx: number; yPx: number } | undefined;
    };
    const point = host.getContentPointAtViewport?.(clientX, clientY);
    if (!point || point.pageIndex < 0) return;
    void this.ensurePageActions(point.pageIndex);
  }

  /**
   * 执行一组动作（**唯一入口**）。
   *
   * @param actions 动作列表。
   * @param context 执行上下文。
   * @returns 每个动作的结果。
   */
  async execute(
    actions: readonly ActionInfo[],
    context: ActionExecutionContext,
  ): Promise<readonly ActionOutcome[]> {
    if (this.destroyed || actions.length === 0) return actions.map(() => 'cancelled' as const);
    const signal = context.signal ?? this.signalForContext(context);
    return this.executor.execute(actions, context, { signal });
  }

  // -------------------------------------------------------------------------
  // 触发
  // -------------------------------------------------------------------------

  /** 文档打开：缓存文档级动作并执行 DO。 */
  private handleDocumentOpen(): void {
    this.abortController.abort();
    this.resetDocumentState();
    this.abortController = new AbortController();
    const document = this.host.getDocument() as
      | { getDocumentActions?: () => readonly ActionInfo[] }
      | null;
    const actions =
      typeof document?.getDocumentActions === 'function' ? document.getDocumentActions() : [];
    this.documentActions = actions.filter((action) => action.event === 'DO');
    this.documentOpenDone = false;
    this.pendingDocumentActions = 0;
    // 预加载可见页的动作集合与命中表：点击可用性不应依赖页面渲染完成，
    // 否则首屏在渲染尚未结束时的点击会被静默丢掉。
    this.preloadVisiblePages();
    if (this.documentActions.length === 0) {
      this.syncActionsState();
      return;
    }
    this.maybeRunDocumentOpen();
  }

  /** 预加载当前可见页的动作集合；不影响 PO 的触发时机判断。 */
  private preloadVisiblePages(): void {
    const range = this.host.getState().view.visiblePageRange;
    const count = this.host.getPageInfos().length;
    for (let index = Math.max(0, range.start); index <= Math.min(range.end, count - 1); index += 1) {
      void this.ensurePageActions(index);
    }
  }

  /** 文档关闭：中止执行、清空缓存、销毁全部播放器。 */
  private handleDocumentClose(): void {
    this.abortController.abort();
    this.resetDocumentState();
    this.abortController = new AbortController();
  }

  /** 执行 DO 动作；开关关闭时计入待执行数并派发跳过事件。 */
  private maybeRunDocumentOpen(): void {
    if (this.documentOpenDone || this.documentActions.length === 0) return;
    if (!this.isAffectedFeatureEnabled()) return;
    if (!this.options.autoExecuteActions) {
      // 仅首次发现时计数，避免可见性/状态变化重复累加。
      if (this.pendingDocumentActions === 0) {
        this.pendingDocumentActions = this.documentActions.length;
        this.reportAutoSkipped(this.documentActions, { trigger: 'DO', pageIndex: 0 });
        this.syncActionsState();
      }
      return;
    }
    this.documentOpenDone = true;
    void this.execute(this.documentActions, {
      trigger: 'DO',
      pageIndex: 0,
      signal: this.abortController.signal,
    });
  }

  /** 页面渲染完成：惰性加载该页动作并判断是否执行 PO。 */
  private handlePageRendered(pageNumber: number): void {
    const pageIndex = Math.trunc(pageNumber) - 1;
    if (pageIndex < 0) return;
    void this.ensurePageActions(pageIndex).then((set) => {
      if (!set || this.destroyed) return;
      this.evaluatePageOpen(pageIndex, set);
    });
  }

  /**
   * 可见页范围变化（滚动/翻页）：重新评估已加载页的 PO。
   *
   * 只依赖 `statechange` 与 `pagechanging` 两条来源，且按可见范围去重，避免每次状态
   * 提交都遍历全部已加载页。
   */
  private handleVisiblePagesChanged(): void {
    if (this.destroyed) return;
    const range = this.host.getState().view.visiblePageRange;
    const last = this.lastVisibleRange;
    if (last && last.start === range.start && last.end === range.end) return;
    this.lastVisibleRange = { start: range.start, end: range.end };
    for (const [pageIndex, set] of this.pages) {
      if (set.pageOpenDone) continue;
      this.evaluatePageOpen(pageIndex, set);
    }
  }

  /**
   * 按当前可见范围评估单页 PO 是否执行。
   *
   * 三个条件同时满足才执行：未执行过、页面在可视范围内、自动执行已开启；开关关闭时
   * 记账并派发跳过事件供宿主提示。
   *
   * @param pageIndex 页索引，0-based。
   * @param set 页动作集合。
   */
  private evaluatePageOpen(pageIndex: number, set: PageActionSet): void {
    if (set.pageOpenDone || set.pageOpen.length === 0) return;
    if (this.pageOpenDonePages.has(pageIndex)) return;
    if (!this.isAffectedFeatureEnabled()) return;
    const range = this.host.getState().view.visiblePageRange;
    const visible = pageIndex >= range.start && pageIndex <= range.end;
    if (!visible) return;
    if (!this.options.autoExecuteActions) {
      if (!this.pendingByPage.has(pageIndex)) {
        this.pendingByPage.set(pageIndex, set.pageOpen.length);
        this.reportAutoSkipped(set.pageOpen, { trigger: 'PO', pageIndex });
        this.syncActionsState();
      }
      return;
    }
    this.markPageOpenDone(pageIndex, set);
    void this.execute(set.pageOpen, {
      trigger: 'PO',
      pageIndex,
      signal: this.signalForPage(pageIndex),
    });
  }

  /** 标记某页 PO 已执行（缓存副本 + 跨淘汰集合）。 */
  private markPageOpenDone(pageIndex: number, set: PageActionSet): void {
    this.pageOpenDonePages.add(pageIndex);
    this.pages.set(pageIndex, { ...set, pageOpenDone: true });
    if (this.pendingByPage.delete(pageIndex)) this.syncActionsState();
  }

  /** 自动执行开关打开后，补执行此前跳过的 DO/PO。 */
  private runPendingAutoActions(): void {
    this.pendingByPage.clear();
    this.pendingDocumentActions = 0;
    this.maybeRunDocumentOpen();
    const range = this.host.getState().view.visiblePageRange;
    for (const [pageIndex, set] of this.pages) {
      if (pageIndex < range.start || pageIndex > range.end) continue;
      this.evaluatePageOpen(pageIndex, set);
    }
    this.syncActionsState();
  }

  // -------------------------------------------------------------------------
  // 收集与缓存
  // -------------------------------------------------------------------------

  /**
   * 惰性加载某页的动作集合（幂等、按页缓存）。
   *
   * 加载失败只上报 warning 并缓存空集合，不重试、不阻断渲染。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 页动作集合；加载中或已销毁时返回 undefined。
   */
  async ensurePageActions(pageIndex: number): Promise<PageActionSet | undefined> {
    if (this.destroyed) return undefined;
    const cached = this.pages.get(pageIndex);
    if (cached) return cached;
    const inflight = this.loading.get(pageIndex);
    if (inflight) return inflight;
    const task = this.buildPageActionSet(pageIndex);
    this.loading.set(pageIndex, task);
    try {
      const set = await task;
      if (set && !this.destroyed && !this.abortController.signal.aborted) {
        this.pages.set(pageIndex, set);
      }
      return set;
    } finally {
      this.loading.delete(pageIndex);
    }
  }

  /**
   * 构建单页动作集合。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 页动作集合；失败时返回空集合。
   */
  private async buildPageActionSet(pageIndex: number): Promise<PageActionSet | undefined> {
    const signal = this.abortController.signal;
    try {
      // 一次批量取齐：`PO` 动作（执行用）与全部可定位动作及其像素几何（建命中表用）。
      // 几何由 engine 按 96 DPI 换算，与文本层同一口径；UI 不做任何 mm → px 计算。
      const [pageOpen, geometries] = await Promise.all([
        this.loadPageActions(pageIndex, 'PO', signal),
        this.loadPageGeometries(pageIndex, signal),
      ]);
      if (this.destroyed) return undefined;
      const click = this.buildClickTable(pageIndex, geometries);
      return {
        pageOpen,
        ...(click ? { click } : {}),
        pageOpenDone: this.pageOpenDonePages.has(pageIndex),
      };
    } catch (error) {
      if (isAbort(error)) return undefined;
      this.bridge.warn(
        UI_WARNING_CODES.W_ACTION_LOAD,
        `第 ${pageIndex + 1} 页动作加载失败：${error instanceof Error ? error.message : String(error)}`,
        pageIndex,
      );
      return { pageOpen: [], pageOpenDone: true };
    }
  }

  /**
   * 由 engine 的批量几何构建命中表。
   *
   * `getPageActionGeometries()` 的返回顺序是「页级动作在前，其后图元按绘制序」。
   * 同一宿主的多个动作共享同一 `paintOrder`，实现上取该宿主**首次出现**的下标：
   * 数组下标越大越靠上，按首次出现分组后，扫描顺序即「后绘制者优先」，且一次点击会
   * 执行该宿主的全部 CLICK 动作。
   *
   * 只保留 `CLICK` 事件的动作：`PO`/`DO` 不参与点击命中。
   *
   * @param pageIndex 页索引，0-based。
   * @param entries engine 返回的动作与几何。
   * @returns 命中表；无 CLICK 动作时 undefined。
   */
  private buildClickTable(pageIndex: number, entries: readonly ActionGeometryEntry[]) {
    const items: ClickHitItem[] = [];
    /** 宿主键 → 绘制序权重。 */
    const orderByOwner = new Map<string, number>();
    for (let index = 0; index < entries.length; index += 1) {
      const { action, geometry } = entries[index]!;
      if (action.event !== 'CLICK') continue;
      // 几何全部来自 engine；无有效矩形时跳过（绝不用近似矩形填充）。
      const bbox = toActionBox(geometry);
      if (bbox.width <= 0 || bbox.height <= 0) continue;
      const ownerKey = ownerOrderKey(action, pageIndex);
      let paintOrder = orderByOwner.get(ownerKey);
      if (paintOrder === undefined) {
        paintOrder = index;
        orderByOwner.set(ownerKey, paintOrder);
      }
      items.push({ action, bbox, source: geometry.source, paintOrder });
    }
    return createClickTable(items);
  }

  /**
   * 命中测试：把页面像素点交给命中表。
   *
   * @param pageIndex 页索引，0-based。
   * @param point 页面像素点（96 DPI，未旋转）。
   * @returns 命中的动作与锚点；未命中时 undefined。
   */
  private hitTest(
    pageIndex: number,
    point: { x: number; y: number },
  ): { actions: readonly ActionInfo[]; anchor?: ActionAnchor } | undefined {
    const table = this.pages.get(pageIndex)?.click;
    if (!table) {
      // 命中表尚未加载：后台补齐，本次点击不触发（下一次点击可正常命中）。
      void this.ensurePageActions(pageIndex);
      return undefined;
    }
    const hit = hitTestTable(table, point);
    if (!hit || hit.actions.length === 0) return undefined;
    const first = hit.actions[0]!;
    const owner = first.owner;
    const anchor: ActionAnchor | undefined =
      owner.kind === 'object'
        ? {
            ...(owner.objectId ? { objectId: owner.objectId } : {}),
            bbox: hit.rect,
          }
        : undefined;
    return { actions: hit.actions, ...(anchor ? { anchor } : {}) };
  }

  /**
   * 页缓存淘汰：删除该页动作集合、中止该页执行、回收其待执行计数。
   *
   * 播放器的暂停与销毁由动作模块在调用本方法前完成（见 `actions/index.ts`）。
   *
   * @param pageNumber 页码，1-based。
   */
  releasePage(pageNumber: number): void {
    const pageIndex = Math.trunc(pageNumber) - 1;
    if (pageIndex < 0) return;
    this.pages.delete(pageIndex);
    this.loading.delete(pageIndex);
    const controller = this.pageAborts.get(pageIndex);
    if (controller) {
      controller.abort();
      this.pageAborts.delete(pageIndex);
    }
    if (this.pendingByPage.delete(pageIndex)) this.syncActionsState();
  }

  /** 清空文档相关状态（关闭/重开时调用）。 */
  private resetDocumentState(): void {
    for (const controller of this.pageAborts.values()) controller.abort();
    this.pageAborts.clear();
    this.pages.clear();
    this.loading.clear();
    this.pageOpenDonePages.clear();
    this.pendingByPage.clear();
    this.documentActions = [];
    this.documentOpenDone = false;
    this.pendingDocumentActions = 0;
    this.lastVisibleRange = null;
    this.activePlayers = 0;
    this.executor.cancelAll();
    this.router.clearSelectionGuard();
    this.syncActionsState();
  }

  // -------------------------------------------------------------------------
  // 状态与事件
  // -------------------------------------------------------------------------

  /** 当前未执行的自动动作总数（`DO` + `PO`）。 */
  private get pendingAutoActions(): number {
    let pending = this.pendingDocumentActions;
    for (const count of this.pendingByPage.values()) pending += count;
    return pending;
  }

  /** 把待执行计数与活动播放器数同步到状态。 */
  private syncActionsState(): void {
    if (this.destroyed) return;
    const current = this.host.getState().actions;
    const pending = this.pendingAutoActions;
    if (current.pendingAutoActions === pending && current.activePlayers === this.activePlayers) {
      return;
    }
    this.bridge.patchActions({ pendingAutoActions: pending, activePlayers: this.activePlayers });
    this.bridge.commit();
  }

  /**
   * 更新活动播放器计数（媒体层调用）。
   *
   * @param count 当前活动播放器数量。
   */
  setActivePlayers(count: number): void {
    const next = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
    if (next === this.activePlayers) return;
    this.activePlayers = next;
    this.syncActionsState();
  }

  /** handler 结果 → 事件。 */
  private handleResult(
    action: ActionInfo,
    result: ActionHandlerResult,
    context: ActionExecutionContext,
  ): void {
    const pageIndex = eventPageIndex(action, context.trigger, context.pageIndex);
    if (result.outcome === 'skipped') {
      this.bridge.emit('action:skipped', {
        type: action.type,
        reason: result.skipReason ?? 'target-missing',
        ...(pageIndex === undefined ? {} : { pageIndex }),
      });
      return;
    }
    if (result.outcome !== 'executed') return;
    this.bridge.emit('action:executed', {
      type: action.type,
      owner: action.owner,
      ...(pageIndex === undefined ? {} : { pageIndex }),
      ...(result.target ? { target: result.target } : {}),
    });
  }

  /** handler 错误 → 事件 + 诊断。 */
  private handleError(
    action: ActionInfo,
    error: {
      readonly code: string;
      readonly reason?: 'loop' | 'popup-blocked' | 'unsupported' | 'load';
      readonly message?: string;
    },
    context: ActionExecutionContext,
  ): void {
    const pageIndex = eventPageIndex(action, context.trigger, context.pageIndex);
    this.bridge.emit('action:error', {
      type: action.type,
      code: error.code,
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.message ? { message: error.message } : {}),
      ...(pageIndex === undefined ? {} : { pageIndex }),
    });
    if (error.message) {
      this.bridge.warn(
        UI_WARNING_CODES.W_ACTION_EXECUTE,
        `动作执行失败（${action.type}）：${error.message}`,
        context.pageIndex,
      );
    }
  }

  /**
   * 派发自动动作因开关关闭而未执行的事件。
   *
   * 按页/文档聚合：同一批动作只派发一次，`reason` 固定为 `autoplay-disabled`；
   * 事件载荷不含逐条信息，宿主按页提示即可。未打开 `actions` 功能时不派发。
   *
   * @param actions 被跳过的动作。
   * @param context 触发上下文。
   */
  private reportAutoSkipped(actions: readonly ActionInfo[], context: { trigger: 'DO' | 'PO'; pageIndex: number }): void {
    if (actions.length === 0) return;
    const first = actions[0]!;
    const pageIndex = eventPageIndex(first, context.trigger, context.pageIndex);
    this.bridge.emit('action:skipped', {
      type: first.type,
      reason: 'autoplay-disabled',
      ...(pageIndex === undefined ? {} : { pageIndex }),
    });
  }

  /**
   * 判断动作功能是否可用；关闭时自动执行与点击均不生效。
   *
   * @returns 可用时 true。
   */
  private isAffectedFeatureEnabled(): boolean {
    return this.host.isFeatureEnabled('actions');
  }

  /**
   * 取某页的执行取消信号：文档级信号与该页信号合并。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 取消信号。
   */
  private signalForPage(pageIndex: number): AbortSignal {
    let controller = this.pageAborts.get(pageIndex);
    if (!controller) {
      controller = new AbortController();
      this.pageAborts.set(pageIndex, controller);
    }
    return controller.signal;
  }

  /**
   * 按上下文取取消信号；未提供时用文档级信号。
   *
   * @param context 执行上下文。
   * @returns 取消信号。
   */
  private signalForContext(context: ActionExecutionContext): AbortSignal {
    return context.trigger === 'DO'
      ? this.abortController.signal
      : this.signalForPage(context.pageIndex);
  }

  /**
   * 校验页索引；越界时抛 `OFD_PAGE_NOT_FOUND`。
   *
   * @param pageIndex 页索引，0-based。
   */
  private assertPageIndex(pageIndex: number): void {
    const count = this.host.getPageInfos().length;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) {
      const error = new Error(`页索引无效：${pageIndex}（共 ${count} 页）`) as Error & {
        code?: string;
      };
      error.code = 'OFD_PAGE_NOT_FOUND';
      throw error;
    }
  }
}

/**
 * 由动作宿主生成宿主分组键。
 *
 * 同一图元的多个动作必须共享权重（一起命中、一起执行）；页级/文档级动作用固定键。
 * 无 ID 的图元按页归组，与其动作在 engine 中共享同一路径键的口径一致。
 *
 * @param action 动作。
 * @param pageIndex 当前页索引。
 * @returns 分组键。
 */
function ownerOrderKey(action: ActionInfo, pageIndex: number): string {
  const owner = action.owner;
  if (owner.kind === 'object') {
    return owner.objectId ? `object:${owner.objectId}` : `object-path:${pageIndex}`;
  }
  return `${owner.kind}`;
}

/**
 * 判断错误是否为取消。
 *
 * @param error 错误对象。
 * @returns 取消时 true。
 */
function isAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AbortError') return true;
  return (error as { code?: unknown }).code === 'OFD_ABORTED';
}

/**
 * 构造已中止错误。
 *
 * @returns 带 `OFD_ABORTED` 码的错误。
 */
function createAbortedError(): Error & { code: string } {
  const error = new Error('阅读器已销毁') as Error & { code: string };
  error.code = 'OFD_ABORTED';
  return error;
}