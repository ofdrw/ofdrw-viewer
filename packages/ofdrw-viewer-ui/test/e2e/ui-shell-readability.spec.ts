/**
 * UI 外壳可读性验收：文档属性常驻入口、更多菜单定位/裁剪、输出对话框 hover/focus 对比度。
 *
 * 证据写入 `test/.artifacts/ui-bugfix-20261023/t1/`（截图 + JSON 计算记录）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, expectNoPageErrors, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { FIXTURES, openViewer, viewerUrl } from './support';

const ARTIFACTS = join(process.cwd(), 'test', '.artifacts', 'ui-bugfix-20261023', 't1');
mkdirSync(ARTIFACTS, { recursive: true });

/** 菜单完成态证据。 */
interface MenuEvidence {
  readonly size: string;
  readonly viewport: string | null;
  readonly toolbar: {
    readonly clientWidth: number;
    readonly scrollWidth: number;
    readonly scrollLeft: number;
  };
  readonly more: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly moreInViewport: boolean;
  readonly moreHitTest: boolean;
  readonly menu: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly withinViewport: boolean;
    readonly parentClass: string | null;
    readonly insideToolbar: boolean;
    readonly visibleItems: string[];
    readonly overflowY: string;
  };
}

/** 颜色分量（0-255，alpha 0-1）。 */
interface RGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** 单条对比度记录。 */
interface ContrastRecord {
  readonly theme: string;
  readonly element: string;
  readonly state: string;
  readonly color: string;
  readonly background: string;
  readonly ratio: number;
  readonly focusVisible?: boolean;
  readonly accentColor?: string;
  readonly outlineColor?: string;
}

/** 解析 `rgb(...)` / `rgba(...)`。 */
function parseColor(value: string): RGBA {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return { r: 0, g: 0, b: 0, a: 0 };
  const parts = match[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
}

/** 前景叠加到背景。 */
function composite(foreground: RGBA, background: RGBA): RGBA {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (front: number, back: number) =>
    (front * foreground.a + back * background.a * (1 - foreground.a)) / alpha;
  return {
    r: channel(foreground.r, background.r),
    g: channel(foreground.g, background.g),
    b: channel(foreground.b, background.b),
    a: alpha,
  };
}

/** WCAG 2.1 相对亮度。 */
function luminance(color: RGBA): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.1 对比度。 */
function contrast(foreground: RGBA, background: RGBA): number {
  const base = background.a < 1 ? composite(background, { r: 255, g: 255, b: 255, a: 1 }) : background;
  const text = foreground.a < 1 ? composite(foreground, base) : foreground;
  const light = Math.max(luminance(text), luminance(base));
  const dark = Math.min(luminance(text), luminance(base));
  return (light + 0.05) / (dark + 0.05);
}

/** 读取元素的前景、有效背景（逐层合成）与焦点/强调色。 */
async function readColors(locator: Locator) {
  return locator.evaluate((element) => {
    interface Rgba {
      readonly r: number;
      readonly g: number;
      readonly b: number;
      readonly a: number;
    }
    const parse = (value: string): Rgba => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) return { r: 0, g: 0, b: 0, a: 0 };
      const parts = match[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
    };
    const blend = (front: Rgba, back: Rgba): Rgba => {
      const alpha = front.a + back.a * (1 - front.a);
      if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
      const channel = (top: number, bottom: number) =>
        (top * front.a + bottom * back.a * (1 - front.a)) / alpha;
      return {
        r: channel(front.r, back.r),
        g: channel(front.g, back.g),
        b: channel(front.b, back.b),
        a: alpha,
      };
    };
    const layers: Rgba[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const background = parse(getComputedStyle(node).backgroundColor);
      if (background.a > 0) layers.push(background);
      if (background.a >= 1) break;
    }
    let effective: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      effective = blend(layers[index]!, effective);
    }
    const style = getComputedStyle(element);
    return {
      color: style.color,
      background: `rgba(${Math.round(effective.r)}, ${Math.round(effective.g)}, ${Math.round(effective.b)}, ${effective.a})`,
      focusVisible: element.matches(':focus-visible'),
      accentColor: style.accentColor,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
    };
  });
}

/** 追加对比度记录并断言 WCAG 2.1 AA 4.5:1。 */
async function checkContrast(
  records: ContrastRecord[],
  theme: string,
  name: string,
  state: string,
  locator: Locator,
  evidence: string,
): Promise<void> {
  const colors = await readColors(locator);
  const ratio = contrast(parseColor(colors.color), parseColor(colors.background));
  records.push({
    theme,
    element: name,
    state,
    color: colors.color,
    background: colors.background,
    ratio: Number(ratio.toFixed(2)),
    focusVisible: colors.focusVisible,
    accentColor: colors.accentColor,
    outlineColor: colors.outlineColor,
  });
  expect(ratio, `${theme}/${name}/${state} (${evidence})`).toBeGreaterThanOrEqual(4.5);
}

/** 断言强调色（非文本控件）/焦点环与背景对比度。 */
async function checkAccentContrast(
  records: ContrastRecord[],
  theme: string,
  name: string,
  state: string,
  locator: Locator,
  property: 'accentColor' | 'outlineColor',
): Promise<void> {
  const colors = await readColors(locator);
  const accent = parseColor(colors[property]);
  const ratio = contrast(accent, parseColor(colors.background));
  records.push({
    theme,
    element: name,
    state,
    color: colors[property],
    background: colors.background,
    ratio: Number(ratio.toFixed(2)),
    focusVisible: colors.focusVisible,
    accentColor: colors.accentColor,
    outlineColor: colors.outlineColor,
  });
  expect(ratio, `${theme}/${name}/${state}/${property}`).toBeGreaterThanOrEqual(4.5);
}

/** 键盘 Tab 到指定元素。 */
async function tabTo(page: Page, target: Locator, limit = 30): Promise<boolean> {
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return true;
    await page.keyboard.press('Tab');
  }
  return target.evaluate((element) => element === document.activeElement);
}

/** 截图并保存到证据目录。 */
async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`) });
}

/** 文档属性常驻入口、菜单去重与功能门控。 */
test('文档属性常驻 info 按钮打开属性对话框，更多菜单不再重复', async ({ page, issues }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openViewer(page, FIXTURES.multi);

  const properties = page.locator('[data-ofd-control="document-properties"]');
  await expect(properties).toBeVisible();
  await expect(properties).toHaveAttribute('aria-label', '文档属性');
  await expect(properties.locator('svg.ofd-icon')).toHaveAttribute('aria-hidden', 'true');
  await properties.click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await expect(page.locator('.ofd-dialog__title')).toContainText('文档属性');
  await screenshot(page, 'properties-dialog-light');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-dialog')).toHaveCount(0);
  await expect(properties).toBeFocused();

  await page.locator('[data-ofd-control="more"]').click();
  const menu = page.locator('.ofd-more-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-ofd-control="menu-properties"]')).toHaveCount(0);
  await expect(menu.locator('[data-ofd-control="menu-about"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // FeatureState=hide：隐藏按钮。
  await page.evaluate(() => window.__viewer!.setFeatures({ documentProperties: false }));
  await expect(properties).toBeHidden();

  // FeatureState=disable：保留按钮但禁用并给出原因。
  await page.evaluate(() => {
    window.__viewer!.setFeatureDisplay('disable');
    window.__viewer!.setFeatures({ documentProperties: true });
    window.__viewer!.setFeatures({ documentProperties: false });
  });
  await expect(properties).toBeVisible();
  await expect(properties).toBeDisabled();
  await expect(properties).toHaveAttribute('aria-disabled', 'true');
  expect(await properties.getAttribute('title')).toContain('文档属性不可用');
  await screenshot(page, 'properties-disabled-light');

  await page.evaluate(() => {
    window.__viewer!.setFeatureDisplay('hide');
    window.__viewer!.setFeatures({ documentProperties: true });
  });
  await expect(properties).toBeVisible();
  await expect(properties).toBeEnabled();
  await expectNoPageErrors(page, issues);
});

/** 四种视口下更多按钮常驻、菜单完整且不被工具栏裁剪。 */
test('360/480/768/1440 视口：更多按钮常驻、菜单完整、Esc/点外关闭', async ({ page, issues }) => {
  const cases = [
    {
      width: 360,
      height: 640,
      viewport: 'narrow',
      items: [
        '上一页',
        '下一页',
        '缩小',
        '放大',
        '适合页面',
        '适合宽度',
        '旋转',
        '查找',
        '打印',
        '导出图片',
        '签章信息',
        '进入全屏',
        '关于',
      ],
    },
    {
      width: 480,
      height: 800,
      viewport: 'mobile',
      items: ['上一页', '下一页', '旋转', '查找', '打印', '导出图片', '签章信息', '进入全屏', '关于'],
    },
    {
      width: 768,
      height: 1024,
      viewport: 'compact',
      items: ['上一页', '下一页', '旋转', '查找', '打印', '导出图片', '签章信息', '进入全屏', '关于'],
    },
    { width: 1440, height: 900, viewport: 'desktop', items: ['关于'] },
  ] as const;

  await page.setViewportSize({ width: 1440, height: 900 });
  await openViewer(page, FIXTURES.multi);
  const more = page.locator('[data-ofd-control="more"]');
  const menu = page.locator('.ofd-more-menu');
  const evidence: MenuEvidence[] = [];

  for (const current of cases) {
    await page.setViewportSize({ width: current.width, height: current.height });
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector<HTMLElement>('.ofd-viewer')?.dataset.viewport ?? null),
      )
      .toBe(current.viewport);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.ofd-viewer__toolbar')!.scrollLeft = 0;
    });
    await page.waitForTimeout(120);

    const closed = await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>('.ofd-viewer__toolbar')!;
      const button = document.querySelector<HTMLElement>('[data-ofd-control="more"]')!;
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        toolbar: {
          clientWidth: toolbar.clientWidth,
          scrollWidth: toolbar.scrollWidth,
          scrollLeft: toolbar.scrollLeft,
        },
        more: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        moreInViewport:
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight &&
          style.visibility !== 'hidden' &&
          style.display !== 'none',
        moreHitTest: Boolean(hit && button.contains(hit)),
      };
    });
    expect(closed.moreInViewport, `${current.width}px 更多按钮在视口内`).toBe(true);
    expect(closed.moreHitTest, `${current.width}px 更多按钮可点击`).toBe(true);
    // 按钮常驻，不需要把工具栏横向滚动到最右才能看到。
    expect(closed.toolbar.scrollLeft, `${current.width}px 未横向滚动`).toBe(0);

    await screenshot(page, `more-${current.width}x${current.height}-closed`);
    await more.click();
    await expect(menu).toBeVisible();
    if (current.viewport === 'narrow') {
      // 键盘导航：第一项聚焦，ArrowDown 移动，Home/End 跳转。
      const items = menu.locator('.ofd-more-menu__item:visible');
      await expect(items.first()).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(items.nth(1)).toBeFocused();
      await page.keyboard.press('End');
      await expect(items.last()).toBeFocused();
      await page.keyboard.press('Home');
      await expect(items.first()).toBeFocused();
    }
    const opened = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-ofd-control="more"]')!;
      const element = document.querySelector<HTMLElement>('.ofd-more-menu')!;
      const rect = element.getBoundingClientRect();
      const items = [...element.querySelectorAll<HTMLElement>('.ofd-more-menu__item')]
        .filter((item) => getComputedStyle(item).display !== 'none')
        .map((item) => item.textContent?.trim() ?? '');
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        withinViewport:
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight,
        parentClass: element.parentElement?.className ?? null,
        insideToolbar: Boolean(element.closest('.ofd-viewer__toolbar')),
        visibleItems: items,
        overflowY: getComputedStyle(element).overflowY,
        expanded: button.getAttribute('aria-expanded'),
        ariaControls: button.getAttribute('aria-controls'),
        menuId: element.id,
        menuRole: element.getAttribute('role'),
        itemRoles: [...element.querySelectorAll('.ofd-more-menu__item')].map((item) =>
          item.getAttribute('role'),
        ),
      };
    });
    expect(opened.withinViewport, `${current.width}px 菜单在视口内`).toBe(true);
    expect(opened.insideToolbar, `${current.width}px 菜单不被 toolbar 裁剪`).toBe(false);
    expect(opened.parentClass).toBe('ofd-viewer');
    expect(opened.visibleItems).toEqual([...current.items]);
    expect(opened.overflowY).toBe('auto');
    expect(opened.expanded).toBe('true');
    expect(opened.ariaControls).toBe(opened.menuId);
    expect(opened.menuRole).toBe('menu');
    expect(opened.itemRoles.every((role) => role === 'menuitem')).toBe(true);

    evidence.push({
      size: `${current.width}x${current.height}`,
      viewport: current.viewport,
      toolbar: closed.toolbar,
      more: closed.more,
      moreInViewport: closed.moreInViewport,
      moreHitTest: closed.moreHitTest,
      menu: {
        left: opened.left,
        top: opened.top,
        right: opened.right,
        bottom: opened.bottom,
        withinViewport: opened.withinViewport,
        parentClass: opened.parentClass,
        insideToolbar: opened.insideToolbar,
        visibleItems: opened.visibleItems,
        overflowY: opened.overflowY,
      },
    });
    await screenshot(page, `more-${current.width}x${current.height}-open`);

    // Esc 关闭并把焦点还给触发按钮。
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toBeFocused();

    // 点击菜单外关闭。
    await more.click();
    await expect(menu).toBeVisible();
    await page.mouse.click(8, Math.min(current.height - 20, 420));
    await expect(menu).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toBeFocused();
  }

  // 视口高度不足时菜单内部可滚动，且仍不超出视口。
  await page.setViewportSize({ width: 360, height: 300 });
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector<HTMLElement>('.ofd-viewer')?.dataset.viewport ?? null),
    )
    .toBe('narrow');
  await more.click();
  await expect(menu).toBeVisible();
  const scrollable = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.ofd-more-menu')!;
    element.scrollTop = 120;
    const rect = element.getBoundingClientRect();
    return {
      withinViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
      overflowY: getComputedStyle(element).overflowY,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
  expect(scrollable.withinViewport).toBe(true);
  expect(scrollable.overflowY).toBe('auto');
  expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
  expect(scrollable.scrollTop).toBeGreaterThan(0);
  await screenshot(page, 'more-360x300-scrollable');
  await page.keyboard.press('Escape');

  writeFileSync(join(ARTIFACTS, 'more-menu.json'), JSON.stringify(evidence, null, 2));
  await expectNoPageErrors(page, issues);
});

/** light/dark 打印选项对话框与导出范围控件的 hover/focus 对比度。 */
test('打印/导出选项 light/dark hover/focus 对比度 ≥ 4.5:1', async ({ page, issues }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openViewer(page, FIXTURES.multi);
  const records: ContrastRecord[] = [];

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => window.__viewer!.setTheme(value), theme);
    await expect(page.locator('.ofd-viewer')).toHaveAttribute('data-theme', theme);
    await page.locator('[data-ofd-control="print"]').click();
    await expect(page.locator('.ofd-dialog')).toBeVisible();
    await screenshot(page, `print-${theme}-normal`);

    const rangeSelect = page.locator('.ofd-output-form select').first();
    const primary = page.locator('.ofd-dialog__action--primary');
    const cancel = page.locator('.ofd-dialog__action:not(.ofd-dialog__action--primary)');
    const closeButton = page.locator('.ofd-dialog__close');
    const checkRow = page.locator('.ofd-output-check');
    const checkbox = page.locator('.ofd-output-check input[type="checkbox"]');

    await page.mouse.move(0, 0);
    await checkContrast(records, theme, 'range-select', 'normal', rangeSelect, 'print dialog');
    await checkContrast(records, theme, 'print-primary', 'normal', primary, 'print dialog');
    await checkContrast(records, theme, 'cancel', 'normal', cancel, 'print dialog');
    await checkContrast(records, theme, 'close', 'normal', closeButton, 'print dialog');
    await checkContrast(records, theme, 'checkbox-label', 'normal', checkRow, 'print dialog');
    await checkContrast(records, theme, 'field-label', 'normal', page.locator('.ofd-output-field__label').first(), 'print dialog');
    await checkAccentContrast(records, theme, 'checkbox', 'normal', checkbox, 'accentColor');

    // select hover。
    await rangeSelect.hover();
    await checkContrast(records, theme, 'range-select', 'hover', rangeSelect, 'print dialog');
    await screenshot(page, `print-${theme}-select-hover`);

    // checkbox 行 hover。
    await page.mouse.move(0, 0);
    await checkRow.hover();
    await checkContrast(records, theme, 'checkbox-label', 'hover', checkRow, 'print dialog');
    await screenshot(page, `print-${theme}-checkbox-hover`);

    // option 普通与选中态。
    await rangeSelect.selectOption('all');
    const options = await rangeSelect.evaluate((element) => {
      const select = element as HTMLSelectElement;
      return [...select.options].map((option) => {
        const style = getComputedStyle(option);
        return {
          text: option.textContent?.trim() ?? '',
          color: style.color,
          background: style.backgroundColor,
          selected: option.selected,
        };
      });
    });
    for (const option of options) {
      const ratio = contrast(parseColor(option.color), parseColor(option.background));
      records.push({
        theme,
        element: `option:${option.text}`,
        state: option.selected ? 'checked' : 'normal',
        color: option.color,
        background: option.background,
        ratio: Number(ratio.toFixed(2)),
      });
      expect(ratio, `${theme}/option/${option.text}`).toBeGreaterThanOrEqual(4.5);
    }
    await rangeSelect.selectOption('current');

    // 主按钮 hover。
    await page.mouse.move(0, 0);
    await primary.hover();
    await checkContrast(records, theme, 'print-primary', 'hover', primary, 'print dialog');
    await screenshot(page, `print-${theme}-primary-hover`);

    // 键盘焦点：checkbox 与主按钮。
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await rangeSelect.focus();
    expect(await tabTo(page, checkbox)).toBe(true);
    await screenshot(page, `print-${theme}-checkbox-focus`);
    await checkContrast(records, theme, 'checkbox-label', 'focus', checkRow, 'print dialog');
    expect(await tabTo(page, primary)).toBe(true);
    await screenshot(page, `print-${theme}-primary-focus`);
    await checkContrast(records, theme, 'print-primary', 'focus', primary, 'print dialog');
    const primaryFocus = await readColors(primary);
    expect(primaryFocus.focusVisible, `${theme} 主按钮键盘焦点可见`).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.ofd-dialog')).toHaveCount(0);

    // 导出对话框覆盖 range 控件的 hover/focus（打印与导出共用输出控件样式）。
    await page.locator('[data-ofd-control="export"]').click();
    await expect(page.locator('.ofd-dialog')).toBeVisible();
    const quality = page.locator('.ofd-output-quality');
    // PNG 下质量滑杆无意义被禁用；切换到 JPEG 后启用。
    await page.locator('.ofd-output-form select').nth(1).selectOption('jpeg');
    await expect(quality).toBeEnabled();
    await page.mouse.move(0, 0);
    await checkAccentContrast(records, theme, 'range', 'normal', quality, 'accentColor');
    await quality.hover();
    await screenshot(page, `export-${theme}-range-hover`);
    await checkAccentContrast(records, theme, 'range', 'hover', quality, 'accentColor');
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('.ofd-output-form select').first().focus();
    expect(await tabTo(page, quality)).toBe(true);
    await screenshot(page, `export-${theme}-range-focus`);
    await checkAccentContrast(records, theme, 'range', 'focus', quality, 'outlineColor');
    const rangeFocus = await readColors(quality);
    expect(rangeFocus.focusVisible, `${theme} range 键盘焦点可见`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ofd-dialog')).toHaveCount(0);
  }

  writeFileSync(join(ARTIFACTS, 'contrast.json'), JSON.stringify(records, null, 2));
  await expectNoPageErrors(page, issues);
});

/** en-US 下常驻按钮与菜单名称全部走 i18n。 */
test('en-US：常驻文档属性按钮与更多菜单名称', async ({ page, issues }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  // 语言由宿主参数注入，验证 i18n 字典而非运行时切换路径。
  await page.goto(`${viewerUrl(FIXTURES.multi)}&locale=en-US`);
  await expect(page.locator('html')).toHaveAttribute('data-e2e-ready', 'true', {
    timeout: 45_000,
  });
  await page.waitForFunction(() => (window.__viewer?.getPageCount() ?? 0) > 0);

  const properties = page.locator('[data-ofd-control="document-properties"]');
  await expect(properties).toHaveAttribute('aria-label', 'Document properties');
  const more = page.locator('[data-ofd-control="more"]');
  await expect(more).toHaveAttribute('aria-label', 'More actions');
  await more.click();
  const menu = page.locator('.ofd-more-menu');
  await expect(menu).toHaveAttribute('aria-label', 'More actions');
  await expect(menu.locator('[data-ofd-control="menu-about"]')).toHaveText('About');
  await expect(menu.locator('[data-ofd-control="menu-properties"]')).toHaveCount(0);
  await screenshot(page, 'more-en-US-480x800');
  await page.keyboard.press('Escape');
  await expectNoPageErrors(page, issues);
});