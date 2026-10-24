/**
 * 图片导出服务（设计方案 §10.5 / §10.6）。
 *
 * 职责：
 * - 单页图片导出（PNG/JPEG/WebP）并触发下载；
 * - 多页逐页导出，`fflate` 按需动态 import 打包 ZIP；
 * - 自适应 DPI、自动旋转、背景/质量选项；
 * - 进度、取消与大任务警告；取消后不产生半成品下载。
 *
 * 只使用引擎 `page.exportImage`，不触碰正常渲染结果。
 */

import type { DocumentPermissions, PageImageFormat } from '@ofdrw/ofdrw-viewer-engine';
import {
  createFeatureDisabledError,
  OFDViewerError,
  toOFDViewerError,
} from '../errors';
import type { ViewerFeature } from '../features';
import type {
  ExportImageOptions,
  ExportImageResult,
  ExportImagesOptions,
  ExportOfdOptions,
  ExportOfdResult,
  ImageFormat,
  PageRange,
} from '../types';
import {
  buildImageFilename,
  buildOfdFilename,
  buildZipFilename,
  downloadBlob,
  resolveDocumentName,
  uniqueEntryName,
} from './filename';
import {
  createAbortScope,
  createAbortError,
  getExportablePage,
  isAbortError,
  renderPageImage,
  throwIfAborted,
} from './image';
import {
  normalizePageNumber,
  normalizeRotation,
  resolveBackground,
  resolveDpi,
  resolveImageFormat,
  resolvePageRange,
  resolveQuality,
  type PageRangeInput,
} from './options';
import {
  createProgressDialog,
  reportOutputWarning,
  warnForLargeTask,
  type OutputHooks,
} from './progress';
import type { OutputHost } from './host';
import { createStoreZip, type ZipEntry } from './zip';
import { emitOutputEvent } from './events';

/** 多页导出选项；`range` 为 `pages` 的别名，便于自定义工具栏直接传范围文本。 */
export interface ExportImagesRequestOptions extends Omit<ExportImagesOptions, 'pages'> {
  /** 导出范围；默认 `current`。 */
  readonly pages?: PageRangeInput;
  /** 导出范围别名；与 `pages` 同时出现时优先 `range`。 */
  readonly range?: PageRangeInput;
}

/** 单页导出请求；`pages` 多余字段被忽略。 */
export type ExportImageRequestOptions = ExportImageOptions;

/** 导出服务所需的纯数据结果（不触发下载）。 */
export interface PreparedPageExport {
  /** 图片 Blob。 */
  readonly blob: Blob;
  /** 下载文件名。 */
  readonly filename: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 实际格式。 */
  readonly format: ImageFormat;
  /** 输出宽，设备像素。 */
  readonly width: number;
  /** 输出高，设备像素。 */
  readonly height: number;
  /** 实际 DPI。 */
  readonly dpi: number;
}

/**
 * 图片导出服务。
 */
export class ExportService {
  /**
   * @param host 阅读器宿主。
   * @param hooks 进度/警告回调；内置 UI 会自动显示 Toast，宿主可另接。
   */
  constructor(
    private readonly host: OutputHost,
    private readonly hooks: OutputHooks = {},
  ) {}

  /**
   * 导出单页图片并下载。
   *
   * @param options 导出选项；页码默认当前页，格式默认 PNG，DPI 默认自动（200）。
   * @returns 导出结果，包含 Blob、文件名与实际格式。
   */
  async exportImage(options: ExportImageOptions = {}): Promise<ExportImageResult> {
    const scope = createAbortScope(options.signal);
    const pageNumber = options.page ?? this.host.getPageNumber();
    try {
      this.assertFeature('export');
      const pageCount = this.requireDocument();
      const targetPage = normalizePageNumber(pageNumber, pageCount);
      const format = resolveImageFormat(options.format);
      const dpi = resolveDpi(options.dpi, 1);
      const quality = resolveQuality(options.quality);
      const background = resolveBackground(options.background, format);
      const rotation = normalizeRotation(options.rotation);
      await this.assertPermission('export');
      throwIfAborted(scope);

      const image = await renderPageImage(this.host, {
        pageNumber: targetPage,
        dpi,
        format,
        quality,
        background,
        rotation,
        signal: scope.signal,
        feature: 'export',
      });
      const filename = buildImageFilename({
        documentName: resolveDocumentName(this.host),
        pageNumber: targetPage,
        format: image.format,
        customName: options.filename,
      });
      throwIfAborted(scope);
      downloadBlob(this.ownerDocument(), image.blob, filename);
      this.hooks.onProgress?.({ current: 1, total: 1 });
      emitOutputEvent(this.host, 'exportprogress', { current: 1, total: 1 });
      return {
        blob: image.blob,
        filename,
        pageNumber: targetPage,
        format: image.format,
      };
    } catch (error) {
      throw this.toExportError(error, pageNumber);
    } finally {
      scope.dispose();
    }
  }

  /**
   * 导出当前 OFD 原文件并下载。
   *
   * 原样输出打开时的字节（加密文档保持原始加密包），不重新渲染；受 `export`
   * 功能与文档导出权限约束。
   *
   * @param options 文件名与取消信号。
   * @returns 原文件 Blob、文件名与字节数。
   */
  async exportOfd(options: ExportOfdOptions = {}): Promise<ExportOfdResult> {
    const scope = createAbortScope(options.signal);
    try {
      this.assertFeature('export');
      this.requireDocument();
      await this.assertPermission('export');
      throwIfAborted(scope);
      if (!this.host.readSourceBytes) {
        throw new OFDViewerError('OFD_EXPORT_FAILED', '当前宿主不支持导出 OFD 原文件');
      }
      const source = await this.host.readSourceBytes(scope.signal);
      throwIfAborted(scope);
      const bytes = new Uint8Array(source);
      if (bytes.byteLength === 0) {
        throw new OFDViewerError('OFD_EXPORT_FAILED', 'OFD 原文件为空');
      }
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/ofd' });
      const filename = buildOfdFilename({
        documentName: resolveDocumentName(this.host),
        customName: options.filename,
      });
      downloadBlob(this.ownerDocument(), blob, filename);
      this.hooks.onProgress?.({ current: 1, total: 1 });
      emitOutputEvent(this.host, 'exportprogress', { current: 1, total: 1 });
      return { blob, filename, size: bytes.byteLength };
    } catch (error) {
      throw this.toExportError(error, this.host.getPageNumber());
    } finally {
      scope.dispose();
    }
  }

  /**
   * 导出多页图片并打包 ZIP 下载。
   *
   * @param options 导出选项；默认导出当前页；多页打包为 ZIP。
   */
  async exportImages(options: ExportImagesRequestOptions = {}): Promise<void> {
    const scope = createAbortScope(options.signal);
    const progressDialog = { current: null as ReturnType<typeof createProgressDialog> };
    try {
      this.assertFeature('export');
      const pageCount = this.requireDocument();
      const pages = resolvePageRange(
        options.range ?? options.pages,
        this.host.getPageNumber(),
        pageCount,
      );
      const format = resolveImageFormat(options.format);
      const dpi = resolveDpi(options.dpi, pages.length);
      const autoDpi = options.dpi === undefined || options.dpi === 'auto';
      const quality = resolveQuality(options.quality);
      const background = resolveBackground(options.background, format);
      const rotation = normalizeRotation(options.rotation);
      const documentName = resolveDocumentName(this.host);
      warnForLargeTask(this.host, this.hooks, 'export', pages.length, autoDpi);
      await this.assertPermission('export');
      throwIfAborted(scope);
      // 预检首页能力，避免打开进度框后才失败。
      await getExportablePage(this.host, pages[0]!, 'export');
      throwIfAborted(scope);

      progressDialog.current = createProgressDialog(
        this.host,
        'export',
        format === 'png' ? '正在导出图片' : `正在导出 ${format.toUpperCase()} 图片`,
        pages.length,
        () => scope.abort(),
      );

      const entries: ZipEntry[] = [];
      const usedNames = new Set<string>();
      const failures: Array<{ pageNumber: number; error: unknown }> = [];
      let processed = 0;
      for (const pageNumber of pages) {
        throwIfAborted(scope);
        try {
          const image = await renderPageImage(this.host, {
            pageNumber,
            dpi,
            format,
            quality,
            background,
            rotation,
            signal: scope.signal,
            feature: 'export',
          });
          const filename = buildImageFilename({
            documentName,
            pageNumber,
            format: image.format,
            // 多页导出即使指定自定义名称也保留页码，避免 ZIP 内互相覆盖。
            customName: options.filename
              ? `${options.filename}-p${pageNumber}`
              : undefined,
          });
          entries.push({ name: uniqueEntryName(filename, usedNames), data: image.data });
        } catch (error) {
          if (isAbortError(error) || scope.signal.aborted) throw createAbortError();
          failures.push({ pageNumber, error });
          reportOutputWarning(
            this.host,
            this.hooks,
            'W_EXPORT_PAGE',
            `第 ${pageNumber} 页导出失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        processed += 1;
        this.hooks.onProgress?.({ current: processed, total: pages.length });
        emitOutputEvent(this.host, 'exportprogress', {
          current: processed,
          total: pages.length,
        });
        progressDialog.current?.update(processed, pages.length);
      }

      if (entries.length === 0) {
        const first = failures[0];
        throw new OFDViewerError(
          'OFD_EXPORT_FAILED',
          `全部 ${pages.length} 页导出失败${first ? `：${describeError(first.error)}` : ''}`,
          first ? { pageNumber: first.pageNumber } : {},
        );
      }
      throwIfAborted(scope);
      const zip = await createStoreZip(entries);
      throwIfAborted(scope);
      const zipName = buildZipFilename({
        documentName,
        customName: options.zipFilename,
      });
      downloadBlob(this.ownerDocument(), zip, zipName);
      if (failures.length > 0) {
        reportOutputWarning(
          this.host,
          this.hooks,
          'W_EXPORT_PARTIAL',
          `${failures.length} 页导出失败，已跳过并继续其余页面`,
        );
      }
    } catch (error) {
      throw this.toExportError(error, this.host.getPageNumber());
    } finally {
      progressDialog.current?.close();
      scope.dispose();
    }
  }

  /** 断言功能可用。 */
  private assertFeature(feature: ViewerFeature): void {
    const state = this.host.getFeatureState(feature);
    if (!state.enabled) throw createFeatureDisabledError(feature);
  }

  /** 断言文档已打开并返回页数。 */
  private requireDocument(): number {
    const pageCount = this.host.getPageCount();
    if (!Number.isFinite(pageCount) || pageCount < 1) {
      throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开');
    }
    return pageCount;
  }

  /** 读取文档权限；导出被文档禁止时按功能关闭处理。 */
  private async assertPermission(feature: 'export' | 'print'): Promise<void> {
    let permissions: DocumentPermissions | null = null;
    try {
      permissions = await this.host.getPermissions();
    } catch {
      permissions = null;
    }
    if (!permissions) return;
    if (feature === 'export' && permissions.export === false) {
      throw createFeatureDisabledError('export', '当前文档不允许导出');
    }
    if (
      feature === 'print' &&
      permissions.print &&
      (permissions.print.printable === false || permissions.print.copies === 0)
    ) {
      throw createFeatureDisabledError('print', '当前文档不允许打印');
    }
  }

  /** 读取宿主文档。 */
  private ownerDocument(): Document {
    const root = this.host.getElements().root;
    const doc = root.ownerDocument;
    if (!doc) throw new OFDViewerError('OFD_EXPORT_FAILED', '无法访问宿主文档');
    return doc;
  }

  /** 把任意错误转换为导出错误；取消与功能关闭错误原样透出。 */
  private toExportError(error: unknown, pageNumber: number): unknown {
    if (isAbortError(error)) return createAbortError();
    if (error instanceof OFDViewerError) return error;
    return toOFDViewerError(
      error,
      'OFD_EXPORT_FAILED',
      `导出失败：${describeError(error)}`,
      { pageNumber },
    );
  }
}

/** 错误信息摘要。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 供外部复用的范围类型。 */
export type { PageRange, PageRangeInput };