/**
 * 控制台诊断：warning/错误打印、去重与 `debug.console` 关闭开关。
 *
 * 不访问真实网络：引擎被替换为返回最小文档的替身，warning 通过引擎 `onWarning`
 * 回调注入，从而覆盖 viewer 的 reportWarning/reportError 链路。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { OFDViewer } from '../../../src/viewer';
import { resolveViewerOptions } from '../../../src/options';

/** 引擎打开参数的最小结构（只取本测试断言用到的字段）。 */
interface OpenOptions {
  onWarning?: (warning: { code: string; message: string; pageIndex?: number }) => void;
  defaultFonts?: readonly unknown[];
  aliases?: readonly unknown[];
}

/** 构造 1 页的引擎文档替身。 */
function makeDocument(): unknown {
  const infos: PageInfo[] = [{ index: 0, widthMm: 210, heightMm: 297 }];
  return {
    pageCount: 1,
    getPageInfos: async () => infos,
    getPage: async () => ({
      index: 0,
      getSize: () => ({ width: 210, height: 297 }),
      getViewport: () => ({ width: 794, height: 1123 }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => ({ items: [], chars: [] }),
      exportImage: async () => {
        throw new Error('not implemented');
      },
    }),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount: 1 }),
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
  };
}

/**
 * 向引擎替身注入 warning。
 *
 * @param warning 引擎 warning 载荷。
 */
function emitEngineWarning(warning: { code: string; message: string; pageIndex?: number; resourceId?: string }): void {
  const calls = engineMocks.open.mock.calls as unknown as [OpenOptions][];
  const options = calls.at(-1)?.[0];
  options?.onWarning?.(warning);
}

/** console.warn 的 spy；显式标注签名，避免 mock.calls 元素退化为 any。 */
let warnSpy: MockInstance<typeof console.warn>;
/** console.error 的 spy；用途同上。 */
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  document.body.innerHTML = '';
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => makeDocument());
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

describe('控制台诊断', () => {
  it('缺字形 warning 调用 console.warn，同 code+page+resource 只打印一次', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;

    const warning = {
      code: 'W_GLYPH_MISSING',
      message: '字形缺失',
      pageIndex: 0,
      resourceId: 'obj-1',
    };
    emitEngineWarning(warning);
    emitEngineWarning(warning);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[ofd-viewer] warning W_GLYPH_MISSING',
      '字形缺失',
      { pageIndex: 0, resourceId: 'obj-1' },
    );
    viewer.destroy();
  });

  it('缺字体 warning 与不同页/资源分别打印', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;

    emitEngineWarning({ code: 'W_FONT_MISSING', message: '字体缺失' });
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 1 });

    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
      '[ofd-viewer] warning W_FONT_MISSING',
      '[ofd-viewer] warning W_GLYPH_MISSING',
      '[ofd-viewer] warning W_GLYPH_MISSING',
    ]);
    viewer.destroy();
  });

  it('重新打开文档后重置去重集合，同一 warning 再次打印', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });
    await viewer.open(new ArrayBuffer(8));
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    viewer.destroy();
  });

  it('onWarning 回调照常触发且不影响去重打印', async () => {
    const onWarning = vi.fn();
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      onWarning,
    });
    await viewer.ready;
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });

    expect(onWarning).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    viewer.destroy();
  });

  it('debug.console=false 时不打印但仍触发 onWarning 事件', async () => {
    const onWarning = vi.fn();
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      debug: { console: false },
      onWarning,
    });
    await viewer.ready;
    const events: string[] = [];
    viewer.on('warning', (warning) => events.push(warning.code));
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['W_GLYPH_MISSING']);
    viewer.destroy();
  });

  it('错误级诊断用 console.error 打印并按 code+page 去重', async () => {
    engineMocks.open.mockImplementation(async () => ({
      ...(makeDocument() as object),
      getPage: async (index: number) => ({
        index,
        getSize: () => ({ width: 210, height: 297 }),
        getViewport: () => ({ width: 794, height: 1123 }),
        render: () => ({ promise: Promise.reject(new Error('画布绘制失败')), cancel: vi.fn() }),
        getTextContent: async () => ({ items: [], chars: [] }),
        exportImage: async () => {
          throw new Error('not implemented');
        },
      }),
    }));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      renderConcurrency: 1,
    });
    await viewer.ready;
    const errors: string[] = [];
    viewer.on('error', (info) => errors.push(info.code));

    await viewer.goToPage(1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toContain('OFD_RENDER_FAILED');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toBe('[ofd-viewer] error OFD_RENDER_FAILED');
    expect(errorSpy.mock.calls[0]![2]).toEqual({ pageIndex: 0 });
    viewer.destroy();
  });

  it('debug 选项默认开启控制台输出', () => {
    const resolved = resolveViewerOptions({ container: document.body });
    expect(resolved.debug).toBeUndefined();
    const disabled = resolveViewerOptions({ container: document.body, debug: { console: false } });
    expect(disabled.debug?.console).toBe(false);
  });

  it('codes 过滤先于去重：被过滤的 W_GLYPH_MISSING 不占用去重键', async () => {
    const printed: string[] = [];
    // 以码白名单过滤运行时无法验证“同一实例解除过滤”，这里用同一实例 + 放行码断言，
    // 并用 DiagnosticPrinter 单测覆盖“过滤不占键”的语义。
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      debug: { codes: ['W_FONT_MISSING'] },
    });
    await viewer.ready;

    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });
    emitEngineWarning({ code: 'W_FONT_MISSING', message: '字体缺失' });
    emitEngineWarning({ code: 'W_FONT_MISSING', message: '字体缺失' });

    for (const call of warnSpy.mock.calls) printed.push(String(call[0]));
    expect(printed).toEqual(['[ofd-viewer] warning W_FONT_MISSING']);
    viewer.destroy();
  });

  it('levels 只含 error 时 warning 不打印、error 打印', async () => {
    engineMocks.open.mockImplementation(async () => ({
      ...(makeDocument() as object),
      getPage: async (index: number) => ({
        index,
        getSize: () => ({ width: 210, height: 297 }),
        getViewport: () => ({ width: 794, height: 1123 }),
        render: () => ({ promise: Promise.reject(new Error('画布绘制失败')), cancel: vi.fn() }),
        getTextContent: async () => ({ items: [], chars: [] }),
        exportImage: async () => {
          throw new Error('not implemented');
        },
      }),
    }));
    const onWarning = vi.fn();
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      renderConcurrency: 1,
      debug: { levels: ['error'] },
      onWarning,
    });
    await viewer.ready;

    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
    // 回调照常触发，只是不打印。
    expect(onWarning).toHaveBeenCalledTimes(1);

    await viewer.goToPage(1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toBe('[ofd-viewer] error OFD_RENDER_FAILED');
    viewer.destroy();
  });

  it('警告的 code+pageIndex+resourceId 任一不同都分别打印', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0, resourceId: 'a' });
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 0, resourceId: 'b' });
    emitEngineWarning({ code: 'W_GLYPH_MISSING', message: '缺字', pageIndex: 1, resourceId: 'a' });

    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls.map((call) => call[2])).toEqual([
      { pageIndex: 0, resourceId: 'a' },
      { pageIndex: 0, resourceId: 'b' },
      { pageIndex: 1, resourceId: 'a' },
    ]);
    viewer.destroy();
  });

  it('warning 的 resourceId 透传到状态与回调（ViewerWarning.resourceId）', async () => {
    const onWarning = vi.fn();
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      onWarning,
    });
    await viewer.ready;
    emitEngineWarning({ code: 'W_FONT_MISSING', message: '字体缺失', resourceId: '3' });

    expect(onWarning).toHaveBeenCalledWith({ code: 'W_FONT_MISSING', message: '字体缺失', resourceId: '3' });
    expect(viewer.getState().ui.warnings.at(-1)).toEqual({
      code: 'W_FONT_MISSING',
      message: '字体缺失',
      resourceId: '3',
    });
    viewer.destroy();
  });

  it('重新打开文档时清空状态里的 warning 列表（只反映当前文档）', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    emitEngineWarning({ code: 'W_FONT_MISSING', message: '字体缺失', resourceId: '3' });
    expect(viewer.getState().ui.warnings.length).toBeGreaterThan(0);

    // 重开同一来源：上一次打开的历史 warning 不应残留，否则「当前文档是否缺字」
    // 会被历史累积污染（本机字体切换后的重开尤其依赖这一点）。
    await viewer.open(new ArrayBuffer(8));
    expect(
      viewer.getState().ui.warnings.filter((item) => item.code === 'W_FONT_MISSING'),
    ).toHaveLength(0);
    viewer.destroy();
  });
});
