/**
 * 版式矩阵：2 种滚动方式 × 2 种视图模式，覆盖滚动、翻页与缩放。
 *
 * 同时回归以下用户报告的问题：
 * - 水平滚动拖到最后一页再往回拖会闪烁；
 * - 垂直滚动拖到最顶部被弹回、反复弹；
 * - 双页缩放倍率小时页面不水平居中；
 * - 双页水平滚动到底后无法回到第一页；
 * - 双页视图垂直滚动被弹回、无法滚动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { open: engineMocks.open },
    OFDError: class extends Error {},
    isOFDError: () => false,
    toOFDError: (error: unknown) => error,
  };
});

import { OFDViewer } from '../../../src/viewer';
import type { LayoutConfig, PageLayout } from '../../../src/page-layout';

/** 引擎文档替身：6 页 A4（双页恰好 3 组）。 */
function makeDocument(): unknown {
  const infos: PageInfo[] = Array.from({ length: 6 }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
  return {
    pageCount: 6,
    getPageInfos: async () => infos,
    getPage: async (index: number) => ({
      index,
      getSize: () => ({ width: 210, height: 297 }),
      getViewport: () => ({ width: 794, height: 1123 }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => ({ items: [], chars: [] }),
      exportImage: async () => {
        throw new Error('not implemented');
      },
    }),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount: 6 }),
    getPermissions: async () => ({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    }),
    getSignatureEntries: async () => [],
    getSignedValue: async () => undefined,
    close: async () => undefined,
  };
}

/** 打包最小 OFD。 */
function buildOfd(): ArrayBuffer {
  const bytes = zipSync({
    'OFD.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0" DocType="OFD">' +
        '<ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>',
    ),
    'Doc_0/Document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"/>',
    ),
  });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 读取内部排版对象。 */
function layoutOf(viewer: OFDViewer): PageLayout {
  return (viewer as unknown as { layout: PageLayout }).layout;
}

/** 内部方法句柄（测试用）。 */
interface Internals {
  handleScroll(): void;
  snapToNearestGroup(): void;
  viewportExtent(): number;
  viewportWidth(): number;
}

/** 读取内部方法。 */
function internalsOf(viewer: OFDViewer): Internals {
  return viewer as unknown as Internals;
}

/** 设置主区域尺寸（jsdom 没有布局，需要显式桩住）。 */
function stubViewport(viewer: OFDViewer, width: number, height: number): HTMLElement {
  const main = viewer.getElements().main;
  Object.defineProperty(main, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(main, 'clientHeight', { configurable: true, get: () => height });
  return main;
}

/** 创建阅读器并设置视口尺寸。 */
async function createViewer(
  layout: LayoutConfig,
  viewport = { width: 1000, height: 800 },
): Promise<{ viewer: OFDViewer; main: HTMLElement }> {
  const viewer = new OFDViewer({
    crypto: { enabled: false },
    container: document.body,
    source: buildOfd(),
    layout,
  });
  await viewer.ready;
  const main = stubViewport(viewer, viewport.width, viewport.height);
  layoutOf(viewer).setViewport(viewport.width, viewport.height);
  (viewer as unknown as { reflow: () => void }).reflow();
  return { viewer, main };
}

/** 沿滚动方向的滚动位置。 */
function posOf(viewer: OFDViewer, horizontal: boolean): number {
  const main = viewer.getElements().main;
  return horizontal ? main.scrollLeft : main.scrollTop;
}

/** 设置沿滚动方向的滚动位置并触发滚动处理。 */
function scrollTo(viewer: OFDViewer, value: number, horizontal: boolean): void {
  const main = viewer.getElements().main;
  if (horizontal) main.scrollLeft = value;
  else main.scrollTop = value;
  internalsOf(viewer).handleScroll();
}

/**
 * 滚到最底部：按浏览器行为钳制到最大可滚动位置后写入。
 *
 * jsdom 不做布局，`scrollTop = 1e9` 不会被夹紧，必须按内容长度与视口尺寸自行计算。
 */
function scrollToBottom(viewer: OFDViewer, horizontal: boolean): number {
  const main = viewer.getElements().main;
  const viewport = horizontal ? main.clientWidth : main.clientHeight;
  const max = Math.max(0, contentExtent(viewer, horizontal) - viewport);
  scrollTo(viewer, max, horizontal);
  return max;
}

/** 滚动内容沿滚动方向的长度。 */
function contentExtent(viewer: OFDViewer, horizontal: boolean): number {
  const layout = layoutOf(viewer);
  return horizontal ? layout.totalWidth : layout.totalHeight;
}

beforeEach(() => {
  document.body.innerHTML = '';
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => makeDocument());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** 四种组合。 */
const MATRIX: ReadonlyArray<readonly [string, LayoutConfig]> = [
  ['页面滚动 + 单页', { direction: 'page', viewMode: 'single' }],
  ['页面滚动 + 双页', { direction: 'page', viewMode: 'spread' }],
  ['水平滚动 + 单页', { direction: 'horizontal', viewMode: 'single' }],
  ['水平滚动 + 双页', { direction: 'horizontal', viewMode: 'spread' }],
];

describe.each(MATRIX)('%s：滚动', (_name, config) => {
  const horizontal = config.direction === 'horizontal';

  it('内容长度覆盖全部页面并可滚动', async () => {
    const { viewer } = await createViewer(config);
    const layout = layoutOf(viewer);
    const extent = contentExtent(viewer, horizontal);
    const last = layout.getBoxes()[layout.pageCount - 1]!;
    const lastEnd = horizontal ? last.left + last.width : last.top + last.height;
    expect(extent).toBeGreaterThanOrEqual(lastEnd);
    // 首尾都有留白，滚动范围不为负。
    expect(extent).toBeGreaterThan(0);
    await viewer.destroy();
  });

  it('最后一组能贴齐视口起点（末端留足一屏）', async () => {
    const { viewer, main } = await createViewer(config);
    const layout = layoutOf(viewer);
    const groups = layout.groupCount;
    const lastGroupStart = layout.groupRangeOf((groups - 1) * layout.columns).start;
    const head = layout.getBox(lastGroupStart)!;
    const target = horizontal ? head.left : head.top;
    const viewport = horizontal ? main.clientWidth : main.clientHeight;
    // 滚动到底时，最后一组起点应能到达（不被内容长度夹住）。
    expect(contentExtent(viewer, horizontal) - viewport).toBeGreaterThanOrEqual(target);
    await viewer.destroy();
  });

  it('滚到底后页码为最后一组，且不再被弹回', async () => {
    const { viewer } = await createViewer(config);
    const layout = layoutOf(viewer);
    // 模拟用户滚到最底。
    scrollToBottom(viewer, horizontal);
    const pageAtBottom = viewer.getState().view.pageNumber;
    const lastGroup = layout.groupRangeOf(layout.pageCount - 1).start + 1;
    expect(pageAtBottom).toBe(lastGroup);
    // 吸附后位置不能发生大幅回弹（回弹会把用户拉离底部）。
    const before = posOf(viewer, horizontal);
    internalsOf(viewer).snapToNearestGroup();
    const after = posOf(viewer, horizontal);
    expect(Math.abs(after - before)).toBeLessThan(1);
    await viewer.destroy();
  });

  it('拖到最顶部不会被弹回', async () => {
    const { viewer } = await createViewer(config);
    scrollTo(viewer, 0, horizontal);
    expect(posOf(viewer, horizontal)).toBe(0);
    internalsOf(viewer).snapToNearestGroup();
    // 顶部已是第一组起点，吸附不应移动位置（回弹反复的根因）。
    expect(posOf(viewer, horizontal)).toBe(0);
    expect(viewer.getState().view.pageNumber).toBe(1);
    await viewer.destroy();
  });

  it('从底部往回滚动能回到第一页', async () => {
    const { viewer } = await createViewer(config);
    scrollToBottom(viewer, horizontal);
    scrollTo(viewer, 0, horizontal);
    internalsOf(viewer).snapToNearestGroup();
    expect(viewer.getState().view.pageNumber).toBe(1);
    expect(posOf(viewer, horizontal)).toBe(0);
    await viewer.destroy();
  });

  it('吸附不产生回环（位置不变时不再写滚动）', async () => {
    const { viewer } = await createViewer(config);
    const layout = layoutOf(viewer);
    // 停在第一组起点：连续吸附不应改变位置。
    const start = layout.getBox(0)!;
    scrollTo(viewer, horizontal ? start.left : start.top, horizontal);
    const before = posOf(viewer, horizontal);
    for (let index = 0; index < 5; index += 1) internalsOf(viewer).snapToNearestGroup();
    expect(posOf(viewer, horizontal)).toBe(before);
    await viewer.destroy();
  });

  it('滚动中间位置时页码跟随所在组', async () => {
    const { viewer } = await createViewer(config);
    const layout = layoutOf(viewer);
    const groupStart = layout.groupRangeOf(layout.columns).start; // 第 2 组
    const head = layout.getBox(groupStart)!;
    scrollTo(viewer, horizontal ? head.left : head.top, horizontal);
    expect(viewer.getState().view.pageNumber).toBe(groupStart + 1);
    await viewer.destroy();
  });
});

describe.each(MATRIX)('%s：缩放', (_name, config) => {
  const horizontal = config.direction === 'horizontal';

  it('缩放改变页盒尺寸（页面与组内间隔同步）', async () => {
    const { viewer } = await createViewer(config);
    viewer.setZoomMode('page-actual');
    viewer.setScale(1);
    const before = layoutOf(viewer).getBoxes()[0]!.width;
    viewer.setScale(2);
    const after = layoutOf(viewer).getBoxes()[0]!.width;
    expect(after).toBeCloseTo(before * 2, -1);
    expect(viewer.getState().view.scale).toBe(2);
    await viewer.destroy();
  });

  it('放大后仍可滚动到最后一组并回到第一页', async () => {
    const { viewer } = await createViewer(config);
    viewer.setZoomMode('page-actual');
    viewer.setScale(2);
    scrollToBottom(viewer, horizontal);
    const layout = layoutOf(viewer);
    expect(viewer.getState().view.pageNumber).toBe(
      layout.groupRangeOf(layout.pageCount - 1).start + 1,
    );
    scrollTo(viewer, 0, horizontal);
    internalsOf(viewer).snapToNearestGroup();
    expect(viewer.getState().view.pageNumber).toBe(1);
    await viewer.destroy();
  });

  it('缩放后内容长度按倍率增长', async () => {
    const { viewer } = await createViewer(config);
    viewer.setZoomMode('page-actual');
    viewer.setScale(1);
    const before = contentExtent(viewer, horizontal);
    viewer.setScale(2);
    const after = contentExtent(viewer, horizontal);
    expect(after).toBeGreaterThan(before * 1.8);
    await viewer.destroy();
  });

  it('缩小后内容仍覆盖全部页面', async () => {
    const { viewer } = await createViewer(config);
    viewer.setZoomMode('page-actual');
    viewer.setScale(0.5);
    const layout = layoutOf(viewer);
    const extent = contentExtent(viewer, horizontal);
    const last = layout.getBoxes()[layout.pageCount - 1]!;
    const lastEnd = horizontal ? last.left + last.width : last.top + last.height;
    expect(extent).toBeGreaterThanOrEqual(lastEnd);
    await viewer.destroy();
  });
});

describe('双页模式：小倍率下水平居中', () => {
  it('纵向滚动时整组在视口中左右对称居中', async () => {
    const viewport = { width: 1400, height: 1000 };
    const { viewer } = await createViewer(
      { direction: 'page', viewMode: 'spread' },
      viewport,
    );
    viewer.setZoomMode('page-actual');
    viewer.setScale(0.3);
    const layout = layoutOf(viewer);
    const [first, second] = layout.getBoxes();
    // 内容（含留白）窄于视口：应有正的居中偏移。
    const offset = layout.centeredOffset(viewport.width);
    expect(offset).toBeGreaterThan(0);
    const leftGap = offset + first!.left;
    const rightGap = viewport.width - (offset + second!.left + second!.width);
    // 允许设备像素对齐带来的 2px 内误差。
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);
    await viewer.destroy();
  });

  it('水平滚动时整组在视口中垂直居中', async () => {
    const viewport = { width: 1400, height: 1000 };
    const { viewer } = await createViewer(
      { direction: 'horizontal', viewMode: 'spread' },
      viewport,
    );
    viewer.setZoomMode('page-actual');
    viewer.setScale(0.3);
    const layout = layoutOf(viewer);
    // 内容矮于视口时给出垂直居中偏移。
    expect(layout.verticalCenteredOffset(viewport.height)).toBeGreaterThan(0);
    await viewer.destroy();
  });
});

describe('双页模式：水平滚动到底后回到第一页', () => {
  it('滚到底 → 滚回顶部，页码与位置都回到第一组', async () => {
    const { viewer } = await createViewer({ direction: 'horizontal', viewMode: 'spread' });
    scrollToBottom(viewer, true);
    expect(viewer.getState().view.pageNumber).not.toBe(1);
    scrollTo(viewer, 0, true);
    internalsOf(viewer).snapToNearestGroup();
    expect(viewer.getState().view.pageNumber).toBe(1);
    expect(posOf(viewer, true)).toBe(0);
    await viewer.destroy();
  });
});

describe('双页模式：垂直滚动不被弹回', () => {
  it('滚到底部位置保持稳定，连续吸附不移动', async () => {
    const { viewer } = await createViewer({ direction: 'page', viewMode: 'spread' });
    scrollToBottom(viewer, false);
    const bottom = posOf(viewer, false);
    for (let index = 0; index < 5; index += 1) internalsOf(viewer).snapToNearestGroup();
    expect(Math.abs(posOf(viewer, false) - bottom)).toBeLessThan(1);
    await viewer.destroy();
  });

  it('小倍率下可以滚到最后一组', async () => {
    const { viewer } = await createViewer({ direction: 'page', viewMode: 'spread' });
    viewer.setZoomMode('page-actual');
    viewer.setScale(0.5);
    scrollToBottom(viewer, false);
    const layout = layoutOf(viewer);
    expect(viewer.getState().view.pageNumber).toBe(
      layout.groupRangeOf(layout.pageCount - 1).start + 1,
    );
    await viewer.destroy();
  });
});
