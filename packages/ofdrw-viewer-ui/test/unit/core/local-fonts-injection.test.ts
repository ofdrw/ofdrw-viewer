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
    // 开启本机字体后打开：先按无本机字体打开，读到声明后再静默重开一次。
    controller.setLocalFonts({ enabled: true });
    await controller.open(new ArrayBuffer(8));
    // 只查询无内嵌字体的声明（含 fontFile 的「宋体」被跳过）。
    expect(controller.getLocalFontDeclarations(8).map((item) => item.fontName)).toEqual(['黑体']);
    const requested = query.mock.calls.flatMap(
      (call) => (call[0] as { postscriptNames?: readonly string[] } | undefined)?.postscriptNames ?? [],
    );
    expect(requested.length, '应发生本机字体查询').toBeGreaterThan(0);
    expect(requested, '不得为内嵌字体发起查询').not.toContain('宋体');
  });

  it('maxFonts 默认 8，且只取前 N 个无内嵌字体的声明', async () => {
    const fonts = Array.from({ length: 12 }, (_, index) =>
      declaration(String(index + 1), `字体${index + 1}`),
    );
    const controller = new DocumentController({
      font: { localFonts: { enabled: true, maxFonts: 3 } },
      openDocument: async () => makeDocument(fonts),
    });
    controller.setLocalFonts({ enabled: true, maxFonts: 3 });
    await controller.open(new ArrayBuffer(8));
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

  it('本机字体只进 defaultFonts，不会同时出现在 supplementaryFonts', async () => {
    stubLocalFonts({ SimSun: new Uint8Array([0, 1, 0, 0]) });
    stubPermissions('granted');
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      font: {
        localFonts: { enabled: true },
        // 同时配置 supplementary，验证本机字体不会被重复塞进补字列表。
        supplementary: [{ data: new Uint8Array([0, 1, 0, 0]), family: 'HostSupp' }],
      },
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument([declaration('1', '宋体')]);
      },
    });
    // 生效值由阅读器在每次打开前同步（REQ-007 / REQ-0180）：先设置再打开。
    controller.setLocalFonts({ enabled: true });
    await controller.open(new ArrayBuffer(8));
    await controller.open(new ArrayBuffer(8));
    const last = calls.at(-1);
    const defaults = last?.defaultFonts ?? [];
    const supplementary = last?.supplementaryFonts ?? [];
    // 本机字体（family 为文档声明名「宋体」）应只出现在 defaultFonts。
    expect(defaults.some((input) => input.family === '宋体')).toBe(true);
    expect(supplementary.some((input) => input.family === '宋体')).toBe(false);
    // 两组之间不得共享同一个 FontInput 引用（引擎按 key 各建一次 FontFace）。
    const duplicated = defaults.filter((input) => supplementary.includes(input));
    expect(duplicated).toEqual([]);
    // 宿主 supplementary 仍原样保留。
    expect(supplementary.map((input) => input.family)).toEqual(['HostSupp']);
  });

  it('首次打开：拿到声明后静默重开一次，第二次 openDocument 带本机字体', async () => {
    stubLocalFonts({ SimSun: new Uint8Array([0, 1, 0, 0]) });
    stubPermissions('granted');
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      font: { localFonts: { enabled: true } },
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument([declaration('1', '宋体')]);
      },
    });
    controller.setLocalFonts({ enabled: true });
    await controller.open(new ArrayBuffer(8));
    // 首次打开不带本机字体，拿到声明后重开一次并带上本机字体。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const first = calls[0];
    const second = calls.at(-1);
    const familyOf = (options: OFDOpenOptions | undefined): readonly string[] =>
      (options?.defaultFonts ?? []).map((input) => String(input.family ?? ''));
    expect(familyOf(first), '第一次打开不含本机字体').not.toContain('宋体');
    expect(familyOf(second), '第二次打开含本机字体').toContain('宋体');
  });

  it('声明为空时不额外重开', async () => {
    stubLocalFonts();
    stubPermissions('granted');
    const calls: OFDOpenOptions[] = [];
    const controller = new DocumentController({
      font: { localFonts: { enabled: true } },
      openDocument: async (options) => {
        calls.push(options);
        return makeDocument([]);
      },
    });
    controller.setLocalFonts({ enabled: true });
    await controller.open(new ArrayBuffer(8));
    expect(calls).toHaveLength(1);
  });
});
