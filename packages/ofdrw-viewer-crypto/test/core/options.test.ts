import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRYPTO_LIMITS,
  DEFAULT_SM2_USER_ID,
  resolveCryptoLimits,
  resolveCryptoOptions,
  resolveParseOptions,
  resolveSm2UserId,
} from '@ofdrw/ofdrw-viewer-crypto';

describe('限制与选项解析', () => {
  it('默认限制覆盖所有字段且为正整数', () => {
    for (const [key, value] of Object.entries(DEFAULT_CRYPTO_LIMITS)) {
      expect(Number.isSafeInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
    expect(DEFAULT_CRYPTO_LIMITS.maxSourceBytes).toBe(256 * 1024 * 1024);
    expect(DEFAULT_CRYPTO_LIMITS.maxDecryptLayers).toBe(4);
  });

  it('resolveCryptoLimits 支持局部覆盖且不改默认值', () => {
    const limits = resolveCryptoLimits({ maxDecryptLayers: 2, maxEntryBytes: 1024 });
    expect(limits.maxDecryptLayers).toBe(2);
    expect(limits.maxEntryBytes).toBe(1024);
    expect(limits.maxSourceBytes).toBe(DEFAULT_CRYPTO_LIMITS.maxSourceBytes);
    expect(DEFAULT_CRYPTO_LIMITS.maxDecryptLayers).toBe(4);
  });

  it('非法上限被拒绝', () => {
    expect(() => resolveCryptoLimits({ maxDecryptLayers: 0 })).toThrowError(/maxDecryptLayers/);
    expect(() => resolveCryptoLimits({ maxEntryBytes: -1 })).toThrowError(/maxEntryBytes/);
    expect(() => resolveCryptoLimits({ maxEntries: 1.5 })).toThrowError(/maxEntries/);
  });

  it('resolveParseOptions 仅返回 DER 相关上限', () => {
    expect(resolveParseOptions()).toEqual({
      maxBytes: DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes,
      maxDepth: DEFAULT_CRYPTO_LIMITS.maxAsn1Depth,
    });
    expect(resolveParseOptions({ maxBytes: 10, maxDepth: 2 })).toEqual({
      maxBytes: 10,
      maxDepth: 2,
    });
  });

  it('resolveCryptoOptions 组合 limits 与 now/signal', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const controller = new AbortController();
    const options = resolveCryptoOptions({
      limits: { maxDecryptLayers: 1 },
      now,
      signal: controller.signal,
    });
    expect(options.limits.maxDecryptLayers).toBe(1);
    expect(options.now).toBe(now);
    expect(options.signal).toBe(controller.signal);
  });

  it('SM2 userId 默认值与校验', () => {
    expect(DEFAULT_SM2_USER_ID).toBe('1234567812345678');
    expect(resolveSm2UserId(undefined)).toBe(DEFAULT_SM2_USER_ID);
    expect(resolveSm2UserId('user')).toBe('user');
    expect(() => resolveSm2UserId('')).toThrowError(/sm2UserId/);
    expect(() => resolveCryptoOptions({ sm2UserId: 'x'.repeat(8193) })).toThrowError(/sm2UserId/);
  });
});