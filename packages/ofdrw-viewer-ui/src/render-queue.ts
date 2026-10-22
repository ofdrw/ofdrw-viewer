/**
 * 渲染队列（设计方案 §6.4 / §12.4）。
 *
 * 负责优先级、并发、取消与代际丢弃：
 * - 优先级数字越小越先执行：0 可见页、1 相邻预取、2 缩略图/后台；
 * - 同 key 的新任务替换旧任务；旧任务结果即使晚到也会被丢弃；
 * - `AbortController` 把取消传播到引擎渲染；取消不视为错误；
 * - 单任务失败只回调 `onError`，不影响队列与其他页；
 * - 预取/后台任务在没有可见任务时通过 `requestIdleCallback`（或 setTimeout 兜底）
 *   延迟启动，避免与阅读抢主线程。
 *
 * 队列不解析 OFD、不持有 DOM；实际绘制由 `run` 回调完成。
 */

/** 空闲回调截止信息。 */
export interface IdleDeadlineLike {
  /** 是否因超时触发。 */
  readonly didTimeout: boolean;
  /** 剩余空闲时间，单位 ms。 */
  timeRemaining(): number;
}

/** 调度器抽象；测试可注入同步/受控实现。 */
export interface RenderQueueScheduler {
  /**
   * 请求下一帧。
   *
   * @param callback 帧回调。
   * @returns 帧句柄。
   */
  requestFrame(callback: FrameRequestCallback): number;
  /**
   * 取消帧请求。
   *
   * @param handle 帧句柄。
   */
  cancelFrame?(handle: number): void;
  /**
   * 请求空闲回调。
   *
   * @param callback 空闲回调。
   * @param timeout 超时，单位 ms。
   * @returns 空闲句柄。
   */
  requestIdle?(callback: (deadline: IdleDeadlineLike) => void, timeout?: number): number;
  /**
   * 取消空闲请求。
   *
   * @param handle 空闲句柄。
   */
  cancelIdle?(handle: number): void;
}

/** 单个渲染任务。 */
export interface RenderTaskSpec {
  /** 唯一键；同一页不同用途需使用不同前缀。 */
  readonly key: string;
  /** 页索引，0-based；用于稳定排序。 */
  readonly pageIndex: number;
  /** 优先级：0 可见页、1 预取、2 后台；默认 0。 */
  readonly priority?: number;
  /** 代次号；仅用于诊断，结果丢弃由调用方结合 PageView generation 判断。 */
  readonly generation?: number;
  /**
   * 执行任务。
   *
   * @param signal 取消信号；取消后应尽快抛错或返回。
   * @returns 完成时 resolve。
   */
  run(signal: AbortSignal): Promise<void>;
  /** 任务开始执行。 */
  onStart?(): void;
  /** 任务成功完成。 */
  onSuccess?(): void;
  /**
   * 任务失败（非取消）。
   *
   * @param error 原始错误。
   */
  onError?(error: unknown): void;
  /** 任务被取消（排队中取消或执行中中止）。 */
  onCancel?(): void;
}

/** 渲染队列选项。 */
export interface RenderQueueOptions {
  /** 并发任务数；默认 2，最小 1。 */
  readonly concurrency?: number;
  /** 调度器；省略时使用全局 `requestAnimationFrame`/`requestIdleCallback`。 */
  readonly scheduler?: RenderQueueScheduler;
  /** 预取/后台任务的空闲超时，单位 ms；默认 500。 */
  readonly idleTimeout?: number;
  /**
   * 未捕获的任务错误回调；用于宿主 warning，不影响队列。
   *
   * @param error 原始错误。
   * @param task 任务描述。
   */
  readonly onTaskError?: (error: unknown, task: RenderTaskSpec) => void;
}

/** 队列中的任务记录。 */
interface QueueEntry {
  /** 任务描述。 */
  readonly spec: RenderTaskSpec;
  /** 是否已开始执行。 */
  running: boolean;
  /** 是否已被取消/替换。 */
  cancelled: boolean;
  /** 执行中任务的取消器。 */
  controller?: AbortController;
}

/** 队列统计。 */
export interface RenderQueueStats {
  /** 排队任务数。 */
  readonly queued: number;
  /** 执行中任务数。 */
  readonly running: number;
  /** 已完成任务数。 */
  readonly completed: number;
  /** 失败任务数（不含取消）。 */
  readonly failed: number;
  /** 取消任务数。 */
  readonly cancelled: number;
}

/** 创建默认调度器。 */
function createDefaultScheduler(): RenderQueueScheduler {
  const global = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (handle: number) => void;
    requestIdleCallback?: (
      callback: (deadline: IdleDeadlineLike) => void,
      options?: { timeout?: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  const hasRaf = typeof global.requestAnimationFrame === 'function';
  const hasIdle = typeof global.requestIdleCallback === 'function';
  return {
    requestFrame: (callback) =>
      hasRaf
        ? global.requestAnimationFrame!(callback)
        : (setTimeout(() => callback(Date.now()), 16) as unknown as number),
    cancelFrame: (handle) => {
      if (hasRaf) global.cancelAnimationFrame!(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    requestIdle: (callback, timeout = 500) =>
      hasIdle
        ? global.requestIdleCallback!(callback, { timeout })
        : (setTimeout(
            () =>
              callback({
                didTimeout: true,
                timeRemaining: () => 50,
              }),
            0,
          ) as unknown as number),
    cancelIdle: (handle) => {
      if (hasIdle) global.cancelIdleCallback!(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
  };
}

/** 渲染队列。 */
export class RenderQueue {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly scheduler: RenderQueueScheduler;
  private readonly idleTimeout: number;
  private readonly onTaskError?: (error: unknown, task: RenderTaskSpec) => void;
  private concurrency: number;
  private frameHandle: number | null = null;
  private idleHandle: number | null = null;
  /** 当前是否处于空闲回调中；用于避免反复安排空闲回调却不启动任务。 */
  private idlePass = false;
  private disposed = false;
  private completedCount = 0;
  private failedCount = 0;
  private cancelledCount = 0;

  /**
   * @param options 并发、调度器与错误回调。
   */
  constructor(options: RenderQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency ?? 2));
    this.scheduler = options.scheduler ?? createDefaultScheduler();
    this.idleTimeout = Math.max(0, options.idleTimeout ?? 500);
    this.onTaskError = options.onTaskError;
  }

  /** 当前并发上限。 */
  get maxConcurrency(): number {
    return this.concurrency;
  }

  /** 排队任务数。 */
  get queuedCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (!entry.running) count += 1;
    return count;
  }

  /** 执行中任务数。 */
  get runningCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.running) count += 1;
    return count;
  }

  /** 队列是否空闲。 */
  get isIdle(): boolean {
    return this.entries.size === 0;
  }

  /** 队列统计。 */
  get stats(): RenderQueueStats {
    return {
      queued: this.queuedCount,
      running: this.runningCount,
      completed: this.completedCount,
      failed: this.failedCount,
      cancelled: this.cancelledCount,
    };
  }

  /**
   * 入队；同 key 的旧任务被取消并替换。
   *
   * @param spec 任务描述。
   */
  enqueue(spec: RenderTaskSpec): void {
    if (this.disposed) return;
    const existing = this.entries.get(spec.key);
    if (existing) {
      existing.cancelled = true;
      existing.controller?.abort();
      existing.spec.onCancel?.();
    }
    this.entries.set(spec.key, {
      spec,
      running: false,
      cancelled: false,
    });
    this.schedulePump();
  }

  /**
   * 取消指定 key。
   *
   * @param key 任务键。
   */
  cancel(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.running) {
      entry.controller?.abort();
    } else {
      this.entries.delete(key);
      this.cancelledCount += 1;
      this.safe(() => entry.spec.onCancel?.());
      this.schedulePump();
    }
  }

  /**
   * 取消满足条件的任务。
   *
   * @param predicate 判定函数。
   */
  cancelWhere(predicate: (task: RenderTaskSpec) => boolean): void {
    for (const [key, entry] of [...this.entries]) {
      if (predicate(entry.spec)) this.cancel(key);
    }
  }

  /** 取消全部任务；队列保留可用。 */
  cancelAll(): void {
    for (const key of [...this.entries.keys()]) this.cancel(key);
    if (this.frameHandle !== null) {
      this.scheduler.cancelFrame?.(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.idleHandle !== null) {
      this.scheduler.cancelIdle?.(this.idleHandle);
      this.idleHandle = null;
    }
  }

  /**
   * 调整并发；缩小时不打断已在执行的任务。
   *
   * @param concurrency 并发数，最小 1。
   */
  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, Math.trunc(concurrency));
    this.schedulePump();
  }

  /** 销毁队列；取消全部任务并拒绝后续入队。 */
  dispose(): void {
    if (this.disposed) return;
    this.cancelAll();
    this.disposed = true;
    this.entries.clear();
  }

  /** 请求一次泵调度（合并同一帧内的多次入队）。 */
  private schedulePump(): void {
    if (this.disposed || this.frameHandle !== null) return;
    this.frameHandle = this.scheduler.requestFrame(() => {
      this.frameHandle = null;
      this.pump();
    });
  }

  /** 尽可能启动任务。 */
  private pump(): void {
    if (this.disposed) return;
    while (this.runningCount < this.concurrency) {
      const next = this.pickNext();
      if (!next) return;
      const hasVisible = this.pickNext(0) !== undefined;
      if (next.spec.priority !== undefined && next.spec.priority > 0 && !hasVisible && !this.idlePass) {
        if (this.runWhenIdle()) return;
      }
      this.start(next);
    }
  }

  /**
   * 选取下一个待执行任务。
   *
   * @param exactPriority 是否只选指定优先级。
   * @returns 排队记录或 undefined。
   */
  private pickNext(exactPriority?: number): QueueEntry | undefined {
    let best: QueueEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.running || entry.cancelled) continue;
      const priority = entry.spec.priority ?? 0;
      if (exactPriority !== undefined && priority !== exactPriority) continue;
      if (!best) {
        best = entry;
        continue;
      }
      const bestPriority = best.spec.priority ?? 0;
      if (
        priority < bestPriority ||
        (priority === bestPriority && entry.spec.pageIndex < best.spec.pageIndex)
      ) {
        best = entry;
      }
    }
    return best;
  }

  /**
   * 在空闲时继续泵；已有空闲请求时返回 true。
   *
   * @returns 是否已安排空闲回调。
   */
  private runWhenIdle(): boolean {
    if (this.idleHandle !== null) return true;
    const requestIdle = this.scheduler.requestIdle;
    if (!requestIdle) return false;
    this.idleHandle = requestIdle(
      () => {
        this.idleHandle = null;
        if (this.disposed) return;
        this.idlePass = true;
        try {
          this.pump();
        } finally {
          this.idlePass = false;
        }
      },
      this.idleTimeout,
    );
    return true;
  }

  /**
   * 启动任务。
   *
   * @param entry 排队记录。
   */
  private start(entry: QueueEntry): void {
    const controller = new AbortController();
    entry.running = true;
    entry.controller = controller;
    entry.spec.onStart?.();
    void Promise.resolve()
      .then(() => entry.spec.run(controller.signal))
      .then(
        () => {
          if (entry.cancelled || controller.signal.aborted) {
            this.cancelledCount += 1;
            this.safe(() => entry.spec.onCancel?.());
            return;
          }
          this.completedCount += 1;
          this.safe(() => entry.spec.onSuccess?.());
        },
        (error: unknown) => {
          if (entry.cancelled || controller.signal.aborted) {
            this.cancelledCount += 1;
            this.safe(() => entry.spec.onCancel?.());
            return;
          }
          this.failedCount += 1;
          this.safe(() => entry.spec.onError?.(error));
          this.safe(() => this.onTaskError?.(error, entry.spec));
        },
      )
      .finally(() => {
        const current = this.entries.get(entry.spec.key);
        if (current === entry) this.entries.delete(entry.spec.key);
        if (!this.disposed) this.schedulePump();
      });
  }

  /**
   * 隔离回调异常。
   *
   * @param callback 回调。
   */
  private safe(callback: () => void): void {
    try {
      callback();
    } catch {
      // 回调异常不得中断队列调度。
    }
  }
}