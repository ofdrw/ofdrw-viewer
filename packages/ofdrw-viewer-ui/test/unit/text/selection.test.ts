import { replaceChildren } from '../../../src/compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import { TextLayerService, createTextSpan } from '../../../src/text/text-layer';
import { buildTextLayerSpecs, buildTextRows } from '../../../src/text/geometry';
import type { SelectionModel } from '../../../src/text/selection';
import { SelectionManager } from '../../../src/text/selection';
import { OFDViewer } from '../../../src/viewer';
import { createViewerBridge } from '../../../src/text/viewer-bridge';
import {
  contentWithLines,
  makeContent,
  makeFakeHost,
  makeItem,
  makePageView,
  makeTextLayerQuery,
} from './helpers';

/** 把文本内容渲染为页文本层 span。 */
function renderPage(
  host: ReturnType<typeof makeFakeHost>,
  pageNumber: number,
  content: TextContent,
  legacy = true,
): void {
  const view = host.getPageView(pageNumber)!;
  const specs = buildTextLayerSpecs(content);
  const fragment = document.createDocumentFragment();
  for (const spec of specs.spans) {
    fragment.appendChild(createTextSpan(document, spec, pageNumber, true, legacy));
  }
  replaceChildren(view.textLayer, fragment);
}

/** 建立选区。 */
function select(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): void {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  selection.addRange(range);
}

/** 构建带根节点与两页文本层的宿主。 */
function setup(): {
  host: ReturnType<typeof makeFakeHost>;
  root: HTMLElement;
} {
  const views = new Map([
    [1, makePageView(1)],
    [2, makePageView(2)],
  ]);
  const root = document.createElement('div');
  document.body.appendChild(root);
  for (const view of views.values()) root.appendChild(view.element);
  const host = makeFakeHost({
    pageCount: 2,
    visiblePageRange: { start: 0, end: 1 },
    contents: new Map([
      [1, contentWithLines(['Hello', 'World'])],
      [2, contentWithLines(['第二页'])],
    ]),
    pageViews: views,
    root,
  });
  return { host, root };
}

/** 读取页内第 index 个 span 的文本节点。 */
function textNodeOf(host: ReturnType<typeof makeFakeHost>, page: number, index = 0): Text {
  const span = host.getPageView(page)!.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item')[
    index
  ]!;
  return span.firstChild as Text;
}

describe('SelectionManager 选区与复制', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  it('同一行英文选区补空格，中文不插空格', () => {
    const { host } = setup();
    renderPage(
      host,
      1,
      makeContent([
        makeItem({ text: 'Hello', x: 10, y: 100, size: 16, order: 0 }),
        makeItem({ text: 'World', x: 70, y: 100, size: 16, order: 1 }),
      ]),
    );
    const manager = new SelectionManager(host, createViewerBridge(host));
    const first = textNodeOf(host, 1, 0);
    const second = textNodeOf(host, 1, 1);
    select(first, 2, second, 3);
    expect(manager.getSelectedText()).toBe('llo Wor');

    renderPage(
      host,
      2,
      makeContent([
        makeItem({ text: '第二', x: 10, y: 100, size: 16, order: 0 }),
        makeItem({ text: '页', x: 50, y: 100, size: 16, order: 1 }),
      ]),
    );
    const cjkFirst = textNodeOf(host, 2, 0);
    const cjkSecond = textNodeOf(host, 2, 1);
    select(cjkFirst, 0, cjkSecond, 1);
    expect(manager.getSelectedText()).toBe('第二页');
    manager.destroy();
  });

  it('Range 端点为元素容器时抽取结果与文本节点端点一致（O5）', () => {
    const { host } = setup();
    renderPage(
      host,
      1,
      makeContent([
        makeItem({ text: 'Hello', x: 10, y: 100, size: 16, order: 0 }),
        makeItem({ text: 'World', x: 70, y: 100, size: 16, order: 1 }),
      ]),
    );
    const manager = new SelectionManager(host, createViewerBridge(host));
    const spans = host
      .getPageView(1)!
      .textLayer.querySelectorAll<HTMLElement>('.ofd-text-item');
    const textRange = document.createRange();
    textRange.setStart(textNodeOf(host, 1, 0), 0);
    textRange.setEnd(textNodeOf(host, 1, 1), textNodeOf(host, 1, 1).data.length);
    // 端点落在 span 元素而非文本节点：offset 是子节点下标。
    const elementRange = document.createRange();
    elementRange.setStart(spans[0]!, 0);
    elementRange.setEnd(spans[1]!, 1);

    const textModel = manager.buildSelectionModel(textRange);
    const elementModel = manager.buildSelectionModel(elementRange);
    expect(elementModel.fragments.map((fragment) => fragment.text)).toEqual(
      textModel.fragments.map((fragment) => fragment.text),
    );
    expect(elementModel.fragments.map((fragment) => fragment.rowId)).toEqual(
      textModel.fragments.map((fragment) => fragment.rowId),
    );
    // 也通过 getSelectedText 的真实 Selection 路径验证一次。
    select(spans[0]!, 0, spans[1]!, 1);
    expect(manager.getSelectedText()).toBe('Hello World');
    manager.destroy();
  });

  it('跨行、跨页选择保留换行', () => {
    const { host } = setup();
    renderPage(
      host,
      1,
      makeContent([
        makeItem({ text: 'First', x: 10, y: 100, size: 16, order: 0 }),
        makeItem({ text: 'Second', x: 10, y: 140, size: 16, order: 1 }),
      ]),
    );
    const manager = new SelectionManager(host, createViewerBridge(host));
    const first = textNodeOf(host, 1, 0);
    const second = textNodeOf(host, 1, 1);
    select(first, 0, second, 6);
    expect(manager.getSelectedText()).toBe('First\nSecond');

    renderPage(host, 2, contentWithLines(['第二页']));
    const page1 = textNodeOf(host, 1, 0);
    const page2 = textNodeOf(host, 2, 0);
    select(page1, 0, page2, 3);
    expect(manager.getSelectedText()).toBe('First\nSecond\n第二页');
    manager.destroy();
  });

  it('竖排/旋转文本按方向分行，不插入换行', () => {
    const { host } = setup();
    renderPage(
      host,
      1,
      makeContent([
        makeItem({ text: '汉', x: 100, y: 100, size: 16, angleRad: Math.PI / 2, order: 0 }),
        makeItem({ text: '字', x: 100, y: 116, size: 16, angleRad: Math.PI / 2, order: 1 }),
      ]),
    );
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 1);
    expect(manager.getSelectedText()).toBe('汉字');
    manager.destroy();
  });

  it('vector 模型：fragments 携带 rowId/quad，复制按行拼接', () => {
    const { host } = setup();
    const content = makeContent([
      makeItem({ text: '甲乙', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: '丙丁', x: 10, y: 130, size: 16, order: 1 }),
    ]);
    renderPage(host, 1, content);
    const manager = new SelectionManager(
      host,
      createViewerBridge(host),
      makeTextLayerQuery(new Map([[1, content]])),
    );
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 2);
    const range = document.getSelection()!.getRangeAt(0);
    const model = manager.buildSelectionModel(range);
    expect(model.mode).toBe('vector');
    // 逐字符片段：甲乙丙丁，跨两行。
    expect(model.fragments.map((fragment) => fragment.text).join('')).toBe('甲乙丙丁');
    expect(new Set(model.fragments.map((fragment) => fragment.rowId)).size).toBe(2);
    expect(model.fragments.every((fragment) => fragment.quad !== null)).toBe(true);
    expect(model.fragments.every((fragment) => fragment.axisRowRad === 0)).toBe(true);
    expect(manager.getSelectedText()).toBe('甲乙\n丙丁');
    manager.destroy();
  });

  it('fragments 按视觉阅读顺序排序，而不是 DOM 顺序', () => {
    const { host } = setup();
    // DOM 顺序（items 数组顺序）与视觉顺序相反：先渲染第二行、再渲染第一行。
    const content = makeContent([
      makeItem({ text: '第二行', x: 10, y: 130, size: 16, order: 0 }),
      makeItem({ text: '第一行', x: 10, y: 100, size: 16, order: 1 }),
    ]);
    renderPage(host, 1, content);
    const manager = new SelectionManager(
      host,
      createViewerBridge(host),
      makeTextLayerQuery(new Map([[1, content]])),
    );
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 3);
    const range = document.getSelection()!.getRangeAt(0);
    const model = manager.buildSelectionModel(range);
    const layout = buildTextRows(content);
    // 排序后首行是视觉上方那行（DOM 中位于后面）。
    expect(model.fragments[0]!.rowId).toBe(layout.rows[0]!.id);
    expect(model.fragments.map((fragment) => fragment.text).join('')).toBe('第一行第二行');
    expect(manager.getSelectedText()).toBe('第一行\n第二行');

    // 对照：旧逻辑按 DOM 顺序拼接，得到相反的行序（说明排序确实生效）。
    const legacy = new SelectionManager(host, createViewerBridge(host));
    expect(legacy.getSelectedText()).toBe('第二行\n第一行');
    legacy.destroy();
    manager.destroy();
  });

  it('vector 模型：同一行跨 span 的拉丁字符补空格', () => {
    const { host } = setup();
    const content = makeContent([
      makeItem({ text: 'Hello', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: 'World', x: 70, y: 100, size: 16, order: 1 }),
    ]);
    renderPage(host, 1, content);
    const manager = new SelectionManager(
      host,
      createViewerBridge(host),
      makeTextLayerQuery(new Map([[1, content]])),
    );
    select(textNodeOf(host, 1, 0), 2, textNodeOf(host, 1, 1), 3);
    expect(manager.getSelectedText()).toBe('llo Wor');
    manager.destroy();
  });

  it('缺少文本层服务时 SelectionModel 回退 legacy，旧逻辑仍可用', () => {
    const { host } = setup();
    renderPage(host, 1, contentWithLines(['Hello']));
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    const model = manager.buildSelectionModel(document.getSelection()!.getRangeAt(0));
    expect(model).toEqual({ fragments: [], mode: 'legacy' });
    expect(manager.getSelectedText()).toBe('Hello');
    manager.destroy();
  });

  it('页文本内容未就绪时 SelectionModel 回退 legacy', () => {
    const { host } = setup();
    renderPage(host, 1, contentWithLines(['Hello']));
    const manager = new SelectionManager(
      host,
      createViewerBridge(host),
      makeTextLayerQuery(new Map<number, TextContent>()),
    );
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    const model = manager.buildSelectionModel(document.getSelection()!.getRangeAt(0));
    expect(model.mode).toBe('legacy');
    expect(manager.getSelectedText()).toBe('Hello');
    manager.destroy();
  });

  it('引擎未返回 chars 时 SelectionModel 回退 legacy', () => {
    const { host } = setup();
    const item = makeItem({ text: 'Hello', x: 10, y: 100, size: 16, order: 0 });
    const content = makeContent([{ ...item, chars: undefined }]);
    renderPage(host, 1, content);
    const manager = new SelectionManager(
      host,
      createViewerBridge(host),
      makeTextLayerQuery(new Map([[1, content]])),
    );
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    const model = manager.buildSelectionModel(document.getSelection()!.getRangeAt(0));
    expect(model.mode).toBe('legacy');
    expect(manager.getSelectedText()).toBe('Hello');
    manager.destroy();
  });

  it('生产构建省略 legacy dataset 且缺少 comparePoint/intersectsNode 时仍按内联样式换行', () => {
    const { host } = setup();
    renderPage(
      host,
      1,
      contentWithLines(['First', 'Second']),
      false,
    );
    const spans = host
      .getPageView(1)!
      .textLayer.querySelectorAll<HTMLElement>('.ofd-text-item');
    expect(spans[0]!.dataset.x).toBeUndefined();
    expect(spans[0]!.dataset.y).toBeUndefined();
    const originalComparePoint = Range.prototype.comparePoint;
    const originalIntersectsNode = Range.prototype.intersectsNode;
    Object.defineProperty(Range.prototype, 'comparePoint', { configurable: true, value: undefined });
    Object.defineProperty(Range.prototype, 'intersectsNode', { configurable: true, value: undefined });
    try {
      const manager = new SelectionManager(host, createViewerBridge(host));
      select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 6);
      expect(manager.getSelectedText()).toBe('First\nSecond');
      manager.destroy();
    } finally {
      Object.defineProperty(Range.prototype, 'comparePoint', {
        configurable: true,
        value: originalComparePoint,
      });
      Object.defineProperty(Range.prototype, 'intersectsNode', {
        configurable: true,
        value: originalIntersectsNode,
      });
    }
  });

  it('焦点在阅读器内查找框时输入字符不清空快照与原生选区', async () => {
    const { host, root } = setup();
    const content = contentWithLines(['Hello']);
    renderPage(host, 1, content);
    const input = document.createElement('input');
    root.appendChild(input);
    const manager = new SelectionManager(
      host,
      createViewerBridge(host),
      makeTextLayerQuery(new Map([[1, content]])),
    );
    // 先在查找框取得焦点，再建立正文学区；避免聚焦本身折叠原生 Selection 干扰断言。
    input.focus();
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = manager.getSelectionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(manager.getSelectedText()).toBe('Hello');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(document.getSelection()?.rangeCount).toBe(1);
    expect(manager.getSelectionSnapshot()).toBe(snapshot);
    expect(manager.getSelectedText()).toBe('Hello');
    manager.destroy();
  });

  it('输入框内 copy 不被旧快照拦截：不 setData、不 preventDefault、快照保留', async () => {
    const { host, root } = setup();
    const content = contentWithLines(['Hello']);
    renderPage(host, 1, content);
    const input = document.createElement('input');
    root.appendChild(input);
    const manager = new SelectionManager(
      host,
      createViewerBridge(host),
      makeTextLayerQuery(new Map([[1, content]])),
    );
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = manager.getSelectionSnapshot();
    expect(snapshot).not.toBeNull();
    // 快照存在但原生选区已折叠/清空：此时输入框的 copy 必须走浏览器默认行为。
    document.getSelection()?.removeAllRanges();
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    input.dispatchEvent(copyEvent);
    expect(setData).not.toHaveBeenCalled();
    expect(copyEvent.defaultPrevented).toBe(false);
    expect(manager.getSelectionSnapshot()).toBe(snapshot);
    manager.destroy();
  });

  it('copySelection 优先使用异步剪贴板', async () => {
    const { host } = setup();
    renderPage(host, 1, contentWithLines(['Hello']));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    await manager.copySelection();
    expect(writeText).toHaveBeenCalledWith('Hello');
    manager.destroy();
  });

  it('剪贴板不可用时回退 execCommand', async () => {
    const { host } = setup();
    renderPage(host, 1, contentWithLines(['Hello']));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    await manager.copySelection();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    manager.destroy();
  });

  it('复制完全失败时抛 OFD_CLIPBOARD_FAILED', async () => {
    const { host } = setup();
    renderPage(host, 1, contentWithLines(['Hello']));
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    await expect(manager.copySelection()).rejects.toMatchObject({
      code: 'OFD_CLIPBOARD_FAILED',
    });
    manager.destroy();
  });

  it('clearSelection 清空原生选区并发布空文本', () => {
    const { host } = setup();
    renderPage(host, 1, contentWithLines(['Hello']));
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    manager.clearSelection();
    expect(document.getSelection()!.rangeCount).toBe(0);
    expect(host.state.view.selectedText).toBe('');
    manager.destroy();
  });

  it('selectionchange 发布选区文本', async () => {
    const { host } = setup();
    renderPage(host, 1, contentWithLines(['Hello']));
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(textNodeOf(host, 1), 0, textNodeOf(host, 1), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.state.view.selectedText).toBe('Hello');
    const event = host.events.find((item) => item.name === 'selectionchange');
    expect(event?.payload).toEqual({ text: 'Hello', isEmpty: false });
    manager.destroy();
  });

  it('阅读器之外的选区不发布', async () => {
    const { host } = setup();
    const outside = document.createElement('p');
    outside.textContent = '外部文本';
    document.body.appendChild(outside);
    const manager = new SelectionManager(host, createViewerBridge(host));
    select(outside.firstChild!, 0, outside.firstChild!, 2);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events.some((item) => item.name === 'selectionchange')).toBe(false);
    expect(manager.getSelectedText()).toBe('');
    manager.destroy();
  });

  it('features.selection=false / textLayer=false 抛 OFD_FEATURE_DISABLED', async () => {
    const { host } = setup();
    host.setFeatures({ selection: false });
    const manager = new SelectionManager(host, createViewerBridge(host));
    let selectionError: unknown;
    try {
      manager.getSelectedText();
    } catch (error) {
      selectionError = error;
    }
    expect(selectionError).toMatchObject({ code: 'OFD_FEATURE_DISABLED', feature: 'selection' });

    host.setFeatures({ selection: true, textLayer: false });
    let textLayerError: unknown;
    try {
      manager.getSelectedText();
    } catch (error) {
      textLayerError = error;
    }
    expect(textLayerError).toMatchObject({ code: 'OFD_FEATURE_DISABLED' });
    await expect(manager.copySelection()).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
    });
    manager.destroy();
  });
});
describe('页级构建后选区稳定性', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('端点页 span 超 pin 预算时清空选区并告警，不返回部分文本', async () => {
    const views = new Map([
      [1, makePageView(1)],
      [2, makePageView(2)],
    ]);
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (const view of views.values()) root.appendChild(view.element);
    const host = makeFakeHost({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 1 },
      contents: new Map([
        [1, contentWithLines(['第一页'])],
        [2, contentWithLines(['第二页'])],
      ]),
      pageViews: views,
      root,
    });
    const textLayer = new TextLayerService(host, createViewerBridge(host), {
      settleMs: 0,
      selectionPinSpanBudget: 0,
    });
    const manager = new SelectionManager(host, createViewerBridge(host), textLayer);
    await vi.waitFor(() => {
      expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(1);
    });
    const first = textNodeOf(host, 1, 0);
    const second = textNodeOf(host, 2, 0);
    select(first, 0, second, second.data.length);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getSelectedText()).toBe('');
    expect(document.getSelection()?.rangeCount).toBe(0);
    expect(host.warnings.some((warning) => warning.code === 'W_SELECTION_UNPINNABLE')).toBe(true);
    manager.destroy();
    textLayer.destroy();
  });

  it('dense 页选中后滚动，getSelectedText 不变且 span 不被移除', async () => {
    const content = contentWithLines(
      Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行 hello`),
      { lineHeight: 20 },
    );
    const view = makePageView(1);
    const root = document.createElement('div');
    document.body.appendChild(root);
    root.appendChild(view.element);
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, content]]),
      pageViews: new Map([[1, view]]),
      root,
    });
    const textLayer = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    const manager = new SelectionManager(host, createViewerBridge(host), textLayer);
    await vi.waitFor(() => {
      expect(view.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(60);
    });
    const spans = view.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item');
    const start = spans[0]!.firstChild as Text;
    const end = spans[3]!.firstChild as Text;
    select(start, 0, end, end.data.length);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = manager.getSelectionSnapshot();
    expect([...new Set(snapshot?.fragments.map((fragment) => fragment.pageNumber))]).toEqual([1]);
    expect(snapshot?.fragments.every((fragment) => Number.isInteger(fragment.itemIndex))).toBe(true);
    expect(snapshot?.fragments.every((fragment) => Number.isInteger(fragment.charIndex))).toBe(true);
    const before = manager.getSelectedText();
    expect(before).toContain('第 1 行');
    host.setView({ scrollTop: 500 });
    await new Promise<void>((resolve) => setTimeout(resolve, 170));
    expect(manager.getSelectedText()).toBe(before);
    expect(view.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(60);
    expect(document.getSelection()?.isCollapsed).toBe(false);
    manager.destroy();
    textLayer.destroy();
  });
});

describe('SelectionManager 驱动块状高亮', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });

  /** 构建已渲染文本层 + 记录 renderSelection 调用的宿主。 */
  function setupRendered() {
    const contents = new Map([
      [1, contentWithLines(['Hello', 'World'])],
      [2, contentWithLines(['第二页'])],
    ]);
    const views = new Map([
      [1, makePageView(1)],
      [2, makePageView(2)],
    ]);
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (const view of views.values()) root.appendChild(view.element);
    const host = makeFakeHost({
      pageCount: 2,
      visiblePageRange: { start: 0, end: 1 },
      contents,
      pageViews: views,
      root,
    });
    renderPage(host, 1, contents.get(1)!);
    renderPage(host, 2, contents.get(2)!);
    const models: SelectionModel[] = [];
    const service = {
      ...makeTextLayerQuery(contents),
      renderSelection(model: SelectionModel): void {
        models.push(model);
      },
    };
    const manager = new SelectionManager(host, createViewerBridge(host), service);
    return { host, manager, models };
  }

  it('selectionchange 构建选区模型并重绘，清空选区时清空高亮', async () => {
    const { host, manager, models } = setupRendered();
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(models.length).toBeGreaterThan(0);
    const model = models[models.length - 1]!;
    expect(model.mode).toBe('vector');
    expect(model.fragments.length).toBeGreaterThan(0);
    expect(model.fragments.every((fragment) => fragment.quad !== null)).toBe(true);
    expect(model.fragments.every((fragment) => fragment.rowId !== null)).toBe(true);

    manager.clearSelection();
    expect(models[models.length - 1]).toEqual({ fragments: [], mode: 'vector' });
    manager.destroy();
  });

  it('折叠选区保留快照，选区移出阅读器才清空高亮', async () => {
    const { host, manager, models } = setupRendered();
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(models[models.length - 1]!.fragments.length).toBeGreaterThan(0);

    // 折叠到起点：可能由淘汰页/浏览器归一化引起，不得清空快照与高亮。
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 0), 0);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getSelectionSnapshot()).not.toBeNull();
    expect(models[models.length - 1]!.fragments.length).toBeGreaterThan(0);

    // 选区落在阅读器外：属于用户新选择，才清空旧快照。
    const outside = document.createElement('div');
    outside.textContent = '外部文本';
    document.body.appendChild(outside);
    select(outside.firstChild as Text, 0, outside.firstChild as Text, 2);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(models[models.length - 1]!.fragments).toHaveLength(0);
    manager.destroy();
  });

  it('缩放/旋转/功能开关变化后按当前选区重建并重绘', async () => {
    const { host, manager, models } = setupRendered();
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 1), 3);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    const before = models.length;

    host.setView({ scale: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(models.length).toBeGreaterThan(before);
    expect(models[models.length - 1]!.mode).toBe('vector');
    expect(models[models.length - 1]!.fragments.length).toBeGreaterThan(0);

    host.setView({ rotation: 90 });
    await Promise.resolve();
    await Promise.resolve();
    expect(models[models.length - 1]!.fragments.length).toBeGreaterThan(0);

    host.setFeatures({ selection: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(models[models.length - 1]!.fragments).toHaveLength(0);
    expect(manager.getSelectionSnapshot()).toBeNull();
    manager.destroy();
  });

  it('文本层几何不可用时提交 legacy 模型供原生高亮兜底', async () => {
    const contents = new Map([[1, contentWithLines(['Hello'])]]);
    const view = makePageView(1);
    const root = document.createElement('div');
    document.body.appendChild(root);
    root.appendChild(view.element);
    const host = makeFakeHost({
      pageCount: 1,
      contents,
      pageViews: new Map([[1, view]]),
      root,
    });
    renderPage(host, 1, contents.get(1)!);
    const models: SelectionModel[] = [];
    const service = {
      ...makeTextLayerQuery(contents),
      getAxisRowRad: () => null,
      renderSelection(model: SelectionModel): void {
        models.push(model);
      },
    };
    const manager = new SelectionManager(host, createViewerBridge(host), service);
    const node = textNodeOf(host, 1, 0);
    select(node, 0, node, 5);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(models[models.length - 1]!.mode).toBe('legacy');
    expect(models[models.length - 1]!.fragments).toHaveLength(0);
    manager.destroy();
  });
});

describe('SelectionSnapshot 复制与高亮不依赖 DOM 存活性（t14）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  /** 等待 selectionchange 的微任务队列。 */
  async function flushSelection(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  /** 构建 3 页、已建文本层与快照的宿主。 */
  async function setupSnapshot() {
    const contents = new Map([
      [1, contentWithLines(['第一页文字'])],
      [2, contentWithLines(['中间页文字'])],
      [3, contentWithLines(['第三页文字'])],
    ]);
    const views = new Map([
      [1, makePageView(1)],
      [2, makePageView(2)],
      [3, makePageView(3)],
    ]);
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (const view of views.values()) root.appendChild(view.element);
    const host = makeFakeHost({
      pageCount: 3,
      visiblePageRange: { start: 0, end: 2 },
      contents,
      pageViews: views,
      root,
    });
    let manager: SelectionManager | null = null;
    const textLayer = new TextLayerService(host, createViewerBridge(host), {
      settleMs: 0,
      onDomMutation: () => manager?.suppressSelectionChangeForDomMutation(),
    });
    manager = new SelectionManager(host, createViewerBridge(host), textLayer);
    await vi.waitFor(() => {
      for (const pageNumber of [1, 2, 3]) {
        expect(
          host.getPageView(pageNumber)!.textLayer.querySelectorAll('.ofd-text-item'),
        ).toHaveLength(1);
      }
    });
    return { host, manager, textLayer, views };
  }

  it('快照完整保存 fragments、每页矩形、端点与版本，并直接驱动高亮', async () => {
    const { host, manager, textLayer } = await setupSnapshot();
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 3, 0), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    const snapshot = manager.getSelectionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.text).toBe('第一页文字\n中间页文字\n第三页文字');
    expect(snapshot!.pageNumbers).toEqual([1, 2, 3]);
    expect(snapshot!.startPage).toBe(1);
    expect(snapshot!.endPage).toBe(3);
    expect(snapshot!.version).toBeGreaterThan(0);
    expect(snapshot!.fragments.length).toBeGreaterThan(3);
    expect(
      snapshot!.fragments.every(
        (fragment) =>
          Number.isInteger(fragment.pageNumber) &&
          Number.isInteger(fragment.itemIndex) &&
          Number.isInteger(fragment.charIndex) &&
          fragment.quad !== null &&
          fragment.rowId !== null,
      ),
    ).toBe(true);
    for (const pageNumber of [1, 2, 3]) {
      expect(snapshot!.rectsByPage.get(pageNumber)!.length).toBeGreaterThan(0);
      expect(snapshot!.axisByPage.has(pageNumber)).toBe(true);
      expect(
        host.getPageView(pageNumber)!.surface.querySelectorAll('.ofd-selection-rect'),
      ).toHaveLength(1);
    }
    // 新的非折叠选区替换旧快照（快照版本递增）。
    const replaced = textNodeOf(host, 1, 0);
    select(replaced, 0, replaced, 2);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    const next = manager.getSelectionSnapshot();
    expect(next).not.toBe(snapshot);
    expect(next!.text).toBe('第一');
    expect(next!.version).toBeGreaterThan(snapshot!.version);

    // 文档切换/关闭是显式生命周期事件，必须清空快照与高亮。
    host.emit('documentclose', {});
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(document.querySelectorAll('.ofd-selection-rect')).toHaveLength(0);
    manager.destroy();
    textLayer.destroy();
  });

  it('淘汰中间页/端点页后复制、快照与选区矩形仍完整；copy 事件读取快照', async () => {
    const { host, manager, textLayer } = await setupSnapshot();
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 3, 0), 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    const snapshot = manager.getSelectionSnapshot()!;
    const expected = snapshot.text;
    const rectCountsBefore = [1, 2, 3].map(
      (pageNumber) =>
        host.getPageView(pageNumber)!.surface.querySelectorAll('.ofd-selection-rect').length,
    );

    // 模拟 LRU 淘汰中间页：文本层清空，但快照覆盖该页，选区层保留。
    textLayer.releasePage(2);
    expect(host.getPageView(2)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    // 即使该页无 state/domBuilt，快照的预合并矩形仍能直接绘制。
    textLayer.renderSelection(snapshot);
    expect(
      [1, 2, 3].map(
        (pageNumber) =>
          host.getPageView(pageNumber)!.surface.querySelectorAll('.ofd-selection-rect').length,
      ),
    ).toEqual(rectCountsBefore);
    // 抑制窗口内到达的 selectionchange 不重算；窗口结束后锚点未变也不重算。
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    expect(manager.getSelectionSnapshot()).toBe(snapshot);
    expect(manager.getSelectedText()).toBe(expected);

    // 端点页也被淘汰：复制与高亮仍完整，仅原生 Shift 扩选可能不可用。
    textLayer.releasePage(3);
    expect(manager.getSelectedText()).toBe(expected);
    expect(
      host.getPageView(3)!.surface.querySelectorAll('.ofd-selection-rect'),
    ).toHaveLength(1);
    // 端点页被淘汰后 pin 只保留仍存活的端点；快照文本不受影响。
    expect(textLayer.getPinnedPages()).toEqual([1]);
    // 端点页淘汰后浏览器可能派发 selectionchange/改锚；快照必须保持。
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    expect(manager.getSelectionSnapshot()).toBe(snapshot);
    expect(manager.getSelectedText()).toBe(expected);

    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    document.dispatchEvent(copyEvent);
    expect(setData).toHaveBeenCalledWith('text/plain', expected);
    expect(copyEvent.defaultPrevented).toBe(true);

    // 折叠原生选区（淘汰后内核可能如此）仍可复制完整快照。
    const startNode = textNodeOf(host, 1, 0);
    select(startNode, 0, startNode, 0);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    const collapsedCopy = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const collapsedData = vi.fn();
    Object.defineProperty(collapsedCopy, 'clipboardData', { value: { setData: collapsedData } });
    document.dispatchEvent(collapsedCopy);
    expect(collapsedData).toHaveBeenCalledWith('text/plain', expected);
    expect(manager.getSelectedText()).toBe(expected);

    // copySelection 也必须从快照取文本，而不是依赖已折叠的原生 Selection。
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await manager.copySelection();
    expect(writeText).toHaveBeenCalledWith(expected);

    // 用户点击文字层外：显式意图清空快照与高亮。
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(document.querySelectorAll('.ofd-selection-rect')).toHaveLength(0);
    manager.destroy();
    textLayer.destroy();
  });

  it('缩放 1→1.5→2 与旋转 0→90→180→270 后快照同一引用、高亮不丢', async () => {
    const contents = new Map([[1, contentWithLines(['第一行', '第二行'])]]);
    const view = makePageView(1);
    const root = document.createElement('div');
    document.body.appendChild(root);
    root.appendChild(view.element);
    const host = makeFakeHost({
      pageCount: 1,
      contents,
      pageViews: new Map([[1, view]]),
      root,
    });
    const textLayer = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    const manager = new SelectionManager(host, createViewerBridge(host), textLayer);
    await vi.waitFor(() => {
      expect(view.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(2);
    });
    const first = textNodeOf(host, 1, 0);
    const second = textNodeOf(host, 1, 1);
    select(first, 0, second, second.data.length);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    const snapshot = manager.getSelectionSnapshot()!;
    const text = snapshot.text;
    const version = snapshot.version;
    const rects = view.surface.querySelectorAll('.ofd-selection-rect').length;
    expect(rects).toBeGreaterThan(0);

    // 回归基线：放大与 180/270 曾经会因行重建丢选区；本实现不移除 span、不清快照。
    for (const scale of [1.5, 2]) {
      host.setView({ scale });
      await flushSelection();
      expect(manager.getSelectionSnapshot()).toBe(snapshot);
      expect(manager.getSelectedText()).toBe(text);
      expect(view.surface.querySelectorAll('.ofd-selection-rect')).toHaveLength(rects);
    }
    for (const rotation of [0, 90, 180, 270] as const) {
      host.setView({ rotation });
      await flushSelection();
      expect(manager.getSelectionSnapshot()).toBe(snapshot);
      expect(manager.getSelectedText()).toBe(text);
      expect(view.surface.querySelectorAll('.ofd-selection-rect')).toHaveLength(rects);
      expect(manager.getSelectionSnapshot()!.version).toBe(version);
    }
    manager.destroy();
    textLayer.destroy();
  });

  it('滚动不重建快照；快照内存远小于 DOM 且不随滚动增长', async () => {
    const content = contentWithLines(
      Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行 hello`),
      { lineHeight: 20 },
    );
    const host = makeFakeHost({ pageCount: 1, contents: new Map([[1, content]]) });
    const textLayer = new TextLayerService(host, createViewerBridge(host), { settleMs: 0 });
    const manager = new SelectionManager(host, createViewerBridge(host), textLayer);
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(60);
    });
    const spans = host.getPageView(1)!.textLayer.querySelectorAll<HTMLElement>('.ofd-text-item');
    select(spans[0]!.firstChild as Text, 0, spans[4]!.firstChild as Text, 5);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    const snapshot = manager.getSelectionSnapshot()!;
    const fragmentCount = snapshot.fragments.length;
    const boxCount = [...snapshot.rectsByPage.values()].reduce(
      (total, boxes) => total + boxes.length,
      0,
    );
    const estimatedBytes =
      snapshot.text.length * 2 + fragmentCount * 160 + boxCount * 40;
    // 远小于 dense 页 DOM 的 8.3 MB；实际选区片段/矩形数量在滚动中保持不变。
    expect(estimatedBytes).toBeLessThan(1_000_000);
    for (const scrollTop of [100, 300, 500]) {
      host.setView({ scrollTop });
      await flushSelection();
      expect(manager.getSelectionSnapshot()).toBe(snapshot);
      expect(snapshot.fragments).toHaveLength(fragmentCount);
      expect(
        [...snapshot.rectsByPage.values()].reduce((total, boxes) => total + boxes.length, 0),
      ).toBe(boxCount);
    }
    manager.destroy();
    textLayer.destroy();
  });

  it('抑制窗口内 Escape/点击仍立即清空；阅读器外复制不被拦截', async () => {
    const { host, manager, textLayer } = await setupSnapshot();
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 0), 2);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    const snapshot = manager.getSelectionSnapshot()!;

    // 抑制中仍必须尊重显式取消，不能吞掉用户真实意图。
    manager.suppressSelectionChangeForDomMutation();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(document.querySelectorAll('.ofd-selection-rect')).toHaveLength(0);

    // 重建选区后，在阅读器外复制不应被快照拦截。
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 0), 2);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    expect(manager.getSelectionSnapshot()).not.toBeNull();
    const outside = document.createElement('p');
    outside.textContent = '外部文本';
    document.body.appendChild(outside);
    select(outside.firstChild as Text, 0, outside.firstChild as Text, 2);
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData } });
    document.dispatchEvent(copyEvent);
    expect(setData).not.toHaveBeenCalled();
    expect(copyEvent.defaultPrevented).toBe(false);
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    // 输入框内点击是例外：保留快照，不打断输入框自身的光标/选区。
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    // 普通左键点击外部才取消；pointerup 后原生空 Range 也被清掉。
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(manager.getSelectionSnapshot()).toBeNull();
    expect(document.getSelection()?.rangeCount ?? 0).toBe(0);
    manager.destroy();
    textLayer.destroy();
  });

  it('单击后浏览器补建的折叠 Range 在 pointerup 时清掉（t17）', async () => {
    const { host, manager, textLayer } = await setupSnapshot();
    const node = textNodeOf(host, 1, 0);
    select(node, 0, node, 2);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(manager.getSelectionSnapshot()).toBeNull();
    // 模拟浏览器默认动作：清空后又在点击位置补建一个折叠 Range。
    const range = document.createRange();
    range.setStart(node, 1);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.rangeCount).toBe(1);
    document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(selection.rangeCount).toBe(0);

    manager.destroy();
    textLayer.destroy();
  });

  it('Shift/右键/滚动条/输入框点击保留快照（t17 例外）', async () => {
    const { host, manager, textLayer } = await setupSnapshot();
    select(textNodeOf(host, 1, 0), 0, textNodeOf(host, 1, 0), 2);
    document.dispatchEvent(new Event('selectionchange'));
    await flushSelection();
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    const shift = new MouseEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true });
    textNodeOf(host, 1, 0).dispatchEvent(shift);
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    const right = new MouseEvent('pointerdown', { bubbles: true, button: 2 });
    textNodeOf(host, 1, 0).dispatchEvent(right);
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    const scroll = document.createElement('div');
    document.body.appendChild(scroll);
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 200 });
    scroll.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    scroll.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 10 }),
    );
    expect(manager.getSelectionSnapshot()).not.toBeNull();

    manager.destroy();
    textLayer.destroy();
  });
});



describe('桌面双击（t17）', () => {
  it('handleTap 只处理触摸指针，鼠标 pointerType 不再进入双击判定', () => {
    const toggle = vi.fn();
    const clear = vi.fn();
    const fake = {
      featureGate: { isEnabled: () => true },
      lastTap: null,
      touchPoints: new Map<number, { x: number; y: number }>(),
      toggleZoomAt: toggle,
      clearTextSelection: clear,
    };
    const handleTap = (
      OFDViewer.prototype as unknown as {
        handleTap(this: typeof fake, event: PointerEvent): void;
      }
    ).handleTap;
    const pointer = (type: string): PointerEvent => {
      const event = new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }) as MouseEvent & { pointerType: string };
      Object.defineProperty(event, 'pointerType', { configurable: true, value: type });
      return event as PointerEvent;
    };

    handleTap.call(fake, pointer('mouse'));
    handleTap.call(fake, pointer('mouse'));
    expect(toggle).not.toHaveBeenCalled();

    // 触摸双击仍然生效：两次同位置触摸只触发一次切换。
    handleTap.call(fake, pointer('touch'));
    handleTap.call(fake, pointer('touch'));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
