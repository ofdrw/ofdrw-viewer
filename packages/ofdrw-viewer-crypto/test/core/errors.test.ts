import { describe, expect, it } from 'vitest';
import {
  CRYPTO_ERROR_CODES,
  CryptoError,
  isCryptoError,
  toCryptoError,
} from '@ofdrw/ofdrw-viewer-crypto';

describe('错误码与 CryptoError', () => {
  it('错误码唯一且已冻结', () => {
    expect(new Set(CRYPTO_ERROR_CODES).size).toBe(CRYPTO_ERROR_CODES.length);
    expect(Object.isFrozen(CRYPTO_ERROR_CODES)).toBe(true);
    expect(CRYPTO_ERROR_CODES).toContain('CRYPTO_SIGNATURE_INVALID');
    expect(CRYPTO_ERROR_CODES).toContain('CRYPTO_TIMESTAMP_PARSE');
  });

  it('CryptoError 保留 code/name/cause', () => {
    const cause = new RangeError('offset');
    const error = new CryptoError('CRYPTO_ASN1_INVALID', '解析失败', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CryptoError');
    expect(error.code).toBe('CRYPTO_ASN1_INVALID');
    expect(error.message).toBe('解析失败');
    expect(error.cause).toBe(cause);
  });

  it('isCryptoError 只识别本包错误', () => {
    expect(isCryptoError(new CryptoError('CRYPTO_ABORTED', 'x'))).toBe(true);
    expect(isCryptoError(new Error('x'))).toBe(false);
    expect(isCryptoError(null)).toBe(false);
  });

  it('toCryptoError 透传或包装未知错误', () => {
    const original = new CryptoError('CRYPTO_LIMIT_EXCEEDED', '超限');
    expect(toCryptoError(original)).toBe(original);
    const wrapped = toCryptoError(new Error('boom'));
    expect(wrapped.code).toBe('CRYPTO_INVALID_ARGUMENT');
    expect(wrapped.message).toContain('boom');
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect(toCryptoError('plain').message).toContain('plain');
  });
});