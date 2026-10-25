/**
 * 侧栏「设置」面板（本地字体加载方案设计 §5.1，需求清单 REQ-0290）。
 *
 * 当前只有「字体」一组：一个「使用本机字体」开关 + 一行状态文案。面板只读外壳状态
 * 快照（`getState().localFonts`），不持有阅读器实例，也不自行维护第二份状态；
 * 开关点击通过 `onToggle` 交给核心的 `local-fonts.set` 命令处理。
 *
 * 展示规则：
 * - 浏览器不支持：不展示开关，只展示「浏览器不支持」原因文案；
 * - 宿主未启用该能力（`fonts.localFonts.enabled !== true`）：整个字体分组不出现；
 * - 其余情况展示开关，状态文案区分 未授权 / 已启用 / 未获得授权。
 */

import { replaceChildren } from '../compat';
import type { Translator } from '../i18n';
import type { LocalFontsStatus } from '../local-fonts-state';

/** 设置面板选项。 */
export interface SettingsPanelOptions {
  /** 面板容器。 */
  readonly host: HTMLElement;
  /** 当前翻译器。 */
  readonly getTranslator: () => Translator;
  /** 读取最新外壳视图状态。 */
  readonly getState: () => { readonly localFonts?: LocalFontsStatus };
  /** 开关切换；由核心执行权限申请与重开。 */
  readonly onToggle: (enabled: boolean) => void;
}

/**
 * 设置面板 DOM 结构。
 */
export class SettingsPanel {
  private readonly doc: Document;
  private readonly group: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly row: HTMLElement;
  private readonly label: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly status: HTMLElement;

  /**
   * 创建并挂载设置面板。
   *
   * @param options 容器、翻译器与状态读取器。
   */
  constructor(private readonly options: SettingsPanelOptions) {
    this.doc = options.host.ownerDocument;
    const doc = this.doc;

    this.group = doc.createElement('section');
    this.group.className = 'ofd-settings__group';
    this.group.dataset.group = 'fonts';

    this.heading = doc.createElement('h3');
    this.heading.className = 'ofd-settings__heading';

    this.row = doc.createElement('div');
    this.row.className = 'ofd-settings__row';

    const text = doc.createElement('div');
    text.className = 'ofd-settings__text';
    this.label = doc.createElement('span');
    this.label.className = 'ofd-settings__label';
    this.hint = doc.createElement('span');
    this.hint.className = 'ofd-settings__hint';
    text.append(this.label, this.hint);

    // 开关使用 role="switch" + aria-checked，原生 button 保证键盘（Enter/Space）可操作。
    this.toggle = doc.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'ofd-settings__switch';
    this.toggle.setAttribute('role', 'switch');
    this.toggle.setAttribute('aria-checked', 'false');
    this.toggle.addEventListener('click', this.handleToggle);

    this.row.append(text, this.toggle);
    this.status = doc.createElement('p');
    this.status.className = 'ofd-settings__status';
    this.group.append(this.heading, this.row, this.status);

    replaceChildren(options.host, this.group);
    this.update();
  }

  /**
   * 用最新状态刷新文案与开关。
   *
   * @param status 本地字体状态；省略时从外壳状态读取。
   */
  update(status?: LocalFontsStatus): void {
    const translator = this.options.getTranslator();
    const localFonts = status ?? this.options.getState().localFonts;
    this.heading.textContent = translator.t('localFonts.group');
    this.label.textContent = translator.t('localFonts.toggle');
    this.hint.textContent = translator.t('localFonts.toggleHint');

    // 宿主未启用该能力：整个分组不出现（设计 §5.1 隐藏条件）。
    if (!localFonts || (!localFonts.visible && localFonts.supported)) {
      this.group.hidden = true;
      this.row.hidden = true;
      return;
    }
    this.group.hidden = false;

    if (!localFonts.supported) {
      // 浏览器不支持：不展示开关，只展示原因文案。
      this.row.hidden = true;
      this.toggle.remove();
      this.status.textContent = translator.t('localFonts.status.unsupported');
      return;
    }

    this.row.hidden = false;
    // 从不支持切回支持时补回开关（`remove()` 之后需要重新挂载）。
    if (!this.toggle.isConnected) this.row.append(this.toggle);
    this.toggle.setAttribute('aria-checked', localFonts.enabled ? 'true' : 'false');
    this.toggle.dataset.enabled = localFonts.enabled ? 'true' : 'false';
    this.toggle.setAttribute('aria-label', translator.t('localFonts.toggle'));
    this.toggle.disabled = localFonts.loading;
    this.status.textContent = statusTextKey(localFonts, translator);
  }

  /** 释放监听。 */
  destroy(): void {
    this.toggle.removeEventListener('click', this.handleToggle);
  }

  /**
   * 点击开关：读取当前值后取反交给核心。
   *
   * 权限申请需要用户手势，因此这里同步派发，不放在异步回调里。
   */
  private readonly handleToggle = (): void => {
    const status = this.options.getState().localFonts;
    this.options.onToggle(!status?.enabled);
  };
}

/**
 * 计算状态文案（需求清单 REQ-0290 的四种状态）。
 *
 * @param status 本地字体状态。
 * @param translator 翻译器。
 * @returns 面向用户的状态文本。
 */
function statusTextKey(status: LocalFontsStatus, translator: Translator): string {
  if (!status.supported) return translator.t('localFonts.status.unsupported');
  if (status.enabled) return translator.t('localFonts.status.enabled');
  if (status.permission === 'denied') return translator.t('localFonts.status.denied');
  return translator.t('localFonts.status.prompt');
}
