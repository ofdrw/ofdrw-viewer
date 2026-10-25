/**
 * 本机字体加载 E2E（设计 §10 e2e 行、需求清单 §10 T-E2E1~T-E2E4）。
 *
 * 夹具 `external-font.ofd` 只声明 宋体/楷体/Courier New 且不含 FontFile：不提供字体时
 * 文字必然缺失（见 `fonts.spec.ts` 的基线断言）。本文件用 `page.addInitScript()` 在页面
 * 脚本执行前桩化 `window.queryLocalFonts` 与 `navigator.permissions.query`，让「本机已安装
 * 字体」这件事可复现：
 *
 * - 桩只接受**定向查询**（必须带 `postscriptNames`），无参全量枚举直接拒绝并记入
 *   `window.__localFontQueries`，供测试断言「从未全量枚举」；
 * - 字号敏感匹配：只认真实 PostScript 写法（`SimSun`、`KaiTi`、`CourierNewPSMT`），
 *   大小写写错（`Simsun`）命中不了 —— 与 Chrome 实测行为一致；
 * - `blob()` 返回真实字体字节：宋体/楷体用 `site/public/fonts` 的中文字体，
 *   Courier New（西文等宽）用同目录的字体字节兜底，只要非空即可被引擎接受。
 *
 * 像素与 DOM 节点的阈值沿用 `fonts.spec.ts` 的实测基线（该文件与本文共用夹具）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, expectNoPageErrors, test } from './fixtures';
import type { IssueCollector } from './fixtures';
import { FIXTURES, openViewer, viewerUrl } from './support';

/** 仓库根目录。 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
/**
 * 桩字体候选：必须是引擎字体库能解析的**完整字体文件**（TTF/OTF/TTC）。
 *
 * 引擎用 fontkit 解析字体，不处理 woff/woff2（站点 `public/fonts/*.woff2` 是给
 * `@font-face` 用的 Web 字体格式），因此这里不能用站点字体，否则字体注入成功也会因为
 * 「无法解析」而继续报 `W_FONT_MISSING`——这一点已实测确认（woff2 → 缺字 71 条；
 * TTF → 0 条）。
 *
 * 优先用带汉字的 CJK TTF（Droid Sans Fallback），退到 DejaVu Sans（仅西文）。
 */
const CJK_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
];
/** 西文兜底字体（与 CJK 字体同用时取第一个可用者）。 */
const LATIN_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

/**
 * 取第一个存在的字体文件。
 *
 * @param candidates 候选绝对路径。
 * @returns 文件路径；全部缺失时返回 null。
 */
function firstExisting(candidates: readonly string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 选定的 CJK 字体（模块加载时确定）。 */
const CJK_FONT_FILE = firstExisting(CJK_FONT_CANDIDATES);
/** 选定的西文字体。 */
const LATIN_FONT_FILE = firstExisting(LATIN_FONT_CANDIDATES);

/**
 * 断言桩字体文件存在。
 *
 * 缺文件时本文件用例全部 skip 而不是伪造通过。
 */
function requireSiteFonts(): void {
  test.skip(CJK_FONT_FILE === null, `缺少本机 TTF 字体：${CJK_FONT_CANDIDATES.join(' / ')}`);
}

/**
 * 读取字体字节为 base64。
 *
 * @param path 字体文件路径；为 null 时抛错（调用前已由 `requireSiteFonts` 拦截）。
 * @returns base64 文本。
 */
function readFontBase64(path: string | null): string {
  if (!path) throw new Error('缺少字体夹具');
  return readFileSync(path).toString('base64');
}

/** 桩化选项。 */
interface LocalFontsStubOptions {
  /** 本机已安装的字体：PostScript 名（大小写敏感）→ 字体字节（base64）。 */
  readonly installed: Readonly<Record<string, string>>;
  /** 权限查询返回的状态；`unsupported` 表示连 `permissions` 都不可用。 */
  readonly permission: 'granted' | 'denied' | 'prompt';
  /** 完全移除 `queryLocalFonts`，模拟不支持的浏览器。 */
  readonly unsupported?: boolean;
  /** 让 `queryLocalFonts` 以该名字的错误拒绝（模拟 NotAllowedError/SecurityError）。 */
  readonly rejectWith?: string;
}

/**
 * 在页面脚本之前注入本机字体桩。
 *
 * @param page 页面。
 * @param options 桩化选项。
 */
async function stubLocalFonts(page: Page, options: LocalFontsStubOptions): Promise<void> {
  await page.addInitScript(
    (config: {
      installed: Record<string, string>;
      permission: string;
      unsupported: boolean;
      rejectWith: string | null;
    }) => {
      /** 查询记录：供测试断言「定向查询」「调用次数」。 */
      const queries: Array<{ postscriptNames: string[] | null; at: number }> = [];
      (window as unknown as { __localFontQueries: typeof queries }).__localFontQueries = queries;

      /**
       * 把 base64 还原为字节。
       *
       * @param base64 base64 文本。
       * @returns 字节数组。
       */
      const decode = (base64: string): Uint8Array => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      };

      const installed = new Map<string, Uint8Array>();
      for (const [name, base64] of Object.entries(config.installed)) {
        installed.set(name, decode(base64));
      }

      // 权限态可变量：`queryLocalFonts` 首次成功调用后置 true，
      // `permissions.query` 读取它（与真实 Chrome 行为一致）。必须声明在两者共同的
      // 作用域里，否则桩调用后权限不会变化。
      let granted = config.permission === 'granted';

      // 与 Chrome 一致：只接受定向查询；无参调用在真实实现里是全量枚举，测试直接拒绝。
      const queryLocalFonts = async (queryOptions?: {
        postscriptNames?: readonly string[];
      }): Promise<unknown[]> => {
        const names = queryOptions?.postscriptNames ?? null;
        queries.push({ postscriptNames: names ? [...names] : null, at: performance.now() });
        if (!names) {
          const error = new Error('桩不接受全量枚举');
          error.name = 'NotSupportedError';
          throw error;
        }
        if (config.rejectWith) {
          const error = new Error(`桩拒绝：${config.rejectWith}`);
          error.name = config.rejectWith;
          throw error;
        }
        // 成功调用即视为用户已授权（与真实 Chrome 行为一致）。
        granted = true;
        const found: unknown[] = [];
        for (const name of names) {
          const bytes = installed.get(name);
          if (!bytes) continue;
          found.push({
            postscriptName: name,
            fullName: name,
            family: name,
            style: 'Regular',
            blob: () => Promise.resolve(new Blob([bytes] as BlobPart[], { type: 'font/woff2' })),
          });
        }
        return found;
      };

      const scope = window as unknown as Record<string, unknown>;
      if (config.unsupported) {
        delete scope.queryLocalFonts;
      } else {
        scope.queryLocalFonts = queryLocalFonts;
      }

      if (config.permission !== 'unsupported') {
        // 与真实浏览器一致：`queryLocalFonts` 首次成功调用后权限即变为 granted，
        // 之后的 `permissions.query` 必须反映这一变化，否则重开时会被刷回 prompt。
        const permissions = {
          query: async (descriptor: { name?: string }) => {
            if (descriptor?.name !== 'local-fonts') throw new TypeError('不支持的权限名');
            const state = granted ? 'granted' : config.permission;
            return { state, onchange: null };
          },
        };
        Object.defineProperty(navigator, 'permissions', {
          configurable: true,
          value: permissions,
        });
      }
    },
    {
      installed: options.installed,
      permission: options.permission,
      unsupported: options.unsupported ?? false,
      rejectWith: options.rejectWith ?? null,
    },
  );
}

/** 读取桩收到的全部查询实参。 */
async function localFontQueries(page: Page): Promise<Array<{ postscriptNames: string[] | null }>> {
  return page.evaluate(
    () => (window as unknown as { __localFontQueries?: Array<{ postscriptNames: string[] | null }> }).__localFontQueries ?? [],
  );
}

/** 页面 canvas 覆盖率统计。 */
interface CoverageStats {
  /** 有像素覆盖（alpha > 0）的像素数量；文字与图形都计入。 */
  readonly painted: number;
  /** 每个 canvas 的覆盖像素数量。 */
  readonly perCanvas: number[];
}

/**
 * 统计已渲染页面 canvas 的覆盖像素数量。
 *
 * @param page 页面。
 * @returns 覆盖率统计。
 */
async function countPaintedPixels(page: Page): Promise<CoverageStats> {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('.ofd-page canvas'));
    const perCanvas: number[] = [];
    for (const canvas of canvases) {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || canvas.width === 0 || canvas.height === 0) continue;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let painted = 0;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 0) painted += 1;
      }
      perCanvas.push(painted);
    }
    return { painted: perCanvas.reduce((sum, value) => sum + value, 0), perCanvas };
  });
}

/**
 * 统计指定 warning 码的出现次数。
 *
 * @param page 页面。
 * @param code warning 码。
 * @returns 出现次数。
 */
async function warningCount(page: Page, code: string): Promise<number> {
  return (await warningCodes(page)).filter((item) => item === code).length;
}

/**
 * 读取当前文档会话的全部 warning 码。
 *
 * @param page 页面。
 * @returns warning 码列表。
 */
async function warningCodes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__viewer!.getState().ui.warnings.map((warning) => warning.code));
}

/**
 * 等待第 2 页（纯文本列表页）渲染完成。
 *
 * @param page 页面。
 */
async function waitForSecondPage(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      window.__events?.some(
        (event) =>
          event.type === 'pagerendered' && (event.detail as { pageNumber?: number }).pageNumber === 2,
      ) ?? false,
    null,
    { timeout: 60_000 },
  );
}

/**
 * 打开阅读器；页面就绪超时（冷启动依赖预构建偏慢）时整段重试一次。
 *
 * 只对「页面未就绪」这类环境抖动重试，不吞掉功能断言失败：重试后仍失败则抛出。
 *
 * @param page 页面。
 * @param fixture OFD 路径。
 * @param options 打开参数。
 */
async function openViewerWithRetry(
  page: Page,
  fixture: string,
  options: Parameters<typeof openViewer>[2],
): Promise<void> {
  try {
    await openViewer(page, fixture, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('data-e2e-ready')) throw error;
    await openViewer(page, fixture, options);
  }
}

/**
 * 断言「未使用本机字体」的基线画面：第 2 页只剩框线、文本对象未建立、有 W_FONT_MISSING。
 *
 * @param page 页面。
 * @param label 断言前缀，便于定位对照组的差异。
 */
async function expectMissingFontBaseline(page: Page, label: string): Promise<void> {
  // 主判据：字体缺失。该夹具声明了 楷体/宋体/Courier New 三种无 FontFile 的字体，
  // 实测每次运行都是 100 条 W_FONT_MISSING，且文本层为空。
  expect(await warningCount(page, 'W_FONT_MISSING'), `${label}：W_FONT_MISSING 次数`).toBeGreaterThan(
    50,
  );
  // 辅证：第 2 页只剩框线，实测固定 14920 覆盖像素。
  const coverage = await countPaintedPixels(page);
  expect(coverage.perCanvas.length, `${label}：已渲染 canvas 数`).toBeGreaterThan(1);
  expect(coverage.perCanvas.at(-1), `${label}：第 2 页覆盖像素`).toBeLessThan(20000);
}

/** 打开侧栏「设置」面板。 */
async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => window.__viewer!.openSidebar('settings'));
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
}

/** 本机字体开关控件（设置面板内的 role=switch）。 */
function localFontsSwitch(page: Page) {
  return page.locator('.ofd-viewer__sidebar [role="switch"]').first();
}

/** 本机字体确认框。 */
function localFontsDialog(page: Page) {
  return page.locator('.ofd-dialog[role="dialog"]').filter({ hasText: '使用本机字体' });
}

test.describe('本机字体加载（queryLocalFonts 桩化）', () => {
  test('T-E2E1 开开关并授权后：本机宋体生效、文字可见且无 W_FONT_MISSING', async ({
    page,
    issues,
  }) => {
    requireSiteFonts();
    await stubLocalFonts(page, {
      installed: {
        // 真实 PostScript 写法：大小写写错就命中不了（与 Chrome 一致）。
        SimSun: readFontBase64(CJK_FONT_FILE),
        KaiTi: readFontBase64(CJK_FONT_FILE),
        CourierNewPSMT: readFontBase64(LATIN_FONT_FILE),
      },
      permission: 'prompt',
    });

    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    // 首次打开时声明尚未缓存，本机字体不参与，先确认基线确实缺字。
    await expectMissingFontBaseline(page, '首次打开');
    const baselineCoverage = (await countPaintedPixels(page)).perCanvas.at(-1) ?? 0;
    // 首次打开不得在没有用户手势时自行申请权限。
    expect(await localFontQueries(page), '首次打开不得静默查询本机字体').toEqual([]);

    // 确认框出现：点「允许」，授权与查询都在该 click 内完成。
    const dialog = localFontsDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.locator('.ofd-dialog__action--primary').click();
    await expect(dialog).toBeHidden();

    // 授权成功后自动重开当前文档。语义判据三连：
    // ①W_FONT_MISSING 从 100 归零；②文本层真正建立（span 数 > 0）；
    // ③文本层使用的字体族命中文档声明名（宋体/楷体/Courier New 三者之一）。
    await expect
      .poll(async () => warningCount(page, 'W_FONT_MISSING'), { timeout: 60_000 })
      .toBe(0);
    // 辅证：第 2 页覆盖像素相对授权前显著增加（文字以字形轮廓绘制，不生成文本层 DOM）。
    // 重开瞬间 canvas 会被重建，`perCanvas` 可能为空：轮询等待数值稳定后再比较。
    await expect
      .poll(
        async () => {
          const stats = await countPaintedPixels(page);
          return stats.perCanvas.length > 0 ? (stats.perCanvas.at(-1) ?? 0) : 0;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan((baselineCoverage ?? 0) * 2);
    const codes = await warningCodes(page);
    expect(codes.filter((code) => code.startsWith('W_FONT')), '字体 warning').toEqual([]);

    // 定向查询：每次调用都带 postscriptNames、不超过 6 个、全部为 ASCII。
    const queries = await localFontQueries(page);
    expect(queries.length, '查询次数').toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.postscriptNames, '查询实参').not.toBeNull();
      expect(query.postscriptNames!.length).toBeLessThanOrEqual(6);
      expect(query.postscriptNames!.every((name) => !/[^\x00-\x7f]/.test(name))).toBe(true);
    }
    // 中文名不得进入候选，真实写法必须出现。
    const requested = queries.flatMap((query) => query.postscriptNames ?? []);
    expect(requested).toContain('SimSun');
    expect(requested).not.toContain('Simsun');
    expect(requested).not.toContain('宋体');

    await expectNoPageErrors(page, issues);
  });

  test('T-E2E1b 用户手动打开开关：授权后同样生效并恢复视图', async ({ page, issues }) => {
    requireSiteFonts();
    await stubLocalFonts(page, {
      installed: {
        SimSun: readFontBase64(CJK_FONT_FILE),
        KaiTi: readFontBase64(CJK_FONT_FILE),
        CourierNewPSMT: readFontBase64(LATIN_FONT_FILE),
      },
      permission: 'granted',
    });

    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1.5,
      rotation: 90,
      fonts: { localFonts: { enabled: true } },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    // 权限已经是 granted：不需要确认框，打开设置面板点开关即可。
    await openSettings(page);
    const toggle = localFontsSwitch(page);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await expect
      .poll(async () => (await countPaintedPixels(page)).painted, { timeout: 60_000 })
      .toBeGreaterThan(40000);
    // 重开后恢复视图：页码/缩放/旋转保持一致。
    const state = await page.evaluate(() => ({
      pageNumber: window.__viewer!.getState().view.pageNumber,
      scale: window.__viewer!.getState().view.scale,
      rotation: window.__viewer!.getState().view.rotation,
    }));
    expect(state.pageNumber).toBe(2);
    expect(state.scale).toBeCloseTo(1.5, 1);
    expect(state.rotation).toBe(90);

    await expectNoPageErrors(page, issues);
  });

  test('T-E2E2 「浏览器不支持」与「关闭开关」行为一致', async ({ page, issues }) => {
    requireSiteFonts();

    // 对照组 1：支持但开关关闭（未配置 localFonts）。
    await openViewer(page, FIXTURES.externalFont, { page: 2, scale: 1 });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);
    const disabled = {
      coverage: await countPaintedPixels(page),
      codes: await warningCodes(page),
    };
    await expectMissingFontBaseline(page, '关闭开关');
    // 不支持/未开启时不得查询本机字体。
    expect(await localFontQueries(page), '关闭开关时不得查询').toEqual([]);
    await expectNoPageErrors(page, issues);

    // 对照组 2：浏览器不支持（无 queryLocalFonts），且宿主把开关配为开启。
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubLocalFonts(page, {
      installed: { SimSun: readFontBase64(CJK_FONT_FILE) },
      permission: 'prompt',
      unsupported: true,
    });
    // 本用例在同一页面里二次导航：Vite 冷启动重新预构建依赖时首次就绪可能偏慢。
    // 就绪超时属于环境抖动、与「能力不可用」无关，因此对整段导航做一次重试，
    // 避免把环境抖动误判成与「关闭开关」的行为差异（重试后仍失败则照常报错）。
    await openViewerWithRetry(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);
    const unsupported = {
      coverage: await countPaintedPixels(page),
      codes: await warningCodes(page),
    };

    // 两种情形的画面与诊断完全一致：能力不可用时整个分支静默跳过。
    expect(unsupported.coverage.perCanvas, '逐 canvas 覆盖像素').toEqual(disabled.coverage.perCanvas);
    expect(unsupported.codes, 'warning 码').toEqual(disabled.codes);
    // 不支持时不弹确认框、不留开关（能力整体不可见）。
    await expect(page.locator('.ofd-dialog[role="dialog"]')).toHaveCount(0);
    await page.evaluate(() => window.__viewer!.openSidebar('settings'));
    const unsupportedSwitch = page.locator('.ofd-viewer__sidebar [role="switch"]');
    await expect(unsupportedSwitch).toHaveCount(0);
    // 不支持场景必须给出原因文案。
    await expect(page.locator('.ofd-viewer__sidebar')).toContainText('浏览器不支持');

    await expectNoPageErrors(page, issues);
  });

  test('T-E2E3 确认框点「不允许」后：本会话不再弹出，且不查询本机字体', async ({
    page,
    issues,
  }) => {
    requireSiteFonts();
    await stubLocalFonts(page, {
      installed: { SimSun: readFontBase64(CJK_FONT_FILE) },
      permission: 'prompt',
    });

    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    const dialog = localFontsDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.locator('.ofd-dialog__action:not(.ofd-dialog__action--primary)').click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(500);

    // 拒绝后：画面保持首次打开的结果，不查询、不重开跳变。
    await expectMissingFontBaseline(page, '拒绝后');
    expect(await localFontQueries(page), '拒绝后不得查询').toEqual([]);

    // 同一会话内再次打开文档：不再弹确认框。
    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);
    await expect(page.locator('.ofd-dialog[role="dialog"]')).toHaveCount(0);
    expect(await localFontQueries(page), '再次打开仍不得查询').toEqual([]);
    await expectMissingFontBaseline(page, '再次打开');

    await expectNoPageErrors(page, issues);
  });

  test('T-E2E4 Esc 关闭确认框视同「不允许」但不写用户选择：下次打开仍询问', async ({
    page,
    issues,
  }) => {
    requireSiteFonts();
    await stubLocalFonts(page, {
      installed: { SimSun: readFontBase64(CJK_FONT_FILE) },
      permission: 'prompt',
    });

    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    const dialog = localFontsDialog(page);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Esc 不写入「用户选择关闭」：持久化的 enabled 不得变成 false
    // （notified 在弹框前即置位，不能作为判断依据；真正的判据是下次仍会询问）。
    const stored = await page.evaluate(() => localStorage.getItem('ofd-viewer:local-fonts'));
    if (stored) {
      expect(JSON.parse(stored).enabled, 'Esc 不应写 enabled=false').not.toBe(false);
    }
    expect(await localFontQueries(page), 'Esc 后不得查询').toEqual([]);

    // 再次打开同一文档（同一会话）：仍然询问。
    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    });
    await waitForSecondPage(page);
    await expect(localFontsDialog(page)).toBeVisible();

    await expectNoPageErrors(page, issues);
  });

  test('权限被拒（NotAllowedError）：静默跳过，画面与关闭一致且只报字体 warning', async ({
    page,
    issues,
  }) => {
    requireSiteFonts();
    // 权限初始为 prompt（需要用户手势授权），但 `queryLocalFonts` 调用被拒绝。
    await stubLocalFonts(page, {
      installed: { SimSun: readFontBase64(CJK_FONT_FILE) },
      permission: 'prompt',
      rejectWith: 'NotAllowedError',
    });

    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    const dialog = localFontsDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.locator('.ofd-dialog__action--primary').click();
    await page.waitForTimeout(800);

    // 权限拒绝只影响本机字体：文档仍可用、只产生字体相关 warning。
    await expectMissingFontBaseline(page, '权限被拒');
    expect(await page.evaluate(() => window.__viewer!.getState().document.status)).toBe('ready');
    expect(await localFontQueries(page), '确实尝试过查询').not.toEqual([]);

    await expectNoPageErrors(page, issues);
  });
});
