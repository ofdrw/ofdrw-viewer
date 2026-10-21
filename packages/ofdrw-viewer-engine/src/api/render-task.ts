/**
 * 渲染任务与取消（对应设计方案 15.1 / 10.7 / 16.3）。
 *
 * `RenderTask` 是公开句柄：`promise` 在完成时 resolve，取消或失败时 reject；
 * `cancel()` 可重复调用。内部通过 `AbortController` 把取消传播到准备/绘制阶段。
 */

import { OFDError } from '../errors';
import type { OFDErrorCode } from '../errors';

/**
 * 一次页面渲染的句柄。
 *
 * 由 `OFDPage.render()` 创建，宿主不应直接构造。
 */
export class RenderTask {
  /** 渲染完成/失败/取消的 promise。 */
  readonly promise: Promise<void>;
  private readonly cancelHandler?: () => void;
  private cancelled = false;

  /**
   * 创建渲染任务。
   *
   * @param promise 实际渲染 promise。
   * @param cancelHandler 取消回调；缺省时只标记取消状态。
   */
  constructor(promise: Promise<void>, cancelHandler?: () => void) {
    this.promise = promise;
    this.cancelHandler = cancelHandler;
  }

  /** 请求取消；重复调用无副作用。 */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelHandler?.();
  }
}

/**
 * 创建标准的取消错误。
 *
 * @param cause 原始取消原因（可选）。
 * @returns `OFD_ABORTED`。
 */
export function createAbortError(cause?: unknown): OFDError {
  return new OFDError('OFD_ABORTED', '渲染已取消', cause === undefined ? undefined : { cause });
}

/**
 * 若信号已中止则抛出 `OFD_ABORTED`。
 *
 * @param signal 取消信号。
 * @throws OFDError code=OFD_ABORTED。
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

/**
 * 合并多个取消信号；任一信号中止即视为整体中止。
 *
 * 返回的 `dispose()` 必须在使用结束后调用，避免监听器泄漏。
 *
 * @param signals 取消信号列表；`undefined` 项忽略。
 * @returns 合并后的信号与清理函数。
 */
export function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove();
      listeners.length = 0;
    },
  };
}

/**
 * 创建渲染任务。
 *
 * - 内部 AbortController 与宿主 `externalSignal` 合并；
 * - `run` 任意阶段抛出的错误都会原样 reject，取消则统一转成 `OFD_ABORTED`；
 * - 任务结束后自动移除外部信号监听。
 *
 * @param run 实际渲染逻辑，接收合并后的取消信号。
 * @param externalSignal 宿主传入的 `AbortSignal`。
 * @returns 渲染任务句柄。
 */
export function createRenderTask(
  run: (signal: AbortSignal) => Promise<void>,
  externalSignal?: AbortSignal,
): RenderTask {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const promise = (async (): Promise<void> => {
    try {
      if (controller.signal.aborted) throw createAbortError(controller.signal.reason);
      await run(controller.signal);
      // 绘制阶段可能正常返回但期间已收到取消；此时仍以 OFD_ABORTED 结束。
      if (controller.signal.aborted) throw createAbortError(controller.signal.reason);
    } catch (error) {
      if (controller.signal.aborted) throw createAbortError(error);
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  })();

  return new RenderTask(promise, () => controller.abort());
}

/**
 * 把非 OFDError 包装成指定错误码；已是 OFDError 时保留原错误。
 *
 * @param error 原始错误。
 * @param code 包装使用的错误码。
 * @param message 包装信息。
 * @returns OFDError。
 */
export function wrapError(error: unknown, code: OFDErrorCode, message: string): OFDError {
  if (error instanceof OFDError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new OFDError(code, `${message}：${detail}`, { cause: error });
}