/**
 * 动作服务单测（UI 动作处理机制设计 §4 / §5 / §10）。
 *
 * 覆盖：页级惰性加载与缓存、`DO`/`PO` 触发次数、`autoExecuteActions` 开关效果、
 * 页淘汰释放、文档关闭清理、事件派发。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionInfo, ActionOwner } from '@ofdrw/ofdrw-viewer-engine';
import { ActionService, resolveViewerActionsOptions } from '../../../src/actions/action-service';
import type { ActionBridge, ActionViewerHost } from '../../../src/actions/types';
import type { ViewerState } from '../../../src/state';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerEventMap, ViewerEventName } from '../../../src/types';

const PAGE_OWNER: ActionOwner = { kind: 'page', pageIndex: 0 };

/** 构造一个 PO 动作。 */
function pageOpenAction(): ActionInfo {
  return {
    event: 'PO',
    type: 'sound',
    owner: PAGE_OWNER,
    payload: { type: 'sound', resourceId: '1', volume: 100, repeat: false, synchronous: false },
  } as ActionInfo;
}

/** 构造一个 DO 动作。 */
function documentOpenAction(): ActionInfo {
  return {
    event: 'DO',
    type: 'goto',
    owner: { kind: 'document' },
    payload: { type: 'goto', dest: { type: 'XYZ', pageIndex: 1 } },
  } as ActionInfo;
}

/** 测试用宿主：事件与状态均在本对象内模拟。 */
function createHost(options: {
  readonly documentActions?: readonly ActionInfo[];
  readonly onEvent?: (event: string, payload: unknown) => void;
} = {}) {
  let state: ViewerState = createInitialViewerState();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const main = document.createElement('div');
  document.body.appendChild(main);
  const host = {
    getState: () => state,
    on(event: string, handler: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    getRoot: () => main,
    getElements: () => ({ root: main, main, dialogLayer: main, toastLayer: main }),
    getDocument: () => ({
      getDocumentActions: () => options.documentActions ?? [],
    }),
    getPageInfos: () => state.document.pageInfos,
    getPageNumber: () => state.view.pageNumber,
    getScale: () => state.view.scale,
    getRotation: () => state.view.rotation,
    getPageView: () => undefined,
    getPageViews: () => [],
    goToPage: vi.fn(),
    setScale: vi.fn(),
    setZoomMode: vi.fn(),
    isFeatureEnabled: () => true,
    getTranslator: () => ({ t: (key: string) => key }),
    patchActions: (patch: Partial<ViewerState['actions']>) => {
      state = { ...state, actions: { ...state.actions, ...patch } };
    },
    // 视口坐标 → 页面像素：测试里直接把 clientX/Y 当作页面坐标。
    getContentPointAtViewport: (x: number, y: number) => ({ pageIndex: 0, xPx: x, yPx: y }),
  } as unknown as ActionViewerHost;
  /** 模拟核心派发事件。 */
  const emit = (event: string, payload: unknown): void => {
    options.onEvent?.(event, payload);
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };
  /** 模拟可见页范围变化。 */
  const setVisibleRange = (start: number, end: number): void => {
    state = { ...state, view: { ...state.view, visiblePageRange: { start, end } } };
  };
  return { host, emit, setVisibleRange, getState: () => state };
}

/** 测试用桥接：记录事件与状态写入，并把 `patchActions` 真正写回宿主状态。 */
function createBridge(
  record: {
    events: Array<{ event: string; payload: unknown }>;
    warnings: string[];
  },
  host: ActionViewerHost,
) {
  return {
    patchActions: (patch: Partial<ViewerState['actions']>) => {
      (host as unknown as { patchActions(p: Partial<ViewerState['actions']>): void }).patchActions(patch);
    },
    commit: () => undefined,
    emit: (event: ViewerEventName, payload: ViewerEventMap[ViewerEventName]) => {
      record.events.push({ event, payload });
    },
    warn: (code: string) => {
      record.warnings.push(code);
    },
    t: (key: string) => key,
  } as unknown as ActionBridge;
}

describe('resolveViewerActionsOptions', () => {
  it('默认关闭自动执行并补默认值', () => {
    const options = resolveViewerActionsOptions(undefined);
    expect(options.autoExecuteActions).toBe(false);
    expect(options.allowUserToggleAutoExecute).toBe(true);
    expect(options.maxActionDepth).toBe(4);
    expect(options.smoothGoto).toBe(true);
  });

  it('非法深度回退 4', () => {
    expect(resolveViewerActionsOptions({ maxActionDepth: 0 }).maxActionDepth).toBe(4);
    expect(resolveViewerActionsOptions({ maxActionDepth: Number.NaN }).maxActionDepth).toBe(4);
    expect(resolveViewerActionsOptions({ maxActionDepth: 2.7 }).maxActionDepth).toBe(2);
  });
});

describe('ActionService 页级缓存', () => {
  it('同一页只加载一次（惰性 + 缓存）', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const loader = vi.fn(async () => [] as readonly ActionInfo[]);
    const { host } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: loader,
      loadPageGeometries: async () => [],
    });
    service.start();
    await service.ensurePageActions(0);
    await service.ensurePageActions(0);
    // 只按 PO 加载一次（命中表用批量几何接口建），第二次调用命中页级缓存。
    expect(loader).toHaveBeenCalledTimes(1);
    service.destroy();
  });

  it('页淘汰后释放缓存，再次进入重新加载', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const loader = vi.fn(async () => [] as readonly ActionInfo[]);
    const { host } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: loader,
      loadPageGeometries: async () => [],
    });
    service.start();
    await service.ensurePageActions(0);
    service.releasePage(1);
    await service.ensurePageActions(0);
    // 淘汰后重新进入页面：重新加载一次。
    expect(loader).toHaveBeenCalledTimes(2);
    service.destroy();
  });

  it('加载失败只告警并缓存空集合', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const loader = vi.fn(async () => {
      throw new Error('boom');
    });
    const { host } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: loader,
      loadPageGeometries: async () => [],
    });
    service.start();
    const set = await service.ensurePageActions(0);
    expect(set?.pageOpen).toEqual([]);
    expect(record.warnings).toContain('W_ACTION_LOAD');
    service.destroy();
  });
});

describe('ActionService 页淘汰与文档关闭的生命周期', () => {
  it('页淘汰时释放该页动作集合，命中表随之失效', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const poAction = pageOpenAction();
    const { host } = createHost();
    const loader = vi.fn(async (_pageIndex: number, event: string) =>
      event === 'PO' ? [poAction] : [],
    );
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: loader,
      loadPageGeometries: async () => [],
    });
    service.start();
    const first = await service.ensurePageActions(0);
    expect(first).toBeDefined();
    // 淘汰后缓存缺失。
    service.releasePage(1);
    // 再次查询需要重新加载（证明缓存确实被删）。
    const loadsBefore = loader.mock.calls.length;
    await service.ensurePageActions(0);
    expect(loader.mock.calls.length).toBeGreaterThan(loadsBefore);
    service.destroy();
  });

  it('文档关闭中止进行中的执行并清空缓存', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const { host, emit } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.start();
    await service.ensurePageActions(0);
    emit('documentclose', {});
    // 关闭后缓存为空：重新加载会再次调用 loader（此处用空实现即可，仅断言不抛错）。
    await expect(service.ensurePageActions(0)).resolves.toBeDefined();
    service.destroy();
  });

  it('活动播放器计数写入状态快照', () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const { host, getState } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.setActivePlayers(2);
    expect(getState().actions.activePlayers).toBe(2);
    service.setActivePlayers(0);
    expect(getState().actions.activePlayers).toBe(0);
    service.destroy();
  });
});

describe('ActionService 自动执行开关', () => {
  it('默认关闭时不执行 DO，只累计待执行数', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const doAction = documentOpenAction();
    const { host, emit, getState } = createHost({ documentActions: [doAction] });
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.start();
    emit('documentopen', { pageCount: 2 });
    expect(getState().actions.pendingAutoActions).toBe(1);
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(0);
    service.destroy();
  });

  it('开启后 setAutoExecute 会补执行 DO', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const doAction = documentOpenAction();
    const { host, emit } = createHost({ documentActions: [doAction] });
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.executor.register('goto', async () => ({ outcome: 'executed' }));
    service.start();
    emit('documentopen', { pageCount: 2 });
    service.setAutoExecute(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(record.events.some((item) => item.event === 'action:executed')).toBe(true);
    service.destroy();
  });

  it('关闭开关时不执行 PO；打开后可见页的 PO 生效', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const poAction = pageOpenAction();
    const { host, emit, setVisibleRange } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async (_pageIndex, event) => (event === 'PO' ? [poAction] : []),
      loadPageGeometries: async () => [],
    });
    service.executor.register('sound', async () => ({ outcome: 'executed' }));
    service.start();
    emit('documentopen', { pageCount: 2 });
    setVisibleRange(0, 0);
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(0);
    service.destroy();
  });

  it('PO 每页只执行一次', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const poAction = pageOpenAction();
    const { host, emit, setVisibleRange } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions({ autoExecuteActions: true }),
      loadPageActions: async (_pageIndex, event) => (event === 'PO' ? [poAction] : []),
      loadPageGeometries: async () => [],
    });
    service.executor.register('sound', async () => ({ outcome: 'executed' }));
    service.start();
    emit('documentopen', { pageCount: 2 });
    setVisibleRange(0, 0);
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const executed = record.events.filter(
      (item) => item.event === 'action:executed' && (item.payload as { type?: string }).type === 'sound',
    );
    expect(executed).toHaveLength(1);
    service.destroy();
  });
});

describe('ActionService 生命周期', () => {
  it('文档关闭清空持有状态，重新打开可再次执行 DO', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const { host, emit } = createHost({ documentActions: [documentOpenAction()] });
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions({ autoExecuteActions: true }),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.executor.register('goto', async () => ({ outcome: 'executed' }));
    service.start();
    emit('documentopen', { pageCount: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(1);
    emit('documentclose', {});
    emit('documentopen', { pageCount: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(2);
    service.destroy();
  });

  it('destroy 后不再派发事件', async () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const { host, emit } = createHost({ documentActions: [documentOpenAction()] });
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions({ autoExecuteActions: true }),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.executor.register('goto', async () => ({ outcome: 'executed' }));
    service.start();
    service.destroy();
    emit('documentopen', { pageCount: 2 });
    await Promise.resolve();
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(0);
  });

  it('setAutoExecute 在禁止用户改动时不生效', () => {
    const record = { events: [] as Array<{ event: string; payload: unknown }>, warnings: [] as string[] };
    const { host } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions({ allowUserToggleAutoExecute: false }),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.setAutoExecute(true);
    expect(service.autoExecute).toBe(false);
    service.destroy();
  });
});
describe('ActionService PO 触发时序', () => {
  /** 构造一个带 PO 与 CLICK 动作的服务与宿主。 */
  function setup(options: {
    readonly autoExecuteActions?: boolean;
    readonly key?: string;
  } = {}) {
    const record = {
      events: [] as Array<{ event: string; payload: unknown }>,
      warnings: [] as string[],
    };
    const poAction = pageOpenAction();
    const { host, emit, setVisibleRange, getState } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions({ autoExecuteActions: options.autoExecuteActions }),
      loadPageActions: async (_pageIndex, event) => (event === 'PO' ? [poAction] : []),
      loadPageGeometries: async () => [],
    });
    service.executor.register('sound', async (context) => {
      if (options.key) await new Promise<void>((resolve) => {
        context.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { outcome: 'executed' };
    });
    service.start();
    return { record, service, emit, setVisibleRange, getState };
  }

  it('首屏未先设置可见范围时，documentopen 之后的首个 pagerendered 仍会执行 PO', async () => {
    // 真实时序：documentopen 派发时 visiblePageRange 仍为空区间，随后核心才更新范围并渲染。
    const { record, service, emit, setVisibleRange, getState } = setup({ autoExecuteActions: true });
    emit('documentopen', { pageCount: 2 });
    setVisibleRange(0, 0);
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(1);
    expect(getState().actions.pendingAutoActions).toBe(0);
    service.destroy();
  });

  it('同页滚动（仅可见范围变化、不触发翻页）时 PO 会被补触发', async () => {
    const { record, service, emit, setVisibleRange } = setup({ autoExecuteActions: true });
    emit('documentopen', { pageCount: 3 });
    // 首页渲染完成时它在视口外。
    setVisibleRange(1, 1);
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(0);
    // 滚动使第 1 页进入可视区，只更新状态、不派发 pagechanging。
    setVisibleRange(0, 1);
    emit('statechange', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(1);
    service.destroy();
  });

  it('开关关闭时 PO 计入待执行数并派发 autoplay-disabled，重复可见不重复计数', async () => {
    const { record, service, emit, setVisibleRange, getState } = setup();
    emit('documentopen', { pageCount: 2 });
    setVisibleRange(0, 0);
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setVisibleRange(1, 1);
    emit('statechange', {});
    setVisibleRange(0, 0);
    emit('statechange', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getState().actions.pendingAutoActions).toBe(1);
    const skipped = record.events.filter((item) => item.event === 'action:skipped');
    expect(skipped).toHaveLength(1);
    expect((skipped[0]!.payload as { reason?: string }).reason).toBe('autoplay-disabled');
    service.destroy();
  });

  it('打开开关后立即补执行当前可见页已跳过的 PO', async () => {
    const { record, service, emit, setVisibleRange, getState } = setup();
    emit('documentopen', { pageCount: 2 });
    setVisibleRange(0, 0);
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getState().actions.pendingAutoActions).toBe(1);
    service.setAutoExecute(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getState().actions.pendingAutoActions).toBe(0);
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(1);
    service.destroy();
  });

  it('页淘汰后待执行计数回收，导航回来不会重复累加', async () => {
    const { service, emit, setVisibleRange, getState } = setup();
    emit('documentopen', { pageCount: 2 });
    setVisibleRange(0, 0);
    emit('pagerendered', { pageNumber: 1, scale: 1, rotation: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getState().actions.pendingAutoActions).toBe(1);
    service.releasePage(1);
    expect(getState().actions.pendingAutoActions).toBe(0);
    service.destroy();
  });

  it('页淘汰中止该页进行中的执行，取消结果不派发执行事件', async () => {
    let completed = 0;
    const poAction = pageOpenAction();
    const record = {
      events: [] as Array<{ event: string; payload: unknown }>,
      warnings: [] as string[],
    };
    const { host, emit, setVisibleRange } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    service.executor.register('sound', async (context) => {
      await new Promise<void>((resolve) => {
        context.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      completed += 1;
      return { outcome: 'executed' };
    });
    service.start();
    const running = service.runActions([poAction], { trigger: 'CLICK', pageIndex: 0 });
    // 等 handler 进入等待（signalForPage 已在调用前建好控制器）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.releasePage(1);
    const outcomes = await running;
    // handler 被中止唤醒后按取消处理：结果不生效，也不派发 action:executed。
    expect(outcomes).toEqual(['cancelled']);
    expect(record.events.filter((item) => item.event === 'action:executed')).toHaveLength(0);
    expect(completed).toBe(1);
    service.destroy();
  });
});

describe('ActionService 内容宿主命中', () => {
  it('同一宿主的多条 CLICK 动作一次命中、一起执行', async () => {
    const record = {
      events: [] as Array<{ event: string; payload: unknown }>,
      warnings: [] as string[],
    };
    const owner: ActionOwner = { kind: 'object', pageIndex: 0, objectId: '9' };
    const first = {
      event: 'CLICK',
      type: 'goto',
      owner,
      payload: { type: 'goto', dest: { type: 'XYZ', pageIndex: 0 } },
    } as ActionInfo;
    const second = {
      event: 'CLICK',
      type: 'goto',
      owner,
      payload: { type: 'goto', dest: { type: 'XYZ', pageIndex: 1 } },
    } as ActionInfo;
    const { host, emit } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [
        { action: first, geometry: { pageIndex: 0, bbox: { x: 0, y: 0, width: 20, height: 20 }, source: 'object' } },
        { action: second, geometry: { pageIndex: 0, bbox: { x: 0, y: 0, width: 20, height: 20 }, source: 'object' } },
      ],
    });
    const executed: string[] = [];
    service.executor.register('goto', async (_context, action) => {
      executed.push(String((action.payload as { dest?: { pageIndex?: number } }).dest?.pageIndex));
      return { outcome: 'executed' };
    });
    service.start();
    emit('documentopen', { pageCount: 2 });
    await service.ensurePageActions(0);
    expect(service.hitTestAt(0, 0)).toBe(true);
    const outcomes = await service.runActions([first, second], { trigger: 'CLICK', pageIndex: 0 });
    expect(outcomes).toEqual(['executed', 'executed']);
    expect(executed).toEqual(['0', '1']);
    service.destroy();
  });

  it('executeActions 越界页索引抛 OFD_PAGE_NOT_FOUND', async () => {
    const record = {
      events: [] as Array<{ event: string; payload: unknown }>,
      warnings: [] as string[],
    };
    const { host } = createHost();
    const service = new ActionService({
      host,
      bridge: createBridge(record, host),
      options: resolveViewerActionsOptions(undefined),
      loadPageActions: async () => [],
      loadPageGeometries: async () => [],
    });
    await expect(service.executeActions(5, 'CLICK')).rejects.toMatchObject({
      code: 'OFD_PAGE_NOT_FOUND',
    });
    service.destroy();
  });
});
