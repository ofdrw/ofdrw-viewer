/**
 * i18n：语言归一、插值、Intl 数字/日期、功能原因文案。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTranslator,
  featureReasonKey,
  getSupportedLocales,
  isLocaleSupported,
  interpolate,
  normalizeLocale,
  registerLocale,
} from '../../../src/i18n';

const originalLanguage = document.documentElement.lang;

afterEach(() => {
  document.documentElement.lang = originalLanguage;
});

describe('i18n 语言解析', () => {
  it('内置 zh-CN / en-US 并归一别名', () => {
    expect(getSupportedLocales()).toEqual(expect.arrayContaining(['zh-CN', 'en-US']));
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh-hans')).toBe('zh-CN');
    expect(normalizeLocale('en')).toBe('en-US');
    expect(normalizeLocale('en-GB')).toBe('en-US');
    expect(normalizeLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeLocale(undefined)).toBe('zh-CN');
    expect(isLocaleSupported('zh-CN')).toBe(true);
  });

  it('支持注册部分语言并以简体中文兜底', () => {
    registerLocale('test-XX', {
      'toolbar.print': 'Print!',
    });
    const translator = createTranslator('test-XX');
    expect(translator.t('toolbar.print')).toBe('Print!');
    expect(translator.t('toolbar.rotate')).toBe('旋转');
  });
});

describe('i18n 文案与格式化', () => {
  it('中文/英文插值', () => {
    expect(
      createTranslator('zh-CN').t('toolbar.pageNumberOf', { page: 1, total: 3 }),
    ).toBe('第 1 页，共 3 页');
    expect(
      createTranslator('en-US').t('toolbar.pageNumberOf', { page: 1, total: 3 }),
    ).toBe('Page 1 of 3');
    expect(interpolate('a {b} c', { b: 2 })).toBe('a 2 c');
    expect(interpolate('a {missing}')).toBe('a {missing}');
  });

  it('数字与日期使用 Intl', () => {
    const translator = createTranslator('en-US');
    const options = { maximumFractionDigits: 1 } as const;
    expect(translator.formatNumber(1234.56, options)).toBe(
      new Intl.NumberFormat('en-US', options).format(1234.56),
    );
    const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
    const dateOptions: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
    };
    expect(translator.formatDate(date, dateOptions)).toBe(
      new Intl.DateTimeFormat('en-US', dateOptions).format(date),
    );
    expect(translator.formatDate('not-a-date')).toBe('');
    expect(translator.formatNumber(Number.NaN)).toBe('');
  });

  it('功能名称与禁用原因 tooltip', () => {
    const zh = createTranslator('zh-CN');
    expect(zh.featureLabel('print')).toBe('打印');
    expect(zh.featureDisabledTooltip('print', 'host')).toBe('打印不可用：已被宿主禁用');
    expect(zh.featureDisabledTooltip('export', 'document')).toContain('当前文档不允许');
    expect(createTranslator('en-US').featureDisabledTooltip('print', 'unsupported')).toContain(
      'not supported',
    );
    expect(featureReasonKey('dependency')).toBe('feature.reason.dependency');
    expect(featureReasonKey(undefined)).toBe('feature.reason.host');
  });
});