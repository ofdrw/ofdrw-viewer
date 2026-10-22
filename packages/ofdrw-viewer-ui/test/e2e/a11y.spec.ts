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

async function scan(page: import('playwright/test').Page, context: string): Promise<AxeViolation[]> {
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

function serious(violations: AxeViolation[]): AxeViolation[] {
  return violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

test('axe 扫描阅读页、侧栏、查找栏与签章对话框', async ({ page, issues }) => {
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
  record('sidebar', await scan(page, '.ofd-viewer'));

  await page.evaluate(() => window.__viewer!.closeSidebar());
  await page.locator('.ofd-page').first().click();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.ofd-viewer__findbar')).toBeVisible();
  record('findbar', await scan(page, '.ofd-viewer'));
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    const signatures = window.__viewer!.getSignatures();
    void window.__viewer!.showSignature(signatures[0]!.id);
  });
  await expect(page.locator('.ofd-dialog')).toBeVisible();
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
