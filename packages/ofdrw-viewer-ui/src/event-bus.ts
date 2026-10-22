/**
 * 类型化事件总线。
 *
 * 每个 `OFDViewer` 实例持有独立总线，不使用全局单例；单个监听器抛错不会中断其他
 * 监听器或阅读流程，错误通过 `onListenerError` 上报给实例。
 */

import type { ViewerEventMap } from './types';

/** 事件监听器。 */
export type EventListener<T> = (payload: T) => void;

/** 事件总线选项。 */
export interface EventBusOptions {
  /**
   * 监听器异常回调；省略时吞掉异常，保证不影响其他监听器。
   *
   * @param error 监听器抛出的错误。
   * @param event 事件名。
   */
  readonly onListenerError?: (error: unknown, event: string) => void;
}

/** 内部监听记录；保留原始回调用于退订。 */
interface ListenerEntry {
  /** 宿主传入的原始回调。 */
  readonly listener: unknown;
  /** 实际调用入口，负责载荷类型收窄。 */
  readonly invoke: (payload: unknown) => void;
  /** 是否只触发一次。 */
  readonly once: boolean;
}

/**
 * 类型化事件总线。
 *
 * @typeParam M 事件名到载荷的映射；键名必须为字符串。
 */
export class EventBus<M extends object> {
  private readonly listeners = new Map<string, Set<ListenerEntry>>();
  private readonly onListenerError?: (error: unknown, event: string) => void;

  /**
   * 创建事件总线。
   *
   * @param options 监听器异常处理。
   */
  constructor(options: EventBusOptions = {}) {
    this.onListenerError = options.onListenerError;
  }

  /**
   * 订阅事件。
   *
   * @param event 事件名。
   * @param listener 监听器。
   * @returns 退订函数；可重复调用。
   */
  on<K extends keyof M & string>(event: K, listener: EventListener<M[K]>): () => void {
    return this.add(event, listener, false);
  }

  /**
   * 订阅一次事件。
   *
   * @param event 事件名。
   * @param listener 监听器。
   * @returns 退订函数；可重复调用。
   */
  once<K extends keyof M & string>(event: K, listener: EventListener<M[K]>): () => void {
    return this.add(event, listener, true);
  }

  /**
   * 退订事件。
   *
   * @param event 事件名。
   * @param listener 原始监听器。
   */
  off<K extends keyof M & string>(event: K, listener: EventListener<M[K]>): void {
    const entries = this.listeners.get(event);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.listener === listener) entries.delete(entry);
    }
    if (entries.size === 0) this.listeners.delete(event);
  }

  /**
   * 同步派发事件。
   *
   * 触发前生成监听器快照：派发过程中新增的监听器不参与本次派发；`once` 监听器在
   * 调用前移除，避免重入时重复触发。监听器异常被隔离并上报。
   *
   * @param event 事件名。
   * @param payload 事件载荷。
   */
  emit<K extends keyof M & string>(event: K, payload: M[K]): void {
    const entries = this.listeners.get(event);
    if (!entries || entries.size === 0) return;
    for (const entry of [...entries]) {
      if (entry.once) entries.delete(entry);
      try {
        entry.invoke(payload);
      } catch (error) {
        this.onListenerError?.(error, event);
      }
    }
    if (entries.size === 0) this.listeners.delete(event);
  }

  /**
   * 移除监听器。
   *
   * @param event 可选事件名；省略时清空全部。
   */
  removeAllListeners(event?: keyof M & string): void {
    if (event === undefined) {
      this.listeners.clear();
      return;
    }
    this.listeners.delete(event);
  }

  /**
   * 读取某事件的监听器数量。
   *
   * @param event 事件名。
   * @returns 监听器数量。
   */
  listenerCount(event: keyof M & string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * 注册监听器。
   *
   * @param event 事件名。
   * @param listener 监听器。
   * @param once 是否只触发一次。
   * @returns 退订函数。
   */
  private add<K extends keyof M & string>(
    event: K,
    listener: EventListener<M[K]>,
    once: boolean,
  ): () => void {
    let entries = this.listeners.get(event);
    if (!entries) {
      entries = new Set();
      this.listeners.set(event, entries);
    }
    const entry: ListenerEntry = {
      listener,
      once,
      invoke: (payload) => listener(payload as M[K]),
    };
    entries.add(entry);
    return () => {
      this.listeners.get(event)?.delete(entry);
    };
  }
}

/** 阅读器事件总线类型。 */
export type ViewerEventBus = EventBus<ViewerEventMap>;