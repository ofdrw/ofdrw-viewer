/**
 * 主题控制器（设计方案 §4.5）。
 *
 * `data-theme` 只写 `light|dark|auto`；`auto` 通过 `matchMedia('(prefers-color-scheme: dark)')`
 * 解析实际主题。CSS 变量定义在 `src/style.css`，这里不注入任何样式。
 */
import type { Theme } from '../state';

/** 解析后的实际主题。 */
export type ResolvedTheme = 'light' | 'dark';

/** 合法主题值。 */
export const THEME_VALUES: readonly Theme[] = Object.freeze(['light', 'dark', 'auto']);

/** 深色模式媒体查询。 */
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** 主题控制器选项。 */
export interface ThemeControllerOptions {
  /**
   * 主题变化回调；主题值或解析结果变化时触发。
   *
   * @param theme 配置主题。
   * @param resolved 实际生效主题。
   */
  readonly onChange?: (theme: Theme, resolved: ResolvedTheme) => void;
}

/**
 * 判断值是否为合法主题。
 *
 * @param value 待判断值。
 * @returns 合法时返回 true。
 */
export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEME_VALUES as readonly string[]).includes(value);
}

/**
 * 主题控制器。
 */
export class ThemeController {
  private theme: Theme;
  private resolved: ResolvedTheme;
  private media: MediaQueryList | null = null;
  private readonly onChange?: (theme: Theme, resolved: ResolvedTheme) => void;

  /**
   * 创建控制器并立即写入根节点 `data-theme`。
   *
   * @param root 阅读器根节点。
   * @param theme 初始主题；默认 `auto`。
   * @param options 变化回调。
   */
  constructor(
    private readonly root: HTMLElement,
    theme: Theme = 'auto',
    options: ThemeControllerOptions = {},
  ) {
    this.theme = isTheme(theme) ? theme : 'auto';
    this.onChange = options.onChange;
    this.media = this.createMediaQuery();
    if (this.media) {
      if (typeof this.media.addEventListener === 'function') {
        this.media.addEventListener('change', this.handleMediaChange);
      } else {
        this.media.addListener?.(this.handleMediaChange);
      }
    }
    this.resolved = this.resolve();
    this.root.dataset.theme = this.theme;
    this.root.dataset.resolvedTheme = this.resolved;
  }

  /** 配置主题。 */
  get currentTheme(): Theme {
    return this.theme;
  }

  /** 实际生效主题。 */
  get currentResolvedTheme(): ResolvedTheme {
    return this.resolved;
  }

  /**
   * 设置主题。
   *
   * @param theme 新主题；非法值回落到 `auto`。
   */
  setTheme(theme: Theme): void {
    const next = isTheme(theme) ? theme : 'auto';
    this.theme = next;
    this.resolved = this.resolve();
    this.root.dataset.theme = next;
    this.root.dataset.resolvedTheme = this.resolved;
    this.onChange?.(next, this.resolved);
  }

  /** 重新解析 `auto` 主题（媒体查询变化时自动调用）。 */
  refresh(): void {
    const previous = this.resolved;
    this.resolved = this.resolve();
    this.root.dataset.resolvedTheme = this.resolved;
    if (previous !== this.resolved) this.onChange?.(this.theme, this.resolved);
  }

  /** 释放媒体查询监听。 */
  destroy(): void {
    if (this.media) {
      if (typeof this.media.removeEventListener === 'function') {
        this.media.removeEventListener('change', this.handleMediaChange);
      } else {
        this.media.removeListener?.(this.handleMediaChange);
      }
    }
    this.media = null;
  }

  /** 创建媒体查询；环境不支持时返回 null。 */
  private createMediaQuery(): MediaQueryList | null {
    const view = this.root.ownerDocument.defaultView;
    if (!view || typeof view.matchMedia !== 'function') return null;
    try {
      return view.matchMedia(DARK_SCHEME_QUERY);
    } catch {
      return null;
    }
  }

  /** 解析实际主题。 */
  private resolve(): ResolvedTheme {
    if (this.theme === 'light') return 'light';
    if (this.theme === 'dark') return 'dark';
    return this.media?.matches ? 'dark' : 'light';
  }

  /** 系统主题变化。 */
  private readonly handleMediaChange = (): void => {
    this.refresh();
  };
}