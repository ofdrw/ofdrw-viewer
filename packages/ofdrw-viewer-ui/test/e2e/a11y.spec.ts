/**
 * axe 可访问性扫描与键盘操作。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: Array<{ target: string[]; failureSummary?: string }>;
}

interface AxeResults {
  readonly violations: AxeViolation[];
}

declare global {
  interface Window {
    axe?: {
      run(context?: unknown, options?: unknown): Promise<AxeResults>;
    };
  }
}

async function scan(page: import('@playwright/test').Page, context: string): Promise<AxeViolation[]> {
  const result = await page.evaluate(async (selector) => {
    const axe = window.axe;
    if (!axe) throw new Error('axe 未加载');
    const target = selector === 'document' ? document : document.querySelector(selector);
    if (!target) throw new Error(`未找到扫描目标 ${selector}`);
    return axe.run(target, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    });
  }, context);
  return result.violations;
}

/**
 * 等待元素自身的 CSS 入场动画结束：动画期间半透明中间态会造成对比度误报。
 *
 * @param locator 目标元素定位器。
 */
async function settleAnimations(
  locator: import('@playwright/test').Locator,
): Promise<void> {
  await locator.evaluate(async (element) => {
    const animations = element
      .getAnimations()
      .filter((animation) => animation.pending || animation.playState === 'running');
    // 动画可能在使用过程中被取消；allSettled 避免 AbortError 让扫描失败。
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
}

function serious(violations: AxeViolation[]): AxeViolation[] {
  return violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

test('axe 扫描阅读页、侧栏、查找栏、打印/导出与签章对话框', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.signature);
  await dismissFindbar(page);
  await page.addScriptTag({ path: 'test/e2e/vendor/axe.min.js' });

  const results: Array<{ area: string; violations: AxeViolation[] }> = [];
  const record = (area: string, violations: AxeViolation[]) => {
    results.push({ area, violations });
    console.log(`AXE ${area}`, JSON.stringify(serious(violations), null, 2));
  };

  record('core', await scan(page, '.ofd-viewer'));

  await page.locator('[data-ofd-control="sidebar"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  await settleAnimations(page.locator('.ofd-viewer__sidebar'));
  record('sidebar', await scan(page, '.ofd-viewer'));

  // 验证面板：状态徽标含 aria-hidden 图标与文字，不能只靠颜色表达。
  // 顶部不再有“验证”按钮：验证结果与签章列表点击、印章详情统一，文档级
  // 完整结果通过验证面板 API 打开（与详情/印章浮层里的入口等价）。
  await page.evaluate(() => window.__viewer!.openVerificationPanel());
  await expect(page.locator('.ofd-verification-panel')).toBeVisible();
  // 等待对话框入场动画结束，避免半透明中间态造成对比度误报。
  await settleAnimations(page.locator('.ofd-dialog'));
  const badgeIcon = page.locator('.ofd-verification-badge__icon').first();
  await expect(badgeIcon).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.ofd-verification-badge').first()).not.toHaveText('');
  record('verification-panel', await scan(page, '.ofd-viewer'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-verification-panel')).toBeHidden();

  await page.evaluate(() => window.__viewer!.closeSidebar());
  await page.locator('.ofd-page').first().click();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.ofd-viewer__findbar')).toBeVisible();
  await settleAnimations(page.locator('.ofd-viewer__findbar'));
  record('findbar', await scan(page, '.ofd-viewer'));
  await page.keyboard.press('Escape');

  // 打印/导出对话框：所有字段有名称，自定义范围输入也不应漏标。
  await page.locator('[data-ofd-control="print"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await page.locator('.ofd-output-form select').first().selectOption('custom');
  // 等待 150ms 入场动画结束，避免半透明中间态造成对比度误报。
  await settleAnimations(page.locator('.ofd-dialog'));
  record('print-dialog', await scan(page, '.ofd-viewer'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-dialog')).toBeHidden();

  await page.locator('[data-ofd-control="export"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await page.locator('.ofd-output-form select').first().selectOption('custom');
  await settleAnimations(page.locator('.ofd-dialog'));
  record('export-dialog', await scan(page, '.ofd-viewer'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-dialog')).toBeHidden();

  await page.evaluate(() => {
    const signatures = window.__viewer!.getSignatures();
    void window.__viewer!.showSignature(signatures[0]!.id);
  });
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await settleAnimations(page.locator('.ofd-dialog'));
  record('dialog', await scan(page, '.ofd-viewer'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-dialog')).toBeHidden();
  await expectNoPageErrors(page, issues);

  const failures = results.flatMap((entry) =>
    serious(entry.violations).map((violation) => ({ area: entry.area, id: violation.id, help: violation.help, nodes: violation.nodes.map((node) => node.target.join(' ')) })),
  );
  expect(failures, 'serious/critical axe violations').toEqual([]);
});

test('键盘：PageDown/PageUp、Home/End、Ctrl+F、Escape', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  await page.locator('.ofd-page').first().click();

  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(2);
  await page.keyboard.press('PageUp');
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(1);
  await page.keyboard.press('End');
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(4);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(1);

  await page.keyboard.press('Control+f');
  await expect(page.locator('.ofd-viewer__findbar')).toBeVisible();
  await page.locator('.ofd-findbar__input').fill('OFD');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-viewer__findbar')).toBeHidden();

  // 输入框中的方向键不应翻页。
  await page.locator('.ofd-page').first().click();
  await page.locator('.ofd-toolbar__page-input').focus();
  await page.keyboard.press('PageDown');
  expect((await viewState(page)).pageNumber).toBe(1);
  await expectNoPageErrors(page, issues);
});

test('沉浸式全屏 fallback 下 Escape 退出且不与侧栏冲突', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  await dismissFindbar(page);
  // 模拟浏览器缺少原生全屏能力，强制走沉浸式 fallback。
  // Chrome 同时暴露标准与前缀实现，只删除标准方法会让兼容层回退到 webkit 方法。
  await page.evaluate(() => {
    const root = window.__viewer!.getElements().root;
    for (const method of ['requestFullscreen', 'webkitRequestFullscreen'] as const) {
      Object.defineProperty(root, method, { configurable: true, value: undefined });
    }
  });
  const fullscreen = () =>
    page.evaluate(() => window.__viewer!.getState().view.fullscreen);
  const sidebar = () =>
    page.evaluate(() => window.__viewer!.getState().view.sidebarView);

  await page.locator('[data-ofd-control="fullscreen"]').click();
  await expect.poll(fullscreen).toBe(true);
  await expect(page.locator('.ofd-viewer')).toHaveAttribute('data-fullscreen-fallback', 'true');

  // 第一次 Esc 只关侧栏，不退出 fallback。
  await page.locator('[data-ofd-control="sidebar"]').click();
  await expect.poll(sidebar).toBe('thumbnails');
  await page.keyboard.press('Escape');
  await expect.poll(sidebar).toBeNull();
  expect(await fullscreen()).toBe(true);

  // 第二次 Esc 退出 fallback，并同步 data/class/state。
  await page.keyboard.press('Escape');
  await expect.poll(fullscreen).toBe(false);
  await expect(page.locator('.ofd-viewer')).toHaveAttribute('data-fullscreen-fallback', 'false');
  expect(
    await page.locator('.ofd-viewer').evaluate((element) =>
      element.classList.contains('ofd-viewer--fullscreen-fallback'),
    ),
  ).toBe(false);
  await expectNoPageErrors(page, issues);
});
