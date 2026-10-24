/**
 * 印章图片渲染工具。
 *
 * 图片字节来自 `SignedValue.dat` 内嵌 SESeal 的 `picture.data`，本模块只负责
 * MIME 推断、Blob URL 生命周期与不可渲染时的文字降级；不解析 ASN.1、不验签。
 */

import { replaceChildren } from '../compat';

import type { SealImageInfo } from '../types';

/** 图片格式 → MIME；未知/矢量格式返回 undefined。 */
const MIME_BY_FORMAT: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  'svg+xml': 'image/svg+xml',
});

/** 图片显示最大边长，单位 CSS px。 */
const MAX_IMAGE_EDGE_PX = 160;

/** 1 mm 对应的 CSS px（96 DPI）。 */
const CSS_PX_PER_MM = 96 / 25.4;

/** 印章图片渲染句柄。 */
export interface SealImageHandle {
  /** `<figure class="ofd-seal-image">` 节点。 */
  readonly element: HTMLElement;
  /** 释放 Blob URL；幂等。 */
  revoke(): void;
}

/**
 * 推断图片 MIME。
 *
 * @param format 印章图片格式，例如 `PNG`/`jpg`。
 * @returns MIME；矢量或未知格式返回 undefined。
 */
export function sealImageMime(format: string): string | undefined {
  return MIME_BY_FORMAT[format.trim().toLowerCase()];
}

/**
 * 创建印章图片节点。
 *
 * 有可渲染图片时生成 `<img>`；数据缺失、矢量、未知格式或环境不支持 Blob URL
 * 时生成文字降级。调用方负责在节点移除/重建时执行 `revoke()`。
 *
 * @param doc 所有者文档。
 * @param image 印章图片信息；undefined 时返回 null。
 * @param options.label 印章名/编码，用于 alt 与降级说明。
 * @returns 渲染句柄；无图片信息时 null。
 */
export function createSealImageElement(
  doc: Document,
  image: SealImageInfo | undefined,
  options: { readonly label: string },
): SealImageHandle | null {
  if (!image) return null;

  const format = image.format?.trim() || '未知';
  const figure = doc.createElement('figure');
  figure.className = 'ofd-seal-image';
  figure.dataset.format = format;
  figure.dataset.widthMm = String(image.widthMm);
  figure.dataset.heightMm = String(image.heightMm);

  const fallback = (message: string): SealImageHandle => {
    const text = doc.createElement('p');
    text.className = 'ofd-seal-image__fallback';
    text.textContent = message;
    replaceChildren(figure, text);
    return { element: figure, revoke: () => undefined };
  };

  const data = image.data;
  if (!data || data.byteLength === 0) {
    return fallback('印章图片数据缺失；请以页面覆盖层显示的印章为准。');
  }

  const mime = sealImageMime(format);
  if (!mime) {
    if (format.toLowerCase() === 'ofd') {
      return fallback(
        '印章图片为矢量（OFD），不提供可直接预览的位图；请以页面覆盖层显示的印章为准。',
      );
    }
    return fallback(
      `印章图片格式 ${format} 暂不支持预览（${formatBytes(data.byteLength)}）；请以页面覆盖层显示的印章为准。`,
    );
  }

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return fallback('当前环境不支持图片预览；请以页面覆盖层显示的印章为准。');
  }

  let objectUrl: string;
  try {
    // 复制到独立 ArrayBuffer，避免 SharedArrayBuffer 兼容性与 offset 问题。
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  } catch {
    return fallback('印章图片无法预览；请以页面覆盖层显示的印章为准。');
  }

  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(objectUrl);
  };

  const img = doc.createElement('img');
  img.className = 'ofd-seal-image__img';
  img.alt = `印章图片：${options.label || '未命名签章'}`;
  img.decoding = 'async';
  img.loading = 'lazy';
  const widthMm = Number.isFinite(image.widthMm) && image.widthMm > 0 ? image.widthMm : 0;
  if (widthMm > 0) {
    img.style.width = `${Math.min(MAX_IMAGE_EDGE_PX, widthMm * CSS_PX_PER_MM)}px`;
    img.style.height = 'auto';
  }
  img.addEventListener(
    'error',
    () => {
      revoke();
      img.remove();
      const text = doc.createElement('p');
      text.className = 'ofd-seal-image__fallback';
      text.textContent = `印章图片无法显示（${format}，${formatBytes(data.byteLength)}）；请以页面覆盖层显示的印章为准。`;
      figure.appendChild(text);
    },
    { once: true },
  );
  img.src = objectUrl;

  const caption = doc.createElement('figcaption');
  caption.className = 'ofd-seal-image__caption';
  caption.textContent = `${format.toUpperCase()} · ${formatMm(image.widthMm)} × ${formatMm(
    image.heightMm,
  )} mm · ${formatBytes(data.byteLength)}`;

  figure.append(img, caption);
  return { element: figure, revoke };
}

/** 字节数格式化，单位 KB/MB。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 毫米数格式化：整数不补小数。 */
function formatMm(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '?';
}