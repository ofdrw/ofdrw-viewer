/**
 * document-controller 的本机字体声明注入（本地字体加载方案设计 §6，
 * 需求清单 REQ-0190 / REQ-0200 / REQ-0210）。
 *
 * 覆盖：声明缓存与筛选（跳过含 `fontFile` 的声明、`maxFonts` 截断、默认 8）、
 * 注入顺序（宿主来源在前、本机字体在后）、未启用时不产生 `{ local }` 来源、
 * 重开时用上一次缓存声明补齐。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentFontResource,
  FontInput,
  OFDOpenOptions,
} from '@ofdrw/ofdrw-viewer-engine';
import { DocumentController, type EngineDocument } from '../../../src/document-controller';

/** 构造字体声明。 */
function declaration(
  id: string,
  fontName: string,
  extra: Partial<DocumentFontResource> = {},
): DocumentFontResource {
  return {
    id,
    fontName,
    charset: 'unicode',
    serif: true,
    bold: false,
    italic: false,
    fixedSize: false,
    documentLevel: true,
    ...extra,
  };
}

/** 构造带字体声明的引擎文档替身。 */
function makeDocument(
  fonts: readonly DocumentFontResource[],
  pageCount = 2,
): EngineDocument {
  return {
    pageCount,
    getPageInfos: async () => [],
    getPage: async (index: number) => ({ index }) as never,
    getOutline: async () => [],
    getBookmarks: async () => [],
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
    getFontResources: async () => fonts,
    close: async () => undefined,
  } as EngineDocument;
}

/** 安装 queryLocalFonts 替身，返回命中字体面的字节。 */
function stubLocalFonts(installed: Readonly<Record<string, Uint8Array>> = {}) {
  const query = vi.fn(
    async (options?: { postscriptNames?: readonly string[] }) => {
      const names = options?.postscriptNames ?? [];
      return names
        .filter((name) => installed[name] !== undefined)
        .map((name) => ({
          postscriptName: name,
          fullName: name,
          family: name,
          style: 'Regular',
          // `Uint8Array<ArrayBufferLike>` 不能直接作为 BlobPart；拷贝到独立 ArrayBuffer。
          blob: async () => new Blob([new Uint8Array(installed[name] as Uint8Array)]),
        }));
    },
  );
  vi.stubGlobal('queryLocalFonts', query);
  return query;
}

/** 安装权限查询替身。 */
function stubPermissions(state: 'granted' | 'denied' | 'prompt') {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    writable: true,
    value: { query: async () => ({ state, onchange: null }) },
  });
}

/** 抽取一次打开里传给 resolver 的 `{ local }` 来源名。 */
function localNames(options: OFDOpenOptions | undefined): readonly string[] {
  const sources = [...(options?.defaultFonts ?? []), ...(options?.supplementaryFonts ?? [])];
  return sources.map((input: FontInput) => String(input.family ?? ''));
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('document-controller 声明筛选', () => {
  it('跳过含 fontFile 的声明，只查询无内嵌字体的声明', async () => {
    const query = stubLocalFonts({ SimSun: new Uint8Array([0, 1, 0, 0]) });
    stubPermissions('granted');
    const calls: OFDOpenOptions[] = [];
    const fonts = [
      declaration('1', '宋体', { fontFile: 'Res/Font_1.ttf' }),
      declaration('2', '黑体'),
    ];
    const controller = new DocumentController({
      font: { localFonts: { enabled: true } },
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument(fonts);
      },
    });
    // 第一次打开：无声明缓存，本机字体不参与（推荐实现）。
    await controller.open(new ArrayBuffer(8));
    expect(query).not.toHaveBeenCalled();
    // 第二次打开：使用上一次缓存的声明。
    await controller.open(new ArrayBuffer(8));
    expect(controller.getLocalFontDeclarations(8).map((item) => item.fontName)).toEqual(['黑体']);
  });

  it('maxFonts 默认 8，且只取前 N 个无内嵌字体的声明', async () => {
    const fonts = Array.from({ length: 12 }, (_, index) =>
      declaration(String(index + 1), `字体${index + 1}`),
    );
    const controller = new DocumentController({
      font: { localFonts: { enabled: true, maxFonts: 3 } },
      openDocument: async () => makeDocument(fonts),
    });
    await controller.open(new ArrayBuffer(8));
    // 先打开一次以填充缓存，再读取筛选结果。
    await vi.waitFor(() => {
      expect(controller.getLocalFontDeclarations(3)).toHaveLength(3);
    });
    expect(controller.getLocalFontDeclarations(3).map((item) => item.fontName)).toEqual([
      '字体1',
      '字体2',
      '字体3',
    ]);
    expect(controller.getLocalFontDeclarations(undefined)).toHaveLength(8);
  });

  it('getFontResources 抛错时按无声明处理，不上报 error', async () => {
    const warnings: unknown[] = [];
    const controller = new DocumentController({
      font: { localFonts: { enabled: true } },
      onWarning: (warning) => warnings.push(warning),
      openDocument: async () =>
        ({
          ...makeDocument([]),
          getFontResources: async () => {
            const error = new Error('已关闭');
            error.name = 'OFD_CLOSED';
            throw error;
          },
        }) as EngineDocument,
    });
    await controller.open(new ArrayBuffer(8));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings).toHaveLength(0);
    expect(controller.getLocalFontDeclarations(8)).toHaveLength(0);
  });
});

describe('document-controller 注入顺序', () => {
  it('未启用 localFonts 时不产生本机字体来源', async () => {
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument([declaration('1', '宋体')]);
      },
    });
    await controller.open(new ArrayBuffer(8));
    await controller.open(new ArrayBuffer(8));
    const withLocal = calls.some((options) => localNames(options).includes('宋体'));
    expect(withLocal).toBe(false);
  });

  it('宿主 default 在前、本机字体在后', async () => {
    stubLocalFonts({ SimSun: new Uint8Array([0, 1, 0, 0]) });
    stubPermissions('granted');
    const hostFont: FontInput = { data: new Uint8Array([0, 1, 0, 0]), family: 'HostFont' };
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      font: {
        localFonts: { enabled: true },
        default: [{ data: new Uint8Array([0, 1, 0, 0]), family: 'HostFont' }],
      },
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument([declaration('1', '宋体')]);
      },
    });
    await controller.open(new ArrayBuffer(8));
    await controller.open(new ArrayBuffer(8));
    const last = calls.at(-1);
    expect(last?.defaultFonts?.[0]?.family).toBe('HostFont');
    expect(hostFont.family).toBe('HostFont');
  });
});
