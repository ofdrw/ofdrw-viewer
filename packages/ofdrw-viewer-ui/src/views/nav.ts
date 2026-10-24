/**
 * 导航模块注册入口（设计方案 §7 / §8）。
 *
 * 顶层调用 `registerViewerExtension` 注册缩略图、大纲、书签面板；由最终入口
 * side-effect import 本文件即可生效。面板通过内置 UI 外壳的 `Sidebar.registerPanel`
 * 挂载，不修改核心 `viewer.ts`，也不直接操作主视图 DOM。
 *
 * 注册时可能尚未安装 UI 外壳（扩展顺序由入口决定），因此绑定会延后到微任务与
 * 后续 `statechange`/`featureschange`/`sidebarviewchanged` 事件继续尝试。
 */

import { runMicrotask } from '../compat';

import type { Translator } from '../i18n';
import { getUIShell } from '../ui';
import { registerViewerExtension, type OFDViewer } from '../viewer';
import { BookmarkView } from './bookmarks';
import { OutlineView } from './outline';
import { ThumbnailView } from './thumbnails';

/** 某个阅读器实例上的导航视图；面板按需创建。 */
export interface NavigationServices {
  /** 缩略图列表；打开过“缩略图”面板后才有。 */
  thumbnails?: ThumbnailView;
  /** 大纲树；打开过“大纲”面板后才有。 */
  outline?: OutlineView;
  /** 书签列表；打开过“书签”面板后才有。 */
  bookmarks?: BookmarkView;
}

/** 实例到导航视图的映射；用于诊断与测试。 */
const servicesByViewer = new WeakMap<object, NavigationServices>();

/**
 * 读取导航视图。
 *
 * @param viewer 阅读器实例。
 * @returns 导航视图；未绑定 UI 外壳时返回 undefined。
 */
export function getNavigationServices(viewer: object): NavigationServices | undefined {
  return servicesByViewer.get(viewer);
}

/**
 * 将三个导航面板挂到内置 UI 外壳。
 *
 * @param viewer 阅读器实例。
 * @returns 面板实例集合。
 */
function bindPanels(viewer: OFDViewer): NavigationServices {
  const shell = getUIShell(viewer);
  if (!shell) throw new Error('内置 UI 外壳尚未挂载');
  const services: NavigationServices = {};
  const getTranslator = (): Translator => shell.translatorInstance;

  shell.sidebar.registerPanel('thumbnails', (host) => {
    const view = new ThumbnailView({ viewer, host, getTranslator });
    services.thumbnails = view;
    return () => {
      if (services.thumbnails === view) delete services.thumbnails;
      view.destroy();
    };
  });

  shell.sidebar.registerPanel('outline', (host) => {
    const view = new OutlineView({ viewer, host, getTranslator });
    services.outline = view;
    return () => {
      if (services.outline === view) delete services.outline;
      view.destroy();
    };
  });

  shell.sidebar.registerPanel('bookmarks', (host) => {
    const view = new BookmarkView({ viewer, host, getTranslator });
    services.bookmarks = view;
    return () => {
      if (services.bookmarks === view) delete services.bookmarks;
      view.destroy();
    };
  });

  servicesByViewer.set(viewer, services);
  return services;
}

/**
 * 阅读器扩展：等待内置 UI 外壳就绪后注册导航面板。
 *
 * @param viewer 阅读器实例。
 * @returns 清理函数。
 */
export function attachNavigation(viewer: OFDViewer): () => void {
  let services: NavigationServices | null = null;
  let disposed = false;

  const bind = (): void => {
    if (disposed || services) return;
    try {
      services = bindPanels(viewer);
    } catch {
      // UI 外壳尚未安装；等待下一次事件/微任务。
    }
  };

  bind();
  if (!services) runMicrotask(bind);

  // 功能被关闭时同步关闭核心侧栏状态：核心只负责 hidden，UI 外壳只收起自己的
  // 选中态；两者保持一致需要导航层补一刀（不修改 viewer.ts）。
  const closeDisabledSidebar = (): void => {
    const view = viewer.getSidebarView();
    if (view && !viewer.getFeatureState(view).enabled) viewer.closeSidebar();
  };

  const offs = [
    viewer.on('statechange', () => {
      bind();
      closeDisabledSidebar();
    }),
    viewer.on('featureschange', () => {
      bind();
      closeDisabledSidebar();
    }),
    viewer.on('sidebarviewchanged', bind),
    viewer.on('documentopen', bind),
  ];

  return () => {
    disposed = true;
    for (const off of offs.splice(0)) off();
    servicesByViewer.delete(viewer);
    services = null;
  };
}

// 顶层注册：入口 side-effect import 本模块即可生效（t9 依赖该行为）。
registerViewerExtension(attachNavigation);