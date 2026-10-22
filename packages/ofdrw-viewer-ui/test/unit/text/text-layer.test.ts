import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextLayerService } from '../../../src/text/text-layer';
import { createViewerBridge } from '../../../src/text/viewer-bridge';
import type { FindMatch } from '../../../src/text/types';
import type { TextProvider } from './helpers';
import { contentWithLines, makeFakeHost } from './helpers';

/** 等待 setTimeout 级异步任务。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 构造高亮命中。 */
function match(pageNumber: number, id: string, x: number): FindMatch {
  return {
    id,
    pageNumber,
    start: 0,
    end: 1,
    text: 'x',
    boxes: [{ x, y: 10, width: 8, height: 16 }],
  };
}

describe('透明文本层服务', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('只为可见页构建 span，并写入 96 DPI 几何', async () => {
    const contents = new Map([
      [2, contentWithLines(['第二页 Hello'])],
      [3, contentWithLines(['第三页 World'])],
    ]);
    const host = makeFakeHost({
      pageCount: 5,
      pageNumber: 2,
      visiblePageRange: { start: 1, end: 2 },
      contents,
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
    });
    await vi.waitFor(() => {
      expect(
        host.getPageView(3)!.textLayer.querySelectorAll('.ofd-text-item').length,
      ).toBeGreaterThan(0);
    });
    const layer = host.getPageView(2)!.textLayer;
    expect(layer.dataset.dpi).toBe('96');
    expect(layer.style.transform).toBe('scale(var(--scale-factor, 1))');
    expect(layer.style.width).toBe(`${(210 / 25.4) * 96}px`);
    const span = layer.querySelector<HTMLElement>('.ofd-text-item')!;
    expect(span.textContent).toBe('第二页 Hello');
    expect(span.style.color).toBe('transparent');
    expect(span.style.cursor).toBe('text');
    expect(span.style.transform).toMatch(/^matrix\(/);
    // 未可见页不加载。
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(host.textCalls).not.toContain(1);
    service.destroy();
  });

  it('缩放/旋转由页面容器承担，文本层坐标不重算', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    const layer = host.getPageView(1)!.textLayer;
    const before = layer.querySelector<HTMLElement>('.ofd-text-item')!.style.left;
    host.setView({ scale: 2 });
    host.setView({ rotation: 90 });
    await flush();
    expect(layer.style.transform).toBe('scale(var(--scale-factor, 1))');
    expect(layer.querySelector<HTMLElement>('.ofd-text-item')!.style.left).toBe(before);
    service.destroy();
  });

  it('features.selection=false 时关闭 user-select', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      features: { selection: false },
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    const layer = host.getPageView(1)!.textLayer;
    expect(layer.dataset.selectable).toBe('false');
    expect(layer.style.userSelect).toBe('none');
    expect(
      layer.querySelector<HTMLElement>('.ofd-text-item')!.style.userSelect,
    ).toBe('none');
    service.destroy();
  });

  it('features.textLayer=false 时清空并隐藏文本层', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    host.setFeatures({ textLayer: false });
    await flush();
    const layer = host.getPageView(1)!.textLayer;
    expect(layer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(layer.hidden).toBe(true);
    service.destroy();
  });

  it('文本提取失败只告警一次，离开可见区后允许重试', async () => {
    let attempts = 0;
    const provider = async () => {
      attempts += 1;
      throw new Error('boom');
    };
    const host = makeFakeHost({
      pageCount: 2,
      pageNumber: 1,
      visiblePageRange: { start: 0, end: 0 },
      contents: new Map<number, TextProvider>([
        [1, provider],
        [2, async () => contentWithLines(['第二页'])],
      ]),
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
    });
    await vi.waitFor(() => expect(attempts).toBe(1));
    host.setView({ scale: 2 });
    host.setView({ pageNumber: 2, visiblePageRange: { start: 1, end: 1 } });
    await flush();
    expect(attempts).toBe(1);
    expect(host.warnings.filter((warning) => warning.code === 'W_TEXT_LOAD')).toHaveLength(1);
    host.setView({ pageNumber: 1, visiblePageRange: { start: 0, end: 0 } });
    await vi.waitFor(() => expect(attempts).toBe(2));
    service.destroy();
  });

  it('不创建 canvas、不调用 Canvas 文字 API', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    expect(getContext).not.toHaveBeenCalled();
    expect(host.getPageView(1)!.surface.querySelectorAll('canvas')).toHaveLength(0);
    service.destroy();
  });

  it('可见页变化后旧页的迟到结果被代次丢弃', async () => {
    let resolveFirst: ((value: ReturnType<typeof contentWithLines>) => void) | null = null;
    const first = new Promise<ReturnType<typeof contentWithLines>>((resolve) => {
      resolveFirst = resolve;
    });
    const contents = new Map<number, ReturnType<typeof contentWithLines> | (() => Promise<ReturnType<typeof contentWithLines>>)>([
      [1, () => first],
      [2, contentWithLines(['第二页'])],
    ]);
    const host = makeFakeHost({
      pageCount: 2,
      pageNumber: 1,
      visiblePageRange: { start: 0, end: 0 },
      contents,
    });
    const service = new TextLayerService(host, createViewerBridge(host), {
      overscan: 0,
    });
    await vi.waitFor(() => expect(host.textCalls).toContain(1));
    host.setView({ pageNumber: 2, visiblePageRange: { start: 1, end: 1 } });
    await vi.waitFor(() => expect(host.textCalls).toContain(2));
    resolveFirst!(contentWithLines(['旧页迟到结果']));
    await flush();
    await flush();
    expect(
      host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item'),
    ).toHaveLength(0);
    service.destroy();
  });

  it('查找高亮独立覆盖层且不影响选区', async () => {
    const host = makeFakeHost({ pageCount: 2 });
    const service = new TextLayerService(host, createViewerBridge(host));
    service.setFindMatches(
      [match(1, '1:0', 10), match(1, '1:1', 30), match(2, '2:0', 5)],
      1,
      true,
    );
    const surface = host.getPageView(1)!.surface;
    const layer = surface.querySelector<HTMLElement>('.ofd-page__find-layer')!;
    expect(layer).not.toBeNull();
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.style.transform).toBe('scale(var(--scale-factor, 1))');
    const boxes = layer.querySelectorAll<HTMLElement>('.ofd-find-highlight');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.dataset.current).toBe('true');
    expect(boxes[0]!.style.left).toBe('10px');
    expect(host.getPageViews()[0]!.textLayer.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);

    service.setFindMatches([match(1, '1:0', 10), match(1, '1:1', 30)], 2, false);
    expect(layer.querySelectorAll('.ofd-find-highlight')).toHaveLength(1);
    expect(layer.querySelector<HTMLElement>('.ofd-find-highlight')!.dataset.matchId).toBe('1:1');

    service.clearFindHighlights();
    expect(layer.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);
    service.destroy();
  });

  it('滚动当前命中会切换页码并调用 scrollIntoView', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const host = makeFakeHost({ pageCount: 2 });
    const service = new TextLayerService(host, createViewerBridge(host));
    const target = match(2, '2:0', 12);
    service.setFindMatches([target], 1, true);
    service.scrollToMatch(target);
    expect(host.goToPageCalls).toEqual([2]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
    service.destroy();
  });

  it('文档关闭时清空文本层与高亮', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Hello'])]]),
    });
    const service = new TextLayerService(host, createViewerBridge(host));
    await vi.waitFor(() => {
      expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length).toBe(1);
    });
    service.setFindMatches([match(1, '1:0', 10)], 1, true);
    host.emit('documentclose', {});
    expect(host.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item')).toHaveLength(0);
    expect(host.getPageView(1)!.surface.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);
    service.destroy();
  });

});