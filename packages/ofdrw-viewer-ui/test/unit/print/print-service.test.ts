/**
 * 打印服务测试：范围、@page、混合尺寸、旋转、DPI、进度、取消与清理。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintService } from '../../../src/print/print-service';
import {
  buildPrintCss,
  preparePrintDocument,
} from '../../../src/print/print-document';
import { isOFDViewerError } from '../../../src/errors';
import { FakeHost } from '../export/fake-host';

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let printSpy: ReturnType<typeof vi.fn>;
let decodeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  createObjectURL = vi.fn(() => `blob:print-${createObjectURL.mock.calls.length}`);
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
  decodeSpy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: decodeSpy,
  });
  printSpy = vi.fn(() => {
    window.dispatchEvent(new Event('afterprint'));
  });
  Object.defineProperty(window, 'print', {
    configurable: true,
    writable: true,
    value: printSpy,
  });
});

afterEach(() => {
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
  delete (window as { print?: unknown }).print;
});

/** 断言抛出指定错误码。 */
function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  return expect(run()).rejects.toMatchObject({ code });
}

/** 准备打印文档的通用参数。 */
function prepareOptions(overrides: Partial<Parameters<typeof preparePrintDocument>[1]> = {}) {
  return {
    pages: [1],
    dpi: 96,
    rotation: 0 as const,
    includeBackground: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('打印范围与 DOM', () => {
  it('按 all/current/自定义范围逐页生成图片 + @page，不生成 PDF', async () => {
    const host = new FakeHost({ pageCount: 4, currentPage: 2 });
    let snapshot = { pages: 0, images: 0, css: '', root: false, pdf: 0 };
    printSpy.mockImplementation(() => {
      snapshot = {
        pages: document.querySelectorAll('.ofd-print-page').length,
        images: document.querySelectorAll('.ofd-print-page__image').length,
        css: document.querySelector('style[data-ofd-print-style]')?.textContent ?? '',
        root: document.querySelector('.ofd-print-root') !== null,
        pdf: document.querySelectorAll('canvas, iframe, object, embed').length,
      };
      window.dispatchEvent(new Event('afterprint'));
    });
    const service = new PrintService(host);

    await service.print({ pages: 'all' });
    expect(snapshot).toMatchObject({ pages: 4, images: 4, root: true, pdf: 0 });
    expect(snapshot.css).toContain('@page { size: 210mm 297mm; margin: 0; }');
    expect(snapshot.css).toContain('.ofd-viewer { display: none !important; }');
    expect(document.querySelector('.ofd-print-root')).toBeNull();
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(host.events.filter((event) => event.event === 'printstart')).toHaveLength(1);
    expect(host.events.filter((event) => event.event === 'printprogress')).toHaveLength(4);
    expect(host.events.filter((event) => event.event === 'printend')).toHaveLength(1);

    host.pages.forEach((page) => page.exportImage.mockClear());
    await service.print();
    expect(host.pages.map((page) => page.exportImage.mock.calls.length)).toEqual([0, 1, 0, 0]);

    host.pages.forEach((page) => page.exportImage.mockClear());
    await service.print({ range: '1,3' });
    expect(host.pages.map((page) => page.exportImage.mock.calls.length)).toEqual([1, 0, 1, 0]);
    expect(host.pages[0]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'png', dpi: 200, rotation: 0 }),
    );
  });

  it('混合页尺寸按尺寸分组使用命名 @page', async () => {
    const host = new FakeHost({
      pageSizes: [
        { widthMm: 210, heightMm: 297 },
        { widthMm: 148, heightMm: 210 },
        { widthMm: 210, heightMm: 297 },
      ],
    });
    const prepared = await preparePrintDocument(host, prepareOptions({ pages: [1, 2, 3] }));
    const css = prepared.style.textContent ?? '';
    expect(css).toContain('@page { size: auto; margin: 0; }');
    expect(css).toContain('@page ofd-size-0 { size: 210mm 297mm; margin: 0; }');
    expect(css).toContain('@page ofd-size-1 { size: 148mm 210mm; margin: 0; }');
    expect(
      [...prepared.container.querySelectorAll<HTMLElement>('.ofd-print-page')].map(
        (element) => element.dataset.size,
      ),
    ).toEqual(['0', '1', '0']);
    expect(prepared.container.style.display).toBe('');
    prepared.cleanup();
    expect(prepared.container.isConnected).toBe(false);
    expect(prepared.style.isConnected).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('统一尺寸只生成一条 @page，不使用命名页', async () => {
    const host = new FakeHost({ pageCount: 2 });
    const prepared = await preparePrintDocument(host, prepareOptions({ pages: [1, 2] }));
    const css = prepared.style.textContent ?? '';
    expect(css).toContain('@page { size: 210mm 297mm; margin: 0; }');
    expect(css).not.toContain('@page ofd-size-');
    expect(
      [...prepared.container.querySelectorAll<HTMLElement>('.ofd-print-page')].map(
        (element) => element.dataset.size,
      ),
    ).toEqual([undefined, undefined]);
    prepared.cleanup();
  });

  it('页面节点为 img 且尺寸使用 mm，不生成 PDF/canvas', async () => {
    const host = new FakeHost({ pageCount: 1 });
    const prepared = await preparePrintDocument(host, prepareOptions());
    const page = prepared.container.querySelector<HTMLElement>('.ofd-print-page')!;
    const image = page.querySelector('img')!;
    expect(page.style.width).toBe('210mm');
    expect(page.style.height).toBe('297mm');
    expect(image.style.width).toBe('210mm');
    expect(image.style.height).toBe('297mm');
    expect(page.querySelector('canvas, iframe, object, embed')).toBeNull();
    expect(image.src).toMatch(/^blob:/);
    prepared.cleanup();
  });
});

describe('打印旋转', () => {
  it('90/270 交换容器宽高并旋转图片；180 不交换', async () => {
    const host = new FakeHost({ pageCount: 1 });
    const quarter = await preparePrintDocument(
      host,
      prepareOptions({ rotation: 90 }),
    );
    const page90 = quarter.container.querySelector<HTMLElement>('.ofd-print-page')!;
    const img90 = page90.querySelector('img')!;
    expect(page90.style.width).toBe('297mm');
    expect(page90.style.height).toBe('210mm');
    expect(img90.style.width).toBe('210mm');
    expect(img90.style.height).toBe('297mm');
    expect(img90.style.transform).toContain('rotate(90deg)');
    expect(quarter.style.textContent).toContain('@page { size: 297mm 210mm; margin: 0; }');
    expect(host.pages[0]!.exportImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ rotation: 0 }),
    );
    quarter.cleanup();

    const half = await preparePrintDocument(host, prepareOptions({ rotation: 180 }));
    const page180 = half.container.querySelector<HTMLElement>('.ofd-print-page')!;
    expect(page180.style.width).toBe('210mm');
    expect(page180.style.height).toBe('297mm');
    expect(page180.querySelector('img')!.style.transform).toContain('rotate(180deg)');
    half.cleanup();
  });

  it('rotation=current 时沿用阅读旋转', async () => {
    const host = new FakeHost({ pageCount: 1, rotation: 270 });
    let css = '';
    printSpy.mockImplementation(() => {
      css = document.querySelector('style[data-ofd-print-style]')?.textContent ?? '';
      window.dispatchEvent(new Event('afterprint'));
    });
    await new PrintService(host).print({ rotation: 'current' });
    expect(css).toContain('@page { size: 297mm 210mm; margin: 0; }');
  });
});

describe('打印选项与守卫', () => {
  it('DPI 自适应与显式 DPI；背景开关生效', async () => {
    const host = new FakeHost({ pageCount: 3 });
    const service = new PrintService(host);
    await service.print({ pages: 'all', dpi: 300, includeBackground: true });
    expect(host.pages[0]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ dpi: 300, background: '#ffffff' }),
    );
    host.pages.forEach((page) => page.exportImage.mockClear());
    await service.print({ includeBackground: false });
    expect(host.pages[0]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ dpi: 200, background: null }),
    );
  });

  it('非法范围/DPI 报错且不打印', async () => {
    const host = new FakeHost({ pageCount: 2 });
    const service = new PrintService(host);
    await expectCode(() => service.print({ pages: { from: 0, to: 2 } }), 'OFD_INVALID_OPTION');
    await expectCode(() => service.print({ pages: '2-1' }), 'OFD_INVALID_OPTION');
    await expectCode(() => service.print({ dpi: 0 }), 'OFD_INVALID_OPTION');
    expect(printSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.ofd-print-root')).toBeNull();
  });

  it('功能关闭、文档禁止打印、引擎不支持时抛 OFD_FEATURE_DISABLED', async () => {
    const disabled = new FakeHost({ pageCount: 1 });
    disabled.getFeatureState = () => ({ enabled: false, visible: true, reason: 'host' });
    await expect(new PrintService(disabled).print()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'print',
    });

    const forbidden = new FakeHost({
      pageCount: 1,
      permissions: { print: { printable: false } },
    });
    await expect(new PrintService(forbidden).print()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'print',
    });

    const unsupported = new FakeHost({ pageCount: 1 });
    Object.defineProperty(unsupported.pages[0]!, 'exportImage', { value: undefined });
    await expect(new PrintService(unsupported).print()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'print',
    });
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('window.print 失败时报 OFD_PRINT_FAILED 并清理 DOM', async () => {
    const host = new FakeHost({ pageCount: 1 });
    printSpy.mockImplementation(() => {
      throw new Error('打印被拒绝');
    });
    await expectCode(() => new PrintService(host).print(), 'OFD_PRINT_FAILED');
    expect(document.querySelector('.ofd-print-root')).toBeNull();
    expect(document.querySelector('style[data-ofd-print-style]')).toBeNull();
  });
});

describe('打印进度与取消', () => {
  it('大任务逐页上报进度；取消后不调用 window.print 并清理', async () => {
    const host = new FakeHost({ pageCount: 1000 });
    const progress: Array<{ current: number; total: number }> = [];
    const warnings: string[] = [];
    const controller = new AbortController();
    const service = new PrintService(host, {
      onProgress: (event) => {
        progress.push(event);
        if (event.current === 1) controller.abort();
      },
      onWarning: (warning) => warnings.push(warning.code),
    });

    await expect(
      service.print({ pages: 'all', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(progress[0]).toEqual({ current: 1, total: 1000 });
    expect(warnings).toContain('W_OUTPUT_DPI_REDUCED');
    expect(warnings).toContain('W_OUTPUT_LARGE_TASK');
    expect(host.pages[0]!.exportImage).toHaveBeenCalledTimes(1);
    expect(host.pages[0]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ dpi: 96 }),
    );
    expect(printSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.ofd-print-root')).toBeNull();
  });

  it('开始前已取消则不生成任何页', async () => {
    const host = new FakeHost({ pageCount: 2 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      new PrintService(host).print({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.pages[0]!.exportImage).not.toHaveBeenCalled();
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('取消后释放已生成的 Object URL', async () => {
    const host = new FakeHost({ pageCount: 3 });
    const controller = new AbortController();
    const service = new PrintService(host, {
      onProgress: ({ current }) => {
        if (current === 2) controller.abort();
      },
    });
    await expect(
      service.print({ pages: 'all', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.ofd-print-root')).toBeNull();
  });
});

describe('打印样式工具', () => {
  it('buildPrintCss 可独立生成统一尺寸与混合尺寸规则', async () => {
    const uniformHost = new FakeHost({ pageCount: 1 });
    const uniform = await preparePrintDocument(uniformHost, prepareOptions());
    expect(buildPrintCss(uniform.pages)).toContain('@page { size: 210mm 297mm; margin: 0; }');
    uniform.cleanup();

    const mixedHost = new FakeHost({
      pageSizes: [
        { widthMm: 210, heightMm: 297 },
        { widthMm: 105, heightMm: 148 },
      ],
    });
    const mixed = await preparePrintDocument(
      mixedHost,
      prepareOptions({ pages: [1, 2] }),
    );
    const css = buildPrintCss(mixed.pages);
    expect(css).toContain('@page ofd-size-0 { size: 210mm 297mm; margin: 0; }');
    expect(css).toContain('@page ofd-size-1 { size: 105mm 148mm; margin: 0; }');
    mixed.cleanup();
  });
});