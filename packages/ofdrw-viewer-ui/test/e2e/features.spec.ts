/**
 * 功能开关：隐藏/禁用、依赖级联、动态切换与 API 拒绝。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

test('features=false 默认隐藏控件，API 返回 OFD_FEATURE_DISABLED', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, {
    features: { print: false, export: false, signatures: false, find: false },
  });

  const print = page.locator('[data-ofd-control="print"]');
  const exportButton = page.locator('[data-ofd-control="export"]');
  const signatures = page.locator('[data-ofd-control="signatures"]');
  const find = page.locator('[data-ofd-control="find"]');
  await expect(print).toBeHidden();
  await expect(exportButton).toBeHidden();
  await expect(signatures).toBeHidden();
  await expect(find).toBeHidden();

  const states = await page.evaluate(() => ({
    print: window.__viewer!.getFeatureState('print'),
    export: window.__viewer!.getFeatureState('export'),
    signatures: window.__viewer!.getFeatureState('signatures'),
    find: window.__viewer!.getFeatureState('find'),
  }));
  for (const state of Object.values(states)) {
    expect(state.enabled).toBe(false);
    expect(state.visible).toBe(false);
    expect(state.reason).toBe('host');
  }

  const errors = await page.evaluate(async () => {
    const read = async (action: () => unknown) => {
      try {
        await action();
        return null;
      } catch (error) {
        const value = error as { code?: string; feature?: string };
        return { code: value.code, feature: value.feature };
      }
    };
    return {
      print: await read(() => window.__viewer!.print()),
      export: await read(() => window.__viewer!.exportImage()),
      signatures: await read(() => window.__viewer!.getSignatureDetail('1')),
      find: await read(() => window.__viewer!.find('OFD')),
    };
  });
  expect(errors).toEqual({
    print: { code: 'OFD_FEATURE_DISABLED', feature: 'print' },
    export: { code: 'OFD_FEATURE_DISABLED', feature: 'export' },
    signatures: { code: 'OFD_FEATURE_DISABLED', feature: 'signatures' },
    find: { code: 'OFD_FEATURE_DISABLED', feature: 'find' },
  });
  await expectNoPageErrors(page, issues);
});

test('featureDisplay=disable 保留控件但禁用并给出原因', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, {
    display: 'disable',
    features: { print: false, export: false },
  });
  const print = page.locator('[data-ofd-control="print"]');
  const exportButton = page.locator('[data-ofd-control="export"]');
  await expect(print).toBeVisible();
  await expect(exportButton).toBeVisible();
  for (const button of [print, exportButton]) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAttribute('data-feature-disabled', 'true');
    expect(await button.getAttribute('title')).toMatch(/不可用|禁用/);
  }
  const states = await page.evaluate(() => ({
    print: window.__viewer!.getFeatureState('print'),
    export: window.__viewer!.getFeatureState('export'),
  }));
  expect(states.print).toEqual({ enabled: false, visible: true, reason: 'host' });
  expect(states.export).toEqual({ enabled: false, visible: true, reason: 'host' });
  await expectNoPageErrors(page, issues);
});

test('textLayer=false 级联关闭 find/selection 且不生成文本层', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.text, { features: { textLayer: false } });
  const states = await page.evaluate(async () => {
    const findState = await window.__viewer!.find('OFD').then(
      () => null,
      (error: { code?: string; feature?: string }) => ({
        code: error.code,
        feature: error.feature,
      }),
    );
    return {
      textLayer: window.__viewer!.getFeatureState('textLayer'),
      find: window.__viewer!.getFeatureState('find'),
      selection: window.__viewer!.getFeatureState('selection'),
      defaultFind: findState,
    };
  });
  expect(states.textLayer.enabled).toBe(false);
  expect(states.find.enabled).toBe(false);
  expect(states.find.reason).toBe('dependency');
  expect(states.selection.enabled).toBe(false);
  expect(states.selection.reason).toBe('dependency');
  expect(states.defaultFind).toEqual({ code: 'OFD_FEATURE_DISABLED', feature: 'find' });

  await expect(page.locator('.ofd-page__text-layer .ofd-text-item, .ofd-page__text-layer .ofd-text-char')).toHaveCount(0);
  await page.locator('.ofd-page').first().click();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.ofd-viewer__findbar')).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('toolbar=false 隐藏外壳控件但文档仍可渲染', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { features: { toolbar: false } });
  await expect(page.locator('.ofd-viewer__toolbar')).toBeHidden();
  await expect(page.locator('.ofd-page')).toHaveCount(4);
  expect((await viewState(page)).pageCount).toBe(4);
  expect(await page.locator('.ofd-page canvas').count()).toBeGreaterThan(0);

  // 没有工具栏后仍能用 API 翻页。
  await page.evaluate(() => window.__viewer!.goToPage(4));
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(4);
  await expectNoPageErrors(page, issues);
});

test('动态 setFeatures/setFeatureDisplay 同步隐藏、禁用与恢复', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  const print = page.locator('[data-ofd-control="print"]');
  await expect(print).toBeVisible();

  await page.evaluate(() => window.__viewer!.setFeatures({ print: false }));
  await expect(print).toBeHidden();
  expect(await page.evaluate(() => window.__viewer!.isFeatureEnabled('print'))).toBe(false);

  await page.evaluate(() => window.__viewer!.setFeatureDisplay('disable'));
  await page.evaluate(() => window.__viewer!.setFeatures({ print: true }));
  await page.evaluate(() => window.__viewer!.setFeatures({ print: false }));
  await expect(print).toBeDisabled();

  await page.evaluate(() => {
    window.__viewer!.setFeatureDisplay('hide');
    window.__viewer!.setFeatures({ print: true });
  });
  await expect(print).toBeVisible();
  await expect(print).toBeEnabled();
  await expect(print).not.toHaveAttribute('aria-disabled', 'true');
  await expectNoPageErrors(page, issues);
});
