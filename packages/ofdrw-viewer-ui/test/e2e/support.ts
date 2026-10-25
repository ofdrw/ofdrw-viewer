/**
 * E2E 共享操作：本地夹具、打开阅读器、等待渲染与读取状态。
 */
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * 断言弹出层打开了预期动画：名称、160–200ms、ease-out 类且只播放一次。
 *
 * @param locator 弹出层元素。
 * @param animationName 预期 animation-name。
 * @returns 计算后的 transform-origin，供菜单/浮层方向断言。
 */
export async function expectOpeningMotion(
  locator: Locator,
  animationName: string,
): Promise<string> {
  const metrics = await locator.evaluate((element, expected) => {
    const style = getComputedStyle(element);
    const animation = element.getAnimations()[0];
    return {
      animationName: style.animationName,
      duration: style.animationDuration,
      timing: style.animationTimingFunction,
      iterations: style.animationIterationCount,
      origin: style.transformOrigin,
      hasAnimation: animation !== undefined,
    };
  }, animationName);
  expect(metrics.animationName).toBe(animationName);
  const seconds = metrics.duration.endsWith('ms')
    ? Number.parseFloat(metrics.duration) / 1000
    : Number.parseFloat(metrics.duration);
  expect(seconds).toBeGreaterThanOrEqual(0.16);
  expect(seconds).toBeLessThanOrEqual(0.2);
  expect(metrics.timing).toMatch(/^ease-out$|^cubic-bezier/);
  expect(metrics.iterations).toBe('1');
  expect(metrics.hasAnimation).toBe(true);
  return metrics.origin;
}

/** 本地 OFD 夹具路径。 */
export const FIXTURES = {
  /** 1 页基础文档（字体缺失，只用于打开/无异常）。 */
  basic: '/ofd_pdf_match/helloworld.ofd',
  /** 2 页密集文本，内嵌 SimSun，用于文本层/查找/选区。 */
  text: '/ofd_pdf_match/dense-text-perf.ofd',
  /** 4 页，含大纲。 */
  multi: '/ofd_pdf_match/z.ofd',
  /** 5 页，含书签。 */
  bookmarks: '/ofd_pdf_match/Page5.ofd',
  /** 1 页真实 V4 签章。 */
  signature: '/ofd_pdf_match/SESV4SignDoc.ofd',
  /** 删除 SignedValue.dat 的签章降级夹具。 */
  signatureMissing: '/packages/ofdrw-viewer-ui/test/acceptance/fixtures/signature-missing-value.ofd',
  /** 1000 页性能夹具。 */
  thousand: '/packages/ofdrw-viewer-ui/test/acceptance/fixtures/thousand.ofd',
  /** 第 3 页 Content.xml 缺失，用于缩略图失败/重试验收。 */
  brokenPage: '/packages/ofdrw-viewer-ui/test/acceptance/fixtures/broken-page.ofd',
  /** 口令加密 OFD（口令 FixturePass123，用户 fixture-password-user）。 */
  cryptoPassword: '/packages/ofdrw-viewer-crypto/test/fixtures/crypto/password-encrypted.ofd',
  /** SM2 证书加密 OFD（用户 fixture-cert-user，私钥 certs/encrypt.key.pem）。 */
  cryptoCert: '/packages/ofdrw-viewer-crypto/test/fixtures/crypto/cert-encrypted.ofd',
  /** 口令加密 + 签名 + 完整性。 */
  cryptoCombined: '/packages/ofdrw-viewer-crypto/test/fixtures/crypto/combined-password-encrypted.ofd',
  /** 真实 SESv4 签章（含时间戳）。 */
  cryptoSigned: '/packages/ofdrw-viewer-crypto/test/fixtures/crypto/signed-sesv4.ofd',
  /** 签名条目缺 Type（仓库 ofd_pdf_match/draw_param_ref.ofd 原样副本），用于容错回归。 */
  signatureNoType: '/packages/ofdrw-viewer-crypto/test/fixtures/crypto/signatures-no-type.ofd',
  /** 签名值被篡改：签名数学/摘要校验失败，用于 invalid 状态验收。 */
  cryptoTamperedSignature:
    '/packages/ofdrw-viewer-crypto/test/fixtures/crypto/negative-tampered-signature.ofd',
  /** 外部未内嵌字体的 5 页中文发票（仓库 ofd_pdf_match/draw_param_ref.ofd 副本，生成于 test/acceptance/fixtures）。 */
  externalFont: '/packages/ofdrw-viewer-ui/test/acceptance/fixtures/external-font.ofd',
  /** 外部未内嵌字体的 2 页中文（鲁迅《拿来主义》）样本，作为 external-font.ofd 的备选。 */
  externalFontBackup:
    '/packages/ofdrw-viewer-ui/test/acceptance/fixtures/external-font-backup.ofd',
  /** 测试信任根证书。 */
  cryptoRoot: '/packages/ofdrw-viewer-crypto/test/fixtures/crypto/certs/root-ca.crt.pem',
} as const;

/** 字体来源参数：URL 必填，`family` 用于验证宿主声明的字体族名。 */
export interface HarnessFontSource {
  /** 字体文件 URL。 */
  readonly url: string;
  /** 宿主声明的字体族名。 */
  readonly family?: string;
}

/** 打开参数。 */
export interface OpenOptions {
  /** 初始缩放；默认 1。 */
  readonly scale?: number | 'auto';
  /** 初始页；默认 1。 */
  readonly page?: number;
  /** 初始旋转。 */
  readonly rotation?: 0 | 90 | 180 | 270;
  /** 功能开关。 */
  readonly features?: Record<string, boolean>;
  /** 功能展示策略。 */
  readonly display?: 'hide' | 'disable';
  /** 宿主容器宽度，单位 px；用于嵌入式断点。 */
  readonly hostWidth?: number;
  /** 初始侧栏。 */
  readonly sidebar?: 'thumbnails' | 'outline' | 'bookmarks' | 'signatures';
  /** 是否等待首个 pagerendered；默认 true。 */
  readonly waitForRender?: boolean;
  /** 口令凭据；缺省且 autoPrompt 时由内置弹窗收集。 */
  readonly password?: string;
  /** 口令用户；省略时仅在唯一用户时自动选择。 */
  readonly userName?: string;
  /** 信任根 URL；由 UI 侧 fetch 后以字节交给 crypto。 */
  readonly rootCertificate?: string;
  /** 无预置凭据时是否弹内置凭据框。 */
  readonly autoPrompt?: boolean;
  /** 打开成功后是否自动验证；默认 true。 */
  readonly autoVerify?: boolean;
  /** 是否启用密码/签名验证能力；默认 true。 */
  readonly crypto?: boolean;
  /**
   * 字体配置；映射为 `fonts` 查询参数（`default=<url>`、`supplementary=<url>`，逗号分隔）。
   *
   * 每个 URL 都必须带查询串：Vite 静态服务对同一 URL 的第二次请求直接返回 304，
   * 会让 `page.route` 的映射失效。
   */
  readonly fonts?: {
    readonly default?: readonly HarnessFontSource[];
    readonly supplementary?: readonly HarnessFontSource[];
    /** 宿主追加的字体别名组；以 `aliases=<组分号分隔的逗号分隔名>` 形式传递。 */
    readonly aliases?: readonly (readonly string[])[];
    /**
     * 本机字体能力配置（`localFonts=1&localDefault=1&...`）。
     *
     * 省略等价于「不配置 `fonts.localFonts`」：开关不可见、能力整体关闭。
     */
    readonly localFonts?: {
      /** 是否展示并启用开关；必填 true 才会真正打开能力。 */
      readonly enabled: true;
      /** 用户从未选择时的默认值；缺省 false。 */
      readonly defaultEnabled?: boolean;
      /** 是否记忆用户选择；缺省 true。 */
      readonly remember?: boolean;
      /** 单文档最多查询的声明数；缺省 8。 */
      readonly maxFonts?: number;
      /** 确认框说明文案覆盖。 */
      readonly consentText?: string;
    };
  };
}

/**
 * 构造测试页 URL。
 *
 * @param fixture OFD 路径。
 * @param options 打开参数。
 * @returns 相对 URL。
 */
export function viewerUrl(fixture: string, options: OpenOptions = {}): string {
  const params = new URLSearchParams({ src: fixture });
  if (options.scale !== undefined) params.set('scale', String(options.scale));
  if (options.page !== undefined) params.set('page', String(options.page));
  if (options.rotation !== undefined) params.set('rotation', String(options.rotation));
  if (options.features) params.set('features', JSON.stringify(options.features));
  if (options.display) params.set('display', options.display);
  if (options.hostWidth) params.set('w', String(options.hostWidth));
  if (options.sidebar) params.set('sidebar', options.sidebar);
  if (options.password) params.set('password', options.password);
  if (options.userName) params.set('userName', options.userName);
  if (options.rootCertificate) params.set('root', options.rootCertificate);
  if (options.autoPrompt) params.set('prompt', '1');
  if (options.autoVerify !== undefined) params.set('autoVerify', options.autoVerify ? '1' : '0');
  if (options.crypto === false) params.set('crypto', '0');
  if (options.fonts) {
    const items = [
      ...(options.fonts.default ?? []).map((source) => `default=${fontItem(source)}`),
      ...(options.fonts.supplementary ?? []).map((source) => `supplementary=${fontItem(source)}`),
    ];
    if (options.fonts.aliases && options.fonts.aliases.length > 0) {
      const groups = options.fonts.aliases.map((group) => group.join('+'));
      params.set('aliases', groups.join(';'));
    }
    if (items.length > 0) params.set('fonts', items.join(','));
    const local = options.fonts.localFonts;
    if (local) {
      params.set('localFonts', '1');
      if (local.defaultEnabled) params.set('localDefault', '1');
      if (local.remember === false) params.set('localRemember', '0');
      if (local.maxFonts !== undefined) params.set('localMax', String(local.maxFonts));
      if (local.consentText) params.set('localConsent', local.consentText);
    }
  }
  return `/packages/ofdrw-viewer-ui/test/e2e/index.html?${params.toString()}`;
}

/**
 * 把字体来源编码为 `fonts` 查询参数项。
 *
 * @param source 字体来源。
 * @returns `url` 或 `url|family=<家族名>`。
 */
function fontItem(source: HarnessFontSource): string {
  return source.family ? `${source.url}|family=${source.family}` : source.url;
}

/**
 * 打开夹具并等待文档就绪（可选等待首屏渲染）。
 *
 * @param page 页面。
 * @param fixture OFD 路径。
 * @param options 打开参数。
 */
export async function openViewer(
  page: Page,
  fixture: string,
  options: OpenOptions = {},
): Promise<void> {
  await page.goto(viewerUrl(fixture, options));
  await expect(page.locator('html')).toHaveAttribute('data-e2e-ready', 'true', {
    timeout: 45_000,
  });
  await page.waitForFunction(() => (window.__viewer?.getPageCount() ?? 0) > 0);
  if (options.waitForRender !== false) {
    await page.waitForFunction(() => window.__events?.some((event) => event.type === 'pagerendered'), null, {
      timeout: 60_000,
    });
  }
}

/**
 * 若查找栏意外处于打开状态则关闭，避免遮挡工具栏；用于独立缺陷修复前的其余路径。
 *
 * @param page 页面。
 */
export async function dismissFindbar(page: Page): Promise<void> {
  const findbar = page.locator('.ofd-viewer__findbar');
  if (await findbar.isVisible()) {
    await page.locator('.ofd-findbar__close').click();
    await expect(findbar).toBeHidden();
  }
}

/**
 * 读取当前视图状态。
 *
 * @param page 页面。
 * @returns 核心状态快照。
 */
export async function viewState(page: Page) {
  return page.evaluate(() => {
    const state = window.__viewer!.getState();
    return {
      pageNumber: state.view.pageNumber,
      pageCount: state.document.pageCount,
      scale: state.view.scale,
      rotation: state.view.rotation,
      scrollTop: state.view.scrollTop,
      sidebarView: state.view.sidebarView,
      status: state.document.status,
      selectedText: state.view.selectedText,
      find: state.view.findState,
      viewport: document.querySelector<HTMLElement>('.ofd-viewer')?.dataset.viewport ?? null,
      sidebarLayout:
        document.querySelector<HTMLElement>('.ofd-viewer')?.dataset.sidebarLayout ?? null,
    };
  });
}

/**
 * 等待指定页渲染完成。
 *
 * @param page 页面。
 * @param pageNumber 1-based 页码。
 */
export async function waitForPageRendered(page: Page, pageNumber: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (target) =>
            window.__events?.some(
              (event) => event.type === 'pagerendered' && (event.detail as { pageNumber?: number }).pageNumber === target,
            ) ?? false,
          pageNumber,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * 读取视图断点/WAI 属性。
 *
 * @param page 页面。
 */
export async function layoutState(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.ofd-viewer')!;
    const sidebar = document.querySelector<HTMLElement>('.ofd-viewer__sidebar')!;
    const mask = document.querySelector<HTMLElement>('.ofd-viewer__sidebar-mask')!;
    const toggle = document.querySelector<HTMLElement>('[data-ofd-control="sidebar"]')!;
    const toolbar = document.querySelector<HTMLElement>('.ofd-viewer__toolbar')!;
    const host = document.querySelector<HTMLElement>('#host')!;
    return {
      viewport: root.dataset.viewport,
      sidebarLayout: root.dataset.sidebarLayout,
      rootWidth: Math.round(root.getBoundingClientRect().width),
      hostWidth: Math.round(host.getBoundingClientRect().width),
      windowWidth: window.innerWidth,
      sidebarHidden: sidebar.hidden,
      sidebarOpen: sidebar.dataset.open,
      maskHidden: mask.hidden,
      ariaExpanded: toggle.getAttribute('aria-expanded'),
      ariaPressed: toggle.getAttribute('aria-pressed'),
      toolbarHidden: toolbar.hidden,
    };
  });
}

/**
 * 设置窗口尺寸并等待根节点断点更新。
 *
 * @param page 页面。
 * @param width 宽度，px。
 * @param height 高度，px。
 * @param expected 期望的 data-viewport。
 */
export async function resizeAndWait(
  page: Page,
  width: number,
  height: number,
  expected: string,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.ofd-viewer')?.dataset.viewport ?? null,
        ),
      { timeout: 10_000 },
    )
    .toBe(expected);
}

/**
 * 统计事件次数。
 *
 * @param page 页面。
 * @param type 事件名。
 */
export async function eventCount(page: Page, type: string): Promise<number> {
  return page.evaluate(
    (name) => window.__events?.filter((event) => event.type === name).length ?? 0,
    type,
  );
}
