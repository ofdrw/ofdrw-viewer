import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntegratedViewer,
  installEnvironment,
  resetDom,
} from './helpers';

beforeEach(() => {
  resetDom();
  installEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('导航模块注册与功能门控', () => {
  it('side-effect import 后自动注册导航面板，无需修改 viewer.ts', async () => {
    const { viewer, shell, navigation } = await createIntegratedViewer({ pageCount: 3 });
    expect(navigation()).toBeDefined();
    viewer.openSidebar('thumbnails');
    expect(shell.sidebar.getPanel('thumbnails')?.querySelector('.ofd-thumbnails')).not.toBeNull();
    expect(navigation()?.thumbnails).toBeDefined();
    viewer.destroy();
  });

  it('features.thumbnails/outline/bookmarks=false 时对应标签隐藏', async () => {
    const { viewer, shell } = await createIntegratedViewer(
      { pageCount: 3 },
      { features: { thumbnails: false, outline: false, bookmarks: false } },
    );
    expect(shell.sidebar.getTab('thumbnails')?.hidden).toBe(true);
    expect(shell.sidebar.getTab('outline')?.hidden).toBe(true);
    expect(shell.sidebar.getTab('bookmarks')?.hidden).toBe(true);
    expect(shell.sidebar.getTab('signatures')?.hidden).toBe(false);
    expect(() => viewer.openSidebar('thumbnails')).toThrow(
      expect.objectContaining({ code: 'OFD_FEATURE_DISABLED' }),
    );

    viewer.setFeatures({ thumbnails: true });
    expect(shell.sidebar.getTab('thumbnails')?.hidden).toBe(false);
    viewer.openSidebar('thumbnails');
    expect(viewer.getSidebarView()).toBe('thumbnails');
    viewer.destroy();
  });

  it('features.sidebar=false 时整个侧栏关闭且导航不崩溃', async () => {
    const { viewer, shell } = await createIntegratedViewer(
      { pageCount: 3 },
      { features: { sidebar: false } },
    );
    expect(viewer.getElements().sidebar.hidden).toBe(true);
    expect(viewer.getFeatureState('thumbnails').reason).toBe('dependency');
    expect(() => viewer.openSidebar('thumbnails')).toThrow(
      expect.objectContaining({ code: 'OFD_FEATURE_DISABLED' }),
    );
    expect(shell.sidebar.getPanel('thumbnails')).not.toBeNull();
    viewer.destroy();
  });

  it('关闭大纲功能后再次开启仍显示面板内容', async () => {
    const { viewer, shell } = await createIntegratedViewer({
      pageCount: 3,
      outline: [{ title: '章节', dest: { type: 'Fit', pageIndex: 0 }, children: [] }],
    });
    await vi.waitFor(() => {
      expect(viewer.getState().document.outline).toHaveLength(1);
    });
    viewer.openSidebar('outline');
    const panel = shell.sidebar.getPanel('outline')!;
    expect(panel.querySelector('.ofd-outline__title')?.textContent).toBe('章节');

    viewer.setFeatures({ outline: false });
    expect(shell.sidebar.getTab('outline')?.hidden).toBe(true);
    expect(viewer.getSidebarView()).toBeNull();

    viewer.setFeatures({ outline: true });
    viewer.openSidebar('outline');
    expect(panel.querySelector('.ofd-outline__title')?.textContent).toBe('章节');
    viewer.destroy();
  });
});