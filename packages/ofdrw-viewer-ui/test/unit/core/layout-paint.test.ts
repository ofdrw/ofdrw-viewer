/**
 * 版式与绘制联动回归：可见页必须有 canvas、面板尺寸正确、选区不影响画面。
 *
 * 覆盖用户报告：
 * - 双页水平滚动放大后没有垂直滚动条（主区域纵向应可滚动）；
 * - 双页复制/选中文字后 canvas 空白；
 * - 双页选中文字时垂直滚动导致文字空白。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return { ...actual, OFDDocument: { open: engineMocks.open } };
});

import { OFDViewer } from '../../../src/viewer';
import type { LayoutConfig } from '../../../src/page-layout';

/** 引擎文档替身：6 页 A4。 */
function createMockDocument(): unknown {
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
      getViewport: (options: { dpi?: number } = {}) => ({
        width: Math.ceil((210 / 25.4) * (options.dpi ?? 96)),
        height: Math.ceil((297 / 25.4) * (options.dpi ?? 96)),
        dpi: options.dpi ?? 96,
      }),
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

/** 内部句柄。 */
interface Internals {
  handleScroll(): void;
  renderVisible(force?: boolean): void;
  reflow(): void;
  lastVisibleRange: { start: number; end: number };
  layout: {
    setViewport(width: number, height: number): void;
    getBoxes(): ReadonlyArray<{ top: number; left: number; width: number; height: number }>;
    pageCount: number;
  };
  pageViews: Array<{ hasCanvas: boolean; pageNumber: number }>;
  viewportExtent(): number;
}

/**
 * 模拟文本层设置选区端点 pin。
 *
 * `services` 是阅读器内部字段，测试里只借用文本层服务的 pin 接口来复现
 * “选中文字后页码被 pin”的场景。
 *
 * @param viewer 阅读器实例。
 * @param pages 需要 pin 的页码（1-based）。
 */
function pinPages(viewer: OFDViewer, pages: number[]): void {
  const services = (viewer as unknown as {
    services: { textLayer?: { setPinnedPages?(pages: number[]): boolean | void } };
    textLayerPinsChanged(): void;
  });
  services.services.textLayer?.setPinnedPages?.(pages);
  services.textLayerPinsChanged();
}

/** 创建已打开文档的阅读器并桩住视口尺寸。 */
async function createViewer(
  layout: LayoutConfig,
  viewport = { width: 1265, height: 688 },
): Promise<{ viewer: OFDViewer; main: HTMLElement; internals: Internals }> {
  const viewer = new OFDViewer({
    crypto: { enabled: false },
    container: document.body,
    source: buildOfd(),
    layout,
  });
  await viewer.ready;
  const internal = viewer as unknown as Internals;
  const main = viewer.getElements().main;
  Object.defineProperty(main, 'clientWidth', { configurable: true, get: () => viewport.width });
  Object.defineProperty(main, 'clientHeight', { configurable: true, get: () => viewport.height });
  internal.layout.setViewport(viewport.width, viewport.height);
  internal.reflow();
  internal.renderVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { viewer, main, internals: internal };
}

beforeEach(() => {
  document.body.innerHTML = '';
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => createMockDocument());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
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
  document.body.innerHTML = '';
});

describe('双页 + 水平滚动：放大后仍可纵向滚动', () => {
  it('主区域同时允许横向与纵向滚动', async () => {
    const { viewer } = await createViewer({
      direction: 'horizontal',
      viewMode: 'spread',
    });
    // 放大到页面高于视口。
    viewer.setZoomMode('page-actual');
    viewer.setScale(2);
    (viewer as unknown as Internals).renderVisible(true);
    const main = viewer.getElements().main;
    // CSS 由 `data-scroll` 驱动：纵向不能再是 hidden，否则放大后看不到页面上下部分。
    expect(viewer.getRoot().dataset.scroll).toBe('horizontal');
    const style = window.getComputedStyle(main);
    expect(style.overflowY).not.toBe('hidden');
    await viewer.destroy();
  });

  it('放大后内容高度超过视口（产生纵向滚动范围）', async () => {
    const { viewer, internals } = await createViewer({
      direction: 'horizontal',
      viewMode: 'spread',
    });
    viewer.setZoomMode('page-actual');
    viewer.setScale(2);
    internals.reflow();
    const boxes = internals.layout.getBoxes();
    const tallest = Math.max(...boxes.map((box) => box.height));
    // 页面高过视口：说明需要纵向滚动。
    expect(tallest).toBeGreaterThan(688);
    // 内容容器写入了高度（纵向滚动范围），而不是被压成 0。
    const pages = viewer.getElements().main.querySelector<HTMLElement>('.ofd-viewer__pages');
    expect(Number.parseFloat(pages?.style.height ?? '0')).toBeGreaterThan(688);
    await viewer.destroy();
  });
});

describe('可见页必须有 canvas', () => {
  it.each([
    ['页面滚动 + 单页', { direction: 'page', viewMode: 'single' } as LayoutConfig],
    ['页面滚动 + 双页', { direction: 'page', viewMode: 'spread' } as LayoutConfig],
    ['水平滚动 + 单页', { direction: 'horizontal', viewMode: 'single' } as LayoutConfig],
    ['水平滚动 + 双页', { direction: 'horizontal', viewMode: 'spread' } as LayoutConfig],
  ])('%s：可见页绘制后都有 canvas', async (_name, config) => {
    const { viewer, internals } = await createViewer(config);
    const visible = internals.lastVisibleRange;
    for (let index = visible.start; index <= visible.end; index += 1) {
      expect(internals.pageViews[index]?.hasCanvas).toBe(true);
    }
    await viewer.destroy();
  });

  it('可见页 canvas 被释放后，滚动回来会强制重绘', async () => {
    const { viewer, main, internals } = await createViewer({
      direction: 'page',
      viewMode: 'spread',
    });
    // 模拟像素预算回收：释放可见页 canvas（选区 pin 页滚出可见区时也会这样）。
    (internals.pageViews[0] as unknown as { releaseCanvas(): void }).releaseCanvas();
    expect(internals.pageViews[0]?.hasCanvas).toBe(false);
    // 回到顶部触发可见页刷新。
    main.scrollTop = 0;
    internals.handleScroll();
    internals.renderVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(internals.pageViews[0]?.hasCanvas).toBe(true);
    await viewer.destroy();
  });
});

describe('选区不影响画面', () => {
  it('设置选区 pin 后，可见页 canvas 保持存在', async () => {
    const { viewer, internals } = await createViewer({
      direction: 'page',
      viewMode: 'spread',
    });
    const before = internals.pageViews.map((view) => view.hasCanvas);
    pinPages(viewer, [1, 2]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = internals.pageViews.map((view) => view.hasCanvas);
    // 可见页不受 pin 影响。
    for (let index = internals.lastVisibleRange.start; index <= internals.lastVisibleRange.end; index += 1) {
      expect(after[index]).toBe(true);
    }
    expect(after.length).toBe(before.length);
    await viewer.destroy();
  });

  it('pin 页滚出可见区再滚回：canvas 被重新绘制而不是保持空白', async () => {
    const { viewer, main, internals } = await createViewer({
      direction: 'page',
      viewMode: 'spread',
    });
    pinPages(viewer, [1]);
    // 滚到页面底部。
    main.scrollTop = 999999;
    internals.handleScroll();
    internals.renderVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 滚回顶部：第 1 页重新可见，必须重新有 canvas。
    main.scrollTop = 0;
    internals.handleScroll();
    internals.renderVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(internals.pageViews[0]?.hasCanvas).toBe(true);
    await viewer.destroy();
  });
});
