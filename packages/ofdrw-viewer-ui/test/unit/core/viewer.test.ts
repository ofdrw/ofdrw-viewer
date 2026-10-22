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

/**
 * 读取页视图的排版顶部偏移，单位 px。
 *
 * @param viewer 阅读器实例。
 * @param pageNumber 页码，1-based。
 * @returns 页顶偏移。
 */
function pageTop(viewer: OFDViewer, pageNumber: number): number {
  const element = viewer.getPageView(pageNumber)?.element;
  if (!element) throw new Error(`页 ${pageNumber} 不存在`);
  return Number.parseFloat(element.style.top);
}

/**
 * 读取滚动内容坐标 `absoluteY` 所在页与页内比例。
 *
 * @param viewer 阅读器实例。
 * @param absoluteY 相对滚动内容顶部的 y 坐标，单位 px。
 * @returns 页码/页内比例；落在页间空隙时返回 null。
 */
function pagePositionAt(
  viewer: OFDViewer,
  absoluteY: number,
): { pageNumber: number; ratio: number } | null {
  for (const pageView of viewer.getPageViews()) {
    const top = Number.parseFloat(pageView.element.style.top);
    const height = Number.parseFloat(pageView.element.style.height);
    if (absoluteY >= top && absoluteY < top + height) {
      return { pageNumber: pageView.pageNumber, ratio: (absoluteY - top) / height };
    }
  }
  return null;
}

/**
 * 派发合成触摸指针事件。
 *
 * @param target 事件目标。
 * @param type 事件类型。
 * @param pointerId 触点 id。
 * @param clientX 视口 x 坐标，单位 px。
 * @param clientY 视口 y 坐标，单位 px。
 * @returns 派发的事件，可检查 defaultPrevented。
 */
function dispatchTouchPointer(
  target: HTMLElement,
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  target.dispatchEvent(event);
  return event;
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
  it('缺少原生 Fullscreen API 时使用沉浸式回退并保持一致状态', async () => {
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    const warnings: string[] = [];
    viewer.on('warning', (warning) => warnings.push(warning.code));
    await viewer.setFullscreen(true);
    expect(viewer.getState().view.fullscreen).toBe(true);
    expect(viewer.getElements().root.classList.contains('ofd-viewer--fullscreen-fallback')).toBe(true);
    expect(warnings).toContain('W_FULLSCREEN_FALLBACK');
    await viewer.setFullscreen(false);
    expect(viewer.getState().view.fullscreen).toBe(false);
    expect(viewer.getElements().root.classList.contains('ofd-viewer--fullscreen-fallback')).toBe(false);
    viewer.destroy();
  });

  it('公共读取 API 与签章门控一致', async () => {
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    expect(viewer.getCurrentPage()).toBe(viewer.getPageNumber());
    expect(viewer.getFindState()).toMatchObject({ query: '', current: 0, total: 0 });
    expect(viewer.getSignatures()).toEqual([]);
    viewer.setFeatures({ signatures: false });
    expect(() => viewer.getSignatures()).toThrow(
      expect.objectContaining({ code: 'OFD_FEATURE_DISABLED', feature: 'signatures' }),
    );
    await expect(viewer.focusSignature('missing')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'signatures',
    });
    expect(() => viewer.showDialog({ name: 'print', title: 't' })).toThrow(
      expect.objectContaining({ code: 'OFD_UNSUPPORTED' }),
    );
    viewer.closeDialog();
    viewer.destroy();
  });

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

  it('主区域 scroll 事件驱动连续滚动状态、事件与后续页渲染', async () => {
    // 监听器只允许绑定一次，并在 destroy 时解绑。
    const addSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    engineMocks.open.mockImplementation(async () => makeDocument(5));
    const viewer = new OFDViewer({ container: document.body, source: new ArrayBuffer(8) });
    await viewer.ready;

    const main = viewer.getElements().main;
    const scrollAddIndex = addSpy.mock.calls.findIndex((call) => call[0] === 'scroll');
    expect(scrollAddIndex).toBeGreaterThanOrEqual(0);
    expect(addSpy.mock.calls.filter((call) => call[0] === 'scroll')).toHaveLength(1);
    expect(addSpy.mock.contexts[scrollAddIndex]).toBe(main);
    expect(addSpy.mock.calls[scrollAddIndex]?.[2]).toMatchObject({ passive: true });

    const changes: Array<{ pageNumber: number; previous: number }> = [];
    const rendered: number[] = [];
    viewer.on('pagechanging', (event) => changes.push(event));
    viewer.on('pagerendered', (event) => rendered.push(event.pageNumber));

    // 第一段：连续滚动到第 2 页，页码/可见范围/事件同步更新。
    main.scrollTop = pageTop(viewer, 2);
    main.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(2);
      expect(viewer.getState().view.visiblePageRange.start).toBe(1);
    });
    expect(changes).toContainEqual({ pageNumber: 2, previous: 1 });

    // 第二段：继续滚动到第 4 页（初始预取范围之外），触发新页渲染。
    const fourth = viewer.getPageView(4)!;
    main.scrollTop = pageTop(viewer, 4);
    main.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(4);
      expect(viewer.getState().view.visiblePageRange.start).toBeLessThanOrEqual(3);
      expect(viewer.getState().view.visiblePageRange.end).toBeGreaterThanOrEqual(3);
    });
    await vi.waitFor(() => {
      expect(fourth.canvas).not.toBeNull();
      expect(fourth.state).toBe('rendered');
    });
    expect(rendered).toContain(4);
    expect(changes).toContainEqual({ pageNumber: 4, previous: 2 });

    // 重复构造/打开不得重复绑定；destroy 必须解绑。
    await viewer.close();
    await viewer.open();
    expect(addSpy.mock.calls.filter((call) => call[0] === 'scroll')).toHaveLength(1);

    viewer.destroy();
    const scrollRemoveIndex = removeSpy.mock.calls.findIndex((call) => call[0] === 'scroll');
    expect(scrollRemoveIndex).toBeGreaterThanOrEqual(0);
    expect(removeSpy.mock.contexts[scrollRemoveIndex]).toBe(main);
  });

  it('A4 小数页高下 goToPage/lastPage 不因整数 scrollTop 落回上一页', async () => {
    engineMocks.open.mockImplementation(async () => makeDocument(5));
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
    });
    await viewer.ready;

    const main = viewer.getElements().main;
    // 模拟 Chromium：scrollTop 按整数像素保存，2285.039 的页顶会被截断为 2285。
    let storedTop = Math.trunc(main.scrollTop);
    Object.defineProperty(main, 'scrollTop', {
      configurable: true,
      get: () => storedTop,
      set: (value: number) => {
        storedTop = Math.trunc(Math.max(0, value));
      },
    });

    // 复现 t11 的 A4 五页小数页顶（scale=1）。
    expect(pageTop(viewer, 3)).toBeCloseTo(2285.0393700787404, 6);
    expect(pageTop(viewer, 5)).toBeCloseTo(4546.078740157481, 6);

    viewer.goToPage(3);
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(3);
      expect(viewer.getState().view.scrollTop).toBe(2286);
    });
    expect(viewer.getPageView(3)?.element.dataset.current).toBe('true');
    expect(viewer.getPageView(4)?.element.dataset.current).toBeUndefined();

    viewer.goToPage(5);
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(5);
      expect(viewer.getState().view.scrollTop).toBe(4547);
    });
    expect(viewer.getPageView(4)?.element.dataset.current).toBeUndefined();
    expect(viewer.getPageView(5)?.element.dataset.current).toBe('true');

    viewer.goToPage(1);
    await vi.waitFor(() => expect(viewer.getPageNumber()).toBe(1));
    viewer.lastPage();
    await vi.waitFor(() => {
      expect(viewer.getPageNumber()).toBe(5);
      expect(viewer.getState().view.scrollTop).toBe(4547);
    });

    // 缩放/旋转按锚点恢复，整数化后仍应停在第 5 页而不是落回第 4 页。
    viewer.setScale(2);
    await vi.waitFor(() => expect(viewer.getPageNumber()).toBe(5));
    viewer.setRotation(90);
    await vi.waitFor(() => expect(viewer.getPageNumber()).toBe(5));
    expect(viewer.getPageView(5)?.element.dataset.current).toBe('true');
    viewer.destroy();
  });

  it('Ctrl+滚轮以指针为锚点缩放并阻止浏览器默认缩放', async () => {
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
    });
    await viewer.ready;
    const main = viewer.getElements().main;
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 50,
      top: 50,
      left: 0,
      right: 800,
      bottom: 650,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    } as DOMRect);
    main.scrollTop = 200;
    main.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(viewer.getState().view.scrollTop).toBe(200));

    const before = pagePositionAt(viewer, 200 + 200);
    expect(before).not.toBeNull();
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
      clientX: 300,
      clientY: 250,
    });
    expect(main.dispatchEvent(wheel)).toBe(false);
    await vi.waitFor(() => expect(viewer.getScale()).toBeCloseTo(1.1, 5));
    await vi.waitFor(() => expect(viewer.getState().view.scrollTop).toBeGreaterThan(200));
    const after = pagePositionAt(viewer, viewer.getState().view.scrollTop + 200);
    expect(after?.pageNumber).toBe(before?.pageNumber);
    expect(Math.abs((after?.ratio ?? 0) - (before?.ratio ?? 0))).toBeLessThan(0.002);

    // 普通滚轮不拦截、不缩放。
    const plain = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: false,
      ctrlKey: false,
      deltaY: -120,
      clientX: 300,
      clientY: 250,
    });
    expect(main.dispatchEvent(plain)).toBe(true);
    expect(viewer.getScale()).toBeCloseTo(1.1, 5);
    viewer.destroy();

    const disabled = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
      features: { zoom: false },
    });
    await disabled.ready;
    const disabledMain = disabled.getElements().main;
    const blocked = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
    });
    expect(disabledMain.dispatchEvent(blocked)).toBe(true);
    expect(disabled.getScale()).toBe(1);
    const dblclick = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    disabledMain.dispatchEvent(dblclick);
    expect(dblclick.defaultPrevented).toBe(false);
    expect(disabled.getScale()).toBe(1);
    disabled.destroy();
  });

  it('触摸双指捏合以中点为锚点并在结束后释放 pointer capture', async () => {
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
    });
    await viewer.ready;
    const main = viewer.getElements().main;
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 800,
      width: 800,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect);
    const released: number[] = [];
    Object.assign(main, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn((pointerId: number) => released.push(pointerId)),
      hasPointerCapture: vi.fn(() => true),
    });
    main.scrollTop = 100;
    main.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(viewer.getState().view.scrollTop).toBe(100));
    const before = pagePositionAt(viewer, 100 + 400);

    expect(dispatchTouchPointer(main, 'pointerdown', 2, 400, 400).defaultPrevented).toBe(false);
    expect(dispatchTouchPointer(main, 'pointerdown', 1, 300, 400).defaultPrevented).toBe(true);
    const move = dispatchTouchPointer(main, 'pointermove', 1, 600, 400);
    expect(move.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(viewer.getScale()).toBeCloseTo(2, 5));
    await vi.waitFor(() => expect(viewer.getState().view.scrollTop).not.toBe(100));
    const after = pagePositionAt(viewer, viewer.getState().view.scrollTop + 400);
    expect(after?.pageNumber).toBe(before?.pageNumber);
    expect(Math.abs((after?.ratio ?? 0) - (before?.ratio ?? 0))).toBeLessThan(0.003);

    dispatchTouchPointer(main, 'pointerup', 2, 400, 400);
    dispatchTouchPointer(main, 'pointerup', 1, 600, 400);
    expect([...released].sort((a, b) => a - b)).toEqual([1, 2]);
    // 剩余单指移动不再被捏合逻辑拦截。
    const single = dispatchTouchPointer(main, 'pointermove', 1, 520, 400);
    expect(single.defaultPrevented).toBe(false);
    expect(viewer.getScale()).toBeCloseTo(2, 5);
    viewer.destroy();
  });

  it('双击在适合宽度与 100% 之间切换并清除文本选区', async () => {
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
    });
    await viewer.ready;
    const main = viewer.getElements().main;
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 800,
      width: 800,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect);
    const textLayer = viewer.getPageView(1)!.textLayer;
    textLayer.textContent = 'hello';
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(textLayer);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.isCollapsed).toBe(false);

    const first = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 300,
    });
    textLayer.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(viewer.getState().view.zoomMode).toBe('auto'));
    expect(viewer.getScale()).toBeGreaterThan(1);
    expect(selection.isCollapsed).toBe(true);

    const second = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 300,
    });
    main.dispatchEvent(second);
    await vi.waitFor(() => expect(viewer.getState().view.zoomMode).toBe('page-actual'));
    expect(viewer.getScale()).toBeCloseTo(1, 5);
    viewer.destroy();
  });
});
