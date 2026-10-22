import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import { createTextSpan } from '../../../src/text/text-layer';
import { buildTextLayerSpecs } from '../../../src/text/geometry';
import { SelectionManager } from '../../../src/text/selection';
import { createViewerBridge } from '../../../src/text/viewer-bridge';
import {
  contentWithLines,
  makeContent,
  makeFakeHost,
  makeItem,
  makePageView,
} from './helpers';

/** 把文本内容渲染为页文本层 span。 */
function renderPage(
  host: ReturnType<typeof makeFakeHost>,
  pageNumber: number,
  content: TextContent,
): void {
  const view = host.getPageView(pageNumber)!;
  const specs = buildTextLayerSpecs(content);
  const fragment = document.createDocumentFragment();
  for (const spec of specs.spans) {
    fragment.appendChild(createTextSpan(document, spec, pageNumber, true));
  }
  view.textLayer.replaceChildren(fragment);
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