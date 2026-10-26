/**
 * 附件侧栏卡片化验收。
 *
 * 覆盖：文件类型图标、图标下载按钮（hover 展开文字）、导出全部的边框与 hover，
 * 以及窄屏下卡片不溢出。
 */
import type { Page } from '@playwright/test';
import { expect, expectNoPageErrors, test } from './fixtures';
import { openViewer } from './support';

/** 含附件的真实样本（附件名 `Gao` 不含扩展名，图标回退为通用文件）。 */
const ATTACHMENT_DOC = '/ofd_pdf_match/AddAttachment.ofd';

/** 打开附件侧栏。 */
async function openAttachments(page: Page): Promise<void> {
  await openViewer(page, ATTACHMENT_DOC, { sidebar: 'attachments', waitForRender: false });
  await expect(page.locator('.ofd-attachment').first()).toBeVisible();
}

test('附件卡片：文件类型图标、图标下载按钮与 hover 展开文字', async ({ page, issues }) => {
  await openAttachments(page);
  const card = page.locator('.ofd-attachment').first();
  const computed = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    const icon = element.querySelector<HTMLElement>('.ofd-attachment__icon');
    return {
      display: style.display,
      radius: Number.parseFloat(style.borderTopLeftRadius),
      border: Number.parseFloat(style.borderTopWidth),
      background: style.backgroundColor,
      kind: icon?.dataset.kind ?? null,
      iconSvg: icon?.querySelector('svg') !== null,
    };
  });
  expect(computed.display).toBe('flex');
  expect(computed.radius).toBeGreaterThan(0);
  expect(computed.border).toBeGreaterThan(0);
  expect(computed.background).not.toBe('rgba(0, 0, 0, 0)');
  // 附件名不含扩展名、XML 也未声明 Format，图标回退为通用文件。
  expect(computed.kind).toBe('other');
  expect(computed.iconSvg).toBe(true);

  const download = card.locator('.ofd-attachment__download');
  await expect(download.locator('svg')).toHaveCount(1);
  await expect(download).toHaveAttribute('aria-label', /下载附件/);
  // 纯图标按钮：不含文字，避免挤压卡片正文；hover 只反馈配色。
  await expect(download).toHaveText('');
  await page.mouse.move(0, 0);
  const baseColor = await download.evaluate((el) => getComputedStyle(el).borderColor);
  await download.hover();
  await expect
    .poll(() => download.evaluate((el) => getComputedStyle(el).borderColor))
    .not.toBe(baseColor);

  // 单附件下载仍可触发真实下载。
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    download.click(),
  ]);
  expect(file.suggestedFilename()).toContain('Gao');
  await expectNoPageErrors(page, issues);
});

test('导出全部：有边框，hover 有明确反馈', async ({ page, issues }) => {
  await openAttachments(page);
  const exportButton = page.locator('.ofd-attachments__export');
  await expect(exportButton).toBeVisible();
  await expect(exportButton).toContainText('导出全部');
  await expect(exportButton.locator('svg')).toHaveCount(1);
  await page.mouse.move(0, 0);
  const base = await exportButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      border: Number.parseFloat(style.borderTopWidth),
      borderColor: style.borderColor,
      color: style.color,
      background: style.backgroundColor,
    };
  });
  expect(base.border).toBeGreaterThan(0);
  await exportButton.hover();
  await expect
    .poll(() =>
      exportButton.evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .not.toBe(base.background);
  const hoverColor = await exportButton.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  expect(hoverColor).not.toBe(base.borderColor);

  const [zip] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    exportButton.click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/attachments\.zip$/);
  await expectNoPageErrors(page, issues);
});

test('附件卡片在窄屏侧栏内不溢出', async ({ page, issues }) => {
  await openAttachments(page);
  const panel = page.locator('.ofd-sidebar__panel:not([hidden])');
  await page.setViewportSize({ width: 360, height: 720 });
  const overflow = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const inside = [...element.querySelectorAll<HTMLElement>('.ofd-attachment')].every(
      (card) => {
        const cardRect = card.getBoundingClientRect();
        return cardRect.right <= rect.right + 1 && cardRect.left >= rect.left - 1;
      },
    );
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, inside };
  });
  expect(overflow.inside).toBe(true);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  await expectNoPageErrors(page, issues);
});
