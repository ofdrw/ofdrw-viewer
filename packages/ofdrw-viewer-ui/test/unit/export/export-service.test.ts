/**
 * 图片导出服务测试：格式/质量/背景、ZIP 文件名、自适应 DPI、进度、取消与错误。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { ExportService } from '../../../src/export/export-service';
import { renderPageImage } from '../../../src/export/image';
import { isOFDViewerError } from '../../../src/errors';
import { FakeHost } from './fake-host';

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let anchorClick: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.body.innerHTML = '';
  createObjectURL = vi.fn(() => `blob:mock-${createObjectURL.mock.calls.length}`);
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
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  anchorClick.mockRestore();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

/** 读取第 N 次下载的 Blob。 */
function downloadedBlob(index = 0): Blob {
  return createObjectURL.mock.calls[index]![0] as Blob;
}

/** 断言抛出指定错误码。 */
function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  return expect(run()).rejects.toMatchObject({ code });
}

describe('exportImage 单页导出', () => {
  it('默认导出当前页 PNG，自动 DPI 200，文件名含页码并触发下载', async () => {
    const host = new FakeHost({ pageCount: 3, currentPage: 2 });
    const service = new ExportService(host);
    const result = await service.exportImage();

    expect(result.pageNumber).toBe(2);
    expect(result.format).toBe('png');
    expect(result.filename).toBe('测试文档-p2.png');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(host.pages[1]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({
        dpi: 200,
        format: 'png',
        quality: 0.92,
        rotation: 0,
        background: '#ffffff',
      }),
    );
    expect(host.pages[1]!.render).not.toHaveBeenCalled();
    expect(host.events).toContainEqual({ event: 'exportprogress', payload: { current: 1, total: 1 } });
  });

  it('JPEG/WebP 质量生效，透明背景被强制为白底；WebP 不支持时回退 PNG 文件名', async () => {
    const host = new FakeHost({ pageCount: 1 });
    const service = new ExportService(host);
    await service.exportImage({ page: 1, format: 'jpeg', quality: 0.5, background: null });
    expect(host.pages[0]!.exportImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: 'jpeg', quality: 0.5, background: '#ffffff' }),
    );

    const fallbackHost = new FakeHost({ pageCount: 1, webpFallback: true });
    const fallbackService = new ExportService(fallbackHost);
    const result = await fallbackService.exportImage({ format: 'webp', background: null });
    expect(result.format).toBe('png');
    expect(result.filename).toBe('测试文档-p1.png');
  });

  it('PNG 显式 null 背景得到透明输出', async () => {
    const host = new FakeHost({ pageCount: 1 });
    const service = new ExportService(host);
    await service.exportImage({ background: null });
    expect(host.pages[0]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ background: null, format: 'png' }),
    );
  });

  it('自定义文件名（不含扩展名）生效', async () => {
    const host = new FakeHost({ pageCount: 1 });
    const result = await new ExportService(host).exportImage({ filename: '封面' });
    expect(result.filename).toBe('封面.png');
  });

  it('功能关闭、文档禁止导出、引擎不支持时抛 OFD_FEATURE_DISABLED', async () => {
    const disabled = new FakeHost({ pageCount: 1 });
    disabled.getFeatureState = () => ({ enabled: false, visible: true, reason: 'host' });
    await expect(new ExportService(disabled).exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });

    const forbidden = new FakeHost({ pageCount: 1, permissions: { export: false } });
    await expect(new ExportService(forbidden).exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });

    const unsupported = new FakeHost({ pageCount: 1 });
    Object.defineProperty(unsupported.pages[0]!, 'exportImage', { value: undefined });
    await expect(new ExportService(unsupported).exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });
  });

  it('页码/格式/质量非法时报对应错误', async () => {
    const host = new FakeHost({ pageCount: 2 });
    const service = new ExportService(host);
    await expectCode(() => service.exportImage({ page: 3 }), 'OFD_INVALID_PAGE');
    await expectCode(
      () => service.exportImage({ format: 'gif' as never }),
      'OFD_INVALID_OPTION',
    );
    await expectCode(() => service.exportImage({ quality: 1.5 }), 'OFD_INVALID_OPTION');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('旋转 90/270 输出尺寸交换', async () => {
    const host = new FakeHost({ pageCount: 1 });
    const natural = await renderPageImage(host, {
      pageNumber: 1,
      dpi: 96,
      format: 'png',
      quality: 0.92,
      background: '#ffffff',
      rotation: 0,
      signal: new AbortController().signal,
      feature: 'export',
    });
    const rotated = await renderPageImage(host, {
      pageNumber: 1,
      dpi: 96,
      format: 'png',
      quality: 0.92,
      background: '#ffffff',
      rotation: 90,
      signal: new AbortController().signal,
      feature: 'export',
    });
    expect(rotated.width).toBe(natural.height);
    expect(rotated.height).toBe(natural.width);
    expect(host.pages[0]!.exportImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ rotation: 90 }),
    );
  });
});

describe('exportImages 多页导出', () => {
  it('逐页导出并打包 ZIP，内部文件名包含页码且不覆盖', async () => {
    const host = new FakeHost({ pageCount: 3 });
    const warnings: string[] = [];
    const service = new ExportService(host, { onWarning: (warning) => warnings.push(warning.code) });
    await service.exportImages({ pages: 'all' });

    expect(anchorClick).toHaveBeenCalledTimes(1);
    const zip = unzipSync(new Uint8Array(await downloadedBlob().arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual([
      '测试文档-p1.png',
      '测试文档-p2.png',
      '测试文档-p3.png',
    ]);
    expect(warnings).toEqual([]);
  });

  it('默认只导出当前页；自定义文件名与 ZIP 名生效', async () => {
    const host = new FakeHost({ pageCount: 3, currentPage: 2 });
    await new ExportService(host).exportImages({
      filename: '页面',
      zipFilename: '打包.zip',
    });
    const zip = unzipSync(new Uint8Array(await downloadedBlob().arrayBuffer()));
    expect(Object.keys(zip)).toEqual(['页面-p2.png']);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('按任务页数自适应 DPI：60 页 150，250 页 96 并提示降精度', async () => {
    const medium = new FakeHost({ pageCount: 60 });
    await new ExportService(medium).exportImages({ pages: 'all' });
    expect(medium.pages[0]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ dpi: 150 }),
    );

    const large = new FakeHost({ pageCount: 250 });
    createObjectURL.mockClear();
    const warnings: string[] = [];
    const controller = new AbortController();
    const service = new ExportService(large, {
      onWarning: (warning) => warnings.push(warning.code),
      onProgress: ({ current }) => {
        if (current === 1) controller.abort();
      },
    });
    await expect(service.exportImages({ pages: 'all', signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(large.pages[0]!.exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ dpi: 96 }),
    );
    expect(warnings).toContain('W_OUTPUT_DPI_REDUCED');
    expect(large.events).toContainEqual(
      expect.objectContaining({ event: 'warning' }),
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('1000 页任务有进度/警告，取消后不下载半成品', async () => {
    const host = new FakeHost({ pageCount: 1000 });
    const progress: Array<{ current: number; total: number }> = [];
    const warnings: string[] = [];
    const controller = new AbortController();
    const service = new ExportService(host, {
      onProgress: (event) => {
        progress.push(event);
        if (event.current === 1) controller.abort();
      },
      onWarning: (warning) => warnings.push(warning.code),
    });

    await expect(
      service.exportImages({ range: 'all', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(progress[0]).toEqual({ current: 1, total: 1000 });
    expect(host.events).toContainEqual({ event: 'exportprogress', payload: { current: 1, total: 1000 } });
    expect(warnings).toContain('W_OUTPUT_DPI_REDUCED');
    expect(warnings).toContain('W_OUTPUT_LARGE_TASK');
    expect(host.pages[0]!.exportImage).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('开始前已取消则不导出、不下载', async () => {
    const host = new FakeHost({ pageCount: 3 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ExportService(host).exportImages({ pages: 'all', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.pages[0]!.exportImage).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('单页失败时跳过并继续，最终打包成功页并提示', async () => {
    const host = new FakeHost({ pageCount: 2 });
    host.pages[0]!.exportImage.mockRejectedValueOnce(new Error('页面损坏'));
    const warnings: string[] = [];
    await new ExportService(host, {
      onWarning: (warning) => warnings.push(warning.code),
    }).exportImages({ pages: 'all' });

    const zip = unzipSync(new Uint8Array(await downloadedBlob().arrayBuffer()));
    expect(Object.keys(zip)).toEqual(['测试文档-p2.png']);
    expect(warnings).toContain('W_EXPORT_PAGE');
    expect(warnings).toContain('W_EXPORT_PARTIAL');
  });

  it('全部页失败时报 OFD_EXPORT_FAILED 且不下载', async () => {
    const host = new FakeHost({ pageCount: 2 });
    host.pages.forEach((page) => page.exportImage.mockRejectedValue(new Error('失败')));
    await expectCode(
      () => new ExportService(host).exportImages({ pages: 'all' }),
      'OFD_EXPORT_FAILED',
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('多页导出同样受功能关闭与文档权限约束', async () => {
    const disabled = new FakeHost({ pageCount: 2 });
    disabled.getFeatureState = () => ({ enabled: false, visible: true, reason: 'host' });
    await expectCode(
      () => new ExportService(disabled).exportImages({ pages: 'all' }),
      'OFD_FEATURE_DISABLED',
    );
    const forbidden = new FakeHost({ pageCount: 2, permissions: { export: false } });
    await expectCode(
      () => new ExportService(forbidden).exportImages({ pages: 'all' }),
      'OFD_FEATURE_DISABLED',
    );
  });

  it('非法范围不修改页面渲染结果', async () => {
    const host = new FakeHost({ pageCount: 2 });
    await expectCode(
      () => new ExportService(host).exportImages({ pages: { from: 2, to: 1 } }),
      'OFD_INVALID_OPTION',
    );
    for (const page of host.pages) {
      expect(page.render).not.toHaveBeenCalled();
      expect(page.exportImage).not.toHaveBeenCalled();
    }
  });
});

describe('导出错误类型', () => {
  it('引擎错误包装为 OFD_EXPORT_FAILED，取消保留 AbortError', async () => {
    const host = new FakeHost({ pageCount: 1 });
    host.pages[0]!.exportImage.mockRejectedValueOnce(new Error('编码失败'));
    try {
      await new ExportService(host).exportImage();
      throw new Error('应当抛出');
    } catch (error) {
      expect(isOFDViewerError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('OFD_EXPORT_FAILED');
    }

    const abortHost = new FakeHost({ pageCount: 1 });
    const controller = new AbortController();
    abortHost.pages[0]!.exportImage.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    });
    await expect(
      new ExportService(abortHost).exportImage({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
