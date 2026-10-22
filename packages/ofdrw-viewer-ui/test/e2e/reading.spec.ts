/**
 * 阅读手势：Ctrl/Cmd+滚轮、触控板 ctrlKey wheel、触摸双指捏合、双击缩放，
 * 以及手势后的滚动/跳页/缩放/旋转回归。
 */
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

test('Ctrl+滚轮以指针为锚点缩放并阻止浏览器默认缩放', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { scale: 1 });
  await dismissFindbar(page);

  const result = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.ofd-viewer__main')!;
    const rect = main.getBoundingClientRect();
    const clientY = rect.top + Math.min(160, rect.height / 2);
    const pageAt = (y: number) => {
      const element = [...document.querySelectorAll<HTMLElement>('.ofd-page')].find((item) => {
        const box = item.getBoundingClientRect();
        return y >= box.top && y < box.bottom;
      });
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        pageNumber: Number(element.dataset.pageNumber),
        ratio: (y - box.top) / box.height,
      };
    };
    const before = pageAt(clientY);
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
      clientX: rect.left + rect.width / 2,
      clientY,
    });
    return { clientY, before, prevented: !main.dispatchEvent(event) };
  });
  expect(result.prevented).toBe(true);
  expect(result.before).not.toBeNull();
  await expect.poll(async () => (await viewState(page)).scale).toBeGreaterThan(1);

  const after = await page.evaluate((clientY) => {
    const element = [...document.querySelectorAll<HTMLElement>('.ofd-page')].find((item) => {
      const box = item.getBoundingClientRect();
      return clientY >= box.top && clientY < box.bottom;
    });
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      pageNumber: Number(element.dataset.pageNumber),
      ratio: (clientY - box.top) / box.height,
    };
  }, result.clientY);
  expect(after?.pageNumber).toBe(result.before?.pageNumber);
  expect(Math.abs((after?.ratio ?? 0) - (result.before?.ratio ?? 0))).toBeLessThan(0.03);
  await expectNoPageErrors(page, issues);
});

test('zoom 功能关闭时 Ctrl+滚轮不拦截、不缩放', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { scale: 1, features: { zoom: false } });
  await dismissFindbar(page);
  const result = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.ofd-viewer__main')!;
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
      clientX: 300,
      clientY: 300,
    });
    return { prevented: !main.dispatchEvent(event), scale: window.__viewer!.getScale() };
  });
  expect(result.prevented).toBe(false);
  expect(result.scale).toBe(1);
  await expectNoPageErrors(page, issues);
});

test('双指捏合以中点为锚点缩放并在结束后不遗留 capture', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { scale: 1 });
  await dismissFindbar(page);
  const result = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.ofd-viewer__main')!;
    const rect = main.getBoundingClientRect();
    const clientY = rect.top + Math.min(160, rect.height / 2);
    const firstX = rect.left + rect.width / 2 - 50;
    const secondX = rect.left + rect.width / 2 + 50;
    const pageAt = (y: number) => {
      const element = [...document.querySelectorAll<HTMLElement>('.ofd-page')].find((item) => {
        const box = item.getBoundingClientRect();
        return y >= box.top && y < box.bottom;
      });
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        pageNumber: Number(element.dataset.pageNumber),
        ratio: (y - box.top) / box.height,
      };
    };
    const fire = (type: string, pointerId: number, x: number, y: number) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: pointerId === 1,
        clientX: x,
        clientY: y,
      });
      return !main.dispatchEvent(event);
    };
    const before = pageAt(clientY);
    const firstDown = fire('pointerdown', 1, firstX, clientY);
    const secondDown = fire('pointerdown', 2, secondX, clientY);
    const moved = fire('pointermove', 2, secondX + 50, clientY);
    const scale = window.__viewer!.getState().view.scale;
    fire('pointerup', 2, secondX + 50, clientY);
    fire('pointerup', 1, firstX, clientY);
    const after = pageAt(clientY);
    return {
      before,
      after,
      firstDown,
      secondDown,
      moved,
      scale,
      captures: [main.hasPointerCapture(1), main.hasPointerCapture(2)],
    };
  });
  expect(result.firstDown).toBe(false);
  expect(result.secondDown).toBe(true);
  expect(result.moved).toBe(true);
  expect(result.scale).toBeCloseTo(1.5, 1);
  expect(result.after?.pageNumber).toBe(result.before?.pageNumber);
  expect(Math.abs((result.after?.ratio ?? 0) - (result.before?.ratio ?? 0))).toBeLessThan(0.05);
  expect(result.captures).toEqual([false, false]);
  await expectNoPageErrors(page, issues);
});

test('双击在适合宽度与 100% 之间切换且不选中文本', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi, { scale: 1 });
  await dismissFindbar(page);
  const firstBox = await page.locator('.ofd-page').first().boundingBox();
  if (!firstBox) throw new Error('页面不可见');
  await page.mouse.dblclick(firstBox.x + firstBox.width / 2, firstBox.y + 80);
  await expect.poll(async () => (await viewState(page)).scale).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__viewer!.getState().view.zoomMode)).toBe('auto');
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true);

  const secondBox = await page.locator('.ofd-page').first().boundingBox();
  if (!secondBox) throw new Error('页面不可见');
  await page.mouse.dblclick(secondBox.x + secondBox.width / 2, secondBox.y + 80);
  await expect.poll(async () => (await viewState(page)).scale).toBeCloseTo(1, 2);
  expect(await page.evaluate(() => window.__viewer!.getState().view.zoomMode)).toBe('page-actual');
  await expectNoPageErrors(page, issues);
});

test('手势后滚动/跳页/缩放/旋转/侧栏回归', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.bookmarks, { scale: 1 });
  await dismissFindbar(page);
  const mainBox = await page.locator('.ofd-viewer__main').boundingBox();
  if (!mainBox) throw new Error('主区域不可见');
  await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + mainBox.height / 2);
  // 首个 wheel 偶发被浏览器丢弃，补一次以确保进入主容器。
  await page.mouse.wheel(0, 1200);
  await page.mouse.wheel(0, 1200);
  await expect.poll(async () => (await viewState(page)).scrollTop).toBeGreaterThan(0);

  await page.evaluate(() => window.__viewer!.goToPage(5));
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(5);
  await page.evaluate(() => window.__viewer!.setScale(1.5));
  await expect.poll(async () => (await viewState(page)).scale).toBeCloseTo(1.5, 2);
  await page.evaluate(() => window.__viewer!.setRotation(90));
  await expect.poll(async () => (await viewState(page)).rotation).toBe(90);
  await page.evaluate(() => window.__viewer!.openSidebar('thumbnails'));
  await expect.poll(async () => (await viewState(page)).sidebarView).toBe('thumbnails');
  await page.evaluate(() => window.__viewer!.closeSidebar());
  await expect.poll(async () => (await viewState(page)).sidebarView).toBe(null);
  await expectNoPageErrors(page, issues);
});