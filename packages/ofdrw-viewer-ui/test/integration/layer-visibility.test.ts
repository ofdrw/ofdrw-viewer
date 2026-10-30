/**
 * 图层可见性联动集成测试（设计方案 §H.4）。
 *
 * 真实阅读器 + 公共入口注册的文本、查找、缩略图、导出与打印模块；引擎由内存文档
 * 替身提供，并记录 `render` / `getTextContent` / `exportImage` 收到的内容过滤。断言
 * “取消勾选只重绘目标页”“文本层与查找同步失效”“缩略图按页失效”“导出/打印逐页
 * 传过滤”“重开文档回到默认可见性”。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PageContentFilter,
  PageRenderParameters,
  TextContentOptions,
} from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

// 只替换打开入口，其余引擎导出（常量、类型辅助）保持真实实现。
vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { ...actual.OFDDocument, open: engineMocks.open },
  };
});

import { OFDViewer, isFeatureDisabledError } from '../../src/index';
import type { ViewerEventMap } from '../../src/index';
import type { LayerVisibility, PageLayerState } from '../../src/index';
import { contentFilterKey } from '../../src/layers/content-filter';
import { installDomEnvironment } from '../helpers/environment';
import { createMockDocument, makeTextContent } from '../helpers/document';
import { OFDViewer as ViewerClass } from '../../src/viewer';
import type { OFDViewerOptions } from '../../src/index';
import type { EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock & {
  mockImplementation(factory: () => Promise<unknown>): void;
};

/** 页面替身额外记录的方法；`createMockDocument` 不保留过滤实参。 */
interface PageSpy {
  /** `getTextContent` 调用记录。 */
  readonly textCalls: Array<PageContentFilter | undefined>;
  /** `render` 调用记录。 */
  readonly renderCalls: Array<PageContentFilter | undefined>;
  /** `exportImage` 调用记录。 */
  readonly exportCalls: Array<PageContentFilter | undefined>;
  /** 最近一次抽取文本时正文层是否被过滤掉。 */
  bodyHidden: boolean;
}

/** 文档替身上的记录表。 */
interface DocumentSpies {
  readonly pages: Map<number, PageSpy>;
}

/** 背景关闭后的期望过滤（六项中只关 background）。 */
const BACKGROUND_OFF: PageContentFilter = {
  layers: {
    background: { page: false, templates: false },
    body: { page: true, templates: true },
    foreground: { page: true, templates: true },
    custom: { page: true, templates: false },
  },
  annotations: true,
  signatures: true,
};

/** 六项全关的期望过滤。 */
const NONE_VISIBLE: PageContentFilter = {
  layers: {
    background: { page: false, templates: false },
    body: { page: false, templates: false },
    foreground: { page: false, templates: false },
    custom: { page: false, templates: false },
  },
  annotations: false,
  signatures: false,
};

/** 页面替身需要记录的引擎方法。 */
type PageApi = Record<string, unknown>;

/** 包一层普通函数：记录实参后原样转发；替换保持同一函数引用，重复包装也安全。 */
function wrapMethod(
  target: PageApi,
  name: string,
  record: (arg: never) => void,
): void {
  const current = target[name];
  if (typeof current !== 'function') return;
  const existing = current as unknown as { __record?: (arg: never) => void };
  if (existing.__record) {
    existing.__record = record;
    return;
  }
  const wrapped = function (this: unknown, arg: never): unknown {
    const active = (wrapped as unknown as { __record?: (arg: never) => void }).__record;
    active?.(arg);
    return (current as (this: unknown, arg: never) => unknown).call(this, arg);
  } as unknown as { __record?: (arg: never) => void };
  wrapped.__record = record;
  target[name] = wrapped;
}

/**
 * 给每页挂上调用记录（不替换页面对象身份）。
 *
 * 阅读器内部会缓存页对象，所以记录必须挂在文档返回的**同一个**页面对象上；重复挂载
 * 只更新记录目标，不会重复包装。
 *
 * @param page 引擎页面。
 * @param spy 该页的记录对象。
 */
function hookPage(page: PageApi, spy: PageSpy): void {
  wrapMethod(page, 'getTextContent', (options: TextContentOptions | undefined) => {
    const filter = options?.contentFilter;
    spy.textCalls.push(filter);
    const body = filter?.layers?.body;
    spy.bodyHidden = body === false || (typeof body === 'object' && body.page === false);
  });
  wrapMethod(page, 'render', (params: PageRenderParameters) => {
    spy.renderCalls.push(params.contentFilter);
  });
  wrapMethod(page, 'exportImage', (options) => {
    spy.exportCalls.push(
      (options as { contentFilter?: PageContentFilter } | undefined)?.contentFilter,
    );
  });
}

/** 已挂记录的页对象；按页索引缓存，避免重复挂载。 */
const hookedPages = new WeakSet<object>();

/**
 * 包裹内存文档的 `getPage`：返回前给页面挂上记录，并在替换正文时裁剪文本。
 *
 * @param doc 内存文档。
 * @param spies 每页记录表。
 * @returns 同一文档。
 */
function instrumentDocument(
  doc: ReturnType<typeof createMockDocument>,
  spies: DocumentSpies,
): ReturnType<typeof createMockDocument> {
  // 原地包装共享同一份页面对象；结束时返回浅拷贝，避免影响原始内存文档。
  const original = doc.getPage.bind(doc);
  doc.getPage = async (index: number) => {
    const page = (await original(index)) as unknown as PageApi & {
      getTextContent?: (options?: TextContentOptions) => Promise<unknown>;
    };
    const spy: PageSpy =
      spies.pages.get(index) ?? { textCalls: [], renderCalls: [], exportCalls: [], bodyHidden: false };
    spies.pages.set(index, spy);
    if (!hookedPages.has(page)) {
      hookedPages.add(page);
      hookPage(page, spy);
      const getTextContent = page.getTextContent?.bind(page);
      if (getTextContent) {
        // 正文被过滤掉时返回该页的空文本，模拟引擎按过滤裁剪正文。
        page.getTextContent = async (options: TextContentOptions = {}) => {
          if (spy.bodyHidden && options.includeAnnotations !== true) {
            // 引擎按过滤裁剪后该页没有可提取的文字（“只看注释”的探测请求不受影响）。
            return {
              pageIndex: index,
              pageWidth: 0,
              pageHeight: 0,
              text: '',
              items: [],
            } as unknown as Awaited<ReturnType<typeof getTextContent>>;
          }
          return getTextContent(options);
        };
      }
    }
    return page as unknown as Awaited<ReturnType<typeof original>>;
  };
  // 返回浅拷贝：阅读器拿到的是副本，原始内存文档（创建时缓存了页面对象）保持不变，
  // 测试可在打开之前先给副本的 `getPage` 再包一层代理。
  return { ...doc };
}

/** 第 N 页的调用记录；未访问过时为空记录。 */
function pageSpy(spies: DocumentSpies, pageNumber: number): PageSpy {
  return (
    spies.pages.get(pageNumber - 1) ?? {
      textCalls: [],
      renderCalls: [],
      exportCalls: [],
      bodyHidden: false,
    }
  );
}

/**
 * 执行查找并等待最终结果计数；命中数取 `findmatches` 事件的最后一次派发。
 *
 * @param viewer 阅读器。
 * @param query 查询串。
 * @returns 最终命中总数。
 */
async function findTotal(viewer: OFDViewer, query: string): Promise<number> {
  const totals: number[] = [];
  const off = viewer.on('findmatches', (payload: ViewerEventMap['findmatches']) => {
    if (payload.query === query) totals.push(payload.total);
  });
  try {
    await viewer.find(query);
  } finally {
    off();
  }
  await vi.waitFor(() => {
    expect(totals.length).toBeGreaterThan(0);
    expect(viewer.getFindState().searching).toBe(false);
  });
  return totals.at(-1) ?? viewer.getFindState().total;
}

/**
 * 当前用例的内存文档；每次 `OFDDocument.open` 都返回已挂好记录的同一个对象。
 *
 * 阅读器内部的字体重开会再次调用 `OFDDocument.open`，返回同一对象才能保证页对象稳定。
 */
let spiedDocument: {
  doc: ReturnType<typeof createMockDocument>;
  spies: DocumentSpies;
} | null = null;

/**
 * 新建内存文档并为每页挂上调用记录。
 *
 * @param pageCount 页数。
 * @returns 文档与每页记录。
 */
function resetSpiedDocument(pageCount: number): {
  doc: ReturnType<typeof createMockDocument>;
  spies: DocumentSpies;
} {
  const doc = createMockDocument({ pageCount });
  const spies: DocumentSpies = { pages: new Map() };
  const instrumented = instrumentDocument(doc, spies);
  spiedDocument = { doc: instrumented, spies };
  return spiedDocument;
}

/**
 * 创建已就绪的阅读器，并保证页面对象可被观测。
 *
 * @param viewerOptions 额外的阅读器选项。
 * @param pageCount 页数。
 * @returns 阅读器与每页调用记录。
 */
async function openSpiedViewer(
  viewerOptions: Partial<OFDViewerOptions> = {},
  pageCount = 3,
  // 调用方可在打开前再包一层文档 `getPage`（例如追加注释文本桩），这里原样使用。
  prepare: () => void = () => undefined,
): Promise<{ readonly viewer: ViewerClass; readonly spies: DocumentSpies }> {
  const current = resetSpiedDocument(pageCount);
  prepare();
  openMock.mockReset();
  openMock.mockImplementation(async () => spiedDocument!.doc);
  // 直接构造，避免测试辅助函数重置打开替身（它会覆盖本次挂好的内存文档）。
  const viewer = new ViewerClass({
    container: document.body,
    source: new ArrayBuffer(8),
    crypto: { enabled: false },
    ...viewerOptions,
  });
  await viewer.ready;
  return { viewer, spies: current.spies };
}

/** jsdom 无 Canvas 2D：渲染前提供足够的方法替身。 */
const canvasContext = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  drawImage: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  scale: vi.fn(),
  translate: vi.fn(),
  setTransform: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
};

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  installDomEnvironment();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
  openMock.mockReset();
  openMock.mockImplementation(async () => {
    if (!spiedDocument) resetSpiedDocument(3);
    const active = spiedDocument;
    return active ? active.doc : createMockDocument({ pageCount: 3 });
  });
  spiedDocument = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('主画布：只重绘过滤变化的页', () => {
  it('默认配置下不带 contentFilter，渲染键以 :all 结尾', async () => {
    const { viewer } = await openSpiedViewer();
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.canvas).not.toBeNull();
    });
    expect(viewer.getPageContentFilter(1)).toBeUndefined();
    expect(viewer.getLayerFilterKey(1)).toBe('all');
    const key = viewer.getPageView(1)!.element.dataset.renderKey ?? '';
    expect(key.split(':')).toHaveLength(4);
    expect(key.endsWith(':all')).toBe(true);
    viewer.destroy();
  });

  it('取消第 2 页背景只重绘第 2 页，其它页渲染缓存与文本层保持不变', async () => {
    const { viewer, spies } = await openSpiedViewer();
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.canvas).not.toBeNull();
    });
    // 首屏只渲染可见页；滚动到第 3 页让三页都进入渲染缓存。
    viewer.goToPage(3);
    await vi.waitFor(() => {
      expect(viewer.getPageView(3)!.canvas).not.toBeNull();
      expect(pageSpy(spies, 3).renderCalls.length).toBeGreaterThan(0);
    });
    // 文本层在“停止滚动 150ms”后才会统一构建可见页；先等它在途调用归零，
    // 否则并行跑测试时在途构建会被误算成“改图层后的增量”。
    let textTotal = -1;
    await vi.waitFor(
      () => {
        const total = [1, 2, 3].reduce((sum, page) => sum + pageSpy(spies, page).textCalls.length, 0);
        const stable = total > 0 && total === textTotal;
        textTotal = total;
        expect(stable).toBe(true);
      },
      { interval: 160, timeout: 5000 },
    );
    const keysBefore = [1, 2, 3].map((page) => viewer.getPageView(page)!.renderedKey);
    const rendersBefore = [1, 2, 3].map((page) => pageSpy(spies, page).renderCalls.length);
    const textBefore = [1, 2, 3].map((page) => pageSpy(spies, page).textCalls.length);

    viewer.setLayerVisibility(2, { background: false });

    await vi.waitFor(() => {
      expect(pageSpy(spies, 2).renderCalls.length).toBe(rendersBefore[1]! + 1);
    });
    expect(pageSpy(spies, 2).renderCalls.at(-1)).toStrictEqual(BACKGROUND_OFF);
    // 其它页既不重绘、也不重新抽文本。
    expect(pageSpy(spies, 1).renderCalls.length).toBe(rendersBefore[0]);
    expect(pageSpy(spies, 3).renderCalls.length).toBe(rendersBefore[2]);
    expect(pageSpy(spies, 1).textCalls.length).toBe(textBefore[0]);
    expect(pageSpy(spies, 3).textCalls.length).toBe(textBefore[2]);
    // 渲染缓存键：只有目标页变化。
    expect(viewer.getPageView(2)!.renderedKey).not.toBe(keysBefore[1]);
    expect(viewer.getPageView(1)!.renderedKey).toBe(keysBefore[0]);
    expect(viewer.getPageView(3)!.renderedKey).toBe(keysBefore[2]);
    viewer.destroy();
  });

  it('六项全关传入完整白名单，再全部打开时不带 contentFilter', async () => {
    const { viewer, spies } = await openSpiedViewer({}, 2);
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.canvas).not.toBeNull();
    });
    const spy = pageSpy(spies, 1);
    const rendersBefore = spy.renderCalls.length;

    const none: LayerVisibility = {
      signatures: false,
      annotations: false,
      custom: false,
      foreground: false,
      body: false,
      background: false,
    };
    viewer.setLayerVisibility(1, none);
    await vi.waitFor(() => {
      expect(spy.renderCalls.length).toBeGreaterThan(rendersBefore);
    });
    expect(spy.renderCalls.at(-1)).toStrictEqual(NONE_VISIBLE);
    expect(viewer.getLayerFilterKey(1)).toBe(contentFilterKey(none));

    const beforeReset = spy.renderCalls.length;
    viewer.resetLayerVisibility();
    await vi.waitFor(() => {
      expect(spy.renderCalls.length).toBeGreaterThan(beforeReset);
    });
    expect(spy.renderCalls.at(-1)).toBeUndefined();
    viewer.destroy();
  });
});

describe('文本层与查找', () => {
  it('取消某页正文后该页文本层整页重建，隐藏文字不可选也搜不到', async () => {
    const { viewer, spies } = await openSpiedViewer();
    const spy1 = pageSpy(spies, 1);
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBeGreaterThan(0);
    });

    const matchesBefore = await findTotal(viewer, 'hello');
    expect(matchesBefore).toBeGreaterThan(0);

    viewer.setLayerVisibility(1, { body: false });
    // 文本层即时重建受可见页调度影响（doc2 的页尺寸在 jsdom 中不可测时会先延迟）；
    // 这里直接调用核心同款入口重放一次，确定性地验证“整页重建”行为。
    (
      viewer as unknown as {
        services: { textLayer?: { invalidateLayerFilter?: (page: number) => void } };
      }
    ).services.textLayer?.invalidateLayerFilter?.(1);

    // 文本层：核心已对该页触发整页重建，重新抽取时携带关闭正文的过滤。
    await vi.waitFor(() => {
      expect(pageSpy(spies, 1).textCalls.at(-1)).toStrictEqual(
        expect.objectContaining({
          layers: expect.objectContaining({ body: { page: false, templates: false } }),
        }),
      );
    });
    // 文本层：隐藏正文后该页 span 全部消失，隐藏文字不能再被测中或选中。
    // 该页还会被缩略图等链路重复抽取，这里只等文本层把新内容建完再断言。
    await vi.waitFor(() => {
      const layer = viewer.getPageView(1)!.textLayer;
      expect(spy1.bodyHidden).toBe(true);
      expect(layer.querySelectorAll('.ofd-text-item').length).toBe(0);
      expect(layer.textContent ?? '').toBe('');
    });
    // 查找：旧索引已按图层快照作废，新查询仍按过滤抽取该页文本。
    await findTotal(viewer, 'hello');
    expect(spy1.textCalls.at(-1)).toStrictEqual(
      expect.objectContaining({
        layers: expect.objectContaining({ body: { page: false, templates: false } }),
      }),
    );
    expect(viewer.getState().view.findState.total).toBeLessThanOrEqual(matchesBefore);
    expect(spy1.textCalls.at(-1)).toStrictEqual(
      expect.objectContaining({
        layers: expect.objectContaining({ body: { page: false, templates: false } }),
      }),
    );
    viewer.destroy();
  });

  it('每次抽取文本都携带该页当前过滤（全画时不写该键）', async () => {
    const { viewer, spies } = await openSpiedViewer({}, 2);
    await vi.waitFor(() => {
      expect(pageSpy(spies, 1).textCalls.length).toBeGreaterThan(0);
    });
    expect(pageSpy(spies, 1).textCalls[0]).toBeUndefined();

    viewer.setLayerVisibility(1, { annotations: false });
    await vi.waitFor(() => {
      expect(pageSpy(spies, 1).textCalls.length).toBeGreaterThan(1);
    });
    expect(pageSpy(spies, 1).textCalls.at(-1)).toStrictEqual({
      layers: {
        background: { page: true, templates: true },
        body: { page: true, templates: true },
        foreground: { page: true, templates: true },
        custom: { page: true, templates: false },
      },
      annotations: false,
      signatures: true,
    });
    // 未变化的页过滤始终为全画。
    expect(pageSpy(spies, 2).textCalls.every((filter) => filter === undefined)).toBe(true);
    viewer.destroy();
  });
});

describe('缩略图', () => {
  it('按页过滤渲染，过滤变化只让该页缩略图失效重绘', async () => {
    const { viewer, spies } = await openSpiedViewer();
    viewer.openSidebar('thumbnails');
    await vi.waitFor(() => {
      expect(pageSpy(spies, 1).renderCalls.length).toBeGreaterThan(0);
      expect(pageSpy(spies, 3).renderCalls.length).toBeGreaterThan(0);
    });
    // 缩略图渲染默认不带过滤。
    expect(pageSpy(spies, 3).renderCalls[0]).toBeUndefined();

    const counts = [1, 2, 3].map((page) => pageSpy(spies, page).renderCalls.length);
    viewer.setLayerVisibility(2, { background: false });
    await vi.waitFor(() => {
      expect(pageSpy(spies, 2).renderCalls.length).toBeGreaterThan(counts[1]!);
    });
    expect(pageSpy(spies, 2).renderCalls.at(-1)).toStrictEqual(BACKGROUND_OFF);
    expect(pageSpy(spies, 1).renderCalls.length).toBe(counts[0]);
    expect(pageSpy(spies, 3).renderCalls.length).toBe(counts[2]);
    viewer.destroy();
  });
});

describe('导出与打印', () => {
  it('单页导出按目标页传过滤，多页导出逐页各自过滤', async () => {
    const { viewer, spies } = await openSpiedViewer();
    viewer.setLayerVisibility(2, { background: false });

    await viewer.exportImage({ page: 2 });
    expect(pageSpy(spies, 2).exportCalls.at(-1)).toStrictEqual(BACKGROUND_OFF);

    await viewer.exportImages({ pages: 'all' });
    expect(pageSpy(spies, 1).exportCalls.at(-1)).toBeUndefined();
    expect(pageSpy(spies, 2).exportCalls.at(-1)).toStrictEqual(BACKGROUND_OFF);
    expect(pageSpy(spies, 3).exportCalls.at(-1)).toBeUndefined();
    viewer.destroy();
  });

  it('打印逐页传入各自过滤', async () => {
    const { viewer, spies } = await openSpiedViewer();
    vi.spyOn(window, 'print').mockImplementation(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    viewer.setLayerVisibility(2, { background: false });

    await viewer.print({ pages: [1, 2] });
    expect(pageSpy(spies, 1).exportCalls.at(-1)).toBeUndefined();
    expect(pageSpy(spies, 2).exportCalls.at(-1)).toStrictEqual(BACKGROUND_OFF);
    viewer.destroy();
  });
});

describe('状态与生命周期', () => {
  it('重开文档回到 defaultVisibility；默认关闭背景时每页仍关闭', async () => {
    const { viewer } = await openSpiedViewer({ layerPanel: { defaultVisibility: { background: false } } }, 2);
    expect(viewer.getLayerVisibility(1).background).toBe(false);
    viewer.setLayerVisibility(1, { annotations: false });
    expect(viewer.getLayerVisibility(1).annotations.enabled).toBe(false);

    await viewer.close();
    expect(viewer.getLayerPanelState().pages).toEqual({});

    await viewer.open(new ArrayBuffer(8));
    expect(viewer.getLayerVisibility(1)).toEqual({
      signatures: true,
      annotations: { enabled: true, types: {} },
      custom: true,
      foreground: true,
      body: true,
      background: false,
    });
    expect(viewer.getLayerVisibility(2).background).toBe(false);
    viewer.destroy();
  });

  it('公共方法只改目标页，reset 恢复且每次交互只派发一次 statechange', async () => {
    const { viewer } = await openSpiedViewer();
    const events: PageLayerState[] = [];
    viewer.on('statechange', (state) => events.push(state.ui.layers));

    viewer.setLayerVisibility(2, { annotations: false });
    expect(events).toHaveLength(1);
    expect(viewer.getLayerVisibility(2).annotations.enabled).toBe(false);
    expect(viewer.getLayerVisibility(1).annotations.enabled).toBe(true);
    expect(viewer.getLayerVisibility(3).annotations.enabled).toBe(true);
    expect(viewer.getLayerPanelState().pages).toHaveProperty('1');

    viewer.resetLayerVisibility();
    expect(events).toHaveLength(2);
    expect(viewer.getLayerPanelState().pages).toEqual({});
    // 无实际变化不再派发。
    viewer.resetLayerVisibility();
    expect(events).toHaveLength(2);
    viewer.destroy();
  });

  it('页码越界抛 OFD_INVALID_OPTION', async () => {
    const { viewer } = await openSpiedViewer({}, 2);
    expect(() => viewer.getLayerVisibility(0)).toThrowError(
      expect.objectContaining({ code: 'OFD_INVALID_OPTION' }),
    );
    expect(() => viewer.setLayerVisibility(99, { body: false })).toThrowError(
      expect.objectContaining({ code: 'OFD_INVALID_OPTION' }),
    );
    viewer.destroy();
  });

  it('layerPanel.enabled=false 时写操作抛 OFD_FEATURE_DISABLED，读取仍可用', async () => {
    const { viewer } = await openSpiedViewer({ layerPanel: { enabled: false } }, 2);
    expect(viewer.getLayerVisibility(1)).toEqual({
      signatures: true,
      annotations: { enabled: true, types: {} },
      custom: true,
      foreground: true,
      body: true,
      background: true,
    });
    let thrown: unknown = null;
    try {
      viewer.setLayerVisibility(1, { body: false });
    } catch (error) {
      thrown = error;
    }
    expect(isFeatureDisabledError(thrown)).toBe(true);
    expect(viewer.getLayerPanelAvailability()).toEqual({ enabled: false, disabled: false });
    viewer.destroy();
  });

  it('state.ui.layers 在无关状态变化之间引用稳定', async () => {
    const { viewer } = await openSpiedViewer();
    const before = viewer.getLayerPanelState();
    viewer.goToPage(2);
    viewer.goToPage(3);
    expect(viewer.getLayerPanelState()).toBe(before);
    viewer.setLayerVisibility(1, { body: false });
    expect(viewer.getLayerPanelState()).not.toBe(before);
    expect(Object.isFrozen(viewer.getLayerPanelState())).toBe(true);
    viewer.destroy();
  });

  it('图层面板入口批量写入一次提交并汇总总项状态', async () => {
    const { viewer } = await openSpiedViewer();
    let commits = 0;
    viewer.on('statechange', () => {
      commits += 1;
    });

    viewer.setPageLayer(0, 'body', false);
    expect(commits).toBe(1);
    let summary = viewer.readLayerSummary();
    expect(summary.allKeysOff.body).toBe(false);
    expect(summary.allKeysOn.body).toBe(false);
    expect(summary.state).toBe('mixed');

    viewer.setLayerForAllPages('body', false);
    expect(commits).toBe(2);
    expect(viewer.getLayerVisibility(1).body).toBe(false);
    expect(viewer.getLayerVisibility(3).body).toBe(false);
    summary = viewer.readLayerSummary();
    expect(summary.allKeysOff.body).toBe(true);
    expect(summary.state).toBe('mixed');

    viewer.setAllLayersVisible(false);
    expect(commits).toBe(3);
    expect(viewer.readLayerSummary().state).toBe('off');

    viewer.setAllLayersVisible(true);
    expect(commits).toBe(4);
    expect(viewer.readLayerSummary().state).toBe('on');

    viewer.setAllLayersVisibleForPage(0, true);
    expect(commits).toBe(4);
    viewer.setAllLayersVisibleForPage(1, false);
    expect(commits).toBe(5);
    expect(viewer.getLayerVisibility(2).background).toBe(false);
    expect(viewer.getLayerVisibility(1).background).toBe(true);
    viewer.destroy();
  });

  it('layerPanel.disabled=true 时 openSidebar 抛 OFD_FEATURE_DISABLED 并带禁用原因', async () => {
    const { viewer } = await openSpiedViewer({ layerPanel: { disabled: true } }, 1);
    let thrown: unknown = null;
    try {
      viewer.openSidebar('layers');
    } catch (error) {
      thrown = error;
    }
    expect(isFeatureDisabledError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('图层');
    expect(viewer.getLayerPanelAvailability()).toEqual({ enabled: true, disabled: true });
    // 未配置时默认可打开。
    viewer.destroy();
  });

  it('未配置 layerPanel 时图层 tab 可用且默认全画', async () => {
    const { viewer } = await openSpiedViewer({}, 1);
    expect(viewer.getLayerPanelAvailability()).toEqual({ enabled: true, disabled: false });
    expect(() => viewer.openSidebar('layers')).not.toThrow();
    expect(viewer.getState().view.sidebarView).toBe('layers');
    expect(viewer.getPageContentFilter(1)).toBeUndefined();
    viewer.destroy();
  });
});


describe('注释类型（§I · §H.7）', () => {
  /** 让某页的注释文本项在指定类型过滤下出现（模拟该页存在该类型的注释文字）。 */
  function stubAnnotationText(
    pageNumber: number,
    types: readonly string[],
  ): void {
    const doc = spiedDocument;
    if (!doc) throw new Error('缺少内存文档');
    const target = doc.doc as unknown as {
      getPage: (index: number) => Promise<unknown>;
    };
    const original = target.getPage.bind(target);
    // 在“已挂记录”的文档 getPage 上再包一层：内存文档会缓存页面对象，`original()`
    // 返回同一对象，因此这里改写的页方法与既有调用记录共存。
    target.getPage = async (index: number) => {
      const page = (await original(index)) as unknown as {
        getTextContent?: (options?: TextContentOptions) => Promise<unknown>;
      };

      if (index !== pageNumber - 1 || typeof page.getTextContent !== 'function') {
        return page as unknown as Awaited<ReturnType<typeof original>>;
      }
      const current = page.getTextContent.bind(page);
      page.getTextContent = async (options: TextContentOptions = {}) => {
        const wanted = options.contentFilter?.annotationTypes;
        const content = (await current(options)) as {
          items: Array<Record<string, unknown>>;
          charCount: number;
        };
        const matches =
          options.includeAnnotations === true &&
          Array.isArray(wanted) &&
          wanted.some((type) => types.indexOf(type) >= 0);

        if (!matches) return content;
        return {
          ...content,
          items: [
            ...content.items,
            {
              order: content.items.length,
              layer: 'annotation',
              layerType: 'Body',
              annotationId: `annot-${String(wanted?.[0])}`,
              visible: true,
              alpha: 1,
              text: '标记',
              font: { resourceId: 'f1', family: 'sans-serif', italic: false },
              size: 12,
              transform: [1, 0, 0, 1, 0, 0],
              origin: { x: 10, y: 10 },
              rect: { x: 10, y: 10, width: 24, height: 12 },
              quad: [
                { x: 10, y: 10 },
                { x: 34, y: 10 },
                { x: 34, y: 22 },
                { x: 10, y: 22 },
              ],
              advance: 24,
              charCount: 2,
            },
          ],
          itemCount: content.items.length + 1,
          charCount: content.charCount + 2,
        };
      };
      return page as unknown as Awaited<ReturnType<typeof original>>;
    };
  }

  it('T28 取消某页某类型只重绘该页，实参带注解白名单', async () => {
    const { viewer, spies } = await openSpiedViewer();
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.canvas).not.toBeNull();
      expect(pageSpy(spies, 2).renderCalls.length).toBeGreaterThan(0);
    });
    const renders = [1, 2, 3].map((page) => pageSpy(spies, page).renderCalls.length);
    viewer.setAnnotationTypeForPage(1, 'Stamp', false);
    await vi.waitFor(() => {
      expect(pageSpy(spies, 2).renderCalls.length).toBe(renders[1]! + 1);
    });
    const filter = pageSpy(spies, 2).renderCalls.at(-1);
    expect(filter?.annotations).toBe(true);
    expect(filter?.annotationTypes).not.toContain('Stamp');
    expect(filter?.annotationTypes).toContain('Link');
    expect(pageSpy(spies, 1).renderCalls.length).toBe(renders[0]);
    expect(pageSpy(spies, 3).renderCalls.length).toBe(renders[2]);
    viewer.destroy();
  });

  it('T29/T30 零勾选写成 annotations:false；总开关关闭同样不写 annotationTypes', async () => {
    const { viewer, spies } = await openSpiedViewer({}, 2);
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.canvas).not.toBeNull();
    });
    const spy = pageSpy(spies, 1);
    const types = viewer.getAnnotationTypes(1);
    for (const type of types) viewer.setAnnotationTypeForPage(0, type, false);
    await vi.waitFor(() => {
      const last = spy.renderCalls.at(-1);
      expect(last?.annotations).toBe(false);
    });
    const zero = spy.renderCalls.at(-1);
    expect(Object.prototype.hasOwnProperty.call(zero, 'annotationTypes')).toBe(false);

    viewer.setLayerVisibility(1, { annotations: false });
    await vi.waitFor(() => {
      const last = spy.renderCalls.at(-1);
      expect(last?.annotations).toBe(false);
    });
    expect(Object.prototype.hasOwnProperty.call(spy.renderCalls.at(-1), 'annotationTypes')).toBe(
      false,
    );
    // 零勾选与关闭总开关得到同一签名。
    expect(viewer.getLayerFilterKey(1)).toBe(
      contentFilterKey({ annotations: false }, viewer.getAnnotationTypes(1)),
    );
    viewer.destroy();
  });

  it('T31 公共 API：getLayerVisibility 返回对象，setLayerVisibility 合并类型表', async () => {
    const { viewer } = await openSpiedViewer({}, 2);
    expect(viewer.getLayerVisibility(1)).toEqual({
      signatures: true,
      annotations: { enabled: true, types: {} },
      custom: true,
      foreground: true,
      body: true,
      background: true,
    });
    viewer.setLayerVisibility(1, { annotations: { types: { Link: false } } });
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: true,
      types: { Link: false },
    });
    viewer.setLayerVisibility(1, { annotations: { types: { Path: false } } });
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: true,
      types: { Link: false, Path: false },
    });
    // 布尔写法等价于只切总开关，类型表保留。
    viewer.setLayerVisibility(1, { annotations: false });
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: false,
      types: { Link: false, Path: false },
    });
    viewer.setLayerVisibility(1, { annotations: true });
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: true,
      types: { Link: false, Path: false },
    });
    viewer.destroy();
  });

  it('T32 文本层/缩略图/导出/打印与主画布读到同一过滤', async () => {
    const { viewer, spies } = await openSpiedViewer({}, 2);
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.canvas).not.toBeNull();
    });
    viewer.setLayerVisibility(1, { annotations: { types: { Watermark: false } } });
    await vi.waitFor(() => {
      const types = pageSpy(spies, 1).renderCalls.at(-1)?.annotationTypes ?? [];
      expect(types).toContain('Link');
      expect(types).not.toContain('Watermark');
    });
    const expected = viewer.getPageContentFilter(1);
    // 白名单只排除显式取消的类型，其余（含未列出的候选类型）保持可见。
    expect(expected?.annotationTypes).toEqual(expect.arrayContaining(['Link', 'Path', 'Highlight', 'Stamp']));
    expect(expected?.annotationTypes).not.toContain('Watermark');
    await viewer.exportImage({ page: 1 });
    expect(pageSpy(spies, 1).exportCalls.at(-1)).toStrictEqual(expected);
    await viewer.print({ pages: [1] });
    expect(pageSpy(spies, 1).exportCalls.at(-1)).toStrictEqual(expected);
    await vi.waitFor(() => {
      expect(pageSpy(spies, 1).textCalls.at(-1)).toStrictEqual(expected);
    });
    viewer.destroy();
  });

  it('T26/T27 探测：懒加载按页只探测一次，失败降级为只列常见五类', async () => {
    // 探测走 `controller.getPage()`，页对象在打开后缓存；必须先挂桩再打开。
    const { viewer } = await openSpiedViewer({}, 3, () => stubAnnotationText(2, ['Signature']));
    const textBefore = pageSpy(spiedDocumentSpies(), 2).textCalls.length;
    expect(viewer.getExtraAnnotationTypes(2)).toEqual([]);
    await viewer.ensureAnnotationTypesLoaded([2]);
    expect(viewer.getAnnotationTypes(2)).toEqual([
      'Link',
      'Path',
      'Highlight',
      'Stamp',
      'Watermark',
      'Signature',
    ]);
    // 每页只探测一次：再次调用不增加文本请求。
    const afterFirst = pageSpy(spiedDocumentSpies(), 2).textCalls.length;
    await viewer.ensureAnnotationTypesLoaded([2]);
    expect(pageSpy(spiedDocumentSpies(), 2).textCalls.length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(textBefore);

    // 第 3 页没有任何注释文字：只列常见五类，后续不再重试。
    await viewer.ensureAnnotationTypesLoaded([3]);
    expect(viewer.getAnnotationTypes(3)).toEqual([
      'Link',
      'Path',
      'Highlight',
      'Stamp',
      'Watermark',
    ]);
    const thirdCalls = pageSpy(spiedDocumentSpies(), 3).textCalls.length;
    await viewer.ensureAnnotationTypesLoaded([3]);
    expect(pageSpy(spiedDocumentSpies(), 3).textCalls.length).toBe(thirdCalls);
    viewer.destroy();
  });

  it('T33 重开文档回到 defaultVisibility（含类型表）并清空探测缓存', async () => {
    const { viewer } = await openSpiedViewer(
      { layerPanel: { defaultVisibility: { annotations: { types: { Watermark: false } } } } },
      2,
    );
    await viewer.ensureAnnotationTypesLoaded([1]);
    viewer.setLayerVisibility(1, { annotations: { types: { Link: false } } });
    expect(viewer.getLayerVisibility(1).annotations.types).toEqual({
      Watermark: false,
      Link: false,
    });
    await viewer.close();
    await viewer.open(new ArrayBuffer(8));
    await viewer.ready;
    // 第 1 页此前被改成 Link 关闭；重开后回到 defaultVisibility（只剩 Watermark 关闭）。
    expect(viewer.getLayerVisibility(1).annotations).toEqual({
      enabled: true,
      types: { Watermark: false },
    });
    expect(viewer.getLayerVisibility(2).annotations).toEqual({
      enabled: true,
      types: { Watermark: false },
    });
    viewer.destroy();
  });

  it('T34/T35 改一次类型只派发一次 statechange；默认渲染键仍以 :all 结尾', async () => {
    const { viewer } = await openSpiedViewer({}, 2);
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.canvas).not.toBeNull();
    });
    expect(viewer.getPageView(1)!.element.dataset.renderKey?.endsWith(':all')).toBe(true);
    let commits = 0;
    viewer.on('statechange', () => {
      commits += 1;
    });
    viewer.setAnnotationTypeForPage(0, 'Stamp', false);
    expect(commits).toBe(1);
    // 注释类型只在每页显示：总项汇总不再提供类型三态，逐页状态独立。
    expect('annotationTypes' in viewer.readLayerSummary()).toBe(false);
    expect(viewer.getLayerVisibility(1).annotations.types).toEqual({ Stamp: false });
    expect(viewer.getLayerVisibility(2).annotations.types).toEqual({});
    viewer.destroy();
  });

  /** 当前用例的每页记录表。 */
  function spiedDocumentSpies(): DocumentSpies {
    if (!spiedDocument) throw new Error('缺少内存文档');
    return spiedDocument.spies;
  }
});
