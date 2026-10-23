/**
 * 引擎页面级事件系统单元测试（对应设计文档 §3、§7.2）。
 *
 * 覆盖事件总线语义、document:open/close、page:load/render 的载荷、时序、
 * abort/error/close 分离与监听器过滤。
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
  PageLoadStartEvent,
  PageRenderAbortEvent,
  PageRenderEndEvent,
  PageRenderStartEvent,
} from '../../src/index';
import type { VirtualContainer } from '../../src/platform/virtual-container';
import type { XmlElementSpec } from '../fixtures/xml';
import {
  buildFixtureOfd,
  createTestCanvas,
  createTestRenderer,
  openTestDocument,
} from './helpers';

/** 全部引擎事件名；测试统一录制。 */
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

/**
 * 在总线上录制全部事件。
 *
 * @param bus 事件总线。
 * @returns 按派发顺序追加的事件数组。
 */
function recordEvents(bus: OFDEventBus): Array<OFDEventMap[OFDEventName]> {
  const events: Array<OFDEventMap[OFDEventName]> = [];
  for (const type of ALL_EVENT_NAMES) {
    bus.on(type, (event) => {
      events.push(event);
    });
  }
  return events;
}

/** 取事件类型序列。 */
function typesOf(events: Array<OFDEventMap[OFDEventName]>): string[] {
  return events.map((event) => event.type);
}

/** 捕获 promise 拒绝并返回错误。 */
async function rejectOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('promise 未按预期拒绝');
}

/** 读取错误码。 */
function errorCode(error: unknown): string | undefined {
  return isOFDError(error) ? error.code : undefined;
}

/** 页对象：纯色填充矩形。 */
function filledRect(id: number, boundary: string, color: string): XmlElementSpec {
  return {
    name: 'ofd:PathObject',
    attrs: { ID: id, Boundary: boundary, Fill: 'true', Stroke: 'false' },
    children: [
      {
        name: 'ofd:AbbreviatedData',
        children: ['M 0 0 L 10 0 L 10 10 L 0 10 Z'],
      },
      { name: 'ofd:FillColor', attrs: { Value: color } },
    ],
  };
}

/** 构造两页最小包。 */
function buildTwoPageOfd(): Uint8Array {
  return buildFixtureOfd({
    pages: [
      { id: 1, widthMm: 100, heightMm: 200, objects: [filledRect(11, '0 0 10 10', '255 0 0')] },
      { id: 2, widthMm: 50, heightMm: 80, objects: [filledRect(21, '0 0 10 10', '0 0 255')] },
    ],
  });
}

/** 构造一条 page:load:start 载荷；用于直接派发测试。 */
function loadStartEvent(overrides: Partial<PageLoadStartEvent> = {}): PageLoadStartEvent {
  return {
    type: 'page:load:start',
    timestamp: Date.now(),
    sequence: 1,
    operationId: 1,
    pageIndex: 0,
    ...overrides,
  };
}

describe('OFDEventBus 基础语义', () => {
  it('同步派发且按注册顺序调用；退订函数可重复调用', () => {
    const bus = new OFDEventBus();
    const calls: string[] = [];
    bus.on('page:load:start', () => calls.push('a'));
    const unsubscribe = bus.on('page:load:start', () => calls.push('b'));
    expect(bus.listenerCount('page:load:start')).toBe(2);

    bus.emit('page:load:start', loadStartEvent());
    expect(calls).toEqual(['a', 'b']);

    unsubscribe();
    unsubscribe();
    expect(bus.listenerCount('page:load:start')).toBe(1);
    bus.emit('page:load:start', loadStartEvent({ sequence: 2 }));
    expect(calls).toEqual(['a', 'b', 'a']);
  });

  it('快照派发：派发中新增的监听器不参与本次事件', () => {
    const bus = new OFDEventBus();
    const calls: string[] = [];
    let added = false;
    bus.on('page:load:start', () => {
      calls.push('first');
      if (added) return;
      added = true;
      bus.on('page:load:start', () => calls.push('late'));
    });
    bus.emit('page:load:start', loadStartEvent());
    expect(calls).toEqual(['first']);
    bus.emit('page:load:start', loadStartEvent({ sequence: 2 }));
    expect(calls).toEqual(['first', 'first', 'late']);
  });

  it('once 只触发一次；监听器抛错也不会再次触发', () => {
    const bus = new OFDEventBus();
    let calls = 0;
    bus.once('page:load:start', () => {
      calls += 1;
      throw new Error('once boom');
    });
    bus.emit('page:load:start', loadStartEvent());
    bus.emit('page:load:start', loadStartEvent({ sequence: 2 }));
    expect(calls).toBe(1);
    expect(bus.listenerCount('page:load:start')).toBe(0);
  });

  it('单个监听器抛错不影响其他监听器，并上报 onListenerError', () => {
    const reported: Array<{ error: unknown; type: OFDEventName }> = [];
    const bus = new OFDEventBus({
      onListenerError: (error, type) => reported.push({ error, type }),
    });
    const calls: string[] = [];
    bus.on('page:load:start', () => {
      calls.push('throwing');
      throw new Error('listener boom');
    });
    bus.on('page:load:start', () => calls.push('survivor'));

    expect(() => bus.emit('page:load:start', loadStartEvent())).not.toThrow();
    expect(calls).toEqual(['throwing', 'survivor']);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.type).toBe('page:load:start');
    expect((reported[0]?.error as Error).message).toBe('listener boom');
  });

  it('onListenerError 自身抛错也被吞掉', () => {
    const bus = new OFDEventBus({
      onListenerError: () => {
        throw new Error('report boom');
      },
    });
    let called = false;
    bus.on('page:load:start', () => {
      throw new Error('listener boom');
    });
    bus.on('page:load:start', () => {
      called = true;
    });
    expect(() => bus.emit('page:load:start', loadStartEvent())).not.toThrow();
    expect(called).toBe(true);
  });

  it('off/removeEventListener 精确移除同一回调的多次注册', () => {
    const bus = new OFDEventBus();
    const handler = (): void => undefined;
    const other = (): void => undefined;
    bus.on('page:load:start', handler);
    bus.on('page:load:start', handler);
    bus.on('page:load:start', other);
    expect(bus.listenerCount('page:load:start')).toBe(3);
    bus.off('page:load:start', handler);
    expect(bus.listenerCount('page:load:start')).toBe(1);
    bus.removeEventListener('page:load:start', other);
    expect(bus.listenerCount('page:load:start')).toBe(0);
  });

  it('addEventListener 支持 once 与 signal 自动移除', () => {
    const bus = new OFDEventBus();
    const calls: string[] = [];
    bus.addEventListener('page:load:start', () => calls.push('once'), { once: true });
    const controller = new AbortController();
    bus.addEventListener('page:load:start', () => calls.push('signal'), {
      signal: controller.signal,
    });
    controller.abort();
    expect(bus.listenerCount('page:load:start')).toBe(1);
    bus.emit('page:load:start', loadStartEvent());
    bus.emit('page:load:start', loadStartEvent({ sequence: 2 }));
    expect(calls).toEqual(['once']);
    expect(bus.listenerCount('page:load:start')).toBe(0);
  });

  it('addEventListener 的 signal 已中止时不注册', () => {
    const bus = new OFDEventBus();
    const controller = new AbortController();
    controller.abort();
    bus.addEventListener('page:load:start', () => undefined, { signal: controller.signal });
    expect(bus.listenerCount('page:load:start')).toBe(0);
  });

  it('removeAllListeners 支持按事件或全部清理', () => {
    const bus = new OFDEventBus();
    bus.on('page:load:start', () => undefined);
    bus.on('page:load:end', () => undefined);
    bus.removeAllListeners('page:load:start');
    expect(bus.listenerCount('page:load:start')).toBe(0);
    expect(bus.listenerCount('page:load:end')).toBe(1);
    bus.removeAllListeners();
    expect(bus.listenerCount('page:load:end')).toBe(0);
  });
});

describe('document:open 事件', () => {
  it('start → end；end 在 Promise resolve 前，载荷与注入总线符合契约', async () => {
    const bytes = buildTwoPageOfd();
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const order: string[] = [];
    bus.on('document:open:end', () => order.push('end'));

    const promise = OFDDocument.open({
      source: { kind: 'arraybuffer', data: bytes },
      renderer: createTestRenderer(),
      eventBus: bus,
    });
    promise.then(() => order.push('resolve'));
    const doc = await promise;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual(['end', 'resolve']);
      expect(typesOf(events)).toEqual(['document:open:start', 'document:open:end']);
      expect(doc.events).toBe(bus);

      const start = events[0] as DocumentOpenStartEvent;
      expect(start.type).toBe('document:open:start');
      expect(start.sourceKind).toBe('arraybuffer');
      expect(start.documentIndex).toBe(0);
      expect(start.viaContainer).toBe(false);
      expect(start.operationId).toBe(1);
      expect(start.sequence).toBe(1);
      expect(start.timestamp).toBeGreaterThan(0);

      const end = events[1] as DocumentOpenEndEvent;
      expect(end.operationId).toBe(1);
      expect(end.sequence).toBe(2);
      expect(end.pageCount).toBe(2);
      expect(end.version).toBe('1.1');
      expect(end.packageSize).toBe(bytes.byteLength);
      expect(end.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await doc.close();
    }
  });

  it('打开失败只派发 start → error，无 end', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const error = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: new Uint8Array([1, 2, 3, 4]) },
        eventBus: bus,
        renderer: createTestRenderer(),
      }),
    );
    expect(errorCode(error)).toBe('OFD_INVALID_PACKAGE');
    expect(typesOf(events)).toEqual(['document:open:start', 'document:open:error']);
    const failure = events[1] as DocumentOpenErrorEvent;
    expect(isOFDError(failure.error)).toBe(true);
    expect(failure.error.code).toBe('OFD_INVALID_PACKAGE');
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('signal 取消打开派发 start → abort(cause=caller) 并以 OFD_ABORTED 拒绝', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const controller = new AbortController();
    // 注入容器读取挂起，验证取消不依赖底层 I/O 是否响应 signal。
    const container: VirtualContainer = {
      packageSize: 0,
      encrypted: false,
      list: () => [],
      has: (path) => path === 'OFD.xml',
      stat: () => undefined,
      read: () =>
        new Promise<Uint8Array>(() => {
          // 永不 resolve；取消必须由 waitForAbort 抢先结束 open。
        }),
      close: async () => undefined,
    };
    const promise = OFDDocument.open({ container, eventBus: bus, signal: controller.signal });
    controller.abort(new Error('用户取消'));
    const error = await rejectOf(promise);
    expect(errorCode(error)).toBe('OFD_ABORTED');
    expect(typesOf(events)).toEqual(['document:open:start', 'document:open:abort']);
    const abort = events[1] as DocumentOpenAbortEvent;
    expect(abort.cause).toBe('caller');
    expect((abort.reason as Error).message).toBe('用户取消');
    expect(abort.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('入口参数校验失败不派发任何事件', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const bytes = buildTwoPageOfd();
    const container: VirtualContainer = {
      packageSize: bytes.byteLength,
      encrypted: false,
      list: () => [],
      has: () => false,
      stat: () => undefined,
      read: async () => bytes,
      close: async () => undefined,
    };
    const error = await rejectOf(
      OFDDocument.open({
        source: { kind: 'arraybuffer', data: bytes },
        container,
        containerFactory: async () => container,
        eventBus: bus,
      } as never),
    );
    expect(errorCode(error)).toBe('OFD_INVALID_PACKAGE');
    expect(events).toHaveLength(0);
  });

  it('取消自有容器工厂时，迟到的容器由 engine 关闭', async () => {
    const bus = new OFDEventBus();
    const events = recordEvents(bus);
    const controller = new AbortController();
    let closedLate = false;
    const lateContainer: VirtualContainer = {
      packageSize: 0,
      encrypted: false,
      list: () => [],
      has: () => false,
      stat: () => undefined,
      read: async () => new Uint8Array(),
      close: async () => {
        closedLate = true;
      },
    };
    const promise = OFDDocument.open({
      source: { kind: 'arraybuffer', data: buildTwoPageOfd() },
      containerFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return lateContainer;
      },
      eventBus: bus,
      signal: controller.signal,
    });
    controller.abort();
    const error = await rejectOf(promise);
    expect(errorCode(error)).toBe('OFD_ABORTED');
    expect(typesOf(events)).toEqual(['document:open:start', 'document:open:abort']);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(closedLate).toBe(true);
  });

  it('不注入事件总线时 document.events 由引擎创建', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      expect(doc.events).toBeInstanceOf(OFDEventBus);
    } finally {
      await doc.close();
    }
  });
});

describe('page:load 事件', () => {
  it('getPage 首次派发 start → end，end 在 Promise resolve 前', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const order: string[] = [];
      doc.events.on('page:load:end', () => order.push('end'));
      const promise = doc.getPage(0);
      promise.then(() => order.push('resolve'));
      const page = await promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual(['end', 'resolve']);
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:end']);

      const start = events[0] as PageLoadStartEvent;
      expect(start.pageIndex).toBe(0);
      expect(start.operationId).toBeGreaterThan(0);
      const end = events[1] as PageLoadEndEvent;
      expect(end.pageIndex).toBe(0);
      expect(end.operationId).toBe(start.operationId);
      expect(end.widthMm).toBe(100);
      expect(end.heightMm).toBe(200);
      expect(end.durationMs).toBeGreaterThanOrEqual(0);
      expect(page.index).toBe(0);
    } finally {
      await doc.close();
    }
  });

  it('getPage 缓存命中仍派发 start → end，不出现额外事件', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      await doc.getPage(0);
      const events = recordEvents(doc.events);
      await doc.getPage(0);
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:end']);
    } finally {
      await doc.close();
    }
  });

  it('页面模型加载失败派发 page:load:error 而非 abort', async () => {
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
      const error = await rejectOf(doc.getPage(0));
      expect(errorCode(error)).toBe('OFD_ENTRY_NOT_FOUND');
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:error']);
      const failure = events[1] as OFDEventMap['page:load:error'];
      expect(failure.pageIndex).toBe(0);
      expect(failure.error.code).toBe('OFD_ENTRY_NOT_FOUND');
    } finally {
      await doc.close();
    }
  });

  it('页索引越界不派发任何事件，Promise 拒绝 OFD_PAGE_NOT_FOUND', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      for (const index of [-1, 2, 1.5]) {
        const error = await rejectOf(doc.getPage(index));
        expect(errorCode(error)).toBe('OFD_PAGE_NOT_FOUND');
      }
      expect(events).toHaveLength(0);
    } finally {
      await doc.close();
    }
  });

  it('signal 已中止不派发任何事件', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const controller = new AbortController();
      controller.abort();
      const error = await rejectOf(doc.getPage(0, { signal: controller.signal }));
      expect(errorCode(error)).toBe('OFD_ABORTED');
      expect(events).toHaveLength(0);
    } finally {
      await doc.close();
    }
  });

  it('取页等待被取消派发 page:load:abort(cause=caller)', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const controller = new AbortController();
      const promise = doc.getPage(0, { signal: controller.signal });
      controller.abort(new Error('切换文档'));
      const error = await rejectOf(promise);
      expect(errorCode(error)).toBe('OFD_ABORTED');
      expect(typesOf(events)).toEqual(['page:load:start', 'page:load:abort']);
      const abort = events[1] as PageLoadAbortEvent;
      expect(abort.cause).toBe('caller');
      expect(abort.pageIndex).toBe(0);
      expect((abort.reason as Error).message).toBe('切换文档');
      // 取消只影响本次等待；其他页面仍可正常加载。
      const other = await doc.getPage(1);
      expect(other.index).toBe(1);
    } finally {
      await doc.close();
    }
  });
});

describe('page:render 事件', () => {
  it('start 在 render() 返回前同步派发；end 在 task.promise resolve 前；id 对齐', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const page = await doc.getPage(0);
      events.length = 0;
      const canvas = createTestCanvas(400, 800);
      const viewport = page.getViewport({ dpi: 96 });
      const order: string[] = [];
      doc.events.on('page:render:end', () => order.push('end'));

      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 400, height: 800, dpi: viewport.dpi },
      });
      // start 必须已在 render() 调用栈内派发。
      expect(typesOf(events)).toEqual(['page:render:start']);
      const start = events[0] as PageRenderStartEvent;
      expect(start.pageIndex).toBe(0);
      expect(start.dpi).toBe(96);
      expect(start.width).toBe(400);
      expect(start.height).toBe(800);
      expect(task.id).toBe(start.operationId);

      task.promise.then(() => order.push('resolve'));
      await task.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual(['end', 'resolve']);
      expect(typesOf(events)).toEqual(['page:render:start', 'page:render:end']);
      const end = events[1] as PageRenderEndEvent;
      expect(end.operationId).toBe(task.id);
      expect(end.pageIndex).toBe(0);
      expect(end.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await doc.close();
    }
  });

  it('非法 viewport 不派发任何事件，Promise 拒绝并返回 id=0 的任务', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const page = await doc.getPage(0);
      events.length = 0;
      const canvas = createTestCanvas(400, 800);
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 0, height: 800, dpi: 96 },
      });
      expect(task.id).toBe(0);
      const error = await rejectOf(task.promise);
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
      expect(events).toHaveLength(0);
    } finally {
      await doc.close();
    }
  });

  it('Canvas 小于 viewport 不派发任何事件', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const page = await doc.getPage(0);
      events.length = 0;
      const canvas = createTestCanvas(100, 100);
      const error = await rejectOf(
        page.render({
          canvasContext: canvas.context,
          viewport: { width: 400, height: 800, dpi: 96 },
        }).promise,
      );
      expect(errorCode(error)).toBe('OFD_CANVAS_SIZE_MISMATCH');
      expect(events).toHaveLength(0);
    } finally {
      await doc.close();
    }
  });

  it('task.cancel() 派发一次 page:render:abort(cause=caller) 并以 OFD_ABORTED 拒绝', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const page = await doc.getPage(0);
      events.length = 0;
      const canvas = createTestCanvas(400, 800);
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 400, height: 800, dpi: 96 },
      });
      task.cancel();
      task.cancel();
      const error = await rejectOf(task.promise);
      expect(errorCode(error)).toBe('OFD_ABORTED');
      expect(typesOf(events)).toEqual(['page:render:start', 'page:render:abort']);
      const abort = events[1] as PageRenderAbortEvent;
      expect(abort.cause).toBe('caller');
      expect(abort.operationId).toBe(task.id);
      expect(abort.pageIndex).toBe(0);
    } finally {
      await doc.close();
    }
  });

  it('外部 signal 取消派发 abort(cause=caller)', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const events = recordEvents(doc.events);
      const page = await doc.getPage(0);
      events.length = 0;
      const canvas = createTestCanvas(400, 800);
      const controller = new AbortController();
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 400, height: 800, dpi: 96 },
        signal: controller.signal,
      });
      controller.abort(new Error('滚动取消'));
      const error = await rejectOf(task.promise);
      expect(errorCode(error)).toBe('OFD_ABORTED');
      const abort = events[1] as PageRenderAbortEvent;
      expect(abort.type).toBe('page:render:abort');
      expect(abort.cause).toBe('caller');
      expect((abort.reason as Error).message).toBe('滚动取消');
    } finally {
      await doc.close();
    }
  });

  it('真实渲染失败派发 page:render:error 而非 abort', async () => {
    const bus = new OFDEventBus();
    const renderer = createTestRenderer();
    // 注入会失败的绘制入口，强制 page:render:start 之后发生真实错误。
    renderer.beginPage = () => {
      throw new OFDError('OFD_RENDERER_UNSUPPORTED', '模拟绘制失败');
    };
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus, renderer });
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(bus);
      const canvas = createTestCanvas(400, 800);
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 400, height: 800, dpi: 96 },
      });
      const error = await rejectOf(task.promise);
      expect(errorCode(error)).toBe('OFD_RENDERER_UNSUPPORTED');
      expect(typesOf(events)).toEqual(['page:render:start', 'page:render:error']);
      const failure = events[1] as OFDEventMap['page:render:error'];
      expect(failure.operationId).toBe(task.id);
      expect(failure.error.code).toBe('OFD_RENDERER_UNSUPPORTED');
      expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await doc.close();
    }
  });

  it('同一 Canvas 串行渲染时两个操作各自 start/end', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page = await doc.getPage(0);
      const events = recordEvents(doc.events);
      const canvas = createTestCanvas(400, 800);
      const first = page.render({
        canvasContext: canvas.context,
        viewport: { width: 400, height: 800, dpi: 96 },
      });
      const second = page.render({
        canvasContext: canvas.context,
        viewport: { width: 400, height: 800, dpi: 96 },
      });
      await Promise.all([first.promise, second.promise]);
      expect(first.id).not.toBe(second.id);
      expect(typesOf(events)).toEqual([
        'page:render:start',
        'page:render:start',
        'page:render:end',
        'page:render:end',
      ]);
    } finally {
      await doc.close();
    }
  });

  it('监听器抛错不影响渲染结果与其他监听器', async () => {
    const reported: OFDEventName[] = [];
    const bus = new OFDEventBus({
      onListenerError: (_error, type) => reported.push(type),
    });
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    try {
      const page = await doc.getPage(0);
      let survived = 0;
      bus.on('page:render:start', () => {
        throw new Error('start listener boom');
      });
      bus.on('page:render:start', () => {
        survived += 1;
      });
      const canvas = createTestCanvas(400, 800);
      const task = page.render({
        canvasContext: canvas.context,
        viewport: { width: 400, height: 800, dpi: 96 },
      });
      await expect(task.promise).resolves.toBeUndefined();
      expect(survived).toBe(1);
      expect(reported).toContain('page:render:start');
    } finally {
      await doc.close();
    }
  });
});

describe('page 监听器过滤与清理', () => {
  it('page.on 只收到本页事件；doc.on 收到全部', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page0 = await doc.getPage(0);
      const page1 = await doc.getPage(1);
      const pageSeen: number[] = [];
      const docSeen: number[] = [];
      page0.on('page:render:start', (event) => pageSeen.push(event.pageIndex));
      doc.on('page:render:start', (event) => docSeen.push(event.pageIndex));

      const canvas1 = createTestCanvas(250, 400);
      await page1.render({
        canvasContext: canvas1.context,
        viewport: { width: 250, height: 400, dpi: 96 },
      }).promise;
      const canvas0 = createTestCanvas(400, 800);
      await page0.render({
        canvasContext: canvas0.context,
        viewport: { width: 400, height: 800, dpi: 96 },
      }).promise;

      expect(pageSeen).toEqual([0]);
      expect(docSeen).toEqual([1, 0]);
    } finally {
      await doc.close();
    }
  });

  it('page.once 只触发一次；addEventListener({signal}) 中止后自动移除', async () => {
    const doc = await openTestDocument(buildTwoPageOfd());
    try {
      const page = await doc.getPage(0);
      let onceCount = 0;
      page.once('page:render:start', () => {
        onceCount += 1;
      });
      const controller = new AbortController();
      let signalCount = 0;
      page.addEventListener(
        'page:render:start',
        () => {
          signalCount += 1;
        },
        { signal: controller.signal },
      );

      const renderOnce = async (): Promise<void> => {
        const canvas = createTestCanvas(400, 800);
        await page.render({
          canvasContext: canvas.context,
          viewport: { width: 400, height: 800, dpi: 96 },
        }).promise;
      };
      await renderOnce();
      controller.abort();
      await renderOnce();
      expect(onceCount).toBe(1);
      expect(signalCount).toBe(1);
    } finally {
      await doc.close();
    }
  });

  it('文档关闭时清理页面过滤监听器', async () => {
    const bus = new OFDEventBus();
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    const page = await doc.getPage(0);
    page.on('page:render:end', () => undefined);
    page.on('page:render:start', () => undefined);
    expect(bus.listenerCount('page:render:start')).toBe(1);
    expect(bus.listenerCount('page:render:end')).toBe(1);
    await doc.close();
    expect(bus.listenerCount('page:render:start')).toBe(0);
    expect(bus.listenerCount('page:render:end')).toBe(0);
  });
});

describe('document:close 事件与关闭后静默', () => {
  it('close() 中止活动 page:load 并派发 abort(cause=close)', async () => {
    const bytes = buildTwoPageOfd();
    const base = await openZipVirtualContainer({ kind: 'arraybuffer', data: bytes });
    const container: VirtualContainer = {
      packageSize: base.packageSize,
      encrypted: false,
      list: () => base.list(),
      has: (path) => base.has(path),
      stat: (path) => base.stat(path),
      read: (path, options) => {
        if (/Page_1\/Content\.xml$/.test(path)) {
          // 挂起页面内容读取，等待 close 的取消信号。
          return new Promise<Uint8Array>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new OFDError('OFD_ABORTED', '容器读取已取消')),
              { once: true },
            );
          });
        }
        return base.read(path, options);
      },
      close: () => base.close(),
    };
    const bus = new OFDEventBus();
    const doc = await OFDDocument.open({
      container,
      eventBus: bus,
      renderer: createTestRenderer(),
    });
    const events = recordEvents(bus);
    const loadSettled = rejectOf(doc.getPage(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(typesOf(events)).toEqual(['page:load:start']);

    await doc.close();
    const error = await loadSettled;
    expect(['OFD_ABORTED', 'OFD_CLOSED']).toContain(errorCode(error));
    expect(typesOf(events)).toEqual([
      'page:load:start',
      'document:close:start',
      'page:load:abort',
      'document:close:end',
    ]);
    const abort = events[2] as PageLoadAbortEvent;
    expect(abort.cause).toBe('close');
  });

  it('close:start → 活动 render abort(cause=close) → close:end；之后不再派发', async () => {
    const bus = new OFDEventBus();
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    const events = recordEvents(bus);
    const page = await doc.getPage(0);
    events.length = 0;

    const canvas = createTestCanvas(400, 800);
    const task = page.render({
      canvasContext: canvas.context,
      viewport: { width: 400, height: 800, dpi: 96 },
    });
    // render 已同步派发 start；关闭立即中止排队中的绘制。
    expect(typesOf(events)).toEqual(['page:render:start']);

    // 先挂接拒绝处理，避免关闭期间出现未处理 rejection。
    const taskSettled = rejectOf(task.promise);
    await doc.close();
    const taskError = await taskSettled;
    // 关闭语义允许 OFD_ABORTED 或 OFD_CLOSED，事件始终是 abort。
    expect(['OFD_ABORTED', 'OFD_CLOSED']).toContain(errorCode(taskError));
    expect(typesOf(events)).toEqual([
      'page:render:start',
      'document:close:start',
      'page:render:abort',
      'document:close:end',
    ]);
    const abort = events[2] as PageRenderAbortEvent;
    expect(abort.cause).toBe('close');
    const closeStart = events[1] as DocumentCloseStartEvent;
    const closeEnd = events[3] as DocumentCloseEndEvent;
    expect(closeStart.operationId).toBe(closeEnd.operationId);
    expect(closeEnd.abortedOperations).toBe(1);
    expect(closeEnd.durationMs).toBeGreaterThanOrEqual(0);

    const before = events.length;
    await doc.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(before);
  });

  it('无活动操作时 close:end.abortedOperations 为 0', async () => {
    const bus = new OFDEventBus();
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    const page = await doc.getPage(0);
    const canvas = createTestCanvas(400, 800);
    await page.render({
      canvasContext: canvas.context,
      viewport: { width: 400, height: 800, dpi: 96 },
    }).promise;
    const events = recordEvents(bus);
    await doc.close();
    expect(typesOf(events)).toEqual(['document:close:start', 'document:close:end']);
    expect((events[1] as DocumentCloseEndEvent).abortedOperations).toBe(0);
  });

  it('关闭后 getPage/render 不派发任何事件并以 OFD_CLOSED 拒绝', async () => {
    const bus = new OFDEventBus();
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    const page = await doc.getPage(0);
    await doc.close();
    const events = recordEvents(bus);

    const loadError = await rejectOf(doc.getPage(1));
    expect(errorCode(loadError)).toBe('OFD_CLOSED');

    const canvas = createTestCanvas(400, 800);
    const task = page.render({
      canvasContext: canvas.context,
      viewport: { width: 400, height: 800, dpi: 96 },
    });
    const renderError = await rejectOf(task.promise);
    expect(errorCode(renderError)).toBe('OFD_CLOSED');
    expect(events).toHaveLength(0);
  });

  it('事件载荷 sequence 从 1 递增且 operationId 按操作分配', async () => {
    const bus = new OFDEventBus();
    const doc = await openTestDocument(buildTwoPageOfd(), { eventBus: bus });
    const events = recordEvents(bus);
    events.length = 0;

    const page = await doc.getPage(0);
    const canvas = createTestCanvas(400, 800);
    await page.render({
      canvasContext: canvas.context,
      viewport: { width: 400, height: 800, dpi: 96 },
    }).promise;
    await doc.close();

    expect(typesOf(events)).toEqual([
      'page:load:start',
      'page:load:end',
      'page:render:start',
      'page:render:end',
      'document:close:start',
      'document:close:end',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    // 打开的 operationId 为 1；之后依次为 2、3、4。
    expect((events[0] as PageLoadStartEvent).operationId).toBe(2);
    expect((events[2] as PageRenderStartEvent).operationId).toBe(3);
    expect((events[4] as DocumentCloseStartEvent).operationId).toBe(4);
    for (const event of events) {
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
    }
  });
});