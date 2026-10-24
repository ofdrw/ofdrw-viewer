import { describe, expect, it, vi } from 'vitest';
import { FindController } from '../../../src/text/find-controller';
import type { FindHighlightRenderer, FindMatch, SliceScheduler } from '../../../src/text/types';
import { createViewerBridge } from '../../../src/text/viewer-bridge';
import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import { contentWithLines, makeContent, makeFakeHost, makeItem } from './helpers';
import { UI_WARNING_CODES } from '../../../src/diagnostics';

/** 记录高亮调用的假渲染器。 */
class RecordingHighlighter implements FindHighlightRenderer {
  matches: readonly FindMatch[] = [];
  current = 0;
  highlightAll = true;
  readonly scrolls: FindMatch[] = [];
  cleared = 0;

  setFindMatches(matches: readonly FindMatch[], current: number, highlightAll: boolean): void {
    this.matches = matches;
    this.current = current;
    this.highlightAll = highlightAll;
  }

  setFindCurrent(current: number): void {
    this.current = current;
  }

  clearFindHighlights(): void {
    this.matches = [];
    this.current = 0;
    this.cleared += 1;
  }

  scrollToMatch(match: FindMatch): void {
    this.scrolls.push(match);
  }
}

/** 构造每页一句话的内容映射。 */
function pagesWith(
  pageCount: number,
  text: (page: number) => string,
): Map<number, TextContent> {
  const map = new Map<number, TextContent>();
  for (let page = 1; page <= pageCount; page += 1) {
    map.set(page, makeContent([makeItem({ text: text(page), x: 10, y: 100, size: 16 })]));
  }
  return map;
}

/** 等待宏任务。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FindController 查找', () => {
  it('支持大小写与全词匹配，并发布进度/计数事件', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: new Map([[1, contentWithLines(['Cat concatenate cat'])]]),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights);

    await controller.find('cat', { caseSensitive: true, wholeWord: true });
    expect(controller.getFindState().total).toBe(1);
    expect(controller.getMatches()[0]!.text).toBe('cat');
    expect(controller.getFindState().searching).toBe(false);
    expect(host.state.view.findState).toMatchObject({
      query: 'cat',
      total: 1,
      current: 1,
      searching: false,
      caseSensitive: true,
      wholeWord: true,
    });
    expect(host.events.some((event) => event.name === 'findstart')).toBe(true);
    expect(host.events.some((event) => event.name === 'findmatches')).toBe(true);
    expect(highlights.scrolls.length).toBeGreaterThanOrEqual(1);
    controller.destroy();
  });

  it('从当前页开始逐页搜索，再回到文首', async () => {
    const host = makeFakeHost({
      pageCount: 5,
      pageNumber: 3,
      contents: pagesWith(5, (page) => `第 ${page} 页 keyword`),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights, {
      pagesPerSlice: 1,
    });
    await controller.find('keyword', { fromCurrentPage: true });
    expect(host.textCalls).toEqual([3, 4, 5, 1, 2]);
    expect(controller.getFindState().total).toBe(5);
    expect(controller.getMatches().map((match) => match.pageNumber)).toEqual([3, 4, 5, 1, 2]);
    controller.destroy();
  });

  it('findNext/findPrevious 循环切换并滚动当前项', async () => {
    const host = makeFakeHost({
      pageCount: 3,
      contents: pagesWith(3, (page) => `match ${page}`),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights);
    await controller.find('match');
    expect(controller.getFindState().current).toBe(1);

    controller.findNext();
    expect(controller.getFindState().current).toBe(2);
    expect(highlights.scrolls.at(-1)!.pageNumber).toBe(2);
    controller.findNext();
    controller.findNext();
    expect(controller.getFindState().current).toBe(1);
    controller.findPrevious();
    expect(controller.getFindState().current).toBe(3);
    expect(highlights.scrolls.map((match) => match.pageNumber)).toEqual([1, 1, 2, 3, 1, 3]);
    expect(host.events.filter((event) => event.name === 'findcurrent')).toHaveLength(5);
    controller.destroy();
  });

  it('highlightAll=false 时只渲染当前命中', async () => {
    const host = makeFakeHost({
      pageCount: 2,
      contents: pagesWith(2, (page) => `hit ${page}`),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights);
    await controller.find('hit', { highlightAll: false });
    expect(highlights.highlightAll).toBe(false);
    expect(highlights.matches).toHaveLength(2);
    expect(highlights.current).toBe(1);
    controller.destroy();
  });

  it('1000 页搜索分片执行，不一次性阻塞主线程', async () => {
    const host = makeFakeHost({
      pageCount: 1000,
      pageNumber: 1,
      contents: pagesWith(1000, (page) => `page ${page} keyword`),
    });
    const highlights = new RecordingHighlighter();
    let yields = 0;
    let callsAtFirstYield = -1;
    const scheduler: SliceScheduler = {
      request(callback) {
        yields += 1;
        if (callsAtFirstYield < 0) callsAtFirstYield = host.textCalls.length;
        setTimeout(callback, 0);
      },
    };
    const controller = new FindController(host, createViewerBridge(host), highlights, {
      scheduler,
      pagesPerSlice: 8,
    });
    await controller.find('keyword');
    expect(controller.getFindState().total).toBe(1000);
    expect(controller.getFindState().searching).toBe(false);
    expect(yields).toBeGreaterThanOrEqual(100);
    expect(callsAtFirstYield).toBeLessThanOrEqual(8);
    expect(host.textCalls).toHaveLength(1000);
    expect(highlights.scrolls.length).toBeGreaterThan(0);
    controller.destroy();
  });

  it('新查询中止旧任务，旧结果按代次丢弃', async () => {
    let resolveFirst: ((content: TextContent) => void) | null = null;
    const first = new Promise<TextContent>((resolve) => {
      resolveFirst = resolve;
    });
    const signals: AbortSignal[] = [];
    const contents = new Map<number, TextContent | ((options?: { signal?: AbortSignal }) => Promise<TextContent>)>([
      [
        1,
        (options) => {
          if (options?.signal) signals.push(options.signal);
          return first;
        },
      ],
      [2, makeContent([makeItem({ text: 'b target', x: 10, y: 100, size: 16 })])],
    ]);
    const host = makeFakeHost({ pageCount: 2, contents });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights);
    const firstRun = controller.find('a');
    await tick();
    const secondRun = controller.find('b');
    await tick();
    expect(signals[0]?.aborted).toBe(true);
    resolveFirst!(makeContent([makeItem({ text: 'a target', x: 10, y: 100, size: 16 })]));
    await firstRun;
    await secondRun;
    const state = controller.getFindState();
    expect(state.query).toBe('b');
    expect(state.total).toBe(1);
    expect(controller.getMatches().every((match) => match.text.includes('b'))).toBe(true);
    const staleStart = host.events.find(
      (event) =>
        event.name === 'findmatches' &&
        (event.payload as { query: string }).query === 'a' &&
        (event.payload as { total: number }).total > 0,
    );
    expect(staleStart).toBeUndefined();
    controller.destroy();
  });

  it('clearFind 清空高亮与状态', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: pagesWith(1, () => 'hello'),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights);
    await controller.find('hello');
    expect(controller.getFindState().total).toBe(1);
    controller.clearFind();
    expect(controller.getFindState()).toMatchObject({ query: '', total: 0, current: 0 });
    expect(highlights.matches).toHaveLength(0);
    expect(host.state.view.findState.query).toBe('');
    expect(
      host.events.some(
        (event) =>
          event.name === 'findmatches' &&
          (event.payload as { query: string }).query === '',
      ),
    ).toBe(true);
    controller.destroy();
  });

  it('命中上限与空文本 warning', async () => {
    const many = `${'x '.repeat(20)}`.trim();
    const host = makeFakeHost({
      pageCount: 2,
      contents: new Map([
        [1, contentWithLines([many])],
        [2, contentWithLines([many])],
      ]),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights, {
      maxPageMatches: 5,
      maxTotalMatches: 8,
    });
    await controller.find('x');
    expect(controller.getMatches()).toHaveLength(8);
    expect(host.warnings.map((warning) => warning.code)).toContain(UI_WARNING_CODES.W_FIND_PAGE_LIMIT);
    expect(host.warnings.map((warning) => warning.code)).toContain(UI_WARNING_CODES.W_FIND_LIMIT);
    controller.destroy();
  });

  it('全篇无文本时提示且总数为 0', async () => {
    const host = makeFakeHost({
      pageCount: 2,
      contents: new Map([
        [1, makeContent([])],
        [2, makeContent([])],
      ]),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights);
    await controller.find('anything');
    expect(controller.getFindState().total).toBe(0);
    expect(host.warnings.map((warning) => warning.code)).toContain(UI_WARNING_CODES.W_TEXT_EMPTY);
    controller.destroy();
  });

  it('features.find=false 时抛 OFD_FEATURE_DISABLED', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      features: { find: false },
      contents: pagesWith(1, () => 'hello'),
    });
    const controller = new FindController(
      host,
      createViewerBridge(host),
      new RecordingHighlighter(),
    );
    await expect(controller.find('hello')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'find',
    });
    let nextError: unknown;
    try {
      controller.findNext();
    } catch (error) {
      nextError = error;
    }
    expect(nextError).toMatchObject({ code: 'OFD_FEATURE_DISABLED' });
    controller.destroy();
  });

  it('空查询等同清除查找', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: pagesWith(1, () => 'hello'),
    });
    const controller = new FindController(
      host,
      createViewerBridge(host),
      new RecordingHighlighter(),
    );
    await controller.find('   ');
    expect(controller.getFindState()).toMatchObject({ query: '', total: 0 });
    controller.destroy();
  });

  it('文档切换时重置查找缓存与状态', async () => {
    const host = makeFakeHost({
      pageCount: 1,
      contents: pagesWith(1, () => 'hello'),
    });
    const highlights = new RecordingHighlighter();
    const controller = new FindController(host, createViewerBridge(host), highlights);
    await controller.find('hello');
    host.emit('documentopen', { pageCount: 1 });
    expect(controller.getFindState().total).toBe(0);
    expect(controller.getFindState().query).toBe('');
    expect(highlights.matches).toHaveLength(0);
    controller.destroy();
  });
});