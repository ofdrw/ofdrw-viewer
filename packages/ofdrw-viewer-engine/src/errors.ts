/**
 * 引擎错误类型与错误码（对应设计方案 15.4）。
 *
 * 错误码是公共契约，冻结后不得增删/改名；warning 见 warnings.ts。
 */

/** 公共错误码。 */
export type OFDErrorCode =
  | 'OFD_INVALID_PACKAGE'
  | 'OFD_ENTRY_NOT_FOUND'
  | 'OFD_UNSUPPORTED_COMPRESSION'
  | 'OFD_ENCRYPTED'
  | 'OFD_XML_PARSE'
  | 'OFD_PAGE_NOT_FOUND'
  | 'OFD_CANVAS_TOO_LARGE'
  | 'OFD_CANVAS_SIZE_MISMATCH'
  | 'OFD_RENDERER_UNSUPPORTED'
  | 'OFD_ABORTED'
  | 'OFD_CLOSED'
  | 'OFD_LIMIT_EXCEEDED'
  | 'OFD_FONT_PARSE'
  | 'OFD_IMAGE_DECODE';

/** 可选的错误附加信息。 */
export interface OFDErrorOptions {
  /** 原始错误。 */
  cause?: unknown;
}

/**
 * 引擎统一错误。
 *
 * 所有公共 API 的失败都应抛该类型；`code` 用于程序分支，`message` 用于诊断。
 */
export class OFDError extends Error {
  /** 机器可读错误码。 */
  readonly code: OFDErrorCode;
  /** 原始错误（若存在）。 */
  override readonly cause?: unknown;

  /**
   * 创建错误。
   *
   * @param code 错误码。
   * @param message 人类可读信息。
   * @param options 可选原始错误。
   */
  constructor(code: OFDErrorCode, message: string, options?: OFDErrorOptions) {
    super(message);
    this.name = 'OFDError';
    this.code = code;
    this.cause = options?.cause;
  }
}

/**
 * 判断一个值是否为 OFDError。
 *
 * @param value 待判断值。
 * @returns 是 OFDError 时返回 true。
 */
export function isOFDError(value: unknown): value is OFDError {
  return value instanceof OFDError;
}

/**
 * 把任意错误包装成 OFDError；已是 OFDError 时原样返回。
 *
 * @param error 原始错误/值。
 * @param code 包装时使用的错误码。
 * @param message 包装时使用的信息。
 * @returns OFDError 实例。
 */
export function toOFDError(error: unknown, code: OFDErrorCode, message: string): OFDError {
  if (error instanceof OFDError) return error;
  return new OFDError(code, message, { cause: error });
}