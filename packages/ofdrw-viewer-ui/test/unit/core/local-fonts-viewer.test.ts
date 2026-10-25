/**
 * viewer 层本机字体测试（设计 §3.5、§4，需求清单 REQ-0220~REQ-0270，§10 T-V1~T-V5）。
 *
 * 复用 `viewer.test.ts` 的引擎替身写法：把 `OFDDocument.open` 整个换成桩，断言的是
 * 阅读器自己的行为——开关生效值解析、授权流程只在用户手势里查询、拒绝后本会话不再打扰、
 * 重开时恢复页码/缩放/旋转、状态事件同源且退订生效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
  // 字体别名表被 `composeFontAliases()` / 候选展开直接引用，mock 里必须提供。
  DEFAULT_FONT_ALIASES: [['宋体', 'simsun', 'songti', 'stsong']],
}));

import { OFDViewer } from '../../../src/viewer';
import type { LocalFontsStatus } from '../../../src/local-fonts-state';

/** 存储键（REQ-008）。 */
const STORAGE_KEY = 'ofd-viewer:local-fonts';

/** 引擎替身页。 */
interface FakePage {
  index: number;
  getSize: () => { width: number; height: number };
  getViewport: (options?: { dpi?: number }) => { width: number; height: number };
  render: (params: { canvasContext: { clearRect: (...args: number[]) => void }; signal?: AbortSignal }) => {
    promise: Promise<void>;
    cancel: () => void;
  };
  getTextContent: () => Promise<{ items: never[]; chars: never[] }>;
  exportImage: () => Promise<never>;
}

/**
 * 构造页信息。
 *
 * @param count 页数。
 * @returns 页信息数组。
 */
function makeInfos(count: number): PageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    widthMm: 210,
    heightMm: 297,
  }));
}

/**
 * 构造单页替身。
 *
 * @param index 0-based 页索引。
 * @returns 页替身。
 */
function makePage(index: number): FakePage {
  return {
    index,
    getSize: () => ({ width: 210, height: 297 }),
    getViewport: (options = {}) => {
      const dpi = options.dpi ?? 96;
      return {
        width: Math.ceil((210 / 25.4) * dpi),
        height: Math.ceil((297 / 25.4) * dpi),
      };
    },
    render: (params) => {
      params.canvasContext.clearRect(0, 0, 1, 1);
      return { promise: Promise.resolve(), cancel: vi.fn() };
    },
    getTextContent: async () => ({ items: [], chars: [] }),
    exportImage: async () => {
      throw new Error('not implemented');
    },
  };
}

/**
 * 构造最小引擎文档替身；`getFontResources` 返回声明的字体。
 *
 * @param count 页数。
 * @param fonts 文档声明的字体资源。
 * @returns 文档替身。
 */
function makeDocument(
  count = 3,
  fonts: ReadonlyArray<{ id: string; fontName: string }> = [],
): unknown {
  return {
    pageCount: count,
    getPageInfos: async () => makeInfos(count),
    getPage: async (index: number) => makePage(index),
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
    getFontResources: async () =>
      fonts.map((font) => ({
        id: font.id,
        fontName: font.fontName,
        charset: 'unicode',
        serif: true,
        bold: false,
        italic: false,
        fixedSize: false,
        documentLevel: true,
      })),
    close: async () => undefined,
  };
}

/**
 * 安装 `queryLocalFonts` 替身。
 *
 * @param installed 已安装字体：PostScript 名 → 是否命中。
 * @returns 查询替身。
 */
function stubQuery(installed: Readonly<Record<string, boolean>> = { SimSun: true }) {
  const query = vi.fn(async (options?: { postscriptNames?: readonly string[] }) => {
    const names = options?.postscriptNames ?? [];
    return names
      .filter((name) => installed[name])
      .map((name) => ({
        postscriptName: name,
        fullName: name,
        family: name,
        style: 'Regular',
        blob: async () => new Blob([new Uint8Array([0, 1, 0, 0])]),
      }));
  });
  vi.stubGlobal('queryLocalFonts', query);
  return query;
}

/**
 * 安装权限查询替身。
 *
 * @param state 权限状态。
 * @returns 权限查询替身。
 */
function stubPermissions(state: 'granted' | 'denied' | 'prompt') {
  const query = vi.fn(async () => ({ state, onchange: null }));
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    writable: true,
    value: { query },
  });
  return query;
}

/** 打开确认框（按文案定位，与实现细节解耦）。 */
function localFontsDialog(): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('.ofd-dialog'));
  return dialogs.find((dialog) => dialog.textContent?.includes('使用本机字体')) ?? null;
}

/**
 * 点击确认框里的按钮。
 *
 * @param kind `allow` 主按钮；`deny` 次按钮。
 */
function clickDialog(kind: 'allow' | 'deny'): void {
  const dialog = localFontsDialog();
  if (!dialog) throw new Error('确认框未打开');
  const selector =
    kind === 'allow'
      ? '.ofd-dialog__action--primary'
      : '.ofd-dialog__action:not(.ofd-dialog__action--primary)';
  (dialog.querySelector(selector) as HTMLButtonElement).click();
}

/** 等待若干个宏任务（重开流程跨多个 await）。 */
async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 创建阅读器并等待首次打开完成。 */
async function createViewer(
  fonts: Record<string, unknown> | undefined,
  options: { source?: ArrayBuffer } = {},
): Promise<OFDViewer> {
  const viewer = new OFDViewer({
    crypto: { enabled: false },
    container: document.body,
    source: options.source ?? new ArrayBuffer(8),
    ...(fonts ? { fonts } : {}),
  } as never);
  await viewer.ready;
  return viewer;
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  // 上一个用例遗留的订阅者/对话框会跨用例影响「是否弹框」的判定，逐例重置。
  sessionStorage.clear();
  for (const dialog of Array.from(document.querySelectorAll('.ofd-dialog'))) {
    dialog.remove();
  }
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () =>
    makeDocument(3, [{ id: '1', fontName: '宋体' }]),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OFDViewer 本机字体开关生效值（T-V1）', () => {
  it('未配置 fonts / 未配置 localFonts / enabled=false：能力均不生效且不可见', async () => {
    stubQuery();
    stubPermissions('granted');
    for (const fonts of [
      undefined,
      {},
      { localFonts: {} },
      { localFonts: { enabled: false, defaultEnabled: true } },
    ]) {
      const viewer = await createViewer(fonts as Record<string, unknown> | undefined);
      const status = viewer.getLocalFontsStatus();
      expect(status.enabled, `配置 ${JSON.stringify(fonts)} 的 enabled`).toBe(false);
      // 宿主未允许时能力不可见：`visible` 是「是否展示开关」的权威字段。
      expect(status.visible, `配置 ${JSON.stringify(fonts)} 的 visible`).toBe(false);
      viewer.destroy();
      document.body.innerHTML = '';
    }
  });

  it('浏览器不支持 queryLocalFonts 时能力不生效且不可见', async () => {
    vi.stubGlobal('queryLocalFonts', undefined);
    stubPermissions('granted');
    const viewer = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    const status = viewer.getLocalFontsStatus();
    expect(status.supported).toBe(false);
    expect(status.enabled).toBe(false);
    viewer.destroy();
  });

  it('宿主默认值生效；用户选择优先于宿主默认值', async () => {
    stubQuery();
    stubPermissions('granted');
    const first = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    expect(first.getLocalFontsStatus().enabled).toBe(true);
    expect(first.getLocalFontsStatus().supported).toBe(true);
    first.destroy();

    // 用户显式关闭后：即使宿主默认值仍为 true，下次创建也按用户选择关闭。
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: false, notified: true }));
    const second = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    expect(second.getLocalFontsStatus().enabled).toBe(false);
    second.destroy();
  });

  it('记住的选择只在 remember !== false 时生效', async () => {
    stubQuery();
    stubPermissions('granted');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: false, notified: true }));
    const viewer = await createViewer({
      localFonts: { enabled: true, defaultEnabled: true, remember: false },
    });
    // remember=false：不读记忆，回到宿主默认值。
    expect(viewer.getLocalFontsStatus().enabled).toBe(true);
    viewer.destroy();
  });
});

describe('OFDViewer 授权流程（T-V2、T-V4）', () => {
  it('T-V4 没有用户手势时不调用 queryLocalFonts', async () => {
    const query = stubQuery();
    stubPermissions('prompt');
    const viewer = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    await flush();
    expect(query, '未点击允许前不得查询').not.toHaveBeenCalled();
    // 首次打开会弹确认框，但不会自行申请权限。
    expect(localFontsDialog(), '确认框').not.toBeNull();
    viewer.destroy();
  });

  it('点「允许」后在同一手势内同步调用 queryLocalFonts', async () => {
    const query = stubQuery({ SimSun: true });
    stubPermissions('prompt');
    const viewer = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    await flush();
    clickDialog('allow');
    // 同步调用：点击后立刻（未等待任何宏任务）就应看到查询。
    expect(query).toHaveBeenCalledTimes(1);
    const options = query.mock.calls[0]?.[0] as { postscriptNames?: readonly string[] } | undefined;
    expect(Object.keys(options ?? {})).toEqual(['postscriptNames']);
    expect(options?.postscriptNames).toContain('SimSun');
    await flush();
    viewer.destroy();
  });

  it('T-V2 拒绝后本会话不再询问：再次 open() 不弹框且不查询', async () => {
    const query = stubQuery();
    stubPermissions('prompt');
    const viewer = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    await flush();
    expect(localFontsDialog()).not.toBeNull();
    clickDialog('deny');
    await flush();
    expect(localFontsDialog()).toBeNull();
    expect(viewer.getLocalFontsStatus().enabled, '拒绝后开关关闭').toBe(false);
    // 拒绝写入用户选择（本会话 + 记忆）。
    const stored = localStorage.getItem(STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual({ enabled: false, notified: true });

    await viewer.open(new ArrayBuffer(8));
    await flush();
    expect(localFontsDialog(), '再次打开不再询问').toBeNull();
    expect(query, '拒绝后不查询').not.toHaveBeenCalled();
    viewer.destroy();
  });

  it('Esc/遮罩关闭确认框视同不允许，但不写用户选择（下次仍询问）', async () => {
    stubQuery();
    stubPermissions('prompt');
    const viewer = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    await flush();
    expect(localFontsDialog()).not.toBeNull();
    // Esc 由焦点陷阱转发为 close()。
    const dialog = localFontsDialog() as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(localFontsDialog()).toBeNull();
    // Esc 不写入「用户选择关闭」：持久化的 enabled 不得变成 false
    // （notified 在弹框前即置位，不能作为判断依据）。
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) expect(JSON.parse(stored).enabled).not.toBe(false);

    await viewer.open(new ArrayBuffer(8));
    await flush();
    expect(localFontsDialog(), 'Esc 后下次打开仍询问').not.toBeNull();
    viewer.destroy();
  });
});

describe('OFDViewer 重开与视图恢复（T-V3、T-V5）', () => {
  it('T-V3 重开后恢复页码/缩放/旋转', async () => {
    stubQuery({ SimSun: true });
    stubPermissions('granted');
    const viewer = await createViewer({ localFonts: { enabled: true } });
    // 5 页文档，切到第 3 页、放大到 2 倍、旋转 90。
    engineMocks.open.mockImplementation(async () =>
      makeDocument(5, [{ id: '1', fontName: '宋体' }]),
    );
    await viewer.open(new ArrayBuffer(16));
    await viewer.goToPage(3);
    await viewer.setScale(2);
    await viewer.setRotation(90);
    await flush(4);
    // jsdom 没有真实布局：`auto` 之外的倍率会被「适合宽度」再钳一次，
    // 因此以重开前的实际值为基准，断言重开后与之完全一致（恢复语义本身）。
    const before = viewer.getState().view;
    expect(before.pageNumber).toBe(3);
    expect(before.rotation).toBe(90);

    const opens = engineMocks.open.mock.calls.length;
    await viewer.setLocalFontsEnabled(true);
    await flush(20);

    const after = viewer.getState().view;
    expect(engineMocks.open.mock.calls.length, '开关变更触发重开').toBeGreaterThan(opens);
    expect(after.pageNumber, '页码').toBe(before.pageNumber);
    expect(after.scale, '缩放').toBeCloseTo(before.scale, 5);
    expect(after.rotation, '旋转').toBe(before.rotation);
    expect(viewer.getLocalFontsStatus().enabled).toBe(true);
    viewer.destroy();
  });

  it('T-V5 local-fonts:change 与订阅者同源、无重复派发；退订后不再收到', async () => {
    stubQuery({ SimSun: true });
    stubPermissions('granted');
    const viewer = await createViewer({ localFonts: { enabled: true } });
    const events: LocalFontsStatus[] = [];
    const handler = vi.fn();
    const off = viewer.onLocalFontsStatusChange(handler);
    viewer.on('local-fonts:change', (detail) => events.push(detail));

    await viewer.setLocalFontsEnabled(true);
    await flush(20);
    // 开关变化会经历 loading 中间态，因此会多次广播；关键是：
    // ①状态确实变化过、②核心事件与订阅者一一对应（同源，不重复派发）。
    expect(events.length, 'local-fonts:change 次数').toBeGreaterThan(0);
    expect(handler.mock.calls.length, '订阅者次数与核心事件一致').toBe(events.length);
    // 没有相邻两次完全相同的状态（不重复派发）。
    for (let index = 1; index < events.length; index += 1) {
      expect(JSON.stringify(events[index]), `第 ${index} 次广播`).not.toBe(
        JSON.stringify(events[index - 1]),
      );
    }
    const last = events.at(-1) as LocalFontsStatus;
    expect(last.enabled, '最终 enabled').toBe(true);
    expect(last.loading, '最终 loading').toBe(false);

    off();
    const before = handler.mock.calls.length;
    const eventCount = events.length;
    await viewer.setLocalFontsEnabled(false);
    await flush(20);
    expect(handler.mock.calls.length, '退订后回调次数不变').toBe(before);
    expect(events.length, '核心事件仍继续广播').toBeGreaterThan(eventCount);
    viewer.destroy();
  });

  it('关闭开关后立即重开当前文档，并保持视图', async () => {
    stubQuery({ SimSun: true });
    stubPermissions('granted');
    const viewer = await createViewer({ localFonts: { enabled: true, defaultEnabled: true } });
    await viewer.goToPage(2);
    // 首次打开可能补一次「带上本机字体」的重开，页码会被恢复；等状态稳定再取基准。
    await flush(20);
    const before = viewer.getState().view;
    expect(before.pageNumber).toBe(2);
    const opens = engineMocks.open.mock.calls.length;

    await viewer.setLocalFontsEnabled(false);
    await flush(20);
    expect(engineMocks.open.mock.calls.length, '关开关触发重开').toBeGreaterThan(opens);
    const after = viewer.getState().view;
    expect(after.pageNumber, '页码').toBe(before.pageNumber);
    expect(after.scale, '缩放').toBeCloseTo(before.scale, 5);
    expect(viewer.getLocalFontsStatus().enabled).toBe(false);
    viewer.destroy();
  });
});
