/**
 * 控制台日志。
 *
 * 正常信息写 stdout，错误与 warning 写 stderr；warning 在结束时按错误码汇总。
 * 输出流可注入，便于单元测试捕获内容。
 */

/** 最小可写流接口；`process.stdout` / `process.stderr` 均满足。 */
export interface OutputStream {
  write(chunk: string): unknown;
}

/** `Logger` 的构造参数。 */
export interface LoggerOptions {
  /** 正常信息输出流，默认 `process.stdout`。 */
  readonly stdout?: OutputStream;
  /** 错误与 warning 输出流，默认 `process.stderr`。 */
  readonly stderr?: OutputStream;
}

/** CLI 控制台日志器。 */
export class Logger {
  readonly #stdout: OutputStream;
  readonly #stderr: OutputStream;
  readonly #warningCounts = new Map<string, number>();

  /** @param options 输出流覆盖；省略时使用进程标准流 */
  constructor(options: LoggerOptions = {}) {
    this.#stdout = options.stdout ?? process.stdout;
    this.#stderr = options.stderr ?? process.stderr;
  }

  /** 输出一条普通信息到 stdout。 */
  info(message: string): void {
    this.#stdout.write(`${message}\n`);
  }

  /** 输出一条错误到 stderr，格式为 `错误[CODE]：message`。 */
  error(code: string, message: string): void {
    this.#stderr.write(`错误[${code}]：${message}\n`);
  }

  /**
   * 输出一条 warning 到 stderr，并累计其错误码。
   *
   * @param code warning 码，如 `W_FONT_DIR_EMPTY`
   * @param message 面向用户的说明
   * @param pageNumber 可选页号（1 起）；提供时输出 `第 N 页`
   */
  warn(code: string, message: string, pageNumber?: number): void {
    const location = pageNumber === undefined ? '' : ` 第 ${pageNumber} 页`;
    this.#stderr.write(`警告 [${code}]${location}：${message}\n`);
    this.#warningCounts.set(code, (this.#warningCounts.get(code) ?? 0) + 1);
  }

  /** 输出原始多行文本到 stderr（用法提示、堆栈等）。 */
  detail(message: string): void {
    this.#stderr.write(`${message}\n`);
  }

  /** 返回 warning 码到出现次数的只读快照。 */
  warningCounts(): ReadonlyMap<string, number> {
    return new Map(this.#warningCounts);
  }

  /**
   * 生成按错误码排序的 warning 汇总行。
   *
   * @returns 汇总文本；没有 warning 时返回 `undefined`
   */
  formatWarningSummary(): string | undefined {
    if (this.#warningCounts.size === 0) return undefined;
    const parts = [...this.#warningCounts.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([code, count]) => `${code}×${count}`);
    return `警告汇总：${parts.join('、')}`;
  }

  /** 有 warning 时输出汇总行到 stderr。 */
  flushWarningSummary(): void {
    const summary = this.formatWarningSummary();
    if (summary !== undefined) this.detail(summary);
  }
}