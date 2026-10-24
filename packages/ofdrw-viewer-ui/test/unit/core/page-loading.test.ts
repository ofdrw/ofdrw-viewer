/**
 * 页面级 loading 视觉与计时契约（设计方案 §5.3 / §6.9.3）。
 *
 * `PageView` 直接单测：首次渲染骨架 + spinner、重渲染保留旧 canvas 的遮罩、
 * 150 ms 延迟 / 最短 200 ms / 120 ms 淡出、失败错误卡与取消静默隐藏。
 */
import { replaceChildren } from '../../../src/compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';
import { PageView } from '../../../src/page-view';

/** 延迟/最短展示/淡出时长，单位毫秒；与实现契约一致。 */
const DELAY_MS = 150;
const MIN_VISIBLE_MS = 200;
const FADE_MS = 120;

const PAGE_INFO: PageInfo = { index: 0, widthMm: 210, heightMm: 297 };

/** 创建页视图并挂载。 */
function createPage(onRetry: (pageNumber: number) => void = () => undefined): PageView {
  const page = new PageView({
    pageNumber: 1,
    pageIndex: 0,
    pageInfo: PAGE_INFO,
    totalPages: 3,
    onRetry,
  });
  document.body.appendChild(page.element);
  return page;
}

/** 读取页面 loading 层。 */
function loadingOf(page: PageView): HTMLElement {
  const loading = page.element.querySelector<HTMLElement>('.ofd-page__loading');
  if (!loading) throw new Error('页面 loading 缺失');
  return loading;
}

/** 读取页面错误卡。 */
function errorOf(page: PageView): HTMLElement {
  const error = page.element.querySelector<HTMLElement>('.ofd-page__error');
  if (!error) throw new Error('页面错误卡缺失');
  return error;
}

beforeEach(() => {
  vi.useFakeTimers();
  replaceChildren(document.body);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  replaceChildren(document.body);
});

describe('PageView 页面 loading', () => {
  it('首次渲染 150 ms 后显示骨架 + spinner，隐藏文案提供状态表达', async () => {
    const page = createPage();
    const loading = loadingOf(page);

    page.beginLoading('op-1');
    expect(page.element.getAttribute('aria-busy')).toBe('true');
    expect(loading.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(loading.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(loading.hidden).toBe(false);
    expect(loading.dataset.variant).toBe('skeleton');

    const skeleton = loading.querySelector<HTMLElement>('.ofd-page__loading-skeleton');
    const spinner = loading.querySelector<HTMLElement>('.ofd-page__loading-spinner');
    const text = loading.querySelector<HTMLElement>('.ofd-page__loading-text');
    expect(skeleton?.hidden).toBe(false);
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(text?.classList.contains('ofd-sr-only')).toBe(true);
    expect(text?.textContent).toBe('第 1 页正在渲染…');

    page.destroy();
  });

  it('显示后最短 200 ms、120 ms 淡出，并在结束时清除 aria-busy', async () => {
    const page = createPage();
    const loading = loadingOf(page);
    page.beginLoading('op-1');
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(loading.hidden).toBe(false);

    page.finishLoading('op-1');
    expect(page.element.hasAttribute('aria-busy')).toBe(false);

    await vi.advanceTimersByTimeAsync(MIN_VISIBLE_MS - 1);
    expect(loading.hidden).toBe(false);
    expect(loading.dataset.fading).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(loading.dataset.fading).toBe('true');

    await vi.advanceTimersByTimeAsync(FADE_MS - 1);
    expect(loading.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(loading.hidden).toBe(true);

    page.destroy();
  });

  it('150 ms 内完成渲染时不显示页面 loading', async () => {
    const page = createPage();
    const loading = loadingOf(page);
    page.beginLoading('op-1');
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    page.finishLoading('op-1');

    await vi.advanceTimersByTimeAsync(DELAY_MS + MIN_VISIBLE_MS + FADE_MS);
    expect(loading.hidden).toBe(true);
    expect(page.element.hasAttribute('aria-busy')).toBe(false);

    page.destroy();
  });

  it('重渲染保留旧 canvas，loading 切换为半透明遮罩', async () => {
    const page = createPage();
    const firstGeneration = page.beginRender('scale:1');
    page.prepareCanvas(120, 160, firstGeneration);
    page.completeRender(firstGeneration, 'scale:1');
    const canvas = page.canvas;
    expect(canvas).not.toBeNull();

    const secondGeneration = page.beginRender('scale:2');
    // 旧 canvas 不销毁，只标记过期以继续展示。
    expect(page.canvas).toBe(canvas);
    expect(canvas?.dataset.stale).toBe('true');

    const loading = loadingOf(page);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(loading.hidden).toBe(false);
    expect(loading.dataset.variant).toBe('overlay');
    expect(page.canvasWrapper.contains(canvas)).toBe(true);

    page.completeRender(secondGeneration, 'scale:2');
    expect(page.canvas).toBe(canvas);
    expect(canvas?.dataset.stale).toBeUndefined();
    expect(canvas?.dataset.renderKey).toBe('scale:2');

    page.destroy();
  });

  it('重渲染先绘制到离屏 canvas，completeRender 成功后才替换旧 canvas', () => {
    const page = createPage();
    const first = page.beginRender('scale:1');
    page.prepareCanvas(120, 160, first);
    page.completeRender(first, 'scale:1');
    const oldCanvas = page.canvas!;
    expect(oldCanvas).not.toBeNull();

    const second = page.beginRender('scale:2');
    const context = page.prepareCanvas(240, 320, second);
    expect(context).not.toBeNull();
    // 旧 canvas 仍在 DOM 且尺寸未被改写；新 canvas 尚未挂载。
    expect(page.canvas).toBe(oldCanvas);
    expect(oldCanvas.width).toBe(120);
    expect(oldCanvas.height).toBe(160);
    expect(page.element.querySelectorAll('.ofd-page__canvas')).toHaveLength(1);

    page.completeRender(second, 'scale:2');
    expect(page.canvas).not.toBe(oldCanvas);
    expect(oldCanvas.isConnected).toBe(false);
    expect(page.element.querySelectorAll('.ofd-page__canvas')).toHaveLength(1);
    expect(page.canvas?.width).toBe(240);
    expect(page.canvas?.height).toBe(320);
    expect(page.canvas?.dataset.renderKey).toBe('scale:2');

    page.destroy();
  });

  it('重渲染 abort/fail 丢弃离屏 canvas 并保留旧画面', () => {
    const page = createPage();
    const first = page.beginRender('scale:1');
    page.prepareCanvas(120, 160, first);
    page.completeRender(first, 'scale:1');
    const oldCanvas = page.canvas!;

    const aborted = page.beginRender('scale:2');
    page.prepareCanvas(240, 320, aborted);
    page.cancelRender(aborted);
    expect(page.canvas).toBe(oldCanvas);
    expect(oldCanvas.isConnected).toBe(true);
    expect(page.state).toBe('rendered');
    expect(page.canvasWrapper.hidden).toBe(false);

    const failed = page.beginRender('scale:3');
    page.prepareCanvas(360, 480, failed);
    page.failRender(failed, { code: 'OFD_RENDER_FAILED', message: '失败' });
    expect(page.canvas).toBe(oldCanvas);
    expect(oldCanvas.isConnected).toBe(true);
    expect(page.state).toBe('error');
    expect(page.canvasWrapper.hidden).toBe(false);
    expect(page.element.querySelectorAll('.ofd-page__canvas')).toHaveLength(1);

    page.destroy();
  });

  it('取消静默隐藏，不显示错误卡；旧操作晚到不关闭新操作的 loading', async () => {
    const page = createPage();
    const loading = loadingOf(page);
    const error = errorOf(page);

    page.beginLoading('op-old');
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(loading.hidden).toBe(false);

    // 新操作接管；旧操作结束不应关闭。
    page.beginLoading('op-new');
    page.finishLoading('op-old');
    expect(loading.hidden).toBe(false);
    expect(page.element.getAttribute('aria-busy')).toBe('true');

    page.cancelLoading('op-new');
    expect(loading.hidden).toBe(true);
    expect(loading.dataset.fading).toBeUndefined();
    expect(error.hidden).toBe(true);
    expect(page.element.hasAttribute('aria-busy')).toBe(false);

    page.destroy();
  });

  it('渲染失败显示页内错误卡（错误码/消息/重试），不残留 loading', async () => {
    const retries: number[] = [];
    const page = createPage((pageNumber) => retries.push(pageNumber));
    const loading = loadingOf(page);
    const generation = page.beginRender('scale:1');

    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(loading.hidden).toBe(false);

    page.failRender(generation, { code: 'OFD_RENDER_FAILED', message: '页渲染失败' });
    const error = errorOf(page);
    expect(loading.hidden).toBe(true);
    expect(page.element.hasAttribute('aria-busy')).toBe(false);
    expect(error.hidden).toBe(false);
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.querySelector('.ofd-page__error-code')?.textContent).toBe('OFD_RENDER_FAILED');
    expect(error.querySelector('.ofd-page__error-message')?.textContent).toBe('页渲染失败');
    expect(page.state).toBe('error');
    expect(page.element.dataset.pageState).toBe('error');
    expect(page.canvasWrapper.hidden).toBe(true);

    const retry = error.querySelector<HTMLButtonElement>('.ofd-page__retry');
    expect(retry?.textContent).toBe('重试');
    retry?.click();
    expect(retries).toEqual([1]);

    page.destroy();
  });

  it('failLoading 不等待 150 ms 即切错误卡，cancelLoading 立即静默隐藏', async () => {
    const page = createPage();
    const loading = loadingOf(page);
    const error = errorOf(page);

    page.beginLoading('op-fail');
    page.failLoading('op-fail', { code: 'OFD_RENDER_FAILED', message: '失败' });
    expect(loading.hidden).toBe(true);
    expect(error.hidden).toBe(false);
    expect(page.element.hasAttribute('aria-busy')).toBe(false);

    error.hidden = true;
    page.beginLoading('op-cancel');
    page.cancelLoading('op-cancel');
    expect(loading.hidden).toBe(true);
    expect(error.hidden).toBe(true);
    expect(page.element.hasAttribute('aria-busy')).toBe(false);

    page.destroy();
  });

  it('prefers-reduced-motion 时跳过淡出直接隐藏', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      })),
    });
    const page = createPage();
    const loading = loadingOf(page);
    page.beginLoading('op');
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    page.finishLoading('op');

    // 最短展示到点后不再产生 data-fading，而是立即隐藏。
    await vi.advanceTimersByTimeAsync(MIN_VISIBLE_MS);
    expect(loading.dataset.fading).toBeUndefined();
    expect(loading.hidden).toBe(true);

    page.destroy();
  });
});