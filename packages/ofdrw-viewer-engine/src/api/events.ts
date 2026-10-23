/**
 * 引擎页面级事件系统（对应《OFD 渲染引擎生命周期与事件设计》§3）。
 *
 * 本模块只依赖平台无关类型，不引用 DOM `EventTarget`/`CustomEvent`，可在
 * Node/小程序环境直接使用。事件名、载荷与派发语义是公共契约：
 * - 事件名是字符串字面量联合，载荷按名称推导；
 * - `emit` 同步派发，派发前快照监听器集合，单个监听器异常被隔离；
 * - 无监听器时不构造载荷、不派发；
 * - 总线派发序号 `sequence` 从 1 开始单调递增。
 */

import type { OFDSource } from '../platform/source';
import type { OFDError } from '../errors';

// ---------------------------------------------------------------------------
// 通用事件字段
// ---------------------------------------------------------------------------

/** 所有事件的公共字段。 */
export interface OFDEventBase {
  /** 事件名。 */
  readonly type: OFDEventName;
  /** 事件时间，Unix 毫秒（Date.now）。 */
  readonly timestamp: number;
  /** 总线派发序号，从 1 开始单调递增。 */
  readonly sequence: number;
}

/** 带操作归属的事件公共字段。 */
export interface OFDOperationEventBase extends OFDEventBase {
  /** 操作 ID，文档内唯一，从 1 开始；`RenderTask.id` 使用同一编号。 */
  readonly operationId: number;
}

/** 页面操作的公共字段。 */
export interface OFDPageOperationEventBase extends OFDOperationEventBase {
  /** 页索引，从 0 开始。 */
  readonly pageIndex: number;
}

/** 取消来源：`caller` 为调用方取消，`close` 为文档关闭。 */
export type OFDAbortCause = 'caller' | 'close';

// ---------------------------------------------------------------------------
// 文档打开/关闭载荷
// ---------------------------------------------------------------------------

/** `document:open:start`：打开开始，容器打开前派发。 */
export interface DocumentOpenStartEvent extends OFDOperationEventBase {
  readonly type: 'document:open:start';
  /** 来源类型；不携带来源内容本身。 */
  readonly sourceKind: OFDSource['kind'];
  /** 多文档包中的文档索引。 */
  readonly documentIndex: number;
  /** 是否通过 container/containerFactory 注入，而非 engine 默认 ZIP。 */
  readonly viaContainer: boolean;
}

/** `document:open:end`：文档构造完成，`open()` resolve 前派发。 */
export interface DocumentOpenEndEvent extends OFDOperationEventBase {
  readonly type: 'document:open:end';
  /** 文档总页数，单位：页。 */
  readonly pageCount: number;
  /** OFD 版本号。 */
  readonly version: string;
  /** 原始包字节数，单位：byte。 */
  readonly packageSize: number;
  /** 打开总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

/** `document:open:error`：打开失败。 */
export interface DocumentOpenErrorEvent extends OFDOperationEventBase {
  readonly type: 'document:open:error';
  /** 打开失败的 OFDError。 */
  readonly error: OFDError;
  /** 打开总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

/** `document:open:abort`：打开被调用方 signal 取消。 */
export interface DocumentOpenAbortEvent extends OFDOperationEventBase {
  readonly type: 'document:open:abort';
  readonly cause: 'caller';
  /** 取消信号原因；未提供时为 undefined。 */
  readonly reason?: unknown;
  /** 打开总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

/** `document:close:start`：开始关闭。 */
export interface DocumentCloseStartEvent extends OFDOperationEventBase {
  readonly type: 'document:close:start';
}

/** `document:close:end`：资源释放完成，也是本文档的最后一帧事件。 */
export interface DocumentCloseEndEvent extends OFDOperationEventBase {
  readonly type: 'document:close:end';
  /** 关闭总耗时，单位：毫秒。 */
  readonly durationMs: number;
  /** 本次关闭中止的活动操作数量，单位：个。 */
  readonly abortedOperations: number;
}

// ---------------------------------------------------------------------------
// 页面加载载荷
// ---------------------------------------------------------------------------

/** `page:load:start`：`getPage()` 入口校验通过后派发。 */
export interface PageLoadStartEvent extends OFDPageOperationEventBase {
  readonly type: 'page:load:start';
}

/** `page:load:end`：页面句柄创建完成，`getPage()` resolve 前派发。 */
export interface PageLoadEndEvent extends OFDPageOperationEventBase {
  readonly type: 'page:load:end';
  /** 页宽，单位：毫米。 */
  readonly widthMm: number;
  /** 页高，单位：毫米。 */
  readonly heightMm: number;
  /** 加载总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

/** `page:load:error`：页面模型/资源加载失败。 */
export interface PageLoadErrorEvent extends OFDPageOperationEventBase {
  readonly type: 'page:load:error';
  /** 加载失败的 OFDError。 */
  readonly error: OFDError;
  /** 加载总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

/** `page:load:abort`：取页取消或文档关闭。 */
export interface PageLoadAbortEvent extends OFDPageOperationEventBase {
  readonly type: 'page:load:abort';
  readonly cause: OFDAbortCause;
  /** 取消原因；文档关闭且未提供原因时为 undefined。 */
  readonly reason?: unknown;
  /** 加载总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// 页面渲染载荷
// ---------------------------------------------------------------------------

/** `page:render:start`：入口校验通过、`render()` 返回前同步派发。 */
export interface PageRenderStartEvent extends OFDPageOperationEventBase {
  readonly type: 'page:render:start';
  /** 渲染精度，单位：DPI。 */
  readonly dpi: number;
  /** viewport 宽度，设备像素。 */
  readonly width: number;
  /** viewport 高度，设备像素。 */
  readonly height: number;
}

/** `page:render:end`：绘制完成、`task.promise` resolve 前派发。 */
export interface PageRenderEndEvent extends OFDPageOperationEventBase {
  readonly type: 'page:render:end';
  /** 渲染总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

/** `page:render:error`：准备或绘制失败。 */
export interface PageRenderErrorEvent extends OFDPageOperationEventBase {
  readonly type: 'page:render:error';
  /** 渲染失败的 OFDError。 */
  readonly error: OFDError;
  /** 渲染总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

/** `page:render:abort`：`task.cancel()`、外部 signal 或文档关闭。 */
export interface PageRenderAbortEvent extends OFDPageOperationEventBase {
  readonly type: 'page:render:abort';
  readonly cause: OFDAbortCause;
  /** 取消原因；`task.cancel()` 不携带原因时为 undefined。 */
  readonly reason?: unknown;
  /** 渲染总耗时，单位：毫秒。 */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// 事件映射与监听器类型
// ---------------------------------------------------------------------------

/** 事件名 → 载荷映射；宿主按事件名推导载荷类型。 */
export interface OFDEventMap {
  'document:open:start': DocumentOpenStartEvent;
  'document:open:end': DocumentOpenEndEvent;
  'document:open:error': DocumentOpenErrorEvent;
  'document:open:abort': DocumentOpenAbortEvent;
  'document:close:start': DocumentCloseStartEvent;
  'document:close:end': DocumentCloseEndEvent;
  'page:load:start': PageLoadStartEvent;
  'page:load:end': PageLoadEndEvent;
  'page:load:error': PageLoadErrorEvent;
  'page:load:abort': PageLoadAbortEvent;
  'page:render:start': PageRenderStartEvent;
  'page:render:end': PageRenderEndEvent;
  'page:render:error': PageRenderErrorEvent;
  'page:render:abort': PageRenderAbortEvent;
}

/** 所有事件名。 */
export type OFDEventName = keyof OFDEventMap;

/** 指定事件的监听器。 */
export type OFDEventHandler<K extends OFDEventName> = (event: OFDEventMap[K]) => void;

/** 页面监听器可接收的事件名。 */
export type OFDPageEventName = Extract<OFDEventName, `page:${string}`>;

/** 页面监听器可接收的事件映射。 */
export type OFDPageEventMap = Pick<OFDEventMap, OFDPageEventName>;

/** `addEventListener` 选项。 */
export interface OFDAddEventListenerOptions {
  /** 是否只触发一次。 */
  once?: boolean;
  /** 绑定生命周期；abort 后自动移除监听器。 */
  signal?: AbortSignal;
}

/** 事件总线选项。 */
export interface OFDEventBusOptions {
  /**
   * 监听器异常回调；省略时吞掉异常。
   *
   * @param error 监听器抛出的错误。
   * @param type 事件名。
   */
  onListenerError?: (error: unknown, type: OFDEventName) => void;
}

// ---------------------------------------------------------------------------
// 事件总线
// ---------------------------------------------------------------------------

/** 内部监听器记录；同一回调可注册多次，因此每条记录独立存在。 */
interface ListenerRecord {
  /** 原始回调。 */
  handler: (event: never) => void;
  /** 是否只触发一次。 */
  once: boolean;
  /** 移除 signal 上的 abort 监听；未使用 signal 时为 undefined。 */
  detachSignal?: () => void;
}

/**
 * OFD 引擎事件总线。
 *
 * 派发语义（§3.4）：
 * - 同步派发，监听器在 `emit` 调用栈内执行；
 * - 派发前快照监听器集合，派发中新增的监听器不参与本次事件；
 * - `once` 在调用前移除，监听器抛错也不会再次触发；
 * - 单个监听器异常被捕获，不影响其他监听器与引擎结果；
 * - 无监听器时直接返回，不构造载荷。
 */
export class OFDEventBus {
  /** 事件名 → 监听器记录；同一回调可重复注册。 */
  private readonly listeners = new Map<OFDEventName, Set<ListenerRecord>>();
  /** 监听器异常回调；省略时静默。 */
  private readonly onListenerError: ((error: unknown, type: OFDEventName) => void) | undefined;
  /** 总线派发序号，从 1 开始。 */
  private sequence = 0;

  /**
   * @param options 监听器异常回调。
   */
  constructor(options: OFDEventBusOptions = {}) {
    this.onListenerError = options.onListenerError;
  }

  /**
   * 订阅事件。
   *
   * @param type 事件名。
   * @param handler 监听器。
   * @returns 退订函数；可重复调用。
   */
  on<K extends OFDEventName>(type: K, handler: OFDEventHandler<K>): () => void {
    return this.addListener(type, handler, false);
  }

  /**
   * 订阅一次事件。
   *
   * @param type 事件名。
   * @param handler 监听器。
   * @returns 退订函数；可重复调用。
   */
  once<K extends OFDEventName>(type: K, handler: OFDEventHandler<K>): () => void {
    return this.addListener(type, handler, true);
  }

  /**
   * 退订事件；同一回调的多次注册全部移除。
   *
   * @param type 事件名。
   * @param handler 监听器。
   */
  off<K extends OFDEventName>(type: K, handler: OFDEventHandler<K>): void {
    const records = this.listeners.get(type);
    if (!records) return;
    for (const record of [...records]) {
      if (record.handler === (handler as (event: never) => void)) {
        this.removeRecord(type, record);
      }
    }
  }

  /**
   * DOM 风格订阅；行为与 `on` 一致并支持 `once`/`signal`。
   *
   * signal 已中止时不注册；注册后中止则自动移除。
   *
   * @param type 事件名。
   * @param handler 监听器。
   * @param options once 与 signal 选项。
   */
  addEventListener<K extends OFDEventName>(
    type: K,
    handler: OFDEventHandler<K>,
    options: OFDAddEventListenerOptions = {},
  ): void {
    this.addListener(type, handler, options.once === true, options.signal);
  }

  /**
   * DOM 风格退订；与 `off` 等价。
   *
   * @param type 事件名。
   * @param handler 监听器。
   */
  removeEventListener<K extends OFDEventName>(type: K, handler: OFDEventHandler<K>): void {
    this.off(type, handler);
  }

  /**
   * 移除指定事件或全部监听器；主要供宿主编排和测试清理。
   *
   * @param type 事件名；省略时清空全部。
   */
  removeAllListeners(type?: OFDEventName): void {
    if (type === undefined) {
      for (const records of this.listeners.values()) {
        for (const record of records) record.detachSignal?.();
      }
      this.listeners.clear();
      return;
    }
    const records = this.listeners.get(type);
    if (!records) return;
    for (const record of [...records]) record.detachSignal?.();
    this.listeners.delete(type);
  }

  /**
   * 当前监听器数量。
   *
   * @param type 事件名。
   * @returns 监听器数量。
   */
  listenerCount(type: OFDEventName): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /**
   * 引擎内部派发入口；宿主只应订阅。
   *
   * @internal
   * @param type 事件名。
   * @param event 已补齐 type/timestamp/sequence 的事件载荷。
   */
  emit<K extends OFDEventName>(type: K, event: OFDEventMap[K]): void {
    const records = this.listeners.get(type);
    if (!records || records.size === 0) return;
    // 快照派发：派发中新增的监听器不参与本次事件。
    const snapshot = [...records];
    for (const record of snapshot) {
      if (record.once) this.removeRecord(type, record);
      try {
        (record.handler as (value: OFDEventMap[K]) => void)(event);
      } catch (error) {
        this.reportListenerError(error, type);
      }
    }
  }

  /**
   * 分配下一个派发序号；仅引擎内部派发器使用。
   *
   * @internal
   * @returns 从 1 开始递增的序号。
   */
  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * 添加监听器记录。
   *
   * @param type 事件名。
   * @param handler 监听器。
   * @param once 是否只触发一次。
   * @param signal 绑定生命周期。
   * @returns 退订函数。
   */
  private addListener<K extends OFDEventName>(
    type: K,
    handler: OFDEventHandler<K>,
    once: boolean,
    signal?: AbortSignal,
  ): () => void {
    if (signal?.aborted) return () => undefined;
    const record: ListenerRecord = {
      handler: handler as (event: never) => void,
      once,
    };
    let records = this.listeners.get(type);
    if (!records) {
      records = new Set<ListenerRecord>();
      this.listeners.set(type, records);
    }
    records.add(record);
    if (signal) {
      const onAbort = (): void => this.removeRecord(type, record);
      signal.addEventListener('abort', onAbort, { once: true });
      record.detachSignal = () => signal.removeEventListener('abort', onAbort);
    }
    return () => this.removeRecord(type, record);
  }

  /**
   * 移除单条监听器记录并释放 signal 绑定。
   *
   * @param type 事件名。
   * @param record 监听器记录。
   */
  private removeRecord(type: OFDEventName, record: ListenerRecord): void {
    const records = this.listeners.get(type);
    if (records) {
      records.delete(record);
      if (records.size === 0) this.listeners.delete(type);
    }
    record.detachSignal?.();
    record.detachSignal = undefined;
  }

  /**
   * 上报监听器异常；回调自身抛错也被吞掉。
   *
   * @param error 监听器抛出的错误。
   * @param type 事件名。
   */
  private reportListenerError(error: unknown, type: OFDEventName): void {
    if (!this.onListenerError) return;
    try {
      this.onListenerError(error, type);
    } catch {
      // 异常回调抛错不影响派发与其他监听器。
    }
  }
}

// ---------------------------------------------------------------------------
// 引擎内部派发器
// ---------------------------------------------------------------------------

/**
 * 事件载荷（不含总线补齐的公共字段）。
 *
 * @internal
 */
export type OFDEventPayload<K extends OFDEventName> = Omit<
  OFDEventMap[K],
  'type' | 'timestamp' | 'sequence'
>;

/**
 * 引擎内部事件派发器。
 *
 * 负责操作 ID、时间戳与总线序号的分配，并在无监听器时跳过载荷构造；
 * 不导出到包入口，宿主只通过 `OFDEventBus` 订阅。
 *
 * @internal
 */
export class OFDInternalEventDispatcher {
  /** 操作 ID 计数，文档内从 1 开始。 */
  private operationSequence = 0;
  /** 关闭后静默标记。 */
  private muted = false;

  /**
   * @param bus 文档生命周期事件总线。
   */
  constructor(private readonly bus: OFDEventBus) {}

  /**
   * 分配操作 ID；文档内唯一，从 1 开始。
   *
   * @internal
   * @returns 操作 ID。
   */
  allocateOperationId(): number {
    this.operationSequence += 1;
    return this.operationSequence;
  }

  /**
   * 同步派发事件；`close:end` 后不再派发。
   *
   * @internal
   * @param type 事件名。
   * @param payload 载荷（不含 type/timestamp/sequence）。
   */
  emit<K extends OFDEventName>(type: K, payload: OFDEventPayload<K>): void {
    // 无监听器零负担：不构造载荷、不递增序号。
    if (this.muted || this.bus.listenerCount(type) === 0) return;
    const event = {
      ...payload,
      type,
      timestamp: Date.now(),
      sequence: this.bus.nextSequence(),
    } as OFDEventMap[K];
    this.bus.emit(type, event);
  }

  /**
   * 关闭后静默；已注册监听器保留但不再被调用。
   *
   * @internal
   */
  mute(): void {
    this.muted = true;
  }
}