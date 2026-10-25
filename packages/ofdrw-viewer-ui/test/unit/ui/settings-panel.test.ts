/**
 * 侧栏「设置」面板（本地字体加载方案设计 §5.1，需求清单 REQ-0290，T-V6）。
 *
 * 覆盖：`settings` 标签存在且可打开、开关是 `role="switch"` 且随状态同步、
 * 四种状态文案、浏览器不支持时隐藏开关但仍给出原因、宿主未启用时整组不出现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../../../src/ui/settings-panel';
import type { LocalFontsStatus } from '../../../src/local-fonts-state';
import { createTranslator } from '../../../src/i18n';
import { SIDEBAR_VIEWS } from '../../../src/state';

/** 构造状态。 */
function status(overrides: Partial<LocalFontsStatus> = {}): LocalFontsStatus {
  return {
    supported: true,
    enabled: false,
    permission: 'prompt',
    visible: true,
    loading: false,
    ...overrides,
  };
}

/** 挂载面板。 */
function mount(
  initial: LocalFontsStatus | undefined,
  options: { locale?: string; onToggle?: (enabled: boolean) => void } = {},
): { panel: SettingsPanel; host: HTMLElement; state: { localFonts?: LocalFontsStatus } } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const state: { localFonts?: LocalFontsStatus } = { localFonts: initial };
  const panel = new SettingsPanel({
    host,
    getTranslator: () => createTranslator(options.locale ?? 'zh-CN'),
    getState: () => state,
    onToggle: options.onToggle ?? (() => undefined),
  });
  return { panel, host, state };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('settings 侧栏视图', () => {
  it('单一清单包含 settings（侧栏标签与 hash 恢复共用同一来源）', () => {
    expect(SIDEBAR_VIEWS).toContain('settings');
  });
});

describe('设置面板字体分组', () => {
  it('渲染分组标题、标签与说明', () => {
    const { host } = mount(status());
    expect(host.querySelector('.ofd-settings__heading')?.textContent).toBe('字体');
    expect(host.querySelector('.ofd-settings__label')?.textContent).toBe('使用本机字体');
    expect(host.querySelector('.ofd-settings__hint')?.textContent).toBe(
      '用本机已安装的字体替换缺失字体',
    );
  });

  it('开关是 role="switch" 且 aria-checked 随 enabled 同步', () => {
    const { host } = mount(status({ enabled: false }));
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    const enabled = mount(status({ enabled: true }));
    expect(
      enabled.host.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('点击开关把取反后的值交给核心（保持同步调用以便申请权限）', () => {
    const onToggle = vi.fn();
    const { host } = mount(status({ enabled: false }), { onToggle });
    host.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('四种状态文案：未授权 / 已启用 / 未获得授权 / 浏览器不支持', () => {
    const cases: ReadonlyArray<[LocalFontsStatus, string]> = [
      [status({ enabled: false, permission: 'prompt' }), '未授权'],
      [status({ enabled: true, permission: 'granted' }), '已启用'],
      [status({ enabled: false, permission: 'denied' }), '未获得授权'],
      [status({ supported: false, enabled: false, permission: 'unsupported' }), '浏览器不支持'],
    ];
    for (const [value, text] of cases) {
      const { host, panel } = mount(value);
      panel.update(value);
      expect(host.querySelector('.ofd-settings__status')?.textContent, text).toBe(text);
      document.body.innerHTML = '';
    }
  });

  it('浏览器不支持时隐藏开关，但保留原因文案', () => {
    const { host } = mount(status({ supported: false, enabled: false, permission: 'unsupported' }));
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.querySelector('.ofd-settings__status')?.textContent).toBe('浏览器不支持');
  });

  it('宿主未启用该能力时整个分组不出现', () => {
    const { host } = mount(undefined);
    const group = host.querySelector<HTMLElement>('.ofd-settings__group');
    expect(group?.hidden).toBe(true);

    const invisible = mount(status({ visible: false, enabled: false }));
    expect(
      invisible.host.querySelector<HTMLElement>('.ofd-settings__group')?.hidden,
    ).toBe(true);
  });

  it('读取中禁用开关，避免重复申请', () => {
    const { host } = mount(status({ loading: true }));
    expect(host.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
  });

  it('英文语言下发英文文案', () => {
    const { host } = mount(status({ enabled: true, permission: 'granted' }), {
      locale: 'en-US',
    });
    expect(host.querySelector('.ofd-settings__heading')?.textContent).toBe('Fonts');
    expect(host.querySelector('.ofd-settings__status')?.textContent).toBe('Enabled');
  });
});
