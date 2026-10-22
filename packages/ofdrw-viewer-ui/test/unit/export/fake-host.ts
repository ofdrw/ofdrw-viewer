/**
 * 打印/导出单元测试的内存宿主与页面。
 *
 * 不依赖真实 OFD 文档与 canvas：页面 `exportImage` 按引擎语义、依据 DPI/旋转
 * 返回宽高与 MIME，便于断言输出尺寸和传入选项。
 */

import { vi } from 'vitest';
import type {
  DocumentPermissions,
  PageImageExportOptions,
  PageImageFormat,
  PageImageResult,
  PageInfo,
} from '@ofdrw/ofdrw-viewer-engine';
import type { EnginePage, EngineRenderTaskLike } from '../../../src/document-controller';
import type { EngineDocument } from '../../../src/document-controller';
import type { FeatureState, ViewerFeature } from '../../../src/features';
import type { OutputHost } from '../../../src/export/host';
import type { Rotation } from '../../../src/state';

/** 假的引擎页面；`exportImage` 记录调用参数并按旋转交换宽高。 */
export class FakePage implements EnginePage {
  /** 页索引，0-based。 */
  readonly index: number;
  /** 页宽，单位 mm。 */
  readonly widthMm: number;
  /** 页高，单位 mm。 */
  readonly heightMm: number;
  /** 请求 WebP 时是否回退 PNG。 */
  readonly webpFallback: boolean;
  /** 导出调用记录。 */
  readonly exportImage = vi.fn(
    async (options: PageImageExportOptions = {}): Promise<PageImageResult> => {
      const dpi = options.dpi ?? 96;
      const rotation = options.rotation ?? 0;
      const format = options.format ?? 'png';
      const naturalWidth = Math.max(1, Math.ceil((this.widthMm / 25.4) * dpi));
      const naturalHeight = Math.max(1, Math.ceil((this.heightMm / 25.4) * dpi));
      const quarter = rotation === 90 || rotation === 270;
      const mime = this.resolveMime(format);
      return {
        data: new Uint8Array([this.index + 1, rotation, dpi % 251]),
        mime,
        width: quarter ? naturalHeight : naturalWidth,
        height: quarter ? naturalWidth : naturalHeight,
        dpi,
      };
    },
  );
  /** 正常渲染不应被打印/导出调用。 */
  readonly render = vi.fn(
    (): EngineRenderTaskLike => ({
      promise: Promise.resolve(),
      cancel: () => undefined,
    }),
  );

  constructor(
    index: number,
    options: { widthMm?: number; heightMm?: number; webpFallback?: boolean } = {},
  ) {
    this.index = index;
    this.widthMm = options.widthMm ?? 210;
    this.heightMm = options.heightMm ?? 297;
    this.webpFallback = options.webpFallback ?? false;
  }

  /** 页尺寸，单位 mm。 */
  getSize(): { width: number; height: number } {
    return { width: this.widthMm, height: this.heightMm };
  }

  /** 指定 DPI 的像素尺寸。 */
  getViewport(options: { dpi?: number } = {}): { width: number; height: number; dpi: number } {
    const dpi = options.dpi ?? 96;
    return {
      width: Math.ceil((this.widthMm / 25.4) * dpi),
      height: Math.ceil((this.heightMm / 25.4) * dpi),
      dpi,
    };
  }

  /** 返回与请求格式对应的 MIME；可模拟 WebP 回退。 */
  private resolveMime(format: PageImageFormat): 'image/png' | 'image/jpeg' | 'image/webp' {
    if (format === 'jpeg') return 'image/jpeg';
    if (format === 'webp') return this.webpFallback ? 'image/png' : 'image/webp';
    return 'image/png';
  }
}

/** 假宿主选项。 */
export interface FakeHostOptions {
  /** 页数；与 `pageSizes` 同时使用时以 `pageSizes` 长度为准。 */
  readonly pageCount?: number;
  /** 每页尺寸；数组长度即页数。 */
  readonly pageSizes?: ReadonlyArray<{ readonly widthMm: number; readonly heightMm: number }>;
  /** 当前页，1-based；默认 1。 */
  readonly currentPage?: number;
  /** 当前旋转；默认 0。 */
  readonly rotation?: Rotation;
  /** 文档标题；用于文件名断言。 */
  readonly title?: string;
  /** 文档权限覆盖。 */
  readonly permissions?: Partial<DocumentPermissions>;
  /** 功能状态覆盖。 */
  readonly features?: Partial<Record<ViewerFeature, FeatureState>>;
  /** WebP 是否回退 PNG。 */
  readonly webpFallback?: boolean;
}

/** 内存宿主；结构兼容 `OutputHost`。 */
export class FakeHost implements OutputHost {
  /** 全部页面。 */
  readonly pages: FakePage[];
  /** 宿主选项。 */
  readonly options: FakeHostOptions;
  /** 模拟核心事件总线收到的输出事件。 */
  readonly events: Array<{ readonly event: string; readonly payload: unknown }> = [];
  private readonly features: Partial<Record<ViewerFeature, FeatureState>>;
  private readonly permissions: DocumentPermissions;

  constructor(options: FakeHostOptions = {}) {
    this.options = options;
    const sizes =
      options.pageSizes ??
      Array.from({ length: options.pageCount ?? 1 }, () => ({
        widthMm: 210,
        heightMm: 297,
      }));
    this.pages = sizes.map(
      (size, index) =>
        new FakePage(index, {
          widthMm: size.widthMm,
          heightMm: size.heightMm,
          webpFallback: options.webpFallback,
        }),
    );
    this.features = options.features ?? {};
    this.permissions = {
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
      ...options.permissions,
    };
  }

  getPageCount(): number {
    return this.pages.length;
  }

  getPageNumber(): number {
    return this.options.currentPage ?? 1;
  }

  getRotation(): Rotation {
    return this.options.rotation ?? 0;
  }

  getPageInfos(): readonly PageInfo[] {
    return this.pages.map((page, index) => ({
      index,
      widthMm: page.widthMm,
      heightMm: page.heightMm,
    }));
  }

  async getPage(pageNumber: number): Promise<EnginePage> {
    const page = this.pages[pageNumber - 1];
    if (!page) throw new Error(`页码越界：${pageNumber}`);
    return page;
  }

  async getPermissions(): Promise<DocumentPermissions> {
    return this.permissions;
  }

  getFeatureState(feature: ViewerFeature): FeatureState {
    return this.features[feature] ?? { enabled: true, visible: true };
  }

  getElements(): { readonly root: HTMLElement } {
    return { root: document.body };
  }

  getState(): { readonly document: { readonly metadata?: { readonly title?: string } } } {
    return { document: { metadata: { title: this.options.title ?? '测试文档' } } };
  }

  /** 模拟 OFDViewer 的内部事件总线；输出模块以此转发进度事件。 */
  emit(event: string, payload: unknown): void {
    this.events.push({ event, payload });
  }

  /** 供测试模拟文档对象；输出服务不直接使用。 */
  asDocument(): EngineDocument {
    return {
      pageCount: this.pages.length,
      getPageInfos: async () => this.getPageInfos(),
      getPage: async (index: number) => this.pages[index]!,
      getOutline: async () => [],
      getBookmarks: async () => [],
      getMetadata: async () => ({ version: '1.0', pageCount: this.pages.length }),
      getPermissions: async () => this.permissions,
      getSignatureEntries: async () => [],
      getSignedValue: async () => undefined,
      close: async () => undefined,
    };
  }
}
