/**
 * UI 加载动画 × 引擎事件集成测试。
 *
 * 用可控的内存引擎 + 真实 `OFDEventBus` 语义替身驱动阅读器，覆盖全屏 loading、
 * 页面骨架/遮罩、取消/错误/关闭清理、主页面与缩略图归属隔离以及 reduced-motion。
 * 这里只验证 UI 对事件序列与 Promise 时序的响应；真实 OFD/浏览器路径见 test/e2e。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
  buses: [] as unknown[],
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  // 未覆盖的引擎导出（常量、类型辅助）保持真实实现，避免新特性读取到 undefined。
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  /**
   * 与引擎 `OFDEventBus` 同步快照/异常隔离语义一致的最小替身。
   */
  class OFDEventBus {
    private readonly listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
    private readonly onListenerError?: (error: unknown, type: string) => void;

    constructor(options: { onListenerError?: (error: unknown, type: string) => void } = {}) {
      this.onListenerError = options.onListenerError;
      engineMocks.buses.push(this);
    }

    on(type: string, handler: (event: Record<string, unknown>) => void): () => void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(handler);
      return () => this.off(type, handler);
    }

    off(type: string, handler: (event: Record<string, unknown>) => void): void {
      const set = this.listeners.get(type);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(type);
    }

    once(type: string, handler: (event: Record<string, unknown>) => void): () => void {
      const wrapper = (event: Record<string, unknown>): void => {
        this.off(type, wrapper);
        handler(event);
      };
      return this.on(type, wrapper);
    }

    removeAllListeners(type?: string): void {
      if (type === undefined) this.listeners.clear();
      else this.listeners.delete(type);
    }

    listenerCount(type: string): number {
      return this.listeners.get(type)?.size ?? 0;
    }

    emit(type: string, event: Record<string, unknown>): void {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(event);
        } catch (error) {
          this.onListenerError?.(error, type);
        }
      }
    }
  }

  class OFDError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: { cause?: unknown }) {
      super(message, options);
      this.name = 'OFDError';
      this.code = code;
    }
  }

  return {
    ...actual,
    OFDDocument: { open: engineMocks.open },
    OFDEventBus,
    OFDError,
    isOFDError: (error: unknown): boolean => error instanceof OFDError,
    toOFDError: (error: unknown): unknown => error,
  };
});

import { OFDError, OFDViewer } from '../../src/index';
import {
  createMockDocument,
  type MockEngineDocument,
  type MockRenderTask,
} from '../helpers/document';
import { installDomEnvironment } from '../helpers/environment';

/** 替身总线的最小接口。 */
interface TestBus {
  on(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  off(type: string, handler: (event: Record<string, unknown>) => void): void;
  removeAllListeners(type?: string): void;
  listenerCount(type: string): number;
  emit(type: string, event: Record<string, unknown>): void;
}

/** 打开调用记录。 */
interface OpenCall {
  readonly operationId: number;
  readonly startedAt: number;
  readonly bus: TestBus;
  readonly signal?: AbortSignal;
  readonly options: Record<string, unknown>;
  settleSuccess(): void;
  settleFailure(error: unknown): void;
  readonly settled: boolean;
}

/** 渲染调用记录。 */
interface RenderCall {
  readonly operationId: number;
  readonly pageIndex: number;
  readonly params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number; dpi: number };
    signal?: AbortSignal;
  };
  readonly bus: TestBus;
  complete(): void;
  fail(error: unknown): void;
  abort(cause?: 'caller' | 'close'): void;
  readonly settled: boolean;
  readonly promise: Promise<void>;
}

/** 运行模式。 */
type Mode = 'auto' | 'manual';

let openMode: Mode = 'auto';
let renderMode: Mode = 'auto';
let operationSequence = 0;
let eventSequence = 0;
let openCalls: OpenCall[] = [];
let renderCalls: RenderCall[] = [];
let activeBus: TestBus | null = null;
let activeDocument: MockEngineDocument | null = null;
let viewers: OFDViewer[] = [];

/**
 * 判断是否已中止。
 *
 * @param signal 信号。
 * @returns 是否已中止。
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * 构造可取消的 abort 错误。
 *
 * @param reason 取消原因。
 * @returns 带 OFD_ABORTED 码的错误。
 */
function abortError(reason?: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : '已取消');
  error.name = 'AbortError';
  Object.assign(error, { code: 'OFD_ABORTED', reason });
  return error;
}

/**
 * 派发一条带公共字段的引擎事件。
 *
 * @param bus 总线。
 * @param type 事件名。
 * @param payload 事件载荷。
 */
function emit(bus: TestBus, type: string, payload: Record<string, unknown>): void {
  eventSequence += 1;
  bus.emit(type, {
    type,
    timestamp: Date.now(),
    sequence: eventSequence,
    ...payload,
  });
}

/**
 * 创建受控引擎替身与阅读器。
 *
 * @param options 页数与打开模式。
 * @returns 阅读器、文档、总线与调用记录。
 */
function createHarness(options: {
  readonly pageCount?: number;
  readonly openMode?: Mode;
  readonly renderMode?: Mode;
  readonly delayPageInfos?: boolean;
} = {}): {
  viewer: OFDViewer;
  document: MockEngineDocument;
  bus: TestBus;
  getPageInfosGate: { resolve(): void; promise: Promise<readonly never[]> } | null;
} {
  openMode = options.openMode ?? 'auto';
  renderMode = options.renderMode ?? 'auto';
  openCalls = [];
  renderCalls = [];
  operationSequence = 0;
  eventSequence = 0;
  activeBus = null;
  viewers = [];

  let pageInfosGate: { resolve(): void; promise: Promise<readonly never[]> } | null = null;
  const engineDocument = createMockDocument({
    pageCount: options.pageCount ?? 4,
    render: (pageIndex, params) => {
      const bus = activeBus;
      if (!bus) throw new Error('测试尚未注入事件总线');
      const operationId = ++operationSequence;
      emit(bus, 'page:render:start', {
        operationId,
        pageIndex,
        dpi: params.viewport.dpi,
        width: params.viewport.width,
        height: params.viewport.height,
      });
      let settled = false;
      let resolveTask: () => void = () => undefined;
      let rejectTask: (error: unknown) => void = () => undefined;
      const promise = new Promise<void>((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
      });
      const call: RenderCall = {
        operationId,
        pageIndex,
        params: params as RenderCall['params'],
        bus,
        get settled() {
          return settled;
        },
        complete: () => {
          if (settled) return;
          settled = true;
          emit(bus, 'page:render:end', { operationId, pageIndex, durationMs: 1 });
          resolveTask();
        },
        fail: (error: unknown) => {
          if (settled) return;
          settled = true;
          emit(bus, 'page:render:error', {
            operationId,
            pageIndex,
            error,
            durationMs: 1,
          });
          rejectTask(error);
        },
        abort: (cause: 'caller' | 'close' = 'caller') => {
          if (settled) return;
          settled = true;
          emit(bus, 'page:render:abort', {
            operationId,
            pageIndex,
            cause,
            reason: abortError(),
            durationMs: 1,
          });
          rejectTask(abortError());
        },
        promise,
      };
      renderCalls.push(call);
      if (renderMode === 'auto') {
        queueMicrotask(() => call.complete());
      }
      return { promise, cancel: () => call.abort('caller') } satisfies MockRenderTask;
    },
  });
  if (options.delayPageInfos) {
    let resolveGate: (value: readonly never[]) => void = () => undefined;
    const promise = new Promise<readonly never[]>((resolve) => {
      resolveGate = resolve;
    });
    pageInfosGate = {
      resolve: () => resolveGate([]),
      promise,
    };
    engineDocument.getPageInfos = () => pageInfosGate!.promise;
  }
  activeDocument = engineDocument;
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation((openOptions: Record<string, unknown>) => {
    const bus = openOptions.eventBus as TestBus;
    activeBus = bus;
    const startedAt = performance.now();
    const operationId = ++operationSequence;
    emit(bus, 'document:open:start', {
      operationId,
      sourceKind: 'arraybuffer',
      documentIndex: 0,
      viaContainer: false,
    });
    let settled = false;
    let resolveOpen: (value: MockEngineDocument) => void = () => undefined;
    let rejectOpen: (error: unknown) => void = () => undefined;
    const promise = new Promise<MockEngineDocument>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const call: OpenCall = {
      operationId,
      startedAt,
      bus,
      signal: openOptions.signal as AbortSignal | undefined,
      options: openOptions,
      get settled() {
        return settled;
      },
      settleSuccess: () => {
        if (settled) return;
        settled = true;
        emit(bus, 'document:open:end', {
          operationId,
          pageCount: engineDocument.pageCount,
          version: '1.0',
          packageSize: 8,
          durationMs: 1,
        });
        resolveOpen(engineDocument);
      },
      settleFailure: (error: unknown) => {
        if (settled) return;
        settled = true;
        emit(bus, 'document:open:error', {
          operationId,
          error,
          durationMs: 1,
        });
        rejectOpen(error);
      },
    };
    openCalls.push(call);
    if (openMode === 'auto') {
      queueMicrotask(() => call.settleSuccess());
    } else {
      call.signal?.addEventListener(
        'abort',
        () => {
          if (settled) return;
          settled = true;
          emit(bus, 'document:open:abort', {
            operationId,
            cause: 'caller',
            reason: call.signal?.reason ?? abortError(),
            durationMs: 1,
          });
          rejectOpen(abortError(call.signal?.reason));
        },
        { once: true },
      );
    }
    return promise;
  });

  const viewer = new OFDViewer({
    container: document.body,
    source: new ArrayBuffer(8),
    crypto: { enabled: false },
  });
  viewers.push(viewer);
  return { viewer, document: engineDocument, bus: engineMocks.buses.at(-1) as TestBus, getPageInfosGate: pageInfosGate };
}

/**
 * 读取全屏 loading DOM 状态。
 *
 * @param viewer 阅读器。
 * @returns 状态与错误卡。
 */
function overlayState(viewer: OFDViewer): {
  status: HTMLElement;
  error: HTMLElement;
  visible: boolean;
  errorVisible: boolean;
} {
  const root = viewer.getRoot();
  const status = root.querySelector<HTMLElement>('.ofd-viewer__loading');
  const error = root.querySelector<HTMLElement>('.ofd-viewer__loading-error');
  if (!status || !error) throw new Error('全屏 loading DOM 缺失');
  return { status, error, visible: !status.hidden, errorVisible: !error.hidden };
}

/**
 * 读取指定页的 loading DOM 状态。
 *
 * @param viewer 阅读器。
 * @param pageNumber 页码，1-based。
 * @returns 页元素与 loading 层。
 */
function pageLoading(viewer: OFDViewer, pageNumber: number): {
  page: HTMLElement;
  loading: HTMLElement;
  error: HTMLElement;
  visible: boolean;
  errorVisible: boolean;
} {
  const page = viewer.getPageView(pageNumber)?.element;
  if (!page) throw new Error(`页 ${pageNumber} 不存在`);
  const loading = page.querySelector<HTMLElement>('.ofd-page__loading');
  const error = page.querySelector<HTMLElement>('.ofd-page__error');
  if (!loading || !error) throw new Error('页面 loading DOM 缺失');
  return { page, loading, error, visible: !loading.hidden, errorVisible: !error.hidden };
}

/** 全屏 loading 显示后的最短展示时长，单位毫秒（与 viewer.ts 的常量保持一致）。 */
const DOCUMENT_LOADING_MIN_VISIBLE_MS = 300;

/**
 * 等待指定毫秒。
 *
 * @param ms 时长，单位毫秒。
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待条件成立。
 *
 * @param predicate 条件。
 * @param timeout 超时，单位毫秒。
 */
async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待条件超时');
    await wait(10);
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
  vi.useRealTimers();
});

afterEach(() => {
  for (const viewer of viewers.splice(0)) {
    try {
      viewer.destroy();
    } catch {
      // destroy 的异常不应影响其他用例清理。
    }
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('文档全屏 loading 与引擎打开事件', () => {
  it('小文件打开完成后立即显示全屏 loading，首屏渲染完成才淡出', async () => {
    const { viewer } = createHarness({ pageCount: 1, openMode: 'auto', renderMode: 'manual' });
    const root = viewer.getRoot();
    let shown = false;
    const observer = new MutationObserver(() => {
      const status = root.querySelector<HTMLElement>('.ofd-viewer__loading');
      if (status && !status.hidden) shown = true;
    });
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    // 打开耗时低于 150ms 也不跳过加载反馈：页壳就绪、首屏尚未画完时遮罩已显示。
    expect(shown).toBe(true);
    expect(overlayState(viewer).visible).toBe(true);
    expect(viewer.getPageView(1)?.state).not.toBe('rendered');

    renderCalls[0]!.complete();
    await until(() => overlayState(viewer).visible === false, 1000);
    observer.disconnect();
    expect(viewer.getPageView(1)?.state).toBe('rendered');
  });

  it('慢文件打开期间显示全屏 loading，完成后满足最短展示并淡出', async () => {
    const { viewer, bus } = createHarness({ openMode: 'manual', renderMode: 'manual' });
    await until(() => openCalls.length > 0);
    const call = openCalls[0]!;
    // 首次打开没有旧画面可看：遮罩从 open() 入口立即显示，不等 150ms 延迟。
    expect(overlayState(viewer).visible).toBe(true);
    const afterDelay = Math.max(0, 160 - (performance.now() - call.startedAt));
    if (afterDelay > 0) await wait(afterDelay);
    // 全量并发时 jsdom 事件循环可能延迟定时器；等待实际展示，避免固定 sleep 抖动。
    await until(() => overlayState(viewer).visible, 1000);
    const shown = overlayState(viewer);
    expect(shown.visible).toBe(true);
    expect(shown.status.getAttribute('role')).toBe('status');
    expect(shown.status.getAttribute('aria-busy')).toBe('true');
    expect(shown.status.querySelector('.ofd-viewer__loading-name')?.textContent).toBe('文档');
    expect(shown.status.querySelector('.ofd-viewer__loading-ring')).not.toBeNull();

    /** 全屏 loading 控制器：最短展示从展示时刻起算。 */
    const overlay = (viewer as unknown as { documentLoading: { shownAt: number } }).documentLoading;
    call.settleSuccess();
    await viewer.ready;
    // 打开完成不结束遮罩：首屏仍在渲染，继续由全屏 loading 覆盖。
    await wait(50);
    expect(overlayState(viewer).visible).toBe(true);
    await until(() => renderCalls.length > 0);
    renderCalls[0]!.complete();
    // finish() 按“展示时刻 + 300ms 最短展示”安排淡出；打开耗时本身已占去一部分，
    // 因此按剩余时长计算等待，避免固定 sleep 在慢机上越过淡出窗口而漏掉“仍在展示”的断言。
    const remainingVisible = Math.max(
      0,
      overlay.shownAt + DOCUMENT_LOADING_MIN_VISIBLE_MS - Date.now(),
    );
    await wait(Math.max(0, remainingVisible - 50));
    // 最短展示未满：仍在展示，不是立即隐藏。
    expect(overlayState(viewer).visible).toBe(true);
    // 最短展示满后再等 150ms 淡出结束，遮罩隐藏。
    await until(() => overlayState(viewer).visible === false, 1000);
    expect(bus.listenerCount('document:open:start')).toBe(1);
  });

  it('已有文档时切换文档保留 150ms 延迟，快速切换不闪遮罩', async () => {
    const { viewer } = createHarness({ pageCount: 1, openMode: 'manual', renderMode: 'auto' });
    await until(() => openCalls.length > 0);
    openCalls[0]!.settleSuccess();
    await viewer.ready;
    await until(() => overlayState(viewer).visible === false, 1000);
    expect(viewer.getState().document.status).toBe('ready');

    // 第二次打开：此时已有可见画面，延迟窗口内不应出现遮罩。
    void viewer.open('samples/other.ofd');
    await until(() => openCalls.length > 1);
    const second = openCalls[1]!;
    expect(overlayState(viewer).visible).toBe(false);
    const beforeDelay = Math.max(0, 100 - (performance.now() - second.startedAt));
    if (beforeDelay > 0) await wait(beforeDelay);
    expect(overlayState(viewer).visible).toBe(false);
  });

  it('新打开进行中收到旧打开的 abort，不收起新遮罩', async () => {
    const { viewer, bus } = createHarness({ pageCount: 1, openMode: 'manual', renderMode: 'auto' });
    await until(() => openCalls.length > 0);
    const first = openCalls[0]!;
    expect(overlayState(viewer).visible).toBe(true);

    // 新的 open() 会 abort 上一次打开；随后旧的 abort 事件才异步到达。
    void viewer.open('samples/second.ofd');
    await until(() => openCalls.length > 1);
    expect(overlayState(viewer).visible).toBe(true);
    emit(bus, 'document:open:abort', {
      operationId: first.operationId,
      cause: 'caller',
      reason: abortError(),
      durationMs: 1,
    });
    await wait(20);
    // 旧操作已归属到上一轮，不得影响本次打开的全屏遮罩。
    expect(overlayState(viewer).visible).toBe(true);
  });

  it('首屏渲染完成前正文区显示加载占位，完成后与全屏 loading 一起撤掉', async () => {
    const { viewer } = createHarness({ pageCount: 2, openMode: 'auto', renderMode: 'manual' });
    const area = viewer.getRoot().querySelector<HTMLElement>('.ofd-viewer__loading-area');
    expect(area).not.toBeNull();
    expect(area!.hidden).toBe(true);
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    // 页壳已就绪、首屏仍在渲染：正文区由占位覆盖，不是空白。
    expect(area!.hidden).toBe(false);
    expect(area!.querySelector('.ofd-viewer__loading-area-skeleton')).not.toBeNull();
    expect(area!.querySelector('.ofd-page__loading-spinner')).not.toBeNull();
    expect(area!.querySelector('.ofd-viewer__loading-area-text')?.textContent).toBe(
      '正在渲染页面…',
    );

    renderCalls.find((call) => call.pageIndex === 0)!.complete();
    await until(() => area!.hidden);
    expect(area!.hidden).toBe(true);
  });

  it('打开失败时不显示首屏加载占位', async () => {
    const { viewer } = createHarness({ openMode: 'manual' });
    await until(() => openCalls.length > 0);
    openCalls[0]!.settleFailure(new OFDError('OFD_ENTRY_NOT_FOUND', '模拟包损坏'));
    await expect(viewer.ready).rejects.toMatchObject({ code: 'OFD_ENTRY_NOT_FOUND' });
    const area = viewer.getRoot().querySelector<HTMLElement>('.ofd-viewer__loading-area');
    expect(area!.hidden).toBe(true);
  });

  it('取消打开立即隐藏 loading、回到空态且不显示错误卡', async () => {
    const { viewer } = createHarness({ openMode: 'manual' });
    await wait(160);
    const state = overlayState(viewer);
    expect(state.visible).toBe(true);
    const cancel = state.status.querySelector<HTMLButtonElement>('.ofd-viewer__loading-button')!;
    cancel.click();

    expect(overlayState(viewer).visible).toBe(false);
    expect(cancel.textContent).toBe('正在取消…');
    expect(cancel.disabled).toBe(true);
    expect(overlayState(viewer).errorVisible).toBe(false);
    await viewer.ready;
    expect(viewer.getState().document.status).toBe('closed');
    expect(viewer.getPageCount()).toBe(0);
    await wait(200);
    expect(overlayState(viewer).errorVisible).toBe(false);
  });

  it('引擎已打开但 UI 未完成布局时取消，会关闭已打开文档', async () => {
    const { viewer, document, getPageInfosGate } = createHarness({
      openMode: 'manual',
      delayPageInfos: true,
    });
    await until(() => openCalls.length > 0);
    openCalls[0]!.settleSuccess();
    await until(() => getPageInfosGate !== null);
    await wait(160);
    expect(overlayState(viewer).visible).toBe(true);
    overlayState(viewer).status
      .querySelector<HTMLButtonElement>('.ofd-viewer__loading-button')!
      .click();
    getPageInfosGate!.resolve();

    await viewer.ready;
    expect(document.closeCalls).toBe(1);
    expect(viewer.getState().document.status).toBe('closed');
    expect(overlayState(viewer).visible).toBe(false);
  });

  it('打开失败立即显示错误卡；点击重试可成功打开', async () => {
    const { viewer, document } = createHarness({ openMode: 'manual' });
    await until(() => openCalls.length > 0);
    openCalls[0]!.settleFailure(new OFDError('OFD_ENTRY_NOT_FOUND', '模拟包损坏'));
    await expect(viewer.ready).rejects.toMatchObject({ code: 'OFD_ENTRY_NOT_FOUND' });
    const failed = overlayState(viewer);
    expect(failed.errorVisible).toBe(true);
    expect(failed.visible).toBe(false);
    expect(failed.error.getAttribute('role')).toBe('alert');
    expect(failed.error.querySelector('.ofd-viewer__loading-error-code')?.textContent).toBe(
      'OFD_ENTRY_NOT_FOUND',
    );
    expect(failed.error.querySelector('.ofd-viewer__loading-error-message')?.textContent).toBe(
      '模拟包损坏',
    );

    // 重试走最近一次来源；下一次打开成功后错误卡隐藏，遮罩随首屏渲染收尾。
    openMode = 'auto';
    renderMode = 'auto';
    failed.error
      .querySelector<HTMLButtonElement>('.ofd-viewer__loading-button--primary')!
      .click();
    await until(() => viewer.getPageCount() === document.pageCount && viewer.getState().document.status === 'ready');
    await until(() => overlayState(viewer).visible === false, 1000);
    expect(overlayState(viewer).errorVisible).toBe(false);
  });

  it('关闭文档立即清理全屏 loading 与页面 loading', async () => {
    const { viewer } = createHarness({ openMode: 'manual' });
    await wait(160);
    expect(overlayState(viewer).visible).toBe(true);
    await viewer.close();
    expect(overlayState(viewer).visible).toBe(false);
    expect(viewer.getState().document.status).toBe('closed');

    // 重新打开并让页面 loading 处于显示状态，再关闭。
    openMode = 'auto';
    await viewer.open(new ArrayBuffer(8));
    await viewer.ready;
    renderMode = 'manual';
    viewer.setScale(1.2);
    await until(() => renderCalls.some((call) => !call.settled));
    const active = [...renderCalls].reverse().find((call) => !call.settled)!;
    const activePage = pageLoading(viewer, active.pageIndex + 1);
    await wait(170);
    expect(activePage.page.getAttribute('aria-busy')).toBe('true');
    await viewer.close();
    expect(activePage.loading.hidden).toBe(true);
    expect(activePage.page.hasAttribute('aria-busy')).toBe(false);
    expect(overlayState(viewer).visible).toBe(false);
  });
});

describe('页面 loading 与引擎渲染事件', () => {
  it('首次渲染超过 150ms 显示骨架 + spinner，结束后按最短展示淡出', async () => {
    const { viewer } = createHarness({ openMode: 'auto', renderMode: 'manual' });
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    const call = renderCalls[0]!;
    const target = pageLoading(viewer, call.pageIndex + 1);
    expect(target.page.dataset.pageState).not.toBe('rendered');
    await wait(140);
    expect(pageLoading(viewer, call.pageIndex + 1).visible).toBe(false);
    await wait(20);
    const shown = pageLoading(viewer, call.pageIndex + 1);
    expect(shown.visible).toBe(true);
    expect(shown.loading.dataset.variant).toBe('skeleton');
    expect(shown.loading.querySelector('.ofd-page__loading-spinner')).not.toBeNull();
    expect(shown.loading.querySelector('.ofd-page__loading-skeleton')).not.toBeNull();
    expect(shown.page.getAttribute('aria-busy')).toBe('true');

    call.complete();
    await wait(220);
    expect(pageLoading(viewer, call.pageIndex + 1).visible).toBe(true);
    await wait(140);
    expect(pageLoading(viewer, call.pageIndex + 1).visible).toBe(false);
    expect(pageLoading(viewer, call.pageIndex + 1).page.dataset.pageState).toBe('rendered');
  });

  it('渲染在 150ms 内结束时不显示骨架', async () => {
    const { viewer } = createHarness({ openMode: 'auto', renderMode: 'manual' });
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    const call = renderCalls[0]!;
    await wait(100);
    expect(pageLoading(viewer, call.pageIndex + 1).visible).toBe(false);
    call.complete();
    await wait(100);
    expect(pageLoading(viewer, call.pageIndex + 1).visible).toBe(false);
  });

  it('重渲染保留旧 canvas 并切换为遮罩层', async () => {
    const { viewer } = createHarness({ openMode: 'auto', renderMode: 'manual' });
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    const first = renderCalls[0]!;
    first.complete();
    await wait(50);
    expect(pageLoading(viewer, first.pageIndex + 1).page.dataset.pageState).toBe('rendered');
    const canvas = pageLoading(viewer, first.pageIndex + 1).page.querySelector('canvas');
    expect(canvas).not.toBeNull();

    viewer.setScale(1.2);
    await until(() => renderCalls.some((call) => call.pageIndex === first.pageIndex && !call.settled && call !== first));
    const second = renderCalls
      .filter((call) => call.pageIndex === first.pageIndex && call !== first)
      .at(-1)!;
    await wait(160);
    const shown = pageLoading(viewer, second.pageIndex + 1);
    expect(shown.visible).toBe(true);
    expect(shown.loading.dataset.variant).toBe('overlay');
    expect(shown.page.contains(canvas!)).toBe(true);
    second.complete();
    await wait(50);
  });

  it('渲染失败显示错误卡，点击重试重新发起渲染并清除错误', async () => {
    const { viewer } = createHarness({ openMode: 'auto', renderMode: 'manual' });
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    const call = renderCalls[0]!;
    call.fail(new OFDError('OFD_RENDERER_UNSUPPORTED', '模拟绘制失败'));
    await wait(20);
    const failed = pageLoading(viewer, call.pageIndex + 1);
    expect(failed.errorVisible).toBe(true);
    expect(failed.error.getAttribute('role')).toBe('alert');
    expect(failed.error.querySelector('.ofd-page__error-code')?.textContent).toBe(
      'OFD_RENDERER_UNSUPPORTED',
    );
    expect(failed.error.querySelector('.ofd-page__error-message')?.textContent).toBe('模拟绘制失败');
    expect(failed.visible).toBe(false);

    const before = renderCalls.length;
    failed.error.querySelector<HTMLButtonElement>('.ofd-page__retry')!.click();
    await until(() => renderCalls.length > before);
    renderCalls.at(-1)!.complete();
    await wait(20);
    expect(pageLoading(viewer, call.pageIndex + 1).errorVisible).toBe(false);
  });

  it('abort 静默隐藏 loading，不显示错误卡', async () => {
    const { viewer } = createHarness({ openMode: 'auto', renderMode: 'manual' });
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    const call = renderCalls[0]!;
    await wait(160);
    expect(pageLoading(viewer, call.pageIndex + 1).visible).toBe(true);
    call.abort('caller');
    await wait(20);
    const state = pageLoading(viewer, call.pageIndex + 1);
    expect(state.visible).toBe(false);
    expect(state.errorVisible).toBe(false);
  });

  it('缩略图 operation 不触发主页面骨架；主页面 operation 正常触发', async () => {
    const { viewer, bus } = createHarness({ openMode: 'auto', renderMode: 'manual' });
    await viewer.ready;
    const tracker = viewer as unknown as {
      trackPageRenderStart(pageIndex: number, purpose: 'main' | 'thumbnail'): { drop(): void };
    };
    // 使用未在首屏渲染的页 4，避免首屏任务干扰断言。
    const pageIndex = 3;
    const target = pageLoading(viewer, pageIndex + 1).page;
    expect(target.hasAttribute('aria-busy')).toBe(false);

    tracker.trackPageRenderStart(pageIndex, 'thumbnail');
    emit(bus, 'page:render:start', {
      operationId: 9001,
      pageIndex,
      dpi: 96,
      width: 100,
      height: 100,
    });
    expect(pageLoading(viewer, pageIndex + 1).visible).toBe(false);
    expect(target.hasAttribute('aria-busy')).toBe(false);

    tracker.trackPageRenderStart(pageIndex, 'main');
    emit(bus, 'page:render:start', {
      operationId: 9002,
      pageIndex,
      dpi: 96,
      width: 100,
      height: 100,
    });
    expect(target.getAttribute('aria-busy')).toBe('true');
    emit(bus, 'page:render:abort', {
      operationId: 9002,
      pageIndex,
      cause: 'caller',
      reason: abortError(),
      durationMs: 1,
    });
    expect(target.hasAttribute('aria-busy')).toBe(false);
  });

  it('reduced-motion 下页面 loading 结束立即隐藏，不进入淡出', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });
    const { viewer } = createHarness({ openMode: 'auto', renderMode: 'manual' });
    await viewer.ready;
    await until(() => renderCalls.length > 0);
    const call = renderCalls[0]!;
    await wait(160);
    expect(pageLoading(viewer, call.pageIndex + 1).visible).toBe(true);
    call.complete();
    await wait(230);
    const state = pageLoading(viewer, call.pageIndex + 1);
    expect(state.visible).toBe(false);
    expect(state.loading.hasAttribute('data-fading')).toBe(false);
  });
});