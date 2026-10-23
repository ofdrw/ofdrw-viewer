/**
 * 签章列表、覆盖层、详情与缺失签名值降级。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer, viewState } from './support';

/** showcase 样本：15 个签章，含真实 PNG 章。 */
const SHOWCASE = '/ofd_pdf_match/ofd-viewer-ui-showcase.ofd';
/** 验收产物目录。 */
const ARTIFACTS = resolve(process.cwd(), '../../test/.artifacts/ui-bugfix-20261023/t5');

test('真实签章：覆盖层、列表、未验证详情与 Esc 关闭', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.signature);
  await dismissFindbar(page);
  const overlay = page.locator('.ofd-signature-box[data-signature-id]');
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toBeVisible();

  // 默认不可见边框；hover/focus 才出现阴影边框，点击命中区域保持不变。
  await page.mouse.move(0, 0);
  await page.waitForTimeout(180);
  const baseStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      hover: element.matches(':hover'),
      focusVisible: element.matches(':focus-visible'),
      active: document.activeElement === element,
    };
  });
  expect(baseStyle).toMatchObject({
    borderColor: expect.stringMatching(/rgba?\(0, 0, 0, 0\)|transparent/),
    boxShadow: 'none',
    hover: false,
    focusVisible: false,
  });
  await overlay.hover();
  await page.waitForTimeout(180);
  const hoverStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(hoverStyle.borderColor).not.toBe(baseStyle.borderColor);
  expect(hoverStyle.boxShadow).not.toBe('none');
  expect(hoverStyle.width).toBeGreaterThan(0);
  expect(hoverStyle.height).toBeGreaterThan(0);
  await page.mouse.move(0, 0);
  await overlay.focus();
  await page.waitForTimeout(180);
  const focusStyle = await overlay.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(focusStyle).not.toBe('none');
  await expect(overlay).toBeFocused();

  // 直接通过 API 校验详情：固定未验证状态，不得出现“有效/通过”措辞。
  const detail = await page.evaluate(async () => {
    const signatures = window.__viewer!.getSignatures();
    if (signatures.length === 0) return null;
    return window.__viewer!.getSignatureDetail(signatures[0]!.id);
  });
  expect(detail).not.toBeNull();
  expect(detail!.validation.status).toBe('not-verified');
  expect(detail!.validation.note).toContain('未');
  expect(detail!.seal?.name ?? '').not.toBe('');
  expect(detail!.warnings ?? []).toEqual([]);

  await page.locator('[data-ofd-control="signatures"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  const summary = page.locator('.ofd-signature-summary-item');
  await expect(summary).toHaveCount(1);
  await expect(summary.locator('.ofd-signature-badge')).toContainText(/未验证|验证未知|验证无效|验证有效|无 效|无效|有效/);
  await expect(summary).toContainText(detail!.seal!.name!);

  await summary.click();
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.ofd-dialog__title')).toContainText('签章信息');
  const dialogText = await dialog.textContent();
  expect(dialogText).toContain(detail!.seal!.name!);
  expect(dialogText).not.toMatch(/验证通过|签名有效|验签成功/);

  // 真实 PNG 印章：Blob URL 解码成功，alt 可读，按 mm 比例显示。
  const sealImage = dialog.locator('.ofd-seal-image img');
  await expect(sealImage).toBeVisible();
  await expect(sealImage).toHaveAttribute('alt', /印章图片：.+/);
  await expect
    .poll(() => sealImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  expect(await sealImage.getAttribute('src')).toMatch(/^blob:/);
  await expect(dialog.locator('.ofd-seal-image__caption')).toContainText('mm');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // 覆盖层点击：默认启用验证，先打开验证浮层而非原详情对话框。
  await page.evaluate(() => window.__viewer!.closeSidebar());
  await overlay.click();
  const popover = page.locator('.ofd-signature-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText(/未验证|验证未知|验证无效|验证有效|有效|无效/);
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('showcase 第 9 页签章浮层：portal 定位不被第 10 页覆盖或 main 裁切', async ({
  page,
  issues,
}) => {
  const artifacts = resolve(process.cwd(), '../../test/.artifacts/ui-bugfix-20261023/t19');
  mkdirSync(artifacts, { recursive: true });
  await openViewer(page, SHOWCASE, { waitForRender: false });
  const page9 = page.locator('.ofd-page').nth(8);
  const overlay = page9.locator('.ofd-signature-box[data-signature-id]').first();
  await expect(overlay).toBeVisible();
  await overlay.click();

  const popover = page.locator('.ofd-signature-popover');
  await expect(popover).toBeVisible();
  await expect(overlay).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() =>
      popover
        .locator('.ofd-signature-popover__seal img')
        .evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(120);

  const geometry = await popover.evaluate((node) => {
    const main = document.querySelector<HTMLElement>('.ofd-viewer__main');
    if (!main) throw new Error('missing .ofd-viewer__main');
    const mainRect = main.getBoundingClientRect();
    const popoverRect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const containsHit = (hit: Element | null): boolean => hit === node || (hit !== null && node.contains(hit));
    const rows = [...node.querySelectorAll<HTMLElement>('dt, dd')].map((row) => {
      const rect = row.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        tag: row.tagName.toLowerCase(),
        text: (row.textContent ?? '').trim(),
        hitInside: containsHit(hit),
        hitLabel: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : null,
      };
    });
    const full = node.querySelector<HTMLElement>('[data-ofd-control="signature-popover-full"]');
    if (!full) throw new Error('missing signature-popover-full');
    const fullRect = full.getBoundingClientRect();
    const fullHit = document.elementFromPoint(
      fullRect.left + fullRect.width / 2,
      fullRect.top + fullRect.height / 2,
    );
    const anchor = document.querySelector<HTMLElement>(
      '.ofd-signature-box[data-signature-id][aria-expanded="true"]',
    );
    if (!anchor) throw new Error('missing expanded signature anchor');
    const anchorRect = anchor.getBoundingClientRect();
    const inMain = (rect: DOMRect): boolean =>
      rect.left >= mainRect.left - 0.5 &&
      rect.right <= mainRect.right + 0.5 &&
      rect.top >= mainRect.top - 0.5 &&
      rect.bottom <= mainRect.bottom + 0.5;
    const placement =
      popoverRect.bottom <= anchorRect.top + 0.5
        ? 'above'
        : popoverRect.top >= anchorRect.bottom - 0.5
          ? 'below'
          : popoverRect.left >= anchorRect.right - 0.5
            ? 'right'
            : popoverRect.right <= anchorRect.left + 0.5
              ? 'left'
              : 'overlap';
    return {
      parentClass: node.parentElement?.className ?? '',
      position: style.position,
      zIndex: style.zIndex,
      mainRect: { left: mainRect.left, top: mainRect.top, right: mainRect.right, bottom: mainRect.bottom },
      popoverRect: { left: popoverRect.left, top: popoverRect.top, right: popoverRect.right, bottom: popoverRect.bottom },
      anchorRect: { left: anchorRect.left, top: anchorRect.top, right: anchorRect.right, bottom: anchorRect.bottom },
      placement,
      belowFits: anchorRect.bottom + 4 + popoverRect.height <= mainRect.bottom,
      popoverInMain: inMain(popoverRect),
      rows,
      full: {
        hitInside: containsHit(fullHit),
        hitLabel: fullHit ? `${fullHit.tagName.toLowerCase()}.${fullHit.className}` : null,
        rect: { left: fullRect.left, top: fullRect.top, right: fullRect.right, bottom: fullRect.bottom },
        inMain: inMain(fullRect),
      },
    };
  });

  expect(geometry.parentClass.split(/\s+/)).toContain('ofd-viewer');
  expect(geometry.position).toBe('fixed');
  expect(Number(geometry.zIndex)).toBeGreaterThan(2);
  expect(geometry.rows).toHaveLength(20);
  expect(geometry.rows.filter((row) => !row.hitInside)).toEqual([]);
  expect(geometry.rows.some((row) => row.text.startsWith('生成时间'))).toBe(true);
  expect(geometry.popoverInMain).toBe(true);
  expect(geometry.full.inMain).toBe(true);
  expect(geometry.full.hitInside).toBe(true);
  if (!geometry.belowFits) {
    expect(['above', 'left', 'right']).toContain(geometry.placement);
  }

  await page.screenshot({ path: resolve(artifacts, 'popover-fixed-900.png'), fullPage: false });

  // 点外关闭并恢复锚点焦点；重新打开后继续验证小视口。
  await page.mouse.click(10, 300);
  await expect(popover).toBeHidden();
  await expect(overlay).toHaveAttribute('aria-expanded', 'false');
  await expect(overlay).toBeFocused();
  await overlay.click();
  await expect(popover).toBeVisible();

  // 小视口下上下都放不下时，浮层限制 max-height，内容区内部滚动，
  // 完整面板按钮仍固定在可视区并可点击。
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.waitForTimeout(150);
  const compact = await popover.evaluate((node) => {
    const main = document.querySelector<HTMLElement>('.ofd-viewer__main')!;
    const mainRect = main.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const body = node.querySelector<HTMLElement>('.ofd-signature-popover__pairs')!;
    const full = node.querySelector<HTMLElement>('[data-ofd-control="signature-popover-full"]')!;
    const fullRect = full.getBoundingClientRect();
    const hit = document.elementFromPoint(
      fullRect.left + fullRect.width / 2,
      fullRect.top + fullRect.height / 2,
    );
    const inMain = (rect: DOMRect): boolean =>
      rect.left >= mainRect.left - 0.5 &&
      rect.right <= mainRect.right + 0.5 &&
      rect.top >= mainRect.top - 0.5 &&
      rect.bottom <= mainRect.bottom + 0.5;
    return {
      popoverInMain: inMain(box),
      bodyScrolls: body.scrollHeight > body.clientHeight,
      fullInMain: inMain(fullRect),
      fullHitInside: hit === full || (hit !== null && node.contains(hit)),
    };
  });
  expect(compact.popoverInMain).toBe(true);
  expect(compact.bodyScrolls).toBe(true);
  expect(compact.fullInMain).toBe(true);
  expect(compact.fullHitInside).toBe(true);
  await page.screenshot({ path: resolve(artifacts, 'popover-maxheight-480.png'), fullPage: false });

  // 360 宽窄屏同样保持浮层/按钮在 main 内，内容区可滚动。
  await page.setViewportSize({ width: 360, height: 480 });
  await page.waitForTimeout(150);
  const narrow = await popover.evaluate((node) => {
    const main = document.querySelector<HTMLElement>('.ofd-viewer__main')!;
    const mainRect = main.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const body = node.querySelector<HTMLElement>('.ofd-signature-popover__pairs')!;
    const full = node.querySelector<HTMLElement>('[data-ofd-control="signature-popover-full"]')!;
    const fullRect = full.getBoundingClientRect();
    const hit = document.elementFromPoint(
      fullRect.left + fullRect.width / 2,
      fullRect.top + fullRect.height / 2,
    );
    const inMain = (rect: DOMRect): boolean =>
      rect.left >= mainRect.left - 0.5 &&
      rect.right <= mainRect.right + 0.5 &&
      rect.top >= mainRect.top - 0.5 &&
      rect.bottom <= mainRect.bottom + 0.5;
    return {
      popoverInMain: inMain(box),
      bodyScrolls: body.scrollHeight > body.clientHeight,
      fullInMain: inMain(fullRect),
      fullHitInside: hit === full || (hit !== null && node.contains(hit)),
      boxRect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      mainRect: { left: mainRect.left, top: mainRect.top, right: mainRect.right, bottom: mainRect.bottom },
      fullRect: { left: fullRect.left, top: fullRect.top, right: fullRect.right, bottom: fullRect.bottom },
    };
  });
  expect(narrow.popoverInMain, JSON.stringify(narrow)).toBe(true);
  expect(narrow.bodyScrolls).toBe(true);
  expect(narrow.fullInMain).toBe(true);
  expect(narrow.fullHitInside).toBe(true);

  writeFileSync(
    resolve(artifacts, 'popover-geometry.json'),
    JSON.stringify({ viewport900: geometry, viewport480: compact, viewport360: narrow }, null, 2),
  );
  await page.screenshot({ path: resolve(artifacts, 'popover-narrow-360.png'), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);

  await popover.locator('[data-ofd-control="signature-popover-full"]').click();
  await expect(page.locator('.ofd-verification-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-verification-panel')).toBeHidden();
  await expectNoPageErrors(page, issues);
});

test('缺失 SignedValue.dat：保留签章列表并降级提示', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.signatureMissing);
  await dismissFindbar(page);
  await page.locator('[data-ofd-control="signatures"]').click();
  const summary = page.locator('.ofd-signature-summary-item');
  await expect(summary).toHaveCount(1);
  await expect(summary.locator('.ofd-signature-badge')).toContainText(/未验证|验证未知|验证无效|验证有效/);

  await summary.click();
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  const text = await dialog.textContent();
  expect(text).toContain('签章信息不完整');
  expect(text).toContain('SignedValue.dat');
  expect(text).not.toMatch(/验证通过|签名有效|验签成功/);

  const state = await viewState(page);
  expect(state.pageCount).toBe(1);
  const warnings = await page.evaluate(() => window.__viewer!.getState().ui.warnings);
  expect(warnings.map((warning) => warning.code)).toContain('W_SIGNATURE_RESOURCE');
  await expectNoPageErrors(page, issues);
});

test('showcase：真实 PNG 印章在详情中解码显示，覆盖层默认无边框', async ({
  page,
  issues,
}) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  await openViewer(page, SHOWCASE, { sidebar: 'signatures', waitForRender: false });
  const overlay = page.locator('.ofd-signature-box[data-signature-id]').first();
  await expect(overlay).toBeVisible();
  const defaultStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  expect(defaultStyle.borderColor).toMatch(/rgba?\(0, 0, 0, 0\)|transparent/);
  expect(defaultStyle.boxShadow).toBe('none');

  const summary = page.locator('.ofd-signature-summary-item').first();
  await expect(summary).toBeVisible();
  await summary.click();
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  const image = dialog.locator('.ofd-seal-image img').first();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('alt', /印章图片：.+/);
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await expect(dialog.locator('.ofd-seal-image__caption')).toContainText('PNG');
  await page.screenshot({ path: resolve(ARTIFACTS, 'showcase-seal-detail.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expectNoPageErrors(page, issues);
});
