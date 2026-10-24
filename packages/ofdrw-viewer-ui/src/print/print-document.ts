/**
 * 打印文档构建（设计方案 §10.2 / §10.3）。
 *
 * 逐页调用引擎 `exportImage` 生成 PNG，插入 `<img>`；页面尺寸使用 mm。
 * `@page` 规则：统一尺寸直接设置；混合尺寸仅在 Chromium ≥85 且
 * `CSS.supports('page', ...)` 为 true 时使用命名页，否则降级为“统一最大纸型 + 等比适配”。
 * 不生成 PDF。打印旋转通过容器宽高交换 + CSS `rotate()` 实现，不改动引擎输出像素。
 */

import { OFDViewerError } from '../errors';
import type { Rotation } from '../state';
import {
  getExportablePage,
  renderPageImage,
  throwIfSignalAborted,
} from '../export/image';
import {
  DEFAULT_IMAGE_QUALITY,
  isQuarterTurn,
  resolveBackground,
} from '../export/options';
import type { OutputHost } from '../export/host';

/** 单页打印准备结果。 */
export interface PreparedPrintPage {
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 页面容器。 */
  readonly element: HTMLElement;
  /** 图片元素。 */
  readonly image: HTMLImageElement;
  /** Object URL；清理时释放。 */
  readonly objectUrl: string;
  /** 未旋转页宽，单位 mm。 */
  readonly widthMm: number;
  /** 未旋转页高，单位 mm。 */
  readonly heightMm: number;
  /** 旋转后页宽，单位 mm。 */
  readonly rotatedWidthMm: number;
  /** 旋转后页高，单位 mm。 */
  readonly rotatedHeightMm: number;
  /** 尺寸分组键；相同尺寸共享同一条 `@page`。 */
  readonly sizeKey: string;
}

/** 打印文档准备结果。 */
export interface PreparedPrintDocument {
  /** 打印根节点；挂在 body 下。 */
  readonly container: HTMLElement;
  /** 注入的打印样式节点。 */
  readonly style: HTMLStyleElement;
  /** 逐页结果，按打印顺序排列。 */
  readonly pages: readonly PreparedPrintPage[];
  /** 打印旋转角度。 */
  readonly rotation: Rotation;
  /** 清理 DOM 与 Object URL；幂等。 */
  cleanup(): void;
}

/** 打印文档准备选项。 */
export interface PreparePrintOptions {
  /** 页号，1-based，按打印顺序。 */
  readonly pages: readonly number[];
  /** 输出 DPI。 */
  readonly dpi: number;
  /** 打印旋转。 */
  readonly rotation: Rotation;
  /** 是否包含页面背景；false 时使用透明底（打印仍为白纸）。 */
  readonly includeBackground: boolean;
  /** 取消信号。 */
  readonly signal: AbortSignal;
  /** 进度回调；每页图片就绪后触发。 */
  readonly onProgress?: (progress: { readonly current: number; readonly total: number }) => void;
}

/** 默认 A4 宽，单位 mm。 */
const A4_WIDTH_MM = 210;
/** 默认 A4 高，单位 mm。 */
const A4_HEIGHT_MM = 297;

/**
 * 构建打印 DOM（不调用 `window.print`）。
 *
 * @param host 输出宿主。
 * @param options 打印选项。
 * @returns 打印文档；调用方负责 `cleanup()`。
 */
export async function preparePrintDocument(
  host: OutputHost,
  options: PreparePrintOptions,
): Promise<PreparedPrintDocument> {
  const root = host.getElements().root;
  const doc = root.ownerDocument;
  if (!doc) throw new OFDViewerError('OFD_PRINT_FAILED', '无法访问宿主文档');
  const view = doc.defaultView;
  const urlApi = view?.URL;
  if (!urlApi || typeof urlApi.createObjectURL !== 'function') {
    throw new OFDViewerError('OFD_PRINT_FAILED', '当前环境不支持 Blob URL，无法准备打印');
  }

  const background = resolveBackground(options.includeBackground ? '#ffffff' : null, 'png');
  const container = doc.createElement('div');
  container.className = 'ofd-print-root';
  container.setAttribute('aria-hidden', 'true');
  const preparedPages: PreparedPrintPage[] = [];
  const objectUrls: string[] = [];

  const cleanup = (): void => {
    for (const url of objectUrls.splice(0)) {
      try {
        urlApi.revokeObjectURL?.(url);
      } catch {
        // 释放失败不影响打印结果。
      }
    }
    container.remove();
    style?.remove();
  };

  let style: HTMLStyleElement | null = null;
  try {
    doc.body.appendChild(container);
    for (let index = 0; index < options.pages.length; index += 1) {
      throwIfSignalAborted(options.signal);
      const pageNumber = options.pages[index]!;
      const page = await getExportablePage(host, pageNumber, 'print');
      const size = normalizePageSize(page.getSize());
      const rotated = isQuarterTurn(options.rotation)
        ? { widthMm: size.heightMm, heightMm: size.widthMm }
        : size;
      const image = await renderPageImage(host, {
        pageNumber,
        page,
        dpi: options.dpi,
        format: 'png',
        quality: DEFAULT_IMAGE_QUALITY,
        background,
        rotation: 0,
        signal: options.signal,
        feature: 'print',
      });
      const objectUrl = urlApi.createObjectURL(image.blob);
      objectUrls.push(objectUrl);
      const element = doc.createElement('div');
      element.className = 'ofd-print-page';
      element.dataset.pageNumber = String(pageNumber);
      element.style.width = `${formatMm(rotated.widthMm)}mm`;
      element.style.height = `${formatMm(rotated.heightMm)}mm`;
      const img = doc.createElement('img');
      img.className = 'ofd-print-page__image';
      img.alt = `第 ${pageNumber} 页`;
      img.draggable = false;
      img.src = objectUrl;
      img.style.width = `${formatMm(size.widthMm)}mm`;
      img.style.height = `${formatMm(size.heightMm)}mm`;
      img.style.transform = `translate(-50%, -50%) rotate(${options.rotation}deg)`;
      element.appendChild(img);
      container.appendChild(element);
      preparedPages.push({
        pageNumber,
        element,
        image: img,
        objectUrl,
        widthMm: size.widthMm,
        heightMm: size.heightMm,
        rotatedWidthMm: rotated.widthMm,
        rotatedHeightMm: rotated.heightMm,
        sizeKey: `${roundSize(rotated.widthMm)}x${roundSize(rotated.heightMm)}`,
      });
      await waitForImage(img);
      options.onProgress?.({ current: index + 1, total: options.pages.length });
    }
    throwIfSignalAborted(options.signal);
    const css = buildPrintCss(preparedPages, supportsNamedPages(doc.defaultView));
    style = doc.createElement('style');
    style.dataset.ofdPrintStyle = 'true';
    style.textContent = css;
    doc.head.appendChild(style);
    return {
      container,
      style,
      pages: preparedPages,
      rotation: options.rotation,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * 触发浏览器打印并等待 `afterprint`（带超时回退）。
 *
 * @param prepared 已准备打印文档。
 * @throws {OFDViewerError} 环境不支持或打印调用失败时抛出。
 */
export async function printPreparedDocument(prepared: PreparedPrintDocument): Promise<void> {
  const doc = prepared.container.ownerDocument;
  const view = doc.defaultView;
  if (!view || typeof view.print !== 'function') {
    throw new OFDViewerError('OFD_PRINT_FAILED', '当前环境不支持打印');
  }
  let printError: unknown = null;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      view.removeEventListener('afterprint', finish);
      resolve();
    };
    view.addEventListener('afterprint', finish, { once: true });
    try {
      view.print();
    } catch (error) {
      printError = error;
      finish();
    }
    // 部分环境（旧内核/测试 DOM）不会派发 afterprint；短超时后继续清理。
    view.setTimeout(finish, 1000);
  });
  if (printError) {
    throw new OFDViewerError('OFD_PRINT_FAILED', '打印失败', { cause: printError });
  }
}

/** 启用命名页所需的最低 Chrome 主版本；Chrome 85 起支持 `page` 属性与命名页。 */
const NAMED_PAGES_MIN_CHROME_MAJOR = 85;

/**
 * 从 UA 解析 Chromium 系浏览器主版本。
 *
 * 只识别 Chromium 系（HeadlessChrome、Chrome、Android Chrome、iOS CriOS）；
 * 其他引擎返回 null，由调用方按“不支持命名页”降级处理。
 *
 * @param userAgent 浏览器 UA；空串返回 null。
 * @returns 主版本号；无法识别时为 null。
 */
function chromiumMajorVersion(userAgent: string): number | null {
  const match = /(?:HeadlessChrome|Chrome|CriOS)\/(\d+)/.exec(userAgent);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

/**
 * 检测命名页（`@page <name>` + `page` 属性）是否可实际生效。
 *
 * Chrome 67 对 `CSS.supports('page', ...)` 返回 true，但打印时命名页尺寸被忽略
 * （真实 Chromium 67 `Page.printToPDF` 两页均为 Letter），单凭 `CSS.supports`
 * 会误判。因此采用双门控：Chromium 主版本 ≥85 **且** `CSS.supports('page', ...)`
 * 为 true 才启用命名页；Chrome 67、非 Chromium 系或 supports 为 false 时一律
 * 走“统一最大纸型 + 等比适配”降级。
 *
 * @param view 目标窗口；省略时使用全局 `window`。
 * @returns 可安全启用命名页时 true。
 */
export function supportsNamedPages(view?: Window | null): boolean {
  const scoped = view ?? (typeof window !== 'undefined' ? window : null);
  if (!scoped) return false;
  const userAgent = scoped.navigator?.userAgent ?? '';
  const major = chromiumMajorVersion(userAgent);
  if (major === null || major < NAMED_PAGES_MIN_CHROME_MAJOR) return false;
  const css = (scoped as Window & { CSS?: typeof CSS }).CSS;
  if (!css || typeof css.supports !== 'function') return false;
  try {
    return css.supports('page', 'ofd-size-0');
  } catch {
    return false;
  }
}

/**
 * 生成打印样式。
 *
 * 统一尺寸直接设置一条 `@page`；混合尺寸在支持命名页时按尺寸分组使用命名页，
 * 不支持时（Chrome 67）降级为“最大页尺寸的统一纸型 + 等比适配”，避免裁切。
 *
 * @param pages 已准备页面。
 * @param namedPages 是否支持命名页；省略时自动探测。
 * @returns CSS 文本。
 */
export function buildPrintCss(
  pages: readonly PreparedPrintPage[],
  namedPages: boolean = supportsNamedPages(),
): string {
  const groups = collectSizeGroups(pages);
  const mixed = groups.length > 1;
  const useNamedPages = mixed && namedPages;
  const namedRules = useNamedPages
    ? groups
        .map(
          (group) =>
            `  .ofd-print-page[data-size="${group.index}"] { page: ofd-size-${group.index}; }`,
        )
        .join('\n')
    : '';
  let pageRules: string;
  if (useNamedPages) {
    pageRules = [
      '@page { size: auto; margin: 0; }',
      ...groups.map(
        (group) =>
          `@page ofd-size-${group.index} { size: ${formatMm(group.widthMm)}mm ${formatMm(
            group.heightMm,
          )}mm; margin: 0; }`,
      ),
    ].join('\n');
  } else {
    // 统一尺寸或 Chrome 67 降级：统一尺寸用该页尺寸；混合尺寸取所有页的最大宽/高，
    // 保证任何一页都不被裁切。
    const unified =
      groups.length <= 1
        ? {
            widthMm: groups[0]?.widthMm ?? A4_WIDTH_MM,
            heightMm: groups[0]?.heightMm ?? A4_HEIGHT_MM,
          }
        : groups.reduce(
            (size, group) => ({
              widthMm: Math.max(size.widthMm, group.widthMm),
              heightMm: Math.max(size.heightMm, group.heightMm),
            }),
            { widthMm: 0, heightMm: 0 },
          );
    pageRules = `@page { size: ${formatMm(unified.widthMm)}mm ${formatMm(
      unified.heightMm,
    )}mm; margin: 0; }`;
  }
  const fallbackRules = mixed && !namedPages
    ? [
        '  html, body { height: 100% !important; }',
        '  .ofd-print-page { width: 100% !important; height: 100% !important; }',
        '  .ofd-print-page__image { max-width: 100%; max-height: 100%; object-fit: contain; }',
      ]
    : [];

  return [
    '.ofd-print-root { display: none; }',
    pageRules,
    '@media print {',
    '  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }',
    '  body > :not(.ofd-print-root) { display: none !important; }',
    '  .ofd-viewer { display: none !important; }',
    '  .ofd-print-root { display: block !important; }',
    '  .ofd-print-page { position: relative; overflow: hidden; margin: 0; padding: 0; background: #fff; break-after: page; page-break-after: always; }',
    '  .ofd-print-page:last-child { break-after: auto; page-break-after: auto; }',
    '  .ofd-print-page__image { display: block; position: absolute; left: 50%; top: 50%; transform-origin: center center; }',
    ...fallbackRules,
    namedRules,
    '}',
    '',
  ].join('\n');
}

/** 尺寸分组；首次出现顺序决定命名页序号。 */
interface SizeGroup {
  readonly key: string;
  readonly index: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly pages: PreparedPrintPage[];
}

/**
 * 按旋转后尺寸分组，并把 `data-size` 写到页面节点。
 *
 * @param pages 页面列表。
 * @returns 尺寸组，按首次出现顺序。
 */
export function collectSizeGroups(pages: readonly PreparedPrintPage[]): SizeGroup[] {
  const groups = new Map<string, SizeGroup>();
  for (const page of pages) {
    let group = groups.get(page.sizeKey);
    if (!group) {
      group = {
        key: page.sizeKey,
        index: groups.size,
        widthMm: page.rotatedWidthMm,
        heightMm: page.rotatedHeightMm,
        pages: [],
      };
      groups.set(page.sizeKey, group);
    }
    group.pages.push(page);
  }
  const result = [...groups.values()];
  if (result.length > 1) {
    for (const group of result) {
      for (const page of group.pages) page.element.dataset.size = String(group.index);
    }
  }
  return result;
}

/** 规范化页尺寸；非法值回退 A4。 */
function normalizePageSize(size: { width: number; height: number }): {
  widthMm: number;
  heightMm: number;
} {
  const widthMm = Number.isFinite(size.width) && size.width > 0 ? size.width : A4_WIDTH_MM;
  const heightMm = Number.isFinite(size.height) && size.height > 0 ? size.height : A4_HEIGHT_MM;
  return { widthMm, heightMm };
}

/** 保留最多 3 位小数，去掉尾零。 */
function formatMm(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** 尺寸键取 0.01mm 精度。 */
function roundSize(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 等待图片解码；不支持 decode 的环境回退 load/error 与超时。 */
function waitForImage(image: HTMLImageElement): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      image.removeEventListener('load', finish);
      image.removeEventListener('error', finish);
      resolve();
    };
    image.addEventListener('load', finish, { once: true });
    image.addEventListener('error', finish, { once: true });
    if (typeof image.decode === 'function') {
      void image.decode().then(finish, finish);
    }
    image.ownerDocument.defaultView?.setTimeout(finish, 500);
  });
}