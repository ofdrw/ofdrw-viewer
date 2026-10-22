/**
 * 打印/导出集成基线：真实阅读器 + 公共入口注册的输出服务。
 *
 * 打印断言捕获 `window.print()` 调用瞬间的 DOM；导出通过替换 Object URL 与锚点
 * 点击捕获文件名与 ZIP 内容，不写真实文件、不访问网络。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { unzipSync } from 'fflate';
import { ALLOW_ALL_PERMISSIONS } from '../helpers/document';
import { captureDownloads, installDomEnvironment } from '../helpers/environment';
import { openViewer, type EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;

/** 未旋转 A4 打印尺寸，单位 mm。 */
const A4 = { widthMm: 210, heightMm: 297 };
/** 横向 A3 页面，用于验证混合尺寸命名页。 */
const A3_LANDSCAPE = { widthMm: 297, heightMm: 210 };

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('打印集成', () => {
  it('范围解析、混合页尺寸 @page、旋转与 DOM 清理', async () => {
    const capture = captureDownloads();
    const { viewer, document: engineDocument } = await openViewer(openMock, {
      pageCount: 5,
      pageSizesMm: [A4, A4, A3_LANDSCAPE, A4, A4],
      metadata: { version: '1.0', pageCount: 5, title: '测试文档 A' },
    });
    const events: string[] = [];
    viewer.on('printstart', () => events.push('start'));
    viewer.on('printprogress', () => events.push('progress'));
    viewer.on('printend', () => events.push('end'));

    interface PrintSnapshot {
      pages: number[];
      sizes: Array<string | null>;
      containers: Array<{ width: string; height: string; imageTransform: string }>;
      css: string;
    }
    let snapshot: PrintSnapshot | null = null;
    vi.spyOn(window, 'print').mockImplementation(() => {
      const root = document.querySelector<HTMLElement>('.ofd-print-root')!;
      snapshot = {
        pages: [...root.querySelectorAll<HTMLElement>('.ofd-print-page')].map((element) =>
          Number(element.dataset.pageNumber),
        ),
        sizes: [...root.querySelectorAll<HTMLElement>('.ofd-print-page')].map(
          (element) => element.dataset.size ?? null,
        ),
        containers: [...root.querySelectorAll<HTMLElement>('.ofd-print-page')].map(
          (element) => ({
            width: element.style.width,
            height: element.style.height,
            imageTransform:
              element.querySelector<HTMLElement>('.ofd-print-page__image')?.style.transform ??
              '',
          }),
        ),
        css: document.querySelector('style[data-ofd-print-style]')?.textContent ?? '',
      };
      window.dispatchEvent(new Event('afterprint'));
    });

    await viewer.print({ pages: [1, 2, 3, 5], dpi: 96 });
    expect(snapshot).not.toBeNull();
    const printed = snapshot as unknown as PrintSnapshot;
    expect(printed.pages).toEqual([1, 2, 3, 5]);
    expect(printed.sizes).toEqual(['0', '0', '1', '0']);
    expect(printed.containers[2]).toMatchObject({ width: '297mm', height: '210mm' });
    expect(printed.containers[0]).toMatchObject({ width: '210mm', height: '297mm' });
    expect(printed.css).toContain('@page ofd-size-0');
    expect(printed.css).toMatch(/@page ofd-size-0[\s\S]*?size: 210mm 297mm/);
    expect(printed.css).toMatch(/@page ofd-size-1[\s\S]*?size: 297mm 210mm/);
    expect(engineDocument.exportLog.map((call) => call.pageNumber)).toEqual([1, 2, 3, 5]);
    expect(engineDocument.exportLog[0]?.options).toMatchObject({
      dpi: 96,
      format: 'png',
      rotation: 0,
      background: null,
    });
    expect(events.filter((event) => event === 'start')).toHaveLength(1);
    expect(events.filter((event) => event === 'end')).toHaveLength(1);
    expect(events).toContain('progress');

    // 打印结束后 DOM、样式与 Object URL 全部释放。
    expect(document.querySelector('.ofd-print-root')).toBeNull();
    expect(document.querySelector('style[data-ofd-print-style]')).toBeNull();
    expect(capture.revoked.length).toBe(4);

    // 旋转打印：交换容器宽高，图片 CSS rotate；引擎导出仍按未旋转像素。
    viewer.setRotation(90);
    snapshot = null;
    await viewer.print({ pages: [2], dpi: 72, rotation: 'current' });
    const rotated = snapshot as unknown as PrintSnapshot;
    expect(rotated.pages).toEqual([2]);
    expect(rotated.containers[0]).toMatchObject({ width: '297mm', height: '210mm' });
    expect(rotated.containers[0]?.imageTransform).toContain('rotate(90deg)');
    expect(document.querySelector('.ofd-print-page')).toBeNull();
    expect(engineDocument.exportLog.at(-1)?.options).toMatchObject({
      dpi: 72,
      rotation: 0,
    });
    expect(rotated.css).toContain('size: 297mm 210mm');
    viewer.destroy();
    capture.restore();
  });
});

describe('导出集成', () => {
  it('单页文件名清洗、多页 ZIP 含页码且质量/背景/DPI 生效', async () => {
    const capture = captureDownloads();
    const { viewer, document: engineDocument } = await openViewer(openMock, {
      pageCount: 5,
      metadata: { version: '1.0', pageCount: 5, title: '测试文档 A' },
    });
    const progress: number[] = [];
    viewer.on('exportprogress', (event) => progress.push(event.current));

    const result = await viewer.exportImage({
      page: 2,
      format: 'jpeg',
      quality: 0.7,
      filename: '封面:1',
    });
    expect(result).toMatchObject({ pageNumber: 2, format: 'jpeg', filename: '封面_1.jpg' });
    expect(engineDocument.exportLog.at(-1)?.options).toMatchObject({
      dpi: 200,
      format: 'jpeg',
      quality: 0.7,
      background: '#ffffff',
      rotation: 0,
    });
    expect(capture.downloads.at(-1)).toMatchObject({ filename: '封面_1.jpg' });

    await viewer.exportImages({
      pages: [1, 2, 3],
      format: 'png',
      filename: '预览',
      zipFilename: '打包',
    });
    const zipDownload = capture.downloads.at(-1)!;
    expect(zipDownload.filename).toBe('打包.zip');
    expect(zipDownload.blob).toBeDefined();
    const entries = unzipSync(new Uint8Array(await zipDownload.blob!.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      '预览-p1.png',
      '预览-p2.png',
      '预览-p3.png',
    ]);
    expect([...progress]).toEqual([1, 1, 2, 3]);
    viewer.destroy();
    capture.restore();
  });

  it('文档权限禁止导出/打印时按功能关闭处理', async () => {
    const { viewer } = await openViewer(openMock, {
      pageCount: 2,
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
    await expect(viewer.exportImage()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'export',
    });
    await expect(viewer.print()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'print',
    });
    expect(document.querySelector('.ofd-print-root')).toBeNull();
    viewer.destroy();
  });
});