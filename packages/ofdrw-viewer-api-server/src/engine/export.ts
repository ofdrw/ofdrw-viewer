/**
 * 文档读取与导出：单页图片、空间文本、页尺寸、目录、附件与音视频。
 *
 * 全部能力经 engine 公共 API 完成；本层只负责参数校验、DTO 收敛与错误码统一，
 * 不持有文档生命周期（由 `open.ts` 的 `OpenedDocument` 管理）。
 */

import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import type {
  AttachmentInfo,
  BookmarkItem,
  MediaResource,
  OFDPage,
  OutlineNode,
  PageImageFormat,
  TextChar,
} from '@ofdrw/ofdrw-viewer-engine';
import { codedError } from './source.js';

/**
 * 单页导出画布的像素上限，单位：像素。
 *
 * engine 默认不限制画布预算，由调用方按自身策略决策；API 服务器沿用 CLI 的
 * 保守上限，避免单页渲染耗尽进程内存。
 */
export const CLI_MAX_CANVAS_PIXELS = 64_000_000;

/**
 * 资源 ID 的安全字符集：仅允许 1–20 位十进制数字。
 *
 * 资源 ID 会进入作业文件名，任何其他字符都不允许通过。
 */
export const SAFE_RESOURCE_ID = /^[0-9]{1,20}$/u;

/** 图片导出参数。 */
export interface PageImageExportOptions {
  /** 输出精度，单位：DPI。 */
  readonly dpi: number;
  /** 图片格式。 */
  readonly format: PageImageFormat;
  /** JPEG/WebP 编码质量，0..1；PNG 忽略。 */
  readonly quality: number;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 单页图片导出结果。 */
export interface PageImageExportResult {
  /** 页号，1 起。 */
  readonly page: number;
  /** 输出宽度，单位：设备像素。 */
  readonly width: number;
  /** 输出高度，单位：设备像素。 */
  readonly height: number;
  /** 编码后的图片字节。 */
  readonly data: Uint8Array;
  /** MIME 类型，如 `image/png`。 */
  readonly mime: string;
}

/** 文本导出参数。 */
export interface PageTextExportOptions {
  /** 输出精度，单位：DPI；坐标换算依据。 */
  readonly dpi: number;
  /** 是否附带字符级数据。 */
  readonly includeChars: boolean;
  /** 是否包含不可见文字。 */
  readonly includeInvisible: boolean;
  /** 是否包含注释 Appearance 文字。 */
  readonly includeAnnotations: boolean;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 空间文本项；坐标为 px，原点为页面左上角。 */
export interface TextItemDto {
  /** 文本内容。 */
  readonly text: string;
  /** 包围盒左上角 x，单位：px。 */
  readonly x: number;
  /** 包围盒左上角 y，单位：px。 */
  readonly y: number;
  /** 包围盒宽度，单位：px。 */
  readonly w: number;
  /** 包围盒高度，单位：px。 */
  readonly h: number;
  /** 字符级数据；`includeChars` 为 true 时存在。 */
  readonly chars?: TextChar[];
}

/** 单页文本导出结果。 */
export interface PageTextExportResult {
  /** 页号，1 起。 */
  readonly page: number;
  /** 该 DPI 下的页面宽度，单位：设备像素（向上取整）。 */
  readonly width: number;
  /** 该 DPI 下的页面高度，单位：设备像素（向上取整）。 */
  readonly height: number;
  /** 文本项，保持 engine 返回顺序并跳过空文本。 */
  readonly items: TextItemDto[];
}

/** 单页尺寸；几何单位 mm。 */
export interface ApiPageSize {
  /** 页号，1 起。 */
  readonly page: number;
  /** 页宽，单位 mm。 */
  readonly widthMm: number;
  /** 页高，单位 mm。 */
  readonly heightMm: number;
}

/** 页尺寸列表。 */
export interface PageSizesPayload {
  /** 总页数。 */
  readonly pageCount: number;
  /** 每页尺寸，按页序。 */
  readonly pages: ApiPageSize[];
}

/** 目录与书签。 */
export interface OutlinePayload {
  /** 目录树，不扁平化。 */
  readonly outline: OutlineNode[];
  /** 书签列表，保持 XML 顺序。 */
  readonly bookmarks: BookmarkItem[];
}

/** 附件索引项。 */
export interface ApiAttachmentDto {
  /** Attachment@ID，十进制字符串。 */
  readonly id: string;
  /** Attachment@Name。 */
  readonly name: string;
  /** Attachment@Format；未声明时省略。 */
  readonly format?: string;
  /** 附件大小，单位 byte；未声明时省略。 */
  readonly size?: number;
  /** MIME 类型；未声明时省略。 */
  readonly mimeType?: string;
}

/** 音视频索引项。 */
export interface ApiMediaDto {
  /** 资源 ID，十进制字符串。 */
  readonly id: string;
  /** 媒体类型。 */
  readonly kind: 'audio' | 'video';
  /** MIME 类型，例如 `video/mp4`。 */
  readonly mimeType: string;
  /** XML `Format` 原文；未声明时省略。 */
  readonly format?: string;
  /** 资源大小，单位 byte；未探测到时省略。 */
  readonly sizeBytes?: number;
  /** 声明来源：公共 / 文档 / 页资源文件。 */
  readonly scope: 'public' | 'document' | 'page';
}

/** 单个附件或音视频资源的字节内容。 */
export interface ResourceBytes {
  /** 资源字节。 */
  readonly data: Uint8Array;
  /** 展示名称（附件取 Attachment@Name，音视频取包内文件名）。 */
  readonly name: string;
  /** MIME 类型。 */
  readonly mime: string;
  /** 字节数，单位 byte。 */
  readonly size: number;
}

/**
 * 按页号（1 起）取页面句柄。
 *
 * @param document 已打开文档
 * @param pageNumber 页号，1 起
 * @returns 页面
 * @throws OFDError `OFD_INVALID_PAGE`：页号越界
 */
async function requirePage(document: OFDDocument, pageNumber: number): Promise<OFDPage> {
  return document.getPage(pageNumber - 1);
}

/**
 * 生成页面在该 DPI 下的像素尺寸并校验画布像素上限。
 *
 * @param page 页面
 * @param pageNumber 页号，1 起，仅用于错误文案
 * @param dpi 输出 DPI
 * @returns 向上取整的宽高，单位：设备像素
 * @throws 带 `CLI_PAGE_TOO_LARGE` 码的错误：像素数超过 {@link CLI_MAX_CANVAS_PIXELS}
 */
function resolveCanvasSize(
  page: OFDPage,
  pageNumber: number,
  dpi: number,
): { width: number; height: number } {
  const viewport = page.getViewport({ dpi });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  if (width * height > CLI_MAX_CANVAS_PIXELS) {
    throw codedError(
      'CLI_PAGE_TOO_LARGE',
      `页面 ${pageNumber} 在 ${dpi} DPI 下为 ${width}×${height} 像素，超过上限 ${CLI_MAX_CANVAS_PIXELS}；请降低 dpi`,
    );
  }
  return { width, height };
}

/**
 * 导出单页图片。
 *
 * 先按 DPI 校验像素上限，再交由 engine 白底渲染与编码。
 *
 * @param document 已打开文档
 * @param pageNumber 页号，1 起
 * @param options 格式、DPI、质量与取消信号
 * @returns 图片字节、MIME 与像素尺寸
 * @throws 带 `CLI_PAGE_TOO_LARGE` 码的错误、OFDError（取消/渲染失败）
 */
export async function exportPageImage(
  document: OFDDocument,
  pageNumber: number,
  options: PageImageExportOptions,
): Promise<PageImageExportResult> {
  const page = await requirePage(document, pageNumber);
  resolveCanvasSize(page, pageNumber, options.dpi);
  const result = await page.exportImage({
    dpi: options.dpi,
    format: options.format,
    quality: options.quality,
    background: '#ffffff',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    page: pageNumber,
    width: result.width,
    height: result.height,
    data: result.data,
    mime: result.mime,
  };
}

/**
 * 导出单页空间文本。
 *
 * 坐标直接取 engine `item.rect`（px），保持返回顺序并跳过空文本。
 *
 * @param document 已打开文档
 * @param pageNumber 页号，1 起
 * @param options DPI、字符/不可见/注释开关与取消信号
 * @returns 该 DPI 下的页面像素尺寸与文本项
 * @throws OFDError（取消/文档关闭/渲染不支持）
 */
export async function exportPageText(
  document: OFDDocument,
  pageNumber: number,
  options: PageTextExportOptions,
): Promise<PageTextExportResult> {
  const page = await requirePage(document, pageNumber);
  const content = await page.getTextContent({
    dpi: options.dpi,
    includeChars: options.includeChars,
    includeInvisible: options.includeInvisible,
    includeAnnotations: options.includeAnnotations,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const items: TextItemDto[] = [];
  for (const item of content.items) {
    if (item.text.length === 0) continue;
    items.push({
      text: item.text,
      x: item.rect.x,
      y: item.rect.y,
      w: item.rect.width,
      h: item.rect.height,
      ...(item.chars === undefined ? {} : { chars: item.chars }),
    });
  }
  return {
    page: pageNumber,
    width: Math.max(1, Math.ceil(content.pageWidth)),
    height: Math.max(1, Math.ceil(content.pageHeight)),
    items,
  };
}

/**
 * 读取全部页尺寸。
 *
 * @param document 已打开文档
 * @returns 页数与每页尺寸（mm）
 * @throws OFDError（取消/文档关闭）
 */
export async function getPageSizes(document: OFDDocument): Promise<PageSizesPayload> {
  const pageInfos = await document.getPageInfos();
  return {
    pageCount: document.pageCount,
    pages: pageInfos.map((info) => ({
      page: info.index + 1,
      widthMm: info.widthMm,
      heightMm: info.heightMm,
    })),
  };
}

/**
 * 读取目录树与书签。
 *
 * @param document 已打开文档
 * @returns 目录树与书签，无数据时为空数组
 * @throws OFDError（取消/文档关闭）
 */
export async function getOutlinePayload(document: OFDDocument): Promise<OutlinePayload> {
  const [outline, bookmarks] = await Promise.all([
    document.getOutline(),
    document.getBookmarks(),
  ]);
  return { outline: [...outline], bookmarks: [...bookmarks] };
}

/**
 * 读取附件索引。
 *
 * @param document 已打开文档
 * @returns 附件索引列表；无附件时为空数组
 * @throws OFDError（取消/文档关闭）
 */
export async function getAttachmentsIndex(document: OFDDocument): Promise<ApiAttachmentDto[]> {
  const attachments = await document.getAttachments();
  return attachments.map(toAttachmentDto);
}

/**
 * 读取音视频资源索引。
 *
 * @param document 已打开文档
 * @returns 音视频索引列表；无音视频时为空数组
 * @throws OFDError（取消/文档关闭）
 */
export async function getMediaIndex(document: OFDDocument): Promise<ApiMediaDto[]> {
  const media = await document.getMediaResources();
  return media.map(toMediaDto);
}

/**
 * 把 engine 附件元信息收敛为附件 DTO。
 *
 * @param attachment engine 附件元信息
 * @returns 缺失字段省略的 DTO
 */
export function toAttachmentDto(attachment: AttachmentInfo): ApiAttachmentDto {
  return {
    id: attachment.id,
    name: attachment.name,
    ...(attachment.format === undefined ? {} : { format: attachment.format }),
    ...(attachment.size === undefined ? {} : { size: attachment.size }),
    ...(attachment.contentType === undefined ? {} : { mimeType: attachment.contentType }),
  };
}

/**
 * 把 engine 音视频资源收敛为媒体 DTO。
 *
 * @param media engine 音视频资源
 * @returns 缺失字段省略的 DTO
 */
export function toMediaDto(media: MediaResource): ApiMediaDto {
  return {
    id: media.id,
    kind: media.kind,
    mimeType: media.mimeType,
    ...(media.format === undefined ? {} : { format: media.format }),
    ...(media.sizeBytes === undefined ? {} : { sizeBytes: media.sizeBytes }),
    scope: media.scope,
  };
}

/**
 * 校验资源 ID 为十进制字符串。
 *
 * @param id 资源 ID
 * @param code 非法时的错误码
 * @throws 带指定码的错误
 */
function assertResourceId(id: string, code: 'CLI_USAGE' | 'CLI_MEDIA_NOT_FOUND'): void {
  if (!SAFE_RESOURCE_ID.test(id)) {
    throw codedError(code, `资源 ID 必须是 1–20 位十进制数字，收到：${JSON.stringify(id)}`);
  }
}

/**
 * 读取附件字节。
 *
 * @param document 已打开文档
 * @param id 附件 ID
 * @param signal 取消信号
 * @returns 附件内容；附件不存在或内容缺失时返回 `undefined`（由上层转 404）
 * @throws 带 `CLI_MEDIA_NOT_FOUND` 码的错误：ID 不是十进制字符串
 * @throws OFDError（取消/文档关闭/超限）
 */
export async function readAttachment(
  document: OFDDocument,
  id: string,
  signal?: AbortSignal,
): Promise<ResourceBytes | undefined> {
  assertResourceId(id, 'CLI_MEDIA_NOT_FOUND');
  const options = signal === undefined ? {} : { signal };
  const data = await document.getAttachmentData(id, options);
  if (data === undefined) return undefined;
  const info = (await document.getAttachments(options)).find(
    (attachment) => attachment.id === id,
  );
  return {
    data,
    name: info?.name ?? `attachment-${id}`,
    mime: info?.contentType ?? attachmentMimeOf(info?.format),
    size: data.byteLength,
  };
}

/**
 * 由附件 `Format` 推导 MIME 类型。
 *
 * @param format Attachment@Format，例如 `xml`
 * @returns 常见格式的 MIME；未声明或无法判定时为 `application/octet-stream`
 */
function attachmentMimeOf(format: string | undefined): string {
  switch (format?.trim().toLowerCase()) {
    case 'xml':
      return 'text/xml';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 读取音视频字节。
 *
 * @param document 已打开文档
 * @param id 资源 ID
 * @param signal 取消信号
 * @returns 资源内容；资源不存在或类型不符时返回 `undefined`（由上层转 404）
 * @throws 带 `CLI_USAGE` 码的错误：ID 不是十进制字符串
 * @throws OFDError（取消/文档关闭/超限）
 */
export async function readMedia(
  document: OFDDocument,
  id: string,
  signal?: AbortSignal,
): Promise<ResourceBytes | undefined> {
  assertResourceId(id, 'CLI_USAGE');
  const options = signal === undefined ? {} : { signal };
  const data = await document.getMediaData(id, options);
  if (data === undefined) return undefined;
  const resource = await document.getMediaResource(id, options);
  const baseName = resource?.mediaFile.split('/').at(-1) ?? '';
  return {
    data,
    name: baseName === '' ? `media-${id}` : baseName,
    mime: resource?.mimeType ?? 'application/octet-stream',
    size: data.byteLength,
  };
}
