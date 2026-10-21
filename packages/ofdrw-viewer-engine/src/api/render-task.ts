/**
 * 渲染任务（对应设计方案 15.1 / 10.7）。
 *
 * `promise` 在渲染完成时 resolve，取消或失败时 reject；`cancel()` 可重复调用。
 */

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