/**
 * 集成测试用内存 OFD 文档。
 *
 * 只实现阅读器实际消费的引擎接口（页尺寸、渲染、文本、导出、侧栏数据），
 * 不解析真实 OFD、不访问网络；能力缺失通过 `omit` 显式模拟。
 */

import type {
  BookmarkItem,
  DocumentMetadata,
  DocumentPermissions,
  OutlineNode,
  PageImageExportOptions,
  PageImageFormat,
  PageImageResult,
  PageInfo,
  PageRenderParameters,
  SignatureEntryInfo,
  SignedValueFile,
  TextChar,
  TextContent,
  TextItem,
  TextPoint,
  TextQuad,
  TextRect,
  Viewport,
} from '@ofdrw/ofdrw-viewer-engine';

/** 毫米到 96 DPI 像素换算系数。 */
const MM_TO_PX = 96 / 25.4;

/** 引擎渲染任务替身。 */
export interface MockRenderTask {
  /** 完成/失败 promise。 */
  readonly promise: Promise<void>;
  /** 取消回调。 */
  cancel(): void;
}

/** 单次导出记录。 */
export interface ExportCall {
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 导出参数。 */
  readonly options: PageImageExportOptions;
}

/** 内存文档选项。 */
export interface MockDocumentOptions {
  /** 页数；默认 3。 */
  readonly pageCount?: number;
  /** 每页尺寸；省略时全部 A4。 */
  readonly pageSizesMm?: ReadonlyArray<{ readonly widthMm: number; readonly heightMm: number }>;
  /** 每页文本行；省略时使用内置两行文本。 */
  readonly textLines?: readonly string[] | ((pageIndex: number) => readonly string[]);
  /** 文档属性。 */
  readonly metadata?: DocumentMetadata;
  /** 文档权限。 */
  readonly permissions?: DocumentPermissions;
  /** 大纲。 */
  readonly outline?: readonly OutlineNode[];
  /** 书签。 */
  readonly bookmarks?: readonly BookmarkItem[];
  /** 签章 XML 摘要。 */
  readonly signatures?: readonly SignatureEntryInfo[];
  /** 签章原始字节，按签章 ID 索引。 */
  readonly signedValues?: Readonly<Record<string, Uint8Array>>;
  /** 自定义页渲染；用于取消/优先级断言。 */
  readonly render?: (pageIndex: number, params: PageRenderParameters) => MockRenderTask;
  /** 指定页导出失败，0-based 页索引。 */
  readonly exportFailures?: readonly number[];
  /** 缺少引擎能力；对应属性会从文档/页对象上删除。 */
  readonly omit?: {
    readonly textContent?: boolean;
    readonly exportImage?: boolean;
    readonly outline?: boolean;
    readonly bookmarks?: boolean;
    readonly signatureEntries?: boolean;
  };
  /** 关闭回调；用于断言生命周期。 */
  readonly onClose?: () => void;
}

/** 内存文档。 */
export interface MockEngineDocument {
  /** 总页数。 */
  readonly pageCount: number;
  /** 渲染调用顺序（页索引，0-based）。 */
  readonly renderLog: number[];
  /** 导出调用记录。 */
  readonly exportLog: ExportCall[];
  /** 已关闭次数。 */
  readonly closeCalls: number;
  /** 渲染调用次数。 */
  readonly renderCalls: number;
  getPageInfos(): Promise<readonly PageInfo[]>;
  getPage(pageIndex: number): Promise<MockEnginePage>;
  getOutline?(): Promise<readonly OutlineNode[]>;
  getBookmarks?(): Promise<readonly BookmarkItem[]>;
  getMetadata(): Promise<DocumentMetadata>;
  getPermissions(): Promise<DocumentPermissions>;
  getSignatureEntries?(): Promise<readonly SignatureEntryInfo[]>;
  getSignedValue(signatureId: string): Promise<SignedValueFile | undefined>;
  close(): Promise<void>;
}

/** 内存页面。 */
export interface MockEnginePage {
  readonly index: number;
  getSize(): { readonly width: number; readonly height: number };
  getViewport(options?: { readonly dpi?: number }): Viewport;
  render(params: PageRenderParameters): MockRenderTask;
  getTextContent?(): Promise<TextContent>;
  exportImage?(options?: PageImageExportOptions): Promise<PageImageResult>;
}

/** 宽松权限：全部允许。 */
export const ALLOW_ALL_PERMISSIONS: DocumentPermissions = Object.freeze({
  edit: true,
  annot: true,
  export: true,
  signature: true,
  watermark: true,
  printScreen: true,
});

/** 生成 A4 页信息。 */
export function makePageInfos(
  count: number,
  sizes?: ReadonlyArray<{ readonly widthMm: number; readonly heightMm: number }>,
): PageInfo[] {
  return Array.from({ length: count }, (_, index) => {
    const size = sizes?.[index] ?? sizes?.[0] ?? { widthMm: 210, heightMm: 297 };
    return { index, widthMm: size.widthMm, heightMm: size.heightMm };
  });
}

/** 默认文本：每页两行。 */
function defaultLines(pageIndex: number): readonly string[] {
  return [`第 ${pageIndex + 1} 页 hello world`, '第二行 text'];
}

/** 字符推进量估算：中日韩全角按字号，其余半字号。 */
function charAdvance(char: string, size: number): number {
  return /[\u2e80-\u9fff\uff00-\uffef]/u.test(char) ? size : size * 0.5;
}

/** 生成矩形四边形。 */
function makeQuad(x: number, y: number, advance: number, size: number): TextQuad {
  return [
    { x, y: y - size },
    { x: x + advance, y: y - size },
    { x: x + advance, y },
    { x, y },
  ] as unknown as TextQuad;
}

/** 生成包围盒。 */
function makeRect(x: number, y: number, width: number, height: number): TextRect {
  return { x, y: y - height, width, height };
}

/** 构造一页文本内容。 */
export function makeTextContent(
  lines: readonly string[],
  pageIndex: number,
  widthMm = 210,
  heightMm = 297,
): TextContent {
  const items: TextItem[] = [];
  let order = 0;
  let charCount = 0;
  for (const line of lines) {
    const size = 16;
    const x = 10;
    const y = 40 + order * 30;
    const chars: TextChar[] = [];
    let cursor = x;
    for (const text of Array.from(line)) {
      const advance = charAdvance(text, size);
      const quad = makeQuad(cursor, y, advance, size);
      const origin: TextPoint = { x: cursor, y };
      chars.push({
        text,
        codePoint: text.codePointAt(0) ?? 0,
        fallback: false,
        origin,
        advance,
        rect: makeRect(cursor, y, advance, size),
        quad,
        approximate: false,
      });
      cursor += advance;
    }
    const advance = cursor - x;
    items.push({
      order,
      layer: 'page',
      layerType: 'Body',
      visible: true,
      alpha: 1,
      text: line,
      font: { resourceId: 'f1', family: 'sans-serif', italic: false },
      size,
      transform: [1, 0, 0, 1, 0, 0],
      origin: { x, y },
      rect: makeRect(x, y, advance, size),
      quad: makeQuad(x, y, advance, size),
      advance,
      charCount: chars.length,
      chars,
    });
    charCount += chars.length;
    order += 1;
  }
  return {
    pageIndex,
    dpi: 96,
    unit: 'px',
    pageWidth: (widthMm / 25.4) * 96,
    pageHeight: (heightMm / 25.4) * 96,
    items,
    itemCount: items.length,
    charCount,
    truncated: { items: false, chars: false },
  };
}

/** 按请求格式确定 MIME。 */
function mimeFor(format: PageImageFormat): PageImageResult['mime'] {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

/** 构造内存文档。 */
export function createMockDocument(options: MockDocumentOptions = {}): MockEngineDocument {
  const count = Math.max(1, options.pageCount ?? 3);
  const pageInfos = makePageInfos(count, options.pageSizesMm);
  const renderLog: number[] = [];
  const exportLog: ExportCall[] = [];
  const exportFailures = new Set(options.exportFailures ?? []);
  let closeCalls = 0;
  let renderCallsCount = 0;
  let pages: MockEnginePage[] = [];

  const makePage = (index: number): MockEnginePage => {
    const info = pageInfos[index]!;
    const lines =
      typeof options.textLines === 'function'
        ? options.textLines(index)
        : (options.textLines ?? defaultLines(index));
    const page: MockEnginePage = {
      index,
      getSize: () => ({ width: info.widthMm, height: info.heightMm }),
      getViewport: (viewportOptions = {}) => {
        const dpi = viewportOptions.dpi ?? 96;
        return {
          width: Math.ceil((info.widthMm / 25.4) * dpi),
          height: Math.ceil((info.heightMm / 25.4) * dpi),
          dpi,
        };
      },
      render: (params) => {
        renderLog.push(index);
        renderCallsCount += 1;
        if (options.render) return options.render(index, params);
        try {
          params.canvasContext.clearRect(0, 0, 1, 1);
        } catch {
          // 测试替身允许上下文不支持。
        }
        return { promise: Promise.resolve(), cancel: () => undefined };
      },
    };
    if (!options.omit?.textContent) {
      page.getTextContent = async () => makeTextContent(lines, index, info.widthMm, info.heightMm);
    }
    if (!options.omit?.exportImage) {
      page.exportImage = async (exportOptions = {}) => {
        exportLog.push({ pageNumber: index + 1, options: exportOptions });
        if (exportFailures.has(index)) throw new Error(`第 ${index + 1} 页导出失败`);
        const dpi = exportOptions.dpi ?? 96;
        const rotation = exportOptions.rotation ?? 0;
        const swapped = rotation === 90 || rotation === 270;
        const width = Math.ceil(((swapped ? info.heightMm : info.widthMm) / 25.4) * dpi);
        const height = Math.ceil(((swapped ? info.widthMm : info.heightMm) / 25.4) * dpi);
        return {
          data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, index, dpi % 251]),
          mime: mimeFor(exportOptions.format ?? 'png'),
          width,
          height,
          dpi,
        };
      };
    }
    return page;
  };

  const document: MockEngineDocument = {
    pageCount: count,
    renderLog,
    exportLog,
    get closeCalls() {
      return closeCalls;
    },
    get renderCalls() {
      return renderCallsCount;
    },
    getPageInfos: async () => pageInfos,
    getPage: async (index: number) => {
      pages[index] ??= makePage(index);
      return pages[index]!;
    },
    getMetadata: async () =>
      options.metadata ?? { version: '1.0', pageCount: count, title: '测试文档' },
    getPermissions: async () => options.permissions ?? ALLOW_ALL_PERMISSIONS,
    getSignedValue: async (signatureId: string) => {
      const data = options.signedValues?.[signatureId];
      if (!data) return undefined;
      return {
        signatureId,
        path: `Signs/SignedValue_${signatureId}.dat`,
        data,
        byteLength: data.byteLength,
      };
    },
    close: async () => {
      closeCalls += 1;
      options.onClose?.();
    },
  };
  if (!options.omit?.outline) {
    document.getOutline = async () => options.outline ?? [];
  }
  if (!options.omit?.bookmarks) {
    document.getBookmarks = async () => options.bookmarks ?? [];
  }
  if (!options.omit?.signatureEntries) {
    document.getSignatureEntries = async () => options.signatures ?? [];
  }
  return document;
}
