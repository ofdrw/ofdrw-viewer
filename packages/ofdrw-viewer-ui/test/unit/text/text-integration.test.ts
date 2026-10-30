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
import { attachUIShell } from '../../../src/ui';
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

/** 生成带文本的假页。 */
function makePage(index: number) {
  const lines = [`第 ${index + 1} 页 hello world`, '第二行 text'];
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

/** 假文档。 */
function makeDocument(count: number): unknown {
  return {
    pageCount: count,
    getPageInfos: async () => makeInfos(count),
    getPage: async (index: number) => makePage(index),
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

let cleanupUI: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  cleanupUI = null;
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => makeDocument(3));
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
  cleanupUI?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('文本模块与 OFDViewer 集成', () => {
  it('自动挂载服务、构建文本层并完成查找/高亮/当前项滚动', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(2);
    });
    const layer = viewer.getPageView(1)!.textLayer;
    expect(layer.dataset.dpi).toBe('96');
    // 缩放倍率由图层显式 scale 表达（自动适配宽度下的初始倍率）。
    expect(layer.style.transform).toMatch(/^scale\([\d.]+\)$/);

    const findEvents: string[] = [];
    viewer.on('findstart', () => findEvents.push('start'));
    viewer.on('findmatches', () => findEvents.push('matches'));
    viewer.on('findcurrent', () => findEvents.push('current'));
    await viewer.find('hello');
    expect(viewer.getState().view.findState).toMatchObject({
      query: 'hello',
      total: 3,
      current: 1,
      searching: false,
    });
    expect(findEvents).toContain('start');
    expect(findEvents).toContain('matches');
    expect(findEvents).toContain('current');
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.surface.querySelectorAll('.ofd-find-highlight').length,
      ).toBeGreaterThan(0);
    });

    // 缩放/旋转由页面容器承担，文本层坐标不变。
    const span = layer.querySelector<HTMLElement>('.ofd-text-item')!;
    const left = span.style.left;
    viewer.setScale(2);
    viewer.setRotation(90);
    expect(left).toBe(span.style.left);
    expect(viewer.getPageView(1)!.surface.style.transform).toContain('rotate(90deg)');
    // 缩放提交后文字层布局框随之更新，仍与纸面尺寸一致。
    const surface = viewer.getPageView(1)!.surface;
    expect(parseFloat(layer.style.width)).toBeCloseTo(
      parseFloat(surface.style.width) / 2,
      5,
    );
    viewer.destroy();
  });

  it('getSelectedText 读取页文本；选区事件回写状态', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(2);
    });
    // 文字层按行构建、DOM 顺序按阅读顺序（不依赖 TextContent.items 的下标顺序）。
    const span = [...viewer.getPageView(1)!.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item')]
      .find((element) => element.textContent?.startsWith('第 1 页'))!;
    const node = span.firstChild as Text;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 4);
    selection.addRange(range);
    expect(viewer.getSelectedText()).toBe('第 1');
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(viewer.getState().view.selectedText).toBe('第 1');
    viewer.clearSelection();
    expect(document.getSelection()!.rangeCount).toBe(0);
    viewer.destroy();
  });

  it('选区变化驱动块状高亮层，缩放/旋转后与文本层同步、清空选区后移除', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(2);
    });
    const page = viewer.getPageView(1)!;
    const spans = [...page.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item')];
    const startNode = spans[0]!.firstChild as Text;
    const endNode = spans[1]!.firstChild as Text;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.length);
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();

    const layer = page.surface.querySelector<HTMLElement>('.ofd-page__selection-layer');
    expect(layer).not.toBeNull();
    expect(layer!.style.pointerEvents).toBe('none');
    expect(layer!.style.zIndex).toBe('2');
    expect(layer!.style.transform).toBe(page.textLayer.style.transform);
    expect(page.surface.querySelectorAll('.ofd-selection-rect')).toHaveLength(2);
    // 默认不标记 native：原生选区透明，由块状层负责高亮。
    expect(page.element.dataset.selectionMode).toBeUndefined();

    // 缩放后选区层与文本层保持同一布局框与缩放倍率。
    viewer.setScale(2);
    await vi.waitFor(() => {
      expect(layer!.style.transform).toBe(page.textLayer.style.transform);
    });
    expect(page.surface.querySelectorAll('.ofd-selection-rect')).toHaveLength(2);

    // 旋转由页容器承担：矩形几何不重算，仍与文字对齐。
    viewer.setRotation(90);
    expect(page.surface.style.transform).toContain('rotate(90deg)');
    expect(page.surface.querySelectorAll('.ofd-selection-rect')).toHaveLength(2);

    viewer.clearSelection();
    expect(page.surface.querySelector('.ofd-page__selection-layer')).toBeNull();
    viewer.destroy();
  });

  it('公共选项把单页 span 上限与 pin 预算透传到文本服务', async () => {
    const warnings: string[] = [];
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      textLayerMaxSpans: 1,
      selectionPinSpanBudget: 7,
      onWarning: (warning) => warnings.push(warning.code),
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(1);
    });
    expect(viewer.getTextLayerOptions()).toEqual({
      selectionPinSpanBudget: 7,
      textLayerMaxSpans: 1,
    });
    expect(warnings).toContain('W_TEXT_LAYER_CAP');
    viewer.destroy();
  });

  it('快照贯穿缩放/旋转：选区文本与高亮保持，原生 copy 读完整快照', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(2);
      expect(
        viewer.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBe(2);
    });
    const firstPage = viewer.getPageView(1)!;
    const secondPage = viewer.getPageView(2)!;
    // 读屏直接读取真实 DOM 文本；copy 拦截不改变 aria-hidden。
    expect(firstPage.textLayer.getAttribute('aria-hidden')).toBe('false');
    const start = firstPage.textLayer.querySelector('.ofd-text-item')!.firstChild as Text;
    const endItem = secondPage.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item')[1]!;
    const end = endItem.firstChild as Text;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.data.length);
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => {
      expect(
        firstPage.surface.querySelectorAll('.ofd-selection-rect').length,
      ).toBeGreaterThan(0);
      expect(
        secondPage.surface.querySelectorAll('.ofd-selection-rect').length,
      ).toBeGreaterThan(0);
    });
    const text = viewer.getSelectedText();
    expect(text).toContain('第 1 页');
    const rectCounts = [firstPage, secondPage].map(
      (page) => page.surface.querySelectorAll('.ofd-selection-rect').length,
    );

    for (const scale of [1.5, 2]) {
      viewer.setScale(scale);
      await vi.waitFor(() => {
        expect(viewer.getSelectedText()).toBe(text);
        expect(
          [firstPage, secondPage].map(
            (page) => page.surface.querySelectorAll('.ofd-selection-rect').length,
          ),
        ).toEqual(rectCounts);
      });
    }
    for (const rotation of [90, 180, 270] as const) {
      viewer.setRotation(rotation);
      await vi.waitFor(() => {
        expect(viewer.getSelectedText()).toBe(text);
        expect(
          [firstPage, secondPage].map(
            (page) => page.surface.querySelectorAll('.ofd-selection-rect').length,
          ),
        ).toEqual(rectCounts);
      });
    }

    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    document.dispatchEvent(copyEvent);
    expect(setData).toHaveBeenCalledWith('text/plain', text);
    expect(copyEvent.defaultPrevented).toBe(true);

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(viewer.getSelectedText()).toBe('');
    viewer.destroy();
  });

  it('textLayer=false 时查找/选区抛 OFD_FEATURE_DISABLED 并清空文本层', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBeGreaterThan(0);
    });
    viewer.setFeatures({ textLayer: false });
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item'),
      ).toHaveLength(0);
    });
    expect(viewer.getPageView(1)!.textLayer.hidden).toBe(true);
    await expect(viewer.find('hello')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
    });
    let selectionError: unknown;
    try {
      viewer.getSelectedText();
    } catch (error) {
      selectionError = error;
    }
    expect(selectionError).toMatchObject({ code: 'OFD_FEATURE_DISABLED' });
    await expect(viewer.copySelection()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
    });
    viewer.destroy();
  });

  it('selection=false 时文本层 user-select 关闭', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBeGreaterThan(0);
    });
    const page = viewer.getPageView(1)!;
    const span = page.textLayer.querySelector<HTMLElement>('.ofd-text-item')!;
    const node = span.firstChild as Text;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => {
      expect(page.surface.querySelectorAll('.ofd-selection-rect').length).toBe(1);
    });
    viewer.setFeatures({ selection: false });
    const layer = page.textLayer;
    expect(layer.style.userSelect).toBe('none');
    expect(layer.dataset.selectable).toBe('false');
    expect(layer.querySelector<HTMLElement>('.ofd-text-item')!.style.userSelect).toBe('');
    // 关闭选区功能：块状高亮层同步清空。
    await vi.waitFor(() => {
      expect(page.surface.querySelector('.ofd-page__selection-layer')).toBeNull();
    });
    viewer.destroy();
  });

  it('find=false 时 Ctrl+F 不打开查找栏', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    cleanupUI = attachUIShell(viewer);
    const root = viewer.getElements().root;
    const pressCtrlF = (): void => {
      root.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    viewer.setFeatures({ find: false });
    pressCtrlF();
    expect(viewer.getElements().findbar.hidden).toBe(true);

    viewer.setFeatures({ find: true });
    pressCtrlF();
    expect(viewer.getElements().findbar.hidden).toBe(false);
    cleanupUI?.();
    cleanupUI = null;
    viewer.destroy();
  });

  it('页级 LRU 淘汰文本层；pin 端点页保留 span 但释放 canvas', async () => {
    engineMocks.open.mockImplementation(async () => makeDocument(5));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      pageCacheSize: 1,
    });
    await viewer.ready;
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBeGreaterThan(0);
    });
    const internals = viewer as unknown as {
      services: {
        textLayer?: {
          renderSelection?(model: unknown): void;
          setPinnedPages?(pages: number[]): boolean;
          getPinnedPages?(): number[];
        };
      };
    };
    const service = internals.services.textLayer!;
    service.renderSelection?.({
      fragments: [
        {
          text: '第',
          pageNumber: 1,
          rowId: '0:0',
          quad: null,
          axisRowRad: 0,
        },
      ],
      mode: 'vector',
    });
    expect(service.getPinnedPages?.()).toEqual([1]);
    viewer.goToPage(5);
    await vi.waitFor(() => {
      expect(
        viewer.getPageView(5)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBeGreaterThan(0);
    });
    // pin 页保留文本 span，但不可见时释放 canvas。
    expect(viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBeGreaterThan(0);
    expect(viewer.getPageView(1)!.canvas).toBeNull();
    service.renderSelection?.({ fragments: [], mode: 'vector' });
    expect(service.getPinnedPages?.()).toEqual([]);
    await vi.waitFor(() => {
      expect(viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    });
    viewer.destroy();
  });
});