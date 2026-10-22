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
import type { FontInput, FontProvider } from '../platform/font-provider';
import type { ImageDecoderPlugin } from '../platform/image-decoder';
import type { Box, DecodedImage, Viewport } from '../common/types';
import type {
  Annotation,
  ColorSpaceDef,
  DocumentModel,
  DocInfo,
  FontResource,
  ImageResource,
  PageModel,
  PageSize,
  ResourceId,
  SealImage,
  SignatureBundle,
  SignatureModel,
  TemplateRef,
} from '../model/types';
import type { DocumentResourceIndex, PageResourceScope, ResourceIndex } from '../resource/types';
import type { Canvas2DLike, CanvasRenderingContext2DLike, Renderer } from '../renderer/types';
import type { OFDWarning, WarningCollector } from '../warnings';
import type {
  CacheOptions,
  CanvasImageEncodeSource,
  EncodeImage,
  OFDOpenOptions,
  OFDSource,
  PageImageExportOptions,
  PageImageFormat,
  PageImageMime,
  PageImageResult,
  PageRenderParameters,
  ResourceLimits,
} from './types';
import type { OFDPage } from './page';
import type {
  BookmarkItem,
  DocumentMetadata,
  OFDDocumentApi,
  OutlineNode,
  PageInfo,
  PageInfoOptions,
  PagePrepareOptions,
  SignatureEntryInfo,
  SignatureStampInfo,
  SignedValueFile,
} from './ui-types';
import type { FontInputLoader } from '../font/provider';
import type { FontFaceSet } from '../font/types';
import type { PageAreaCandidate } from '../model/page-area';
import { decodePageAreaXml } from '../model/page-info';
import type { PageAreaInfo } from '../model/page-info';

import { DEFAULT_CACHE_OPTIONS, DEFAULT_RESOURCE_LIMITS } from './types';
import { OFDPage as OFDPageClass } from './page';
import { combineAbortSignals, createAbortError, throwIfAborted, wrapError } from './render-task';
import { DEFAULT_DPI, getPageViewport } from './viewport';
import { openByteSource } from './source';
import {
  createWarningCollector,
  createDocumentWarningHandler,
  createPageWarningHandler,
} from './warnings';
import { DisposableLruCache } from './cache';
import { isOFDError, OFDError } from '../errors';
import { ZipReader } from '../container/zip-reader';
import type { ZipLimits } from '../container/zip-reader';
import { dirnameOf } from '../container/path';
import { normalizeResourceId } from '../model/ids';
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
  decodeSignature,
  decodeSignatureBundle,
  decodeSignaturesIndex,
  signatureIndexCandidates,
} from '../model/signature';
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
import { H5Canvas2DRenderer, H5CanvasFactory } from '../renderer/canvas2d';
import { preparePage } from '../render/prepare';
import type {
  PreparedPageBundle,
  PreparePageLoader,
  SignatureStampSource,
} from '../render/prepare';
import { drawPage } from '../render/page';

/** Canvas 尺寸比较容差，避免浮点 viewport 与整数 canvas 的舍入误差。 */
const CANVAS_SIZE_EPSILON = 1e-6;

/** 矢量 OFD 印章离屏渲染的目标 DPI；上限由 maxImagePixels/maxCanvasPixels 收敛。 */
const VECTOR_SEAL_DPI = 300;

/** 页面图片导出默认 DPI。 */
const DEFAULT_EXPORT_DPI = 96;

/** 页面图片导出 JPEG/WebP 默认质量。 */
const DEFAULT_EXPORT_QUALITY = 0.92;

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
  /** 打开时解析的文档属性缓存；close 后不可再取。 */
  metadata: DocumentMetadata;
  limits: ResourceLimits;
  cacheOptions: CacheOptions;
  warnings: WarningCollector;
  renderer: Renderer;
  imageDecoders: readonly ImageDecoderPlugin[];
  strictImageCtm: boolean;
  layerOrder: 'document' | 'type';
  documentResources: DocumentResourceIndex;
  fontLibrary: FontLibrary;
  /** Signs/Signatures.xml 包内路径；文档无签章索引时缺省。 */
  signatureIndexPath?: string;
  /** Document 声明但读取失败的 Annotations 索引路径；用于页级 warning。 */
  annotationsIndexError?: string;
  /** 宿主临时画布工厂；供矢量 OFD 章与内部 H5 渲染器复用。 */
  createCanvas?: (width: number, height: number) => Canvas2DLike;
  /** 文档级导出画布工厂；仅来自 `OFDOpenOptions.createCanvas`。 */
  exportCanvas?: (width: number, height: number) => Canvas2DLike;
  /** 页面图片编码钩子；仅来自 `OFDOpenOptions.encodeImage`。 */
  encodeImage?: EncodeImage;
  /** 宿主字体提供者；矢量章独立打开内嵌 OFD 时继承。 */
  fontProvider?: FontProvider;
  /** 宿主补充字体；矢量章独立打开内嵌 OFD 时继承。 */
  supplementaryFonts?: readonly FontInput[];
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
  private readonly metadata: DocumentMetadata;
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
  /** Signs/Signatures.xml 包内路径；无签章索引时 undefined，loader 不注册签章方法。 */
  private readonly signatureIndexPath: string | undefined;
  /** Document 声明但读取失败的 Annotations 索引路径；无失败时为 undefined。 */
  private readonly annotationsIndexError: string | undefined;
  /** 宿主临时画布工厂；未注入时矢量章使用浏览器默认工厂。 */
  private readonly createCanvas: ((width: number, height: number) => Canvas2DLike) | undefined;
  /** 文档级导出画布工厂；严格使用 `OFDOpenOptions.createCanvas`。 */
  private readonly exportCanvas: ((width: number, height: number) => Canvas2DLike) | undefined;
  /** 页面图片编码钩子；未注入时使用浏览器 Canvas 原生编码。 */
  private readonly encodeImage: EncodeImage | undefined;
  /** 宿主字体提供者；供矢量章嵌套文档继承。 */
  private readonly fontProvider: FontProvider | undefined;
  /** 宿主补充字体；供矢量章嵌套文档继承。 */
  private readonly supplementaryFonts: readonly FontInput[] | undefined;
  /** 是否允许加载签章；矢量章嵌套文档关闭，避免递归。 */
  private signatureLoading = true;

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
  /** getPageInfos 页尺寸缓存；按页索引。 */
  private readonly pageInfoCache = new Map<number, PageInfo>();
  /** getPageInfos 并发去重。 */
  private readonly pageInfoPending = new Map<number, Promise<PageInfo>>();
  /** 模板页 Area 缓存（键：Content.xml 包内路径）；只用于页尺寸回退。 */
  private readonly templateAreaCache = new Map<string, Promise<Box | undefined>>();
  /** prepare 已完成的 bundle；当前每页保留一个 DPI。 */
  private readonly preparedBundles = new Map<number, { dpi: number; bundle: PreparedPageBundle }>();
  /** prepare 并发去重。 */
  private readonly preparePending = new Map<number, Promise<PreparedPageBundle>>();
  /** 模板页模型缓存（键：Content.xml 包内路径）。 */
  private readonly templateCache = new Map<string, Promise<PageModel>>();
  /** 页资源索引缓存（键：资源 XML 包内路径）。 */
  private readonly resourceIndexCache = new Map<string, Promise<ResourceIndex>>();
  /** 注释文件缓存（键：PageAnnot 包内路径）。 */
  private readonly annotationCache = new Map<string, Promise<readonly Annotation[]>>();
  /** 文档级签章集合缓存；无 Signatures.xml 时为已解析的 undefined。 */
  private signatureBundlePromise: Promise<SignatureBundle | undefined> | undefined;
  /** 公开签章 XML 条目缓存；只含 XML 元数据，不读取 Seal/SignedValue。 */
  private signatureEntriesCache: readonly SignatureEntryInfo[] | undefined;
  /** 公开签章条目并发加载去重。 */
  private signatureEntriesPending: Promise<readonly SignatureEntryInfo[]> | undefined;
  /** 按 SealImage.cacheKey（缺省实例）缓存印章解码结果，避免骑缝章逐页重复解码。 */
  private readonly signatureSealPromises = new Map<string | SealImage, Promise<DecodedImage>>();
  /** 本文档解码出的印章图片，关闭时释放 ImageBitmap。 */
  private readonly signatureSealImages = new Set<DecodedImage>();

  /** 每个 Canvas 的渲染 Promise 链；同一 Canvas 串行。 */
  private readonly canvasChains = new WeakMap<Canvas2DLike, Promise<void>>();
  /** 进行中的渲染/导出 promise（close 时等待）。 */
  private readonly activeRuns = new Set<Promise<unknown>>();
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
    this.metadata = init.metadata;
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
    this.signatureIndexPath = init.signatureIndexPath;
    this.annotationsIndexError = init.annotationsIndexError;
    this.createCanvas = init.createCanvas;
    this.exportCanvas = init.exportCanvas;
    this.encodeImage = init.encodeImage;
    this.fontProvider = init.fontProvider;
    this.supplementaryFonts = init.supplementaryFonts;
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
    let annotationsIndexError: string | undefined;
    try {
      if (!options || !options.source) {
        throw new OFDError('OFD_INVALID_PACKAGE', 'OFDDocument.open 缺少 source');
      }
      const requestedSource: OFDSource = options.source;
      source = await openByteSource(requestedSource);
      zip = await ZipReader.open(source, toZipLimits(limits));

      // 1) OFD.xml → DocRoot（支持多文档包）。
      const ofdRoot = await readXmlEntry(zip, 'OFD.xml', limits.maxXmlBytes, onWarning);
      const rootInfo = decodeOfdRoot(ofdRoot, { onWarning });
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
          annotationsIndexError = document.annotationsFile;
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

      const renderer: Renderer =
        options.renderer ??
        new H5Canvas2DRenderer(
          options.createCanvas ? { createCanvas: options.createCanvas } : undefined,
        );
      // 兼容旧宿主：显式 H5 渲染器已注入的 createCanvas 继续作为矢量章工厂。
      const createCanvas = options.createCanvas ?? createCanvasFromRenderer(renderer);
      const signaturePath = signatureIndexCandidates(documentPath).find((path) =>
        zip?.hasEntry(path),
      );
      const metadata: DocumentMetadata = {
        version: rootInfo.version,
        pageCount: document.pageCount,
        packageSize: source.size,
        ...metadataFromDocInfo(rootInfo.docInfos[documentIndex]),
      };
      return new OFDDocument({
        source,
        zip,
        document,
        metadata,
        limits,
        cacheOptions,
        warnings,
        renderer,
        imageDecoders: options.imageDecoders ?? [],
        strictImageCtm: options.strictImageCtm ?? true,
        layerOrder: options.layerOrder ?? 'type',
        documentResources,
        fontLibrary,
        ...(signaturePath ? { signatureIndexPath: signaturePath } : {}),
        ...(annotationsIndexError ? { annotationsIndexError } : {}),
        ...(createCanvas ? { createCanvas } : {}),
        ...(options.createCanvas ? { exportCanvas: options.createCanvas } : {}),
        ...(options.encodeImage ? { encodeImage: options.encodeImage } : {}),
        ...(options.fontProvider ? { fontProvider: options.fontProvider } : {}),
        ...(options.supplementaryFonts ? { supplementaryFonts: options.supplementaryFonts } : {}),
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
    return new OFDPageClass(
      pageIndex,
      entry.model.size,
      (params, signal) => this.renderPage(pageIndex, params, signal),
      (options) => this.exportPage(pageIndex, entry.model.size, options),
      (options) => this.preparePageIndex(pageIndex, options),
    );
  }

  /**
   * 批量读取页尺寸信息，不构建 display list、不解码字体/图片。
   *
   * 支持分片与取消；返回连续页、按索引升序。页尺寸与 `getPage(index).getSize()`
   * 使用同一 Area/模板/CommonData 回退链。结果按页缓存到 `close()`。
   *
   * @param options 起始页、页数与取消信号。
   * @returns 页信息数组；越界时为空数组或截断到实际页数。
   * @throws OFDError 取消或文档已关闭。
   */
  async getPageInfos(options: PageInfoOptions = {}): Promise<readonly PageInfo[]> {
    this.assertOpen();
    throwIfAborted(options.signal);
    const total = this.pageCount;
    const start = normalizeInfoStart(options.start, total);
    const count = normalizeInfoCount(options.count, total - start);
    if (start < 0 || start >= total || count <= 0) return [];

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const combined = combineAbortSignals([
      options.signal,
      controller.signal,
      this.closeController.signal,
    ]);
    const run = (async (): Promise<readonly PageInfo[]> => {
      const infos: PageInfo[] = [];
      try {
        const end = Math.min(total, start + count);
        // 分小批并发读取，兼顾 1000 页性能与取消响应；不跨页并发全部 I/O。
        const batchSize = 128;
        for (let from = start; from < end; from += batchSize) {
          this.assertInfoActive(combined.signal);
          const to = Math.min(end, from + batchSize);
          const batch = await Promise.all(
            Array.from({ length: to - from }, (_, offset) => this.getPageInfo(from + offset)),
          );
          this.assertInfoActive(combined.signal);
          infos.push(...batch);
        }
        return infos;
      } catch (error) {
        if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭', { cause: error });
        throw error;
      } finally {
        combined.dispose();
        this.activeControllers.delete(controller);
      }
    })();
    this.trackActiveRun(run);
    return run;
  }

  /**
   * 预取一页：复用 preparePage 并缓存 bundle。
   *
   * 已准备或正在准备时复用；不创建 canvas。caller 的 signal 只影响本次等待，
   * 不取消共享准备流程；close 会中止共享流程。
   *
   * @param pageIndex 页索引。
   * @param options 取消信号。
   * @throws OFDError 取消、文档已关闭或准备失败。
   */
  private async preparePageIndex(
    pageIndex: number,
    options: PagePrepareOptions,
  ): Promise<void> {
    this.assertOpen();
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new OFDError(
        'OFD_PAGE_NOT_FOUND',
        `页码越界：${pageIndex}（页数 ${this.pageCount}）`,
      );
    }
    throwIfAborted(options.signal);
    const prepared = this.preparedBundles.get(pageIndex);
    if (prepared && prepared.dpi === DEFAULT_DPI) {
      throwIfAborted(options.signal);
      return;
    }

    let pending = this.preparePending.get(pageIndex);
    if (!pending) {
      pending = this.runPreparePage(pageIndex);
      this.preparePending.set(pageIndex, pending);
      void pending
        .catch(() => undefined)
        .finally(() => {
          if (this.preparePending.get(pageIndex) === pending) {
            this.preparePending.delete(pageIndex);
          }
        });
    }
    await waitForAbort(pending, options.signal);
  }

  /**
   * 执行页面准备；共享流程只受 close 控制，单个调用方取消不污染缓存。
   *
   * @param pageIndex 页索引。
   * @returns 准备好的页面 bundle。
   * @throws OFDError 关闭或准备失败。
   */
  private async runPreparePage(pageIndex: number): Promise<PreparedPageBundle> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const combined = combineAbortSignals([controller.signal, this.closeController.signal]);
    const run = (async (): Promise<PreparedPageBundle> => {
      try {
        throwIfAborted(combined.signal);
        const entry = await this.getPageEntry(pageIndex);
        throwIfAborted(combined.signal);
        const pageWarning = createPageWarningHandler(this.warnings, pageIndex);
        const bundle = await preparePage({
          page: entry.model,
          resources: entry.resources,
          loader: this.createLoader(combined.signal, pageIndex),
          dpi: DEFAULT_DPI,
          strictImageCtm: this.strictImageCtm,
          signal: combined.signal,
          onWarning: pageWarning,
        });
        throwIfAborted(combined.signal);
        if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭');
        this.preparedBundles.set(pageIndex, { dpi: DEFAULT_DPI, bundle });
        return bundle;
      } catch (error) {
        if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭', { cause: error });
        throw error;
      } finally {
        combined.dispose();
        this.activeControllers.delete(controller);
      }
    })();
    this.trackActiveRun(run);
    return run;
  }

  /**
   * 读取单页尺寸信息；按页缓存并合并并发请求。
   *
   * @param pageIndex 页索引。
   * @returns 页信息。
   */
  private getPageInfo(pageIndex: number): Promise<PageInfo> {
    const cached = this.pageInfoCache.get(pageIndex);
    if (cached) return Promise.resolve(cached);
    const pending = this.pageInfoPending.get(pageIndex);
    if (pending) return pending;
    const promise = this.loadPageInfo(pageIndex)
      .then((info) => {
        this.pageInfoCache.set(pageIndex, info);
        return info;
      })
      .finally(() => {
        this.pageInfoPending.delete(pageIndex);
      });
    this.pageInfoPending.set(pageIndex, promise);
    return promise;
  }

  /**
   * 轻量解码页尺寸：只读 Page.xml 的 Area 与模板引用。
   *
   * @param pageIndex 页索引。
   * @returns 页信息；缺页/非法 Area 时 warning 并使用回退尺寸。
   */
  private async loadPageInfo(pageIndex: number): Promise<PageInfo> {
    const pageWarning = createPageWarningHandler(this.warnings, pageIndex);
    const ref = this.document.pages[pageIndex];
    let areaInfo: PageAreaInfo = { templates: [] };
    if (!ref?.loc) {
      pageWarning({
        code: 'W_BAD_PATH',
        message: `第 ${pageIndex} 页缺少 Content 文件，页尺寸按回退链处理`,
      });
    } else {
      try {
        const bytes = await this.zip.readEntry(ref.loc, {
          maxBytes: this.limits.maxXmlBytes,
          onWarning: pageWarning,
        });
        areaInfo = decodePageAreaXml(bytes, ref.id, pageWarning);
      } catch (error) {
        pageWarning({
          code: 'W_BAD_PATH',
          message: `第 ${pageIndex} 页 Content.xml 读取失败：${errorMessage(error)}`,
        });
      }
    }

    const templateAreas: PageAreaCandidate[] = [];
    for (const reference of areaInfo.templates) {
      const template = this.withTemplateLoc(reference);
      let area: Box | undefined;
      if (template.loc) {
        area = await this.loadTemplateArea(template.loc);
      }
      if (!area) {
        pageWarning({
          code: 'W_UNSUPPORTED_PAINT',
          message: `模板页 ${template.id} 无可用 Area，页尺寸继续回退`,
          resourceId: template.id,
        });
      }
      templateAreas.push({ id: template.id, ...(area ? { area } : {}) });
    }

    const resolution = resolvePageArea({
      ...(areaInfo.area ? { pageArea: areaInfo.area } : {}),
      templateAreas,
      ...(this.document.commonData?.pageArea
        ? { commonDataArea: this.document.commonData.pageArea }
        : {}),
      onWarning: pageWarning,
    });
    const source =
      resolution.source === 'page'
        ? 'page'
        : resolution.source === 'template'
          ? 'template'
          : 'default';
    return {
      index: pageIndex,
      widthMm: resolution.size.width,
      heightMm: resolution.size.height,
      ...(resolution.area.x !== 0 ? { xMm: resolution.area.x } : {}),
      ...(resolution.area.y !== 0 ? { yMm: resolution.area.y } : {}),
      source,
    };
  }

  /**
   * 只读取模板页 Area；按模板 Content.xml 路径缓存。
   *
   * @param loc 模板 Content.xml 包内路径。
   * @returns Area；读取/解析失败时为 undefined。
   */
  private loadTemplateArea(loc: string): Promise<Box | undefined> {
    const cached = this.templateAreaCache.get(loc);
    if (cached) return cached;
    const promise = this.zip
      .readEntry(loc, { maxBytes: this.limits.maxXmlBytes, onWarning: this.documentWarningHandler })
      .then((bytes) => decodePageAreaXml(bytes, '').area)
      .catch(() => undefined);
    this.templateAreaCache.set(loc, promise);
    return promise;
  }

  /**
   * getPageInfos 进行中检查：close 优先于取消。
   *
   * @param signal 合并后的取消信号。
   * @throws OFDError OFD_CLOSED / OFD_ABORTED。
   */
  private assertInfoActive(signal: AbortSignal): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭');
    throwIfAborted(signal);
  }

  /**
   * 把 promise 加入 close 等待集合，并在完成后移除。
   *
   * @param run 进行中的异步任务。
   */
  private trackActiveRun<T>(run: Promise<T>): void {
    this.activeRuns.add(run);
    void run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.activeRuns.delete(run);
      });
  }

  /**
   * 读取文档大纲；打开阶段已解析并缓存，不加载页面内容。
   *
   * @param options 取消信号。
   * @returns 大纲树；无大纲返回空数组。
   * @throws OFDError OFD_CLOSED / OFD_ABORTED。
   */
  async getOutline(options: { signal?: AbortSignal } = {}): Promise<readonly OutlineNode[]> {
    this.assertOpen();
    throwIfAborted(options.signal);
    return this.document.outlines ?? [];
  }

  /**
   * 读取文档书签；打开阶段已解析并缓存，不加载页面内容。
   *
   * @param options 取消信号。
   * @returns 书签列表；无书签返回空数组。
   * @throws OFDError OFD_CLOSED / OFD_ABORTED。
   */
  async getBookmarks(options: { signal?: AbortSignal } = {}): Promise<readonly BookmarkItem[]> {
    this.assertOpen();
    throwIfAborted(options.signal);
    return this.document.bookmarks ?? [];
  }

  /**
   * 读取文档属性；打开阶段解析 OFD.xml/DocInfo 并缓存。
   *
   * @param options 取消信号。
   * @returns OFD 版本、页数、包大小与 DocInfo 字段。
   * @throws OFDError OFD_CLOSED / OFD_ABORTED。
   */
  async getMetadata(options: { signal?: AbortSignal } = {}): Promise<DocumentMetadata> {
    this.assertOpen();
    throwIfAborted(options.signal);
    return this.metadata;
  }

  /**
   * 读取签章 XML 元数据；按 Signatures.xml 顺序返回并缓存到 close。
   *
   * 只读取 Signatures.xml / Signature.xml；不读取 Seal.esl 或 SignedValue.dat，
   * 不解析 ASN.1/证书/签名值。单个 Signature.xml 损坏时 warning 后跳过。
   *
   * @param options 取消信号。
   * @returns 签章条目；无签章索引或索引损坏时为空数组。
   * @throws OFDError OFD_CLOSED / OFD_ABORTED。
   */
  async getSignatureEntries(
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly SignatureEntryInfo[]> {
    this.assertOpen();
    throwIfAborted(options.signal);
    const cached = this.signatureEntriesCache;
    if (cached) return cached;
    if (!this.signatureIndexPath) {
      this.signatureEntriesCache = [];
      return [];
    }
    let pending = this.signatureEntriesPending;
    if (!pending) {
      pending = this.loadSignatureEntries();
      this.signatureEntriesPending = pending;
      this.trackActiveRun(pending);
      void pending
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (this.signatureEntriesPending === pending) this.signatureEntriesPending = undefined;
        });
    }
    return waitForAbort(pending, options.signal);
  }

  /**
   * 读取 SignedValue.dat 原始字节；不解析内容、不读取 Seal.esl。
   *
   * 未声明 SignedValue 时返回 undefined 且不 warning；声明但读取失败时
   * warning W_SIGNATURE_RESOURCE 并返回 undefined。每次调用重新读取，不缓存大文件。
   *
   * @param signatureId 签章 ID。
   * @param options 取消信号。
   * @returns 原始字节与包内路径；未声明或读取失败时 undefined。
   * @throws OFDError OFD_CLOSED / OFD_ABORTED / OFD_LIMIT_EXCEEDED / OFD_INVALID_PACKAGE。
   */
  async getSignedValue(
    signatureId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SignedValueFile | undefined> {
    this.assertOpen();
    throwIfAborted(options.signal);
    const entries = await this.getSignatureEntries(options);
    this.assertOpen();
    throwIfAborted(options.signal);
    const normalizedId = normalizeResourceId(signatureId);
    const entry = entries.find((item) => item.id === normalizedId);
    if (!entry || !entry.hasSignedValue || !entry.signedValuePath) return undefined;
    const path = entry.signedValuePath;
    const combined = combineAbortSignals([options.signal, this.closeController.signal]);
    const run = (async (): Promise<SignedValueFile | undefined> => {
      try {
        throwIfAborted(combined.signal);
        let bytes: Uint8Array;
        try {
          bytes = await this.readSignatureFile(path);
        } catch (error) {
          if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭', { cause: error });
          if (combined.signal.aborted) throw createAbortError();
          if (
            isOFDError(error) &&
            (error.code === 'OFD_LIMIT_EXCEEDED' || error.code === 'OFD_INVALID_PACKAGE')
          ) {
            throw error;
          }
          this.documentWarningHandler({
            code: 'W_SIGNATURE_RESOURCE',
            message: `签章 ${entry.id} 的 SignedValue 读取失败：${path}（${errorMessage(error)}）`,
            resourceId: entry.id,
            objectId: entry.id,
          });
          return undefined;
        }
        if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭');
        throwIfAborted(combined.signal);
        return { signatureId: entry.id, path, data: bytes, byteLength: bytes.byteLength };
      } finally {
        combined.dispose();
      }
    })();
    this.trackActiveRun(run);
    return run;
  }

  /**
   * 关闭文档并释放全部缓存与句柄；可重复调用。
   *
   * 进行中的渲染/导出/页信息/准备会先被中止；`close()` 不向调用方抛错。
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
    this.signatureSealPromises.clear();
    for (const image of this.signatureSealImages) {
      const close = (image.data as { close?: () => void }).close;
      if (typeof close === 'function') {
        try {
          close.call(image.data);
        } catch {
          // 印章 ImageBitmap.close 失败不影响关闭流程。
        }
      }
    }
    this.signatureSealImages.clear();
    this.signatureBundlePromise = undefined;
    this.signatureEntriesCache = undefined;
    this.signatureEntriesPending = undefined;
    this.pageCache.clear();
    this.pagePending.clear();
    this.pageInfoCache.clear();
    this.pageInfoPending.clear();
    this.templateAreaCache.clear();
    this.preparedBundles.clear();
    this.preparePending.clear();
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
        const prepared = this.preparedBundles.get(pageIndex);
        const bundle =
          prepared && prepared.dpi === params.viewport.dpi
            ? prepared.bundle
            : await preparePage({
                page: entry.model,
                resources: entry.resources,
                loader: this.createLoader(combined.signal, pageIndex),
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
   * 导出整页图片（被 `OFDPage.exportImage` 调用）。
   *
   * 导出使用独立的离屏画布与页面渲染管线，不经过宿主主 Canvas；导出期间
   * 注册到 activeRuns，`close()` 会中止并等待本次导出结束。
   *
   * @param pageIndex 页索引。
   * @param pageSize 页尺寸，单位 mm。
   * @param options 导出参数。
   * @returns 编码后的图片结果。
   */
  private exportPage(
    pageIndex: number,
    pageSize: PageSize,
    options: PageImageExportOptions,
  ): Promise<PageImageResult> {
    this.assertOpen();
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const combined = combineAbortSignals([
      options?.signal,
      controller.signal,
      this.closeController.signal,
    ]);
    const run = (async (): Promise<PageImageResult> => {
      try {
        return await this.runExportPage(pageIndex, pageSize, options, combined.signal);
      } catch (error) {
        // close 与导出竞争时以 OFD_CLOSED 结束，不返回编码结果。
        if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭', { cause: error });
        throw error;
      } finally {
        combined.dispose();
        this.activeControllers.delete(controller);
      }
    })();
    this.activeRuns.add(run);
    void run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.activeRuns.delete(run);
    });
    return run;
  }

  /**
   * 执行整页导出：创建画布、填背景、渲染并编码。
   *
   * @param pageIndex 页索引。
   * @param pageSize 页尺寸，单位 mm。
   * @param options 导出参数。
   * @param signal 合并后的取消信号。
   * @returns 编码后的图片结果。
   */
  private async runExportPage(
    pageIndex: number,
    pageSize: PageSize,
    options: PageImageExportOptions,
    signal: AbortSignal,
  ): Promise<PageImageResult> {
    const exportOptions = options ?? {};
    const dpi = normalizeExportDpi(exportOptions.dpi);
    const format = normalizeExportFormat(exportOptions.format);
    const quality = normalizeExportQuality(exportOptions.quality, format);
    const viewport = getPageViewport(pageSize, { dpi });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    if (this.limits.maxCanvasPixels > 0 && width * height > this.limits.maxCanvasPixels) {
      throw new OFDError(
        'OFD_CANVAS_TOO_LARGE',
        `导出画布 ${width}×${height} 超过画布像素上限 ${this.limits.maxCanvasPixels}`,
      );
    }
    this.assertExportActive(signal);

    let entry: { canvas: Canvas2DLike; context: CanvasRenderingContext2DLike };
    try {
      const factory = new H5CanvasFactory(
        this.exportCanvas ? { createCanvas: this.exportCanvas } : {},
      );
      entry = factory.create(width, height);
    } catch (error) {
      throw wrapError(error, 'OFD_RENDERER_UNSUPPORTED', '页面图片导出创建画布失败');
    }
    const { canvas, context } = entry;
    if (canvas.width !== width || canvas.height !== height) {
      throw new OFDError(
        'OFD_CANVAS_SIZE_MISMATCH',
        `导出画布尺寸 ${canvas.width}×${canvas.height} 与请求 ${width}×${height} 不符`,
      );
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, width, height);
    const background = resolveExportBackground(context, exportOptions.background, format);
    if (background !== null) {
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
    }
    this.assertExportActive(signal);

    await this.renderPage(
      pageIndex,
      {
        canvasContext: context,
        viewport: { width: viewport.width, height: viewport.height, dpi },
        signal,
      },
      signal,
    );
    this.assertExportActive(signal);

    const data = await this.encodeExportCanvas(canvas, format, quality);
    this.assertExportActive(signal);
    return {
      data,
      mime: mimeOfPageImageFormat(format),
      width,
      height,
      dpi,
    };
  }

  /**
   * 编码整页画布：优先取文档级 encodeImage，其次浏览器 Canvas 原生入口。
   *
   * @param canvas 已绘制的整页画布。
   * @param format 输出格式。
   * @param quality 规范化后的质量；PNG 固定为 1。
   * @returns 非空编码字节。
   */
  private async encodeExportCanvas(
    canvas: Canvas2DLike,
    format: PageImageFormat,
    quality: number,
  ): Promise<Uint8Array> {
    const source = canvas as CanvasImageEncodeSource;
    const mime = mimeOfPageImageFormat(format);
    if (this.encodeImage) {
      try {
        return ensureEncodedBytes(
          await this.encodeImage(source, format, quality),
          'encodeImage 返回无效图片',
        );
      } catch (error) {
        throw encodeExportError('页面图片编码失败', error);
      }
    }
    if (typeof source.convertToBlob === 'function') {
      try {
        const blob = await source.convertToBlob({ type: mime, quality });
        return await blobToBytes(blob);
      } catch (error) {
        throw encodeExportError('convertToBlob 编码失败', error);
      }
    }
    if (typeof source.toBlob === 'function') {
      try {
        const blob = await new Promise<Blob | null>((resolve, reject) => {
          try {
            source.toBlob!((value) => resolve(value), mime, quality);
          } catch (error) {
            reject(error);
          }
        });
        return await blobToBytes(blob);
      } catch (error) {
        throw encodeExportError('toBlob 编码失败', error);
      }
    }
    throw encodeExportError('页面图片导出缺少编码器：请注入 OFDOpenOptions.encodeImage');
  }

  /**
   * 断言导出仍可继续；close 优先于取消上报 OFD_CLOSED。
   *
   * @param signal 合并后的取消信号。
   * @throws OFDError OFD_CLOSED / OFD_ABORTED。
   */
  private assertExportActive(signal: AbortSignal): void {
    if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭');
    throwIfAborted(signal);
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
   * @param pageIndex 当前页索引，用于签章按页过滤。
   * @returns loader 实现；无 Signatures.xml 时不注册签章方法，避免额外调用。
   */
  private createLoader(signal: AbortSignal, pageIndex: number): PreparePageLoader {
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
      ...(this.signatureIndexPath && this.signatureLoading
        ? {
            loadSignatureStamps: async (page: PageModel) => {
              throwIfAborted(signal);
              void page;
              return this.loadSignatureStamps(pageIndex);
            },
            decodeSeal: async (seal: SealImage) => {
              throwIfAborted(signal);
              return this.decodeSeal(seal);
            },
          }
        : {}),
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
    if (!annotationFile && this.annotationsIndexError) {
      pageWarning({
        code: 'W_ANNOT_EMPTY',
        message: `注释索引 ${this.annotationsIndexError} 读取失败，本页注释已跳过`,
      });
    }

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
   * 加载公开签章 XML 条目；只读 XML，不触发 Seal/SignedValue 解码。
   *
   * 索引读取失败时 warning 后返回空；单条 Signature.xml 失败时跳过该条。
   * 结果在成功时写入 `signatureEntriesCache`，由 close 清理。
   *
   * @returns 按 Signatures.xml 顺序的签章条目。
   * @throws OFDError OFD_CLOSED。
   */
  private async loadSignatureEntries(): Promise<readonly SignatureEntryInfo[]> {
    const indexFilePath = this.signatureIndexPath;
    if (!indexFilePath) return [];
    this.assertOpen();
    let indexRoot: XmlNode;
    try {
      indexRoot = await this.readXml(indexFilePath, this.documentWarningHandler);
    } catch (error) {
      if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭', { cause: error });
      this.documentWarningHandler({
        code: 'W_BAD_NUMBER',
        message: `签章索引 ${indexFilePath} 加载失败：${errorMessage(error)}`,
        objectId: indexFilePath,
      });
      this.signatureEntriesCache = [];
      return [];
    }
    this.assertOpen();
    const entries = decodeSignaturesIndex(indexRoot, indexFilePath, {
      onWarning: this.documentWarningHandler,
    });
    const pageIds = this.document.pages.map((page) => page.id);
    const result: SignatureEntryInfo[] = [];
    for (const entry of entries) {
      this.assertOpen();
      let model: SignatureModel;
      try {
        const bytes = await this.readSignatureFile(entry.baseLoc);
        this.assertOpen();
        model = decodeSignature(parseXml(bytes), entry.baseLoc, {
          id: entry.id,
          type: entry.type,
          pageIds,
          onWarning: this.documentWarningHandler,
        });
      } catch (error) {
        if (this.closed) throw new OFDError('OFD_CLOSED', '文档已关闭', { cause: error });
        this.documentWarningHandler({
          code: 'W_BAD_NUMBER',
          message: `Signature ${entry.id} 读取/解析失败：${errorMessage(error)}`,
          objectId: entry.id,
          resourceId: entry.id,
        });
        continue;
      }
      const stamps: SignatureStampInfo[] = model.stamps.map((stamp) => {
        const info: SignatureStampInfo = {
          pageId: stamp.pageId,
          boundary: { ...stamp.boundary },
        };
        if (stamp.id !== undefined) info.id = stamp.id;
        if (stamp.pageIndex !== undefined) info.pageIndex = stamp.pageIndex;
        if (stamp.clip) info.clip = { ...stamp.clip };
        return info;
      });
      const info: SignatureEntryInfo = {
        id: model.id,
        type: model.type,
        baseLoc: model.baseLoc,
        references: model.references.map((reference) => ({ fileRef: reference.fileRef })),
        stamps,
        hasSignedValue: model.hasSignedValue,
      };
      if (model.provider) info.provider = { ...model.provider };
      if (model.signatureDateTime !== undefined) info.signatureDateTime = model.signatureDateTime;
      if (model.signedValuePath !== undefined) info.signedValuePath = model.signedValuePath;
      result.push(info);
    }
    this.signatureEntriesCache = result;
    return result;
  }

  /**
   * 加载文档签章集合；按文档缓存，无 Signatures.xml 时返回 undefined。
   *
   * 索引/Signature 损坏只 warning 并返回 undefined，不阻断页面打开或渲染。
   *
   * @returns 签章集合；无签章或加载失败时为 undefined。
   */
  private getSignatureBundle(): Promise<SignatureBundle | undefined> {
    if (!this.signatureIndexPath || !this.signatureLoading) return Promise.resolve(undefined);
    if (this.signatureBundlePromise) return this.signatureBundlePromise;
    const indexFilePath = this.signatureIndexPath;
    const pageIds = this.document.pages.map((ref) => ref.id);
    const promise = (async (): Promise<SignatureBundle> => {
      const root = await this.readXml(indexFilePath, this.documentWarningHandler);
      return decodeSignatureBundle(
        {
          index: root,
          indexFilePath,
          pageIds,
          readFile: (path) => this.readSignatureFile(path),
        },
        { onWarning: this.documentWarningHandler, pageIds },
      );
    })().catch((error: unknown) => {
      this.documentWarningHandler({
        code: 'W_BAD_NUMBER',
        message: `签章索引 ${indexFilePath} 加载失败：${errorMessage(error)}`,
      });
      return undefined;
    });
    this.signatureBundlePromise = promise;
    return promise;
  }

  /**
   * 读取签章相关条目：Signature.xml 受 XML 上限约束，Seal.esl 受条目上限约束。
   *
   * @param path 包内路径。
   * @returns 条目字节。
   */
  private readSignatureFile(path: string): Promise<Uint8Array> {
    const maxBytes = /\.xml$/i.test(path) ? this.limits.maxXmlBytes : this.limits.maxEntryBytes;
    return this.zip.readEntry(path, {
      maxBytes,
      onWarning: this.documentWarningHandler,
    });
  }

  /**
   * 取当前页的签章戳记与 Seal 元数据。
   *
   * 只读取已缓存的文档签章集合，不重复解析 XML/Seal.esl。
   *
   * @param pageIndex 页索引。
   * @returns 当前页签章戳记；无签章时为 []。
   */
  private async loadSignatureStamps(pageIndex: number): Promise<readonly SignatureStampSource[]> {
    const bundle = await this.getSignatureBundle();
    if (!bundle) return [];
    const result: SignatureStampSource[] = [];
    for (const signature of bundle.signatures) {
      for (const stamp of signature.stamps) {
        if (stamp.pageIndex !== pageIndex) continue;
        result.push({
          signatureId: signature.id,
          stamp,
          ...(signature.seal ? { seal: signature.seal } : {}),
        });
      }
    }
    return result;
  }

  /**
   * 解码 Seal.esl/SignedValue 中的印章：位图走图片解码，type=ofd 的内嵌 ZIP
   * 作为独立 OFD 渲染首页到离屏 canvas；按 SealImage 实例缓存。
   *
   * @param seal Seal 图片元数据。
   * @returns 解码后的图片；矢量章为 canvas source。
   * @throws OFDError 无可用解码器/像素超限/矢量 ZIP 无效/渲染失败时。
   */
  private decodeSeal(seal: SealImage): Promise<DecodedImage> {
    const cacheKey = seal.cacheKey ?? seal;
    const cached = this.signatureSealPromises.get(cacheKey);
    if (cached) return cached;
    const format = normalizeSealFormat(seal.type) || detectImageFormat(seal.data, 'Seal.esl');
    const promise = (format === 'ofd' || isZipData(seal.data)
      ? this.decodeVectorSeal(seal)
      : this.decodeImageBytes(seal.data, format)
    )
      .then((decoded) => {
        this.signatureSealImages.add(decoded);
        return decoded;
      })
      .catch((error: unknown) => {
        this.signatureSealPromises.delete(cacheKey);
        throw error;
      });
    this.signatureSealPromises.set(cacheKey, promise);
    return promise;
  }

  /**
   * 把 type=ofd 的内嵌 ZIP 作为独立 OFD 打开，渲染首页到离屏 canvas。
   *
   * 嵌套文档关闭签章加载，保证矢量章内部不再递归解析签章；使用独立 H5
   * 渲染器与画布，不污染父页 Canvas 状态。
   *
   * @param seal 矢量印章元数据；data 为内嵌 OFD ZIP。
   * @returns 首页渲染结果，宽度/高度单位为像素。
   * @throws OFDError ZIP/OFD 无效、无页面或画布不可用时。
   */
  private async decodeVectorSeal(seal: SealImage): Promise<DecodedImage> {
    if (!isZipData(seal.data)) {
      throw new OFDError('OFD_INVALID_PACKAGE', '矢量印章 picture.type=ofd 但数据不是 ZIP');
    }
    const nested = await OFDDocument.open({
      source: { kind: 'arraybuffer', data: seal.data },
      renderer: new H5Canvas2DRenderer(
        this.createCanvas ? { createCanvas: this.createCanvas } : undefined,
      ),
      ...(this.createCanvas ? { createCanvas: this.createCanvas } : {}),
      imageDecoders: [...this.imageDecoders],
      limits: this.limits,
      onWarning: this.documentWarningHandler,
      ...(this.fontProvider ? { fontProvider: this.fontProvider } : {}),
      ...(this.supplementaryFonts ? { supplementaryFonts: [...this.supplementaryFonts] } : {}),
    });
    nested.disableSignatureLoading();
    try {
      if (nested.pageCount < 1) {
        throw new OFDError('OFD_INVALID_PACKAGE', '矢量印章 OFD 没有页面');
      }
      const page = await nested.getPage(0);
      let dpi = VECTOR_SEAL_DPI;
      let width = 1;
      let height = 1;
      const pixelLimit = this.vectorSealPixelLimit();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const viewport = page.getViewport({ dpi });
        width = Math.max(1, Math.ceil(viewport.width));
        height = Math.max(1, Math.ceil(viewport.height));
        if (pixelLimit <= 0 || width * height <= pixelLimit) break;
        dpi *= Math.sqrt(pixelLimit / (width * height)) * 0.999;
      }
      if (pixelLimit > 0 && width * height > pixelLimit) {
        throw new OFDError(
          'OFD_LIMIT_EXCEEDED',
          `矢量印章 ${width}×${height} 超过像素上限 ${pixelLimit}`,
        );
      }
      const factory = new H5CanvasFactory(
        this.createCanvas ? { createCanvas: this.createCanvas } : {},
      );
      const { canvas, context } = factory.create(width, height);
      context.clearRect(0, 0, width, height);
      await page.render({
        canvasContext: context,
        viewport: { width, height, dpi },
      }).promise;
      return { width, height, data: canvas, kind: 'source' };
    } finally {
      await nested.close();
    }
  }

  /**
   * 矢量印章可用像素上限：同时受图片上限与嵌套页面画布上限约束。
   *
   * @returns 最大像素数；0 表示不限制。
   */
  private vectorSealPixelLimit(): number {
    const limits = [this.limits.maxImagePixels, this.limits.maxCanvasPixels].filter(
      (value) => value > 0,
    );
    return limits.length > 0 ? Math.min(...limits) : 0;
  }

  /** 关闭当前文档的签章加载，供矢量章嵌套文档防止递归。 */
  private disableSignatureLoading(): void {
    this.signatureLoading = false;
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
 * UI API 类型声明合并。
 *
 * 方法实现由后续任务落到 `OFDDocument`；本任务只冻结签名，不改变现有行为。
 */
export interface OFDDocument extends OFDDocumentApi {}

/**
 * 规范化 getPageInfos 的 start；负数返回 -1 表示空结果。
 *
 * @param start 原始起始页索引，从 0 开始。
 * @param pageCount 总页数。
 * @returns 可用的起始索引；-1 表示越界。
 */
function normalizeInfoStart(start: number | undefined, pageCount: number): number {
  if (start === undefined || !Number.isFinite(start)) return 0;
  const value = Math.trunc(start);
  if (value < 0) return -1;
  return Math.min(value, pageCount);
}

/**
 * 规范化 getPageInfos 的 count；默认剩余全部，非法/负数按 0 处理。
 *
 * @param count 原始返回页数。
 * @param remaining 从 start 到文档末尾的剩余页数。
 * @returns 实际请求页数。
 */
function normalizeInfoCount(count: number | undefined, remaining: number): number {
  if (remaining <= 0) return 0;
  if (count === undefined || !Number.isFinite(count)) return remaining;
  return Math.min(Math.max(0, Math.trunc(count)), remaining);
}

/**
 * 等待 promise，同时让单个调用方的 signal 只影响本次等待。
 *
 * @param promise 共享准备流程。
 * @param signal 调用方取消信号。
 * @returns promise 结果。
 * @throws OFDError signal 中止时 OFD_ABORTED。
 */
function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError(signal.reason));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * 把模型 DocInfo 映射为公共 DocumentMetadata 的可选字段。
 *
 * @param info 已解码 DocInfo；无 DocInfo 时为 undefined。
 * @returns 仅包含存在字段的对象。
 */
function metadataFromDocInfo(info: DocInfo | undefined): Partial<DocumentMetadata> {
  if (!info) return {};
  const result: Partial<DocumentMetadata> = {};
  if (info.title) result.title = info.title;
  if (info.author) result.author = info.author;
  if (info.subject) result.subject = info.subject;
  if (info.abstract) result.abstract = info.abstract;
  if (info.creationDate) result.creationDate = info.creationDate;
  if (info.modDate) result.modDate = info.modDate;
  if (info.creator) result.creator = info.creator;
  if (info.creatorVersion) result.creatorVersion = info.creatorVersion;
  if (info.keywords) result.keywords = info.keywords;
  if (info.docId) result.docId = info.docId;
  if (info.customData) result.customData = info.customData;
  return result;
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

/** 规范化导出 DPI；非有限或 <=0 回退 96。 */
function normalizeExportDpi(dpi: number | undefined): number {
  return dpi !== undefined && Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_EXPORT_DPI;
}

/** 规范化导出格式；缺省 png，未知格式报不支持。 */
function normalizeExportFormat(format: PageImageFormat | undefined): PageImageFormat {
  if (format === undefined) return 'png';
  if (format === 'png' || format === 'jpeg' || format === 'webp') return format;
  throw new OFDError('OFD_RENDERER_UNSUPPORTED', `不支持的页面图片格式：${String(format)}`);
}

/** 规范化 JPEG/WebP 质量；非法值回退 0.92 并夹取到 0..1，PNG 固定 1。 */
function normalizeExportQuality(
  quality: number | undefined,
  format: PageImageFormat,
): number {
  if (format === 'png') return 1;
  if (quality === undefined || !Number.isFinite(quality)) return DEFAULT_EXPORT_QUALITY;
  return Math.min(1, Math.max(0, quality));
}

/** 页面图片格式对应的 MIME。 */
function mimeOfPageImageFormat(format: PageImageFormat): PageImageMime {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
  }
}

/**
 * 解析导出背景：默认白底；PNG null 透明，JPEG/WebP null 视为白底。
 *
 * @param context 导出画布上下文，用于 CSS 颜色有效性探测。
 * @param background 请求的背景色。
 * @param format 输出格式。
 * @returns CSS 颜色字符串；null 表示保持透明。
 */
function resolveExportBackground(
  context: CanvasRenderingContext2DLike,
  background: string | null | undefined,
  format: PageImageFormat,
): string | null {
  if (background === null) return format === 'png' ? null : '#ffffff';
  if (typeof background !== 'string' || background.trim() === '') return '#ffffff';
  return isCssColor(context, background) ? background : '#ffffff';
}

/**
 * 探测 Canvas 是否接受某个 CSS 颜色；避免无效值沿用旧 fillStyle。
 *
 * Canvas 对非法 fillStyle 赋值会保留旧值；用两个哨兵颜色可区分“非法”与
 * “颜色本身恰好等于哨兵”。
 */
function isCssColor(context: CanvasRenderingContext2DLike, value: string): boolean {
  const first = '#010203';
  const second = '#040506';
  try {
    context.fillStyle = first;
    context.fillStyle = value;
    if (normalizeFillStyle(context.fillStyle) !== first) return true;
    context.fillStyle = second;
    context.fillStyle = value;
    return normalizeFillStyle(context.fillStyle) !== second;
  } catch {
    return false;
  }
}

/** 归一化 fillStyle 的字符串形式；非字符串返回空串。 */
function normalizeFillStyle(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 校验编码器结果为非空 Uint8Array。 */
function ensureEncodedBytes(value: unknown, message: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new OFDError('OFD_RENDERER_UNSUPPORTED', message);
  }
  return value;
}

/** 读取 Blob 字节；非 Blob 或空结果统一报不支持。 */
async function blobToBytes(blob: Blob | null): Promise<Uint8Array> {
  if (!blob || typeof (blob as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
    throw new OFDError('OFD_RENDERER_UNSUPPORTED', '编码器未返回有效 Blob');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return ensureEncodedBytes(bytes, '编码器返回空图片');
}

/** 构造编码阶段错误；保留原始 cause。 */
function encodeExportError(message: string, cause?: unknown): OFDError {
  if (cause === undefined) return new OFDError('OFD_RENDERER_UNSUPPORTED', message);
  return new OFDError('OFD_RENDERER_UNSUPPORTED', `${message}：${errorMessage(cause)}`, { cause });
}

/**
 * 从显式 H5 渲染器提取 createCanvas，兼容 t56 之前只传 renderer 的宿主。
 *
 * @param renderer 宿主渲染器。
 * @returns 画布工厂；非 H5 或未注入时 undefined。
 */
function createCanvasFromRenderer(
  renderer: Renderer,
): ((width: number, height: number) => Canvas2DLike) | undefined {
  if (!(renderer instanceof H5Canvas2DRenderer)) return undefined;
  const options = (
    renderer as unknown as {
      options?: { createCanvas?: (width: number, height: number) => Canvas2DLike };
    }
  ).options;
  return options?.createCanvas;
}

/** 判断字节是否为 ZIP 头（PK\x03\x04 / PK\x05\x06 / PK\x07\x08）。 */
function isZipData(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;
}

/**
 * 归一化 Seal.esl 中记录的图片格式名。
 *
 * @param type Seal 图片格式（例如 PNG/JPG）。
 * @returns 引擎图片格式名；空值原样返回。
 */
function normalizeSealFormat(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpe') return 'jpeg';
  if (normalized === 'tif') return 'tiff';
  return normalized;
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