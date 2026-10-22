/**
 * 图片导出模块入口。
 *
 * 模块加载时向阅读器注册 `ExportService`：`viewer.exportImage()` /
 * `viewer.exportImages()` 由此可用。t9 入口会 side-effect import 本文件。
 */

import { registerViewerExtension } from '../viewer';
import { ExportService } from './export-service';

/** 将导出服务挂到阅读器实例。 */
registerViewerExtension((viewer) => viewer.attachExportService(new ExportService(viewer)));

export { ExportService } from './export-service';
export type {
  ExportImageRequestOptions,
  ExportImagesRequestOptions,
  PreparedPageExport,
} from './export-service';
export { createStoreZip } from './zip';
export type { ZipEntry } from './zip';
export {
  buildImageFilename,
  buildZipFilename,
  downloadBlob,
  extensionForFormat,
  resolveDocumentName,
  sanitizeFileName,
  uniqueEntryName,
} from './filename';
export {
  AUTO_DPI_LARGE,
  AUTO_DPI_MEDIUM,
  AUTO_DPI_SMALL,
  computeOutputSize,
  normalizePageNumber,
  normalizeRotation,
  parseRangeText,
  resolveAutoDpi,
  resolveBackground,
  resolveDpi,
  resolveImageFormat,
  resolvePageRange,
  resolveQuality,
} from './options';
export type { PageRangeInput } from './options';
export {
  createAbortError,
  createAbortScope,
  formatFromMime,
  getExportablePage,
  isAbortError,
  renderPageImage,
  throwIfAborted,
} from './image';
export type {
  AbortScope,
  PageImageOutput,
  PageImageRequest,
} from './image';
export { createProgressDialog, reportOutputWarning, warnForLargeTask } from './progress';
export type { OutputHooks, OutputProgressHandle } from './progress';
export type { OutputHost, OutputDocumentState } from './host';