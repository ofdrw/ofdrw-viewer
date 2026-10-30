/**
 * 与真实 OFDViewer 核心的接线测试。
 *
 * 验证 t9 侧 side-effect import 两个入口后：服务被挂到实例上，
 * `viewer.exportImage()` / `viewer.print()` 可用，且 feature/权限守卫仍然生效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

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
import '../../../src/print/index';
import '../../../src/export/index';

/** 假的引擎页面。 */
function makePage(index: number) {
  return {
    index,
    getSize: () => ({ width: 210, height: 297 }),
    getViewport: (options: { dpi?: number } = {}) => {
      const dpi = options.dpi ?? 96;
      return {
        width: Math.ceil((210 / 25.4) * dpi),
        height: Math.ceil((297 / 25.4) * dpi),
        dpi,
      };
    },
    render: (params: { canvasContext: { clearRect: (...args: number[]) => void } }) => {
      params.canvasContext.clearRect(0, 0, 1, 1);
      return { promise: Promise.resolve(), cancel: () => undefined };
    },
    getTextContent: async () => ({ items: [], chars: [] }),
    exportImage: async (options: { dpi?: number; rotation?: number } = {}) => {
      const dpi = options.dpi ?? 96;
      const rotation = options.rotation ?? 0;
      const quarter = rotation === 90 || rotation === 270;
      const width = Math.ceil((210 / 25.4) * dpi);
      const height = Math.ceil((297 / 25.4) * dpi);
      return {
        data: new Uint8Array([index + 1]),
        mime: 'image/png' as const,
        width: quarter ? height : width,
        height: quarter ? width : height,
        dpi,
      };
    },
  };
}

/** 假引擎文档。 */
function makeDocument(pageCount: number, options: { export?: boolean } = {}) {
  const infos: PageInfo[] = Array.from({ length: pageCount }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
  return {
    pageCount,
    getPageInfos: async () => infos,
    getPage: async (index: number) => makePage(index),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount }),
    getPermissions: async () => ({
      edit: true,
      annot: true,
      export: options.export ?? true,
      signature: true,
      watermark: true,
      printScreen: true,
    }),
    getSignatureEntries: async () => [],
    getSignedValue: async () => undefined,
    close: async () => undefined,
  };
}

let createObjectURL: ReturnType<typeof vi.fn>;
let printSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => makeDocument(2));
  createObjectURL = vi.fn(() => 'blob:viewer-integration');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  printSpy = vi.fn(() => window.dispatchEvent(new Event('afterprint')));
  Object.defineProperty(window, 'print', {
    configurable: true,
    writable: true,
    value: printSpy,
  });
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
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
  delete (window as { print?: unknown }).print;
});

describe('打印/导出与 OFDViewer 接线', () => {
  it('入口自注册后 viewer.exportImage/print 可用，且不修改页面渲染结果', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    expect(viewer.getFeatureState('export').enabled).toBe(true);

    const result = await viewer.exportImage({ page: 2, dpi: 96 });
    expect(result.pageNumber).toBe(2);
    expect(result.format).toBe('png');
    expect(result.filename).toContain('p2');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    await viewer.print({ pages: 'all' });
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ofd-print-root')).toBeNull();
    viewer.destroy();
  });

  it('features=false 时方法抛 OFD_FEATURE_DISABLED，服务不被调用', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      features: { print: false, export: false },
    });
    await viewer.ready;
    await expect(viewer.exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });
    await expect(viewer.print()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'print',
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(printSpy).not.toHaveBeenCalled();
    viewer.destroy();
  });

  it('文档权限禁止导出时有效状态为 disabled，不能强行开启', async () => {
    engineMocks.open.mockImplementation(async () => makeDocument(1, { export: false }));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      features: { export: true },
    });
    await viewer.ready;
    expect(viewer.getFeatureState('export').enabled).toBe(false);
    expect(viewer.getFeatureState('export').reason).toBe('document');
    await expect(viewer.exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });
    viewer.destroy();
  });
});