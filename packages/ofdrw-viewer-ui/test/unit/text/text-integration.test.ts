import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

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
    const span = viewer.getPageView(1)!.textLayer.querySelector<HTMLElement>('.ofd-text-item')!;
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
    viewer.setFeatures({ selection: false });
    const layer = viewer.getPageView(1)!.textLayer;
    expect(layer.style.userSelect).toBe('none');
    expect(layer.dataset.selectable).toBe('false');
    expect(
      layer.querySelector<HTMLElement>('.ofd-text-item')!.style.userSelect,
    ).toBe('none');
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
});