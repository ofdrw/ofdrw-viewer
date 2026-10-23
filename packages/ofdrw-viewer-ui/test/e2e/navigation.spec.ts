/**
 * 缩略图、大纲与书签导航。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { expect, expectNoPageErrors, test } from './fixtures';
import { FIXTURES, openViewer, viewState } from './support';

/** 大纲核验产物目录（仓库根 t4）。 */
const ARTIFACT_DIR = fileURLToPath(
  new URL('../../../../test/.artifacts/ui-bugfix-20261023/t4/', import.meta.url),
);

/** 多级大纲夹具的浏览器 URL 与磁盘路径。 */
const MULTI_LEVEL_URL = '/test/.artifacts/ui-bugfix-20261023/t4/outline-multilevel.ofd';
const MULTI_LEVEL_FILE = join(ARTIFACT_DIR, 'outline-multilevel.ofd');

/** XML 声明。 */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
/** OFD 命名空间。 */
const OFD_NS = 'xmlns:ofd="http://www.ofdspec.org/2016"';

/** 生成 Dest 元素。 */
function dest(type: string, pageId: number, extra = ''): string {
  return `<ofd:Dest Type="${type}" PageID="${pageId}"${extra}/>`;
}

/** 生成 Goto 动作。 */
function goto(target: string): string {
  return `<ofd:Actions><ofd:Action Event="CLICK"><ofd:Goto>${target}</ofd:Goto></ofd:Action></ofd:Actions>`;
}

/** 生成大纲节点。 */
function outlineElem(
  title: string,
  options: { expanded?: boolean; target?: string; children?: readonly string[] } = {},
): string {
  const expanded =
    options.expanded === undefined ? '' : ` Expanded="${options.expanded ? 'true' : 'false'}"`;
  const action = options.target ? goto(options.target) : '';
  return `<ofd:OutlineElem Title="${title}"${expanded}>${action}${(options.children ?? []).join('')}</ofd:OutlineElem>`;
}

/**
 * 生成 4 级大纲 OFD 夹具（运行时写入 t4 产物目录，不修改 showcase）。
 *
 * @returns 可在 E2E 中打开的 URL。
 */
function ensureMultiLevelOutlineFixture(): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const encode = (text: string) => new TextEncoder().encode(text);
  const pageIds = [1, 2, 3, 4];
  const files: Record<string, Uint8Array> = {
    'OFD.xml': encode(
      `${XML_HEADER}<ofd:OFD ${OFD_NS} DocType="ofd" Version="1.1"><ofd:DocBody><ofd:DocInfo><ofd:DocID>e2e-outline-multilevel</ofd:DocID><ofd:Title>多级大纲夹具</ofd:Title></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
    ),
  };
  for (const pageId of pageIds) {
    files[`Doc_0/Pages/Page_${pageId}/Content.xml`] = encode(
      `${XML_HEADER}<ofd:Page ${OFD_NS}><ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area><ofd:Content><ofd:Layer ID="1"/></ofd:Content></ofd:Page>`,
    );
  }
  const pages = pageIds
    .map((pageId) => `<ofd:Page ID="${pageId}" BaseLoc="Pages/Page_${pageId}/Content.xml"/>`)
    .join('');
  const level4 = outlineElem('1.1.1.1 缩略语', { target: dest('Fit', 3) });
  const level3 = [
    outlineElem('1.1.1 术语定义', {
      target: dest('FitH', 2, ' Top="10"'),
      children: [level4],
    }),
    outlineElem('1.1.2 研究范围', { target: dest('Fit', 3) }),
  ];
  const level2 = [
    outlineElem('1.1 研究背景', {
      target: '<ofd:Bookmark>背景书签</ofd:Bookmark>',
      children: level3,
    }),
    outlineElem('1.2 研究方法', { target: dest('FitV', 4, ' Left="10"') }),
  ];
  const outlines = [
    outlineElem('第一章 概述', {
      expanded: true,
      target: dest('XYZ', 1),
      children: level2,
    }),
    outlineElem('第二章 结论', { target: dest('Fit', 4) }),
  ];
  files['Doc_0/Document.xml'] = encode(
    `${XML_HEADER}<ofd:Document ${OFD_NS} Version="1.1"><ofd:CommonData><ofd:MaxUnitID>10</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData><ofd:Pages>${pages}</ofd:Pages><ofd:Bookmarks><ofd:Bookmark Name="背景书签">${dest('Fit', 2)}</ofd:Bookmark></ofd:Bookmarks><ofd:Outlines>${outlines.join('')}</ofd:Outlines></ofd:Document>`,
  );
  writeFileSync(MULTI_LEVEL_FILE, zipSync(files, { level: 0 }));
  return MULTI_LEVEL_URL;
}

test('缩略图与大纲跳转保持当前页高亮', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  // 用工具栏打开侧栏，确保焦点进入侧栏并验证关闭后的焦点恢复。
  await page.locator('[data-ofd-control="sidebar"]').click();
  await expect(page.locator('.ofd-viewer__sidebar')).toBeVisible();
  await expect(page.locator('.ofd-sidebar__tab[data-view="thumbnails"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.ofd-thumbnail')).toHaveCount(4);

  await page.locator('.ofd-thumbnail[data-page="4"]').click();
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(4);
  await expect(page.locator('.ofd-page[data-page-number="4"]')).toHaveAttribute('data-current', 'true');
  await expect(page.locator('.ofd-thumbnail[data-page="4"]')).toHaveAttribute('aria-selected', 'true');

  await page.locator('.ofd-sidebar__tab[data-view="outline"]').click();
  const outlineTitles = page.locator('.ofd-outline__title');
  await expect(outlineTitles.first()).toBeVisible();
  expect(await outlineTitles.count()).toBeGreaterThan(0);
  await outlineTitles.filter({ hasText: '3、一对多' }).click();
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(3);
  await expect(page.locator('.ofd-page[data-page-number="3"]')).toHaveAttribute('data-current', 'true');

  // 关闭侧栏后工具栏状态同步；焦点恢复在移动抽屉场景单独验证。
  await page.keyboard.press('Escape');
  await expect(page.locator('.ofd-viewer__sidebar')).toBeHidden();
  await expect(page.locator('[data-ofd-control="sidebar"]')).toHaveAttribute('aria-expanded', 'false');
  await expectNoPageErrors(page, issues);
});

test('书签跳转回目标页', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.bookmarks);
  await page.evaluate(() => window.__viewer!.goToPage(5));
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(5);

  await page.evaluate(() => window.__viewer!.openSidebar('bookmarks'));
  const bookmark = page.locator('.ofd-bookmark');
  await expect(bookmark).toHaveCount(1);
  await expect(bookmark).toContainText('新建书签');
  await bookmark.click();
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(1);
  await expect(page.locator('.ofd-page[data-page-number="1"]')).toHaveAttribute('data-current', 'true');
  await expectNoPageErrors(page, issues);
});

test('多级大纲树：aria-level 1-4、嵌套 role=group、逐层展开、第四级跳转与截图', async ({
  page,
  issues,
}) => {
  const fixture = ensureMultiLevelOutlineFixture();
  await openViewer(page, fixture);
  await page.locator('[data-ofd-control="sidebar"]').click();
  await page.locator('.ofd-sidebar__tab[data-view="outline"]').click();

  const tree = page.locator('.ofd-outline__tree');
  await expect(tree).toHaveAttribute('role', 'tree');
  const level1 = tree.locator('li[role="treeitem"][aria-level="1"]');
  await expect(level1).toHaveCount(2);
  await expect(level1.first()).toHaveAttribute('aria-expanded', 'true');
  const group1 = tree.locator('ul[role="group"]').first();
  await expect(group1).toBeVisible();

  const level2 = group1.locator('li[role="treeitem"][aria-level="2"]');
  await expect(level2).toHaveCount(2);
  await expect(level2.first()).toHaveAttribute('aria-expanded', 'false');
  const group2 = group1.locator('ul[role="group"]').first();
  await expect(group2).toBeHidden();

  // 逐层展开到第三、第四级。
  await level2.first().locator('.ofd-outline__toggle').first().click();
  await expect(group2).toBeVisible();
  const level3 = group2.locator('li[role="treeitem"][aria-level="3"]');
  await expect(level3).toHaveCount(2);
  const group3 = group2.locator('ul[role="group"]').first();
  await expect(group3).toBeHidden();
  await level3.first().locator('.ofd-outline__toggle').first().click();
  await expect(group3).toBeVisible();
  const level4 = group3.locator('li[role="treeitem"][aria-level="4"]');
  await expect(level4).toHaveCount(1);
  await expect(level4.locator('.ofd-outline__title')).toHaveText('1.1.1.1 缩略语');

  // 截图证据：1-4 级同时可见（t4 产物目录）。
  await page.screenshot({
    path: join(ARTIFACT_DIR, 'nav-outline-multilevel-expanded.png'),
  });

  await level4.locator('.ofd-outline__title').click();
  await expect.poll(async () => (await viewState(page)).pageNumber).toBe(3);
  await expect(page.locator('.ofd-page[data-page-number="3"]')).toHaveAttribute(
    'data-current',
    'true',
  );

  // 收起第一层后整棵子树隐藏，aria-expanded 同步。
  await level1.first().locator('.ofd-outline__toggle').first().click();
  await expect(group1).toBeHidden();
  await expect(level1.first()).toHaveAttribute('aria-expanded', 'false');
  await expectNoPageErrors(page, issues);
});
