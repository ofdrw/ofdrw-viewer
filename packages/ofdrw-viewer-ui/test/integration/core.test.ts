/**
 * 核心阅读器集成基线：打开/关闭、页面布局、渲染队列优先级/取消、功能有效状态
 * 与 1000 页文档降级表现。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import type { PageRenderParameters } from '@ofdrw/ofdrw-viewer-engine';
import { OFDViewer } from '../../src/index';
import { DEFAULT_PAGE_GAP, DEFAULT_PAGE_PADDING, MM_TO_CSS_PX } from '../../src/page-layout';
import {
  ALLOW_ALL_PERMISSIONS,
  createMockDocument,
  type MockRenderTask,
} from '../helpers/document';
import { installDomEnvironment } from '../helpers/environment';
import { createViewer, openViewer, type EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 读取页盒 CSS 数值。 */
function boxMetrics(element: HTMLElement): {
  top: number;
  width: number;
  height: number;
} {
  return {
    top: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  };
}

describe('核心集成：文档生命周期', () => {
  it('打开/关闭/重新打开保持状态与事件一致', async () => {
    const { viewer, document: engineDocument } = createViewer(openMock, {
      pageCount: 3,
      metadata: { version: '1.0', pageCount: 3, title: '集成文档' },
    });
    const events: string[] = [];
    viewer.on('documentopen', (event) => events.push(`open:${event.pageCount}`));
    viewer.on('pagesloaded', (event) => events.push(`loaded:${event.pageCount}`));
    viewer.on('documentclose', () => events.push('close'));

    await viewer.ready;
    expect(events).toEqual(['open:3', 'loaded:3']);
    expect(viewer.getState().document.status).toBe('ready');
    expect(viewer.getPageCount()).toBe(3);
    expect(viewer.getPageViews()).toHaveLength(3);

    const firstPage = viewer.getPageView(1)!;
    expect(firstPage.element.getAttribute('role')).toBe('document');
    expect(firstPage.element.getAttribute('aria-label')).toBe('第 1 页，共 3 页');

    await viewer.close();
    expect(events.at(-1)).toBe('close');
    expect(viewer.getState().document.status).toBe('closed');
    expect(viewer.getPageCount()).toBe(0);
    expect(viewer.getPageViews()).toHaveLength(0);
    expect(engineDocument.closeCalls).toBe(1);
    await expect(viewer.getPage(1)).rejects.toMatchObject({ code: 'OFD_NOT_OPENED' });

    // 重新打开新文档：不重建实例，页壳按新文档重建。
    openMock.mockReset();
    openMock.mockResolvedValue(createMockDocument({ pageCount: 5 }));
    await viewer.open(new ArrayBuffer(8));
    expect(viewer.getPageCount()).toBe(5);
    expect(viewer.getPageViews()).toHaveLength(5);
    expect(events.filter((event) => event.startsWith('open:'))).toEqual(['open:3', 'open:5']);
    viewer.destroy();
  });

  it('引擎打开失败时 ready reject、状态为 error 且发出 OFD_OPEN_FAILED', async () => {
    openMock.mockReset();
    openMock.mockRejectedValueOnce?.(new Error('损坏的 OFD 包'));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    const errors: Array<{ code: string; message: string }> = [];
    viewer.on('error', (error) => errors.push({ code: error.code, message: error.message }));

    await expect(viewer.ready).rejects.toThrow('损坏的 OFD 包');
    expect(viewer.getState().document.status).toBe('error');
    expect(errors[0]).toMatchObject({ code: 'OFD_OPEN_FAILED' });
    viewer.destroy();
  });
});

describe('核心集成：页面布局', () => {
  it('连续滚动页盒、缩放与旋转保持一致的 mm→px 换算', async () => {
    const { viewer } = await openViewer(openMock, { pageCount: 3 }, { initialScale: 1 });
    const pageWidth = MM_TO_CSS_PX * 210;
    const pageHeight = MM_TO_CSS_PX * 297;

    const first = boxMetrics(viewer.getPageView(1)!.element);
    const second = boxMetrics(viewer.getPageView(2)!.element);
    expect(first.width).toBeCloseTo(pageWidth, 2);
    expect(first.height).toBeCloseTo(pageHeight, 2);
    expect(first.top).toBeCloseTo(DEFAULT_PAGE_PADDING, 2);
    expect(second.top).toBeCloseTo(DEFAULT_PAGE_PADDING + pageHeight + DEFAULT_PAGE_GAP, 2);

    const pages = viewer.getElements().main.querySelector<HTMLElement>('.ofd-viewer__pages')!;
    expect(Number.parseFloat(pages.style.height)).toBeCloseTo(
      DEFAULT_PAGE_PADDING * 2 + pageHeight * 3 + DEFAULT_PAGE_GAP * 2,
      1,
    );

    viewer.setScale(2);
    expect(boxMetrics(viewer.getPageView(1)!.element).width).toBeCloseTo(pageWidth * 2, 2);

    viewer.setRotation(90);
    const rotated = boxMetrics(viewer.getPageView(1)!.element);
    expect(rotated.width).toBeCloseTo(pageHeight * 2, 2);
    expect(rotated.height).toBeCloseTo(pageWidth * 2, 2);
    expect(viewer.getPageView(1)!.surface.style.transform).toContain('rotate(90deg)');
    expect(viewer.getPageView(1)!.element.dataset.rotation).toBe('90');
    viewer.destroy();
  });
});

describe('核心集成：渲染队列', () => {
  it('可见页先于预取页，缩放取消旧任务且不产生渲染错误', async () => {
    interface PendingRender {
      readonly pageIndex: number;
      resolve(): void;
      reject(error: unknown): void;
    }
    const pending: PendingRender[] = [];
    const renderCalls: number[] = [];
    const render = (pageIndex: number, params: PageRenderParameters): MockRenderTask => {
      renderCalls.push(pageIndex);
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((finished, failed) => {
        resolve = finished;
        reject = failed;
      });
      params.signal?.addEventListener('abort', () => {
        const error = new Error('页面渲染已取消');
        error.name = 'AbortError';
        reject(error);
      });
      pending.push({ pageIndex, resolve, reject });
      return { promise, cancel: () => undefined };
    };

    const { viewer } = await openViewer(openMock, { pageCount: 3, render }, { initialScale: 1 });
    const errors: string[] = [];
    viewer.on('error', (error) => errors.push(error.code));

    await vi.waitFor(() => expect(renderCalls.length).toBeGreaterThanOrEqual(2));
    expect(renderCalls[0]).toBe(0);
    expect(renderCalls.indexOf(1)).toBeGreaterThan(renderCalls.indexOf(0));

    const cancelledBefore = viewer.getRenderStats().cancelled;
    viewer.setScale(2);
    await vi.waitFor(() =>
      expect(viewer.getRenderStats().cancelled).toBeGreaterThan(cancelledBefore),
    );
    expect(errors).toEqual([]);

    // 新代次任务完成后页面进入 rendered；旧代次结果不会回写。
    await vi.waitFor(() => {
      for (const item of pending) item.resolve();
      expect(viewer.getPageView(1)!.state).toBe('rendered');
    });
    expect(viewer.getPageView(1)!.element.dataset.renderedScale).toBe('2');
    viewer.destroy();
  });
});

describe('核心集成：功能有效状态', () => {
  it('文档权限与宿主开关合并为有效状态，API 与工具栏同步禁用', async () => {
    const { viewer } = await openViewer(openMock, {
      pageCount: 3,
      permissions: {
        ...ALLOW_ALL_PERMISSIONS,
        export: false,
        print: { printable: false },
      },
    });
    expect(viewer.getFeatureState('export')).toMatchObject({
      enabled: false,
      reason: 'document',
    });
    expect(viewer.getFeatureState('print')).toMatchObject({
      enabled: false,
      reason: 'document',
    });

    viewer.setFeatureDisplay('disable');
    viewer.setFeatures({ print: false });
    expect(viewer.getFeatureState('print')).toMatchObject({ enabled: false, visible: true });
    const printButton = viewer
      .getElements()
      .toolbar.querySelector<HTMLButtonElement>('[data-ofd-control="print"]');
    expect(printButton?.disabled).toBe(true);
    expect(printButton?.getAttribute('aria-disabled')).toBe('true');

    await expect(viewer.print()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'print',
    });
    await expect(viewer.exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });
    viewer.destroy();
  });

  it('引擎缺少文本/导出能力时关闭对应功能并保留阅读', async () => {
    const { viewer } = await openViewer(openMock, {
      pageCount: 2,
      omit: { textContent: true, exportImage: true },
    });
    expect(viewer.getFeatureState('textLayer')).toMatchObject({
      enabled: false,
      reason: 'unsupported',
    });
    expect(viewer.getFeatureState('find')).toMatchObject({
      enabled: false,
      reason: 'dependency',
    });
    expect(viewer.getFeatureState('export')).toMatchObject({
      enabled: false,
      reason: 'unsupported',
    });
    await expect(viewer.find('hello')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
    });
    await expect(viewer.exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });
    expect(viewer.getPageCount()).toBe(2);
    viewer.destroy();
  });
});

describe('核心集成：1000 页已知限制', () => {
  it('千页文档只创建页壳与可见 canvas，跳转末页不崩溃', async () => {
    const { viewer, document: engineDocument } = await openViewer(
      openMock,
      { pageCount: 1000 },
      { initialScale: 1 },
    );
    expect(viewer.getPageCount()).toBe(1000);
    expect(viewer.getPageViews()).toHaveLength(1000);

    await vi.waitFor(() => expect(engineDocument.renderLog.length).toBeGreaterThan(0));
    expect(engineDocument.renderLog.length).toBeLessThanOrEqual(6);
    expect(viewer.getRoot().querySelectorAll('.ofd-page__canvas').length).toBeLessThanOrEqual(4);

    viewer.goToPage(1000);
    expect(viewer.getPageNumber()).toBe(1000);
    await vi.waitFor(() =>
      expect(engineDocument.renderLog.length).toBeLessThanOrEqual(12),
    );
    viewer.destroy();
  });
});