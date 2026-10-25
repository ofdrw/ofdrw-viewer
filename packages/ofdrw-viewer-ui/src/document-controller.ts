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
  AttachmentInfo,
  BookmarkItem,
  DocumentFontResource,
  DocumentMetadata,
  DocumentPermissions,
  FontAliasTable,
  FontInput,
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
import {
  composeFontAliases,
  FontSourceResolver,
  type FontSource,
  type ViewerFontOptions,
} from './font';
import { normalizeLocalFontsMaxFonts } from './local-fonts-state';
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
  /** 附件元信息；旧引擎实现可能不含该方法。 */
  getAttachments?(options?: { signal?: AbortSignal }): Promise<readonly AttachmentInfo[]>;
  /** 签章 XML 摘要。 */
  getSignatureEntries(
    options?: { signal?: AbortSignal },
  ): Promise<readonly SignatureEntryInfo[]>;
  /** `SignedValue.dat` 原始字节。 */
  getSignedValue(
    signatureId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SignedValueFile | undefined>;
  /** 文档声明的字体资源清单；旧引擎实现可能不含该方法。 */
  getFontResources?(): Promise<readonly DocumentFontResource[]>;
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

/** 字体加载状态：`loading` 正在读取，`ready` 已结束（成功或失败）。 */
export type FontLoadState = 'loading' | 'ready';

/** 文档控制器选项。 */
export interface DocumentControllerOptions {
  /** 引擎打开工厂；默认 `OFDDocument.open`。 */
  readonly openDocument?: (options: OFDOpenOptions) => Promise<EngineDocument>;
  /** URL 来源的额外请求参数；headers 会与来源 headers 合并。 */
  readonly requestInit?: RequestInit;
  /** 引擎 warning 回调。 */
  readonly onWarning?: (warning: ViewerWarning) => void;
  /** 字体配置：默认/补充字体、path/filePath 加载器与追加别名组。 */
  readonly font?: ViewerFontOptions;
  /**
   * 字体加载状态回调。
   *
   * `loading` 在开始读取字体时触发，`ready` 在字体解析结束（含失败、取消）时触发。
   * 阅读器据此把加载动画文案切换为「正在加载字体…」，让用户知道等待来自字体下载。
   * 未声明任何字体来源时不会触发。
   */
  readonly onFontState?: (state: FontLoadState) => void;
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
export function mergeHeaders(
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

/** 关闭文档并忽略失败；用于过期/被替换的文档实例。 */
async function closeQuietly(document: EngineDocument): Promise<void> {
  try {
    await document.close();
  } catch {
    // 过期文档关闭失败不影响调用方。
  }
}

/**
 * 判断一次打开参数里是否包含本机字体来源。
 *
 * @param fonts `resolveFonts()` 的结果。
 * @returns 含本机字体时返回 true。
 */
function hasLocalFonts(fonts: {
  readonly defaultFonts?: readonly FontInput[];
  readonly supplementaryFonts?: readonly FontInput[];
}): boolean {
  return (fonts.defaultFonts?.length ?? 0) > 0;
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
  private attachmentsPromise: Promise<readonly AttachmentInfo[]> | null = null;
  private signatureEntriesPromise: Promise<readonly SignatureEntryInfo[]> | null = null;
  /** 字体来源解析器；创建时按 `font.loader` 与 `requestInit` 构造一次。 */
  private readonly fonts: FontSourceResolver;
  /**
   * 上一次打开文档的字体声明缓存。
   *
   * `getFontResources()` 需要文档实例，而字体要在 `openDocument()` 之前准备好；因此本次
   * 打开使用上一次缓存的声明，打开完成后再刷新缓存，由阅读器的重开流程补齐首屏
   * （需求清单 REQ-0190 的推荐实现）。
   */
  private fontDeclarations: readonly DocumentFontResource[] = [];
  /**
   * 本机字体的当前生效值（用户选择或宿主默认值），由阅读器在每次打开前同步。
   *
   * 与 `font.localFonts.enabled`（宿主是否允许展示开关）语义不同：后者是能力开关，
   * 前者是用户当前是否真的要使用本机字体（需求清单 REQ-007 / REQ-0180）。
   */
  private localFontsState:
    | { readonly enabled: boolean; readonly maxFonts: number }
    | undefined;

  /**
   * @param options 打开工厂、请求参数、warning 回调与字体配置。
   */
  constructor(options: DocumentControllerOptions = {}) {
    this.options = options;
    this.fonts = new FontSourceResolver({
      ...(options.font?.loader ? { loader: options.font.loader } : {}),
      ...(options.requestInit ? { requestInit: options.requestInit } : {}),
      ...(options.font?.localFonts
        ? {
            localFonts: {
              enabled: options.font.localFonts.enabled === true,
              ...(options.font.aliases
                ? { aliases: composeFontAliases(options.font.aliases) }
                : {}),
            },
          }
        : {}),
    });
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
   * 判断是否声明了任何字体来源。
   *
   * 只读取已配置的选项，不触发 I/O；为 false 时打开流程保持零字体等待开销。
   *
   * @returns 声明了 default 或 supplementary 来源时为 true。
   */
  private hasFontSources(): boolean {
    const font = this.options.font;
    if (!font) return false;
    return (font.default?.length ?? 0) > 0 || (font.supplementary?.length ?? 0) > 0;
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
    // 清空上一个文档的声明：本机字体查询必须基于当前文档（跨文档复用会查到错误字体）。
    this.fontDeclarations = [];
    // closeInternal 会递增 openToken；打开代次必须在关闭之后捕获。
    const token = ++this.openToken;
    if (signal?.aborted) throw createOpenAbortError();
    const openDocument =
      this.options.openDocument ??
      ((options: OFDOpenOptions) =>
        OFDDocument.open(options) as unknown as Promise<EngineDocument>);
    // 字体读取与文档打开串行协作，但先于 openDocument 完成：首次渲染即带完整字体，
    // 不出现「先渲染缺字页面、字体到达后再跳变」的中间态。字体就绪后才打开文档，等待
    // 换取的是一次成型的正确画面。
    const hasFonts = this.hasFontSources();
    if (hasFonts) this.options.onFontState?.('loading');
    let fonts: Awaited<ReturnType<DocumentController['resolveFonts']>> = {};
    try {
      fonts = await this.resolveFonts(signal);
    } finally {
      if (hasFonts) this.options.onFontState?.('ready');
    }
    const openOnce = (openFonts: Awaited<ReturnType<DocumentController['resolveFonts']>>) =>
      openDocument({
        ...extra,
        ...openFonts,
        ...(this.options.onWarning ? { onWarning: this.options.onWarning } : {}),
        ...(signal ? { signal } : {}),
      });

    let document = await openOnce(fonts);
    // 声明只能从已打开的文档读取（设计 §3.6），而查询本机字体又必须先有声明。因此这里
    // 每条打开路径都做「打开 → 读当前文档声明 → 有本机字体则静默重开一次」
    // （需求清单 REQ-0190 方案 A）。不使用缓存做短路，避免切换文档时沿用上一个文档的
    // 声明；未启用本机字体时完全跳过，不产生额外打开与查询。
    {
      // 声明与开关解耦：即使尚未启用本机字体也要读一次，供授权手势展开候选名
      // （开关打开后才会真正注入；未启用时不产生额外重开）。
      const declarations = await this.readFontDeclarations(document);
      if (token !== this.openToken || signal?.aborted) {
        await closeQuietly(document);
        throw createOpenAbortError();
      }
      this.fontDeclarations = declarations;
      if (declarations.length > 0 && this.localFontsState?.enabled) {
        const reopenFonts = await this.resolveFonts(signal);
        // 只有真的产生了本机字体来源才值得多打开一次。
        if (hasLocalFonts(reopenFonts)) {
          const reopened = await openOnce(reopenFonts);
          if (token !== this.openToken || signal?.aborted) {
            await closeQuietly(document);
            await closeQuietly(reopened);
            throw createOpenAbortError();
          }
          await closeQuietly(document);
          document = reopened;
          fonts = reopenFonts;
        }
      }
    }
    if (token !== this.openToken || signal?.aborted) {
      await closeQuietly(document);
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
   * 读取文档声明的字体资源（不写缓存）。
   *
   * @param document 已打开的引擎文档。
   * @returns 声明列表；引擎未提供该 API 或读取失败时为空数组。
   */
  private async readFontDeclarations(
    document: EngineDocument,
  ): Promise<readonly DocumentFontResource[]> {
    if (typeof document.getFontResources !== 'function') return [];
    try {
      return await document.getFontResources();
    } catch {
      // OFD_CLOSED / OFD_ABORTED / 旧引擎：按「无声明」处理，不上报 error。
      return [];
    }
  }

  /**
   * 筛选参与本机字体查询的文档声明（需求清单 REQ-0190 / §0.2 的 `maxFonts`）。
   *
   * 规则：跳过含内嵌 `fontFile` 的声明（内嵌字体本来就优先，查询是浪费）；按
   * `maxFonts`（默认 8，上限 32）截断。结果顺序沿用引擎给定的 `id` 升序。
   *
   * @param maxFonts 单文档最多查询的声明数；非法值按默认 8 处理。
   * @returns 需要查询本机字体的声明列表。
   */
  getLocalFontDeclarations(maxFonts?: number): readonly DocumentFontResource[] {
    const limit = normalizeLocalFontsMaxFonts(maxFonts);
    const candidates = this.fontDeclarations.filter(
      (resource) => resource.fontFile === undefined,
    );
    return candidates.slice(0, limit);
  }

  /**
   * 透传本地字体开关到字体来源解析器。
   *
   * 生效值变化时清空本机字体缓存（需求清单 REQ-0260 / C14），宿主 url/path 缓存不受影响。
   *
   * @param enabled 生效的开关值（用户选择或宿主默认值）。
   */
  setLocalFontsEnabled(enabled: boolean): void {
    this.fonts.setLocalFontsEnabled(enabled);
  }

  /**
   * 同步本机字体的生效配置（阅读器在开关/权限变化与每次打开前调用）。
   *
   * `enabled=false` 时既不会生成 `{ local }` 来源，也会让 resolver 清空本机字体缓存，
   * 保证关闭开关后 `queryLocalFonts` 调用次数为 0（REQ-0180 行为底线）。
   *
   * @param options 生效的开关值与 `maxFonts`；省略表示能力不可用。
   */
  setLocalFonts(
    options: { readonly enabled: boolean; readonly maxFonts?: number } | undefined,
  ): void {
    this.localFontsState = options
      ? { enabled: options.enabled, maxFonts: normalizeLocalFontsMaxFonts(options.maxFonts) }
      : undefined;
    this.fonts.setLocalFontsEnabled(options?.enabled === true);
  }

  /**
   * 已读取到的当前文档字体声明。
   *
   * 与 `getLocalFontDeclarations()` 的区别：本方法不按开关过滤，供「授权手势」在尚未
   * 启用本机字体时展开候选名（此时开关还没打开，但仍需要一次有效查询来触发授权框）。
   *
   * @returns 当前文档的声明列表；未读取或为空时为空数组。
   */
  getDocumentFontDeclarations(): readonly DocumentFontResource[] {
    return this.fontDeclarations;
  }

  /** 当前生效的本机字体配置；省略表示不可用。 */
  get localFonts(): { readonly enabled: boolean; readonly maxFonts: number } | undefined {
    return this.localFontsState;
  }

  /**
   * 按文档声明生成本机字体来源列表（需求清单 REQ-0190 / REQ-0200）。
   *
   * 每个声明产出声明对象形态的 `{ local }`，候选展开与 `FontInput.family = fontName`
   * （F6）由 resolver 负责。未开启 / 浏览器不支持 / 无声明时返回空数组，打开流程与
   * 「未引入本功能」完全一致。
   *
   * @returns 追加在宿主来源之后的本机字体来源。
   */
  private createLocalFontSources(): readonly FontSource[] {
    const localFonts = this.localFontsState;
    if (!localFonts || !localFonts.enabled) return [];
    const declarations = this.getLocalFontDeclarations(localFonts.maxFonts);
    const sources: FontSource[] = [];
    for (const declaration of declarations) {
      // 直接用声明对象：候选展开与 `FontInput.family = fontName`（F6）由 resolver 负责。
      sources.push({
        local: {
          fontName: declaration.fontName,
          ...(declaration.familyName ? { familyName: declaration.familyName } : {}),
          bold: declaration.bold,
          italic: declaration.italic,
        },
      });
    }
    return sources;
  }

  /**
   * 解析字体配置为引擎打开参数片段。
   *
   * 只把非空结果作为 `defaultFonts`/`supplementaryFonts` 传入，避免空数组触发引擎多余的
   * 加载分支；未配置 `font` 时返回空对象。单个来源读取失败只通过 `onWarning` 报
   * `W_FONT_MISSING`，不抛错、不阻断打开；本次 open 被取消时返回空对象（由调用方按
   * 取消流程处理）。
   *
   * @param signal 本次 open 的取消信号。
   * @returns `{ defaultFonts?, supplementaryFonts?, aliases? }`；无可用字体时为空对象。
   */
  private async resolveFonts(
    signal: AbortSignal | undefined,
  ): Promise<{
    defaultFonts?: readonly FontInput[];
    supplementaryFonts?: FontInput[];
    aliases?: FontAliasTable;
  }> {
    const font = this.options.font;
    if (!font) return {};
    const localFonts = font.localFonts;
    const report = (source: FontSource, error: unknown): void => {
      // 取消导致的失败不再上报：打开流程本身会以 AbortError 结束。
      if (isAbortError(error) || signal?.aborted) return;
      this.options.onWarning?.({
        code: 'W_FONT_MISSING',
        message: `字体读取失败（${describeFontSource(source)}）：${describeError(error)}`,
      });
    };
    // 本机字体来源：按文档声明生成 `{ local }`，追加在宿主来源之后（宿主优先，F3）。
    const localSources = this.createLocalFontSources();
    const [hostDefaults, hostSupplementary, localInputs] = await Promise.all([
      this.fonts.resolve(font.default ?? [], signal, report),
      this.fonts.resolve(font.supplementary ?? [], signal, report),
      localSources.length > 0
        ? this.fonts.resolve(localSources, signal, report)
        : Promise.resolve<FontInput[]>([]),
    ]);
    if (signal?.aborted) return {};
    // 宿主配置在前、本机字体在后（F3/C2）；宿主 `default` 为空时结果即 `[...localInputs]`，
    // 不需要额外分支。
    const defaultFonts = [...hostDefaults, ...localInputs];
    // 本机字体只进 defaultFonts：引擎按 `default:N` 与 `supplementary:M` 分别建 FontFace
    // 且不跨列表去重（font/provider.ts loadDefaultFaces / loadSupplementaryFaces），
    // 同时注入会让同一份 10–20 MB 字体被解析两次、内存翻倍。本机字体是「替代/优先」语义，
    // 不是「补字」语义，因此固定放默认候选。
    const supplementaryFonts = [...hostSupplementary];
    return {
      ...(defaultFonts.length > 0 ? { defaultFonts } : {}),
      ...(supplementaryFonts.length > 0 ? { supplementaryFonts } : {}),
      // 追加语义：宿主别名组与内置别名组合并后再交给引擎。
      ...(font.aliases && font.aliases.length > 0
        ? { aliases: composeFontAliases(font.aliases) }
        : {}),
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

  /**
   * 读取附件元信息；结果缓存。
   *
   * 只读索引，不读取附件内容。引擎未实现 `getAttachments()` 时返回空数组，
   * 保证旧版本引擎下调用方无需额外分支判断。
   */
  async getAttachments(): Promise<readonly AttachmentInfo[]> {
    const document = this.requireDocument();
    if (typeof document.getAttachments !== 'function') return [];
    this.attachmentsPromise ??= document.getAttachments();
    return this.attachmentsPromise;
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

  /**
   * 关闭文档并清缓存；可重复调用、可再次打开。
   *
   * 字体缓存不在关闭时清理，重新打开同一文档可复用已读取的字体字节。
   */
  async close(): Promise<void> {
    await this.closeInternal();
  }

  /**
   * 释放控制器：中止进行中的字体读取并清空字体缓存。
   *
   * 不关闭已打开的文档，文档由 `close()`/`destroy()` 的调用方负责。
   */
  dispose(): void {
    this.fonts.dispose();
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
    this.attachmentsPromise = null;
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

/**
 * 生成字体来源的诊断描述；只含 URL/路径，不含字体字节。
 *
 * @param source 字体来源。
 * @returns 形如 `url=<url>` / `path=<path>` / `filePath=<filePath>` / `data` 的描述。
 */
function describeFontSource(source: FontSource): string {
  if (typeof source !== 'object' || source === null) return 'invalid';
  if ('local' in source) {
    // 本机字体来源只用于诊断：不打印字体字节，也不展开成字体清单（设计 §6.3 / §7）。
    const local = source.local;
    const name = typeof local === 'string'
      ? local
      : Array.isArray(local)
        ? local.join(',')
        : (local as { fontName?: string }).fontName ?? 'unknown';
    return `local=${name}`;
  }
  if ('url' in source) return `url=${source.url}`;
  if ('path' in source) return `path=${source.path}`;
  if ('filePath' in source) return `filePath=${source.filePath}`;
  return 'data';
}

/**
 * 提取错误摘要，用于 warning 文案。
 *
 * @param error 任意错误。
 * @returns 错误消息；非 Error 时转为字符串。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
