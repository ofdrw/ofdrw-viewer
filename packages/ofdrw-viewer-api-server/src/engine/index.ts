/**
 * API 服务器 engine 适配层出口。
 *
 * 汇总字节源、Canvas/解码、字体、打开、导出、信息、验签与作业执行的公共导出，
 * 供 `src/index.ts` 与各路由模块引用。
 */

export { NodeFileByteSource, codedError, isErrnoError } from './source.js';
export type { CodedError, FileReadHandle } from './source.js';

export { createCanvasLike, encodeCanvasImage, loadCanvasModule } from './canvas.js';

export { nodeImageDecoders } from './decoder.js';

export {
  MAX_SCANNED_FONTS,
  MAX_SYSTEM_FONT_BYTES,
  MAX_SYSTEM_FONTS,
  clearSystemFontCache,
  discoverSystemFonts,
  isFontFileName,
  loadFontInputs,
  mergeFontFiles,
  scanFontDirectory,
  systemFontDirectories,
} from './fonts.js';
export type {
  FontFile,
  SystemFontDiscoveryOptions,
  SystemFontDiscoveryResult,
} from './fonts.js';

export { openDocument, openDocumentFromBytes } from './open.js';
export type {
  OpenDocumentFromBytesOptions,
  OpenDocumentOptions,
  OpenedDocument,
  OpenedDocumentCommonOptions,
} from './open.js';

export {
  CLI_MAX_CANVAS_PIXELS,
  SAFE_RESOURCE_ID,
  exportPageImage,
  exportPageText,
  getAttachmentsIndex,
  getMediaIndex,
  getOutlinePayload,
  getPageSizes,
  readAttachment,
  readMedia,
  toAttachmentDto,
  toMediaDto,
} from './export.js';
export type {
  ApiAttachmentDto,
  ApiMediaDto,
  ApiPageSize,
  OutlinePayload,
  PageImageExportOptions,
  PageImageExportResult,
  PageSizesPayload,
  PageTextExportOptions,
  PageTextExportResult,
  ResourceBytes,
  TextItemDto,
} from './export.js';

export { collectInfo } from './info.js';
export type { InfoDocument, InfoPageSize, InfoPayload } from './info.js';

export { verifyPackage } from './verify.js';
export type { VerifyPackageOptions } from './verify.js';

export {
  MAX_PAGE_RANGE_SPAN,
  MAX_SELECTED_PAGES,
  extensionOfMime,
  pageNumberWidth,
  parsePageRanges,
  resolvePageNumbers,
  runJob,
  validatePageNumbers,
  writeFileAtomic,
} from './jobs.js';
export type {
  JobOp,
  JobRunCallbacks,
  JobRunInput,
  JobRunParams,
} from './jobs.js';