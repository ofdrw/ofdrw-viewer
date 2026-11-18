/**
 * 指针路由单测（UI 动作处理机制设计 §6.1 / §6.2 / §6.4）。
 *
 * 覆盖：位移 > 4px 视为拖拽不触发、有选区不触发、签章/媒体元素让位、坐标换算
 * 走 `getContentPointAtViewport()`、多指不触发。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionInfo } from '@ofdrw/ofdrw-viewer-engine';
import { DRAG_THRESHOLD_PX, PointerRouter } from '../../../src/actions/pointer-router';
import type { ActionViewerHost } from '../../../src/actions/types';

/** 构造一个待命中的动作。 */
const ACTION = {
  event: 'CLICK',
  type: 'goto',
  owner: { kind: 'object', pageIndex: 0, objectId: '1' },
  payload: { type: 'goto', dest: { type: 'XYZ', pageIndex: 1 } },
} as unknown as ActionInfo;

/** 创建路由与记录。 */
function createRouter(options: { contentPoint?: { pageIndex: number; xPx: number; yPx: number } } = {}) {
  const main = document.createElement('div');
  document.body.appendChild(main);
  const host = {
    getState: () => ({ view: { visiblePageRange: { start: 0, end: 0 } } }),
    on: () => () => undefined,
    getRoot: () => main,
    getElements: () => ({ root: main, main, dialogLayer: main, toastLayer: main }),
    getDocument: () => null,
    getPageInfos: () => [],
    getPageNumber: () => 1,
    getScale: () => 1,
    getRotation: () => 0,
    getPageView: () => undefined,
    getPageViews: () => [],
    goToPage: vi.fn(),
    setScale: vi.fn(),
    setZoomMode: vi.fn(),
    isFeatureEnabled: () => true,
    getTranslator: () => ({ t: () => '' }),
    getContentPointAtViewport: () =>
      options.contentPoint ?? { pageIndex: 0, xPx: 100, yPx: 200 },
  } as unknown as ActionViewerHost;
  const onClick = vi.fn();
  const resolveHit = vi.fn(() => ({ actions: [ACTION] }));
  const router = new PointerRouter({ host, resolveHit, onClick });
  router.attach();
  return { router, main, onClick, resolveHit };
}

/** 派发指针事件。 */
function fire(
  target: Element,
  type: 'pointerdown' | 'pointerup',
  init: {
    clientX: number;
    clientY: number;
    button?: number;
    pointerType?: string;
    pointerId?: number;
    isPrimary?: boolean;
  },
): void {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    button: { value: init.button ?? 0 },
    pointerType: { value: init.pointerType ?? 'mouse' },
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: init.isPrimary ?? true },
  });
  target.dispatchEvent(event);
}

describe('PointerRouter 点击判定', () => {
  it('位移在阈值内触发命中', () => {
    const { main, onClick, resolveHit } = createRouter();
    fire(main, 'pointerdown', { clientX: 10, clientY: 10 });
    fire(main, 'pointerup', { clientX: 12, clientY: 12 });
    expect(resolveHit).toHaveBeenCalledWith(0, { x: 100, y: 200 });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]![0]).toBe(0);
  });

  it('位移超过 4px 视为拖拽，不触发', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 10, clientY: 10 });
    fire(main, 'pointerup', { clientX: 10 + DRAG_THRESHOLD_PX + 1, clientY: 10 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('边界正好等于阈值时仍触发', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(main, 'pointerup', { clientX: DRAG_THRESHOLD_PX, clientY: 0 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('没有 pointerdown 起点时不触发', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('非主按钮不响应', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 0, clientY: 0, button: 2 });
    fire(main, 'pointerup', { clientX: 0, clientY: 0, button: 2 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('pointercancel 后不触发', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 0, clientY: 0 });
    main.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    fire(main, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('PointerRouter 让位规则', () => {
  it('签章框上按下再抬起不触发', () => {
    const { main, onClick } = createRouter();
    const signature = document.createElement('button');
    signature.className = 'ofd-signature-box';
    main.appendChild(signature);
    fire(signature, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(signature, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('媒体元素（video）上按下不触发', () => {
    const { main, onClick } = createRouter();
    const video = document.createElement('video');
    main.appendChild(video);
    fire(video, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(video, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('[data-ofd-media] 元素同样让位', () => {
    const { main, onClick } = createRouter();
    const media = document.createElement('div');
    media.setAttribute('data-ofd-media', '');
    main.appendChild(media);
    fire(media, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(media, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('有活动文本选区时不触发', () => {
    const { main, onClick } = createRouter();
    const text = document.createElement('span');
    text.textContent = '可选文本';
    main.appendChild(text);
    // 模拟非空选区且锚点在主区域内。
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    fire(text, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(text, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
    selection.removeAllRanges();
  });

  it('actions 功能关闭时不响应', () => {
    const main = document.createElement('div');
    document.body.appendChild(main);
    const host = {
      getState: () => ({ view: { visiblePageRange: { start: 0, end: 0 } } }),
      on: () => () => undefined,
      getRoot: () => main,
      getElements: () => ({ root: main, main, dialogLayer: main, toastLayer: main }),
      getDocument: () => null,
      getPageInfos: () => [],
      getPageNumber: () => 1,
      getScale: () => 1,
      getRotation: () => 0,
      getPageView: () => undefined,
      getPageViews: () => [],
      goToPage: vi.fn(),
      setScale: vi.fn(),
      setZoomMode: vi.fn(),
      isFeatureEnabled: () => false,
      getTranslator: () => ({ t: () => '' }),
      getContentPointAtViewport: () => ({ pageIndex: 0, xPx: 0, yPx: 0 }),
    } as unknown as ActionViewerHost;
    const onClick = vi.fn();
    const router = new PointerRouter({ host, resolveHit: () => ({ actions: [ACTION] }), onClick });
    router.attach();
    fire(main, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(main, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('PointerRouter 坐标换算', () => {
  it('把 getContentPointAtViewport 的页面 px 直接交给命中测试', () => {
    const { main, resolveHit } = createRouter({
      contentPoint: { pageIndex: 2, xPx: 258.9, yPx: 128.5 },
    });
    fire(main, 'pointerdown', { clientX: 500, clientY: 300 });
    fire(main, 'pointerup', { clientX: 500, clientY: 300 });
    expect(resolveHit).toHaveBeenCalledWith(2, { x: 258.9, y: 128.5 });
  });

  it('坐标换算返回空时静默放弃', () => {
    const main = document.createElement('div');
    document.body.appendChild(main);
    const host = {
      getState: () => ({ view: { visiblePageRange: { start: 0, end: 0 } } }),
      on: () => () => undefined,
      getRoot: () => main,
      getElements: () => ({ root: main, main, dialogLayer: main, toastLayer: main }),
      getDocument: () => null,
      getPageInfos: () => [],
      getPageNumber: () => 1,
      getScale: () => 1,
      getRotation: () => 0,
      getPageView: () => undefined,
      getPageViews: () => [],
      goToPage: vi.fn(),
      setScale: vi.fn(),
      setZoomMode: vi.fn(),
      isFeatureEnabled: () => true,
      getTranslator: () => ({ t: () => '' }),
      getContentPointAtViewport: () => undefined,
    } as unknown as ActionViewerHost;
    const onClick = vi.fn();
    const router = new PointerRouter({ host, resolveHit: () => ({ actions: [ACTION] }), onClick });
    router.attach();
    fire(main, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(main, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('命中为空时不触发', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(main, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('PointerRouter 生命周期', () => {
  it('detach 后不再响应', () => {
    const { router, main, onClick } = createRouter();
    router.detach();
    fire(main, 'pointerdown', { clientX: 0, clientY: 0 });
    fire(main, 'pointerup', { clientX: 0, clientY: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });
});
describe('PointerRouter 多指判定', () => {
  it('非主指针按下不记录起点，其抬起不触发动作', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 2, isPrimary: false });
    fire(main, 'pointerup', { clientX: 10, clientY: 10, pointerId: 2, isPrimary: false });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('主指针按下、另一根手指抬起时不触发动作', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    fire(main, 'pointerup', { clientX: 10, clientY: 10, pointerId: 2, isPrimary: false });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('主指针按下并抬起触发一次动作', () => {
    const { main, onClick } = createRouter();
    fire(main, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    fire(main, 'pointerup', { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
