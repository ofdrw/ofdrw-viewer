/** CLI 单元测试共享工具。 */

import type { OutputStream } from '../../src/log.js';

/** 内存输出流捕获结果。 */
export interface StreamCapture {
  /** 可注入 Logger / main 的 stdout。 */
  readonly stdout: OutputStream;
  /** 可注入 Logger / main 的 stderr。 */
  readonly stderr: OutputStream;
  /** 返回目前为止写入 stdout 的文本。 */
  stdoutText(): string;
  /** 返回目前为止写入 stderr 的文本。 */
  stderrText(): string;
}

/** 创建内存 stdout/stderr 捕获器。 */
export function createStreamCapture(): StreamCapture {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk: string): boolean {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string): boolean {
        stderr += chunk;
        return true;
      },
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}