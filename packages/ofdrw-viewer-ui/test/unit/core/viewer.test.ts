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

interface FakePage {
  index: number;
  getSize: () => { width: number; height: number };
  getViewport: (options?: { dpi?: number }) => { width: number; height: number };
  render: (params: { canvasContext: { clearRect: (...args: number[]) => void }; signal?: AbortSignal }) => {
    promise: Promise<void>;
    cancel: () => void;
  };
  getTextContent: () => Promise<{ items: never[]; chars: never[] }>;
  exportImage: () => Promise<never>;
}

function makeInfos(count: number): PageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
}

function makePage(index: number): FakePage {
  return {
    index,
    getSize: () => ({ width: 210, height: 297 }),
    getViewport: (options = {}) => {
      const dpi = options.dpi ?? 96;
      return {
        width: Math.ceil((210 / 25.4) * dpi),
        height: Math.ceil((297 / 25.4) * dpi),
      };
    },
    render: (params) => {
      params.canvasContext.clearRect(0, 0, 1, 1);
      return { promise: Promise.resolve(), cancel: vi.fn() };
    },
    getTextContent: async () => ({ items: [], chars: [] }),
    exportImage: async () => {
      throw new Error('not implemented');
    },
  };
}

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

let contextMock: { clearRect: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn> };

beforeEach(() => {
  document.body.innerHTML = '';
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => makeDocument(3));
  contextMock = { clearRect: vi.fn(), fillRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    contextMock as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OFDViewer 核心', () => {
  it('创建结构、打开文档并初始化页壳', async () => {
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
    });
    const opened: number[] = [];
    viewer.on('documentopen', (event) => opened.push(event.pageCount));
    await viewer.ready;

    expect(viewer.getState().document.status).toBe('ready');
    expect(viewer.getPageCount()).toBe(3);
    expect(viewer.getPageViews()).toHaveLength(3);
    expect(viewer.getElements().root.classList.contains('ofd-viewer')).toBe(true);
    expect(viewer.getElements().main.querySelector('.ofd-viewer__pages')).not.toBeNull();
    expect(opened).toEqual([3]);
    viewer.destroy();
  });

  it('翻页、缩放和旋转保持状态一致', async () => {
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    await viewer.ready;

    viewer.goToPage(3);
    expect(viewer.getPageNumber()).toBe(3);
    viewer.previousPage();
    expect(viewer.getPageNumber()).toBe(2);
    viewer.nextPage();
    expect(viewer.getPageNumber()).toBe(3);

    viewer.setScale(2);
    expect(viewer.getScale()).toBe(2);
    const box = viewer.getPageView(1)?.element;
    expect(box?.style.width).toBeTruthy();

    viewer.setRotation(90);
    expect(viewer.getRotation()).toBe(90);
    expect(viewer.getPageView(1)?.element.dataset.rotation).toBe('90');
    viewer.destroy();
  });

  it('功能关闭时控件隐藏/API 抛 OFD_FEATURE_DISABLED，并联动查找', async () => {
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    await viewer.ready;

    viewer.setFeatures({ toolbar: false, textLayer: false });
    expect(viewer.getElements().toolbar.hidden).toBe(true);
    expect(viewer.getFeatureState('toolbar').enabled).toBe(false);
    expect(viewer.getFeatureState('find').reason).toBe('dependency');
    await expect(viewer.find('abc')).rejects.toMatchObject({ code: 'OFD_FEATURE_DISABLED' });

    viewer.setFeatures({ toolbar: true, textLayer: true });
    expect(viewer.getElements().toolbar.hidden).toBe(false);
    expect(viewer.getFeatureState('find').enabled).toBe(true);
    viewer.destroy();
  });

  it('侧栏打开/关闭与特性门控', async () => {
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    await viewer.ready;
    const states: Array<unknown> = [];
    viewer.on('sidebarviewchanged', (event) => states.push(event.view));

    viewer.openSidebar('thumbnails');
    expect(viewer.getSidebarView()).toBe('thumbnails');
    expect(viewer.getElements().sidebar.hidden).toBe(false);
    viewer.closeSidebar();
    expect(viewer.getSidebarView()).toBeNull();
    expect(viewer.getElements().sidebar.hidden).toBe(true);
    expect(states).toEqual(['thumbnails', null]);
    viewer.destroy();
  });

  it('挂载查找服务后代理查找与选区', async () => {
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    await viewer.ready;
    const find = vi.fn();
    const getSelectedText = vi.fn(() => 'hello');
    const detach = viewer.attachFindController({ find, getSelectedText });
    await viewer.find('hello', { caseSensitive: true });
    expect(find).toHaveBeenCalledWith('hello', { caseSensitive: true });
    expect(viewer.getSelectedText()).toBe('hello');
    detach();
    await expect(viewer.find('hello')).rejects.toMatchObject({ code: 'OFD_UNSUPPORTED' });
    viewer.destroy();
  });

  it('只给可见区域附近创建 canvas，并在销毁时清理', async () => {
    engineMocks.open.mockImplementation(async () => makeDocument(100));
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    await viewer.ready;
    await vi.waitFor(() => {
      const canvases = viewer
        .getPageViews()
        .filter((page) => page.canvas !== null).length;
      expect(canvases).toBeGreaterThan(0);
      expect(canvases).toBeLessThan(10);
    });
    expect(viewer.getPageViews()).toHaveLength(100);
    viewer.destroy();
    expect(viewer.getRoot().isConnected).toBe(false);
  });
});
