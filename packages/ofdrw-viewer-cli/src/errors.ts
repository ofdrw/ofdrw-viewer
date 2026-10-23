/**
 * CLI 进程退出码与错误映射。
 *
 * 退出码语义见 docs/CLI设计方案.md §5.4 与
 * docs/ofdrw-viewer-crypto设计方案.md §7.5：
 * 0 成功；1 用法/参数/路径错误；2 文档级失败；3 页级失败；
 * 4 加密/凭据失败；5 验证未通过；130 用户中断。
 */

import { isCryptoError, type CryptoErrorCode } from '@ofdrw/ofdrw-viewer-crypto';
import { isOFDError } from '@ofdrw/ofdrw-viewer-engine';

/** CLI 进程退出码常量。 */
export const EXIT_CODES = {
  /** 全部页成功（允许 warning）；info 查询成功；verify 结果为 valid。 */
  OK: 0,
  /** 用法错误、参数非法、输入/输出路径错误、页码越界。 */
  USAGE: 1,
  /** 文档级失败：无法打开、非 OFD、包损坏等。 */
  DOCUMENT: 2,
  /** 页级失败：至少一页失败且至少一页成功。 */
  PAGE: 3,
  /** 加密/凭据失败：缺少凭据、用户名不存在、口令/私钥错误、解密失败。 */
  CREDENTIAL: 4,
  /** 验证未通过：verify 的 invalid/unknown/unsupported/not-applicable。 */
  VERIFY_FAILED: 5,
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
  | 'CLI_TEXT_WRITE_FAILED'
  | 'CLI_TEXT_UNSUPPORTED'
  | 'CLI_PAGE_TOO_LARGE'
  | 'CLI_CREDENTIALS_INCOMPLETE'
  | 'CLI_CREDENTIALS_CONFLICT'
  | 'CLI_CREDENTIAL_FILE_NOT_FOUND'
  | 'CLI_CREDENTIAL_FILE_UNREADABLE'
  | 'CLI_CREDENTIALS_REQUIRED'
  | 'CLI_ROOT_FILE_NOT_FOUND'
  | 'CLI_ROOT_FILE_UNREADABLE'
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

/**
 * crypto 错误码到 CLI 退出码的映射。
 *
 * 分类依据设计 §3.7 与 §7.5：凭据/解密失败 4；包结构/文档级 2；
 * ASN.1/验证入口失败 5；参数 1；取消 130。
 */
const CRYPTO_EXIT_CODES: Readonly<Record<CryptoErrorCode, ExitCode>> = Object.freeze({
  CRYPTO_INVALID_ARGUMENT: EXIT_CODES.USAGE,
  CRYPTO_ABORTED: EXIT_CODES.INTERRUPTED,
  CRYPTO_SOURCE_UNSUPPORTED: EXIT_CODES.DOCUMENT,
  CRYPTO_LIMIT_EXCEEDED: EXIT_CODES.DOCUMENT,
  CRYPTO_INVALID_PACKAGE: EXIT_CODES.DOCUMENT,
  CRYPTO_NOT_ENCRYPTED: EXIT_CODES.DOCUMENT,
  CRYPTO_CREDENTIALS_REQUIRED: EXIT_CODES.CREDENTIAL,
  CRYPTO_UNSUPPORTED_ENCRYPTION: EXIT_CODES.CREDENTIAL,
  CRYPTO_ENTRY_MAP_INVALID: EXIT_CODES.CREDENTIAL,
  CRYPTO_DECRYPT_FAILED: EXIT_CODES.CREDENTIAL,
  CRYPTO_DECRYPT_LAYER_LIMIT: EXIT_CODES.CREDENTIAL,
  CRYPTO_LAYER_LOOP: EXIT_CODES.CREDENTIAL,
  CRYPTO_USER_NOT_FOUND: EXIT_CODES.CREDENTIAL,
  CRYPTO_USER_AMBIGUOUS: EXIT_CODES.CREDENTIAL,
  CRYPTO_WRONG_PASSWORD: EXIT_CODES.CREDENTIAL,
  CRYPTO_PRIVATE_KEY_INVALID: EXIT_CODES.CREDENTIAL,
  CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED: EXIT_CODES.CREDENTIAL,
  CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION: EXIT_CODES.CREDENTIAL,
  CRYPTO_PRIVATE_KEY_MISMATCH: EXIT_CODES.CREDENTIAL,
  CRYPTO_ASN1_INVALID: EXIT_CODES.VERIFY_FAILED,
  CRYPTO_UNSUPPORTED_SES_VERSION: EXIT_CODES.VERIFY_FAILED,
  CRYPTO_UNSUPPORTED_ALGORITHM: EXIT_CODES.VERIFY_FAILED,
  CRYPTO_CERTIFICATE_INVALID: EXIT_CODES.VERIFY_FAILED,
  CRYPTO_TRUST_ROOT_INVALID: EXIT_CODES.VERIFY_FAILED,
  CRYPTO_INTEGRITY_INVALID: EXIT_CODES.VERIFY_FAILED,
  CRYPTO_SIGNATURE_INVALID: EXIT_CODES.VERIFY_FAILED,
  CRYPTO_TIMESTAMP_PARSE: EXIT_CODES.VERIFY_FAILED,
});

/**
 * 计算 crypto 错误对应的进程退出码。
 *
 * @param code crypto 错误码
 * @returns 退出码
 */
export function cryptoExitCode(code: CryptoErrorCode): ExitCode {
  return CRYPTO_EXIT_CODES[code];
}

/** 归一化后的错误描述，供日志与退出码计算使用。 */
export interface CliFailure {
  /** 稳定错误码；engine/crypto 错误透传原始码，未知异常归为 `CLI_UNEXPECTED`。 */
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
 * crypto 的 `CryptoError` 按设计 §3.7 分类映射到 1/2/4/5/130；
 * 其余非 `CliError` 统一归为 `CLI_UNEXPECTED`，并保留堆栈。
 */
export function toCliError(error: unknown): CliFailure {
  if (isCliError(error)) {
    return { code: error.code, message: error.message, exitCode: error.exitCode };
  }
  if (isCryptoError(error)) {
    return {
      code: error.code,
      message: error.message,
      exitCode: cryptoExitCode(error.code),
    };
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
  return toCliError(error).exitCode;
}
