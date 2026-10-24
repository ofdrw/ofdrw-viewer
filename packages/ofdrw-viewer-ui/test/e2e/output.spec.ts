/**
 * 打印预览 DOM、真实 Chromium 打印 PDF 页数与图片/ZIP 导出下载。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { expect, expectNoPageErrors, test, type IssueCollector } from './fixtures';
import { FIXTURES, dismissFindbar, openViewer } from './support';

/** 10 页总体验收文档，位于站点样例目录。 */
const SHOWCASE_FIXTURE = '/site/public/samples/ofd-viewer-ui-showcase.ofd';
/** 打印验收产物目录（仓库根 `test/.artifacts/ui-bugfix-20261023/t3/`）。 */
const ARTIFACT_DIR = fileURLToPath(
  new URL('../../../../test/.artifacts/ui-bugfix-20261023/t3/', import.meta.url),
);

interface PrintSnapshot {
  readonly calls: number;
  readonly pages: number;
  readonly pageNumbers: number[];
  readonly imageCount: number;
  readonly css: string;
  readonly rootConnected: boolean;
  readonly revoked: number;
}

/** 挂起打印后从页面读取的完整快照。 */
interface HeldPrintSnapshot extends PrintSnapshot {
  readonly alts: string[];
  readonly sizes: Array<{ width: string; height: string; transform: string }>;
}

/**
 * 在页面内接管 `window.print`：记录打印 DOM 快照并挂起 `afterprint`，
 * 便于在打印 DOM 仍然挂载时用 Chromium 生成 PDF；同时压掉 1s 兜底计时器，
 * 避免打印文档在 PDF 完成前被清理。仅测试侧注入，产品代码无感知。
 *
 * @param page Playwright 页面。
 */
async function installHeldPrint(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globals = window as unknown as {
      __printCalls: number;
      __printSnapshot: HeldPrintSnapshot | null;
      __revoked: number;
      __printRelease: (() => void) | null;
    };
    globals.__printCalls = 0;
    globals.__printSnapshot = null;
    globals.__revoked = 0;
    globals.__printRelease = null;
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      globals.__revoked += 1;
      originalRevoke(url);
    };
    const originalSetTimeout = window.setTimeout.bind(window);
    let suppressFallback = false;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (suppressFallback && timeout === 1000) {
        suppressFallback = false;
        return 0;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
    window.print = () => {
      globals.__printCalls += 1;
      const root = document.querySelector<HTMLElement>('.ofd-print-root');
      const style = document.querySelector<HTMLStyleElement>('style[data-ofd-print-style]');
      const pages = [...document.querySelectorAll<HTMLElement>('.ofd-print-page')];
      globals.__printSnapshot = {
        calls: globals.__printCalls,
        pages: pages.length,
        pageNumbers: pages.map((element) => Number(element.dataset.pageNumber)),
        imageCount: root?.querySelectorAll('img.ofd-print-page__image').length ?? 0,
        css: style?.textContent ?? '',
        rootConnected: root?.isConnected ?? false,
        revoked: globals.__revoked,
        alts: pages.map(
          (element) => element.querySelector<HTMLImageElement>('img')?.alt ?? '',
        ),
        sizes: pages.map((element) => {
          const image = element.querySelector<HTMLImageElement>('img');
          return {
            width: element.style.width,
            height: element.style.height,
            transform: image?.style.transform ?? '',
          };
        }),
      };
      suppressFallback = true;
      globals.__printRelease = () => {
        window.dispatchEvent(new Event('afterprint'));
      };
    };
  });
}

/**
 * 读取挂起的打印快照。
 *
 * @param page Playwright 页面。
 * @returns 打印 DOM 快照。
 */
async function readHeldPrintSnapshot(page: Page): Promise<HeldPrintSnapshot> {
  const snapshot = await page.evaluate(
    () =>
      (window as unknown as { __printSnapshot: HeldPrintSnapshot | null }).__printSnapshot,
  );
  expect(snapshot).not.toBeNull();
  return snapshot!;
}

/**
 * 释放挂起的打印（派发 afterprint）并等待打印流程完成。
 *
 * @param page Playwright 页面。
 */
async function releaseHeldPrint(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __printRelease: (() => void) | null }).__printRelease?.();
  });
  // 打印流程在 finally 中清理 DOM/Object URL 并派发 printend；以此判断已完成。
  await expect
    .poll(() =>
      page.evaluate(() => {
        const events =
          (window as unknown as { __events?: Array<{ type: string }> }).__events ?? [];
        return (
          document.querySelector('.ofd-print-root') === null &&
          document.querySelector('style[data-ofd-print-style]') === null &&
          events.some((event) => event.type === 'printend')
        );
      }),
    )
    .toBe(true);
}

/**
 * 把打印图片绘制到 24×24 白底灰度画布，作为与 PDF 渲染页比对的内容签名。
 *
 * @param page Playwright 页面。
 * @returns 每页灰度签名，按打印 DOM 顺序。
 */
async function capturePrintImageSignatures(page: Page): Promise<number[][]> {
  return page.evaluate(async () => {
    const size = 24;
    const images = [...document.querySelectorAll<HTMLImageElement>('.ofd-print-page__image')];
    const signatures: number[][] = [];
    for (const image of images) {
      await image.decode?.().catch(() => undefined);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建 2D 上下文');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size, size);
      context.drawImage(image, 0, 0, size, size);
      const data = context.getImageData(0, 0, size, size).data;
      const gray: number[] = [];
      for (let index = 0; index < data.length; index += 4) {
        gray.push(
          (data[index]! * 0.299 + data[index + 1]! * 0.587 + data[index + 2]! * 0.114),
        );
      }
      signatures.push(gray);
    }
    return signatures;
  });
}

/**
 * 读取 PDF 页数与页面尺寸。
 *
 * @param pdfPath PDF 路径。
 * @returns 页数与 Page size 文本。
 */
function readPdfInfo(pdfPath: string): { pages: number; pageSize: string } {
  const output = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  writeFileSync(`${pdfPath}.pdfinfo.txt`, output, 'utf8');
  const pages = Number(/^Pages:\s+(\d+)$/m.exec(output)?.[1]);
  const pageSize = /^Page size:\s+(.+)$/m.exec(output)?.[1] ?? '';
  return { pages, pageSize };
}

/**
 * 用 pdfimages -list 统计每页的嵌入图片数量。
 *
 * @param pdfPath PDF 路径。
 * @returns 从第 1 页到最后一页的图片数量；缺失页记 0。
 */
function readPdfImageCounts(pdfPath: string): number[] {
  const output = execFileSync('pdfimages', ['-list', pdfPath], { encoding: 'utf8' });
  writeFileSync(`${pdfPath}.pdfimages.txt`, output, 'utf8');
  const counts = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+\d+\s+/.exec(line);
    if (!match) continue;
    const page = Number(match[1]);
    counts.set(page, (counts.get(page) ?? 0) + 1);
  }
  const maxPage = Math.max(0, ...counts.keys());
  return Array.from({ length: maxPage }, (_, index) => counts.get(index + 1) ?? 0);
}

/**
 * 解析 P5 PGM 字节。
 *
 * @param bytes 文件内容。
 * @returns 宽高与灰度数据。
 */
function parsePgm(bytes: Buffer): { width: number; height: number; data: Buffer } {
  let index = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (
      index < bytes.length &&
      [0x20, 0x0a, 0x0d, 0x09].includes(bytes[index]!)
    ) {
      index += 1;
    }
    if (bytes[index] === 0x23) {
      while (index < bytes.length && bytes[index] !== 0x0a) index += 1;
      continue;
    }
    const start = index;
    while (
      index < bytes.length &&
      ![0x20, 0x0a, 0x0d, 0x09].includes(bytes[index]!)
    ) {
      index += 1;
    }
    if (index === start) break;
    tokens.push(bytes.subarray(start, index).toString('ascii'));
  }
  if (tokens[0] !== 'P5') throw new Error('pdftoppm 未输出 P5 PGM');
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  if (Number(tokens[3]) !== 255) throw new Error('仅支持 8 位 PGM');
  return { width, height, data: bytes.subarray(index + 1) };
}

/**
 * 区域平均缩放灰度图到 24×24，与浏览器画布签名同一尺度。
 *
 * @param pgm 灰度图。
 * @returns 576 个灰度值。
 */
function downsamplePgm(pgm: { width: number; height: number; data: Buffer }): number[] {
  const size = 24;
  const result: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor((x * pgm.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * pgm.width) / size));
      const y0 = Math.floor((y * pgm.height) / size);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * pgm.height) / size));
      let sum = 0;
      let count = 0;
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) {
          sum += pgm.data[py * pgm.width + px]!;
          count += 1;
        }
      }
      result.push(sum / count);
    }
  }
  return result;
}

/** PDF 渲染页的灰度签名与内容占比。 */
interface PdfPageSignature {
  /** 24×24 灰度签名。 */
  readonly signature: number[];
  /** 灰度 < 200 的像素占比；用于排除空白页。 */
  readonly darkRatio: number;
  /** 平均灰度；空白页接近 255。 */
  readonly mean: number;
}

/**
 * 用 pdftoppm 把 PDF 每页渲染为灰度图，生成 24×24 签名与内容占比。
 *
 * @param pdfPath PDF 路径。
 * @param directory PGM 输出目录。
 * @param prefix 输出文件前缀。
 * @returns 按 PDF 页序的页面签名。
 */
function renderPdfSignatures(
  pdfPath: string,
  directory: string,
  prefix: string,
): PdfPageSignature[] {
  const outputPrefix = join(directory, `${prefix}-page`);
  execFileSync('pdftoppm', ['-r', '40', '-gray', pdfPath, outputPrefix]);
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(`${prefix}-page-`) && name.endsWith('.pgm'))
    .sort((left, right) => {
      const leftNumber = Number(/-(\d+)\.pgm$/.exec(left)?.[1]);
      const rightNumber = Number(/-(\d+)\.pgm$/.exec(right)?.[1]);
      return leftNumber - rightNumber;
    });
  if (files.length === 0) throw new Error('pdftoppm 未生成页面图片');
  return files.map((name) => {
    const pgm = parsePgm(readFileSync(join(directory, name)));
    let dark = 0;
    let sum = 0;
    for (const value of pgm.data) {
      sum += value;
      if (value < 200) dark += 1;
    }
    return {
      signature: downsamplePgm(pgm),
      darkRatio: dark / pgm.data.length,
      mean: sum / pgm.data.length,
    };
  });
}

/**
 * 计算两幅同尺寸灰度签名的平均绝对误差。
 *
 * @param left 签名 A。
 * @param right 签名 B。
 * @returns 0..255 的平均绝对误差。
 */
function meanAbsoluteError(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += Math.abs(left[index]! - right[index]!);
  }
  return sum / left.length;
}

test('打印全部页/当前页/自定义范围：默认全部页、调用 window.print 并清理', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  await dismissFindbar(page);

  await page.evaluate(() => {
    const globals = window as unknown as {
      __printCalls: number;
      __printSnapshot: PrintSnapshot | null;
      __revoked: number;
    };
    globals.__printCalls = 0;
    globals.__printSnapshot = null;
    globals.__revoked = 0;
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      globals.__revoked += 1;
      originalRevoke(url);
    };
    window.print = () => {
      globals.__printCalls += 1;
      const root = document.querySelector<HTMLElement>('.ofd-print-root');
      const style = document.querySelector<HTMLStyleElement>('style[data-ofd-print-style]');
      const pages = [...document.querySelectorAll<HTMLElement>('.ofd-print-page')];
      globals.__printSnapshot = {
        calls: globals.__printCalls,
        pages: pages.length,
        pageNumbers: pages.map((element) => Number(element.dataset.pageNumber)),
        imageCount: root?.querySelectorAll('img.ofd-print-page__image').length ?? 0,
        css: style?.textContent ?? '',
        rootConnected: root?.isConnected ?? false,
        revoked: globals.__revoked,
      };
      window.dispatchEvent(new Event('afterprint'));
    };
  });

  // 全部 4 页。
  await page.evaluate(() => window.__viewer!.print({ pages: 'all', dpi: 72 }));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)).toBe(1);
  let snapshot = await page.evaluate(
    () => (window as unknown as { __printSnapshot: PrintSnapshot | null }).__printSnapshot,
  );
  expect(snapshot).not.toBeNull();
  expect(snapshot!.pages).toBe(4);
  expect(snapshot!.pageNumbers).toEqual([1, 2, 3, 4]);
  expect(snapshot!.imageCount).toBe(4);
  expect(snapshot!.rootConnected).toBe(true);
  expect(snapshot!.css).toContain('@page');
  expect(snapshot!.css).toContain('210mm');
  await expect(page.locator('.ofd-print-root')).toHaveCount(0);
  await expect(page.locator('style[data-ofd-print-style]')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __revoked: number }).__revoked),
  ).toBeGreaterThanOrEqual(4);

  // 工具栏打印：默认全部页；取消不触发打印；当前页/自定义范围仍可用。
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  await page.locator('[data-ofd-control="print"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  const defaultRange = page.locator('.ofd-output-form select').first();
  await expect(defaultRange).toHaveValue('all');
  expect(await defaultRange.locator('option:checked').textContent()).toContain('全部页');
  await page.screenshot({ path: join(ARTIFACT_DIR, 'print-dialog-default-all.png') });
  await page.locator('.ofd-dialog__action:not(.ofd-dialog__action--primary)').click();
  await expect(page.locator('.ofd-dialog')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls),
  ).toBe(1);

  // 默认确认：全部 4 页。
  await page.locator('[data-ofd-control="print"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await page.locator('.ofd-dialog__action--primary').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)).toBe(2);
  snapshot = await page.evaluate(
    () => (window as unknown as { __printSnapshot: PrintSnapshot | null }).__printSnapshot,
  );
  expect(snapshot!.pages).toBe(4);
  expect(snapshot!.pageNumbers).toEqual([1, 2, 3, 4]);
  await expect(page.locator('.ofd-print-root')).toHaveCount(0);

  // 当前页：先切到第 3 页，再显式选择 current。
  await page.evaluate(() => window.__viewer!.goToPage(3));
  await expect
    .poll(() => page.evaluate(() => window.__viewer!.getState().view.pageNumber))
    .toBe(3);
  await page.locator('[data-ofd-control="print"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await page.locator('.ofd-output-form select').first().selectOption('current');
  await page.locator('.ofd-dialog__action--primary').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls),
    )
    .toBe(3);
  snapshot = await page.evaluate(
    () => (window as unknown as { __printSnapshot: PrintSnapshot | null }).__printSnapshot,
  );
  expect(snapshot!.pages).toBe(1);
  expect(snapshot!.pageNumbers).toEqual([3]);
  await expect(page.locator('.ofd-print-root')).toHaveCount(0);

  // Enter 提交打印：自定义范围 1-2 不得导航/丢文档，并按范围生成打印 DOM。
  const initialUrl = page.url();
  await page.locator('[data-ofd-control="print"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  const printForm = page.locator('.ofd-output-form');
  await printForm.locator('select').first().selectOption('custom');
  const printRange = printForm.locator('input.ofd-input');
  await printRange.fill('1-2');
  await printRange.press('Enter');
  await expect(page.locator('.ofd-dialog')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls),
    )
    .toBe(4);
  snapshot = await page.evaluate(
    () => (window as unknown as { __printSnapshot: PrintSnapshot | null }).__printSnapshot,
  );
  expect(snapshot!.pages).toBe(2);
  expect(snapshot!.pageNumbers).toEqual([1, 2]);
  expect(page.url()).toBe(initialUrl);
  expect(await page.evaluate(() => window.__viewer!.getPageCount())).toBe(4);
  expect(await page.locator('.ofd-page').count()).toBe(4);

  // Enter 提交导出：同样不导航，并调用 exportImages 处理 1-2 范围。
  await page.evaluate(() => {
    const globals = window as unknown as {
      __exportCalls: number;
      __exportPages: number[] | null;
    };
    globals.__exportCalls = 0;
    globals.__exportPages = null;
    const viewer = window.__viewer as unknown as {
      exportImages(options: { pages?: number[] }): Promise<void>;
    };
    viewer.exportImages = async (options) => {
      globals.__exportCalls += 1;
      globals.__exportPages = options.pages ?? null;
    };
  });
  const exportUrl = page.url();
  await page.locator('[data-ofd-control="export"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  const exportForm = page.locator('.ofd-output-form');
  // 只有打印默认全部页；导出仍保持当前页，公开 API 契约不变。
  await expect(exportForm.locator('select').first()).toHaveValue('current');
  await exportForm.locator('select').first().selectOption('custom');
  const exportRange = exportForm.locator('input.ofd-input');
  await exportRange.fill('1-2');
  await exportRange.press('Enter');
  await expect(page.locator('.ofd-dialog')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __exportCalls: number }).__exportCalls),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __exportPages: number[] | null }).__exportPages,
    ),
  ).toEqual([1, 2]);
  expect(page.url()).toBe(exportUrl);
  expect(await page.evaluate(() => window.__viewer!.getPageCount())).toBe(4);
  expect(await page.locator('.ofd-page').count()).toBe(4);

  // 导出选项对话框可取消，不触发下载。
  await page.locator('[data-ofd-control="export"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  await page.locator('.ofd-dialog__action:not(.ofd-dialog__action--primary)').click();
  await expect(page.locator('.ofd-dialog')).toHaveCount(0);
  await expectNoPageErrors(page, issues);
});

/**
 * 等待页面内 `window.print` 的累计调用次数。
 *
 * @param page Playwright 页面。
 * @param calls 期望的累计次数。
 */
async function expectPrintCalls(page: Page, calls: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls),
    )
    .toBe(calls);
}

/**
 * 走工具栏打印对话框提交打印：保留默认范围（全部页），指定 72 DPI 与白底，
 * 以便 Chromium 生成与打印 DOM 一致的 PDF。
 *
 * @param page Playwright 页面。
 */
async function submitPrintDialog(page: Page): Promise<void> {
  await page.locator('[data-ofd-control="print"]').click();
  await expect(page.locator('.ofd-dialog')).toBeVisible();
  const form = page.locator('.ofd-output-form');
  await expect(form.locator('select').first()).toHaveValue('all');
  const dpi = form.locator('select').nth(1);
  await dpi.selectOption('72');
  await expect(dpi).toHaveValue('72');
  await form.locator('input[type="checkbox"]').check();
  await page.locator('.ofd-dialog__action--primary').click();
}

/**
 * 执行一次打印（默认全部页），在打印 DOM 挂载期间由 Chromium 生成 PDF，
 * 再用 pdfinfo/pdfimages/pdftoppm 验证页数、图片与内容顺序，最后释放打印并检查清理。
 *
 * @param page Playwright 页面。
 * @param pdfCase 文档夹具与期望页数。
 */
async function verifyPrintPdf(
  page: Page,
  issues: IssueCollector,
  pdfCase: { readonly name: string; readonly fixture: string; readonly pageCount: number },
): Promise<void> {
  // 10 页文档在内存紧张时准备/生成 PDF 可能超过默认 60s，留出稳定余量。
  test.setTimeout(120_000);
  await openViewer(page, pdfCase.fixture);
  await dismissFindbar(page);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  await installHeldPrint(page);
  let released = false;
  try {
    await submitPrintDialog(page);
    await expectPrintCalls(page, 1);
    const snapshot = await readHeldPrintSnapshot(page);
    const expectedPages = Array.from(
      { length: pdfCase.pageCount },
      (_, index) => index + 1,
    );
    expect(snapshot.pages).toBe(pdfCase.pageCount);
    expect(snapshot.pageNumbers).toEqual(expectedPages);
    expect(snapshot.imageCount).toBe(pdfCase.pageCount);
    expect(snapshot.alts).toEqual(expectedPages.map((number) => `第 ${number} 页`));
    expect(snapshot.rootConnected).toBe(true);
    expect(snapshot.css).toContain('@page { size: 210mm 297mm; margin: 0; }');
    expect(snapshot.css).toContain('break-after: page');
    expect(snapshot.css).toContain('page-break-after: always');
    writeFileSync(
      join(ARTIFACT_DIR, `${pdfCase.name}-print-dom.json`),
      JSON.stringify(snapshot, null, 2),
    );

    const signatures = await capturePrintImageSignatures(page);
    expect(signatures).toHaveLength(pdfCase.pageCount);

    const pdfPath = join(ARTIFACT_DIR, `${pdfCase.name}-all.pdf`);
    await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });

    const info = readPdfInfo(pdfPath);
    expect(info.pages).toBe(pdfCase.pageCount);
    // Chrome 的 A4 页面尺寸会做 1/300 英寸级取整，按 A4 标称值容差校验。
    const sizeMatch = /([\d.]+) x ([\d.]+) pts \(A4\)/.exec(info.pageSize);
    expect(sizeMatch, info.pageSize).not.toBeNull();
    expect(Math.abs(Number(sizeMatch![1]) - 595.276)).toBeLessThan(1);
    expect(Math.abs(Number(sizeMatch![2]) - 841.89)).toBeLessThan(1);
    const imageCounts = readPdfImageCounts(pdfPath);
    // 每个 PDF 页恰好一张整页图片，既不丢页也没有额外空白页。
    expect(imageCounts).toEqual(expectedPages.map(() => 1));

    const pdfPages = renderPdfSignatures(pdfPath, ARTIFACT_DIR, pdfCase.name);
    expect(pdfPages).toHaveLength(pdfCase.pageCount);
    for (const pdfPage of pdfPages) {
      expect(pdfPage.darkRatio).toBeGreaterThan(0.0005);
      expect(pdfPage.mean).toBeLessThan(254.5);
    }
    const pdfSignatures = pdfPages.map((pdfPage) => pdfPage.signature);
    const matrix = signatures.map((target) =>
      pdfSignatures.map((candidate) => Number(meanAbsoluteError(target, candidate).toFixed(3))),
    );
    const bestMatches = matrix.map((row) => row.indexOf(Math.min(...row)));
    writeFileSync(
      join(ARTIFACT_DIR, `${pdfCase.name}-signature-match.json`),
      JSON.stringify({ matrix, bestMatches }, null, 2),
    );
    // 对角签名与对应 PDF 页一致；允许文档内重复页（如 showcase 第 2/5 页内容相同）
    // 造成 argmin 并列，但要求对角 MAE 与行最小值几乎相同，排除整体错位/丢页。
    for (let index = 0; index < matrix.length; index += 1) {
      const diagonal = matrix[index]![index]!;
      expect(diagonal).toBeLessThan(8);
      expect(diagonal).toBeLessThanOrEqual(Math.min(...matrix[index]!) + 0.05);
    }

    await releaseHeldPrint(page);
    released = true;
    const finalState = await page.evaluate(() => {
      const globals = window as unknown as { __printCalls: number; __revoked: number };
      const events =
        (window as unknown as {
          __events?: Array<{ type: string; detail?: { current?: number } }>;
        }).__events ?? [];
      return {
        calls: globals.__printCalls,
        revoked: globals.__revoked,
        printstart: events.filter((event) => event.type === 'printstart').length,
        printend: events.filter((event) => event.type === 'printend').length,
        progress: events
          .filter((event) => event.type === 'printprogress')
          .map((event) => event.detail?.current),
        errorToasts: document.querySelectorAll('.ofd-toast[data-level="error"]').length,
      };
    });
    expect(finalState).toEqual({
      calls: 1,
      revoked: pdfCase.pageCount,
      printstart: 1,
      printend: 1,
      progress: expectedPages,
      errorToasts: 0,
    });
    await expect(page.locator('.ofd-print-root')).toHaveCount(0);
    await expect(page.locator('style[data-ofd-print-style]')).toHaveCount(0);
    await expectNoPageErrors(page, issues);
  } finally {
    if (!released) {
      await releaseHeldPrint(page).catch(() => undefined);
    }
  }
}

// Chromium 的 printToPDF 与 Playwright trace 资源回收存在竞态，输出用例关闭 trace。
test.use({ trace: 'off' });

for (const pdfCase of [
  { name: 'showcase-10p', fixture: SHOWCASE_FIXTURE, pageCount: 10 },
  { name: 'multi-4p', fixture: FIXTURES.multi, pageCount: 4 },
] as const) {
  test(`Chromium 打印媒体 PDF：${pdfCase.name} 输出 ${pdfCase.pageCount} 页且内容顺序正确`, async ({
    page,
    issues,
  }) => {
    await verifyPrintPdf(page, issues, pdfCase);
  });
}

test('导出选项：OFD 原文件隐藏图片字段，下载保持原始字节', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  await dismissFindbar(page);
  await page.locator('[data-ofd-control="export"]').click();
  const dialog = page.locator('.ofd-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('导出选项');
  const format = dialog.locator('[data-ofd-control="output-format"]');
  await expect(format.locator('option')).toHaveCount(4);
  await format.selectOption('ofd');
  await expect(dialog.locator('[data-ofd-control="output-ofd-note"]')).toBeVisible();
  await expect(dialog.locator('[data-ofd-control="output-ofd-note"]')).toContainText('OFD 原文件');
  await expect(dialog.locator('input[type="range"]')).toBeHidden();
  await expect(dialog.locator('.ofd-output-field').nth(2)).toBeHidden();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    dialog.locator('.ofd-dialog__action--primary').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.ofd$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = readFileSync(path!);
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  await expectNoPageErrors(page, issues);
});

test('加密文档导出 OFD 原文件：导出原始加密包而非解密内容', async ({ page, issues }) => {
  const fixture = fileURLToPath(
    new URL('../../../ofdrw-viewer-crypto/test/fixtures/crypto/password-encrypted.ofd', import.meta.url),
  );
  const original = readFileSync(fixture);
  await openViewer(page, FIXTURES.cryptoPassword, { password: 'FixturePass123' });
  await dismissFindbar(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.evaluate(() => window.__viewer!.exportOfd({ filename: 'encrypted-original' })),
  ]);
  expect(download.suggestedFilename()).toBe('encrypted-original.ofd');
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(readFileSync(path!)).toEqual(original);
  await expectNoPageErrors(page, issues);
});

test('单页 JPEG 与多页 ZIP 导出下载', async ({ page, issues }) => {
  await openViewer(page, FIXTURES.multi);
  await dismissFindbar(page);

  const [single] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.evaluate(() =>
      window.__viewer!.exportImage({ page: 1, format: 'jpeg', dpi: 72, filename: 'e2e-cover' }),
    ),
  ]);
  expect(single.suggestedFilename()).toBe('e2e-cover.jpg');
  const singlePath = await single.path();
  expect(singlePath).not.toBeNull();
  const bytes = readFileSync(singlePath!);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  const [zipDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.evaluate(() =>
      window.__viewer!.exportImages({
        pages: [1, 2, 3],
        format: 'png',
        filename: 'e2e-pack',
        dpi: 72,
        zipFilename: 'e2e-pack',
      }),
    ),
  ]);
  expect(zipDownload.suggestedFilename()).toBe('e2e-pack.zip');
  const zipPath = await zipDownload.path();
  expect(zipPath).not.toBeNull();
  const zip = unzipSync(readFileSync(zipPath!));
  const names = Object.keys(zip).sort();
  expect(names).toEqual(['e2e-pack-p1.png', 'e2e-pack-p2.png', 'e2e-pack-p3.png']);
  for (const name of names) {
    const entry = zip[name]!;
    expect(entry.length).toBeGreaterThan(1000);
    expect([...entry.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  await expectNoPageErrors(page, issues);
});
