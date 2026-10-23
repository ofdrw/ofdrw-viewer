/**
 * 用引擎 + Node Canvas 把 OFD 渲染为 PNG（黄金图 harness 的“实际输出”侧）。
 *
 * - 引擎通过包名 `ofdrw-viewer-engine` 引入（vitest alias 指向 src）；
 * - Node 画布通过 `H5Canvas2DRenderer({ createCanvas })` 注入；
 * - PNG/JPEG/WebP 通过 `test/helpers/node-image-decoder.ts` 注入 `imageDecoders`；
 *   JBIG2/TIFF 待 T5b 专用插件提供后另行注入，本文件不重复实现解码；
 * - harness 先填白底（引擎不负责背景），与 PDF 参考一致；
 * - 性能计时拆成 `drawMs`（页准备/绘制）与 `encodeMs`（PNG 编码），门禁使用 `drawMs`；
 * - 引擎尚未实现（T8 阶段）时返回 `unavailable`，不抛异常，供 run-all 记录。
 */

import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import {
  H5Canvas2DRenderer,
  OFDDocument,
  getPageViewport,
  isOFDError,
} from '@ofdrw/ofdrw-viewer-engine';
import type {
  Canvas2DLike,
  CanvasRenderingContext2DLike,
  OFDWarning,
} from '@ofdrw/ofdrw-viewer-engine';
import { nodeImageDecoders } from '../../helpers/node-image-decoder';
import { hostFontMismatchWarnings, inspectHostFontCoverage } from './host-font-coverage';
import { loadSystemSupplementaryFonts } from './system-fonts';
import type { PortableWarning } from './types';

/** 单页渲染结果。 */
export interface RenderedPage {
  /** 页号，1 起。 */
  page: number;
  /** 画布宽，像素。 */
  width: number;
  /** 画布高，像素。 */
  height: number;
  /** 页面尺寸，mm。 */
  sizeMm: { width: number; height: number };
  /** 白底合成后的 PNG 字节。 */
  png: Uint8Array;
  /** 引擎 draw 阶段耗时（页准备+绘制，不含 PNG 编码），ms。 */
  drawMs: number;
  /** PNG 编码耗时，ms。 */
  encodeMs: number;
  /** 总耗时（drawMs + encodeMs），ms；报告保留，门禁统一用 drawMs。 */
  renderMs: number;
  /** 该页期间收集的 warning（去重后）。 */
  warnings: PortableWarning[];
}

/** 单页失败记录。 */
export interface PageRenderFailure {
  /** 页号，1 起。 */
  page: number;
  /** 错误码（OFDError 时）。 */
  code?: string;
  /** 错误信息。 */
  message: string;
  /** 耗时，ms。 */
  renderMs: number;
}

/** 样本渲染结果。 */
export interface EngineRenderResult {
  /** 状态：ok=已渲染；unavailable=引擎未实现；error=打开/渲染失败。 */
  status: 'ok' | 'unavailable' | 'error';
  /** 引擎报告的页数。 */
  pageCount: number | null;
  /** 成功渲染的页。 */
  pages: RenderedPage[];
  /** 失败的页。 */
  failures: PageRenderFailure[];
  /** 样本级 warning（去重）。 */
  warnings: PortableWarning[];
  /** 字体缺失 warning 数。 */
  fontMissingCount: number;
  /** 打开耗时，ms。 */
  openMs: number | null;
  /** 总耗时，ms。 */
  totalMs: number;
  /** 打开/渲染错误。 */
  error: { code?: string; message: string } | null;
  /** 内存快照（byte），用于性能回归的粗略参考。 */
  memory: {
    rssBefore: number;
    rssAfter: number;
    heapUsedBefore: number;
    heapUsedAfter: number;
  };
}

/** 渲染选项。 */
export interface RenderSampleOptions {
  /** 输出 DPI，默认 96。 */
  dpi?: number;
  /** 需要渲染的页（1 起）；不传则渲染全部页。 */
  pages?: readonly number[];
}

/** 引擎 warning 转可序列化结构。 */
function toPortable(warning: OFDWarning): PortableWarning {
  const portable: PortableWarning = { code: String(warning.code), message: warning.message };
  if (warning.pageIndex !== undefined) portable.pageIndex = warning.pageIndex;
  if (warning.objectId !== undefined) portable.objectId = warning.objectId;
  if (warning.resourceId !== undefined) portable.resourceId = warning.resourceId;
  return portable;
}

/** 是否为“尚未实现”哨兵错误（T8 阶段并行开发用）。 */
function isNotImplemented(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not implemented/i.test(message);
}

/** 是否为画布尺寸不匹配错误。 */
function isCanvasSizeMismatch(error: unknown): boolean {
  return isOFDError(error) && error.code === 'OFD_CANVAS_SIZE_MISMATCH';
}

/**
 * 渲染 OFD 样本。
 *
 * @param ofdPath OFD 文件绝对路径。
 * @param options DPI 与页列表。
 * @returns 渲染结果（含 warning、耗时、内存快照）。
 */
export async function renderOfdSample(
  ofdPath: string,
  options: RenderSampleOptions = {},
): Promise<EngineRenderResult> {
  const dpi = options.dpi ?? 96;
  const start = performance.now();
  const memoryBefore = process.memoryUsage();
  const warnings: PortableWarning[] = [];
  const seenWarnings = new Set<string>();
  let doc: OFDDocument | null = null;

  const pushWarning = (warning: OFDWarning): void => {
    const portable = toPortable(warning);
    const key = `${portable.code}\u0000${portable.pageIndex ?? ''}\u0000${portable.objectId ?? ''}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push(portable);
  };

  try {
    const data = new Uint8Array(readFileSync(ofdPath));
    const supplementaryFonts = loadSystemSupplementaryFonts();
    const renderer = new H5Canvas2DRenderer({
      createCanvas: (width, height) => createCanvas(width, height) as unknown as Canvas2DLike,
    });
    doc = await OFDDocument.open({
      source: { kind: 'arraybuffer', data },
      renderer,
      onWarning: pushWarning,
      // Node 测试环境没有 DOM 图片解码器；PNG/JPEG/WebP 走共享 helper，JBIG2/TIFF 待 T5b 插件另行注入。
      imageDecoders: [...nodeImageDecoders],
      // Node 测试环境没有系统字体回退；注入主机 CJK 字体，避免把缺字体误判为文字渲染缺陷。
      ...(supplementaryFonts.length > 0 ? { supplementaryFonts } : {}),
    });
    const suppliedFamilies = supplementaryFonts
      .map((font) => font.family ?? '')
      .filter((family) => family.length > 0);
    const hostCoverage = inspectHostFontCoverage(ofdPath, suppliedFamilies);
    for (const diagnostic of hostFontMismatchWarnings(hostCoverage)) {
      const key = `${diagnostic.code}\u0000${diagnostic.message}`;
      if (seenWarnings.has(key)) continue;
      seenWarnings.add(key);
      warnings.push({ code: diagnostic.code, message: diagnostic.message });
    }
    const openMs = performance.now() - start;
    const pageCount = doc.pageCount;
    const pageNumbers =
      options.pages && options.pages.length > 0
        ? [...options.pages]
        : Array.from({ length: pageCount }, (_, index) => index + 1);

    const pages: RenderedPage[] = [];
    const failures: PageRenderFailure[] = [];
    for (const pageNumber of pageNumbers) {
      const pageStart = performance.now();
      try {
        if (pageNumber < 1 || pageNumber > pageCount) {
          throw new Error(`页码越界：${pageNumber}（共 ${pageCount} 页）`);
        }
        const page = await doc.getPage(pageNumber - 1);
        const size = page.getSize();
        const viewport = getPageViewport(size, { dpi });
        // 画布像素尺寸取整；viewport 同步取整，避免半像素尺寸导致的尺寸校验差异。
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        // harness 背景约定：先填白底，引擎只画页面内容。
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);

        const roundedViewport = { width, height, dpi };
        const runRender = async (renderViewport: { width: number; height: number; dpi: number }): Promise<void> => {
          const task = page.render({
            canvasContext: context as unknown as CanvasRenderingContext2DLike,
            viewport: renderViewport,
          });
          await task.promise;
        };
        try {
          await runRender(roundedViewport);
        } catch (error) {
          if (!isCanvasSizeMismatch(error)) throw error;
          // 兼容严格按 getViewport 小数尺寸校验的实现。
          await runRender({ width: viewport.width, height: viewport.height, dpi });
        }

        // 门禁口径：drawMs 只覆盖页准备/绘制；PNG 编码单独记录，避免编码开销混入性能门禁。
        const drawMs = performance.now() - pageStart;
        const encodeStart = performance.now();
        const png = new Uint8Array(canvas.toBuffer('image/png'));
        const encodeMs = performance.now() - encodeStart;
        pages.push({
          page: pageNumber,
          width,
          height,
          sizeMm: { width: size.width, height: size.height },
          png,
          drawMs,
          encodeMs,
          renderMs: drawMs + encodeMs,
          warnings: warnings.filter((warning) => warning.pageIndex === pageNumber - 1),
        });
      } catch (error) {
        failures.push({
          page: pageNumber,
          code: isOFDError(error) ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
          renderMs: performance.now() - pageStart,
        });
      }
    }

    const memoryAfter = process.memoryUsage();
    return {
      status: 'ok',
      pageCount,
      pages,
      failures,
      warnings,
      fontMissingCount:
        warnings.filter((warning) => warning.code === 'W_FONT_MISSING').length +
        hostCoverage.missing.length,
      openMs,
      totalMs: performance.now() - start,
      error: null,
      memory: {
        rssBefore: memoryBefore.rss,
        rssAfter: memoryAfter.rss,
        heapUsedBefore: memoryBefore.heapUsed,
        heapUsedAfter: memoryAfter.heapUsed,
      },
    };
  } catch (error) {
    const memoryAfter = process.memoryUsage();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: isNotImplemented(error) ? 'unavailable' : 'error',
      pageCount: null,
      pages: [],
      failures: [],
      warnings,
      fontMissingCount: warnings.filter((warning) => warning.code === 'W_FONT_MISSING').length,
      openMs: null,
      totalMs: performance.now() - start,
      error: {
        code: isOFDError(error) ? error.code : undefined,
        message,
      },
      memory: {
        rssBefore: memoryBefore.rss,
        rssAfter: memoryAfter.rss,
        heapUsedBefore: memoryBefore.heapUsed,
        heapUsedAfter: memoryAfter.heapUsed,
      },
    };
  } finally {
    if (doc) {
      try {
        await doc.close();
      } catch {
        // T8 阶段 close 可能未实现；关闭失败不覆盖渲染结论。
      }
    }
  }
}