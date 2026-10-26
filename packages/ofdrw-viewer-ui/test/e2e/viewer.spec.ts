/**
 * 阅读主路径：连续滚动、跳页、缩放、旋转、查找、选择复制。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, eventCount, openViewer, viewState } from './support';

test('连续滚动更新当前页并触发下一页渲染', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.text, { scale: 1 });
  await expect(page.locator('.ofd-page')).toHaveCount(2);

  await page.locator('.ofd-viewer__main').hover();
  // 全套件运行时首个 wheel 偶发被浏览器丢弃，补一次以确保滚动事件已进入主容器。
  await page.mouse.wheel(0, 1400);
  await page.mouse.wheel(0, 1400);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const main = document.querySelector<HTMLElement>('.ofd-viewer__main')!;
          return {
            scrollTop: main.scrollTop,
            pageNumber: window.__viewer!.getPageNumber(),
          };
        }),
      { timeout: 10_000 },
    )
    .toEqual(expect.objectContaining({ pageNumber: 2 }));
  const state = await viewState(page);
  expect(state.scrollTop).toBeGreaterThan(0);
  expect(state.pageNumber).toBe(2);
  await expect(page.locator('.ofd-page[data-page-number="2"]')).toHaveAttribute('data-current', 'true');
  await expectNoPageErrors(page, issues);
});

test('跳页、缩放、旋转、查找与选择复制', async ({ page, issues, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openViewer(page, FIXTURES.text, { scale: 1 });

  expect(await page.evaluate(() => window.__viewer!.getPageCount())).toBe(2);
  expect((await viewState(page)).viewport).toBe('desktop');

  // 跳页：工具栏页码输入提交后当前页与渲染事件一致。
  await page.locator('.ofd-toolbar__page-input').fill('2');
  await page.locator('.ofd-toolbar__page-input').press('Enter');
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(2);
  await expect(page.locator('.ofd-page[data-page-number="2"]')).toHaveAttribute('data-current', 'true');

  // 缩放：canvas 设备像素随 scale 重新渲染。
  const beforeZoom = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.ofd-page[data-page-number="2"] canvas');
    return { width: canvas?.width ?? 0 };
  });
  const rendersBeforeZoom = await eventCount(page, 'pagerendered');
  await page.locator('[data-ofd-control="zoomIn"]').click();
  await expect.poll(async () => (await viewState(page)).scale).toBeGreaterThan(1);
  await expect.poll(() => eventCount(page, 'pagerendered')).toBeGreaterThan(rendersBeforeZoom);
  const afterZoom = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.ofd-page[data-page-number="2"] canvas');
    return { width: canvas?.width ?? 0 };
  });
  expect(afterZoom.width).toBeGreaterThan(beforeZoom.width);

  // 旋转：页面容器角度与渲染事件同步。
  await page.locator('[data-ofd-control="rotate"]').click();
  await expect.poll(async () => (await viewState(page)).rotation).toBe(90);
  await expect(page.locator('.ofd-page[data-page-number="2"]')).toHaveAttribute('data-rotation', '90');

  // 查找：Ctrl+F 打开查找栏，输入后产生高亮与计数。
  await page.locator('.ofd-page[data-page-number="2"]').click();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.ofd-viewer__findbar')).toBeVisible();
  const input = page.locator('.ofd-findbar__input');
  await input.fill('OFD');
  await input.press('Enter');
  await expect(page.locator('.ofd-find-highlight').first()).toBeVisible();
  const findState = (await viewState(page)).find;
  expect(findState.query).toBe('OFD');
  expect(findState.total).toBeGreaterThan(0);
  const countText = await page.locator('.ofd-findbar__count').textContent();
  expect(countText).toMatch(/\d/);

  await input.press('Escape');
  await expect(page.locator('.ofd-viewer__findbar')).toBeHidden();

  // 选择：跨字符 span 构造范围，状态回写并复制到系统剪贴板。
  const selected = await page.evaluate(() => {
    const spans = [
      ...document.querySelectorAll<HTMLElement>(
        '.ofd-page[data-page-number="2"] .ofd-text-item, .ofd-page[data-page-number="2"] .ofd-text-char',
      ),
    ];
    const usable = spans.filter((span) => (span.textContent ?? '').trim().length > 0);
    if (usable.length < 3) return '';
    const range = document.createRange();
    range.setStart(usable[0]!.firstChild ?? usable[0]!, 0);
    range.setEndBefore(usable[2]!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return window.getSelection()?.toString() ?? '';
  });
  expect(selected.length).toBeGreaterThan(0);
  await expect.poll(async () => (await viewState(page)).selectedText.length).toBeGreaterThan(0);
  await page.evaluate(() => window.__viewer!.copySelection());
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.trim().length).toBeGreaterThan(0);

  expect(await page.evaluate(() => window.__viewer!.getScale())).toBeGreaterThan(1);
  await expectNoPageErrors(page, issues);
});

test('缩小到最低渲染倍率以下只做 CSS 缩放，不重绘 canvas', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.text, { scale: 1 });
  const canvas = page.locator('.ofd-page[data-page-number="1"] canvas');
  await expect(canvas).toHaveCount(1);
  await expect
    .poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(0);
  const base = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).width,
    cssWidth: element.getBoundingClientRect().width,
    renderKey: (element as HTMLCanvasElement).dataset.renderKey,
  }));
  // 给当前 canvas 打标记：一旦触发重绘，元素会被离屏画布替换，标记随之消失。
  await canvas.evaluate((element) => {
    (element as HTMLCanvasElement & { __e2eFloor?: boolean }).__e2eFloor = true;
  });

  await page.evaluate(() => window.__viewer!.setScale(0.5));
  await expect.poll(async () => (await viewState(page)).scale).toBe(0.5);
  const half = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).width,
    cssWidth: element.getBoundingClientRect().width,
    renderKey: (element as HTMLCanvasElement).dataset.renderKey,
    marked: (element as HTMLCanvasElement & { __e2eFloor?: boolean }).__e2eFloor === true,
  }));
  expect(half.width).toBe(base.width);
  expect(half.renderKey).toBe(base.renderKey);
  expect(half.marked).toBe(true);
  expect(half.cssWidth).toBeCloseTo(base.cssWidth / 2, 1);

  await page.evaluate(() => window.__viewer!.setScale(0.25));
  await expect.poll(async () => (await viewState(page)).scale).toBe(0.25);
  const quarter = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).width,
    cssWidth: element.getBoundingClientRect().width,
    marked: (element as HTMLCanvasElement & { __e2eFloor?: boolean }).__e2eFloor === true,
  }));
  expect(quarter.width).toBe(base.width);
  expect(quarter.marked).toBe(true);
  expect(quarter.cssWidth).toBeCloseTo(base.cssWidth / 4, 1);

  // 放大回下限以上仍按实际倍率重绘。
  await page.evaluate(() => window.__viewer!.setScale(2));
  await expect
    .poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width))
    .toBeGreaterThan(base.width);
  await expectNoPageErrors(page, issues);
});

test('移动 390×844 打开本地 OFD 并保持抽屉布局', async ({ page, issues }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openViewer(page, FIXTURES.multi);

  const state = await viewState(page);
  expect(state.pageCount).toBe(4);
  expect(state.viewport).toBe('narrow');
  expect(state.sidebarLayout).toBe('drawer');
  await expect(page.locator('.ofd-page')).toHaveCount(4);
  expect(await page.locator('.ofd-viewer__toolbar').isVisible()).toBe(true);

  await page.locator('[data-ofd-control="sidebar"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  await expect(page.locator('.ofd-viewer__sidebar-mask')).toBeVisible();
  await expect(page.locator('[data-ofd-control="sidebar"]')).toHaveAttribute('aria-expanded', 'true');
  await expectNoPageErrors(page, issues);
});
