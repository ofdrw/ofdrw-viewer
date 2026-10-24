/**
 * UI 字体配置 E2E：外部未内嵌字体的 OFD + 真实浏览器 + dist 构建产物。
 *
 * 夹具 `external-font.ofd` 是仓库 `ofd_pdf_match/draw_param_ref.ofd` 的原样副本：5 页
 * 中文发票，只声明 FontName/FamilyName（宋体/楷体/Courier New），**不含 FontFile**，
 * 不配置外部字体时文字必然缺失。与内嵌 SimSun 的 `site/public/samples/*.ofd` 不同，
 * 它才能真正验证“外部字体是否生效”。
 *
 * 为了稳定性与离线可重复，远端的 fontsource URL 保持线上 CDN 形态，由 `page.route`
 * 映射到 `test/.fixtures/fonts` 内的本地副本；站点首选的本地兜底字体（文泉驿微米黑 TTC）
 * 则由 Vite 静态服务直接提供。CDN 中断降级用例在同一路由上直接 abort。
 * 真实 CDN 访问另做过手工验证（见任务输出）。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, expectNoPageErrors, test } from './fixtures';
import type { IssueCollector } from './fixtures';
import { FIXTURES, openViewer, viewerUrl } from './support';

/** 仓库根目录。 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
/** 本地字体夹具目录（gitignore）。 */
const FONT_DIR = join(REPO_ROOT, 'packages/ofdrw-viewer-ui/test/.fixtures/fonts');
/** 站点首选的本地兜底字体（随站点分发的文泉驿微米黑 TTC，bypass 用本地副本）。 */
const LOCAL_FONT_FILE = 'wqy-microhei.ttc';
/** 站点本地字体的 URL（真实站点为 `public/fonts/wqy-microhei.ttc`，测试走 e2e 静态目录）。 */
const LOCAL_FONT_URL = '/packages/ofdrw-viewer-ui/test/.fixtures/fonts/wqy-microhei.ttc?e2e=fonts';
/** 以上 URL 在路由中的匹配模式。 */
const LOCAL_FONT_PATTERN = /\/test\/\.fixtures\/fonts\/wqy-microhei\.ttc/;
/** 站点别名组（`SITE_FONT_ALIASES` 的关键一条）：把「宋体」声明接到文泉驿的真实名。 */
const SITE_ALIASES = [['宋体', 'simsun', 'nsimsun', '新宋体', 'wenquanyimicrohei', 'notoserifsc']];
/** 线上 CDN 形态；只在 URL 上使用，实际字节由 page.route 提供。 */
const FONT_CDN_SERIF = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.1/files';
/** 与站点 `SITE_FONTS` 同源的第二种字体（无衬线）。 */
const FONT_CDN_SANS = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.3.1/files';
/** 中文主字体（衬线）：覆盖发票中的全部汉字。 */
const CJK_FONT_FILE = 'noto-serif-sc-chinese-simplified-400-normal.woff2';
/** 拉丁补充字体。 */
const LATIN_FONT_FILE = 'noto-serif-sc-latin-400-normal.woff2';
/** 站点补充字体：中文（无衬线）。 */
const SANS_CJK_FONT_FILE = 'noto-sans-sc-chinese-simplified-400-normal.woff2';
/** 站点补充字体：拉丁（无衬线）。 */
const SANS_LATIN_FONT_FILE = 'noto-sans-sc-latin-400-normal.woff2';
/**
 * 中文主字体 URL；带查询串，避免 Vite 对重复 URL 返回 304 而绕过 page.route。
 *
 * 两个必须注意的点（均为实测踩坑）：
 * 1. 页面自身的导航请求也带着这两个 URL（`fonts` 查询参数），所以 Playwright 的路由
 *    匹配必须**精确到字体路径**；宽泛的 `/cdn\.jsdelivr\.net/` 会连 index.html 的导航
 *    一起拦下，`page.goto` 收到内容为字体的响应，页面根本不会加载。
 * 2. family 不能命中引擎内置别名 `宋体 → notoserifcjksc`：`noto-serif-sc` 字体文件的
 *    PostScript 名 `NotoSerifSC-Regular` 归一化后正好命中该别名，引擎会把替代字体当成
 *    原字体并信任文档里的显式 Glyph ID，整页文字被画成错字且不报 `W_FONT_MISSING`
 *    （字体覆盖集还缺少部分字形）。因此用 `family=` 显式声明该字体的内部 family 名
 *    （来自字体 name 表，相当于真实运行时对 `FontInput.family` 的赋值）。
 */
const CJK_FONT_URL = `${FONT_CDN_SERIF}/${CJK_FONT_FILE}?e2e=fonts&family=NotoSerifSC-Regular`;
/** 拉丁补充字体 URL。 */
const LATIN_FONT_URL = `${FONT_CDN_SERIF}/${LATIN_FONT_FILE}?e2e=fonts`;
/** 与站点一致的补充字体：中文（无衬线）。 */
const SANS_CJK_FONT_URL = `${FONT_CDN_SANS}/${SANS_CJK_FONT_FILE}?e2e=fonts`;
/** 与站点一致的补充字体：拉丁（无衬线）。 */
const SANS_LATIN_FONT_URL = `${FONT_CDN_SANS}/${SANS_LATIN_FONT_FILE}?e2e=fonts`;
/** 字体请求的精确路径（不含查询串），用于区分页面导航与真实字体请求。 */
const FONT_PATTERN = new RegExp(
  `${FONT_CDN_SERIF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:${CJK_FONT_FILE}|${LATIN_FONT_FILE})|` +
    `${FONT_CDN_SANS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:${SANS_CJK_FONT_FILE}|${SANS_LATIN_FONT_FILE})|` +
    LOCAL_FONT_PATTERN.source,
);
/**
 * 打开后允许出现的非字体 warning。
 *
 * 该样本自带发票模板、签章与图片；这些 warning 在未引入字体配置前就存在，与字体无关，
 * 实测为 `W_UNSUPPORTED_PAINT`（模板页无 Area）、`W_BAD_NUMBER`（ColorSpace/DeltaX）、
 * `W_ANNOT_EMPTY`（注释 Appearance 为空）、`W_IMAGE_DECODE`（图片由测试路由裁剪）。
 */
const ALLOWED_NON_FONT_WARNINGS = [
  /^W_SIGNATURE/,
  /^W_UNSUPPORTED_PAINT$/,
  /^W_BAD_NUMBER$/,
  /^W_ANNOT_EMPTY$/,
  /^W_IMAGE_DECODE$/,
];

/**
 * 断言本地字体夹具存在。
 *
 * 字体文件不提交（体积大且只用于测试），缺失时本文件全部用例 skip，而不是伪造通过。
 */
function requireFontFixtures(): void {
  for (const file of [
    CJK_FONT_FILE,
    LATIN_FONT_FILE,
    SANS_CJK_FONT_FILE,
    SANS_LATIN_FONT_FILE,
    LOCAL_FONT_FILE,
  ]) {
    test.skip(
      !existsSync(join(FONT_DIR, file)),
      `缺少本地字体夹具 ${file}：见 test/acceptance/README.md 的下载命令`,
    );
  }
}

/**
 * 把字体 URL 映射到本地 woff2 夹具。
 *
 * @param page 页面。
 * @param mode `serve` 正常返回本地字节；`abort` 模拟 CDN 中断。
 * @returns 每个字体 URL 的命中次数（按 URL 计数）。
 */
async function routeFonts(page: Page, mode: 'serve' | 'abort'): Promise<Map<string, number>> {
  const hits = new Map<string, number>();
  await page.route(FONT_PATTERN, async (route) => {
    // 查询串里的 family 只用于被 UI 读取，命中统计按路径归一。
    const url = route.request().url().split('?')[0]!;
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (LOCAL_FONT_PATTERN.test(url)) {
      // 本地字体本来就走 e2e 静态服务（与真实站点同源形态），“CDN 中断”只针对远端来源。
      await route.continue();
      return;
    }
    if (mode === 'abort') {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'font/woff2',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      path: join(FONT_DIR, url.split('/').at(-1)!),
    });
  });
  return hits;
}

/** 页面覆盖率统计。 */
interface CoverageStats {
  /** 有像素覆盖（alpha > 0）的像素数量；文字与图形都计入。 */
  readonly painted: number;
  /** 每个 canvas 的覆盖像素数量。 */
  readonly perCanvas: number[];
}

/**
 * 统计已渲染页面 canvas 的覆盖像素数量。
 *
 * 引擎用覆盖率画字形（白色 + alpha），因此“文字是否画出来”的直接证据是覆盖像素数量：
 * 该发票样本的框线/图片只占约 1.5 万像素，文字全部画出后约 4.5 万像素。
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

/** 页面 DOM 指纹：可访问姓名/尺寸等结构化信息越多，说明真实文本对象越多。 */
interface DomSignature {
  /** 带 aria-label / data-page-number / role 的元素数量。 */
  readonly nodes: number;
}

/**
 * 读取页面 DOM 指纹。
 *
 * 文字对象是否存在会体现在可访问姓名（`aria-label`）与页面节点上：字体缺失时该发票
 * 只剩框线与图片节点，实测约 77 个；字体生效后文本对象全部建立，约 641 个。
 *
 * @param page 页面。
 * @returns DOM 指纹。
 */
async function domSignature(page: Page): Promise<DomSignature> {
  return page.evaluate(() => ({
    nodes: document.querySelectorAll('[aria-label],[data-page-number],[role]').length,
  }));
}

/**
 * 等待第 2 页渲染完成（5 页发票的第 2 页是纯文本列表页，内容最密集）。
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
 * 滚动到指定页并等待该页真实渲染完成。
 *
 * @param page 页面。
 * @param pageNumber 1-based 页码。
 */
async function goToPage(page: Page, pageNumber: number): Promise<void> {
  await page.evaluate((target) => window.__viewer!.goToPage(target), pageNumber);
  await page.waitForFunction(
    (target) =>
      window.__events?.some(
        (event) =>
          event.type === 'pagerendered' &&
          (event.detail as { pageNumber?: number }).pageNumber === target,
      ) ?? false,
    pageNumber,
    { timeout: 60_000 },
  );
}

/**
 * 读取当前文档会话的全部 warning 码。
 *
 * @param page 页面。
 * @returns warning 码列表（按发生顺序，可能重复）。
 */
async function warningCodes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__viewer!.getState().ui.warnings.map((warning) => warning.code));
}

/**
 * 断言页面没有未预期异常：字体相关的 requestfailed 是“CDN 中断”用例的预期结果，
 * 由调用方通过 `allowFontFailures` 放行。
 *
 * @param page 页面。
 * @param issues 收集器。
 * @param allowFontFailures 是否放行字体请求失败。
 */
async function expectNoUnexpectedErrors(
  page: Page,
  issues: IssueCollector,
  allowFontFailures = false,
): Promise<void> {
  if (allowFontFailures) {
    const other = issues.requestFailures.filter((item) => !FONT_PATTERN.test(item.url));
    expect(other, 'requestfailed（非字体）').toEqual([]);
    expect(issues.pageErrors, 'pageerror').toEqual([]);
    const unexpected = await page.evaluate(() => window.__errors ?? []);
    expect(unexpected, 'window error').toEqual([]);
    return;
  }
  await expectNoPageErrors(page, issues);
}

test.describe('UI 字体配置（外部未内嵌字体样本）', () => {
  test('未配置字体：文字不可见且出现 W_FONT_MISSING', async ({ page, issues }) => {
    requireFontFixtures();
    const hits = await routeFonts(page, 'serve');
    await openViewer(page, FIXTURES.externalFont, { page: 2, scale: 1 });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    // 第 1 页是模板页（框线+图片，实测固定 4.76 万覆盖像素、77 个节点）；第 2 页纯文本，
    // 字体缺失时只剩框线（实测 1.5 万覆盖像素、2.9 万/5.1 万对比）。逐 canvas 计数才能
    // 区分两者：滚到第 2 页时前两页都可能留在 DOM 中。
    const coverage = await countPaintedPixels(page);
    expect(coverage.perCanvas.length, '已渲染 canvas 数').toBeGreaterThan(1);
    // 第 2 页 canvas：字体缺失时只有框线，不超过 2 万像素。
    expect(coverage.perCanvas.at(-1), '第 2 页覆盖像素').toBeLessThan(20000);
    const signature = await domSignature(page);
    expect(signature.nodes, 'DOM 节点').toBeLessThan(300);

    const codes = await warningCodes(page);
    // 该样本声明了 楷体/宋体/Courier New 三种字体，均无 FontFile：每种字体各报一次。
    expect(
      codes.filter((code) => code === 'W_FONT_MISSING').length,
      'W_FONT_MISSING 次数',
    ).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => window.__viewer!.getState().document.status)).toBe('ready');
    // 未配置字体时 UI 不应发起任何字体请求。
    expect(Array.from(hits.keys()), '字体请求').toEqual([]);

    await expectNoUnexpectedErrors(page, issues);
  });

  test('配置字体后：文字可见且无 W_FONT_MISSING', async ({ page, issues }) => {
    requireFontFixtures();
    const hits = await routeFonts(page, 'serve');
    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { default: [{ url: CJK_FONT_URL }], supplementary: [{ url: LATIN_FONT_URL }] },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    const coverage = await countPaintedPixels(page);
    expect(coverage.perCanvas.length, '已渲染 canvas 数').toBeGreaterThan(0);
    expect(coverage.painted, '覆盖像素').toBeGreaterThan(40000);
    expect((await domSignature(page)).nodes, 'DOM 节点').toBeGreaterThan(400);

    const codes = await warningCodes(page);
    expect(codes.filter((code) => code.startsWith('W_FONT'))).toEqual([]);
    expect(Array.from(hits.keys()).sort(), '字体请求').toEqual(
      [CJK_FONT_URL, LATIN_FONT_URL].map((url) => url.split('?')[0]).sort(),
    );
    expect(Array.from(hits.values())).toEqual([1, 1]);

    await expectNoUnexpectedErrors(page, issues);
  });

  test('字体生效前后：同一页覆盖像素与 DOM 节点对比，配置后显著增加', async ({ page, issues }) => {
    requireFontFixtures();
    await routeFonts(page, 'serve');

    await openViewer(page, FIXTURES.externalFont, { page: 1, scale: 1 });
    await goToPage(page, 1);
    await page.waitForTimeout(500);
    const withoutFont = {
      coverage: await countPaintedPixels(page),
      signature: await domSignature(page),
    };

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routeFonts(page, 'serve');
    await openViewer(page, FIXTURES.externalFont, {
      page: 1,
      scale: 1,
      fonts: { default: [{ url: CJK_FONT_URL }], supplementary: [{ url: LATIN_FONT_URL }] },
    });
    await goToPage(page, 1);
    await page.waitForTimeout(500);
    const withFont = {
      coverage: await countPaintedPixels(page),
      signature: await domSignature(page),
    };

    // 页面导航后 window.__events 被重置，字体请求的命中可能记在导航前的加载上；
    // 这里以像素与 DOM 为准，命中数只在同一会话内断言（见其他用例）。
    // 实测第 1 页：覆盖像素 1.6 万 → 4.5 万，DOM 节点 77 → 641。
    expect(withFont.coverage.painted, '覆盖像素').toBeGreaterThan(
      withoutFont.coverage.painted * 2,
    );
    expect(withFont.signature.nodes, 'DOM 节点').toBeGreaterThan(
      withoutFont.signature.nodes * 4,
    );
    expect(await warningCodes(page)).not.toContain('W_FONT_MISSING');

    await expectNoUnexpectedErrors(page, issues);
  });

  test('CDN 中断降级：文档仍打开、不抛错、只产生字体 warning', async ({ page, issues }) => {
    requireFontFixtures();
    const hits = await routeFonts(page, 'abort');
    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: { default: [{ url: CJK_FONT_URL }], supplementary: [{ url: LATIN_FONT_URL }] },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    // 文档结构与页数不受字体影响。
    expect(await page.evaluate(() => window.__viewer!.getPageCount())).toBe(5);
    expect(await page.evaluate(() => window.__viewer!.getState().document.status)).toBe('ready');
    expect(Array.from(hits.keys()).sort(), '被中断的字体请求').toEqual(
      [CJK_FONT_URL, LATIN_FONT_URL].map((url) => url.split('?')[0]).sort(),
    );

    // 只剩字体相关 warning。
    const codes = await warningCodes(page);
    const unexpected = codes.filter(
      (code) => !code.startsWith('W_FONT') && !ALLOWED_NON_FONT_WARNINGS.some((pattern) => pattern.test(code)),
    );
    expect(unexpected, '非字体 warning').toEqual([]);
    // 两个来源各失败一次，加上文档三种字体自身缺字体。
    expect(
      codes.filter((code) => code === 'W_FONT_MISSING').length,
      'W_FONT_MISSING 次数',
    ).toBeGreaterThanOrEqual(2);
    // 没有可用字体：第 2 页只剩框线（与“未配置字体”逐像素一致），文本对象不建立。
    const coverage = await countPaintedPixels(page);
    expect(coverage.perCanvas.length, '已渲染 canvas 数').toBeGreaterThan(1);
    expect(coverage.perCanvas.at(-1), '第 2 页覆盖像素').toBeLessThan(20000);
    expect((await domSignature(page)).nodes, 'DOM 节点').toBeLessThan(300);

    // 只有字体请求失败；没有 pageerror、没有未捕获 rejection。
    await expectNoUnexpectedErrors(page, issues, true);
  });

  test('Web Component：font-default 属性变更后实例重建并生效', async ({ page, issues }) => {
    requireFontFixtures();
    await routeFonts(page, 'serve');
    await page.goto(
      viewerUrl(FIXTURES.externalFont, { page: 1, scale: 1, waitForRender: false }),
    );
    await expect(page.locator('html')).toHaveAttribute('data-e2e-ready', 'true', {
      timeout: 45_000,
    });

    await expect
      .poll(
        async () => {
          const defined = await page.evaluate(async () => {
            // 自定义元素是独立入口（核心入口不注册），按站点同样的方式引入；
            // 路径由页面 origin 解析，类型上以变量形式传入以避免 tsc 按模块解析。
            const entry: string = '/packages/ofdrw-viewer-ui/dist/element.js';
            await import(/* @vite-ignore */ entry);
            return customElements.get('ofd-viewer') !== undefined;
          });
          return defined ? 'defined' : 'undefined';
        },
        { timeout: 30_000 },
      )
      .toBe('defined');
    await page.evaluate((src) => {
      const container = document.querySelector<HTMLElement>('#viewer')!;
      const element = document.createElement('ofd-viewer');
      element.id = 'component';
      element.setAttribute('src', src);
      element.style.height = '100vh';
      container.replaceWith(element);
    }, FIXTURES.externalFont);

    // 未配置字体：文字不可见。
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            document.querySelectorAll<HTMLCanvasElement>('#component .ofd-page canvas').length,
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(2000);
    const before = await countPaintedPixels(page);
    expect(before.painted, '属性变更前覆盖像素').toBeLessThan(80000);

    // font-default 变更触发 destroyViewer + ensureViewer：实例重建并按新属性重新打开文档。
    await page.evaluate((url) => {
      document.querySelector('#component')!.setAttribute('font-default', url);
    }, CJK_FONT_URL);

    let after = before;
    await expect
      .poll(
        async () => {
          after = await countPaintedPixels(page);
          return after.painted;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(before.painted * 2);
    // 元素仍在 DOM 中，文档仍然可见。
    expect(await page.locator('#component').isVisible()).toBe(true);
    expect(
      await page.evaluate(
        () => document.querySelector('#component')!.querySelectorAll('.ofd-page').length,
      ),
    ).toBeGreaterThan(1);

    await expectNoUnexpectedErrors(page, issues);
  });

  test('与站点 SITE_FONTS 同构：本地兜底字体 + CDN 补充 + 别名，远端中断仍可显示', async ({
    page,
    issues,
  }) => {
    requireFontFixtures();
    const hits = await routeFonts(page, 'serve');
    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: {
        default: [
          { url: LOCAL_FONT_URL, family: 'WenQuanYi Micro Hei' },
          { url: CJK_FONT_URL, family: 'Noto Serif SC' },
        ],
        supplementary: [
          { url: LATIN_FONT_URL },
          { url: SANS_CJK_FONT_URL },
          { url: SANS_LATIN_FONT_URL },
        ],
        aliases: SITE_ALIASES,
      },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    const coverage = await countPaintedPixels(page);
    expect(coverage.perCanvas.length, '已渲染 canvas 数').toBeGreaterThan(0);
    expect(coverage.perCanvas.at(-1), '第 2 页覆盖像素').toBeGreaterThan(40000);
    expect((await warningCodes(page)).filter((code) => code.startsWith('W_FONT'))).toEqual([]);
    // 本地字体与 4 个 CDN 来源都被读取；同一来源只请求一次（来源去重 + Promise 复用）。
    expect(hits.size, '字体来源').toBe(5);
    expect([...hits.values()].every((count) => count === 1), '每个来源只请求一次').toBe(true);

    await expectNoUnexpectedErrors(page, issues);
  });

  test('CDN 中断时本地兜底字体仍生效：文字可见且无字体 warning', async ({ page, issues }) => {
    requireFontFixtures();
    const hits = await routeFonts(page, 'abort');
    await openViewer(page, FIXTURES.externalFont, {
      page: 2,
      scale: 1,
      fonts: {
        default: [
          { url: LOCAL_FONT_URL, family: 'WenQuanYi Micro Hei' },
          { url: CJK_FONT_URL, family: 'Noto Serif SC' },
        ],
        supplementary: [
          { url: LATIN_FONT_URL },
          { url: SANS_CJK_FONT_URL },
          { url: SANS_LATIN_FONT_URL },
        ],
        aliases: SITE_ALIASES,
      },
    });
    await waitForSecondPage(page);
    await page.waitForTimeout(500);

    // 远端来源全部失败只产生 warning；本地兜底字体保证文字可见。
    expect(
      (await warningCodes(page)).filter((code) => code === 'W_FONT_MISSING').length,
      'W_FONT_MISSING 次数',
    ).toBe(4);
    const coverage = await countPaintedPixels(page);
    expect(coverage.perCanvas.at(-1), '第 2 页覆盖像素').toBeGreaterThan(40000);
    // 5 个来源都会被请求：4 个远端被中断，本地字体照常返回。
    expect(hits.size, '字体来源').toBe(5);

    await expectNoUnexpectedErrors(page, issues, true);
  });

  test('备选外部字体样本（拿来主义/宋体）：未配置不可见，配置后可见', async ({ page, issues }) => {
    requireFontFixtures();
    await routeFonts(page, 'serve');
    await openViewer(page, FIXTURES.externalFontBackup, { page: 1, scale: 1 });
    const withoutFont = await countPaintedPixels(page);
    // 该样本除水印图片外全是文字：未配置字体时只剩图片（实测 1.7 万像素）。
    expect(withoutFont.painted, '未配置字体覆盖像素').toBeLessThan(25000);
    expect(await warningCodes(page)).toContain('W_FONT_MISSING');

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routeFonts(page, 'serve');
    await openViewer(page, FIXTURES.externalFontBackup, {
      page: 1,
      scale: 1,
      fonts: { default: [{ url: CJK_FONT_URL }], supplementary: [{ url: LATIN_FONT_URL }] },
    });
    const withFont = await countPaintedPixels(page);
    // 实测 1.7 万 → 11.7 万。
    expect(withFont.painted, '配置字体覆盖像素').toBeGreaterThan(withoutFont.painted * 3);
    expect(await warningCodes(page)).not.toContain('W_FONT_MISSING');

    await expectNoUnexpectedErrors(page, issues);
  });
});
