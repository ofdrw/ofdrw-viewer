/**
 * 本机字体相关的包级导出完整性（本地字体加载方案设计 §9、需求清单 REQ-0320 前置）。
 *
 * 宿主在 TypeScript 下必须能直接构造 `{ local: { fontName } }` 等形态，因此
 * `FontSource.local` 的联合成员与状态类型都必须是公共导出。这里用类型层面的断言锁定
 * 导出面，防止后续重构把某个类型悄悄收回包内。
 */

import { describe, expect, it } from 'vitest';
import type {
  FontSource,
  LocalFontDeclaration,
  LocalFontStatus,
  LocalFontsChangeEvent,
  LocalFontsOptions,
  LocalFontsStatus,
  ViewerFontOptions,
} from '../../../src/index';

/**
 * 仅用于类型层面的“必须可赋值”断言；运行期不会执行。
 *
 * @param value 待断言的值。
 */
function expectType<T>(value: T): T {
  return value;
}

describe('本机字体公共导出', () => {
  it('LocalFontDeclaration 可用于构造 { local } 来源', () => {
    const declaration: LocalFontDeclaration = {
      fontName: '宋体',
      familyName: '宋体',
      bold: false,
      italic: false,
    };
    const source: FontSource = { local: declaration };
    expect(source).toHaveProperty('local');
    // 声明形态与字符串/数组形态同属 `FontSource.local` 联合。
    expectType<FontSource>({ local: 'SimSun' });
    expectType<FontSource>({ local: ['SimSun', 'NSimSun'] });
    expectType<FontSource>(source);
  });

  it('LocalFontsOptions 五个字段可用且可挂到 ViewerFontOptions 上', () => {
    const options: LocalFontsOptions = {
      enabled: true,
      defaultEnabled: false,
      remember: true,
      maxFonts: 8,
      consentText: '允许阅读器使用本机字体。',
    };
    const fonts: ViewerFontOptions = { localFonts: options };
    expect(fonts.localFonts?.maxFonts).toBe(8);
  });

  it('状态类型与事件载荷可被宿主引用', () => {
    const status: LocalFontsStatus = {
      supported: true,
      enabled: false,
      permission: 'prompt',
      visible: true,
      loading: false,
    };
    const permission: LocalFontStatus = status.permission;
    const event: LocalFontsChangeEvent = status;
    expect(permission).toBe('prompt');
    expect(event.enabled).toBe(false);
  });
});
