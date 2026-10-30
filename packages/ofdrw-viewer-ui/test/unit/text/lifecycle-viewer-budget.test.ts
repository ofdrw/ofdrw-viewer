/**
 * t11 验收（阅读器层）：pin 页 canvas 释放、span 预算分账、可见页保护与无障碍。
 *
 * 使用假引擎与真实 OFDViewer/文本模块，验证 viewer.trimCache() 的取舍规则；
 * 所有断言基于 DOM 计数与内部 LRU 状态，不做视觉判断。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  // 未覆盖的引擎导出（常量、类型辅助）保持真实实现，避免新特性读取到 undefined。
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
import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import '../../../src/text/index';
import { contentWithLines } from './helpers';

/** 生成页信息。 */
function makeInfos(count: number): PageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
}

/** 生成带指定行数文本的假页。 */
function makePage(index: number, lines: readonly string[]) {
  const content: TextContent = { ...contentWithLines(lines), pageIndex: index };
  return {
    index,
    getSize: () => ({ width: 210, height: 297 }),
    getViewport: (options: { dpi?: number } = {}) => {
      const dpi = options.dpi ?? 96;
      return {
        width: (210 / 25.4) * dpi,
        height: (297 / 25.4) * dpi,
        dpi,
      };
    },
    render: (params: { canvasContext: { clearRect: (...args: number[]) => void } }) => {
      params.canvasContext.clearRect(0, 0, 1, 1);
      return { promise: Promise.resolve(), cancel: () => undefined };
    },
    getTextContent: async () => content,
    exportImage: async () => {
      throw new Error('not implemented');
    },
  };
}

/** 假文档；每页行数由 lines 决定。 */
function makeDocument(count: number, lines: readonly string[]): unknown {
  return {
    pageCount: count,
    getPageInfos: async () => makeInfos(count),
    getPage: async (index: number) => makePage(index, lines),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount: count }),
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

/** 页内文本 span 数。 */
function spanCountOf(viewer: OFDViewer, page: number): number {
  return viewer.getPageView(page)!.textLayer.querySelectorAll('.ofd-text-item').length;
}

/** 页内选区矩形数。 */
function rectCountOf(viewer: OFDViewer, page: number): number {
  return viewer.getPageView(page)!.surface.querySelectorAll('.ofd-selection-rect').length;
}

/** 读取内部可见页范围（0-based）。 */
function visibleRangeOf(viewer: OFDViewer): { start: number; end: number } {
  return (
    viewer as unknown as { lastVisibleRange: { start: number; end: number } }
  ).lastVisibleRange;
}

/** 文本层服务内部 pin 页（1-based）。 */
function pinnedPagesOf(viewer: OFDViewer): number[] {
  const services = (
    viewer as unknown as {
      services: {
        textLayer?: { getPinnedPages?(): readonly number[] };
      };
    }
  ).services;
  return [...(services.textLayer?.getPinnedPages?.() ?? [])];
}

/** 选中第一页首行到第二页末行。 */
function selectFirstPage(viewer: OFDViewer): Text {
  const view = viewer.getPageView(1)!;
  const spans = view.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item');
  const start = spans[0]!.firstChild as Text;
  const end = spans[spans.length - 1]!.firstChild as Text;
  return selectRange(start, 0, end, end.data.length);
}

/** 建立原生选区。 */
function selectRange(start: Text, startOffset: number, end: Text, endOffset: number): Text {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  selection.addRange(range);
  return start;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
  engineMocks.open.mockReset();
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
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('t11 验收（阅读器层）：pin、预算与无障碍', () => {
  it('pin 页只保留 span、canvas 立即释放；清空选区后旧 pin 页可被淘汰', async () => {
    engineMocks.open.mockImplementation(async () => makeDocument(5, ['第一行 text', '第二行 text']));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      pageCacheSize: 1,
    });
    await viewer.ready;
    await vi.waitFor(() => expect(spanCountOf(viewer, 1)).toBe(2));

    selectFirstPage(viewer);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => expect(pinnedPagesOf(viewer)).toEqual([1]));
    const selectedText = viewer.getSelectedText();
    expect(selectedText).toContain('第一行');
    const rectsBefore = rectCountOf(viewer, 1);
    expect(rectsBefore).toBeGreaterThan(0);
    // 读屏文本源：文本层不隐藏真实文本，复制拦截不改动它。
    expect(viewer.getPageView(1)!.textLayer.getAttribute('aria-hidden')).toBe('false');
    expect(document.getSelection()?.toString()).toContain('第一行');

    viewer.goToPage(5);
    await vi.waitFor(() => expect(spanCountOf(viewer, 5)).toBe(2));
    // pin 页不可见：canvas 释放，span 与选区矩形保留。
    await vi.waitFor(() => expect(viewer.getPageView(1)!.canvas).toBeNull());
    expect(spanCountOf(viewer, 1)).toBe(2);
    expect(rectCountOf(viewer, 1)).toBe(rectsBefore);
    expect(viewer.getSelectedText()).toBe(selectedText);

    // copy 事件读取快照，不依赖原生选区是否仍在。
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    document.dispatchEvent(copyEvent);
    expect(setData).toHaveBeenCalledWith('text/plain', selectedText);
    expect(copyEvent.defaultPrevented).toBe(true);

    // 显式点击清空选区 → 旧 pin 解除 → 文本层按页级 LRU 淘汰。
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(viewer.getSelectedText()).toBe('');
    await vi.waitFor(() => expect(spanCountOf(viewer, 1)).toBe(0));
    expect(pinnedPagesOf(viewer)).toEqual([]);
    viewer.destroy();
  });

  it('跨页选区后切换页面再回来：快照文本与两页矩形保持，pin 页 canvas 释放', async () => {
    engineMocks.open.mockImplementation(async () => makeDocument(3, ['第一行 text', '第二行 text']));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      pageCacheSize: 2,
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(spanCountOf(viewer, 1)).toBe(2);
      expect(spanCountOf(viewer, 2)).toBe(2);
    });
    const first = viewer.getPageView(1)!.textLayer.querySelector<HTMLElement>('.ofd-text-item')!
      .firstChild as Text;
    const second = viewer.getPageView(2)!.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item')[1]!
      .firstChild as Text;
    selectRange(first, 0, second, second.data.length);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => expect(pinnedPagesOf(viewer)).toEqual([1, 2]));
    const text = viewer.getSelectedText();
    expect(text).toContain('第一行');
    expect(text).toContain('第二行');
    const rects = [rectCountOf(viewer, 1), rectCountOf(viewer, 2)];
    expect(rects.every((count) => count > 0)).toBe(true);

    // 切到第 3 页再切回：两端 pin 页 span 不受切换影响，canvas 释放。
    viewer.goToPage(3);
    await vi.waitFor(() => expect(spanCountOf(viewer, 3)).toBe(2));
    expect(viewer.getSelectedText()).toBe(text);
    expect([rectCountOf(viewer, 1), rectCountOf(viewer, 2)]).toEqual(rects);
    expect(spanCountOf(viewer, 1)).toBe(2);
    expect(spanCountOf(viewer, 2)).toBe(2);
    expect(viewer.getPageView(1)!.canvas).toBeNull();
    expect(viewer.getPageView(2)!.canvas).toBeNull();

    viewer.goToPage(1);
    await vi.waitFor(() => expect(spanCountOf(viewer, 1)).toBe(2));
    expect(viewer.getSelectedText()).toBe(text);
    expect([rectCountOf(viewer, 1), rectCountOf(viewer, 2)]).toEqual(rects);
    viewer.destroy();
  });

  it('端点页分帧增长越过 pin 预算：viewer 选区被清空且只告警一次', async () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `第 ${index + 1} 行 text`);
    const queued: FrameRequestCallback[] = [];
    let frameId = 0;
    let viewer: OFDViewer | undefined;
    // 首帧 700 span 后暂停后续构建帧，给测试留出建立真实 DOM 选区的窗口。
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const view = viewer?.getPageView(1);
      if (view && view.textLayer.childElementCount > 0) {
        queued.push(callback);
        return ++frameId;
      }
      return setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      void handle;
    });
    const warnings: string[] = [];
    engineMocks.open.mockImplementation(async () => makeDocument(1, lines));
    viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      pageCacheSize: 2,
      selectionPinSpanBudget: 1500,
      onWarning: (warning) => warnings.push(warning.code),
    });
    await viewer.ready;
    await vi.waitFor(() => expect(spanCountOf(viewer, 1)).toBeGreaterThan(0));
    expect(spanCountOf(viewer, 1)).toBeLessThan(1500);

    const view = viewer.getPageView(1)!;
    const spans = view.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item');
    const first = spans[0]!.firstChild as Text;
    const last = spans[spans.length - 1]!.firstChild as Text;
    selectRange(first, 0, last, last.data.length);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => expect(pinnedPagesOf(viewer!)).toEqual([1]));
    expect(viewer.getSelectedText()).not.toBe('');
    expect(rectCountOf(viewer, 1)).toBeGreaterThan(0);

    // 放行剩余分帧；span 继续增长并越过 1500 的 pin 预算。
    for (let round = 0; round < 300 && queued.length > 0; round += 1) {
      while (queued.length > 0) {
        const callback = queued.shift()!;
        callback(performance.now());
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await vi.waitFor(() => expect(spanCountOf(viewer!, 1)).toBe(2000));
    await vi.waitFor(() => expect(viewer!.getSelectedText()).toBe(''));
    expect(rectCountOf(viewer, 1)).toBe(0);
    expect(document.getSelection()?.rangeCount ?? 0).toBe(0);
    expect(pinnedPagesOf(viewer)).toEqual([]);
    expect(warnings.filter((code) => code === 'W_SELECTION_UNPINNABLE')).toHaveLength(1);
    viewer.destroy();
  });

  it('仅缓存 content 的不可见页在页预算超限时被 release，重进重新抽取', async () => {
    const documentMock = makeDocument(6, ['第一行 text']) as unknown as {
      getPage(index: number): Promise<{
        getTextContent(): Promise<TextContent>;
        [key: string]: unknown;
      }>;
    };
    let textCalls = 0;
    const originalGetPage = documentMock.getPage.bind(documentMock);
    documentMock.getPage = async (index: number) => {
      const page = await originalGetPage(index);
      const originalGetText = page.getTextContent.bind(page);
      page.getTextContent = async () => {
        textCalls += 1;
        return originalGetText();
      };
      return page;
    };
    engineMocks.open.mockImplementation(async () => documentMock);
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      pageCacheSize: 1,
    });
    await viewer.ready;
    await vi.waitFor(() => expect(spanCountOf(viewer, 1)).toBe(1));

    type PageState = Record<string, unknown>;
    const service = (
      viewer as unknown as {
        services: {
          textLayer: {
            pages: Map<number, PageState>;
            releasePage(pageNumber: number): void;
            hasTextData(pageNumber: number): boolean;
          };
        };
      }
    ).services.textLayer;
    const content = contentWithLines(['仅缓存内容']);
    for (const pageNumber of [3, 4, 5, 6]) {
      service.pages.set(pageNumber, {
        content,
        rows: null,
        axisRowRad: 0,
        domBuilt: false,
        spanCount: 0,
        truncated: false,
        build: null,
        generation: 0,
        abort: null,
        failed: false,
        page: null,
        extracting: false,
      });
    }
    const released: number[] = [];
    const originalRelease = service.releasePage.bind(service);
    service.releasePage = (pageNumber: number) => {
      released.push(pageNumber);
      originalRelease(pageNumber);
    };
    // 当前可见第 1 页；页预算 3，4 个仅缓存 content 的不可见页必须被淘汰。
    (
      viewer as unknown as { trimCache(): void }
    ).trimCache();
    expect(released).toContain(6);
    expect(service.hasTextData(6)).toBe(false);

    const callsBefore = textCalls;
    viewer.goToPage(6);
    await vi.waitFor(() => expect(spanCountOf(viewer, 6)).toBe(1));
    expect(textCalls).toBeGreaterThan(callsBefore);
    viewer.destroy();
  });

  it('span 预算与 pin 分账：非 pin 缓存 span 不超预算，pin 与可见页永不淘汰', async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 行 text`);
    engineMocks.open.mockImplementation(async () => makeDocument(4, lines));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      pageCacheSize: 4,
      textSpanBudget: 25,
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(spanCountOf(viewer, 1)).toBe(10);
      expect(spanCountOf(viewer, 2)).toBe(10);
    });

    selectFirstPage(viewer);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => expect(pinnedPagesOf(viewer)).toEqual([1]));

    viewer.goToPage(4);
    await vi.waitFor(() => {
      expect(spanCountOf(viewer, 3)).toBe(10);
      expect(spanCountOf(viewer, 4)).toBe(10);
    });
    const visible = visibleRangeOf(viewer);
    // pin 页 span 保留，尽管已不可见。
    expect(pinnedPagesOf(viewer)).toEqual([1]);
    expect(spanCountOf(viewer, 1)).toBe(10);
    // 可见页永不淘汰。
    for (let index = visible.start; index <= visible.end; index += 1) {
      expect(spanCountOf(viewer, index + 1)).toBe(10);
    }
    // 非 pin、非可见页（第 2 页）被预算淘汰；非 pin 缓存 span 不超 B=25。
    let nonPinnedCached = 0;
    for (const page of [2, 3, 4]) {
      const index = page - 1;
      if (index >= visible.start && index <= visible.end) continue;
      nonPinnedCached += spanCountOf(viewer, page);
    }
    expect(spanCountOf(viewer, 2)).toBe(0);
    expect(nonPinnedCached).toBeLessThanOrEqual(25);
    // 总 span 超过 B：证明 pinnedSpans 未侵占滚动预算。
    expect(spanCountOf(viewer, 1) + spanCountOf(viewer, 3) + spanCountOf(viewer, 4)).toBeGreaterThan(25);
    viewer.destroy();
  });
});