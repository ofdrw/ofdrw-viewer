/**
 * 文本层/查找/选区集成基线：真实 `OFDViewer` + 公共入口注册的文本模块。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { installDomEnvironment } from '../helpers/environment';
import { openViewer, type EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 等待首页文本层完成构建并返回首个文本项。 */
async function waitForFirstTextItem(
  viewer: Awaited<ReturnType<typeof openViewer>>['viewer'],
): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(
      viewer.getPageView(1)!.textLayer.querySelectorAll('.ofd-text-item').length,
    ).toBeGreaterThan(0);
  });
  return viewer.getPageView(1)!.textLayer.querySelector<HTMLElement>('.ofd-text-item')!;
}

describe('文本/查找集成', () => {
  it('构建透明文本层并按页查找、高亮与切换当前项', async () => {
    const { viewer } = await openViewer(openMock, { pageCount: 3 });
    const firstItem = await waitForFirstTextItem(viewer);
    expect(firstItem.textContent).toContain('hello');
    expect(viewer.getPageView(1)!.textLayer.dataset.dpi).toBe('96');
    expect(viewer.getPageView(1)!.textLayer.style.transform).toBe(
      'scale(var(--scale-factor, 1))',
    );

    const findEvents: string[] = [];
    viewer.on('findstart', () => findEvents.push('start'));
    viewer.on('findmatches', () => findEvents.push('matches'));
    viewer.on('findcurrent', () => findEvents.push('current'));

    await viewer.find('hello');
    expect(viewer.getState().view.findState).toMatchObject({
      query: 'hello',
      current: 1,
      total: 3,
      searching: false,
    });
    expect(findEvents).toEqual(expect.arrayContaining(['start', 'matches', 'current']));

    await vi.waitFor(() => {
      expect(
        viewer.getPageView(1)!.surface.querySelectorAll('.ofd-find-highlight').length,
      ).toBeGreaterThan(0);
    });

    await viewer.findNext();
    expect(viewer.getState().view.findState.current).toBe(2);
    await viewer.findPrevious();
    expect(viewer.getState().view.findState.current).toBe(1);

    viewer.clearFind();
    expect(viewer.getState().view.findState).toMatchObject({ query: '', total: 0, current: 0 });
    expect(viewer.getPageView(1)!.surface.querySelectorAll('.ofd-find-highlight')).toHaveLength(0);
    viewer.destroy();
  });

  it('选区读取/复制与 selectedText 状态同步', async () => {
    const { viewer } = await openViewer(openMock, { pageCount: 2 });
    const firstItem = await waitForFirstTextItem(viewer);
    const textNode = firstItem.firstChild;
    expect(textNode).toBeInstanceOf(Text);

    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(textNode!, 0);
    range.setEnd(textNode!, 4);
    selection.addRange(range);

    expect(viewer.getSelectedText()).toBe('第 1');
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() =>
      expect(viewer.getState().view.selectedText).toBe('第 1'),
    );

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await viewer.copySelection();
    expect(writeText).toHaveBeenCalledWith('第 1');

    viewer.clearSelection();
    expect(document.getSelection()!.rangeCount).toBe(0);
    expect(viewer.getState().view.selectedText).toBe('');
    viewer.destroy();
  });

  it('features.textLayer=false 时文本层清空、查找/选区按依赖关闭', async () => {
    const { viewer } = await openViewer(
      openMock,
      { pageCount: 2 },
      { features: { textLayer: false } },
    );
    expect(viewer.getFeatureState('textLayer')).toMatchObject({
      enabled: false,
      reason: 'host',
    });
    expect(viewer.getFeatureState('find')).toMatchObject({
      enabled: false,
      reason: 'dependency',
    });
    expect(viewer.getPageView(1)!.textLayer.hidden).toBe(true);
    expect(viewer.getPageView(1)!.textLayer.childElementCount).toBe(0);
    expect(viewer.getPageView(1)!.textLayer.dataset.selectable).toBe('false');

    await expect(viewer.find('hello')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'find',
    });
    expect(() => viewer.getSelectedText()).toThrow(
      expect.objectContaining({ code: 'OFD_FEATURE_DISABLED' }),
    );
    viewer.destroy();
  });
});