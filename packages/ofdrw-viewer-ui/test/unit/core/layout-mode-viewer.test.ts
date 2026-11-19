/**
 * 版式在阅读器中的生效：滚动方向 × 视图模式、文档声明、翻页、吸附与缩放。
 *
 * 覆盖四种组合（单页/双页 × 页面滚动/水平滚动）下的滚动位置、页码与缩放。
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

/** 构造 4 页 A4 引擎文档替身。 */
function makeDocument(): unknown {
  const infos: PageInfo[] = Array.from({ length: 4 }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
  return {
    pageCount: 4,
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
    getMetadata: async () => ({ version: '1.0', pageCount: 4 }),
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
function buildOfd(document: string): ArrayBuffer {
  const bytes = zipSync({
    'OFD.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0" DocType="OFD">' +
        '<ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>',
    ),
    'Doc_0/Document.xml': strToU8(document),
  });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 带声明的最小 Document.xml。 */
function documentXml(inner = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">${inner}</ofd:Document>`;
}

/** 读取内部排版对象。 */
function layoutOf(viewer: OFDViewer): PageLayout {
  return (viewer as unknown as { layout: PageLayout }).layout;
}

/** 创建阅读器。 */
function createViewer(
  options: { readonly source?: ArrayBuffer; readonly layout?: Partial<LayoutConfig> } = {},
): OFDViewer {
  return new OFDViewer({
    crypto: { enabled: false },
    container: document.body,
    source: options.source ?? buildOfd(documentXml()),
    ...(options.layout ? { layout: options.layout } : {}),
  });
}

/** 模拟用户把主区域滚到指定位置并触发滚动处理。 */
function scrollTo(viewer: OFDViewer, pos: number, horizontal: boolean): void {
  const main = viewer.getElements().main;
  if (horizontal) main.scrollLeft = pos;
  else main.scrollTop = pos;
  (viewer as unknown as { handleScroll: () => void }).handleScroll();
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
  document.body.innerHTML = '';
});

describe('默认版式', () => {
  it('默认单页 + 页面滚动', async () => {
    const viewer = createViewer();
    await viewer.ready;
    expect(viewer.getLayout()).toEqual({ direction: 'page', viewMode: 'single' });
    expect(viewer.getState().view.layout).toEqual({ direction: 'page', viewMode: 'single' });
    await viewer.destroy();
  });
});

describe('文档声明 VPreferences/PageLayout', () => {
  it.each([
    ['OneColumn', { direction: 'page', viewMode: 'single' }],
    ['OnePage', { direction: 'horizontal', viewMode: 'single' }],
    ['TwoColumnL', { direction: 'page', viewMode: 'spread' }],
    ['TwoPageR', { direction: 'horizontal', viewMode: 'spread' }],
  ] as const)('%s → %o', async (value, expected) => {
    const viewer = createViewer({
      source: buildOfd(
        documentXml(`<ofd:VPreferences><ofd:PageLayout>${value}</ofd:PageLayout></ofd:VPreferences>`),
      ),
    });
    await viewer.ready;
    expect(viewer.getLayout()).toEqual(expected);
    await viewer.destroy();
  });

  it('宿主 layout 选项优先于文档声明', async () => {
    const viewer = createViewer({
      source: buildOfd(
        documentXml('<ofd:VPreferences><ofd:PageLayout>OnePage</ofd:PageLayout></ofd:VPreferences>'),
      ),
      layout: { viewMode: 'spread' },
    });
    await viewer.ready;
    // 宿主只给了 viewMode（其声明值被宿主覆盖），direction 仍取文档声明。
    expect(viewer.getLayout()).toEqual({ direction: 'horizontal', viewMode: 'spread' });
    await viewer.destroy();
  });

  it('宿主关闭 viewPreferences 时不应用 PageLayout', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: buildOfd(
        documentXml('<ofd:VPreferences><ofd:PageLayout>TwoPageL</ofd:PageLayout></ofd:VPreferences>'),
      ),
      documentPolicy: { viewPreferences: false },
    });
    await viewer.ready;
    expect(viewer.getLayout()).toEqual({ direction: 'page', viewMode: 'single' });
    await viewer.destroy();
  });
});

describe('页面滚动（纵向）', () => {
  it('单页：逐页向下滚动并更新页码', async () => {
    const viewer = createViewer({ layout: { direction: 'page', viewMode: 'single' } });
    await viewer.ready;
    const layout = layoutOf(viewer);
    const page2Top = layout.getBoxes()[1]!.top;
    const viewportHeight = (viewer as unknown as { viewportHeight: () => number }).viewportHeight();
    // 视口中点仍在第 1 页：页码不变。
    scrollTo(viewer, page2Top - viewportHeight, false);
    expect(viewer.getState().view.pageNumber).toBe(1);
    // 视口中点进入第 2 页后切页。
    scrollTo(viewer, page2Top + viewportHeight / 2, false);
    expect(viewer.getState().view.pageNumber).toBe(2);
    await viewer.destroy();
  });

  it('双页：nextPage 跳到下一组首页，previousPage 回到上一组', async () => {
    const viewer = createViewer({ layout: { direction: 'page', viewMode: 'spread' } });
    await viewer.ready;
    expect(viewer.getState().view.pageNumber).toBe(1);
    viewer.nextPage();
    expect(viewer.getState().view.pageNumber).toBe(3);
    viewer.previousPage();
    expect(viewer.getState().view.pageNumber).toBe(1);
    await viewer.destroy();
  });

  it('双页：滚动到第二组时页码切到该组首页', async () => {
    const viewer = createViewer({ layout: { direction: 'page', viewMode: 'spread' } });
    await viewer.ready;
    const layout = layoutOf(viewer);
    const group2Top = layout.getBoxes()[2]!.top;
    scrollTo(viewer, group2Top, false);
    expect(viewer.getState().view.pageNumber).toBe(3);
    await viewer.destroy();
  });
});

describe('水平滚动（横向）', () => {
  it('单页：逐页向右滚动并更新页码', async () => {
    const viewer = createViewer({ layout: { direction: 'horizontal', viewMode: 'single' } });
    await viewer.ready;
    const layout = layoutOf(viewer);
    const page2Left = layout.getBoxes()[1]!.left;
    scrollTo(viewer, page2Left + 400, true);
    expect(viewer.getState().view.pageNumber).toBe(2);
    const main = viewer.getElements().main;
    // 横向布局：纵向不再是滚动方向，滚动位置来自 scrollLeft。
    expect(main.scrollLeft).toBeGreaterThan(0);
    await viewer.destroy();
  });

  it('双页：一次翻一组两页', async () => {
    const viewer = createViewer({ layout: { direction: 'horizontal', viewMode: 'spread' } });
    await viewer.ready;
    viewer.nextPage();
    expect(viewer.getState().view.pageNumber).toBe(3);
    const layout = layoutOf(viewer);
    // 第 3 页与第 4 页同一组，left 均大于第 1 组。
    expect(layout.getBoxes()[2]!.left).toBeGreaterThan(layout.getBoxes()[0]!.left);
    expect(layout.getBoxes()[2]!.top).toBe(layout.getBoxes()[3]!.top);
    await viewer.destroy();
  });

  it('goToPage 在横向布局下滚动到目标组起点', async () => {
    const viewer = createViewer({ layout: { direction: 'horizontal', viewMode: 'single' } });
    await viewer.ready;
    const layout = layoutOf(viewer);
    const before = viewer.getElements().main.scrollLeft;
    viewer.goToPage(3);
    expect(viewer.getState().view.pageNumber).toBe(3);
    // 横向布局的滚动位置写入 scrollLeft，且比初始位置更靠右。
    const scrollLeft = viewer.getElements().main.scrollLeft;
    expect(scrollLeft).toBeGreaterThan(before);
    expect(scrollLeft).toBeGreaterThan(0);
    // 目标页已在视口之内。
    const left = layout.getBoxes()[2]!.left;
    const width = (viewer as unknown as { viewportWidth: () => number }).viewportWidth();
    expect(left).toBeLessThanOrEqual(scrollLeft + width);
    await viewer.destroy();
  });
});

describe('缩放', () => {
  it('页面滚动 + 单页：缩放改变页盒尺寸', async () => {
    const viewer = createViewer({ layout: { direction: 'page', viewMode: 'single' } });
    await viewer.ready;
    // 先固定为 100% 模式，再按倍率缩放；否则 auto 模式会按视口重算倍率。
    viewer.setZoomMode('page-actual');
    const before = layoutOf(viewer).getBoxes()[0]!.width;
    viewer.setScale(2);
    const after = layoutOf(viewer).getBoxes()[0]!.width;
    expect(after).toBeCloseTo(before * 2, 0);
    expect(viewer.getState().view.scale).toBe(2);
    await viewer.destroy();
  });

  it('水平滚动 + 单页：缩放改变横向页盒尺寸', async () => {
    const viewer = createViewer({ layout: { direction: 'horizontal', viewMode: 'single' } });
    await viewer.ready;
    viewer.setZoomMode('page-actual');
    const before = layoutOf(viewer).getBoxes()[0]!.width;
    viewer.setScale(1.5);
    expect(layoutOf(viewer).getBoxes()[0]!.width).toBeCloseTo(before * 1.5, 0);
    await viewer.destroy();
  });

  it('双页：整组作为整体缩放，两页共同变大', async () => {
    const viewer = createViewer({ layout: { direction: 'page', viewMode: 'spread' } });
    await viewer.ready;
    viewer.setZoomMode('page-actual');
    const before = layoutOf(viewer).getBoxes().slice(0, 2).map((box) => box.width);
    viewer.setScale(1.5);
    const after = layoutOf(viewer).getBoxes().slice(0, 2).map((box) => box.width);
    expect(after[0]).toBeCloseTo(before[0]! * 1.5, 0);
    expect(after[1]).toBeCloseTo(before[1]! * 1.5, 0);
    // 两页仍并排且等宽。
    expect(after[0]).toBe(after[1]);
    await viewer.destroy();
  });

  it('水平滚动 + 双页：缩放下组内间隔同步放大', async () => {
    const viewer = createViewer({ layout: { direction: 'horizontal', viewMode: 'spread' } });
    await viewer.ready;
    const gapOf = (): number => {
      const [first, second] = layoutOf(viewer).getBoxes();
      return second!.left - (first!.left + first!.width);
    };
    viewer.setZoomMode('page-actual');
    viewer.setScale(1);
    const before = gapOf();
    viewer.setScale(2);
    expect(gapOf()).toBeCloseTo(before * 2, 0);
    await viewer.destroy();
  });
});

describe('切换版式', () => {
  it('setLayout 切换后保持当前页并派发 layoutchange', async () => {
    const viewer = createViewer();
    await viewer.ready;
    const events: string[] = [];
    viewer.on('layoutchange', (payload) =>
      events.push(`${payload.previous.direction}/${payload.previous.viewMode}->${payload.layout.direction}/${payload.layout.viewMode}`),
    );
    viewer.goToPage(3);
    viewer.setLayout({ direction: 'horizontal' });
    expect(viewer.getLayout()).toEqual({ direction: 'horizontal', viewMode: 'single' });
    expect(viewer.getState().view.pageNumber).toBe(3);
    expect(events).toEqual(['page/single->horizontal/single']);
    viewer.setLayout({ viewMode: 'spread' });
    expect(viewer.getState().view.pageNumber).toBe(3);
    expect(events).toHaveLength(2);
    await viewer.destroy();
  });

  it('滚动停顿后吸附到整组边界（接近组边界时才吸附）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const viewer = createViewer({ layout: { direction: 'page', viewMode: 'single' } });
      await viewer.ready;
      const layout = layoutOf(viewer);
      const page2Top = layout.getBoxes()[1]!.top;
      // 停在第 2 页顶部附近（越过组边界不足半个组间距）时吸附到该页顶部。
      scrollTo(viewer, page2Top + 1, false);
      vi.advanceTimersByTime(200);
      expect(Math.abs(viewer.getElements().main.scrollTop - page2Top)).toBeLessThan(1.5);
      // 停在第 1 页中段时不强行拉回（吸附只让“快对齐”的位置对齐）。
      scrollTo(viewer, 300, false);
      const middle = viewer.getElements().main.scrollTop;
      vi.advanceTimersByTime(200);
      expect(viewer.getElements().main.scrollTop).toBe(middle);
      await viewer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
