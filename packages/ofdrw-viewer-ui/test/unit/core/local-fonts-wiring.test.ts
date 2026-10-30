/**
 * 本机字体「接线」回归：走阅读器真实入口，验证生效值确实传到了文档控制器
 * （本地字体加载方案设计 §4 / §6，需求清单 REQ-007 / REQ-0180 / REQ-0240）。
 *
 * 这条测试的价值在于不手动调用 `controller.setLocalFonts()`——它只经由
 * `viewer.setLocalFontsEnabled()` / `viewer.open()` 的公开路径驱动。若将来有人再次
 * 漏掉这处接线，本用例会立刻失败（历史上正是该缺失导致授权后本机字体从未注入）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentFontResource, OFDOpenOptions, PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  // 未覆盖的引擎导出（常量、类型辅助）保持真实实现，避免新特性读取到 undefined。
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { open: engineMocks.open },
    OFDError: class extends Error {},
    isOFDError: () => false,
    toOFDError: (error: unknown) => error,
    // 别名表被候选展开直接引用。
    DEFAULT_FONT_ALIASES: [['宋体', 'simsun', 'songti', 'stsong']],
  };
});

import { OFDViewer, registerViewerExtension } from '../../../src/viewer';
import { attachUIShell } from '../../../src/ui';

/** 构造页信息。 */
function makeInfos(count: number): PageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
}

/** 构造带 `getFontResources` 的引擎文档替身。 */
function makeDocument(fonts: readonly DocumentFontResource[]): unknown {
  const count = 2;
  return {
    pageCount: count,
    getPageInfos: async () => makeInfos(count),
    getPage: async (index: number) => ({
      index,
      getSize: () => ({ width: 210, height: 297 }),
      getViewport: (options: { dpi?: number } = {}) => {
        const dpi = options.dpi ?? 96;
        return {
          width: Math.ceil((210 / 25.4) * dpi),
          height: Math.ceil((297 / 25.4) * dpi),
        };
      },
      render: (params: { canvasContext: { clearRect: () => void } }) => {
        params.canvasContext.clearRect();
        return { promise: Promise.resolve(), cancel: vi.fn() };
      },
      getTextContent: async () => ({ items: [], chars: [] }),
      exportImage: async () => {
        throw new Error('not implemented');
      },
    }),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount: count }),
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
  };
}

/** 安装 queryLocalFonts 与权限替身。 */
function stubLocalFonts(permission: 'granted' | 'prompt' = 'granted') {
  const query = vi.fn(async (options?: { postscriptNames?: readonly string[] }) =>
    (options?.postscriptNames ?? []).map((name) => ({
      postscriptName: name,
      fullName: name,
      family: name,
      style: 'Regular',
      blob: async () => new Blob([new Uint8Array([0, 1, 0, 0])]),
    })),
  );
  vi.stubGlobal('queryLocalFonts', query);
  // 与真实 Chrome 一致：`queryLocalFonts` 首次成功调用后权限变为 granted。
  let current = permission;
  const tracked = vi.fn(async (options?: { postscriptNames?: readonly string[] }) => {
    const result = await query(options);
    current = 'granted';
    return result;
  });
  vi.stubGlobal('queryLocalFonts', tracked);
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    writable: true,
    value: { query: async () => ({ state: current, onchange: null }) },
  });
  return tracked;
}

/** 等待若干宏任务。 */
async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 读取一次打开调用里的 defaultFonts family 列表。 */
function defaultFamilies(options: OFDOpenOptions | undefined): readonly string[] {
  return (options?.defaultFonts ?? []).map((input) => String(input.family ?? ''));
}

beforeEach(() => {
  document.body.innerHTML = '';
  // 授权确认框由内置 UI 外壳提供。
  registerViewerExtension(attachUIShell as never);
  localStorage.clear();
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () =>
    makeDocument([
      {
        id: '1',
        fontName: '宋体',
        charset: 'unicode',
        serif: true,
        bold: false,
        italic: false,
        fixedSize: false,
        documentLevel: true,
      },
    ]),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('本机字体接线（走 viewer 公开入口）', () => {
  it('开关开启后打开文档：查询本机字体并注入 defaultFonts', async () => {
    const query = stubLocalFonts('granted');
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { enabled: false },
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    } as never);
    await viewer.ready;
    await flush();

    // 走真实入口：不手动调用 controller.setLocalFonts。
    expect(viewer.getLocalFontsStatus().enabled).toBe(true);
    await viewer.open(new ArrayBuffer(16));
    await flush();

    expect(query, '应发起本机字体查询').toHaveBeenCalled();
    const last = engineMocks.open.mock.calls.at(-1)?.[0] as OFDOpenOptions | undefined;
    expect(defaultFamilies(last), 'defaultFonts 应含文档声明的本机字体').toContain('宋体');
    viewer.destroy();
  });

  it('开关关闭后打开文档：不查询本机字体、不注入', async () => {
    const query = stubLocalFonts('granted');
    engineMocks.open.mockClear();
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { enabled: false },
      fonts: { localFonts: { enabled: true, defaultEnabled: false } },
    } as never);
    await viewer.ready;
    engineMocks.open.mockClear();
    query.mockClear();

    await viewer.open(new ArrayBuffer(16));
    await flush();

    expect(query, '关闭时不得查询').not.toHaveBeenCalled();
    const last = engineMocks.open.mock.calls.at(-1)?.[0] as OFDOpenOptions | undefined;
    expect(defaultFamilies(last)).not.toContain('宋体');
    viewer.destroy();
  });

  it('运行时关闭开关后：再次打开不再注入本机字体', async () => {
    const query = stubLocalFonts('granted');
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { enabled: false },
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    } as never);
    await viewer.ready;
    await flush();
    await viewer.setLocalFontsEnabled(false);
    await flush();
    query.mockClear();
    engineMocks.open.mockClear();

    await viewer.open(new ArrayBuffer(16));
    await flush();

    expect(query, '关闭开关后不得查询').not.toHaveBeenCalled();
    const last = engineMocks.open.mock.calls.at(-1)?.[0] as OFDOpenOptions | undefined;
    expect(defaultFamilies(last)).not.toContain('宋体');
    viewer.destroy();
  });
});

/**
 * 点击「使用本机字体」授权确认框里的按钮。
 *
 * @param label 按钮文案。
 */
function clickGrantDialog(label: string): void {
  const dialog = Array.from(document.querySelectorAll<HTMLElement>('.ofd-dialog')).find((item) =>
    item.textContent?.includes('使用本机字体'),
  );
  if (!dialog) throw new Error('没有弹出「使用本机字体」确认框');
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.ofd-dialog__action')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`确认框里没有「${label}」按钮`);
  button.click();
}

describe('授权后补注入（prompt → 允许）', () => {
  it('确认框点「允许」后重开会带上本机字体（不再需要首屏就已授权）', async () => {
    const query = stubLocalFonts('prompt');
    const viewer = new OFDViewer({
      container: document.body,
      source: new ArrayBuffer(8),
      crypto: { enabled: false },
      fonts: { localFonts: { enabled: true, defaultEnabled: true } },
    } as never);
    await viewer.ready;
    // 首屏打开时尚无本机字体注入。
    const families: string[] = engineMocks.open.mock.calls.map((call) =>
      defaultFamilies(call[0] as OFDOpenOptions).join(','),
    );
    expect(families.some((value) => value.includes('宋体')), '授权前不注入').toBe(false);

    await flush(20);

    // 会话打开时没有用户手势：先弹内置确认框，点击前不请求授权。
    expect(query, '点击前不应请求授权').not.toHaveBeenCalled();
    clickGrantDialog('允许');
    expect(query, '点「允许」后在同步栈内请求授权').toHaveBeenCalled();
    await flush(20);
    const afterGrant = engineMocks.open.mock.calls.at(-1)?.[0] as OFDOpenOptions | undefined;
    expect(defaultFamilies(afterGrant), '授权后重开应注入本机字体').toContain('宋体');
    expect(viewer.getLocalFontsStatus().enabled).toBe(true);
    viewer.destroy();
  });
});
