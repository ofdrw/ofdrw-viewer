/**
 * OFD 文档公共入口（对应设计方案 15.1 / 16）。
 *
 * 打开阶段只读 OFD.xml / Document.xml / 页树 / 文档资源索引与注释索引，不加载页面
 * 内容或字体/图片二进制；`getPage` 按需解码页面模型与页级资源；`render` 通过
 * `preparePage`（异步 I/O）与 `drawPage`（同步绘制）完成渲染。
 *
 * 缓存与生命周期：
 * - XML / 字体字节 / 解码图片 / 页面模型分别按 `CacheOptions` 预算 LRU；
 * - 同 key 的加载用 `Map<key, Promise>` 去重，避免并发重复解析；
 * - 同一 Canvas 的渲染通过 Promise 链串行，不同 Canvas 互不阻塞；
 * - `close()` 幂等：先中止进行中的渲染，再释放渲染器、字体、图片句柄与文件句柄。
 */

import type { ByteSource } from '../platform/byte-source';
import type { FontInput } from '../platform/font-provider';
import type { ImageDecoderPlugin } from '../platform/image-decoder';
import type { DecodedImage, Viewport } from '../common/types';
import type {
  Annotation,
  ColorSpaceDef,
  DocumentModel,
  FontResource,
  ImageResource,
  PageModel,
  ResourceId,
  TemplateRef,
} from '../model/types';
import type { DocumentResourceIndex, PageResourceScope, ResourceIndex } from '../resource/types';
import type { Canvas2DLike, CanvasRenderingContext2DLike, Renderer } from '../renderer/types';
import type { OFDWarning, WarningCollector } from '../warnings';
import type {
  CacheOptions,
  OFDOpenOptions,
  OFDSource,
  PageRenderParameters,
  ResourceLimits,
} from './types';
import type { OFDPage } from './page';
import type { FontInputLoader } from '../font/provider';
import type { FontFaceSet } from '../font/types';
import type { PageAreaCandidate } from '../model/page-area';

import { DEFAULT_CACHE_OPTIONS, DEFAULT_RESOURCE_LIMITS } from './types';
import { OFDPage as OFDPageClass } from './page';
import { combineAbortSignals, throwIfAborted, wrapError } from './render-task';
import { openByteSource } from './source';
import {
  createWarningCollector,
  createDocumentWarningHandler,
  createPageWarningHandler,
} from './warnings';
import { DisposableLruCache } from './cache';
import { OFDError } from '../errors';
import { ZipReader } from '../container/zip-reader';
import type { ZipLimits } from '../container/zip-reader';
import { dirnameOf } from '../container/path';
import { parseXml } from '../xml/parser';
import type { XmlNode } from '../xml/types';
import {
  decodeAnnotations,
  decodeAnnotationsIndex,
  decodeDocument,
  decodeOfdRoot,
  decodePageContent,
  decodePageResources,
} from '../model/decode';
import { resolvePageArea, applyPageArea } from '../model/page-area';
import {
  buildDocumentResourceIndex,
  ResourceStore,
  resourceSetToIndex,
} from '../resource/store';
import type { ResourceDefinitionSet } from '../model/types';
import { FontLibrary } from '../font/provider';
import {
  detectImageFormat,
  isWithinImagePixelLimit,
  readImageSize,
  resolveImageDecoder,
} from '../image/format';
import { H5Canvas2DRenderer } from '../renderer/canvas2d';
import { preparePage } from '../render/prepare';
import { drawPage } from '../render/page';

/** Canvas 尺寸比较容差，避免浮点 viewport 与整数 canvas 的舍入误差。 */
const CANVAS_SIZE_EPSILON = 1e-6;

/** 页面级运行时：模型、资源作用域与按引用顺序解码的模板页。 */
interface PageEntry {
  /** 页面模型；`area`/`size` 已按回退链解析。 */
  model: PageModel;
  /** 页级资源作用域（页 → 模板 → 文档）。 */
  resources: PageResourceScope;
  /** 按 `page.templates` 引用顺序成功解码的模板页。 */
  templates: PageModel[];
}

/** XML 缓存条目；同时记录估算字节数用于预算淘汰。 */
interface XmlCacheEntry {
  /** 解析后的 XML 树。 */
  node: XmlNode;
  /** 估算内存，byte（UTF-16 文本约 2× 原始字节）。 */
  bytes: number;
}

/** `OFDDocument` 构造输入（仅内部使用）。 */
interface DocumentInit {
  source: ByteSource;
  zip: ZipReader;
  document: DocumentModel;
  limits: ResourceLimits;
  cacheOptions: CacheOptions;
  warnings: WarningCollector;
  renderer: Renderer;
  imageDecoders: readonly ImageDecoderPlugin[];
  strictImageCtm: boolean;
  layerOrder: 'document' | 'type';
  documentResources: DocumentResourceIndex;
  fontLibrary: FontLibrary;
}

/**
 * 把 `ResourceLimits` 中与 ZIP 相关的字段映射为 `ZipLimits`。
 *
 * @param limits 资源限制。
 * @returns ZIP 打开限制。
 */
function toZipLimits(limits: ResourceLimits): ZipLimits {
  return {
    maxPackageBytes: limits.maxPackageBytes,
    maxEntries: limits.maxEntries,
    maxEntryBytes: limits.maxEntryBytes,
    maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
    maxCompressionRatio: limits.maxCompressionRatio,
  };
}

/**
 * 读取并解析一个 XML 条目。
 *
 * @param zip ZIP 读取器。
 * @param path 包内路径。
 * @param maxBytes XML 大小上限，byte。
 * @param onWarning CRC/大小不一致等 warning 回调。
 * @returns 解析后的 XML 根节点。
 */
async function readXmlEntry(
  zip: ZipReader,
  path: string,
  maxBytes: number,
  onWarning: (warning: OFDWarning) => void,
): Promise<XmlNode> {
  const bytes = await zip.readEntry(path, { maxBytes, onWarning });
  return parseXml(bytes);
}

/**
 * 静默关闭字节源（若实现提供 close）。
 *
 * @param source 字节源。
 */
async function closeByteSource(source: ByteSource | undefined): Promise<void> {
  if (!source) return;
  const close = (source as ByteSource & { close?: () => Promise<void> | void }).close;
  if (typeof close !== 'function') return;
  try {
    await close.call(source);
  } catch {
    // 关闭失败不覆盖调用方结论。
  }
}

/**
 * 校验解码结果尺寸与像素上限。
 *
 * @param decoded 解码结果。
 * @param maxPixels 单图像素上限。
 * @param format 图片格式。
 * @returns 原解码结果。
 * @throws OFDError 尺寸非法或超限时。
 */
function assertDecodedImage(decoded: DecodedImage, maxPixels: number, format: string): DecodedImage {
  const { width, height } = decoded;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new OFDError('OFD_IMAGE_DECODE', `${format} 图片解码结果尺寸非法：${width} × ${height}`);
  }
  if (!isWithinImagePixelLimit(width, height, maxPixels)) {
    throw new OFDError(
      'OFD_LIMIT_EXCEEDED',
      `${format} 图片 ${width}×${height} 超过像素上限 ${maxPixels}`,
    );
  }
  return decoded;
}

/** 浏览器 HTMLImageElement 的最小结构。 */
interface BrowserImageElement {
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
  src: string;
  onload: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

/** 浏览器原生图片解码所需的最小全局接口。 */
interface BrowserImageGlobals {
  createImageBitmap?: (source: Blob) => Promise<{
    width: number;
    height: number;
  }>;
  document?: {
    createElement(tag: 'img'): BrowserImageElement;
  };
  Image?: new () => BrowserImageElement;
  URL?: {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(url: string): void;
  };
}

/** 图片格式到 MIME 类型。 */
function mimeTypeOf(format: string): string {
  switch (format.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

/** 浏览器原生可解码的格式（无宿主插件时的兜底）。 */
const BROWSER_NATIVE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp', 'gif', 'bmp']);

/**
 * 已打开的 OFD 文档。
 *
 * 生命周期：`OFDDocument.open()` → `getPage()` → `close()`；`close()` 可重复调用，
 * 关闭后 `getPage`/`render` 以 `OFD_CLOSED` 拒绝。
 */
export class OFDDocument {
  /** 页数，打开后立即固定。 */
  readonly pageCount: number;

  private readonly source: ByteSource;
  private readonly zip: ZipReader;
  private readonly document: DocumentModel;
  private readonly limits: ResourceLimits;
  private readonly warnings: WarningCollector;
  private readonly renderer: Renderer;
  private readonly imageDecoders: readonly ImageDecoderPlugin[];
  private readonly strictImageCtm: boolean;
  private readonly layerOrder: 'document' | 'type';
  private readonly resourceStore: ResourceStore;
  private readonly documentResources: DocumentResourceIndex;
  private readonly fontLibrary: FontLibrary;
  private readonly documentWarningHandler: (warning: OFDWarning) => void;

  /** 已解析 XML 的 LRU（键：包内路径）。 */
  private readonly xmlCache: DisposableLruCache<string, XmlCacheEntry>;
  /** 并发 XML 读取去重。 */
  private readonly xmlPending = new Map<string, Promise<XmlNode>>();
  /** 字体字节 LRU。 */
  private readonly fontBytesCache: DisposableLruCache<string, Uint8Array>;
  /** 并发字体读取去重。 */
  private readonly fontBytesPending = new Map<string, Promise<Uint8Array>>();
  /** 解码图片 LRU；淘汰/关闭时释放 ImageBitmap。 */
  private readonly imageCache: DisposableLruCache<string, DecodedImage>;
  /** 并发图片解码去重。 */
  private readonly imagePending = new Map<string, Promise<DecodedImage>>();
  /** 页面模型缓存；值包含资源作用域，条目数受 `cache.pageModels` 限制。 */
  private readonly pageCache: DisposableLruCache<number, Promise<PageEntry>>;
  /** 并发页面加载去重。 */
  private readonly pagePending = new Map<number, Promise<PageEntry>>();
  /** 模板页模型缓存（键：Content.xml 包内路径）。 */
  private readonly templateCache = new Map<string, Promise<PageModel>>();
  /** 页资源索引缓存（键：资源 XML 包内路径）。 */
  private readonly resourceIndexCache = new Map<string, Promise<ResourceIndex>>();
  /** 注释文件缓存（键：PageAnnot 包内路径）。 */
  private readonly annotationCache = new Map<string, Promise<readonly Annotation[]>>();

  /** 每个 Canvas 的渲染 Promise 链；同一 Canvas 串行。 */
  private readonly canvasChains = new WeakMap<Canvas2DLike, Promise<void>>();
  /** 进行中的渲染 promise（close 时等待）。 */
  private readonly activeRuns = new Set<Promise<void>>();
  /** 进行中渲染的内部取消器（close 时中止）。 */
  private readonly activeControllers = new Set<AbortController>();
  /** 文档级取消器；close 时中止，供所有渲染合并。 */
  private readonly closeController = new AbortController();

  private closed = false;

  /**
   * @param init 已完成的打开结果与运行时依赖。
   */
  private constructor(init: DocumentInit) {
    this.source = init.source;
    this.zip = init.zip;
    this.document = init.document;
    this.limits = init.limits;
    this.warnings = init.warnings;
    this.renderer = init.renderer;
    this.imageDecoders = init.imageDecoders;
    this.strictImageCtm = init.strictImageCtm;
    this.layerOrder = init.layerOrder;
    this.documentResources = init.documentResources;
    this.resourceStore = new ResourceStore(init.documentResources);
    this.fontLibrary = init.fontLibrary;
    this.documentWarningHandler = createDocumentWarningHandler(init.warnings);
    this.pageCount = init.document.pageCount;
    this.xmlCache = new DisposableLruCache<string, XmlCacheEntry>({
      maxBytes: init.cacheOptions.xmlBytes,
      sizeOf: (entry) => entry.bytes,
    });
    this.fontBytesCache = new DisposableLruCache<string, Uint8Array>({
      maxBytes: init.cacheOptions.fontBytes,
      sizeOf: (bytes) => bytes.byteLength,
    });
    this.imageCache = new DisposableLruCache<string, DecodedImage>({
      maxBytes: init.cacheOptions.imageBytes,
      sizeOf: (image) => image.width * image.height * 4,
      dispose: (image) => {
        const close = (image.data as { close?: () => void }).close;
        if (typeof close === 'function') {
          try {
            close.call(image.data);
          } catch {
            // ImageBitmap.close 失败不影响关闭流程。
          }
        }
      },
    });
    this.pageCache = new DisposableLruCache<number, Promise<PageEntry>>({
      maxEntries: init.cacheOptions.pageModels,
      sizeOf: () => 1,
    });
  }

  /**
   * 打开 OFD 文档。
   *
   * @param options 来源、资源限制、字体/图片插件、渲染器与 warning 回调。
   * @returns 文档实例。
   * @throws OFDError 包结构/XML/资源限制错误。
   */
  static async open(options: OFDOpenOptions): Promise<OFDDocument> {
    const limits: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...(options?.limits ?? {}) };
    const cacheOptions: CacheOptions = { ...DEFAULT_CACHE_OPTIONS, ...(options?.cache ?? {}) };
    const warnings = createWarningCollector(options?.onWarning);
    const onWarning = createDocumentWarningHandler(warnings);
    let source: ByteSource | undefined;
    let zip: ZipReader | undefined;
    try {
      if (!options || !options.source) {
        throw new OFDError('OFD_INVALID_PACKAGE', 'OFDDocument.open 缺少 source');
      }
      const requestedSource: OFDSource = options.source;
      source = await openByteSource(requestedSource);
      zip = await ZipReader.open(source, toZipLimits(limits));

      // 1) OFD.xml → DocRoot（支持多文档包）。
      const ofdRoot = await readXmlEntry(zip, 'OFD.xml', limits.maxXmlBytes, onWarning);
      const rootInfo = decodeOfdRoot(ofdRoot);
      const documentIndex = options.documentIndex ?? 0;
      let docRoot: string;
      if (!Number.isInteger(documentIndex) || documentIndex < 0) {
        throw new OFDError('OFD_INVALID_PACKAGE', `documentIndex 非法：${documentIndex}`);
      }
      if (rootInfo.docRoots.length > 0) {
        if (documentIndex >= rootInfo.docRoots.length) {
          throw new OFDError(
            'OFD_INVALID_PACKAGE',
            `documentIndex ${documentIndex} 超出文档数量 ${rootInfo.docRoots.length}`,
          );
        }
        docRoot = rootInfo.docRoots[documentIndex] as string;
      } else if (documentIndex === 0 && zip.hasEntry('Document.xml')) {
        // 少数简化包把 DocRoot 留空；Document.xml 位于包根。
        docRoot = '';
      } else {
        throw new OFDError('OFD_INVALID_PACKAGE', 'OFD.xml 缺少有效 DocRoot');
      }

      // 2) Document.xml → 页树与 CommonData。
      // 标准 OFD.xml 的 DocRoot 是 Document.xml 文件路径；兼容写成目录的实现/简化包。
      const normalizedRoot = docRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const documentPath = normalizedRoot === ''
        ? 'Document.xml'
        : /\.xml$/i.test(normalizedRoot)
          ? normalizedRoot
          : `${normalizedRoot}/Document.xml`;
      const documentNode = await readXmlEntry(zip, documentPath, limits.maxXmlBytes, onWarning);
      let document = decodeDocument(documentNode, documentPath, { onWarning });

      // 3) 文档级注释索引（DocumentModel.pageAnnotIndex）。
      if (document.annotationsFile) {
        try {
          const annotationsIndexNode = await readXmlEntry(
            zip,
            document.annotationsFile,
            limits.maxXmlBytes,
            onWarning,
          );
          const index = decodeAnnotationsIndex(
            annotationsIndexNode,
            dirnameOf(document.annotationsFile),
            { onWarning },
          );
          document = { ...document, pageAnnotIndex: index.pageAnnotIndex };
        } catch (error) {
          onWarning({
            code: 'W_ANNOT_EMPTY',
            message: `注释索引 ${document.annotationsFile} 解析失败：${errorMessage(error)}`,
          });
        }
      }

      // 4) 文档级资源索引（PublicRes + DocumentRes）。
      const publicRes = document.commonData?.publicRes ?? [];
      const documentRes = document.commonData?.documentRes ?? [];
      const sets: ResourceDefinitionSet[] = [];
      for (const path of [...publicRes, ...documentRes]) {
        try {
          const rootNode = await readXmlEntry(zip, path, limits.maxXmlBytes, onWarning);
          sets.push(decodePageResources(rootNode, path, { onWarning }));
        } catch (error) {
          onWarning({
            code: 'W_BAD_NUMBER',
            message: `资源文件 ${path} 解析失败：${errorMessage(error)}`,
          });
          sets.push(emptyResourceSet());
        }
      }
      const documentResources = buildDocumentResourceIndex({
        publicRes,
        documentRes,
        sets,
        ...(document.commonData?.defaultColorSpaceId
          ? { defaultColorSpace: document.commonData.defaultColorSpaceId }
          : {}),
        onWarning,
      });

      // 5) 字体库：内嵌字体按需注册，provider/supplementary 由宿主注入。
      const fontLibrary = new FontLibrary({
        ...(options.fontProvider ? { fontProvider: options.fontProvider } : {}),
        ...(options.supplementaryFonts ? { supplementaryFonts: options.supplementaryFonts } : {}),
        loadInput: createFontInputLoader(),
        onWarning: (code, message, context) => {
          const warning: OFDWarning = { code, message };
          if (context?.resourceId !== undefined) warning.resourceId = context.resourceId;
          onWarning(warning);
        },
        maxFontBytes: limits.maxFontBytes,
      });

      const renderer: Renderer = options.renderer ?? new H5Canvas2DRenderer();
      return new OFDDocument({
        source,
        zip,
        document,
        limits,
        cacheOptions,
        warnings,
        renderer,
        imageDecoders: options.imageDecoders ?? [],
        strictImageCtm: options.strictImageCtm ?? true,
        layerOrder: options.layerOrder ?? 'type',
        documentResources,
        fontLibrary,
      });
    } catch (error) {
      // 打开失败时释放已获得的 ZIP/文件句柄。
      zip?.close();
      await closeByteSource(source);
      throw wrapError(error, 'OFD_INVALID_PACKAGE', '打开 OFD 失败');
    }
  }

  /**
   * 按需加载指定页；索引从 0 开始。
   *
   * @param pageIndex 页索引。
   * @returns 页面实例（页尺寸已解析）。
   * @throws OFDError 页码越界/文档已关闭/页面解码失败。
   */
  async getPage(pageIndex: number): Promise<OFDPage> {
    this.assertOpen();
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new OFDError(
        'OFD_PAGE_NOT_FOUND',
        `页码越界：${pageIndex}（页数 ${this.pageCount}）`,
      );
    }
    const entry = await this.getPageEntry(pageIndex);
    return new OFDPageClass(pageIndex, entry.model.size, (params, signal) =>
      this.renderPage(pageIndex, params, signal),
    );
  }

  /**
   * 关闭文档并释放全部缓存与句柄；可重复调用。
   *
   * 进行中的渲染会先被中止；`close()` 不向调用方抛错。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    for (const controller of this.activeControllers) controller.abort();
    // 等待已开始的渲染结束（取消后通常在下一个对象/I/O 边界退出）。
    await Promise.allSettled([...this.activeRuns]);

    try {
      this.renderer.close();
    } catch {
      // 渲染器释放失败不阻塞关闭。
    }
    this.fontLibrary.dispose();
    this.xmlCache.clear();
    this.xmlPending.clear();
    this.fontBytesCache.clear();
    this.fontBytesPending.clear();
    this.imageCache.clear();
    this.imagePending.clear();
    this.pageCache.clear();
    this.pagePending.clear();
    this.templateCache.clear();
    this.resourceIndexCache.clear();
    this.annotationCache.clear();
    this.zip.close();
    await closeByteSource(this.source);
  }

  /**
   * 断言文档仍打开。
   *
   * @throws OFDError code=OFD_CLOSED。
   */
  private assertOpen(): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭');
  }

  /**
   * 渲染一页（被 `OFDPage.render` 调用）。
   *
   * 校验 viewport/canvas 后进入该 Canvas 的 Promise 链：准备阶段异步加载资源，
   * 绘制阶段同步执行；取消信号同时合并宿主 signal、任务 cancel 与 close。
   *
   * @param pageIndex 页索引。
   * @param params 宿主渲染参数。
   * @param taskSignal 渲染任务取消信号。
   */
  private async renderPage(
    pageIndex: number,
    params: PageRenderParameters,
    taskSignal: AbortSignal,
  ): Promise<void> {
    this.assertOpen();
    this.validateRenderParams(pageIndex, params);

    const canvas = params.canvasContext.canvas;
    const previous = this.canvasChains.get(canvas) ?? Promise.resolve();
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const combined = combineAbortSignals([taskSignal, controller.signal, this.closeController.signal]);

    const run = (async (): Promise<void> => {
      try {
        throwIfAborted(combined.signal);
        const entry = await this.getPageEntry(pageIndex);
        throwIfAborted(combined.signal);
        const pageWarning = createPageWarningHandler(this.warnings, pageIndex);
        const bundle = await preparePage({
          page: entry.model,
          resources: entry.resources,
          loader: this.createLoader(combined.signal),
          dpi: params.viewport.dpi,
          strictImageCtm: this.strictImageCtm,
          signal: combined.signal,
          onWarning: pageWarning,
        });
        throwIfAborted(combined.signal);
        drawPage(bundle, this.renderer, params.canvasContext, params.viewport, {
          layerOrder: this.layerOrder,
          strictImageCtm: this.strictImageCtm,
          signal: combined.signal,
          onWarning: pageWarning,
          pageIndex,
        });
        throwIfAborted(combined.signal);
      } catch (error) {
        throw wrapError(error, 'OFD_RENDERER_UNSUPPORTED', `第 ${pageIndex} 页渲染失败`);
      } finally {
        combined.dispose();
        this.activeControllers.delete(controller);
      }
    })();

    // 同一 Canvas 串行：前一个任务失败也继续执行后一个（失败由各自 promise 承担）。
    const chain = previous.catch(() => undefined).then(() => run);
    this.canvasChains.set(canvas, chain);
    this.activeRuns.add(chain);
    void chain
      .catch(() => undefined)
      .finally(() => {
        this.activeRuns.delete(chain);
        if (this.canvasChains.get(canvas) === chain) this.canvasChains.delete(canvas);
      });
    await chain;
  }

  /**
   * 校验渲染参数：viewport 合法性、Canvas 像素上限与 Canvas 宽高。
   *
   * @param pageIndex 页索引（用于错误信息）。
   * @param params 渲染参数。
   * @throws OFDError OFD_CANVAS_SIZE_MISMATCH / OFD_CANVAS_TOO_LARGE / OFD_RENDERER_UNSUPPORTED。
   */
  private validateRenderParams(pageIndex: number, params: PageRenderParameters): void {
    const viewport: Viewport | undefined = params?.viewport;
    if (
      !viewport ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      !Number.isFinite(viewport.dpi) ||
      viewport.dpi <= 0
    ) {
      throw new OFDError(
        'OFD_CANVAS_SIZE_MISMATCH',
        `第 ${pageIndex} 页 viewport 非法：${JSON.stringify(viewport)}`,
      );
    }
    if (this.limits.maxCanvasPixels > 0) {
      const pixels = viewport.width * viewport.height;
      if (pixels > this.limits.maxCanvasPixels) {
        throw new OFDError(
          'OFD_CANVAS_TOO_LARGE',
          `viewport ${Math.ceil(viewport.width)}×${Math.ceil(viewport.height)} 超过画布像素上限 ${this.limits.maxCanvasPixels}`,
        );
      }
    }
    const context: CanvasRenderingContext2DLike | undefined = params.canvasContext;
    const canvas: Canvas2DLike | undefined = context?.canvas;
    if (!context || !canvas) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', 'render 需要有效的 CanvasRenderingContext2DLike');
    }
    if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height)) {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', 'Canvas 宽高不是有效数值');
    }
    if (
      canvas.width + CANVAS_SIZE_EPSILON < viewport.width ||
      canvas.height + CANVAS_SIZE_EPSILON < viewport.height
    ) {
      throw new OFDError(
        'OFD_CANVAS_SIZE_MISMATCH',
        `Canvas 尺寸 ${canvas.width}×${canvas.height} 小于 viewport ${viewport.width}×${viewport.height}；请按 getViewport 设置 canvas.width/height`,
      );
    }
  }

  /**
   * 构造准备阶段 loader。
   *
   * @param signal 取消信号，用于准备阶段 I/O 前后检查。
   * @returns loader 实现。
   */
  private createLoader(signal: AbortSignal): {
    loadFontFaces(resources: readonly FontResource[]): Promise<ReadonlyMap<ResourceId, FontFaceSet>>;
    decodeImage(resource: ImageResource): Promise<DecodedImage>;
    loadTemplatePage(ref: TemplateRef): Promise<PageModel>;
    loadAnnotations(page: PageModel): Promise<readonly Annotation[]>;
  } {
    return {
      loadFontFaces: async (resources) => {
        throwIfAborted(signal);
        return this.loadFontFaces(resources, signal);
      },
      decodeImage: async (resource) => {
        throwIfAborted(signal);
        return this.decodeImage(resource);
      },
      loadTemplatePage: async (ref) => {
        throwIfAborted(signal);
        return this.loadTemplatePageModel(ref);
      },
      loadAnnotations: async (page) => {
        throwIfAborted(signal);
        return this.loadAnnotations(page);
      },
    };
  }

  /**
   * 加载页级资源作用域与模板页。
   *
   * @param pageIndex 页索引。
   * @returns 页面运行时。
   */
  private async getPageEntry(pageIndex: number): Promise<PageEntry> {
    const cached = this.pageCache.get(pageIndex);
    if (cached) return cached;
    const pending = this.pagePending.get(pageIndex);
    if (pending) return pending;

    const promise = this.loadPageEntry(pageIndex)
      .catch((error: unknown) => {
        this.pageCache.delete(pageIndex);
        throw wrapError(error, 'OFD_ENTRY_NOT_FOUND', `第 ${pageIndex} 页加载失败`);
      })
      .finally(() => {
        this.pagePending.delete(pageIndex);
      });
    this.pagePending.set(pageIndex, promise);
    this.pageCache.set(pageIndex, promise);
    return promise;
  }

  /**
   * 解码单个页面模型、解析页尺寸并合并资源作用域。
   *
   * @param pageIndex 页索引。
   * @returns 页面运行时。
   */
  private async loadPageEntry(pageIndex: number): Promise<PageEntry> {
    const ref = this.document.pages[pageIndex];
    if (!ref || !ref.loc) {
      throw new OFDError('OFD_ENTRY_NOT_FOUND', `第 ${pageIndex} 页缺少 Content 文件`);
    }
    const pageWarning = createPageWarningHandler(this.warnings, pageIndex);
    const root = await this.readXml(ref.loc, pageWarning);
    let model = decodePageContent(root, ref.id, ref.loc, this.decodeOptions(pageWarning));

    // 用文档模板表补齐 TemplateRef.loc；模板页按引用顺序解码。
    model = { ...model, templates: model.templates.map((template) => this.withTemplateLoc(template)) };
    const decodedTemplates: PageModel[] = [];
    const templateAreas: PageAreaCandidate[] = [];
    for (const template of model.templates) {
      try {
        const decoded = await this.loadTemplatePageModel(template);
        decodedTemplates.push(decoded);
        templateAreas.push({ id: template.id, area: decoded.area });
      } catch (error) {
        templateAreas.push({ id: template.id });
        pageWarning({
          code: 'W_UNSUPPORTED_PAINT',
          message: `模板页 ${template.id} 加载失败：${errorMessage(error)}`,
          resourceId: template.id,
        });
      }
    }

    // 页尺寸回退：页面 → 模板（按引用顺序第一个有效 Area）→ CommonData → A4。
    const resolution = resolvePageArea({
      pageArea: model.area,
      templateAreas,
      ...(this.document.commonData?.pageArea
        ? { commonDataArea: this.document.commonData.pageArea }
        : {}),
      onWarning: pageWarning,
    });
    model = applyPageArea(model, resolution);

    // 注释文件：DocumentModel.pageAnnotIndex 按页 ID 索引。
    const annotationFile = this.document.pageAnnotIndex[model.id];
    if (annotationFile) model = { ...model, annotationFile };

    // 页资源与模板资源（均按 XML/引用顺序）。
    const pageResources = await Promise.all(
      model.pageRes.map((path) => this.loadResourceIndex(path, pageWarning)),
    );
    const templateResources: ResourceIndex[] = [];
    for (const template of decodedTemplates) {
      for (const path of template.pageRes) {
        templateResources.push(await this.loadResourceIndex(path, pageWarning));
      }
    }
    const resources = this.resourceStore.createPageScope({
      page: model,
      document: this.documentResources,
      pageResources,
      templateResources,
      onWarning: pageWarning,
    });
    return { model, resources, templates: decodedTemplates };
  }

  /**
   * 解析模板引用的内容文件路径。
   *
   * 文档模板表（TemplatePage/BaseLoc）可能指向目录（标准写法）或直接指向 XML；
   * 先按目录拼 `Content.xml`，不存在时回退到 BaseLoc 本身。
   *
   * @param ref 模板引用。
   * @returns 模板 Content.xml 的包内路径；无法解析时为 undefined。
   */
  private templateContentLoc(ref: TemplateRef): string | undefined {
    if (ref.loc) return ref.loc;
    const baseLoc = this.document.templatePages[ref.id]?.baseLoc;
    if (!baseLoc) return undefined;
    const normalized = baseLoc.replace(/\/+$/, '');
    if (/\.xml$/i.test(normalized)) return normalized;
    const candidate = normalized ? `${normalized}/Content.xml` : 'Content.xml';
    if (this.zip.hasEntry(normalized) && !this.zip.hasEntry(candidate)) return normalized;
    return candidate;
  }

  /**
   * 用文档模板表补齐模板引用路径。
   *
   * @param ref 页面模型中的模板引用。
   * @returns 带 `loc` 的新引用（找不到时保持原样）。
   */
  private withTemplateLoc(ref: TemplateRef): TemplateRef {
    if (ref.loc) return ref;
    const loc = this.templateContentLoc(ref);
    return loc ? { ...ref, loc } : ref;
  }

  /**
   * 解码模板页 Content.xml；按路径缓存。
   *
   * @param ref 模板引用。
   * @returns 模板页模型。
   * @throws OFD_ENTRY_NOT_FOUND 模板文件缺失/路径无法解析。
   */
  private loadTemplatePageModel(ref: TemplateRef): Promise<PageModel> {
    const loc = this.templateContentLoc(ref);
    if (!loc) {
      return Promise.reject(
        new OFDError('OFD_ENTRY_NOT_FOUND', `模板页 ${ref.id} 缺少 BaseLoc`),
      );
    }
    const cached = this.templateCache.get(loc);
    if (cached) return cached;
    const promise = (async (): Promise<PageModel> => {
      const root = await this.readXml(loc, this.documentWarningHandler);
      const model = decodePageContent(root, ref.id, loc, this.decodeOptions(this.documentWarningHandler));
      return { ...model, templates: model.templates.map((template) => this.withTemplateLoc(template)) };
    })().catch((error: unknown) => {
      this.templateCache.delete(loc);
      throw wrapError(error, 'OFD_ENTRY_NOT_FOUND', `模板页 ${ref.id} 解析失败`);
    });
    this.templateCache.set(loc, promise);
    return promise;
  }

  /**
   * 读取并解码一个资源 XML；按路径缓存索引。
   *
   * @param path 资源 XML 包内路径。
   * @param onWarning warning 回调。
   * @returns 资源索引。
   */
  private loadResourceIndex(
    path: string,
    onWarning: (warning: OFDWarning) => void,
  ): Promise<ResourceIndex> {
    const cached = this.resourceIndexCache.get(path);
    if (cached) return cached;
    const promise = (async (): Promise<ResourceIndex> => {
      const root = await this.readXml(path, onWarning);
      const set = decodePageResources(root, path, this.decodeOptions(onWarning));
      return resourceSetToIndex(set);
    })().catch((error: unknown) => {
      this.resourceIndexCache.delete(path);
      throw wrapError(error, 'OFD_ENTRY_NOT_FOUND', `资源文件 ${path} 解析失败`);
    });
    this.resourceIndexCache.set(path, promise);
    return promise;
  }

  /**
   * 加载页面注释（PageAnnot）；按文件路径缓存。
   *
   * @param page 页面模型。
   * @returns 注释数组；无注释时为空。
   */
  private loadAnnotations(page: PageModel): Promise<readonly Annotation[]> {
    const path = page.annotationFile;
    if (!path) return Promise.resolve([]);
    const cached = this.annotationCache.get(path);
    if (cached) return cached;
    const pageIds = this.document.pages.map((ref) => ref.id);
    const promise = (async (): Promise<readonly Annotation[]> => {
      const root = await this.readXml(path, this.documentWarningHandler);
      return decodeAnnotations(root, pageIds, this.decodeOptions(this.documentWarningHandler));
    })().catch((error: unknown) => {
      this.annotationCache.delete(path);
      throw wrapError(error, 'OFD_ENTRY_NOT_FOUND', `注释文件 ${path} 解析失败`);
    });
    this.annotationCache.set(path, promise);
    return promise;
  }

  /**
   * 加载字体面集合：内嵌字体 → FontProvider → supplementaryFonts。
   *
   * 单字体失败只 warning，不影响整页。
   *
   * @param resources 本页引用的字体资源（已去重）。
   * @param signal 取消信号。
   * @returns 字体资源 ID → 字体面集合。
   */
  private async loadFontFaces(
    resources: readonly FontResource[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<ResourceId, FontFaceSet>> {
    const result = new Map<ResourceId, FontFaceSet>();
    await Promise.all(
      resources.map(async (font) => {
        if (signal.aborted) return;
        try {
          if (font.fontFile) {
            const bytes = await this.loadFontBytes(font.fontFile, signal);
            if (bytes) this.fontLibrary.registerEmbedded(font, bytes);
          }
          const faces = await this.fontLibrary.resolve(font);
          if (faces) result.set(font.id, faces);
        } catch (error) {
          if (signal.aborted) return;
          this.documentWarningHandler({
            code: 'W_FONT_MISSING',
            message: `字体 ${font.id}（${font.fontName}）加载失败：${errorMessage(error)}`,
            resourceId: font.id,
          });
        }
      }),
    );
    return result;
  }

  /**
   * 读取字体文件字节；按路径 LRU + Promise 去重。
   *
   * @param path 包内路径。
   * @param signal 取消信号。
   * @returns 字体字节；文件缺失/超限时返回 null。
   */
  private async loadFontBytes(path: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const cached = this.fontBytesCache.get(path);
    if (cached) return cached;
    const pending = this.fontBytesPending.get(path);
    if (pending) return pending;
    const promise = (async (): Promise<Uint8Array> => {
      throwIfAborted(signal);
      const bytes = await this.zip.readEntry(path, {
        maxBytes: this.limits.maxFontBytes,
        onWarning: this.documentWarningHandler,
      });
      throwIfAborted(signal);
      this.fontBytesCache.set(path, bytes);
      return bytes;
    })().finally(() => {
      this.fontBytesPending.delete(path);
    });
    this.fontBytesPending.set(path, promise);
    try {
      return await promise;
    } catch (error) {
      if (error instanceof OFDError && error.code === 'OFD_ABORTED') throw error;
      return null;
    }
  }

  /**
   * 解码图片资源；按包内路径 LRU + Promise 去重。
   *
   * @param resource 图片资源元数据。
   * @returns 解码结果。
   * @throws OFDError 读取/解码失败或超限时（prepare 捕获后 warning 跳过）。
   */
  private async decodeImage(resource: ImageResource): Promise<DecodedImage> {
    this.assertOpen();
    const cached = this.imageCache.get(resource.mediaFile);
    if (cached) return cached;
    const pending = this.imagePending.get(resource.mediaFile);
    if (pending) return pending;
    const promise = (async (): Promise<DecodedImage> => {
      const bytes = await this.zip.readEntry(resource.mediaFile, {
        maxBytes: this.limits.maxEntryBytes,
        onWarning: this.documentWarningHandler,
      });
      const format =
        resource.format !== 'unknown'
          ? resource.format
          : detectImageFormat(bytes, resource.mediaFile);
      const decoded = await this.decodeImageBytes(bytes, format);
      this.imageCache.set(resource.mediaFile, decoded);
      return decoded;
    })().finally(() => {
      this.imagePending.delete(resource.mediaFile);
    });
    this.imagePending.set(resource.mediaFile, promise);
    return promise;
  }

  /**
   * 用宿主插件/内置解码器/浏览器原生能力解码图片。
   *
   * @param bytes 图片字节。
   * @param format 图片格式。
   * @returns 解码结果。
   * @throws OFDError 无解码器、像素超限或解码失败时。
   */
  private async decodeImageBytes(bytes: Uint8Array, format: string): Promise<DecodedImage> {
    const header = readImageSize(bytes, format as ImageResource['format']);
    if (header && !isWithinImagePixelLimit(header.width, header.height, this.limits.maxImagePixels)) {
      throw new OFDError(
        'OFD_LIMIT_EXCEEDED',
        `${format} 图片 ${header.width}×${header.height} 超过像素上限 ${this.limits.maxImagePixels}`,
      );
    }

    const plugin = await resolveImageDecoder(format, this.imageDecoders, {
      maxPixels: this.limits.maxImagePixels,
      onWarning: this.documentWarningHandler,
    });
    if (plugin) {
      const decoded = await plugin.decode(bytes);
      return assertDecodedImage(decoded, this.limits.maxImagePixels, format);
    }

    if (BROWSER_NATIVE_FORMATS.has(format.toLowerCase())) {
      const decoded = await this.decodeWithBrowser(bytes, format);
      if (decoded) return assertDecodedImage(decoded, this.limits.maxImagePixels, format);
    }
    throw new OFDError('OFD_IMAGE_DECODE', `缺少 ${format} 图片解码器（当前环境无原生解码能力）`);
  }

  /**
   * 浏览器原生图片解码：优先 `createImageBitmap`，回退 `HTMLImageElement`。
   *
   * 仅在浏览器/Worker 环境可用；Node 测试必须注入 `ImageDecoderPlugin`。
   *
   * @param bytes 图片字节。
   * @param format 图片格式。
   * @returns 解码结果；环境不支持时返回 null。
   */
  private async decodeWithBrowser(bytes: Uint8Array, format: string): Promise<DecodedImage | null> {
    const globals = globalThis as unknown as BrowserImageGlobals;
    // 复制为独立 ArrayBuffer 视图，满足 BlobPart 对非共享缓冲的要求。
    const copy = new Uint8Array(bytes);
    const blob = new Blob([copy], { type: mimeTypeOf(format) });

    if (typeof globals.createImageBitmap === 'function') {
      try {
        const bitmap = await globals.createImageBitmap(blob);
        if (bitmap.width > 0 && bitmap.height > 0) {
          return { width: bitmap.width, height: bitmap.height, data: bitmap, kind: 'source' };
        }
      } catch {
        // 继续尝试 HTMLImageElement。
      }
    }

    const documentApi = globals.document;
    const urlApi = globals.URL;
    let image: BrowserImageElement | null = null;
    if (globals.Image) image = new globals.Image();
    else if (documentApi) image = documentApi.createElement('img');
    if (!image || !urlApi) return null;

    const objectUrl = urlApi.createObjectURL(blob);
    try {
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = (event) => reject(event ?? new Error('图片加载失败'));
      });
      image.src = objectUrl;
      await loaded;
      const width = image.naturalWidth > 0 ? image.naturalWidth : image.width;
      const height = image.naturalHeight > 0 ? image.naturalHeight : image.height;
      if (!(width > 0) || !(height > 0)) return null;
      return { width, height, data: image, kind: 'source' };
    } catch {
      return null;
    } finally {
      urlApi.revokeObjectURL(objectUrl);
    }
  }

  /**
   * 读取 XML（LRU + 并发去重）。
   *
   * @param path 包内路径。
   * @param onWarning CRC/大小不一致 warning 回调。
   * @returns XML 根节点。
   */
  private async readXml(
    path: string,
    onWarning: (warning: OFDWarning) => void,
  ): Promise<XmlNode> {
    const cached = this.xmlCache.get(path);
    if (cached) return cached.node;
    const pending = this.xmlPending.get(path);
    if (pending) return pending;
    const promise = (async (): Promise<XmlNode> => {
      const bytes = await this.zip.readEntry(path, {
        maxBytes: this.limits.maxXmlBytes,
        onWarning,
      });
      const node = parseXml(bytes);
      this.xmlCache.set(path, { node, bytes: bytes.byteLength * 2 });
      return node;
    })().finally(() => {
      this.xmlPending.delete(path);
    });
    this.xmlPending.set(path, promise);
    return promise;
  }

  /**
   * 构造模型解码选项（颜色空间来自文档级资源索引）。
   *
   * @param onWarning warning 回调。
   * @returns 解码选项。
   */
  private decodeOptions(onWarning: (warning: OFDWarning) => void): {
    onWarning: (warning: OFDWarning) => void;
    colorSpaces: ReadonlyMap<ResourceId, ColorSpaceDef>;
    defaultColorSpaceId?: ResourceId;
  } {
    return {
      onWarning,
      colorSpaces: this.documentResources.colorSpaces,
      ...(this.documentResources.defaultColorSpace
        ? { defaultColorSpaceId: this.documentResources.defaultColorSpace }
        : {}),
    };
  }
}

/**
 * 空的资源定义集合；用于单个资源 XML 解析失败时保持集合顺序。
 *
 * @returns 空集合。
 */
function emptyResourceSet(): ResourceDefinitionSet {
  return {
    fonts: [],
    images: [],
    drawParams: [],
    compositeGraphicUnits: [],
    colorSpaces: [],
    patterns: new Map(),
  };
}

/**
 * 取错误消息。
 *
 * @param error 任意错误。
 * @returns 可读消息。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 创建宿主字体来源加载器。
 *
 * Web 优先：`data` 由 FontLibrary 内部直接处理；`url` 用 fetch 读取。
 * `path`/`filePath` 属于 Node/小程序来源，本轮不实现，返回明确错误由字体层 warning。
 *
 * @returns FontInputLoader。
 */
function createFontInputLoader(): FontInputLoader {
  return async (input: FontInput): Promise<Uint8Array | null> => {
    if ('url' in input) {
      if (typeof globalThis.fetch !== 'function') {
        throw new Error('当前环境没有 fetch，无法加载字体 URL');
      }
      const response = await globalThis.fetch(input.url);
      if (!response.ok) throw new Error(`字体 URL 加载失败：HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    throw new Error('Web 优先版本不支持本地字体 path/filePath，请改用 data 或 url');
  };
}