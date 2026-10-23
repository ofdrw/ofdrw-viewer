/**
 * 引擎事件系统独立契约测试（设计文档 §3.7 / §3.8 / §3.9 / §6）。
 *
 * 与实现方自测分离：本文件只通过公开 API 与真实合成 OFD 包验证事件总线、
 * 文档/页面事件的载荷、顺序、同步点与 abort/error/close 语义。
 */

import { describe, expect, it } from 'vitest';
import {
  OFDDocument,
  OFDError,
  OFDEventBus,
  isOFDError,
  openZipVirtualContainer,
} from '../../src/index';
import type {
  DocumentCloseEndEvent,
  DocumentCloseStartEvent,
  DocumentOpenAbortEvent,
  DocumentOpenEndEvent,
  DocumentOpenErrorEvent,
  DocumentOpenStartEvent,
  OFDEventMap,
  OFDEventName,
  PageLoadAbortEvent,
  PageLoadEndEvent,
  PageLoadErrorEvent,
  PageLoadStartEvent,
  PageRenderAbortEvent,
  PageRenderEndEvent,
  PageRenderErrorEvent,
  PageRenderStartEvent,
} from '../../src/index';
import type { VirtualContainer } from '../../src/platform/virtual-container';
import {
  buildFixtureOfd,
  createTestCanvas,
  createTestRenderer,
  openTestDocument,
} from './helpers';

/** 全部事件名；录制时统一订阅。 */
const ALL_EVENT_NAMES: readonly OFDEventName[] = [
  'document:open:start',
  'document:open:end',
  'document:open:error',
  'document:open:abort',
  'document:close:start',
  'document:close:end',
  'page:load:start',
  'page:load:end',
  'page:load:error',
  'page:load:abort',
  'page:render:start',
  'page:render:end',
  'page:render:error',
  'page:render:abort',
];

/** 录制到的事件联合。 */
type RecordedEvent = OFDEventMap[OFDEventName];

/**
 * 在总线上录制全部事件。
 *
 * @param bus 事件总线。
 * @returns 按派发顺序追加的事件数组。
 */
function recordEvents(bus: OFDEventBus): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  for (const type of ALL_EVENT_NAMES) {
    bus.on(type, (event) => {
      events.push(event as RecordedEvent);
    });
  }
  return events;
}

/**
 * 读取事件类型序列。
 *
 * @param events 录制事件。
 * @returns 事件名数组。
 */
function typesOf(events: readonly RecordedEvent[]): string[] {
  return events.map((event) => event.type);
}

/**
 * 捕获 Promise 拒绝值。
 *
 * @param promise 待观察 Promise。
 * @returns 拒绝值。
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Promise 未按预期拒绝');
}

/**
 * 读取 OFD 错误码。
 *
 * @param error 错误值。
 * @returns 错误码；非 OFDError 为 undefined。
 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/**
 * 断言错误为指定码之一（关闭场景允许 OFD_ABORTED/OFD_CLOSED）。
 *
 * @param error 错误值。
 * @param codes 允许的错误码。
 */
function expectCodeIn(error: unknown, codes: readonly string[]): void {
  const code = errorCode(error);
  expect(code).toBeDefined();
  expect(codes).toContain(code!);
}

/** 构造两页最小合成包（100×200mm、50×80mm）。 */
function buildTwoPageOfd(): Uint8Array {
  return buildFixtureOfd({
    pages: [
      { id: 1, widthMm: 100, heightMm: 200, objects: [] },
      { id: 2, widthMm: 50, heightMm: 80, objects: [] },
    ],
  });
}

/** 页面渲染所需的画布与 viewport。 */
interface RenderInput {
  readonly canvas: ReturnType<typeof createTestCanvas>;
  readonly viewport: { width: number; height: number; dpi: number };
}

/**
 * 为页面创建尺寸匹配的画布与 viewport。
 *
 * @param page 页面对象。
 * @param dpi 渲染精度。
 * @returns 画布与 viewport。
 */
function renderInput(page: {
  getViewport(options?: { dpi?: number }): { width: number; height: number; dpi: number };
}, dpi = 96): RenderInput {
  const viewport = page.getViewport({ dpi });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  return {
    canvas: createTestCanvas(width, height),
    viewport: { width, height, dpi: viewport.dpi },
  };
}

/** 构造一条 page:render:start 载荷；仅用于直接派发总线测试。 */
function pageRenderStart(overrides: Partial<PageRenderStartEvent> = {}): PageRenderStartEvent {
  return {
    type: 'page:render:start',
    timestamp: Date.now(),
    sequence: 1,
    operationId: 1,
    pageIndex: 0,
    dpi: 96,
    width: 100,
    height: 100,
    ...overrides,
  };
}

describe('OFDEventBus 公共 API', () => {
  it('on/emit 同步按注册顺序调用，off/removeEventListener 移除重复注册且退订幂等', () => {
    const bus = new OFDEventBus();
    const calls: string[] = [];
    const first = (): void => {
      calls.push('first');
    };
    const duplicate = (): void => {
      calls.push('duplicate');
    };
    bus.on('page:render:start', first);
    bus.on('page:render:start', duplicate);
    bus.on('page:render:start', duplicate);
    expect(bus.listenerCount('page:render:start')).toBe(3);

    // 同步：emit 返回时监听器已全部执行。
    bus.emit('page:render:start', pageRenderStart());
    expect(calls).toEqual(['first', 'duplicate', 'duplicate']);

    // off 移除同一回调的全部注册；未注册的回调安全无操作。
    bus.off('page:render:start', duplicate);
    bus.off('page:render:start', () => undefined);
    expect(bus.listenerCount('page:render:start')).toBe(1);
    bus.emit('page:render:start', pageRenderStart({ sequence: 2 }));
    expect(calls).toEqual(['first', 'duplicate', 'duplicate', 'first']);

    // removeEventListener 与 off 等价。
    bus.removeEventListener('page:render:start', first);
    expect(bus.listenerCount('page:render:start')).toBe(0);
    bus.emit('page:render:start', pageRenderStart({ sequence: 3 }));
    expect(calls).toHaveLength(4);
  });

  it('once 在调用前移除，监听器抛错也不会二次触发；off 可提前撤销 once', () => {
    const bus = new OFDEventBus();
    let onceCalls = 0;
    const onceHandler = (): void => {
      onceCalls += 1;
      throw new Error('once boom');
    };
    bus.once('page:render:start', onceHandler);
    bus.emit('page:render:start', pageRenderStart());
    bus.emit('page:render:start', pageRenderStart({ sequence: 2 }));
    expect(onceCalls).toBe(1);
    expect(bus.listenerCount('page:render:start')).toBe(0);

    const cancelled = (): void => {
      onceCalls += 100;
    };
    bus.once('page:render:start', cancelled);
    bus.off('page:render:start', cancelled);
    bus.emit('page:render:start', pageRenderStart({ sequence: 3 }));
    expect(onceCalls).toBe(1);
  });

  it('addEventListener 支持 once 与 signal：注册前已 abort 不注册，注册后 abort 自动移除', () => {
    const bus = new OFDEventBus();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    bus.addEventListener('page:render:start', handler, { signal: alreadyAborted.signal });
    expect(bus.listenerCount('page:render:start')).toBe(0);

    const controller = new AbortController();
    bus.addEventListener('page:render:start', handler, { signal: controller.signal });
    bus.addEventListener('page:render:start', handler, { once: true });
    expect(bus.listenerCount('page:render:start')).toBe(2);
    controller.abort();
    expect(bus.listenerCount('page:render:start')).toBe(1);

    bus.emit('page:render:start', pageRenderStart());
    bus.emit('page:render:start', pageRenderStart({ sequence: 2 }));
    // signal 监听器已移除；once 监听器只触发一次。
    expect(calls).toBe(1);
  });

  it('快照派发：派发中新增的监听器不参与本次事件', () => {
    const bus = new OFDEventBus();
    const calls: string[] = [];
    let added = false;
    bus.on('page:render:start', () => {
      calls.push('first');
      if (added) return;
      added = true;
      bus.on('page:render:start', () => calls.push('late'));
    });

    bus.emit('page:render:start', pageRenderStart());
    expect(calls).toEqual(['first']);
    bus.emit('page:render:start', pageRenderStart({ sequence: 2 }));
    expect(calls).toEqual(['first', 'first', 'late']);
  });

  it('监听器异常互不影响，onListenerError 收到错误与事件名，回调自身抛错被吞掉', () => {
    const reported: Array<{ error: unknown; type: OFDEventName }> = [];
    const bus = new OFDEventBus({
      onListenerError: (error, type) => {
        reported.push({ error, type });
        throw new Error('reporter boom');
      },
    });
    const calls: string[] = [];
    bus.on('page:render:start', () => {
      calls.push('throwing');
      throw new Error('listener boom');
    });
    bus.on('page:render:start', () => calls.push('survived'));

    expect(() => bus.emit('page:render:start', pageRenderStart())).not.toThrow();
    expect(calls).toEqual(['throwing', 'survived']);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.type).toBe('page:render:start');
    expect((reported[0]?.error as Error).message).toBe('listener boom');
  });

  it('removeAllListeners 支持按事件与全部清理，listenerCount 按事件独立', () => {
    const bus = new OFDEventBus();
    bus.on('page:render:start', () => undefined);
    bus.on('page:render:start', () => undefined);
    bus.on('page:render:end', () => undefined);
    expect(bus.listenerCount('page:render:start')).toBe(2);
    expect(bus.listenerCount('page:render:end')).toBe(1);

    bus.removeAllListeners('page:render:start');
    expect(bus.listenerCount('page:render:start')).toBe(0);
    expect(bus.listenerCount('page:render:end')).toBe(1);

    bus.removeAllListeners();
    expect(bus.listenerCount('page:render:end')).toBe(0);
  });

  it('没有监听器时 emit 直接返回；removeAllListeners 后不再触发', () => {
    const bus = new OFDEventBus();
    expect(() => bus.emit('document:open:abort', {
      type: 'document:open:abort',
      timestamp: Date.now(),
      sequence: 1,
      operationId: 1,
      cause: 'caller',
      durationMs: 0,
    })).not.toThrow();

    let calls = 0;
    bus.on('page:render:start', () => {
      calls += 1;
    });
    bus.removeAllListeners();
    bus.emit('page:render:start', pageRenderStart());
    expect(calls).toBe(0);
  });
});

describe('document:open 事件（独立契约）', () => {
  it('start 同步派发；end 在 Promise resolve 前；载荷、operationId 与 sequence 符合契约', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const before = Date.now();
    const promise = OFDDocument.open({
      source: { kind: 'arraybuffer', data: buildTwoPageOfd() },
      renderer: createTestRenderer(),
      eventBus: bus,
    });
    // start 必须在任何异步动作前同步派发。
    expect(typesOf(events)).toEqual(['document:open:start']);
    const start = events[0] as DocumentOpenStartEvent;
    expect(start.operationId).toBe(1);
    expect(start.sequence).toBe(1);
    expect(start.sourceKind).toBe('arraybuffer');
    expect(start.documentIndex).toBe(0);
    expect(start.viaContainer).toBe(false);
    expect(start.timestamp).toBeGreaterThanOrEqual(before);
    expect(start.timestamp).toBeLessThanOrEqual(Date.now());

    let endSeen = false;
    let endBeforeResolve = false;
    promise.then(() => {
      endBeforeResolve = endSeen;
    });
    bus.on('document:open:end', () => {
      endSeen = true;
    });

    const doc = await promise;
    try {
      expect(endBeforeResolve).toBe(true);
      expect(doc.events).toBe(bus);
      const end = events[1] as DocumentOpenEndEvent;
      expect(typesOf(events)).toEqual(['document:open:start', 'document:open:end']);
      expect(end.operationId).toBe(start.operationId);
      expect(end.sequence).toBe(2);
      expect(end.pageCount).toBe(2);
      expect(typeof end.version).toBe('string');
      expect(end.packageSize).toBeGreaterThan(0);
      expect(end.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await doc.close();
    }
  });

  it('打开失败只派发 start → error；error 是 OFDError，不出现 end/abort', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const promise = OFDDocument.open({
      source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3, 4]) },
      renderer: createTestRenderer(),
      eventBus: bus,
    });
    const error = await rejectionOf(promise);

    expect(errorCode(error)).toBeDefined();
    expect(typesOf(events)).toEqual(['document:open:start', 'document:open:error']);
    const failure = events[1] as DocumentOpenErrorEvent;
    expect(failure.operationId).toBe((events[0] as DocumentOpenStartEvent).operationId);
    expect(failure.error).toBeInstanceOf(OFDError);
    expect(failure.error.code).toBe(errorCode(error));
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('signal 取消打开派发 start → abort(cause=caller)，并携带 reason、以 OFD_ABORTED 拒绝', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const controller = new AbortController();
    const promise = OFDDocument.open({
      source: { kind: 'arraybuffer', data: buildTwoPageOfd() },
      renderer: createTestRenderer(),
      eventBus: bus,
      signal: controller.signal,
    });
    expect(typesOf(events)).toEqual(['document:open:start']);
    controller.abort(new Error('用户关闭选择框'));
    const error = await rejectionOf(promise);

    expect(errorCode(error)).toBe('OFD_ABORTED');
    expect(typesOf(events)).toEqual(['document:open:start', 'document:open:abort']);
    const abort = events[1] as DocumentOpenAbortEvent;
    expect(abort.cause).toBe('caller');
    expect((abort.reason as Error).message).toBe('用户关闭选择框');
    expect(abort.operationId).toBe((events[0] as DocumentOpenStartEvent).operationId);
  });

  it('入口参数校验失败不派发任何事件', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);

    const missing = await rejectionOf(
      OFDDocument.open({ eventBus: bus } as never),
    );
    expect(errorCode(missing)).toBe('OFD_INVALID_PACKAGE');

    const conflict = await rejectionOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: buildTwoPageOfd() },
        container: {} as VirtualContainer,
        containerFactory: async () => ({}) as VirtualContainer,
        eventBus: bus,
      } as never),
    );
    expect(errorCode(conflict)).toBe('OFD_INVALID_PACKAGE');
    expect(events).toHaveLength(0);
  });

  it('container 注入打开时 viaContainer=true，且不托管借用容器', async () => {
    const base = await openZipVirtualContainer({
      kind: 'arraybuffer',
      data: buildTwoPageOfd(),
    });
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const doc = await OFDDocument.open({
      container: base,
      eventBus: bus,
      renderer: createTestRenderer(),
    });
    try {
      const start = events[0] as DocumentOpenStartEvent;
      expect(start.viaContainer).toBe(true);
      expect(start.sourceKind).toBe('custom');
      expect(typesOf(events)).toEqual(['document:open:start', 'document:open:end']);
    } finally {
      await doc.close();
      // 借用容器由宿主关闭；engine 不应在 close 时关闭它。
      await base.close();
    }
  });

  it('没有监听器时不消耗 sequence：后注册的第一个事件从 1 开始', async () => {
    const bus = new OFDEventBus();
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    try {
      const events = recordEvents(bus);
      await doc.getPage(0);
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:end']);
      expect((events[0] as PageLoadStartEvent).sequence).toBe(1);
      expect((events[1] as PageLoadEndEvent).sequence).toBe(2);
    } finally {
      await doc.close();
    }
  });
});

describe('document:close 事件（独立契约）', () => {
  it('活动 getPage 被关闭中止：close:start → page:load:abort(close) → close:end', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    const events = recordEvents(doc.events);
    const load = doc.getPage(0);
    const closing = doc.close();
    await closing;
    const loadError = await rejectionOf(load);

    expectCodeIn(loadError, ['OFD_ABORTED', 'OFD_CLOSED']);
    expect(typesOf(events)).toEqual([
      'page:load:start',
      'document:close:start',
      'page:load:abort',
      'document:close:end',
    ]);
    const closeStart = events[1] as DocumentCloseStartEvent;
    const abort = events[2] as PageLoadAbortEvent;
    const closeEnd = events[3] as DocumentCloseEndEvent;
    expect(abort.cause).toBe('close');
    expect(abort.pageIndex).toBe(0);
    expect(abort.operationId).toBe((events[0] as PageLoadStartEvent).operationId);
    expect(closeStart.sequence).toBeLessThan(abort.sequence);
    expect(abort.sequence).toBeLessThan(closeEnd.sequence);
    expect(closeEnd.abortedOperations).toBeGreaterThanOrEqual(1);
    expect(closeEnd.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('活动渲染被关闭中止：abort(cause=close) 先于 close:end，task 不派发 error', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(doc.events);
      const input = renderInput(page);
      const task = page.render({
        canvasContext: input.canvas.context,
        viewport: input.viewport,
      });
      expect(typesOf(events)).toEqual(['page:render:start']);

      await doc.close();
      const taskError = await rejectionOf(task.promise);
      expectCodeIn(taskError, ['OFD_ABORTED', 'OFD_CLOSED']);
      expect(typesOf(events)).toEqual([
        'page:render:start',
        'document:close:start',
        'page:render:abort',
        'document:close:end',
      ]);
      const abort = events[2] as PageRenderAbortEvent;
      expect(abort.cause).toBe('close');
      expect(abort.operationId).toBe(task.id);
      expect(abort.pageIndex).toBe(0);
      expect((events[3] as DocumentCloseEndEvent).abortedOperations).toBeGreaterThanOrEqual(1);
    } finally {
      await doc.close();
    }
  });

  it('无活动操作时 abortedOperations=0；第二次 close 与关闭后 API 均无事件', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    const page = await doc.getPage(1);
    const events = recordEvents(doc.events);
    await doc.close();
    expect(typesOf(events)).toEqual(['document:close:start', 'document:close:end']);
    expect((events[1] as DocumentCloseEndEvent).abortedOperations).toBe(0);
    const countAfterClose = events.length;

    await doc.close();
    expect(events).toHaveLength(countAfterClose);

    const loadError = await rejectionOf(doc.getPage(0));
    expect(errorCode(loadError)).toBe('OFD_CLOSED');
    const input = renderInput(page);
    const task = page.render({
      canvasContext: input.canvas.context,
      viewport: input.viewport,
    });
    expect(task.id).toBe(0);
    const renderError = await rejectionOf(task.promise);
    expect(errorCode(renderError)).toBe('OFD_CLOSED');
    expect(events).toHaveLength(countAfterClose);
  });
});

describe('page:load 事件（独立契约）', () => {
  it('start 在 getPage 调用栈内同步派发；end 先于 resolve，pageIndex/尺寸正确', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const promise = doc.getPage(0);
      expect(typesOf(events)).toEqual(['page:load:start']);

      let endSeen = false;
      let endBeforeResolve = false;
      promise.then(() => {
        endBeforeResolve = endSeen;
      });
      doc.events.on('page:load:end', () => {
        endSeen = true;
      });
      const page = await promise;

      expect(endBeforeResolve).toBe(true);
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:end']);
      const start = events[0] as PageLoadStartEvent;
      const end = events[1] as PageLoadEndEvent;
      expect(start.pageIndex).toBe(0);
      expect(end.pageIndex).toBe(0);
      expect(end.operationId).toBe(start.operationId);
      expect(end.sequence).toBe(start.sequence + 1);
      expect(end.widthMm).toBe(100);
      expect(end.heightMm).toBe(200);
      expect(page.index).toBe(0);
      expect(page.getSize()).toEqual({ width: 100, height: 200 });
    } finally {
      await doc.close();
    }
  });

  it('缓存命中仍派发新的 start/end，新操作 operationId 与 sequence 递增', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      await doc.getPage(0);
      await doc.getPage(0);
      expect(typesOf(events)).toEqual([
        'page:load:start',
        'page:load:end',
        'page:load:start',
        'page:load:end',
      ]);
      const firstStart = events[0] as PageLoadStartEvent;
      const firstEnd = events[1] as PageLoadEndEvent;
      const secondStart = events[2] as PageLoadStartEvent;
      const secondEnd = events[3] as PageLoadEndEvent;
      expect(secondStart.operationId).toBeGreaterThan(firstStart.operationId);
      expect(secondEnd.operationId).toBe(secondStart.operationId);
      expect(secondStart.sequence).toBe(firstEnd.sequence + 1);
    } finally {
      await doc.close();
    }
  });

  it('取页等待取消派发 abort(cause=caller)，不带 error 载荷', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const controller = new AbortController();
      const promise = doc.getPage(0, { signal: controller.signal });
      expect(typesOf(events)).toEqual(['page:load:start']);
      controller.abort(new Error('切换文档'));
      const error = await rejectionOf(promise);

      expect(errorCode(error)).toBe('OFD_ABORTED');
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:abort']);
      const abort = events[1] as PageLoadAbortEvent;
      expect(abort.cause).toBe('caller');
      expect(abort.pageIndex).toBe(0);
      expect((abort.reason as Error).message).toBe('切换文档');
      expect('error' in abort).toBe(false);
    } finally {
      await doc.close();
    }
  });

  it('页面模型加载失败派发 page:load:error；pageIndex 与操作归属一致', async () => {
    const bytes = buildTwoPageOfd();
    const base = await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes });
    const failing: VirtualContainer = {
      packageSize: base.packageSize,
      encrypted: false,
      list: () => base.list(),
      has: (path) => base.has(path),
      stat: (path) => base.stat(path),
      read: async (path, options) => {
        if (/Page_1\/Content\.xml$/.test(path)) {
          throw new OFDError('OFD_ENTRY_NOT_FOUND', '模拟页面内容损坏');
        }
        return base.read(path, options);
      },
      close: () => base.close(),
    };
    const bus = new OFDEventBus();
    const doc = await OFDDocument.open({
      container: failing,
      eventBus: bus,
      renderer: createTestRenderer(),
    });
    try {
      const events = recordEvents(bus);
      const error = await rejectionOf(doc.getPage(0));
      expect(errorCode(error)).toBe('OFD_ENTRY_NOT_FOUND');
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:error']);
      const failure = events[1] as PageLoadErrorEvent;
      expect(failure.pageIndex).toBe(0);
      expect(failure.error.code).toBe('OFD_ENTRY_NOT_FOUND');
      expect(failure.operationId).toBe((events[0] as PageLoadStartEvent).operationId);
    } finally {
      await doc.close();
      await base.close();
    }
  });

  it('越界索引与预取消 signal 属于入口校验失败，不派发任何事件', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      for (const pageIndex of [-1, 2, 1.5]) {
        const error = await rejectionOf(doc.getPage(pageIndex));
        expect(errorCode(error)).toBe('OFD_PAGE_NOT_FOUND');
      }
      const controller = new AbortController();
      controller.abort();
      const aborted = await rejectionOf(doc.getPage(0, { signal: controller.signal }));
      expect(errorCode(aborted)).toBe('OFD_ABORTED');
      expect(events).toHaveLength(0);
    } finally {
      await doc.close();
    }
  });
});

describe('page:render 事件（独立契约）', () => {
  it('start 在 render() 返回前同步派发；end 先于 resolve；RenderTask.id 与 operationId 一致', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(doc.events);
      const input = renderInput(page);
      const task = page.render({
        canvasContext: input.canvas.context,
        viewport: input.viewport,
      });

      expect(typesOf(events)).toEqual(['page:render:start']);
      const start = events[0] as PageRenderStartEvent;
      expect(start.pageIndex).toBe(0);
      expect(start.dpi).toBe(96);
      expect(start.width).toBe(input.viewport.width);
      expect(start.height).toBe(input.viewport.height);
      expect(task.id).toBe(start.operationId);
      expect(task.id).toBeGreaterThan(0);

      let endSeen = false;
      let endBeforeResolve = false;
      task.promise.then(() => {
        endBeforeResolve = endSeen;
      });
      doc.events.on('page:render:end', () => {
        endSeen = true;
      });
      await task.promise;
      expect(endBeforeResolve).toBe(true);
      expect(typesOf(events)).toEqual(['page:render:start', 'page:render:end']);
      const end = events[1] as PageRenderEndEvent;
      expect(end.pageIndex).toBe(0);
      expect(end.operationId).toBe(task.id);
      expect(end.sequence).toBe(start.sequence + 1);
      expect(end.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await doc.close();
    }
  });

  it('入口校验失败返回 id=0 的拒绝任务且零事件', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(doc.events);
      const canvas = createTestCanvas(10, 10);
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 0, height: 10, dpi: 96 },
      });
      expect(task.id).toBe(0);
      const error = await rejectionOf(task.promise);
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
      expect(events).toHaveLength(0);
    } finally {
      await doc.close();
    }
  });

  it('task.cancel() 重复调用只派发一次 abort(cause=caller)，不派发 error', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(doc.events);
      const input = renderInput(page);
      const task = page.render({
        canvasContext: input.canvas.context,
        viewport: input.viewport,
      });
      task.cancel();
      task.cancel();
      const error = await rejectionOf(task.promise);

      expect(errorCode(error)).toBe('OFD_ABORTED');
      expect(typesOf(events)).toEqual(['page:render:start', 'page:render:abort']);
      const abort = events[1] as PageRenderAbortEvent;
      expect(abort.cause).toBe('caller');
      expect(abort.pageIndex).toBe(0);
      expect(abort.operationId).toBe(task.id);
    } finally {
      await doc.close();
    }
  });

  it('外部 signal 取消派发 abort(cause=caller) 并携带 reason', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(doc.events);
      const input = renderInput(page);
      const controller = new AbortController();
      const task = page.render({
        canvasContext: input.canvas.context,
        viewport: input.viewport,
        signal: controller.signal,
      });
      controller.abort(new Error('滚动离开可视区'));
      const error = await rejectionOf(task.promise);

      expect(errorCode(error)).toBe('OFD_ABORTED');
      const abort = events[1] as PageRenderAbortEvent;
      expect(abort.type).toBe('page:render:abort');
      expect(abort.cause).toBe('caller');
      expect((abort.reason as Error).message).toBe('滚动离开可视区');
      expect(abort.operationId).toBe(task.id);
    } finally {
      await doc.close();
    }
  });

  it('真实绘制失败派发 page:render:error 而非 abort，错误码与 task 一致', async () => {
    const bus = new OFDEventBus();
    const renderer = createTestRenderer();
    renderer.beginPage = () => {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', '模拟绘制失败');
    };
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus, renderer });
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(bus);
      const input = renderInput(page);
      const task = page.render({
        canvasContext: input.canvas.context,
        viewport: input.viewport,
      });
      const error = await rejectionOf(task.promise);

      expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
      expect(typesOf(events)).toEqual(['page:render:start', 'page:render:error']);
      const failure = events[1] as PageRenderErrorEvent;
      expect(failure.pageIndex).toBe(0);
      expect(failure.error.code).toBe('OFD_RENDERER_UNSUPPORTED');
      expect(failure.operationId).toBe(task.id);
    } finally {
      await doc.close();
    }
  });

  it('监听器抛错不改变渲染结果，也不影响其他与文档事件监听器', async () => {
    const bus = new OFDEventBus({ onListenerError: () => undefined });
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    try {
      const page = await doc.getPage(0);
      const calls: string[] = [];
      bus.on('page:render:start', () => {
        calls.push('throwing');
        throw new Error('listener boom');
      });
      bus.on('page:render:start', () => calls.push('survivor'));
      const input = renderInput(page);
      const task = page.render({
        canvasContext: input.canvas.context,
        viewport: input.viewport,
      });
      await expect(task.promise).resolves.toBeUndefined();
      expect(calls).toEqual(['throwing', 'survivor']);
      expect(task.id).toBeGreaterThan(0);
    } finally {
      await doc.close();
    }
  });
});

describe('页面监听器过滤与销毁（独立契约）', () => {
  it('page.on 只收到本页事件；doc.on 收到全部页面事件', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page0 = await doc.getPage(0);
      const page1 = await doc.getPage(1);
      const page0Events: string[] = [];
      const page1Events: string[] = [];
      const docEvents: string[] = [];
      page0.on('page:render:start', (event) => page0Events.push(`${event.pageIndex}:start`));
      page1.on('page:render:start', (event) => page1Events.push(`${event.pageIndex}:start`));
      doc.on('page:render:start', (event) => docEvents.push(`${event.pageIndex}:start`));

      const input0 = renderInput(page0);
      const input1 = renderInput(page1);
      await page0.render({
        canvasContext: input0.canvas.context,
        viewport: input0.viewport,
      }).promise;
      await page1.render({
        canvasContext: input1.canvas.context,
        viewport: input1.viewport,
      }).promise;

      expect(page0Events).toEqual(['0:start']);
      expect(page1Events).toEqual(['1:start']);
      expect(docEvents).toEqual(['0:start', '1:start']);
    } finally {
      await doc.close();
    }
  });

  it('page.once/off/addEventListener(signal) 与文档关闭清理行为一致', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page0 = await doc.getPage(0);
      const page1 = await doc.getPage(1);
      const calls: string[] = [];
      const onceHandler = (): void => {
        calls.push('once');
      };
      page0.once('page:render:start', onceHandler);
      const removed = (): void => {
        calls.push('removed');
      };
      page0.on('page:render:start', removed);
      page0.off('page:render:start', removed);

      const controller = new AbortController();
      page0.addEventListener(
        'page:render:start',
        () => calls.push('signal'),
        { signal: controller.signal },
      );
      controller.abort();

      await page0.render({
        canvasContext: renderInput(page0).canvas.context,
        viewport: renderInput(page0).viewport,
      }).promise;
      expect(calls).toEqual(['once']);

      // 其他页的事件不会进入本页监听器。
      await page1.render({
        canvasContext: renderInput(page1).canvas.context,
        viewport: renderInput(page1).viewport,
      }).promise;
      expect(calls).toEqual(['once']);

      // 文档关闭后页面监听器被清理；关闭后渲染被拒绝且无事件。
      await doc.close();
      const before = calls.length;
      const task = page0.render({
        canvasContext: renderInput(page0).canvas.context,
        viewport: renderInput(page0).viewport,
      });
      await expect(task.promise).rejects.toMatchObject({ code: 'OFD_CLOSED' });
      expect(calls).toHaveLength(before);
    } finally {
      await doc.close();
    }
  });
});