/**
 * 本机字体开关生效值与持久化测试（需求清单 REQ-007 / REQ-008，§10 T-P7~T-P8）。
 *
 * 生效值只有一个实现点 `resolveLocalFontsConfig()`：宿主配置决定「可见性与默认值」，
 * 用户选择优先。持久化只允许写 `enabled`/`notified` 两个布尔值，不写字体清单
 * （设计 §7 隐私约束）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCAL_FONTS_MAX_FONTS,
  LOCAL_FONTS_STORAGE_KEY,
  MAX_LOCAL_FONTS_MAX_FONTS,
  normalizeLocalFontsMaxFonts,
  readLocalFontsPreference,
  resolveLocalFontsConfig,
  writeLocalFontsPreference,
} from '../../../src/local-fonts-state';

/** 构造内存 storage 替身。 */
function memoryStorage(): Storage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage & { readonly data: Map<string, string> };
}

describe('resolveLocalFontsConfig 生效值解析（T-P7）', () => {
  it('第 1 行：未配置 fonts.localFonts → 不生效且不可见', () => {
    const config = resolveLocalFontsConfig({ supported: true });
    expect(config).toMatchObject({ visible: false, enabled: false });
  });

  it('第 2 行：enabled !== true（含 false 与省略）→ 不生效且不可见', () => {
    for (const localFonts of [{}, { enabled: false }, { enabled: false, defaultEnabled: true }]) {
      const config = resolveLocalFontsConfig({
        localFonts,
        supported: true,
        preference: { enabled: true, notified: true },
      });
      expect(config, JSON.stringify(localFonts)).toMatchObject({ visible: false, enabled: false });
    }
  });

  it('第 3 行：浏览器无 queryLocalFonts → 不生效且不可见', () => {
    const config = resolveLocalFontsConfig({
      localFonts: { enabled: true, defaultEnabled: true },
      supported: false,
      preference: { enabled: true, notified: true },
    });
    expect(config).toMatchObject({ visible: false, enabled: false });
  });

  it('第 4 行：可用 + 已记住用户选择 → 生效值取用户选择', () => {
    for (const choice of [true, false]) {
      const config = resolveLocalFontsConfig({
        localFonts: { enabled: true, defaultEnabled: !choice },
        supported: true,
        preference: { enabled: choice, notified: true },
      });
      expect(config.visible).toBe(true);
      expect(config.enabled, `用户选择 ${choice}`).toBe(choice);
    }
  });

  it('第 5 行：无用户选择 → 生效值取 defaultEnabled', () => {
    expect(
      resolveLocalFontsConfig({ localFonts: { enabled: true, defaultEnabled: true }, supported: true })
        .enabled,
    ).toBe(true);
    expect(
      resolveLocalFontsConfig({ localFonts: { enabled: true }, supported: true }).enabled,
    ).toBe(false);
  });

  it('第 6 例：用户选择 false 覆盖 defaultEnabled=true', () => {
    const config = resolveLocalFontsConfig({
      localFonts: { enabled: true, defaultEnabled: true },
      supported: true,
      preference: { enabled: false, notified: true },
    });
    expect(config.visible).toBe(true);
    expect(config.enabled).toBe(false);
  });

  it('remember=false 时忽略已记住的用户选择', () => {
    const config = resolveLocalFontsConfig({
      localFonts: { enabled: true, defaultEnabled: true, remember: false },
      supported: true,
      preference: { enabled: false, notified: true },
    });
    expect(config.enabled).toBe(true);
    expect(config.remember).toBe(false);
  });

  it('maxFonts：缺省 8、非有限数/小于 1 回落 8、超过上限钳到 32', () => {
    expect(DEFAULT_LOCAL_FONTS_MAX_FONTS).toBe(8);
    expect(MAX_LOCAL_FONTS_MAX_FONTS).toBe(32);
    expect(normalizeLocalFontsMaxFonts(undefined)).toBe(8);
    expect(normalizeLocalFontsMaxFonts(Number.NaN)).toBe(8);
    expect(normalizeLocalFontsMaxFonts(Number.POSITIVE_INFINITY)).toBe(8);
    expect(normalizeLocalFontsMaxFonts(0)).toBe(8);
    expect(normalizeLocalFontsMaxFonts(-3)).toBe(8);
    expect(normalizeLocalFontsMaxFonts(5)).toBe(5);
    expect(normalizeLocalFontsMaxFonts(100)).toBe(32);
    // 与两个「名字数上限」无关：这里只决定查询多少个文档声明。
    expect(
      resolveLocalFontsConfig({ localFonts: { enabled: true, maxFonts: 3 }, supported: true })
        .maxFonts,
    ).toBe(3);
  });

  it('consentText 原样透传，未提供时省略字段', () => {
    expect(
      resolveLocalFontsConfig({
        localFonts: { enabled: true, consentText: '内网统一口径' },
        supported: true,
      }).consentText,
    ).toBe('内网统一口径');
    expect(
      'consentText' in
        resolveLocalFontsConfig({ localFonts: { enabled: true }, supported: true }),
    ).toBe(false);
  });
});

describe('本地字体持久化（T-P8）', () => {
  it('只写 enabled 与 notified 两个布尔值，不写字体清单', () => {
    const storage = memoryStorage();
    writeLocalFontsPreference({ enabled: true, notified: true }, storage);
    const raw = storage.getItem(LOCAL_FONTS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['enabled', 'notified']);
    expect(parsed).toEqual({ enabled: true, notified: true });
    // 值必须是布尔，不能塞字体名列表。
    expect(typeof parsed.enabled).toBe('boolean');
    expect(typeof parsed.notified).toBe('boolean');
  });

  it('读取时只接受布尔值；内容非法按「无用户选择」处理', () => {
    const storage = memoryStorage();
    expect(readLocalFontsPreference(storage)).toBeUndefined();
    for (const raw of ['not-json', 'null', '[]', '{"enabled":"yes"}', '{"notified":true}']) {
      storage.setItem(LOCAL_FONTS_STORAGE_KEY, raw);
      expect(readLocalFontsPreference(storage), raw).toBeUndefined();
    }
    storage.setItem(LOCAL_FONTS_STORAGE_KEY, JSON.stringify({ enabled: false }));
    // notified 缺省按 false 处理。
    expect(readLocalFontsPreference(storage)).toEqual({ enabled: false, notified: false });
  });

  it('localStorage 抛错（隐私模式）时读写都静默降级', () => {
    const throwing = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    } as unknown as Storage;
    expect(readLocalFontsPreference(throwing)).toBeUndefined();
    expect(() => writeLocalFontsPreference({ enabled: true, notified: true }, throwing)).not.toThrow();
  });

  it('没有 storage 时读写都不抛错', () => {
    expect(readLocalFontsPreference(undefined)).toBeUndefined();
    expect(() => writeLocalFontsPreference({ enabled: true, notified: false }, undefined)).not.toThrow();
  });

  it('remember=false 的语义由调用方保证不读写：本模块不会被隐式调用', () => {
    // 纯函数不做 remember 判断，避免两处真相；这里锁死「配置层已把 remember 暴露出来」。
    const config = resolveLocalFontsConfig({
      localFonts: { enabled: true, remember: false },
      supported: true,
    });
    expect(config.remember).toBe(false);
  });
});
