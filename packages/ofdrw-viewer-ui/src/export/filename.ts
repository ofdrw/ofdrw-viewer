/**
 * 导出文件命名与下载（设计方案 §10.5）。
 *
 * 文件名必须包含页码，避免多页导出互相覆盖；同时清洗 Windows/Unix 非法字符
 * 与控制字符，保证跨平台可用。
 */

import type { PageImageFormat } from '@ofdrw/ofdrw-viewer-engine';
import type { OutputHost } from './host';

/** 文件名最大长度；超出截断，保留页码后缀。 */
const MAX_BASE_LENGTH = 80;

/**
 * 清洗文件名片段。
 *
 * @param value 原始文本，例如文档标题。
 * @returns 去掉 `/\:*?"<>|`、控制字符与首尾空白/点号的文本；为空时返回空字符串。
 */
export function sanitizeFileName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .trim();
}

/**
 * 格式对应的文件扩展名。
 *
 * @param format 图片格式。
 * @returns 扩展名，不含点；JPEG 使用 `jpg`。
 */
export function extensionForFormat(format: PageImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

/**
 * 从文档来源推导文件名。
 *
 * 优先使用原始 URL/文件名的 basename（去扩展名），其次 metadata.title，
 * 都无法推导时返回 `document`；规范化来源不再参与命名。
 *
 * @param host 输出宿主。
 * @returns 清洗后的文档名；无法推导时为 `document`。
 */
export function resolveDocumentName(host: OutputHost): string {
  const document = host.getState().document;
  const origin = document.origin;
  if (origin) {
    const path = origin.kind === 'url' ? origin.url : origin.kind === 'file' ? origin.name : '';
    const name = path ? fileNameFromPath(path) : '';
    if (name) return name;
  }
  const title = document.metadata?.title;
  if (title) {
    const cleaned = sanitizeFileName(title);
    if (cleaned) return cleaned;
  }
  return 'document';
}

/**
 * 构造单页图片文件名。
 *
 * @param options 文档名、页码、格式与自定义文件名。
 * @returns 含扩展名的文件名。
 */
export function buildImageFilename(options: {
  /** 文档名（已清洗）。 */
  readonly documentName: string;
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 实际格式。 */
  readonly format: PageImageFormat;
  /** 自定义文件名（不含扩展名）；省略时使用 `{docName}-p{page}`。 */
  readonly customName?: string;
}): string {
  const custom = options.customName ? sanitizeFileName(options.customName) : '';
  const base = custom || `${options.documentName}-p${options.pageNumber}`;
  return `${base}.${extensionForFormat(options.format)}`;
}

/**
 * 构造 ZIP 文件名。
 *
 * @param options 文档名与自定义 ZIP 名。
 * @returns 以 `.zip` 结尾的文件名。
 */
export function buildZipFilename(options: {
  /** 文档名（已清洗）。 */
  readonly documentName: string;
  /** 自定义 ZIP 文件名；可带或不带 `.zip`。 */
  readonly customName?: string;
}): string {
  const raw = options.customName ? sanitizeFileName(options.customName) : '';
  const base = raw || `${options.documentName}-images`;
  return base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
}

/**
 * 在 ZIP 中生成唯一名称；重名时追加序号。
 *
 * @param filename 期望名称。
 * @param used 已使用名称集合；会被更新。
 * @returns 唯一名称。
 */
export function uniqueEntryName(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  let index = 2;
  let candidate = `${base}-${index}${extension}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 触发浏览器下载。
 *
 * @param doc 宿主文档。
 * @param blob 文件内容。
 * @param filename 下载文件名。
 * @throws {Error} 环境不支持 Blob URL 时抛出，避免静默失败。
 */
export function downloadBlob(doc: Document, blob: Blob, filename: string): void {
  const view = doc.defaultView;
  const urlApi = view?.URL;
  if (!urlApi || typeof urlApi.createObjectURL !== 'function') {
    throw new Error('当前环境不支持 Blob URL，无法下载文件');
  }
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const revoke = () => {
    try {
      urlApi.revokeObjectURL?.(objectUrl);
    } catch {
      // 释放失败不影响下载结果。
    }
  };
  if (typeof view?.setTimeout === 'function') view.setTimeout(revoke, 1000);
}

/** 从路径/URL 取文件名并去掉扩展名。 */
function fileNameFromPath(path: string): string {
  const withoutQuery = path.split('?')[0]!.split('#')[0]!;
  const segment = withoutQuery.split(/[\\/]/).pop() ?? '';
  const name = segment.replace(/\.[^.]+$/, '');
  return sanitizeFileName(name);
}