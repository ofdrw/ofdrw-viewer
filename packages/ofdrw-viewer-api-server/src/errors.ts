/**
 * 错误码 → HTTP 状态码映射与统一错误体。
 *
 * `code` 沿用 engine、crypto 与 CLI 的原始错误码；未知异常统一为
 * `CLI_UNEXPECTED` 并映射 500。
 */

/** 错误码到 HTTP 状态码的固定映射。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  CLI_USAGE: 400,
  CLI_INVALID_PAGES: 400,
  CLI_INVALID_DPI: 400,
  CLI_INVALID_FORMAT: 400,
  CLI_INVALID_MEDIA_KIND: 400,
  CLI_JOB_TOO_MANY_PAGES: 400,
  CLI_CONFIG_INVALID: 400,
  CLI_JOB_NOT_FOUND: 404,
  CLI_METHOD_NOT_ALLOWED: 405,
  CLI_JOB_EXPIRED: 410,
  CLI_JOB_STORAGE_FULL: 412,
  CLI_UPLOAD_TOO_LARGE: 413,
  OFD_ENCRYPTED: 415,
  CLI_UNSUPPORTED_MEDIA_TYPE: 415,
  OFD_INVALID_PACKAGE: 422,
  CRYPTO_INVALID_PACKAGE: 422,
  CRYPTO_SOURCE_UNSUPPORTED: 422,
  CLI_UNEXPECTED: 500,
  CLI_JOB_TIMEOUT: 500,
  CLI_SERVER_BUSY: 503,
};

/** 可携带错误码与状态码的服务错误。 */
export class ApiError extends Error {
  /** 稳定错误码。 */
  readonly code: string;

  /** 对应的 HTTP 状态码。 */
  readonly status: number;

  /**
   * @param code 稳定错误码
   * @param message 面向调用方的中文说明
   * @param status 覆盖默认映射的 HTTP 状态码
   */
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? statusOfCode(code);
  }
}

/**
 * 查询错误码对应的 HTTP 状态码。
 *
 * @param code 错误码
 * @returns 状态码；未登记时为 500
 */
export function statusOfCode(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * 从任意抛出值提取错误码。
 *
 * @param error 抛出值
 * @returns 错误码；无法识别时为 `CLI_UNEXPECTED`
 */
export function errorCodeOf(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'CLI_UNEXPECTED';
}

/**
 * 把任意抛出值归一为错误体。
 *
 * @param error 抛出值
 * @returns 状态码、错误码与消息
 */
export function toErrorBody(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const code = errorCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  return { status: statusOfCode(code), code, message };
}