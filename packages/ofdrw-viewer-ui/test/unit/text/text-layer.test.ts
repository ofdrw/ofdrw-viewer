import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextLayerService, createTextSpan } from '../../../src/text/text-layer';
import { createViewerBridge } from '../../../src/text/viewer-bridge';
import type { FindMatch } from '../../../src/text/types';
import type { SelectionFragment, SelectionModel } from '../../../src/text/selection';
import type { TextContent, TextQuad } from '@ofdrw/ofdrw-viewer-engine';
import type { TextProvider } from './helpers';
import {
  buildTextLayerSpecs,
  buildTextRows,
  cssScaleForDpi,
  MAX_TEXT_LAYER_NODES,
  rowIdOfRef,
} from '../../../src/text/geometry';
import {
  contentWithLines,
  makeChar,
  makeContent,
  makeFakeHost,
  makeItem,
  makePageView,
} from './helpers';
import { UI_WARNING_CODES } from '../../../src/diagnostics';
import { resolveViewerOptions } from '../../../src/options';

/** 等待 setTimeout 级异步任务。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 构造高亮命中。 */
function match(pageNumber: number, id: string, x: number): FindMatch {
  return {
    id,
    pageNumber,
    start: 0,
    end: 1,
    text: 'x',
    boxes: [{ x, y: 10, width: 8, height: 16 }],
  };
}

describe('透明文本层服务', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('只为可见页构建 span，并写入 96 DPI 几何', async () => {
    const contents = new Map([
      [2, contentWithLines(['第二页 Hello'])],
      [3, contentWithLines(['第三页 World'])],
    ]);
    const host = makeFakeHost({
      pageCount: 5,
      pageNumber: 2,
      visiblePageRange: { start: 1, end: 2 },
      contents,
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
    });
    await vi.waitFor(() => {
      expect(
        host.getPageView(3)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBeGreaterThan(0);
    });
    const layer = host.getPageView(2)!.textLayer;
    expect(layer.dataset.dpi).toBe('96');
    // 布局框取“纸面尺寸 / 布局倍率”，再由显式 scale 放大回纸面，与 canvas 重合。
    expect(layer.style.transform).toBe('scale(1)');
    expect(layer.style.width).toBe(`${(210 / 25.4) * 96}px`);
    expect(layer.style.height).toBe(`${(297 / 25.4) * 96}px`);
    const span = layer.querySelector<HTMLElement>('.ofd-text-item')!;
    expect(span.textContent).toBe('第二页 Hello');
    // 不变样式由 CSS class 提供；水平文字的恒等 transform 不写内联样式。
    expect(span.className).toBe('ofd-text-item');
    expect(span.style.color).toBe('');
    expect(span.style.cursor).toBe('');
    expect(span.style.transform).toBe('');
    // 未可见页不加载。
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(host.textCalls).not.toContain(1);
    service.destroy();
  });

  it('缩放/旋转由页面容器承担，文本层坐标不重算', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    const layer = host.getPageView(1)!.textLayer;
    const before = layer.querySelector<HTMLElement>('.ofd-text-item')!.style.left;
    host.setView({ scale: 2 });
    host.setView({ rotation: 90 });
    await flush();
    // 缩放/旋转不重算 span 坐标：坐标始终以 96 DPI 基准存放，由图层变换承担。
    expect(layer.querySelector<HTMLElement>('.ofd-text-item')!.style.left).toBe(before);
    service.destroy();
  });

  it('布局倍率变化后文字层布局框按纸面尺寸换算', async () => {
    const view = makePageView(1);
    // 纸面 800×1131（含 2 倍布局倍率）对应 96 DPI 基准 400×565.5。
    Object.assign(view as unknown as Record<string, number>, {
      surfaceWidth: 800,
      surfaceHeight: 1131,
      layoutScale: 2,
    });
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
      pageViews: new Map([[1, view]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(view.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    expect(view.textLayer.style.width).toBe('400px');
    expect(view.textLayer.style.height).toBe('565.5px');
    expect(view.textLayer.style.transform).toBe('scale(2)');
    service.destroy();
  });

  it.each([0.5, 1, 1.25, 2, 4])(
    '布局倍率 %s 下文字层布局框与纸面换算一致',
    async (scale) => {
      // 纸面尺寸 = 96 DPI 页尺寸 × 倍率；布局框应为其除以倍率后的 96 DPI 基准尺寸，
      // 再由 scale(倍率) 放大回纸面。若把纸面尺寸直接当布局框（或漏乘倍率），
      // 缩放后文字层会与 canvas 相差一个倍率。
      const baseW = (210 / 25.4) * 96;
      const baseH = (297 / 25.4) * 96;
      const view = makePageView(1);
      Object.assign(view as unknown as Record<string, number>, {
        surfaceWidth: baseW * scale,
        surfaceHeight: baseH * scale,
        layoutScale: scale,
      });
      const host = makeFakeHost({
        pageCount: 1,
        contents: new Map([[1, contentWithLines(['Hello'])]]),
        pageViews: new Map([[1, view]]),
      });
      const service = new TextLayerService(host, createViewerBridge(host));
      await vi.waitFor(() => {
        expect(view.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
      });
      expect(Number.parseFloat(view.textLayer.style.width)).toBeCloseTo(baseW, 5);
      expect(Number.parseFloat(view.textLayer.style.height)).toBeCloseTo(baseH, 5);
      expect(view.textLayer.style.transform).toBe(`scale(${scale})`);
      service.destroy();
    },
  );

  it('查找高亮层与文字层共用同一布局框与倍率', async () => {
    const scale = 2;
    const view = makePageView(1);
    Object.assign(view as unknown as Record<string, number>, {
      surfaceWidth: (210 / 25.4) * 96 * scale,
      surfaceHeight: (297 / 25.4) * 96 * scale,
      layoutScale: scale,
    });
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
      pageViews: new Map([[1, view]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(view.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    service.setFindMatches([match(1, '1:0', 10)], 1, true);
    const layer = view.surface.querySelector<HTMLElement>('.ofd-page__find-layer')!;
    expect(layer.style.width).toBe(view.textLayer.style.width);
    expect(layer.style.height).toBe(view.textLayer.style.height);
    expect(layer.style.transform).toBe(view.textLayer.style.transform);
    service.destroy();
  });

  it('features.selection=false 时关闭 user-select', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      features: { selection: false },
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    const layer = host.getPageView(1)!.textLayer;
    expect(layer.dataset.selectable).toBe('false');
    expect(layer.style.userSelect).toBe('none');
    expect(layer.querySelector<HTMLElement>('.ofd-text-item')!.style.userSelect).toBe('');
    service.destroy();
  });

  it('features.textLayer=false 时清空并隐藏文本层', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    host.setFeatures({ textLayer: false });
    // 刷新调度在下一帧（rAF）：一帧内完成清空与隐藏。
    await nextFrame();
    const layer = host.getPageView(1)!.textLayer;
    expect(layer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(layer.hidden).toBe(true);
    service.destroy();
  });

  it('文本提取失败只告警一次，离开可见区后允许重试', async () => {
    let attempts = 0;
    const provider = async () => {
      attempts += 1;
      throw new Error('boom');
    };
    const host = makeFakeHost({
      pageCount: 2,
      pageNumber: 1,
      visiblePageRange: { start: 0, end: 0 },
      contents: new Map<number, TextProvider>([
        [1, provider],
        [2, async () => contentWithLines(['第二页'])],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
    });
    await vi.waitFor(() => expect(attempts).toBe(1));
    host.setView({ scale: 2 });
    host.setView({ pageNumber: 2, visiblePageRange: { start: 1, end: 1 } });
    // 刷新在下一帧执行：等该页构建完成，确认失败页离开可见区后不会重复请求。
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    expect(attempts).toBe(1);
    expect(host.warnings.filter((warning) => warning.code === UI_WARNING_CODES.W_TEXT_LOAD)).toHaveLength(1);
    host.setView({ pageNumber: 1, visiblePageRange: { start: 0, end: 0 } });
    await vi.waitFor(() => expect(attempts).toBe(2));
    service.destroy();
  });

  it('不创建 canvas、不调用 Canvas 文字 API', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    expect(getContext).not.toHaveBeenCalled();
    expect(host.getPageView(1)!.surface.querySelectorAll('canvas')).toHaveLength(0);
    service.destroy();
  });

  it('可见页变化后旧页的迟到结果被代次丢弃', async () => {
    let resolveFirst: ((value: ReturnType<typeof contentWithLines>) => void) | null = null;
    const first = new Promise<ReturnType<typeof contentWithLines>>((resolve) => {
      resolveFirst = resolve;
    });
    const contents = new Map<number, ReturnType<typeof contentWithLines> | (() => Promise<ReturnType<typeof contentWithLines>>)>([
      [1, () => first],
      [2, contentWithLines(['第二页'])],
    ]);
    const host = makeFakeHost({
      pageCount: 2,
      pageNumber: 1,
      visiblePageRange: { start: 0, end: 0 },
      contents,
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
    });
    await vi.waitFor(() => expect(host.textCalls).toContain(1));
    host.setView({ pageNumber: 2, visiblePageRange: { start: 1, end: 1 } });
    await vi.waitFor(() => expect(host.textCalls).toContain(2));
    // 页级缓存下旧页默认保留；显式淘汰后迟到结果必须丢弃。
    service.releasePage(1);
    resolveFirst!(contentWithLines(['旧页迟到结果']));
    await flush();
    await flush();
    expect(
      host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item'),
    ).toHaveLength(0);
    service.destroy();
  });

  it('查找高亮独立覆盖层且不影响选区', async () => {
    const host = makeFakeHost({ pageCount: 2 });
    const service = new TextLayerService(host, createViewerBridge(host));
    service.setFindMatches(
      [match(1, '1:0', 10), match(1, '1:1', 30), match(2, '2:0', 5)],
      1,
      true,
    );
    const surface = host.getPageView(1)!.surface;
    const layer = surface.querySelector<HTMLElement>('.ofd-page__find-layer')!;
    expect(layer).not.toBeNull();
    expect(layer.style.pointerEvents).toBe('none');
    // 高亮层与文字层共用 applyLayerScale：布局框为 96 DPI 页尺寸，按显式倍率放大。
    expect(layer.style.transform).toBe('scale(1)');
    expect(layer.style.width).toBe(`${(210 / 25.4) * 96}px`);
    expect(layer.style.height).toBe(`${(297 / 25.4) * 96}px`);
    const boxes = layer.querySelectorAll<HTMLElement>('.ofd-find-highlight');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.dataset.current).toBe('true');
    expect(boxes[0]!.style.left).toBe('10px');
    expect(host.getPageViews()[0]!.textLayer.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);

    service.setFindMatches([match(1, '1:0', 10), match(1, '1:1', 30)], 2, false);
    expect(layer.querySelectorAll('.ofd-find-highlight')).toHaveLength(1);
    expect(layer.querySelector<HTMLElement>('.ofd-find-highlight')!.dataset.matchId).toBe('1:1');

    service.clearFindHighlights();
    expect(layer.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);
    service.destroy();
  });

  it('滚动当前命中会切换页码并调用 scrollIntoView', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const host = makeFakeHost({ pageCount: 2 });
    const service = new TextLayerService(host, createViewerBridge(host));
    const target = match(2, '2:0', 12);
    service.setFindMatches([target], 1, true);
    service.scrollToMatch(target);
    expect(host.goToPageCalls).toEqual([2]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
    service.destroy();
  });

  it('文档关闭时清空文本层与高亮', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    service.setFindMatches([match(1, '1:0', 10)], 1, true);
    host.emit('documentclose', {});
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(host.getPageView(1)!.surface.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);
    service.destroy();
  });

});
/** 记录行增减与 span 创建次数；用于差量与抖动断言。 */
function observeLayerMutations(layer: HTMLElement): {
  readonly created: Map<string, number>;
  readonly addedRows: number;
  readonly removedRows: number;
} {
  const created = new Map<string, number>();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of [...record.addedNodes]) {
        if (!(node instanceof HTMLElement) || !node.classList.contains('ofd-text-item')) continue;
        const key = node.dataset.itemIndex ?? '';
        created.set(key, (created.get(key) ?? 0) + 1);
      }
    }
  });
  observer.observe(layer, { childList: true });
  return { created, addedRows: 0, removedRows: 0 };
}

/** 等待下一帧。 */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * 构造“页盒位于可滚动主区中”的宿主；页高 600（96 DPI）、容器高 300。
 *
 * @param pageCount 页数。
 * @param content 每页内容。
 * @param pageTopOf 第 n 页的屏幕顶边；默认页 1 在 0、后续页依次下移。
 * @returns 宿主、页视图与容器。
 */
function setupScrolledPage(
  pageCount: number,
  content: ReturnType<typeof contentWithLines>,
  pageTopOf: (pageNumber: number) => number = (pageNumber) => (pageNumber - 1) * 600,
): { host: ReturnType<typeof makeFakeHost>; scroller: HTMLElement; views: Map<number, ReturnType<typeof makePageView>> } {
  const scroller = document.createElement('div');
  scroller.className = 'ofd-viewer__main';
  scroller.style.overflowY = 'auto';
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 400 });
  const views = new Map<number, ReturnType<typeof makePageView>>();
  for (let page = 1; page <= pageCount; page += 1) {
    const view = makePageView(page);
    Object.assign(view as unknown as Record<string, number>, { surfaceWidth: 400, surfaceHeight: 600 });
    scroller.appendChild(view.element);
    views.set(page, view);
  }
  document.body.appendChild(scroller);
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const page = (this as HTMLElement).dataset.pageNumber;
      if (this.classList.contains('ofd-page') && page) {
        const top = pageTopOf(Number(page));
        return { left: 0, top, width: 400, height: 600, right: 400, bottom: top + 600 };
      }
      if (this === scroller) {
        return { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 };
      }
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    },
  });
  const contents = new Map<number, ReturnType<typeof contentWithLines>>();
  for (let page = 1; page <= pageCount; page += 1) contents.set(page, content);
  const host = makeFakeHost({ pageCount, contents, pageViews: views, root: scroller });
  return { host, scroller, views };
}

describe('页级整页构建与缓存', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  /** 生成 60 行文本内容。 */
  function longContent(lines = 60) {
    return contentWithLines(
      Array.from({ length: lines }, (_, index) => `第 ${index + 1} 行 hello`),
      { lineHeight: 20 },
    );
  }

  it('页进入可见集后一次性构建全部行，滚动期间不增删 span', async () => {
    const view = makePageView(1);
    Object.assign(view as unknown as Record<string, number>, {
      surfaceWidth: 400,
      surfaceHeight: 600,
    });
    const content = longContent();
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, content]]),
      pageViews: new Map([[1, view]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    await vi.waitFor(() => {
      expect(view.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(60);
    });
    const before = [...view.textLayer.children];
    host.setView({ scrollTop: 300 });
    await flush();
    await flush();
    const after = [...view.textLayer.children];
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]);
    expect(after[after.length - 1]).toBe(before[before.length - 1]);
    expect(view.textLayer.querySelector('[data-item-index="0"]')).not.toBeNull();
    expect(view.textLayer.querySelector('[data-item-index="59"]')).not.toBeNull();
    service.destroy();
  });

  it('滚动中不为首次访问页构建，停止 150ms 后统一构建', async () => {
    const host = makeFakeHost({
      pageCount: 2,
      pageNumber: 1,
      visiblePageRange: { start: 0, end: 0 },
      contents: new Map([
        [1, contentWithLines(['第一页'])],
        [2, contentWithLines(['第二页'])],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), { overscan: 0 });
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    host.setView({ pageNumber: 2, visiblePageRange: { start: 1, end: 1 } });
    await flush();
    // 150ms settle 之前不构建新页。
    expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    service.destroy();
  });

  it('getPage 晚到且仍在滚动：不抽取，settle 后只抽取一次', async () => {
    const host = makeFakeHost({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 0 },
      contents: new Map([
        [1, contentWithLines(['第一页'])],
        [2, contentWithLines(['第二页'])],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
      settleMs: 30,
    });
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    const originalGetPage = host.getPage.bind(host);
    let releasePage!: (page: Awaited<ReturnType<typeof host.getPage>>) => void;
    const pageGate = new Promise<Awaited<ReturnType<typeof host.getPage>>>((resolve) => {
      releasePage = resolve;
    });
    host.getPage = (pageNumber: number) =>
      pageNumber === 2 ? pageGate : originalGetPage(pageNumber);

    host.setView({ pageNumber: 2, visiblePageRange: { start: 1, end: 1 } });
    await flush();
    const page2 = await originalGetPage(2);
    // 页句柄返回前继续滚动：loadPage 续体必须看到未 settle 并只保存句柄。
    host.setView({ scrollTop: 80 });
    releasePage(page2);
    await flush();
    expect(host.textCalls).not.toContain(2);

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    expect(host.textCalls.filter((page) => page === 2)).toHaveLength(1);
    service.destroy();
  });

  it('内容已缓存但建 span 前滚走：仍计入页数据并可释放后重新抽取', async () => {
    let releaseContent!: (content: TextContent) => void;
    const contentGate = new Promise<TextContent>((resolve) => {
      releaseContent = resolve;
    });
    const host = makeFakeHost({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 0 },
      contents: new Map<number, TextProvider>([
        [1, contentWithLines(['第一页'])],
        [2, () => contentGate],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
      settleMs: 30,
    });
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    host.setView({ pageNumber: 2, visiblePageRange: { start: 1, end: 1 } });
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    await vi.waitFor(() => expect(host.textCalls).toContain(2));

    // 抽取进行中继续滚动：抽取完成后只能缓存内容，不能建 span。
    host.setView({ scrollTop: 80 });
    releaseContent(contentWithLines(['第二页']));
    await flush();
    expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(service.hasTextData(2)).toBe(true);

    service.releasePage(2);
    expect(service.hasTextData(2)).toBe(false);
    service.refresh();
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    expect(host.textCalls.filter((page) => page === 2)).toHaveLength(2);
    service.destroy();
  });

  it('releasePage 清理文本层与查找层，但保留快照选区层；重进时重新构建', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    service.setFindMatches([match(1, '1:0', 10)], 1, true);
    service.renderSelection({
      fragments: [
        {
          text: 'H',
          pageNumber: 1,
          rowId: '0:0',
          quad: [
            { x: 10, y: 100 },
            { x: 20, y: 100 },
            { x: 20, y: 116 },
            { x: 10, y: 116 },
          ] as unknown as TextQuad,
          axisRowRad: 0,
        },
      ],
      mode: 'vector',
    });
    expect(host.getPageView(1)!.surface.querySelector('.ofd-page__selection-layer')).not.toBeNull();
    expect(host.getPageView(1)!.surface.querySelector('.ofd-page__find-layer')).not.toBeNull();
    service.releasePage(1);
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    // span 已淘汰，但最后模型仍覆盖该页：选区层与矩形必须保留。
    expect(host.getPageView(1)!.surface.querySelector('.ofd-page__selection-layer')).not.toBeNull();
    expect(
      host.getPageView(1)!.surface.querySelectorAll('.ofd-selection-rect'),
    ).toHaveLength(1);
    expect(host.getPageView(1)!.surface.querySelector('.ofd-page__find-layer')).toBeNull();
    expect(service.getCharQuads(1, [{ itemIndex: 0, charIndex: 0 }])).toEqual([null]);
    service.refresh();
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    expect(host.textCalls.filter((page) => page === 1)).toHaveLength(2);
    service.destroy();
  });

  it('选区只 pin 首尾端点页，释放后 pin 清零', async () => {
    const host = makeFakeHost({
      pageCount: 3,
      visiblePageRange: { start: 0, end: 2 },
      contents: new Map([
        [1, contentWithLines(['第一页'])],
        [2, contentWithLines(['第二页'])],
        [3, contentWithLines(['第三页'])],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    await vi.waitFor(() => {
      expect(host.getPageView(3)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    const fragment = (pageNumber: number): SelectionFragment => ({
      text: '文',
      pageNumber,
      rowId: '0:0',
      quad: null,
      axisRowRad: 0,
    });
    service.renderSelection({ fragments: [fragment(1), fragment(2), fragment(3)], mode: 'vector' });
    expect(service.getPinnedPages()).toEqual([1, 3]);
    expect(service.getPinnedSpanCount()).toBe(2);
    // 新选区替换旧选区时，旧端点页 pin 立即释放。
    // 中间页不 pin，可被淘汰；重建后按缓存模型补回高亮。
    service.releasePage(2);
    service.refresh();
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    expect(host.getPageView(2)!.surface.querySelector('.ofd-page__selection-layer')).not.toBeNull();
    service.renderSelection({ fragments: [fragment(2)], mode: 'vector' });
    expect(service.getPinnedPages()).toEqual([2]);
    expect(service.getPinnedSpanCount()).toBe(1);
    service.renderSelection({ fragments: [], mode: 'vector' });
    expect(service.getPinnedPages()).toEqual([]);
    expect(service.getPinnedSpanCount()).toBe(0);
    service.destroy();
  });

  it('pin span 超预算时拒绝并保持无 pin', async () => {
    const host = makeFakeHost({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 1 },
      contents: new Map([
        [1, contentWithLines(['第一页'])],
        [2, contentWithLines(['第二页'])],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      settleMs: 0,
      selectionPinSpanBudget: 1,
    });
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    const fragments: SelectionFragment[] = [1, 2].map((pageNumber) => ({
      text: '文',
      pageNumber,
      rowId: '0:0',
      quad: null,
      axisRowRad: 0,
    }));
    // 先接受一个端点页，再提交超预算的两端点选区：旧 pin 也必须释放。
    service.renderSelection({ fragments: [fragments[0]!], mode: 'vector' });
    expect(service.getPinnedPages()).toEqual([1]);
    service.renderSelection({ fragments, mode: 'vector' });
    expect(service.getPinnedPages()).toEqual([]);
    expect(service.getPinnedSpanCount()).toBe(0);
    expect(host.getPageView(1)!.surface.querySelector('.ofd-page__selection-layer')).toBeNull();
    service.destroy();
  });

  it('pin 后分帧增长超出预算：解除 pin、清空快照并告警', async () => {
    const content = contentWithLines(
      Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行`),
      { lineHeight: 20 },
    );
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, content]]),
    });
    let cleared = 0;
    (host as typeof host & { textLayerPinBudgetExceeded?: () => void }).textLayerPinBudgetExceeded =
      () => {
        cleared += 1;
      };
    const service = new TextLayerService(host, createViewerBridge(host), {
      settleMs: 0,
      selectionPinSpanBudget: 100,
    });
    service.renderSelection({
      fragments: [{ text: '第', pageNumber: 1, rowId: '0:0', quad: null, axisRowRad: 0 }],
      mode: 'vector',
    });
    expect(service.getPinnedPages()).toEqual([1]);

    await vi.waitFor(() => {
      expect(host.warnings.some((warning) => warning.code === 'W_SELECTION_UNPINNABLE')).toBe(
        true,
      );
    });
    expect(service.getPinnedPages()).toEqual([]);
    expect(service.getPinnedSpanCount()).toBe(0);
    expect(cleared).toBe(1);
    service.destroy();
  });

  it('文档关闭时清空 pin 与文本层', async () => {
    const host = makeFakeHost({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 1 },
      contents: new Map([
        [1, contentWithLines(['第一页'])],
        [2, contentWithLines(['第二页'])],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    service.renderSelection({
      fragments: [
        { text: 'a', pageNumber: 1, rowId: '0:0', quad: null, axisRowRad: 0 },
        { text: 'b', pageNumber: 2, rowId: '0:0', quad: null, axisRowRad: 0 },
      ],
      mode: 'vector',
    });
    expect(service.getPinnedPages()).toEqual([1, 2]);
    host.setFeatures({ selection: false });
    expect(service.getPinnedPages()).toEqual([]);
    host.emit('documentclose', {});
    expect(service.getPinnedPages()).toEqual([]);
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    service.destroy();
  });
});

describe('字符几何与行归属查询（选区模型数据源）', () => {
  it('getCharQuads 返回 96 DPI 四边形，getRowIdOf 按 TextRow 查表', async () => {
    const content = makeContent([
      makeItem({ text: '甲乙', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '丙丁', x: 10, y: 130, size: 16, order: 1 }),
    ]);
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, content]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(
        host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(2);
    });
    const layout = buildTextRows(content);
    expect(service.getAxisRowRad(1)).toBe(layout.axisRowRad);
    expect(service.getRowIdOf(1, { itemIndex: 0, charIndex: 1 })).toBe(layout.rows[0]!.id);
    expect(service.getRowIdOf(1, { itemIndex: 1, charIndex: 0 })).toBe(layout.rows[1]!.id);
    const quads = service.getCharQuads(1, [
      { itemIndex: 0, charIndex: 0 },
      { itemIndex: 1, charIndex: 1 },
    ]);
    expect(quads[0]).toEqual(content.items[0]!.chars![0]!.quad);
    expect(quads[1]).toEqual(content.items[1]!.chars![1]!.quad);
    // 未加载的页：内容/行表均未就绪，返回 null 由选区回退 legacy。
    expect(service.getCharQuads(2, [{ itemIndex: 0, charIndex: 0 }])).toEqual([null]);
    expect(service.getRowIdOf(2, { itemIndex: 0, charIndex: 0 })).toBeNull();
    expect(service.getAxisRowRad(2)).toBeNull();
    service.destroy();
  });

  it('getCharQuads 把引擎输出 DPI 换算到 96 DPI 文本层坐标', async () => {
    const content = makeContent(
      [makeItem({ text: '甲', x: 10, y: 100, size: 16, order: 0 })],
      { dpi: 192 },
    );
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, content]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(
        host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(1);
    });
    const quad = service.getCharQuads(1, [{ itemIndex: 0, charIndex: 0 }])[0]!;
    const source = content.items[0]!.chars![0]!.quad;
    for (let index = 0; index < 4; index += 1) {
      expect(quad[index]!.x).toBeCloseTo(source[index]!.x * 0.5, 6);
      expect(quad[index]!.y).toBeCloseTo(source[index]!.y * 0.5, 6);
    }
    service.destroy();
  });

  it('字符级 span 的行归属按 charIndex 精确匹配', async () => {
    const item = makeItem({
      text: '汉',
      x: 10,
      y: 100,
      size: 16,
      chars: [makeChar('汉', 10, 100, 16, 16, Math.PI / 3)],
    });
    const content = makeContent([item]);
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, content]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(
        host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-char').length,
      ).toBe(1);
    });
    const layout = buildTextRows(content);
    expect(service.getRowIdOf(1, { itemIndex: 0, charIndex: 0 })).toBe(layout.rows[0]!.id);
    // 该 item 只有 charIndex 0 的字符 span，其它下标无法匹配。
    expect(service.getRowIdOf(1, { itemIndex: 0, charIndex: 1 })).toBeNull();
    service.destroy();
  });
});

describe('选区块状高亮层', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  /** 由文本内容构造整页选区模型；片段覆盖全部字符。 */
  function selectionModelOf(content: TextContent, pageNumber: number): SelectionModel {
    const layout = buildTextRows(content);
    const scale = cssScaleForDpi(content.dpi);
    const fragments: SelectionFragment[] = [];
    for (const [itemIndex, item] of (content.items ?? []).entries()) {
      for (const [charIndex, char] of (item.chars ?? []).entries()) {
        fragments.push({
          text: char.text,
          pageNumber,
          rowId: rowIdOfRef(layout.rows, { itemIndex, charIndex }),
          quad: char.quad.map((point) => ({
            x: point.x * scale,
            y: point.y * scale,
          })) as unknown as TextQuad,
          axisRowRad: layout.axisRowRad,
        });
      }
    }
    return { fragments, mode: 'vector' };
  }

  it('选区层挂在纸面、位于文字层与查找层之间，按行合并并留 1px 缝隙', async () => {
    // 行距 9 < 行高 16：行划分为两行，但字符 quad 纵向重叠 7px。
    const content = contentWithLines(['第一行', '第二行'], { lineHeight: 9 });
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(2);
    });
    service.renderSelection(selectionModelOf(content, 1));

    const view = host.getPageView(1)!;
    const layer = view.surface.querySelector<HTMLElement>('.ofd-page__selection-layer')!;
    expect(layer).not.toBeNull();
    expect(layer.parentElement).toBe(view.surface);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.style.zIndex).toBe('2');
    // 与文本层共用同一套布局框与缩放，保证和文字对齐。
    expect(layer.style.width).toBe(view.textLayer.style.width);
    expect(layer.style.height).toBe(view.textLayer.style.height);
    expect(layer.style.transform).toBe(view.textLayer.style.transform);
    const children = [...view.surface.children];
    expect(children.indexOf(layer)).toBeGreaterThan(children.indexOf(view.textLayer));

    service.setFindMatches([match(1, '1:0', 10)], 1, true);
    const findLayer = view.surface.querySelector<HTMLElement>('.ofd-page__find-layer')!;
    expect(findLayer).not.toBeNull();
    expect(Number(findLayer.style.zIndex)).toBeGreaterThan(Number(layer.style.zIndex));
    expect([...view.surface.children].indexOf(findLayer)).toBeGreaterThan(children.indexOf(layer));

    const rects = [...layer.querySelectorAll<HTMLElement>('.ofd-selection-rect')];
    // 两个字符 span 分属两行 → 恰好两个矩形；同行字符已合并。
    expect(rects).toHaveLength(2);
    const first = rects[0]!;
    const second = rects[1]!;
    const firstTop = Number.parseFloat(first.style.top);
    const firstHeight = Number.parseFloat(first.style.height);
    const secondTop = Number.parseFloat(second.style.top);
    expect(firstHeight).toBeGreaterThan(0);
    expect(secondTop - (firstTop + firstHeight)).toBeCloseTo(1);
    // 同行相邻 span 的矩形是一个整体，宽度覆盖整行。
    expect(Number.parseFloat(first.style.width)).toBeGreaterThan(20);
    expect(view.element.dataset.selectionMode).toBeUndefined();
    service.destroy();
  });

  it('同一行内矮矩形按自身高度收缩，零高缺口不出现（O1）', () => {
    const content = contentWithLines(['第一行', '第二行'], { lineHeight: 9 });
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    const view = host.getPageView(1)!;
    const quad = (x: number, top: number, width: number, height: number): TextQuad =>
      [
        { x, y: top },
        { x: x + width, y: top },
        { x: x + width, y: top + height },
        { x, y: top + height },
      ] as unknown as TextQuad;
    service.renderSelection({
      mode: 'vector',
      fragments: [
        // 正常行 a：高 16px。
        {
          text: 'a',
          pageNumber: 1,
          rowId: 'row-a',
          quad: quad(10, 100, 10, 16),
          axisRowRad: 0,
        },
        // 同一行内的矮矩形：高仅 0.2px。
        {
          text: 'b',
          pageNumber: 1,
          rowId: 'row-a',
          quad: quad(30, 100, 10, 0.2),
          axisRowRad: 0,
        },
        // 相邻行 b：高 16px，与上行原本无缝隙。
        {
          text: 'c',
          pageNumber: 1,
          rowId: 'row-b',
          quad: quad(10, 116, 10, 16),
          axisRowRad: 0,
        },
      ],
    });
    const rects = [
      ...view.surface.querySelectorAll<HTMLElement>('.ofd-selection-rect'),
    ];
    expect(rects).toHaveLength(3);
    const heights = rects.map((rect) => Number.parseFloat(rect.style.height));
    const widths = rects.map((rect) => Number.parseFloat(rect.style.width));
    expect(Math.min(...heights)).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeLessThan(1);
    // 矮矩形仍有可见面积，不是被钳成 0 高的空壳。
    expect(heights[1]! * widths[1]!).toBeGreaterThan(0);
    service.destroy();
  });

  it('选区矩形渲染抛异常时清理块状层、回退 native 并告警（O3）', () => {
    const content = contentWithLines(['Hello']);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    const view = host.getPageView(1)!;
    const model: SelectionModel = {
      mode: 'vector',
      fragments: [
        {
          text: 'H',
          pageNumber: 1,
          rowId: 'row-a',
          quad: [
            { x: 10, y: 100 },
            { x: 20, y: 100 },
            { x: 20, y: 116 },
            { x: 10, y: 116 },
          ] as unknown as TextQuad,
          axisRowRad: 0,
        },
      ],
    };
    const insertBefore = vi
      .spyOn(view.surface, 'insertBefore')
      .mockImplementation(() => {
        throw new Error('insert failed');
      });
    expect(() => service.renderSelection(model)).not.toThrow();
    expect(insertBefore).toHaveBeenCalled();
    expect(view.element.dataset.selectionMode).toBe('native');
    expect(view.surface.querySelector('.ofd-page__selection-layer')).toBeNull();
    expect(host.warnings.some((warning) => warning.code === 'W_SELECTION_RENDER')).toBe(true);
    service.destroy();
  });

  it('同一行的多个 item span 合并为一个矩形', async () => {
    const content = makeContent([
      makeItem({ text: 'Hello', x: 10, y: 100, order: 0 }),
      makeItem({ text: 'World', x: 50, y: 100, order: 1 }),
    ]);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(2);
    });
    service.renderSelection(selectionModelOf(content, 1));
    const rects = host
      .getPageView(1)!
      .surface.querySelectorAll<HTMLElement>('.ofd-selection-rect');
    expect(rects).toHaveLength(1);
    expect(Number.parseFloat(rects[0]!.style.left)).toBeCloseTo(10);
    // Hello(40px) 与 World(40px) 首尾相接 → flow 并集宽 80px。
    expect(Number.parseFloat(rects[0]!.style.width)).toBeCloseTo(80);
    service.destroy();
  });

  it('多页选区每页各自渲染，不跨页合并', async () => {
    const contents = new Map([
      [1, contentWithLines(['第一页'])],
      [2, contentWithLines(['第二页'])],
    ]);
    const host = makeFakeHost({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 1 },
      contents,
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    const fragments = [
      ...selectionModelOf(contents.get(1)!, 1).fragments,
      ...selectionModelOf(contents.get(2)!, 2).fragments,
    ];
    service.renderSelection({ fragments, mode: 'vector' });
    for (const pageNumber of [1, 2]) {
      const view = host.getPageView(pageNumber)!;
      const rects = view.surface.querySelectorAll<HTMLElement>('.ofd-selection-rect');
      expect(rects).toHaveLength(1);
      expect(Number.parseFloat(rects[0]!.style.left)).toBeCloseTo(10);
    }
    service.destroy();
  });

  it('竖排文字（主轴 π/2）输出绕中心旋转的矩形，且相邻列不重叠', async () => {
    // 竖排两列：主轴 π/2，flow 沿 y；按整页构建（文本层已知限制）。
    const angle = Math.PI / 2;
    const content = makeContent([
      makeItem({ text: '甲乙', x: 100, y: 100, angleRad: angle, order: 0 }),
      makeItem({ text: '丙丁', x: 150, y: 100, angleRad: angle, order: 1 }),
    ]);
    expect(buildTextRows(content).axisRowRad).toBeCloseTo(angle);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(2);
    });
    service.renderSelection(selectionModelOf(content, 1));
    const rects = [
      ...host.getPageView(1)!.surface.querySelectorAll<HTMLElement>('.ofd-selection-rect'),
    ];
    expect(rects).toHaveLength(2);
    for (const rect of rects) {
      expect(rect.style.transform).toBe(`rotate(${angle}rad)`);
      expect(rect.style.transformOrigin).toBe('50% 50%');
    }
    const centers = rects.map(
      (rect) => Number.parseFloat(rect.style.left) + Number.parseFloat(rect.style.width) / 2,
    );
    // 两列中心在 x 方向相距 50px，每列旋转后占 16px 宽 → 间隙 34px，不重叠。
    expect(Math.abs(centers[1]! - centers[0]!)).toBeCloseTo(50);
    expect(Number.parseFloat(rects[0]!.style.height)).toBeCloseTo(16);
  });

  it('缩放 50%/150%/200% 后选区层布局框跟随文本层，旋转不重算矩形', async () => {
    // 小页（约 378×302）保证 2 倍缩放后整页仍在默认视口内，旋转 180° 时行不会被裁掉。
    const content = contentWithLines(['Hello'], { widthMm: 100, heightMm: 80 });
    const view = makePageView(1);
    const baseWidth = content.pageWidth;
    const baseHeight = content.pageHeight;
    Object.assign(view as unknown as Record<string, number>, {
      surfaceWidth: baseWidth,
      surfaceHeight: baseHeight,
    });
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, content]]),
      pageViews: new Map([[1, view]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(view.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    service.renderSelection(selectionModelOf(content, 1));
    const layer = view.surface.querySelector<HTMLElement>('.ofd-page__selection-layer')!;
    const rect = layer.querySelector<HTMLElement>('.ofd-selection-rect')!;
    const left = rect.style.left;
    for (const scale of [0.5, 1, 1.5, 2]) {
      Object.assign(view as unknown as Record<string, number>, {
        surfaceWidth: baseWidth * scale,
        surfaceHeight: baseHeight * scale,
        layoutScale: scale,
      });
      host.setView({ scale });
      await flush();
      await nextFrame();
      expect(layer.style.transform).toBe(`scale(${scale})`);
      expect(layer.style.width).toBe(`${baseWidth}px`);
      expect(layer.style.width).toBe(view.textLayer.style.width);
      expect(layer.style.transform).toBe(view.textLayer.style.transform);
      // 96 DPI 基准坐标不因缩放改变。
      expect(rect.style.left).toBe(left);
    }
    for (const rotation of [90, 180, 270] as const) {
      host.setView({ rotation });
      await flush();
      await nextFrame();
      expect(rect.style.left).toBe(left);
      expect(layer.querySelectorAll('.ofd-selection-rect')).toHaveLength(1);
      expect(layer.style.transform).toBe(view.textLayer.style.transform);
    }
    service.destroy();
  });

  it('legacy 模式恢复原生高亮，空模型清空选区层', async () => {
    const content = contentWithLines(['Hello']);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    service.renderSelection(selectionModelOf(content, 1));
    const view = host.getPageView(1)!;
    expect(view.surface.querySelector('.ofd-page__selection-layer')).not.toBeNull();

    service.renderSelection({ fragments: [], mode: 'legacy' });
    expect(view.element.dataset.selectionMode).toBe('native');
    expect(view.surface.querySelector('.ofd-page__selection-layer')).toBeNull();

    service.renderSelection({ fragments: [], mode: 'vector' });
    expect(view.element.dataset.selectionMode).toBeUndefined();
    expect(view.surface.querySelector('.ofd-page__selection-layer')).toBeNull();
    service.destroy();
  });

  it('滚动后选区层仍保留，span 不被移除', async () => {
    const content = contentWithLines(
      Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行 hello`),
      { lineHeight: 20 },
    );
    const { host, views } = setupScrolledPage(1, content, () => 0);
    const service = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    const view = views.get(1)!;
    await vi.waitFor(() => {
      expect(view.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(60);
    });
    const firstRowId = buildTextRows(content).rows[0]!.id;
    service.renderSelection({
      fragments: [
        {
          text: '第 1 行 hello',
          pageNumber: 1,
          rowId: firstRowId,
          quad: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ] as unknown as TextQuad,
          axisRowRad: 0,
        },
      ],
      mode: 'vector',
    });
    expect(view.surface.querySelectorAll('.ofd-selection-rect').length).toBe(1);
    host.setView({ scrollTop: 500 });
    await flush();
    await flush();
    expect(view.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(60);
    expect(view.surface.querySelectorAll('.ofd-selection-rect').length).toBe(1);
    service.destroy();
  });
});


describe('构建性能与分帧（t10）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('单 span 只写必要内联样式与查表 dataset，恒等 transform 跳过', () => {
    const content = makeContent([makeItem({ text: 'Hello', x: 10, y: 100, size: 16 })]);
    const spec = buildTextLayerSpecs(content).spans[0]!;
    const span = createTextSpan(document, spec, 1, true, false);
    expect(span.style.length).toBeLessThanOrEqual(7);
    expect(span.style.transform).toBe('');
    expect(span.dataset.pageNumber).toBeUndefined();
    expect(span.dataset.x).toBeUndefined();
    expect(span.dataset.y).toBeUndefined();
    expect(span.dataset.size).toBeUndefined();
    expect(span.dataset.angle).toBeUndefined();
    expect(span.dataset.itemIndex).toBe('0');
    expect(span.style.length + Object.keys(span.dataset).length).toBeLessThanOrEqual(10);
  });

  it('旋转 span 保留 transform；legacy 模式才写旧几何字段', () => {
    const content = makeContent([makeItem({ text: '竖', x: 10, y: 100, size: 16 })]);
    const spec = { ...buildTextLayerSpecs(content).spans[0]!, transform: 'rotate(1.5rad)' };
    const span = createTextSpan(document, spec, 1, true, false);
    expect(span.style.transform).toMatch(/^rotate\(/);
    expect(span.style.length).toBeLessThanOrEqual(7);
    const legacy = createTextSpan(document, spec, 1, true, true);
    expect(legacy.dataset.x).toBeDefined();
    expect(legacy.dataset.angle).toBeDefined();
  });

  it('8331 span 按 700/帧追加，分帧期间已有 span 不被替换', async () => {
    const total = 8331;
    const items = Array.from({ length: total }, (_, index) =>
      makeItem({ text: 'a', x: 10, y: 100 + index * 2, size: 16, order: index }),
    );
    const content = makeContent(items);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    // 固定时钟，避免 jsdom 创建 span 的耗时提前触发 8ms 预算，使每帧条数可预期。
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    const layer = host.getPageView(1)!.textLayer;
    await vi.waitFor(() => expect(layer.childElementCount).toBe(700));
    const firstFrameNodes = [...layer.children];
    expect(layer.childElementCount).toBeLessThan(total);
    // 首帧已挂出的文字可被选中；后续帧只追加，不会折叠该选区。
    const firstText = firstFrameNodes[0]!.firstChild as Text;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(firstText, 1);
    selection.addRange(range);
    expect(selection.toString()).toBe('a');

    while (layer.childElementCount < total) {
      const frame = frames.shift();
      expect(frame).toBeDefined();
      frame!(performance.now());
    }
    expect(layer.childElementCount).toBe(total);
    // append-only：首帧节点仍在原位，后续帧没有 replaceChildren。
    expect([...layer.children].slice(0, 700)).toEqual(firstFrameNodes);
    expect(firstText.isConnected).toBe(true);
    expect(selection.toString()).toBe('a');
    service.destroy();
  });

  it('释放页会取消未完成分帧并清理悬挂帧', async () => {
    const total = 2000;
    const items = Array.from({ length: total }, (_, index) =>
      makeItem({ text: 'a', x: 10, y: 100 + index * 2, size: 16, order: index }),
    );
    const content = makeContent(items);
    const frames: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      cancelled.push(handle);
    });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    const layer = host.getPageView(1)!.textLayer;
    await vi.waitFor(() => expect(layer.childElementCount).toBe(700));
    service.releasePage(1);
    expect(cancelled.length).toBeGreaterThan(0);
    expect(layer.childElementCount).toBe(0);
    // 已取消的回调即使被外部误执行，也不能再写入已释放页。
    const stale = frames.at(-1);
    stale?.(performance.now());
    expect(layer.childElementCount).toBe(0);
    service.destroy();
  });

  it('超过单页 span 上限时降级 item 级并告警，不崩溃', async () => {
    const content = makeContent([
      makeItem({ text: '甲乙', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '丙丁', x: 10, y: 120, size: 16, order: 1 }),
      makeItem({ text: '戊己', x: 10, y: 140, size: 16, order: 2 }),
    ]);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host), {
      textLayerMaxSpans: 4,
    });
    const layer = host.getPageView(1)!.textLayer;
    await vi.waitFor(() => expect(layer.childElementCount).toBe(3));
    expect([...layer.querySelectorAll<HTMLElement>('.ofd-text-item')]).toHaveLength(3);
    expect(host.warnings).toHaveLength(0);
    service.destroy();
  });

  it('公共预算选项按桌面/移动端给默认值且允许覆盖', () => {
    const desktop = resolveViewerOptions({ container: document.body });
    expect(desktop.textSpanBudget).toBe(30_000);
    expect(desktop.selectionPinSpanBudget).toBe(50_000);
    expect(desktop.textLayerMaxSpans).toBe(100_000);
    const mobile = resolveViewerOptions({ container: document.body }, { mobile: true });
    expect(mobile.textSpanBudget).toBe(12_000);
    expect(mobile.selectionPinSpanBudget).toBe(20_000);
    const custom = resolveViewerOptions({
      container: document.body,
      textSpanBudget: 5,
      selectionPinSpanBudget: 6,
      textLayerMaxSpans: 7,
    });
    expect(custom.textSpanBudget).toBe(5);
    expect(custom.selectionPinSpanBudget).toBe(6);
    expect(custom.textLayerMaxSpans).toBe(7);
  });

  it('文档关闭会取消未完成分帧', async () => {
    const total = 2000;
    const items = Array.from({ length: total }, (_, index) =>
      makeItem({ text: 'a', x: 10, y: 100 + index * 2, size: 16, order: index }),
    );
    const content = makeContent(items);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelled: number[] = [];
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => cancelled.push(handle));
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host));
    const layer = host.getPageView(1)!.textLayer;
    await vi.waitFor(() => expect(layer.childElementCount).toBe(700));
    host.emit('documentclose', {});
    expect(cancelled.length).toBeGreaterThan(0);
    expect(layer.childElementCount).toBe(0);
    service.destroy();
  });

  it('降级后仍超限时截断并发出 W_TEXT_LAYER_CAP', async () => {
    const content = makeContent([
      makeItem({ text: '甲乙', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '丙丁', x: 10, y: 120, size: 16, order: 1 }),
      makeItem({ text: '戊己', x: 10, y: 140, size: 16, order: 2 }),
    ]);
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const service = new TextLayerService(host, createViewerBridge(host), {
      textLayerMaxSpans: 2,
    });
    const layer = host.getPageView(1)!.textLayer;
    await vi.waitFor(() => expect(layer.childElementCount).toBe(2));
    expect(host.warnings.some((warning) => warning.code === 'W_TEXT_LAYER_CAP')).toBe(true);
    expect(MAX_TEXT_LAYER_NODES).toBe(100_000);
    service.destroy();
  });
});
