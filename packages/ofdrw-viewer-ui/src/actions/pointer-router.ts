/**
 * 指针路由（UI 动作处理机制设计 §6.1 / §6.2 / §6.4）。
 *
 * 用 `pointerup` 而非 `click` 判定动作点击：需要区分「拖拽/选择」与「点击」，
 * 且 `click` 在拖拽后也可能触发、无法拿到起点。
 *
 * 判定流程：
 * ```
 * pointerdown → 存在文本选区 ?          → 不记录起点，本次按下不派生动作
 *             → 记录起点
 * pointerup   → 位移 > DRAG_THRESHOLD(4px) ? → 拖拽/选择，不触发
 *             → 存在活动文本选区 ?          → 不触发
 *             → DOM 目标是签章/媒体元素 ?   → 不触发（控件优先）
 *             → 坐标换算 → 命中测试 → 执行
 * ```
 *
 * 坐标换算复用核心的 `getContentPointAtViewport()`：它已扣除页盒偏移与滚动位置，
 * 直接返回 96 DPI 页面像素，因此与 `getActionGeometry({ dpi: 96 })` 的输出同口径，
 * 页面旋转由 `surface` 的 CSS transform 承担，这里无需再做逆变换。
 */

import type { ActionInfo } from '@ofdrw/ofdrw-viewer-engine';
import type { ActionAnchor, ActionViewerHost } from './types';

/** 判定为拖拽的位移阈值，单位 px。 */
export const DRAG_THRESHOLD_PX = 4;

/**
 * 不触发动作的 DOM 目标选择器。
 *
 * - `a,button,input,select,textarea,[contenteditable]`：原生可交互元素优先；
 * - `video,audio,[data-ofd-media]`：媒体控件优先（与双击缩放防误触选择器保持一致）；
 * - `.ofd-signature-box`：签章是 `<button>`，已由第一条覆盖，这里显式保留语义。
 */
const INTERACTIVE_SELECTOR =
  'a,button,input,select,textarea,[contenteditable="true"],video,audio,[data-ofd-media],.ofd-signature-box';

/** 指针路由选项。 */
export interface PointerRouterOptions {
  /** 阅读器宿主。 */
  readonly host: ActionViewerHost;
  /**
   * 命中测试：给定页索引与 96 DPI 页面像素点，返回命中的动作与可选锚点。
   *
   * @param pageIndex 页索引，0-based。
   * @param point 页面像素点（未旋转、未缩放）。
   */
  readonly resolveHit: (
    pageIndex: number,
    point: { x: number; y: number },
  ) => { actions: readonly ActionInfo[]; anchor?: ActionAnchor } | undefined;
  /**
   * 命中回调：执行命中的动作。
   *
   * @param pageIndex 页索引，0-based。
   * @param actions 动作列表（同一宿主的全部 CLICK 动作）。
   * @param anchor 触发图元锚点。
   */
  readonly onClick: (
    pageIndex: number,
    actions: readonly ActionInfo[],
    anchor: ActionAnchor | undefined,
  ) => void;
}

/**
 * 一次指针按下的起点。
 */
interface PointerStart {
  /** 视口 x 坐标，单位 px。 */
  readonly x: number;
  /** 视口 y 坐标，单位 px。 */
  readonly y: number;
  /** 指针标识；抬起时须与按下时一致。 */
  readonly pointerId: number;
}

/** 指针路由。 */
export class PointerRouter {
  private readonly host: ActionViewerHost;
  private readonly resolveHit: PointerRouterOptions['resolveHit'];
  private readonly onClick: PointerRouterOptions['onClick'];
  /** 当前按下的指针；多指时只跟踪主指针。 */
  private start: PointerStart | null = null;
  /** 是否已挂载监听。 */
  private attached = false;
  /** 本次按下是否由媒体/签章等交互元素发起（按下即决定，抬起不再复核）。 */
  private suppressed = false;

  private readonly onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event);
  private readonly onPointerUp = (event: PointerEvent): void => this.handlePointerUp(event);

  /**
   * @param options 路由选项。
   */
  constructor(options: PointerRouterOptions) {
    this.host = options.host;
    this.resolveHit = options.resolveHit;
    this.onClick = options.onClick;
  }

  /** 挂载监听到主区域；重复调用幂等。 */
  attach(): void {
    if (this.attached) return;
    const main = this.host.getElements().main;
    main.addEventListener('pointerdown', this.onPointerDown);
    main.addEventListener('pointerup', this.onPointerUp);
    // 指针被取消（滚动接管、系统手势）时丢弃起点，避免误触发。
    main.addEventListener('pointercancel', this.handlePointerCancel);
    this.attached = true;
  }

  /** 卸载监听。 */
  detach(): void {
    if (!this.attached) return;
    const main = this.host.getElements().main;
    main.removeEventListener('pointerdown', this.onPointerDown);
    main.removeEventListener('pointerup', this.onPointerUp);
    main.removeEventListener('pointercancel', this.handlePointerCancel);
    this.attached = false;
    this.start = null;
    this.suppressed = false;
  }

  /** 清除选区守卫状态；文档关闭时调用。 */
  clearSelectionGuard(): void {
    this.start = null;
    this.suppressed = false;
  }

  /**
   * 记录按下起点并判定是否让位给原生交互。
   *
   * @param event 指针按下事件。
   */
  private handlePointerDown(event: PointerEvent): void {
    this.start = null;
    this.suppressed = false;
    // 只响应主按钮；右键/中键交给浏览器菜单与滚动。
    if (event.button !== 0) return;
    // 多指手势只跟踪主指针：第二根手指落下时丢弃起点，避免捏合/双指点击误触发动作。
    if (!event.isPrimary) return;
    if (!this.host.isFeatureEnabled('actions')) return;
    this.suppressed = isInteractiveTarget(event.target);
    if (this.suppressed) return;
    // 存在文本选区时不记录起点：本次按下到抬起都不会派生动作，交给选区继续拖选/复制。
    if (hasActiveSelection(this.host)) return;
    this.start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  }

  /**
   * 抬起时判定点击并派发命中。
   *
   * @param event 指针抬起事件。
   */
  private handlePointerUp(event: PointerEvent): void {
    const start = this.start;
    this.start = null;
    if (!start || this.suppressed) return;
    if (!this.host.isFeatureEnabled('actions')) return;
    // 抬起必须来自同一根指针；多指手势中的其他手指抬起不触发动作。
    if (event.pointerId !== start.pointerId) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > DRAG_THRESHOLD_PX) return;
    if (hasActiveSelection(this.host)) return;
    if (isInteractiveTarget(event.target)) return;

    const hit = this.locate(event.clientX, event.clientY);
    if (!hit) return;
    this.onClick(hit.pageIndex, hit.actions, hit.anchor);
  }

  /** 指针取消：丢弃起点。 */
  private readonly handlePointerCancel = (): void => {
    this.start = null;
    this.suppressed = false;
  };

  /**
   * 把视口坐标换算为 96 DPI 页面坐标并做命中测试。
   *
   * @param clientX 视口 x 坐标，单位 px。
   * @param clientY 视口 y 坐标，单位 px。
   * @returns 命中结果；未命中或坐标无效时 undefined。
   */
  locate(
    clientX: number,
    clientY: number,
  ): { pageIndex: number; actions: readonly ActionInfo[]; anchor?: ActionAnchor } | undefined {
    const host = this.host as ActionViewerHost & {
      /**
       * 视口坐标 → 96 DPI 页面像素（核心新增的纯读取方法）。
       */
      getContentPointAtViewport?(
        x: number,
        y: number,
      ): { pageIndex: number; xPx: number; yPx: number } | undefined;
    };
    const point = host.getContentPointAtViewport?.(clientX, clientY);
    if (!point) return undefined;
    if (point.pageIndex < 0) return undefined;
    const hit = this.resolveHit(point.pageIndex, { x: point.xPx, y: point.yPx });
    if (!hit) return undefined;
    return {
      pageIndex: point.pageIndex,
      actions: hit.actions,
      ...(hit.anchor ? { anchor: hit.anchor } : {}),
    };
  }
}

/**
 * 判断事件目标是否属于需要优先响应的原生交互元素。
 *
 * @param target 事件目标。
 * @returns 需要让位时 true。
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * 判断当前是否存在活动文本选区。
 *
 * `pointerup` 先于浏览器完成选区更新的时序下，用「选区非空且锚点在主区域内」判定；
 * 拖拽选择过程中选区已建立，因此能正确让位。
 *
 * @param host 阅读器宿主。
 * @returns 有活动选区时 true。
 */
function hasActiveSelection(host: ActionViewerHost): boolean {
  const main = host.getElements().main;
  const doc = main.ownerDocument;
  const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const text = selection.toString();
  if (text.length === 0) return false;
  const anchor = selection.anchorNode;
  if (!anchor) return false;
  return main.contains(anchor);
}