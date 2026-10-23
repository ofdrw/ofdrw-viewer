/**
 * 文档控制器（设计方案 §3.2 / §6.1）。
 *
 * 负责 `ViewerSource` 规范化、引擎 `OFDDocument` 打开/关闭、页信息与侧栏数据的
 * 按需加载、并发去重与关闭清理。它不排版、不渲染、不访问页面 DOM。
 *
 * 该模块保留一个可注入的 `openDocument` 工厂：生产环境使用引擎，测试可注入
 * 结构等价的内存文档，避免 jsdom 中依赖真实 canvas。
 */

import { OFDDocument } from '@ofdrw/ofdrw-viewer-engine';
import type {
  BookmarkItem,
  DocumentMetadata,
  DocumentPermissions,
  OFDOpenOptions,
  OFDSource,
  OutlineNode,
  PageImageExportOptions,
  PageImageResult,
  PageInfo,
  PageInfoOptions,
  PageRenderParameters,
  SignatureEntryInfo,
  SignedValueFile,
  TextContent,
  TextContentOptions,
  Viewport,
  VirtualContainer,
} from '@ofdrw/ofdrw-viewer-engine';
import type { ViewerWarning } from './state';
import type { ViewerSource } from './types';
import type { ViewerOrigin } from './state';
import { OFDViewerError } from './errors';
import { HttpByteSource } from './source/http-byte-source';

/** 引擎渲染任务的最小结构。 */
export interface EngineRenderTaskLike {
  /** 完成/失败 promise。 */
  readonly promise: Promise<void>;
  /** 取消渲染。 */
  cancel(): void;
}

/** 引擎页面的最小结构；`OFDPage` 结构兼容。 */
export interface EnginePage {
  /** 页索引，0-based。 */
  readonly index: number;
  /** 页尺寸，单位 mm。 */
  getSize(): { width: number; height: number };
  /** 指定 DPI 的像素尺寸。 */
  getViewport(options?: { dpi?: number }): Viewport;
  /** 渲染到宿主上下文。 */
  render(params: PageRenderParameters): EngineRenderTaskLike;
  /** 读取文本层内容；不存在时由引擎报不支持。 */
  getTextContent?(options?: TextContentOptions): Promise<TextContent>;
  /** 预取页面资源。 */
  prepare?(options?: { signal?: AbortSignal }): Promise<void>;
  /** 导出整页图片。 */
  exportImage?(options?: PageImageExportOptions): Promise<PageImageResult>;
}

/** 引擎文档的最小结构；`OFDDocument` 结构兼容。 */
export interface EngineDocument {
  /** 总页数。 */
  readonly pageCount: number;
  /** 批量页尺寸。 */
  getPageInfos(options?: PageInfoOptions): Promise<readonly PageInfo[]>;
  /** 按需加载页面。 */
  getPage(pageIndex: number): Promise<EnginePage>;
  /** 大纲。 */
  getOutline(options?: { signal?: AbortSignal }): Promise<readonly OutlineNode[]>;
  /** 书签。 */
  getBookmarks(options?: { signal?: AbortSignal }): Promise<readonly BookmarkItem[]>;
  /** 文档属性。 */
  getMetadata(options?: { signal?: AbortSignal }): Promise<DocumentMetadata>;
  /** 文档权限声明。 */
  getPermissions(options?: { signal?: AbortSignal }): Promise<DocumentPermissions>;
  /** 签章 XML 摘要。 */
  getSignatureEntries(
    options?: { signal?: AbortSignal },
  ): Promise<readonly SignatureEntryInfo[]>;
  /** `SignedValue.dat` 原始字节。 */
  getSignedValue(
    signatureId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SignedValueFile | undefined>;
  /** 关闭并释放缓存。 */
  close(): Promise<void>;
}

/** 打开后的基础信息。 */
export interface OpenedDocumentInfo {
  /** 引擎文档。 */
  readonly document: EngineDocument;
  /** 规范化后的引擎来源。 */
  readonly source: OFDSource;
  /** 总页数。 */
  readonly pageCount: number;
}

/** 文档控制器选项。 */
export interface DocumentControllerOptions {
  /** 引擎打开工厂；默认 `OFDDocument.open`。 */
  readonly openDocument?: (options: OFDOpenOptions) => Promise<EngineDocument>;
  /** URL 来源的额外请求参数；headers 会与来源 headers 合并。 */
  readonly requestInit?: RequestInit;
  /** 引擎 warning 回调。 */
  readonly onWarning?: (warning: ViewerWarning) => void;
}

/** 规范化后的来源与原始来源信息。 */
export interface NormalizedViewerSource {
  /** 可直接交给 engine 的来源；URL 已转成 `custom` 字节源。 */
  readonly source: OFDSource;
  /** 原始 URL/文件信息；用于标题与导出命名。 */
  readonly origin?: ViewerOrigin;
  /** 本次为 URL 新建的字节源；由调用方决定关闭归属。 */
  readonly httpSource?: HttpByteSource;
}

/** 来源规范化上下文。 */
export interface NormalizeViewerSourceContext {
  /** 取消信号；传入后由 HTTP 字节源共享。 */
  readonly signal?: AbortSignal;
  /** 整包下载进度回调。 */
  readonly onProgress?: (loaded: number, total: number | undefined) => void;
}

/**
 * 把宿主来源规范化为引擎 `OFDSource`，并保留原始来源信息。
 *
 * 字符串与 `{ url, headers }` 转为 `{ kind: 'custom' }`（`HttpByteSource`），
 * 不再产生 engine 已删除的 `url` 来源；`ArrayBuffer`/`Uint8Array`/`Blob` 原样返回。
 * 请求头合并顺序为 `requestInit.headers` → 来源 headers（来源优先）。
 *
 * @param source 宿主来源。
 * @param requestInit 额外请求参数；只使用 `headers` 与来源合并。
 * @param context 取消信号与整包进度回调。
 * @returns 规范化来源；URL/File 同时返回 origin。
 * @throws {OFDViewerError} 来源类型非法或为空。
 */
export function normalizeViewerSourceDetailed(
  source: ViewerSource,
  requestInit?: RequestInit,
  context: NormalizeViewerSourceContext = {},
): NormalizedViewerSource {
  const sourceHeaders =
    typeof source === 'object' &&
    source !== null &&
    !(source instanceof ArrayBuffer) &&
    !(source instanceof Uint8Array) &&
    !(typeof Blob !== 'undefined' && source instanceof Blob)
      ? (source as { headers?: Record<string, string> }).headers
      : undefined;
  // 来源对象自带的 headers 覆盖 requestInit.headers（后者是全局默认值）。
  const headers = mergeHeaders(requestInit?.headers, sourceHeaders);
  if (typeof source === 'string') {
    if (!source.trim()) {
      throw new OFDViewerError('OFD_INVALID_OPTION', 'source URL 不能为空');
    }
    return createUrlSource(source, headers, context);
  }
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    if (source.byteLength === 0) {
      throw new OFDViewerError('OFD_INVALID_OPTION', 'source 字节为空');
    }
    return { source: { kind: 'arraybuffer', data: source } };
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    if (source.size === 0) {
      throw new OFDViewerError('OFD_INVALID_OPTION', 'source Blob 为空');
    }
    const isFile = typeof File !== 'undefined' && source instanceof File;
    return {
      source: { kind: 'blob', blob: source },
      origin: isFile ? { kind: 'file', name: source.name } : { kind: 'blob' },
    };
  }
  if (isUrlSource(source)) {
    if (!source.url.trim()) {
      throw new OFDViewerError('OFD_INVALID_OPTION', 'source.url 不能为空');
    }
    return createUrlSource(source.url, headers, context);
  }
  throw new OFDViewerError(
    'OFD_INVALID_OPTION',
    'source 必须是 ArrayBuffer、Uint8Array、Blob/File、URL 字符串或 { url, headers }',
  );
}

/**
 * 把宿主来源规范化为引擎 `OFDSource`。
 *
 * 保留该入口供内部复用；URL 同样转为 `custom` 字节源。需要 origin 时使用
 * `normalizeViewerSourceDetailed()`。
 *
 * @param source 宿主来源。
 * @param requestInit 额外请求参数。
 * @param context 取消信号与整包进度回调。
 * @returns 引擎来源。
 * @throws {OFDViewerError} 来源类型非法或为空。
 */
export function normalizeViewerSource(
  source: ViewerSource,
  requestInit?: RequestInit,
  context: NormalizeViewerSourceContext = {},
): OFDSource {
  return normalizeViewerSourceDetailed(source, requestInit, context).source;
}

/**
 * 创建 URL 来源：一次性构造 `HttpByteSource` 并保留 URL 供命名。
 *
 * @param url 文档 URL。
 * @param headers 合并后的请求头。
 * @param context 取消信号与进度回调。
 * @returns 规范化来源。
 */
function createUrlSource(
  url: string,
  headers: Record<string, string> | undefined,
  context: NormalizeViewerSourceContext,
): NormalizedViewerSource {
  const httpSource = new HttpByteSource(url, {
    ...(headers ? { headers } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.onProgress ? { onProgress: context.onProgress } : {}),
  });
  return {
    source: { kind: 'custom', source: httpSource },
    origin: { kind: 'url', url },
    httpSource,
  };
}

/**
 * 判断值是否为 `{ url, headers? }` 形式。
 *
 * @param value 待判断值。
 * @returns 匹配时 true。
 */
function isUrlSource(value: unknown): value is { url: string; headers?: Record<string, string> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { url?: unknown }).url === 'string'
  );
}

/**
 * 合并请求头。
 *
 * @param base 基础头。
 * @param extra 覆盖头。
 * @returns 合并后的普通对象；都为空时 undefined。
 */
function mergeHeaders(
  base: HeadersInit | undefined,
  extra: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!base && !extra) return undefined;
  const merged: Record<string, string> = {};
  for (const source of [base, extra]) {
    if (!source) continue;
    if (typeof Headers !== 'undefined' && source instanceof Headers) {
      source.forEach((value, key) => {
        merged[key] = value;
      });
    } else if (Array.isArray(source)) {
      for (const [key, value] of source) merged[key] = value;
    } else {
      Object.assign(merged, source);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 判断错误是否为取消。 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'OFD_ABORTED';
}

/** 创建打开取消错误。 */
function createOpenAbortError(): Error {
  const error = new Error('打开文档已取消');
  error.name = 'AbortError';
  return error;
}

/** 文档控制器。 */
export class DocumentController {
  private readonly options: DocumentControllerOptions;
  private doc: EngineDocument | null = null;
  private docSource: OFDSource | null = null;
  private openToken = 0;
  private pageInfosPromise: Promise<readonly PageInfo[]> | null = null;
  private readonly pagePromises = new Map<number, Promise<EnginePage>>();
  private outlinePromise: Promise<readonly OutlineNode[]> | null = null;
  private bookmarksPromise: Promise<readonly BookmarkItem[]> | null = null;
  private metadataPromise: Promise<DocumentMetadata> | null = null;
  private permissionsPromise: Promise<DocumentPermissions> | null = null;
  private signatureEntriesPromise: Promise<readonly SignatureEntryInfo[]> | null = null;

  /**
   * @param options 打开工厂、请求参数与 warning 回调。
   */
  constructor(options: DocumentControllerOptions = {}) {
    this.options = options;
  }

  /** 当前引擎文档；未打开为 null。 */
  get document(): EngineDocument | null {
    return this.doc;
  }

  /** 当前规范化来源；未打开为 null。 */
  get source(): OFDSource | null {
    return this.docSource;
  }

  /** 是否已打开。 */
  get isOpen(): boolean {
    return this.doc !== null;
  }

  /** 页数；未打开为 0。 */
  get pageCount(): number {
    return this.doc?.pageCount ?? 0;
  }

  /**
   * 打开文档；会先关闭旧文档。
   *
   * URL 来源只在此规范化一次；需要 origin 或自行管理字节源时改用
   * `openNormalized()`。
   *
   * @param source 宿主来源。
   * @param signal 取消信号；传给引擎打开流程与 HTTP 字节源。
   * @returns 打开结果。
   * @throws {OFDViewerError|Error} 来源非法、引擎打开失败或打开被取消（AbortError）。
   */
  async open(source: ViewerSource, signal?: AbortSignal): Promise<OpenedDocumentInfo> {
    const normalized = normalizeViewerSourceDetailed(source, this.options.requestInit, {
      ...(signal ? { signal } : {}),
    });
    return this.openNormalized(normalized, signal);
  }

  /**
   * 打开已规范化的来源；不再二次规范化或新建字节源。
   *
   * @param normalized 规范化来源。
   * @param signal 取消信号；传给引擎打开流程。
   * @returns 打开结果。
   * @throws {OFDViewerError|Error} 引擎打开失败或打开被取消（AbortError）。
   */
  async openNormalized(
    normalized: NormalizedViewerSource,
    signal?: AbortSignal,
  ): Promise<OpenedDocumentInfo> {
    return this.openWithOptions(normalized.source, { source: normalized.source }, signal);
  }

  /**
   * 用外部明文容器打开文档；容器所有权仍归调用方，引擎借用不关闭。
   *
   * @param container 明文虚拟容器。
   * @param source 原始来源；仅用于状态展示与诊断。
   * @param signal 取消信号。
   * @returns 打开结果。
   * @throws {OFDViewerError|Error} 引擎打开失败或打开被取消（AbortError）。
   */
  async openContainer(
    container: VirtualContainer,
    source: ViewerSource,
    signal?: AbortSignal,
  ): Promise<OpenedDocumentInfo> {
    const normalized = normalizeViewerSourceDetailed(source, this.options.requestInit, {
      ...(signal ? { signal } : {}),
    });
    return this.openContainerNormalized(container, normalized, signal);
  }

  /**
   * 用已规范化的来源与外部明文容器打开；不会为 URL 再建字节源。
   *
   * @param container 明文虚拟容器。
   * @param normalized 已规范化的来源。
   * @param signal 取消信号。
   * @returns 打开结果。
   * @throws {OFDViewerError|Error} 引擎打开失败或打开被取消（AbortError）。
   */
  async openContainerNormalized(
    container: VirtualContainer,
    normalized: NormalizedViewerSource,
    signal?: AbortSignal,
  ): Promise<OpenedDocumentInfo> {
    // engine 要求 source 必填，但提供 container 时只把 source 作为宿主上下文。
    return this.openWithOptions(
      normalized.source,
      { source: normalized.source, container },
      signal,
    );
  }

  /**
   * 统一打开流程：关闭旧文档、代次校验与结果组装。
   *
   * 内部不再创建独立 AbortController：外部 signal 直接传给引擎，`close()` 通过
   * 递增代次使迟到的打开结果失效并关闭。
   *
   * @param normalized 规范化来源。
   * @param extra 引擎打开参数补丁（`source` 或 `container`）。
   * @param signal 外部取消信号。
   * @returns 打开结果。
   */
  private async openWithOptions(
    normalized: OFDSource,
    extra: { readonly source: OFDSource; readonly container?: VirtualContainer },
    signal?: AbortSignal,
  ): Promise<OpenedDocumentInfo> {
    await this.closeInternal();
    // closeInternal 会递增 openToken；打开代次必须在关闭之后捕获。
    const token = ++this.openToken;
    if (signal?.aborted) throw createOpenAbortError();
    const openDocument =
      this.options.openDocument ??
      ((options: OFDOpenOptions) =>
        OFDDocument.open(options) as unknown as Promise<EngineDocument>);
    const document = await openDocument({
      ...extra,
      ...(this.options.onWarning ? { onWarning: this.options.onWarning } : {}),
      ...(signal ? { signal } : {}),
    });
    if (token !== this.openToken || signal?.aborted) {
      try {
        await document.close();
      } catch {
        // 过期文档关闭失败不影响调用方。
      }
      throw createOpenAbortError();
    }
    this.doc = document;
    this.docSource = normalized;
    return {
      document,
      source: normalized,
      pageCount: document.pageCount,
    };
  }

  /**
   * 批量读取全部页尺寸；结果缓存到关闭。
   *
   * @param options 起始页/页数与取消信号；非完整请求不缓存。
   * @returns 页信息数组。
   */
  async getPageInfos(options: PageInfoOptions = {}): Promise<readonly PageInfo[]> {
    const document = this.requireDocument();
    const isFullRequest =
      (options.start === undefined || options.start === 0) && options.count === undefined;
    if (isFullRequest && this.pageInfosPromise) return this.pageInfosPromise;
    const promise = document.getPageInfos(options);
    if (!isFullRequest) return promise;
    this.pageInfosPromise = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.pageInfosPromise === promise) this.pageInfosPromise = null;
      throw error;
    }
  }

  /**
   * 按需读取页面；同一页并发去重。
   *
   * @param pageIndex 页索引，0-based。
   * @returns 引擎页面。
   */
  async getPage(pageIndex: number): Promise<EnginePage> {
    const document = this.requireDocument();
    const cached = this.pagePromises.get(pageIndex);
    if (cached) return cached;
    const promise = document.getPage(pageIndex);
    this.pagePromises.set(pageIndex, promise);
    try {
      return await promise;
    } catch (error) {
      if (this.pagePromises.get(pageIndex) === promise) this.pagePromises.delete(pageIndex);
      throw error;
    }
  }

  /**
   * 预取页面资源；无 `prepare` 能力时静默跳过。
   *
   * @param pageIndex 页索引，0-based。
   * @param signal 取消信号。
   */
  async preparePage(pageIndex: number, signal?: AbortSignal): Promise<void> {
    const page = await this.getPage(pageIndex);
    if (typeof page.prepare !== 'function') return;
    await page.prepare(signal ? { signal } : {});
  }

  /** 读取大纲；结果缓存。 */
  async getOutline(): Promise<readonly OutlineNode[]> {
    const document = this.requireDocument();
    this.outlinePromise ??= document.getOutline();
    return this.outlinePromise;
  }

  /** 读取书签；结果缓存。 */
  async getBookmarks(): Promise<readonly BookmarkItem[]> {
    const document = this.requireDocument();
    this.bookmarksPromise ??= document.getBookmarks();
    return this.bookmarksPromise;
  }

  /** 读取文档属性；结果缓存。 */
  async getMetadata(): Promise<DocumentMetadata> {
    const document = this.requireDocument();
    this.metadataPromise ??= document.getMetadata();
    return this.metadataPromise;
  }

  /** 读取文档权限；结果缓存。 */
  async getPermissions(): Promise<DocumentPermissions> {
    const document = this.requireDocument();
    this.permissionsPromise ??= document.getPermissions();
    return this.permissionsPromise;
  }

  /** 读取签章 XML 摘要；结果缓存。 */
  async getSignatureEntries(): Promise<readonly SignatureEntryInfo[]> {
    const document = this.requireDocument();
    this.signatureEntriesPromise ??= document.getSignatureEntries();
    return this.signatureEntriesPromise;
  }

  /**
   * 读取签章原始字节；不缓存。
   *
   * @param signatureId 签章 ID。
   * @returns 文件字节；未声明/缺失时 undefined。
   */
  async getSignedValue(signatureId: string): Promise<SignedValueFile | undefined> {
    return this.requireDocument().getSignedValue(signatureId);
  }

  /** 关闭文档并清缓存；可重复调用。 */
  async close(): Promise<void> {
    await this.closeInternal();
  }

  /** 关闭实现；递增 token 使进行中的打开结果失效。 */
  private async closeInternal(): Promise<void> {
    this.openToken += 1;
    const document = this.doc;
    this.doc = null;
    this.docSource = null;
    this.pageInfosPromise = null;
    this.pagePromises.clear();
    this.outlinePromise = null;
    this.bookmarksPromise = null;
    this.metadataPromise = null;
    this.permissionsPromise = null;
    this.signatureEntriesPromise = null;
    if (!document) return;
    try {
      await document.close();
    } catch {
      // 关闭失败不向宿主抛错；资源由引擎尽力释放。
    }
  }

  /**
   * 断言文档已打开。
   *
   * @returns 引擎文档。
   * @throws {OFDViewerError} 未打开时抛 `OFD_NOT_OPENED`。
   */
  private requireDocument(): EngineDocument {
    if (!this.doc) {
      throw new OFDViewerError('OFD_NOT_OPENED', '文档尚未打开');
    }
    return this.doc;
  }
}