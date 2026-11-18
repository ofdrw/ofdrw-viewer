/**
 * 动作执行器（UI 动作处理机制设计 §7）。
 *
 * 负责一组动作的**顺序执行**与执行语义：
 * - 顺序：按 `ActionInfo[]` 逐个 `await`，前一个失败不影响后一个（错误隔离）；
 * - `Synchronous` 阻塞：`Sound@Synchronous` 时等到播放结束才继续（`Repeat=true` 时该
 *   字段无效，标准显式规定）；
 * - `Movie` 不阻塞：标准无 `Synchronous` 属性，立即返回；
 * - 循环防护：`maxActionDepth` 限制嵌套深度，超限停止并上报 `reason: 'loop'`；
 * - 取消：文档关闭或页淘汰时以 `OFD_ABORTED` 中止，排队中的动作直接丢弃。
 *
 * 执行器**不关心动作语义**：每种动作由 `handlers/` 下的 handler 实现，执行器只负责
 * 调度、事件派发与结果汇总。
 *
 * 嵌套深度通过 `ExecuteActionsOptions.depth` 逐层传递，**不使用实例字段**：同一服务上
 * 可能同时存在多组无关执行（`Synchronous` 播放阻塞时的点击、`DO` 与 `PO` 交错），
 * 共享可变深度会让并发执行互相污染并永久累积。
 */

import type { ActionInfo, ActionType } from '@ofdrw/ofdrw-viewer-engine';
import type {
  ActionExecutionContext,
  ActionHandler,
  ActionHandlerResult,
  ActionOutcome,
  ActionTrigger,
} from './types';

/** 默认最大嵌套动作深度（设计 §7.2）。 */
export const DEFAULT_MAX_ACTION_DEPTH = 4;

/** 执行器选项。 */
export interface ActionExecutorOptions {
  /** 最大嵌套动作深度；默认 {@link DEFAULT_MAX_ACTION_DEPTH}。 */
  readonly maxActionDepth?: number;
  /**
   * 派发单个动作结果。
   *
   * @param action 动作。
   * @param result handler 结果（已归一化）。
   * @param context 执行上下文。
   */
  readonly onResult?: (
    action: ActionInfo,
    result: ActionHandlerResult,
    context: ActionExecutionContext,
  ) => void;
  /** 上报执行失败（已归一化的错误码与原因）。 */
  readonly onError?: (
    action: ActionInfo,
    error: {
      readonly code: string;
      readonly reason?: 'loop' | 'popup-blocked' | 'unsupported' | 'load';
      readonly message?: string;
    },
    context: ActionExecutionContext,
  ) => void;
}

/** 执行一组动作的选项。 */
export interface ExecuteActionsOptions {
  /** 取消信号。 */
  readonly signal?: AbortSignal;
  /** 嵌套深度；由 handler 自嵌套调用时递增，调用方通常省略。 */
  readonly depth?: number;
}

/**
 * 动作执行器。
 *
 * 五种动作的 handler 按 `ActionType` 注册；未注册的类型按 `skipped` 处理并告警，
 * 保证新增动作类型时不会静默崩溃。
 */
export class ActionExecutor {
  private readonly handlers = new Map<ActionType, ActionHandler>();
  private readonly maxActionDepth: number;
  private readonly onResult: ActionExecutorOptions['onResult'];
  private readonly onError: ActionExecutorOptions['onError'];
  /** 文档级中止控制器；文档关闭时统一作废。 */
  private abortController = new AbortController();

  /**
   * @param options 执行器选项。
   */
  constructor(options: ActionExecutorOptions = {}) {
    const depth = options.maxActionDepth;
    this.maxActionDepth =
      typeof depth === 'number' && Number.isFinite(depth) && depth > 0
        ? Math.trunc(depth)
        : DEFAULT_MAX_ACTION_DEPTH;
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  /**
   * 注册（或替换）某一动作类型的 handler。
   *
   * @param type 动作类型。
   * @param handler 处理函数。
   */
  register(type: ActionType, handler: ActionHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * 判断某动作类型是否已注册 handler。
   *
   * @param type 动作类型。
   * @returns 已注册时 true。
   */
  has(type: ActionType): boolean {
    return this.handlers.has(type);
  }

  /**
   * 顺序执行一组动作。
   *
   * @param actions 动作列表，按文档顺序。
   * @param context 执行上下文。
   * @param options 取消信号与嵌套深度。
   * @returns 与 `actions` 等长的结果数组；取消后剩余动作记为 `cancelled`。
   */
  async execute(
    actions: readonly ActionInfo[],
    context: ActionExecutionContext,
    options: ExecuteActionsOptions = {},
  ): Promise<readonly ActionOutcome[]> {
    const depth = options.depth ?? 0;
    // 捕获本次执行开始时的中止控制器：`cancelAll()` 之后即使实例字段被换成新控制器，
    // 本组执行也必须继续视为已中止。
    const lifetime = this.abortController.signal;
    const signal = combineAbortSignals(options.signal, lifetime);
    if (depth >= this.maxActionDepth) {
      // 深度超限：整组动作都不执行，逐个记失败，宿主可从 action:error 事件观察。
      const loopError = {
        code: 'OFD_ACTION_LOOP',
        reason: 'loop' as const,
        message: `动作嵌套深度超过上限 ${this.maxActionDepth}`,
      };
      const outcomes: ActionOutcome[] = [];
      for (const action of actions) {
        this.onError?.(action, loopError, context);
        outcomes.push('failed');
      }
      return outcomes;
    }

    const outcomes: ActionOutcome[] = [];
    for (const action of actions) {
      if (isAborted(signal)) {
        // 排队中的动作直接丢弃：不再调用 handler，也不派发结果事件。
        outcomes.push('cancelled');
        continue;
      }
      const result = await this.runOne(action, context, depth, signal);
      outcomes.push(result.outcome);
      if (result.waitForEnd) {
        // `Synchronous`：等到播放结束（或被取消）才继续后续动作。
        await settleWhileAbortable(result.waitForEnd, signal);
      }
    }
    return outcomes;
  }

  /**
   * 执行单个动作并把异常归一化为 `failed`。
   *
   * @param action 动作。
   * @param context 执行上下文。
   * @param depth 当前嵌套深度。
   * @param signal 取消信号（已与文档级中止合并）。
   * @returns 归一化后的结果。
   */
  private async runOne(
    action: ActionInfo,
    context: ActionExecutionContext,
    depth: number,
    signal: AbortSignal | undefined,
  ): Promise<ActionHandlerResult> {
    const handler = this.handlers.get(action.type);
    if (!handler) {
      const result: ActionHandlerResult = {
        outcome: 'skipped',
        skipReason: 'target-missing',
        message: `未注册 ${action.type} 动作的处理器`,
      };
      this.onResult?.(action, result, context);
      return result;
    }
    const scopedContext: ActionExecutionContext = { ...context, signal };
    let result: ActionHandlerResult;
    try {
      result = await handler(scopedContext, action);
    } catch (error) {
      // 错误隔离：handler 抛错只让当前动作失败，后续动作继续。
      const message = error instanceof Error ? error.message : String(error);
      result = {
        outcome: isAbortError(error) ? 'cancelled' : 'failed',
        code: readErrorCode(error) ?? 'OFD_ACTION_FAILED',
        ...(isAbortError(error) ? {} : { message }),
      };
    }
    if (isAborted(signal)) {
      // handler 在 await 期间被取消：其结果不代表实际生效，按取消处理且不派发结果事件。
      return { outcome: 'cancelled' };
    }
    if (result.outcome === 'failed') {
      this.onError?.(
        action,
        {
          code: result.code ?? 'OFD_ACTION_FAILED',
          ...(result.errorReason ? { reason: result.errorReason } : {}),
          ...(result.message ? { message: result.message } : {}),
        },
        context,
      );
    } else {
      this.onResult?.(action, result, context);
    }
    return result;
  }

  /** 中止全部进行中的执行；文档关闭或组件销毁时调用。 */
  cancelAll(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /** 当前是否处于中止状态（上一次 `cancelAll()` 之后、尚未开始新一轮执行）。 */
  get cancelled(): boolean {
    return this.abortController.signal.aborted;
  }
}

/**
 * 把触发器映射为事件载荷中的 `pageIndex`。
 *
 * 文档级与大纲级动作没有页上下文，按设计不携带 `pageIndex`。
 *
 * @param action 动作。
 * @param trigger 触发来源。
 * @param pageIndex 触发页索引，0-based。
 * @returns 需要写入事件载荷的页索引；无页上下文时 undefined。
 */
export function eventPageIndex(
  action: ActionInfo,
  trigger: ActionTrigger,
  pageIndex: number,
): number | undefined {
  if (trigger === 'DO') return undefined;
  const owner = action.owner;
  if (owner.kind === 'page' || owner.kind === 'object') return owner.pageIndex;
  return undefined;
}

/**
 * 合并多个取消信号：任一中止即中止。
 *
 * @param a 信号 A；可为 undefined。
 * @param b 信号 B；可为 undefined。
 * @returns 合并后的信号；两者都缺失时 undefined。
 */
function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b || a === b) return a;
  if (a.aborted || b.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  // 一次性监听，控制器随两个来源一同释放；无需显式移除。
  return controller.signal;
}

/**
 * 判断信号是否已中止。
 *
 * @param signal 取消信号。
 * @returns 已中止（或不存在）时 false。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * 等待 Promise 完成或信号中止，取先发生者。
 *
 * @param promise 待等待的 Promise。
 * @param signal 取消信号。
 */
async function settleWhileAbortable(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await promise;
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', finish, { once: true });
    void promise.then(finish, finish);
  });
}

/**
 * 判断错误是否为取消错误。
 *
 * @param error 错误对象。
 * @returns 取消时 true。
 */
function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AbortError') return true;
  return (error as { code?: unknown }).code === 'OFD_ABORTED';
}

/**
 * 读取错误对象上的稳定错误码。
 *
 * @param error 错误对象。
 * @returns 字符串错误码；无则 undefined。
 */
function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}