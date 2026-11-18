/**
 * 附件能力（设计方案 §6.2）。
 *
 * 只做三件事：
 * - 纯函数：大小/日期格式化、下载文件名清洗、阈值判断、可预览类型判定；
 * - ZIP 打包：复用图片导出的 store 模式 ZIP（fflate，按需动态导入）；
 * - 侧栏视图：列表、单个下载、多选导出。
 *
 * 安全约束（§6.2.5）：附件内容一律不进入 DOM，不使用 innerHTML/srcdoc；
 * 未知格式只提供下载，不提供预览。
 */

import type { AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import type { Translator } from './i18n';

/**
 * 大附件阈值，单位 byte（500 MB）。
 *
 * 声明大小超过该阈值的附件不读取内容，改为提示用户下载整个 OFD 原文件；
 * 未声明大小的附件不参与阈值判断。
 */
export const ATTACHMENT_LARGE_THRESHOLD_BYTES = 524288000;

/**
 * 可预览附件的上限，单位 byte（20 MB）。
 *
 * 声明大小超过该阈值的附件不进入预览弹框，改为直接下载，避免整份内容驻留内存。
 * 未声明大小的附件按未超限处理，否则无从判断，只有读取后才知道实际大小。
 */
export const ATTACHMENT_PREVIEW_THRESHOLD_BYTES = 20 * 1024 * 1024;

/** 单个 ZIP 条目名最大长度（含扩展名），避免超长路径。 */
const MAX_ENTRY_NAME_LENGTH = 120;

/**
 * 格式化附件大小。
 *
 * @param translator 翻译器。
 * @param bytes 字节数，单位 byte；可为 undefined。
 * @returns 例如 `12.3 KB`；未声明或非法时返回 `-`。
 */
export function formatAttachmentSize(
  translator: Translator,
  bytes: number | undefined,
): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return translator.t('attachments.missing');
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return translator.t('attachments.sizeKb', {
      value: translator.formatNumber(kb, { maximumFractionDigits: 1 }),
    });
  }
  return translator.t('attachments.sizeMb', {
    value: translator.formatNumber(kb / 1024, { maximumFractionDigits: 2 }),
  });
}

/**
 * 读取附件日期文本：优先 ModDate，缺失回退 CreationDate。
 *
 * @param attachment 附件元信息。
 * @param translator 翻译器。
 * @returns 日期原文；两者都缺失时返回 `-`。
 */
export function formatAttachmentDate(
  attachment: AttachmentInfo,
  translator: Translator,
): string {
  return attachment.modDate ?? attachment.creationDate ?? translator.t('attachments.missing');
}

/**
 * 判断附件是否超过大附件阈值。
 *
 * 只依据 XML 声明的大小；未声明大小按普通附件处理。
 *
 * @param attachment 附件元信息。
 * @returns 声明大小超过阈值时返回 true。
 */
export function isLargeAttachment(attachment: AttachmentInfo): boolean {
  return attachment.size !== undefined && attachment.size > ATTACHMENT_LARGE_THRESHOLD_BYTES;
}

/**
 * 过滤非法文件名片段，避免路径穿越。
 *
 * 去掉 `/`、`\`、`..` 与控制字符，并清洗平台保留字符。
 *
 * @param value 原始文本。
 * @returns 安全文件名；清洗后为空时返回空字符串。
 */
export function sanitizeAttachmentName(value: string): string {
  return value
    // 控制字符先去掉，避免影响后续分段。
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // 按路径分隔符与目录回溯段切分，只保留合法片段，杜绝 `../` 穿越。
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    // 残余的 `..` 片段整体替换为单个下划线，避免相邻片段粘连成新路径。
    .map((segment) => segment.replace(/\.{2,}/g, '_').replace(/[*?"<>|:]/g, '_'))
    .join('_')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, MAX_ENTRY_NAME_LENGTH)
    .trim();
}

/** 附件图标类别；与 `ui/glyphs.ts` 中的文件图标一一对应。 */
export type AttachmentIconKind =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'image'
  | 'text'
  | 'xml'
  | 'archive'
  | 'video'
  | 'audio'
  | 'code'
  | 'other';

/** 扩展名到图标类别；键为小写扩展名。 */
const ICON_KINDS: Readonly<Record<string, AttachmentIconKind>> = Object.freeze({
  pdf: 'pdf',
  ofd: 'pdf',
  ofd2: 'pdf',
  doc: 'doc',
  docx: 'doc',
  dot: 'doc',
  dotx: 'doc',
  wps: 'doc',
  rtf: 'doc',
  odt: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  xlsm: 'sheet',
  et: 'sheet',
  csv: 'sheet',
  ods: 'sheet',
  ppt: 'slide',
  pptx: 'slide',
  pps: 'slide',
  ppsx: 'slide',
  pot: 'slide',
  potx: 'slide',
  dps: 'slide',
  odp: 'slide',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
  txt: 'text',
  md: 'text',
  log: 'text',
  html: 'text',
  htm: 'text',
  xml: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  plist: 'xml',
  json: 'code',
  js: 'code',
  mjs: 'code',
  ts: 'code',
  css: 'code',
  yml: 'code',
  yaml: 'code',
  toml: 'code',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  ogv: 'video',
  avi: 'video',
  mkv: 'video',
  wmv: 'video',
  flv: 'video',
  mpg: 'video',
  mpeg: 'video',
  '3gp': 'video',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  flac: 'audio',
  wma: 'audio',
  amr: 'audio',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  tar: 'archive',
});

/**
 * 读取附件扩展名（小写，不含点）。
 *
 * 优先取名称里的扩展名，名称无扩展名时回退 XML 声明的格式。
 *
 * @param attachment 附件元信息。
 * @returns 小写扩展名；无法确定时为空字符串。
 */
function attachmentExtension(attachment: AttachmentInfo): string {
  const name = attachment.name ?? '';
  const dot = name.lastIndexOf('.');
  const fromName = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return fromName || (attachment.format?.trim().toLowerCase() ?? '');
}

/**
 * 判断附件格式对应的图标类别。
 *
 * @param attachment 附件元信息。
 * @returns 图标类别；无法识别时为 `other`。
 */
export function attachmentIconKind(attachment: AttachmentInfo): AttachmentIconKind {
  return ICON_KINDS[attachmentExtension(attachment)] ?? 'other';
}

/** 可预览附件的类型。 */
export type AttachmentPreviewKind = 'image' | 'video' | 'audio' | 'text';

/** 扩展名到预览类型；未列出的扩展名不提供预览，只提供下载。 */
const PREVIEW_KINDS: Readonly<Record<string, AttachmentPreviewKind>> = Object.freeze({
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  ico: 'image',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  flac: 'audio',
  txt: 'text',
  md: 'text',
  log: 'text',
  json: 'text',
  csv: 'text',
  xml: 'text',
  yml: 'text',
  yaml: 'text',
});

/** 扩展名到 MIME 类型；用于预览对象 URL，避免浏览器按扩展名猜测失败。 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
});

/**
 * 判断附件是否可预览，以及按哪种类型预览。
 *
 * 只认可图片、视频、音频、纯文本四类；其余格式（含 PDF、Office、压缩包）
 * 一律返回 undefined，由调用方只提供下载。
 *
 * @param attachment 附件元信息。
 * @returns 预览类型；不可预览时 undefined。
 */
export function attachmentPreviewKind(
  attachment: AttachmentInfo,
): AttachmentPreviewKind | undefined {
  return PREVIEW_KINDS[attachmentExtension(attachment)];
}

/**
 * 判断附件声明的类型是否为纯文本。
 *
 * @param attachment 附件元信息。
 * @returns 预览类型为 `text` 时 true。
 */
export function isTextAttachment(attachment: AttachmentInfo): boolean {
  return attachmentPreviewKind(attachment) === 'text';
}

/**
 * 推断预览用的 MIME 类型。
 *
 * 优先使用 XML 声明的 `ContentType`，其次按扩展名映射，都没有时按下载默认值处理。
 *
 * @param attachment 附件元信息。
 * @returns MIME 类型；无法确定时为 `application/octet-stream`。
 */
export function attachmentMimeType(attachment: AttachmentInfo): string {
  const declared = attachment.contentType?.trim();
  if (declared) return declared;
  return MIME_BY_EXTENSION[attachmentExtension(attachment)] ?? 'application/octet-stream';
}

/**
 * 判断附件是否超过可预览阈值。
 *
 * 只依据 XML 声明的大小；未声明大小按未超限处理。
 *
 * @param attachment 附件元信息。
 * @returns 声明大小超过预览阈值时 true。
 */
export function isPreviewTooLargeAttachment(attachment: AttachmentInfo): boolean {
  return (
    attachment.size !== undefined && attachment.size > ATTACHMENT_PREVIEW_THRESHOLD_BYTES
  );
}

/**
 * 生成附件下载文件名。
 *
 * 优先使用附件名称，其次使用附件 ID；都会按 {@link sanitizeAttachmentName} 清洗。
 * 名称带扩展名时保留，不带扩展名时按格式补全。
 *
 * @param attachment 附件元信息。
 * @returns 下载文件名；无法生成时返回 `attachment`。
 */
export function buildAttachmentFilename(attachment: AttachmentInfo): string {
  const base = sanitizeAttachmentName(attachment.name) || sanitizeAttachmentName(attachment.id);
  const fallback = base || 'attachment';
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(fallback);
  const format = attachment.format?.trim().toLowerCase();
  if (hasExtension || !format) return fallback;
  const extension = /^[a-z0-9]{1,8}$/.test(format) ? format : '';
  return extension ? `${fallback}.${extension}` : fallback;
}

/**
 * 生成 ZIP 内唯一的条目名；重名追加 `-2`、`-3` 序号。
 *
 * @param filename 候选文件名。
 * @param used 已使用的文件名集合，会被更新。
 * @returns 唯一文件名。
 */
export function uniqueAttachmentEntryName(filename: string, used: Set<string>): string {
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
 * @throws {Error} 环境不支持 Blob URL 时抛出。
 */
export function triggerAttachmentDownload(doc: Document, blob: Blob, filename: string): void {
  const view = doc.defaultView;
  const urlApi = view?.URL;
  if (!urlApi || typeof urlApi.createObjectURL !== 'function') {
    throw new Error('当前环境不支持 Blob URL，无法下载附件');
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
  const revoke = (): void => {
    try {
      urlApi.revokeObjectURL?.(objectUrl);
    } catch {
      // 释放失败不影响下载结果。
    }
  };
  if (typeof view?.setTimeout === 'function') view.setTimeout(revoke, 1000);
  else revoke();
}

/**
 * 分块拼装为单个字节数组。
 *
 * @param chunks 分块列表；按传入顺序拼接。
 * @returns 合并后的字节数组。
 */
export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
