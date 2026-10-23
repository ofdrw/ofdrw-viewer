import { describe, expect, it } from 'vitest';
import { CryptoError } from '@ofdrw/ofdrw-viewer-crypto';
import {
  CliError,
  EXIT_CODES,
  cryptoExitCode,
  errorMessage,
  exitCodeForError,
  isCliError,
  isErrnoError,
  toCliError,
} from '../../src/errors.js';

describe('CliError', () => {
  it('保留错误码与退出码', () => {
    const error = new CliError('CLI_INVALID_DPI', 'dpi 非法', EXIT_CODES.USAGE);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CliError');
    expect(error.code).toBe('CLI_INVALID_DPI');
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe('dpi 非法');
    expect(isCliError(error)).toBe(true);
  });

  it('默认退出码为 1', () => {
    expect(new CliError('CLI_USAGE', 'x').exitCode).toBe(1);
  });

  it('支持 cause', () => {
    const cause = new Error('底层原因');
    const error = new CliError('CLI_UNEXPECTED', '外层', EXIT_CODES.DOCUMENT, { cause });
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

describe('退出码映射', () => {
  it('CliError 使用自身退出码', () => {
    expect(exitCodeForError(new CliError('CLI_PAGE_TOO_LARGE', 'x', 2))).toBe(2);
  });

  it('未知异常映射为文档级失败', () => {
    expect(exitCodeForError(new Error('boom'))).toBe(EXIT_CODES.DOCUMENT);
    expect(exitCodeForError('boom')).toBe(EXIT_CODES.DOCUMENT);
  });

  it('toCliError 归一化 CliError', () => {
    expect(toCliError(new CliError('CLI_INPUT_NOT_FOUND', '不存在', 1))).toEqual({
      code: 'CLI_INPUT_NOT_FOUND',
      message: '不存在',
      exitCode: 1,
    });
  });

  it('toCliError 将未知异常归为 CLI_UNEXPECTED 并保留堆栈', () => {
    const failure = toCliError(new Error('boom'));
    expect(failure.code).toBe('CLI_UNEXPECTED');
    expect(failure.exitCode).toBe(2);
    expect(failure.message).toBe('boom');
    expect(failure.stack).toContain('boom');
  });

  it('非 Error 抛出值也有可读消息', () => {
    const failure = toCliError('oops');
    expect(failure).toMatchObject({ code: 'CLI_UNEXPECTED', message: 'oops', exitCode: 2 });
    expect(failure.stack).toBeUndefined();
  });
});

describe('crypto 错误退出码', () => {
  it('凭据/解密错误映射为 4', () => {
    for (const code of [
      'CRYPTO_CREDENTIALS_REQUIRED',
      'CRYPTO_USER_NOT_FOUND',
      'CRYPTO_USER_AMBIGUOUS',
      'CRYPTO_WRONG_PASSWORD',
      'CRYPTO_PRIVATE_KEY_INVALID',
      'CRYPTO_PRIVATE_KEY_PASSPHRASE_REQUIRED',
      'CRYPTO_PRIVATE_KEY_UNSUPPORTED_ENCRYPTION',
      'CRYPTO_PRIVATE_KEY_MISMATCH',
      'CRYPTO_DECRYPT_FAILED',
      'CRYPTO_DECRYPT_LAYER_LIMIT',
      'CRYPTO_LAYER_LOOP',
      'CRYPTO_ENTRY_MAP_INVALID',
      'CRYPTO_UNSUPPORTED_ENCRYPTION',
    ] as const) {
      expect(cryptoExitCode(code)).toBe(EXIT_CODES.CREDENTIAL);
      expect(exitCodeForError(new CryptoError(code, 'x'))).toBe(4);
    }
  });

  it('包结构错误映射为 2，参数为 1，取消为 130', () => {
    expect(cryptoExitCode('CRYPTO_INVALID_PACKAGE')).toBe(EXIT_CODES.DOCUMENT);
    expect(cryptoExitCode('CRYPTO_INVALID_ARGUMENT')).toBe(EXIT_CODES.USAGE);
    expect(cryptoExitCode('CRYPTO_ABORTED')).toBe(EXIT_CODES.INTERRUPTED);
  });

  it('ASN.1/验证错误映射为 5', () => {
    for (const code of [
      'CRYPTO_ASN1_INVALID',
      'CRYPTO_UNSUPPORTED_SES_VERSION',
      'CRYPTO_UNSUPPORTED_ALGORITHM',
      'CRYPTO_CERTIFICATE_INVALID',
      'CRYPTO_TRUST_ROOT_INVALID',
      'CRYPTO_INTEGRITY_INVALID',
      'CRYPTO_SIGNATURE_INVALID',
      'CRYPTO_TIMESTAMP_PARSE',
    ] as const) {
      expect(cryptoExitCode(code)).toBe(EXIT_CODES.VERIFY_FAILED);
    }
  });

  it('toCliError 保留 crypto 错误码且不附加堆栈', () => {
    const failure = toCliError(new CryptoError('CRYPTO_WRONG_PASSWORD', '口令错误'));
    expect(failure).toEqual({
      code: 'CRYPTO_WRONG_PASSWORD',
      message: '口令错误',
      exitCode: 4,
    });
    expect(failure.stack).toBeUndefined();
  });
});

describe('系统错误工具', () => {
  it('识别 errno 错误', () => {
    expect(isErrnoError({ code: 'ENOENT' }, 'ENOENT')).toBe(true);
    expect(isErrnoError({ code: 'EACCES' }, 'ENOENT')).toBe(false);
    expect(isErrnoError(new Error('x'), 'ENOENT')).toBe(false);
    expect(isErrnoError(null, 'ENOENT')).toBe(false);
  });

  it('提取错误消息', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('oops')).toBe('oops');
    expect(errorMessage(42)).toBe('42');
  });
});