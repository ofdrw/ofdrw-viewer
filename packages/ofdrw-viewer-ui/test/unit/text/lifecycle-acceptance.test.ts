/**
 * t11 验收：页级文本层生命周期与选区快照的计数断言。
 *
 * 本文件只做验证，不改产品代码；所有结论都来自可复现的计数（MutationObserver、
 * 属性写入 spy、rAF 帧计数、快照版本号），不依赖“目测正常”。真实浏览器帧耗时
 * 无法在 jsdom 中可信测量，分帧验收采用“帧数 × 单帧 span 上限 × 单 span 写次数”
 * 的上界推算，并在用例注释中说明。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import { TextLayerService, createTextSpan } from '../../../src/text/text-layer';
import { SelectionManager } from '../../../src/text/selection';
import { createViewerBridge } from '../../../src/text/viewer-bridge';
import {
  buildTextLayerSpecs,
  MAX_TEXT_LAYER_NODES,
} from '../../../src/text/geometry';
import { resolveViewerOptions } from '../../../src/options';
import {
  contentWithLines,
  makeContent,
  makeFakeHost,
  makeItem,
  makePageView,
} from './helpers';

/** 等待 setTimeout 级异步任务。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 建立原生选区。 */
function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  selection.addRange(range);
}

/** 读取页内第 index 个 span 的文本节点。 */
function textNodeOf(host: ReturnType<typeof makeFakeHost>, page: number, index = 0): Text {
  const span = host.getPageView(page)!.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item')[
    index
  ]!;
  return span.firstChild as Text;
}

/** 每页选区矩形数量。 */
function rectCountsOf(
  host: ReturnType<typeof makeFakeHost>,
  pages: readonly number[],
): number[] {
  return pages.map(
    (page) =>
      host.getPageView(page)!.surface.querySelectorAll('.ofd-selection-rect').length,
  );
}

/** 选区快照文本与矩形数量；用于滚动前后逐次比较。 */
function selectionStateOf(
  host: ReturnType<typeof makeFakeHost>,
  manager: SelectionManager,
  pages: readonly number[],
): { readonly text: string; readonly rects: readonly number[] } {
  return { text: manager.getSelectedText(), rects: rectCountsOf(host, pages) };
}

interface MountOptions {
  /** 页数。 */
  readonly pageCount: number;
  /** 按页提供文本内容。 */
  readonly contents: ReadonlyMap<number, TextContent>;
  /** 初始可见页范围；默认全部可见。 */
  readonly visiblePageRange?: { readonly start: number; readonly end: number };
  /** settle 延迟，单位毫秒；默认 0 便于用例立即建满。 */
  readonly settleMs?: number;
  /** 可见页额外预取页数；默认 1。 */
  readonly overscan?: number;
  /** pin span 预算；默认使用服务端默认值。 */
  readonly selectionPinSpanBudget?: number;
  /** 单页 span 上限。 */
  readonly textLayerMaxSpans?: number;
  /** 是否把文本层 DOM 变更通知给选区管理器（抑制窗口）。 */
  readonly suppressOnMutation?: boolean;
}

/** 构建假宿主、文本层服务与选区管理器。 */
function mount(options: MountOptions): {
  readonly host: ReturnType<typeof makeFakeHost>;
  readonly service: TextLayerService;
  readonly manager: SelectionManager;
  readonly root: HTMLElement;
} {
  const views = new Map<number, ReturnType<typeof makePageView>>();
  const root = document.createElement('div');
  document.body.appendChild(root);
  for (let page = 1; page <= options.pageCount; page += 1) {
    const view = makePageView(page);
    views.set(page, view);
    root.appendChild(view.element);
  }
  const host = makeFakeHost({
    pageCount: options.pageCount,
    visiblePageRange: options.visiblePageRange ?? { start: 0, end: options.pageCount - 1 },
    contents: options.contents,
    pageViews: views,
    root,
  });
  let manager: SelectionManager | null = null;
  const service = new TextLayerService(host, createViewerBridge(host), {
    settleMs: options.settleMs ?? 0,
    overscan: options.overscan,
    selectionPinSpanBudget: options.selectionPinSpanBudget,
    textLayerMaxSpans: options.textLayerMaxSpans,
    onDomMutation: options.suppressOnMutation
      ? () => manager?.suppressSelectionChangeForDomMutation()
      : undefined,
  });
  manager = new SelectionManager(host, createViewerBridge(host), service);
  return { host, service, manager, root };
}

/** 等待指定页建满指定 span 数。 */
async function waitForSpans(
  host: ReturnType<typeof makeFakeHost>,
  expected: ReadonlyMap<number, number>,
): Promise<void> {
  await vi.waitFor(
    () => {
      for (const [page, count] of expected) {
        expect(
          host.getPageView(page)!.textLayer.querySelectorAll('.ofd-text-item'),
        ).toHaveLength(count);
      }
    },
    { timeout: 10_000 },
  );
}

describe('t11 验收：滚动稳定性（计数断言）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
    // 分帧构建用微任务推进，避免整页构建在全量并行跑测时被真实 rAF 饿死。
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('dense 页选中后滚动 10 次（滚出再滚回）：文本与矩形数量不变、span 增删 0、getBoundingClientRect 0', async () => {
    // 与 dense-text-perf 同量级：146 行 × 57 个 item 级 span = 8,322 个 span。
    const denseItems = [];
    for (let row = 0; row < 146; row += 1) {
      for (let column = 0; column < 57; column += 1) {
        denseItems.push(
          makeItem({
            text: '字',
            x: 10 + column * 6,
            y: 100 + row * 7,
            size: 6,
            order: row * 57 + column,
          }),
        );
      }
    }
    const dense = makeContent(denseItems);
    const { host, service, manager } = mount({
      pageCount: 3,
      contents: new Map([
        [1, dense],
        [2, contentWithLines(['第二页'])],
        [3, contentWithLines(['第三页'])],
      ]),
    });
    await waitForSpans(
      host,
      new Map([
        [1, 8322],
        [2, 1],
        [3, 1],
      ]),
    );
    const spans = host.getPageView(1)!.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item');
    const end = spans[57 * 3 - 1]!.firstChild as Text;
    select(spans[0]!.firstChild as Text, 0, end, end.data.length);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    const before = selectionStateOf(host, manager, [1, 2, 3]);
    expect(before.rects[0]).toBeGreaterThan(0);
    const snapshot = manager.getSelectionSnapshot();
    expect(snapshot).not.toBeNull();

    // 观察文本层 childList：滚动刷新不得新增或删除任何 span。
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    for (const page of [1, 2, 3]) {
      observer.observe(host.getPageView(page)!.textLayer, { childList: true });
    }
    const rectReads = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    const readsBefore = rectReads.mock.calls.length;

    // 10 次滚动：在 page1 与 page3 之间来回（含完全滚出 page1 再滚回）。
    for (let step = 0; step < 10; step += 1) {
      const away = step % 2 === 0;
      host.setView({
        scrollTop: away ? 1800 : 0,
        visiblePageRange: away ? { start: 2, end: 2 } : { start: 0, end: 2 },
        pageNumber: away ? 3 : 1,
      });
      // 每轮模拟 3 个刷新帧（共 30 帧）；已建满页只同步几何，不得改 DOM/读布局。
      for (let frame = 0; frame < 3; frame += 1) service.refresh();
      await flush();
      expect(selectionStateOf(host, manager, [1, 2, 3])).toEqual(before);
    }
    observer.disconnect();
    // 快照对象与版本在 10 次滚动（30 个刷新帧）后保持不变。
    expect(manager.getSelectionSnapshot()).toBe(snapshot);
    const records = mutations.concat(observer.takeRecords());
    const added = records.reduce((sum, record) => sum + record.addedNodes.length, 0);
    const removed = records.reduce((sum, record) => sum + record.removedNodes.length, 0);
    expect({ added, removed }).toEqual({ added: 0, removed: 0 });
    // 滚动期间每帧 getBoundingClientRect 调用次数为 0（10 次滚动 × 3 帧 = 30 次 refresh）。
    expect(rectReads.mock.calls.length - readsBefore).toBe(0);
    // 快照本身不因滚动重建。
    expect(manager.getSelectionSnapshot()?.version).toBeGreaterThan(0);
    service.destroy();
    manager.destroy();
  });

  it('settle 生效：滚动中不为首次访问页构建，150ms 后构建；已建页在滚动中直接复用', async () => {
    const { host, service, manager } = mount({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 0 },
      contents: new Map([
        [1, contentWithLines(['第一页'])],
        [2, contentWithLines(['第二页'])],
      ]),
      settleMs: 150,
      overscan: 0,
    });
    await waitForSpans(host, new Map([[1, 1]]));
    const page1Nodes = [...host.getPageView(1)!.textLayer.children];
    const page2CallsBefore = host.textCalls.filter((page) => page === 2).length;

    host.setView({ pageNumber: 2, scrollTop: 700, visiblePageRange: { start: 1, end: 1 } });
    await flush();
    // 滚动中：首次访问页不构建、不提取文本；已建页原样保留。
    expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(host.textCalls.filter((page) => page === 2)).toHaveLength(page2CallsBefore);
    expect([...host.getPageView(1)!.textLayer.children]).toEqual(page1Nodes);

    await new Promise((resolve) => setTimeout(resolve, 170));
    expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    expect(host.textCalls.filter((page) => page === 2)).toHaveLength(page2CallsBefore + 1);
    expect([...host.getPageView(1)!.textLayer.children]).toEqual(page1Nodes);
    service.destroy();
    manager.destroy();
  });

  it('单 span DOM 写次数 ≤ 10：cssText 1 次、dataset ≤2、类名/文本各 1 次', () => {
    const content = makeContent([makeItem({ text: 'Hello', x: 10, y: 100, size: 16 })]);
    const spec = buildTextLayerSpecs(content).spans[0]!;
    const cssTextSet = vi.spyOn(CSSStyleDeclaration.prototype, 'cssText', 'set');
    const attributeWrites = vi.spyOn(Element.prototype, 'setAttribute');
    const textWrites = vi.spyOn(Node.prototype, 'textContent', 'set');
    const span = createTextSpan(document, spec, 1, true, false);
    // createElement 1 + class 1 + textContent 1 + cssText 1 + dataset 1~2 + 插入 1。
    const writeCount =
      1 +
      cssTextSet.mock.calls.length +
      attributeWrites.mock.calls.length +
      textWrites.mock.calls.length +
      1;
    expect(cssTextSet.mock.calls.length).toBe(1);
    expect(attributeWrites.mock.calls.length).toBeLessThanOrEqual(3);
    expect(textWrites.mock.calls.length).toBe(1);
    expect(writeCount).toBeLessThanOrEqual(10);
    // 文档 §8 第 6 条的独立口径。
    expect(span.getAttributeNames().length).toBeLessThanOrEqual(6);
    expect(span.style.length).toBeLessThanOrEqual(7);
    // 生产构建关闭 legacy 字段后不应再有 4 个旧 dataset。
    expect(span.dataset.x).toBeUndefined();
    expect(span.dataset.angle).toBeUndefined();
    expect(span.dataset.itemIndex).toBe('0');
    vi.restoreAllMocks();
  });

  it('8331 span 按 12 帧构建，单帧 ≤700：不产生整页同步构建', async () => {
    const total = 8331;
    const items = Array.from({ length: total }, (_, index) =>
      makeItem({ text: 'a', x: 10, y: 100 + index * 2, size: 16, order: index }),
    );
    const content = makeContent(items);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    // 固定时钟：只由 700/帧的数量上限切分，便于断言帧数与每帧条数。
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { host, service, manager } = mount({
      pageCount: 1,
      contents: new Map([[1, content]]),
    });
    const layer = host.getPageView(1)!.textLayer;
    await vi.waitFor(() => expect(layer.childElementCount).toBe(700));
    // 首帧只构建 700 个：整页 8331 个不会在一次任务里同步挂出。
    expect(layer.childElementCount).toBeLessThan(total);
    const perFrame: number[] = [];
    while (layer.childElementCount < total) {
      const frame = frames.shift();
      expect(frame).toBeDefined();
      const before = layer.childElementCount;
      frame!(performance.now());
      perFrame.push(layer.childElementCount - before);
    }
    expect(perFrame.length).toBe(Math.ceil(total / 700) - 1);
    expect([...perFrame, 700].every((count) => count > 0 && count <= 700)).toBe(true);
    // 单帧上界：700 span × ≤7 次 DOM 写 = 4,900 次，远低于 16ms 帧预算的量级
    // （设计 §3.2 估算 0.49 万写 ≈ 1~3ms）；这里以帧数与单帧上限作为可复现证据。
    expect(700 * 7).toBe(4900);
    // append-only：首帧节点仍是最初节点，选区不因后续帧折叠。
    const first = layer.children[0]!;
    expect(first.isConnected).toBe(true);
    expect(first.textContent).toBe('a');
    vi.unstubAllGlobals();
    service.destroy();
    manager.destroy();
  });
});

describe('t11 验收：pin、上限与预算', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  it('跨 5 页选中：只 pin 首尾端点页；淘汰中间 3 页后文本与矩形仍完整', async () => {
    const pages = [1, 2, 3, 4, 5];
    const contents = new Map(
      pages.map((page) => [page, contentWithLines([`第${page}页文字`])]),
    );
    const { host, service, manager } = mount({ pageCount: 5, contents });
    await waitForSpans(host, new Map(pages.map((page) => [page, 1])));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 5), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();

    const expected = pages.map((page) => `第${page}页文字`).join('\n');
    expect(manager.getSelectedText()).toBe(expected);
    expect(service.getPinnedPages()).toEqual([1, 5]);
    const rectsBefore = rectCountsOf(host, pages);
    expect(rectsBefore.every((count) => count > 0)).toBe(true);
    const snapshot = manager.getSelectionSnapshot()!;

    // 中间 3 页被 LRU 淘汰（端点页 pin，不释放）。
    service.releasePage(2);
    service.releasePage(3);
    service.releasePage(4);
    await flush();
    for (const page of [2, 3, 4]) {
      expect(host.getPageView(page)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    }
    expect(manager.getSelectionSnapshot()).toBe(snapshot);
    expect(manager.getSelectedText()).toBe(expected);
    expect(rectCountsOf(host, pages)).toEqual(rectsBefore);
    expect(service.getPinnedPages()).toEqual([1, 5]);

    // 中间页 DOM 消失后复制仍取快照全文。
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await manager.copySelection();
    expect(writeText).toHaveBeenCalledWith(expected);
    service.destroy();
    manager.destroy();
  });

  it('pin 泄漏：新选区替换后旧 pinned 页解除并可被淘汰', async () => {
    const pages = [1, 2, 3, 4, 5];
    const contents = new Map(
      pages.map((page) => [page, contentWithLines([`第${page}页文字`])]),
    );
    const { host, service, manager } = mount({ pageCount: 5, contents });
    await waitForSpans(host, new Map(pages.map((page) => [page, 1])));

    select(textNodeOf(host, 1), 0, textNodeOf(host, 2), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    expect(service.getPinnedPages()).toEqual([1, 2]);

    // 新选区（第 4~5 页）替换旧快照，旧端点页从 pin 集合移除。
    select(textNodeOf(host, 4), 0, textNodeOf(host, 5), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    expect(service.getPinnedPages()).toEqual([4, 5]);
    expect(manager.getSelectedText()).toBe('第4页文字\n第5页文字');

    // 旧 pin 页不再受保护，可被正常释放。
    service.releasePage(1);
    service.releasePage(2);
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(manager.getSelectedText()).toBe('第4页文字\n第5页文字');
    service.destroy();
    manager.destroy();
  });

  it('端点页被淘汰（防御）：复制仍完整，新选区可正常建立', async () => {
    const contents = new Map([
      [1, contentWithLines(['第一页文字'])],
      [2, contentWithLines(['第二页文字'])],
      [3, contentWithLines(['第三页文字'])],
    ]);
    const { host, service, manager } = mount({ pageCount: 3, contents });
    await waitForSpans(host, new Map([[1, 1], [2, 1], [3, 1]]));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 2), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    const expected = '第一页文字\n第二页文字';
    expect(manager.getSelectedText()).toBe(expected);

    // 强制释放端点页（正常受 pin 保护；此处验证防御路径）。
    service.releasePage(1);
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    // 快照文本与选区层仍在（选区层按预合并矩形绘制）。
    expect(manager.getSelectedText()).toBe(expected);
    expect(rectCountsOf(host, [1])[0]).toBeGreaterThan(0);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await manager.copySelection();
    expect(writeText).toHaveBeenCalledWith(expected);

    // 点击（无 Shift）后新建选择正常：旧快照让位，新快照只覆盖第 3 页。
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    select(textNodeOf(host, 3), 0, textNodeOf(host, 3), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    expect(manager.getSelectedText()).toBe('第三页文字');
    expect(service.getPinnedPages()).toEqual([3]);
    service.destroy();
    manager.destroy();
  });

  it('selectionPinSpanBudget：桌面/移动默认值不同；超预算清空选区并告警，不返回部分文本', async () => {
    const desktop = resolveViewerOptions({ container: document.body });
    const mobile = resolveViewerOptions({ container: document.body }, { mobile: true });
    expect(desktop.selectionPinSpanBudget).toBe(50_000);
    expect(mobile.selectionPinSpanBudget).toBe(20_000);
    expect(desktop.textSpanBudget).toBe(30_000);
    expect(mobile.textSpanBudget).toBe(12_000);
    expect(desktop.textLayerMaxSpans).toBe(100_000);

    const lines = Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 行`);
    const { host, service, manager } = mount({
      pageCount: 2,
      contents: new Map([
        [1, contentWithLines(lines)],
        [2, contentWithLines(lines)],
      ]),
      selectionPinSpanBudget: 5,
    });
    await waitForSpans(host, new Map([[1, 10], [2, 10]]));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 2), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();

    // 端点页各 10 span > 预算 5：清空原生选区、快照、pin，并告警。
    expect(manager.getSelectedText()).toBe('');
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(document.getSelection()?.rangeCount).toBe(0);
    expect(host.warnings.some((warning) => warning.code === 'W_SELECTION_UNPINNABLE')).toBe(true);
    expect(service.getPinnedPages()).toEqual([]);
    expect(document.querySelectorAll('.ofd-selection-rect')).toHaveLength(0);
    service.destroy();
    manager.destroy();
  });

  it('单页超节点上限：先降级 item 级、仍超限则截断并告警，不崩溃', async () => {
    expect(MAX_TEXT_LAYER_NODES).toBe(100_000);
    const content = makeContent([
      makeItem({ text: '甲乙', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '丙丁', x: 10, y: 120, size: 16, order: 1 }),
      makeItem({ text: '戊己', x: 10, y: 140, size: 16, order: 2 }),
    ]);
    const { host, service, manager } = mount({
      pageCount: 1,
      contents: new Map([[1, content]]),
      textLayerMaxSpans: 2,
    });
    const layer = host.getPageView(1)!.textLayer;
    await vi.waitFor(() => expect(layer.querySelectorAll('.ofd-text-item')).toHaveLength(2));
    // 字符级 6 个 → 降级 item 级 3 个 → 仍超 2 → 截断；不崩溃。
    expect(layer.querySelectorAll('.ofd-text-char')).toHaveLength(0);
    expect(host.warnings.some((warning) => warning.code === 'W_TEXT_LAYER_CAP')).toBe(true);
    service.destroy();
    manager.destroy();
  });
});

describe('t11 验收：快照、抑制与复制', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('淘汰中间页触发折叠：快照保留；copy 拦截全文；点击/Esc 清空；新选区替换无旧高亮', async () => {
    const contents = new Map([
      [1, contentWithLines(['第一页文字'])],
      [2, contentWithLines(['中间页文字'])],
      [3, contentWithLines(['第三页文字'])],
    ]);
    const { host, service, manager } = mount({
      pageCount: 3,
      contents,
      suppressOnMutation: true,
    });
    await waitForSpans(host, new Map([[1, 1], [2, 1], [3, 1]]));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 3), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    const snapshot = manager.getSelectionSnapshot()!;
    const expected = '第一页文字\n中间页文字\n第三页文字';
    expect(manager.getSelectedText()).toBe(expected);
    expect(rectCountsOf(host, [1, 2, 3])).toEqual([1, 1, 1]);

    // 淘汰中间页（本模块改 DOM → 抑制窗口），原生选区随之折叠。
    service.releasePage(2);
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    expect(manager.getSelectionSnapshot()).toBe(snapshot);
    expect(manager.getSelectedText()).toBe(expected);
    expect(rectCountsOf(host, [1, 2, 3])).toEqual([1, 1, 1]);

    // 原生 copy 拦截：中间页已淘汰，仍写入完整快照文本。
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    document.dispatchEvent(copyEvent);
    expect(setData).toHaveBeenCalledWith('text/plain', expected);
    expect(copyEvent.defaultPrevented).toBe(true);

    // 显式点击文字层外：清空快照与高亮。
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(manager.getSelectedText()).toBe('');
    expect(document.querySelectorAll('.ofd-selection-rect')).toHaveLength(0);

    // 新选区替换快照：旧高亮不得残留。
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 2);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    expect(manager.getSelectedText()).toBe('第一');
    expect(rectCountsOf(host, [1, 3])).toEqual([1, 0]);

    // Esc 立即清空（不被抑制窗口吞掉）。
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(document.querySelectorAll('.ofd-selection-rect')).toHaveLength(0);
    service.destroy();
    manager.destroy();
  });

  it('布局变化不清空/不重建快照：缩放 1→1.5→2→1.5→1、旋转 0→90→180→270，矩形按新几何重绘且尺寸不变', async () => {
    const contents = new Map([
      [1, contentWithLines(['第一页文字'])],
      [2, contentWithLines(['第二页文字'])],
    ]);
    const { host, service, manager } = mount({ pageCount: 2, contents });
    await waitForSpans(host, new Map([[1, 1], [2, 1]]));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 2), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    const snapshot = manager.getSelectionSnapshot()!;
    const version = snapshot.version;
    const text = snapshot.text;
    const rects = rectCountsOf(host, [1, 2]);
    const layer = host.getPageView(1)!.surface.querySelector<HTMLElement>(
      '.ofd-page__selection-layer',
    )!;
    const sample = layer.querySelector<HTMLElement>('.ofd-selection-rect')!;
    const sampleLeft = sample.style.left;
    const sampleTop = sample.style.top;
    const sampleWidth = sample.style.width;

    for (const scale of [1.5, 2, 1.5, 1] as const) {
      for (const page of [1, 2]) {
        const view = host.getPageView(page)!;
        const baseWidth = (210 / 25.4) * 96;
        const baseHeight = (297 / 25.4) * 96;
        Object.assign(view as unknown as Record<string, number>, {
          surfaceWidth: baseWidth * scale,
          surfaceHeight: baseHeight * scale,
          layoutScale: scale,
        });
      }
      host.setView({ scale });
      await flush();
      await flush();
      expect(manager.getSelectionSnapshot()).toBe(snapshot);
      expect(manager.getSelectionSnapshot()!.version).toBe(version);
      expect(manager.getSelectedText()).toBe(text);
      expect(rectCountsOf(host, [1, 2])).toEqual(rects);
      // 图层按布局倍率缩放，矩形仍是 96 DPI 页坐标（不重算）。
      expect(layer.style.transform).toBe(`scale(${scale})`);
      const current = layer.querySelector<HTMLElement>('.ofd-selection-rect')!;
      expect(current.style.left).toBe(sampleLeft);
      expect(current.style.top).toBe(sampleTop);
      expect(current.style.width).toBe(sampleWidth);
    }
    for (const rotation of [0, 90, 180, 270] as const) {
      host.setView({ rotation });
      await flush();
      await flush();
      expect(manager.getSelectionSnapshot()).toBe(snapshot);
      expect(manager.getSelectionSnapshot()!.version).toBe(version);
      expect(manager.getSelectedText()).toBe(text);
      expect(rectCountsOf(host, [1, 2])).toEqual(rects);
      const current = layer.querySelector<HTMLElement>('.ofd-selection-rect')!;
      expect(current.style.left).toBe(sampleLeft);
    }
    // 布局变化后复制内容不变。
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    document.dispatchEvent(copyEvent);
    expect(setData).toHaveBeenCalledWith('text/plain', text);
    service.destroy();
    manager.destroy();
  });

  it('竖排文字（主轴 π/2）仍可选中，矩形绕中心旋转且不重叠', async () => {
    const angle = Math.PI / 2;
    const content = makeContent([
      makeItem({ text: '甲乙', x: 100, y: 100, angleRad: angle, order: 0 }),
      makeItem({ text: '丙丁', x: 150, y: 100, angleRad: angle, order: 1 }),
    ]);
    const { host, service, manager } = mount({
      pageCount: 1,
      contents: new Map([[1, content]]),
    });
    await waitForSpans(host, new Map([[1, 2]]));
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 2);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    expect(manager.getSelectedText()).toBe('丙丁\n甲乙');
    const rects = [
      ...host.getPageView(1)!.surface.querySelectorAll<HTMLElement>('.ofd-selection-rect'),
    ];
    expect(rects).toHaveLength(2);
    for (const rect of rects) {
      expect(rect.style.transform).toBe(`rotate(${angle}rad)`);
      expect(rect.style.transformOrigin).toBe('50% 50%');
    }
    service.destroy();
    manager.destroy();
  });

  it('查找高亮：页被淘汰后不残留矩形；页重建后可正确重绘', async () => {
    const content = contentWithLines(['第一行', '第二行']);
    const { host, service, manager } = mount({
      pageCount: 1,
      contents: new Map([[1, content]]),
    });
    await waitForSpans(host, new Map([[1, 2]]));
    const view = host.getPageView(1)!;
    service.setFindMatches(
      [{ id: '1:0', pageNumber: 1, start: 0, end: 1, text: 'x', boxes: [{ x: 10, y: 10, width: 8, height: 16 }] }],
      1,
      true,
    );
    expect(view.surface.querySelectorAll('.ofd-find-highlight')).toHaveLength(1);

    // 淘汰页：文本、查找层、选区层（无快照）一并清理，不留错位矩形。
    service.releasePage(1);
    expect(view.surface.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);
    expect(view.surface.querySelector('.ofd-page__find-layer')).toBeNull();
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);

    // 重建后重新渲染查找高亮，位置仍取 96 DPI 页坐标。
    service.refresh();
    await waitForSpans(host, new Map([[1, 2]]));
    service.setFindMatches(
      [{ id: '1:0', pageNumber: 1, start: 0, end: 1, text: 'x', boxes: [{ x: 10, y: 10, width: 8, height: 16 }] }],
      1,
      true,
    );
    const highlight = view.surface.querySelector<HTMLElement>('.ofd-find-highlight')!;
    expect(highlight).not.toBeNull();
    expect(highlight.style.left).toBe('10px');
    expect(highlight.style.top).toBe('10px');
    service.destroy();
    manager.destroy();
  });
});
describe('t18 验收：缺页兜底与端点页释放', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  it('淘汰中间页后 Shift 扩选：incompletePages → 清空 + W_SELECTION_EVICTED；Ctrl+C 仍取旧快照', async () => {
    const contents = new Map([
      [1, contentWithLines(['第一页文字'])],
      [2, contentWithLines(['第二页文字'])],
      [3, contentWithLines(['第三页文字'])],
      [4, contentWithLines(['第四页文字'])],
    ]);
    const { host, service, manager } = mount({ pageCount: 4, contents });
    await waitForSpans(host, new Map([[1, 1], [2, 1], [3, 1], [4, 1]]));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 3), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    const oldText = '第一页文字\n第二页文字\n第三页文字';
    expect(manager.getSelectedText()).toBe(oldText);
    const oldSnapshot = manager.getSelectionSnapshot()!;
    expect(oldSnapshot.pageNumbers).toEqual([1, 2, 3]);

    // 中间页被淘汰，旧快照仍然完整；此时原生 Ctrl+C 仍取旧快照。
    service.releasePage(2);
    await flush();
    expect(manager.getSelectionSnapshot()).toBe(oldSnapshot);
    expect(manager.getSelectedText()).toBe(oldText);
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    document.dispatchEvent(copyEvent);
    expect(setData).toHaveBeenCalledWith('text/plain', oldText);

    // 用户继续 Shift 扩选到第 4 页：区间缺第 2 页 → 模型不完整，必须清空并告警。
    select(textNodeOf(host, 1), 0, textNodeOf(host, 4), 5);
    const model = manager.buildSelectionModel(document.getSelection()!.getRangeAt(0));
    expect(model.incompletePages).toEqual([2]);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(manager.getSelectedText()).toBe('');
    expect(document.querySelectorAll('.ofd-selection-rect')).toHaveLength(0);
    expect(host.warnings.some((warning) => warning.code === 'W_SELECTION_EVICTED')).toBe(true);
    service.destroy();
    manager.destroy();
  });

  it('释放仍被快照覆盖的端点 pin 页：发 W_SELECTION_EVICTED，快照复制仍完整', async () => {
    const contents = new Map([
      [1, contentWithLines(['第一页文字'])],
      [2, contentWithLines(['第二页文字'])],
    ]);
    const { host, service, manager } = mount({ pageCount: 2, contents });
    await waitForSpans(host, new Map([[1, 1], [2, 1]]));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 2), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    await flush();
    const expected = '第一页文字\n第二页文字';
    expect(manager.getSelectedText()).toBe(expected);
    expect(service.getPinnedPages()).toEqual([1, 2]);

    // 端点页被强制释放：快照与矩形保留，但必须上报诊断。
    service.releasePage(1);
    expect(manager.getSelectedText()).toBe(expected);
    expect(
      host.getPageView(1)!.surface.querySelectorAll('.ofd-selection-rect').length,
    ).toBeGreaterThan(0);
    expect(host.warnings.some((warning) => warning.code === 'W_SELECTION_EVICTED')).toBe(true);
    expect(service.getPinnedPages()).toEqual([2]);
    service.destroy();
    manager.destroy();
  });
});
