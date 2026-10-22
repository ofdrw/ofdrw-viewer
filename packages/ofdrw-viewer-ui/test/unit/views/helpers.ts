/**
 * 缩略图/大纲/书签测试辅助。
 *
 * 用内存文档替换引擎 `OFDDocument.open`，避免 jsdom 依赖真实 OFD 包与 canvas；
 * 同时安装内置 UI 外壳与导航扩展，覆盖 `src/views/nav.ts` 的注册路径。
 */

import { vi } from 'vitest';
import type {
  BookmarkItem,
  OutlineNode,
  PageInfo,
  PageRenderParameters,
} from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { getUIShell, installUIShell, type UIShell } from '../../../src/ui';
import { getNavigationServices, type NavigationServices } from '../../../src/views/nav';
import { OFDViewer, registerViewerExtension } from '../../../src/viewer';
import type { OFDViewerOptions } from '../../../src/options';

// 入口顺序模拟 t9：导航扩展先注册，随后安装内置 UI 外壳。
installUIShell(registerViewerExtension);

/** 文档渲染日志；记录每次 `page.render` 的页索引。 */
export interface RenderLog {
  /** 已发起渲染的页索引，0-based。 */
  readonly pages: number[];
}

/** 内存文档选项。 */
export interface FakeDocumentOptions {
  /** 页数；默认 3。 */
  readonly pageCount?: number;
  /** 大纲。 */
  readonly outline?: OutlineNode[];
  /** 书签。 */
  readonly bookmarks?: BookmarkItem[];
  /** 缺少 `getOutline`，模拟引擎不支持。 */
  readonly omitOutline?: boolean;
  /** 缺少 `getBookmarks`，模拟引擎不支持。 */
  readonly omitBookmarks?: boolean;
  /** 指定页渲染失败，0-based。 */
  readonly failRenderPages?: readonly number[];
  /** 渲染日志。 */
  readonly renderLog?: RenderLog;
}

/** 创建页信息。 */
export function makePageInfos(count: number): PageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
}

/** 创建内存页面。 */
function makePage(index: number, options: FakeDocumentOptions): unknown {
  const fail = options.failRenderPages?.includes(index) ?? false;
  return {
    index,
    getSize: () => ({ width: 210, height: 297 }),
    getViewport: (viewportOptions: { dpi?: number } = {}) => {
      const dpi = viewportOptions.dpi ?? 96;
      return {
        width: Math.ceil((210 / 25.4) * dpi),
        height: Math.ceil((297 / 25.4) * dpi),
      };
    },
    render: (params: PageRenderParameters) => {
      options.renderLog?.pages.push(index);
      try {
        params.canvasContext.clearRect(0, 0, 1, 1);
      } catch {
        // 伪上下文允许不支持。
      }
      if (fail) {
        return {
          promise: Promise.reject(new Error(`render failed: ${index}`)),
          cancel: vi.fn(),
        };
      }
      return { promise: Promise.resolve(), cancel: vi.fn() };
    },
    getTextContent: async () => ({ items: [], chars: [] }),
    exportImage: async () => {
      throw new Error('not implemented');
    },
  };
}

/**
 * 创建内存文档。
 *
 * @param options 页数、大纲、书签与失败页配置。
 * @returns 结构等价于引擎 `OFDDocument` 的对象。
 */
export function makeDocument(options: FakeDocumentOptions = {}): unknown {
  const pageCount = options.pageCount ?? 3;
  const document = {
    pageCount,
    getPageInfos: async () => makePageInfos(pageCount),
    getPage: async (index: number) => makePage(index, options),
    getOutline: async () => options.outline ?? [],
    getBookmarks: async () => options.bookmarks ?? [],
    getMetadata: async () => ({ version: '1.0', pageCount }),
    getPermissions: async () => ({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    }),
    getSignatureEntries: async () => [],
    getSignedValue: async () => undefined,
    close: async () => undefined,
  } as Record<string, unknown>;
  if (options.omitOutline) delete document.getOutline;
  if (options.omitBookmarks) delete document.getBookmarks;
  return document;
}

/** 安装 canvas/rAF/DPR 模拟。 */
export function installEnvironment(): void {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
}

/** 创建后的阅读器、外壳与导航视图读取器。 */
export interface IntegratedViewer {
  /** 阅读器。 */
  readonly viewer: OFDViewer;
  /** 内置 UI 外壳。 */
  readonly shell: UIShell;
  /** 读取导航视图（面板打开后才有）。 */
  readonly navigation: () => NavigationServices | undefined;
}

/**
 * 创建带内置 UI 与导航扩展的阅读器。
 *
 * @param documentOptions 内存文档配置。
 * @param viewerOptions 额外的阅读器选项。
 * @returns 阅读器、外壳与导航视图读取器。
 */
export async function createIntegratedViewer(
  documentOptions: FakeDocumentOptions = {},
  viewerOptions: Partial<OFDViewerOptions> = {},
): Promise<IntegratedViewer> {
  engineMocks.open.mockReset();
  engineMocks.open.mockResolvedValue(makeDocument(documentOptions));
  const viewer = new OFDViewer({
    container: document.body,
    source: new ArrayBuffer(8),
    ...viewerOptions,
  });
  await viewer.ready;
  const shell = getUIShell(viewer);
  if (!shell) throw new Error('内置 UI 外壳未挂载');
  await vi.waitFor(() => {
    if (!getNavigationServices(viewer)) throw new Error('导航视图尚未绑定');
  });
  return {
    viewer,
    shell,
    navigation: () => getNavigationServices(viewer),
  };
}

/** 清空 DOM。 */
export function resetDom(): void {
  document.body.innerHTML = '';
}

/** 读取面板中的缩略图按钮。 */
export function thumbnailItems(panel: HTMLElement): HTMLButtonElement[] {
  return [...panel.querySelectorAll<HTMLButtonElement>('.ofd-thumbnail')];
}

/** 读取面板中的大纲标题按钮。 */
export function outlineTitles(panel: HTMLElement): HTMLButtonElement[] {
  return [...panel.querySelectorAll<HTMLButtonElement>('.ofd-outline__title')];
}

/** 读取面板中的书签按钮。 */
export function bookmarkItems(panel: HTMLElement): HTMLButtonElement[] {
  return [...panel.querySelectorAll<HTMLButtonElement>('.ofd-bookmark')];
}