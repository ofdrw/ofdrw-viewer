/**
 * CLI 进程退出码与错误映射。
 *
 * 退出码语义见 docs/CLI设计方案.md §5.4：
 * 0 成功；1 用法/参数/路径错误；2 文档级失败；3 页级失败；130 用户中断。
 */

import { isOFDError } from 'ofdrw-viewer-engine';

/** CLI 进程退出码常量。 */
export const EXIT_CODES = {
  /** 全部页成功（允许 warning）。 */
  OK: 0,
  /** 用法错误、参数非法、输入/输出路径错误、页码越界。 */
  USAGE: 1,
  /** 文档级失败：无法打开、非 OFD、加密等。 */
  DOCUMENT: 2,
  /** 页级失败：至少一页失败且至少一页成功。 */
  PAGE: 3,
  /** 用户中断（SIGINT）。 */
  INTERRUPTED: 130,
} as const;

/** `EXIT_CODES` 中单个退出码的类型。 */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * CLI 自身产生的错误码。
 *
 * engine 的 `OFD_*` 错误码由后续图片链路接入后原样透传，不在此枚举中。
 */
export type CliErrorCode =
  | 'CLI_USAGE'
  | 'CLI_INVALID_FORMAT'
  | 'CLI_INVALID_DPI'
  | 'CLI_INVALID_PAGES'
  | 'CLI_INPUT_NOT_FOUND'
  | 'CLI_INPUT_NOT_FILE'
  | 'CLI_INPUT_UNREADABLE'
  | 'CLI_OUTPUT_NOT_DIRECTORY'
  | 'CLI_OUTPUT_CREATE_FAILED'
  | 'CLI_FONT_DIR_INVALID'
  | 'CLI_FONT_DIR_UNREADABLE'
  | 'CLI_IMAGE_WRITE_FAILED'
  | 'CLI_PAGE_TOO_LARGE'
  | 'CLI_UNEXPECTED';

/** 可携带退出码的 CLI 错误。 */
export class CliError extends Error {
  /** 稳定的错误码，用于日志与脚本匹配。 */
  readonly code: CliErrorCode;

  /** 该错误对应的进程退出码。 */
  readonly exitCode: ExitCode;

  /**
   * @param code 稳定错误码
   * @param message 面向用户的中文错误说明
   * @param exitCode 进程退出码，默认 1（用法错误）
   * @param options 原生 `Error` 选项（如 `cause`）
   */
  constructor(
    code: CliErrorCode,
    message: string,
    exitCode: ExitCode = EXIT_CODES.USAGE,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** 判断任意值是否为 `CliError`。 */
export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

/** 判断任意值是否为带指定 `code` 的 Node 系统错误。 */
export function isErrnoError(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === code
  );
}

/** 提取任意抛出值的可读消息。 */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** 归一化后的错误描述，供日志与退出码计算使用。 */
export interface CliFailure {
  /** 稳定错误码；engine 错误透传 `OFD_*`，未知异常归为 `CLI_UNEXPECTED`。 */
  readonly code: string;
  /** 面向用户的消息。 */
  readonly message: string;
  /** 进程退出码。 */
  readonly exitCode: ExitCode;
  /** 原始堆栈，仅未知异常提供。 */
  readonly stack?: string;
}

/**
 * 将任意抛出值归一化为 `CliFailure`。
 *
 * engine 的 `OFDError` 保留原始错误码并按文档级失败（退出码 2）处理；
 * 其余非 `CliError` 统一归为 `CLI_UNEXPECTED`，并保留堆栈。
 */
export function toCliError(error: unknown): CliFailure {
  if (isCliError(error)) {
    return { code: error.code, message: error.message, exitCode: error.exitCode };
  }
  if (isOFDError(error)) {
    return { code: error.code, message: error.message, exitCode: EXIT_CODES.DOCUMENT };
  }
  return {
    code: 'CLI_UNEXPECTED',
    message: errorMessage(error),
    exitCode: EXIT_CODES.DOCUMENT,
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/** 计算任意抛出值对应的进程退出码。 */
export function exitCodeForError(error: unknown): ExitCode {
  return isCliError(error) ? error.exitCode : EXIT_CODES.DOCUMENT;
}
