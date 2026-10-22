/**
 * 文本模块与阅读器核心之间的桥接（设计方案 §3.4 / §9）。
 *
 * 文本层、查找、选区都是核心的扩展：核心负责实例方法门控与事件总线，文本模块只
 * 消费 `getPage`/`getPageView` 等公开读取接口。查找进度、选区文本需要回写核心状态
 * 并发事件；当前核心尚未暴露公开的“扩展写入”入口，这里通过结构化内部接口复用
 * 核心已有的 `patchView`/`commit`/`emit`/`warn`，不修改核心文件。
 *
 * 当宿主是测试替身或未来核心提供了同等公开接口时，桥接自动降级：
 * - 缺少 `patchView`/`commit` 时只维护文本模块内部状态（不写核心状态）；
 * - 缺少 `emit` 时只调用文本模块自己的监听器；
 * - 缺少 `warn` 时静默忽略诊断信息。
 */

import type { EnginePage } from '../document-controller';
import type { ViewerFeature, ViewerFeatureStates } from '../features';
import type { PageInfo, TextContent, TextContentOptions } from '@ofdrw/ofdrw-viewer-engine';
import type { PageView } from '../page-view';
import type { FindState, Rotation, ViewerState } from '../state';
import type {
  SelectionChangeEvent,
  ViewerEventMap,
  ViewerEventHandler,
  ViewerEventName,
} from '../types';

/** 文本模块使用的阅读器能力；`OFDViewer` 结构兼容。 */
export interface TextViewerHost {
  /** 最新状态快照。 */
  getState(): ViewerState;
  /** 订阅核心事件；返回退订函数。 */
  on<K extends ViewerEventName>(event: K, handler: ViewerEventHandler<K>): () => void;
  /** 总页数。 */
  getPageCount(): number;
  /** 当前页码，1-based。 */
  getPageNumber(): number;
  /** 页信息；页码 1-based。 */
  getPageInfo(pageNumber: number): PageInfo | undefined;
  /** 读取指定页引擎对象；页码 1-based。 */
  getPage(pageNumber: number): Promise<EnginePage>;
  /** 读取页视图；页码 1-based。 */
  getPageView(pageNumber: number): PageView | undefined;
  /** 全部页视图。 */
  getPageViews(): readonly PageView[];
  /** 当前缩放倍率。 */
  getScale(): number;
  /** 当前旋转角度。 */
  getRotation(): Rotation;
  /** 功能是否可用。 */
  isFeatureEnabled(feature: ViewerFeature): boolean;
  /** 全部功能状态。 */
  getFeatureStates(): ViewerFeatureStates;
  /** 跳转页码。 */
  goToPage(pageNumber: number, options?: { readonly smooth?: boolean }): void;
  /** 阅读器根节点；用于监听原生选区。 */
  getRoot?(): HTMLElement;
}

/** 核心内部可用的写入口；仅做“存在即使用”的运行时探测。 */
interface ViewerCoreInternals {
  patchView?: (patch: Partial<ViewerState['view']>) => void;
  commit?: () => void;
  emit?: <K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]) => void;
  warn?: (code: string, message: string, pageIndex?: number) => void;
}

/** 文本层服务的最小接口；`OFDViewer.attachTextLayerService` 结构兼容。 */
export interface ViewerTextLayerServiceLike {
  /** 页面创建/布局变化时刷新文本层。 */
  refresh(): void;
  /** 销毁。 */
  destroy(): void;
}

/** 文本模块使用的核心状态/事件桥。 */
export interface ViewerBridge {
  /**
   * 合并写入查找状态。
   *
   * @param patch 部分查找状态；与核心当前状态合并后提交。
   */
  patchFindState(patch: Partial<FindState>): void;
  /**
   * 发布选区变化：写入 `selectedText` 并触发 `selectionchange`。
   *
   * @param text 当前选区文本；空字符串表示清空。
   */
  publishSelection(text: string): void;
  /**
   * 触发核心事件。
   *
   * @param event 事件名。
   * @param payload 事件载荷。
   */
  emit<K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]): void;
  /**
   * 上报 warning。
   *
   * @param code 诊断码。
   * @param message 文案。
   * @param pageIndex 页索引，0-based。
   */
  warn(code: string, message: string, pageIndex?: number): void;
}

/**
 * 创建核心桥接。
 *
 * @param host 阅读器能力集合。
 * @returns 桥接对象；核心缺少写入口时为空操作（仍可本地运行）。
 */
export function createViewerBridge(host: TextViewerHost): ViewerBridge {
  const internals = host as unknown as ViewerCoreInternals;

  const patchView = (patch: Partial<ViewerState['view']>): void => {
    if (typeof internals.patchView !== 'function') return;
    internals.patchView.call(host, patch);
  };

  const commit = (): void => {
    if (typeof internals.commit === 'function') internals.commit.call(host);
  };

  return {
    patchFindState(patch: Partial<FindState>): void {
      const current = host.getState().view.findState;
      patchView({ findState: { ...current, ...patch } });
      commit();
    },

    publishSelection(text: string): void {
      patchView({ selectedText: text });
      const payload: SelectionChangeEvent = { text, isEmpty: text.length === 0 };
      if (typeof internals.emit === 'function') {
        internals.emit.call(host, 'selectionchange', payload);
      }
      commit();
    },

    emit<K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]): void {
      if (typeof internals.emit === 'function') internals.emit.call(host, event, payload);
    },

    warn(code: string, message: string, pageIndex?: number): void {
      if (typeof internals.warn === 'function') {
        if (pageIndex === undefined) internals.warn.call(host, code, message);
        else internals.warn.call(host, code, message, pageIndex);
      }
    },
  };
}

/**
 * 读取文本内容的统一选项；固定 96 DPI（CSS px 基准），包含字符级几何。
 *
 * @param signal 取消信号。
 * @returns 引擎文本选项。
 */
export function textContentOptions(signal: AbortSignal): TextContentOptions {
  return {
    dpi: 96,
    includeChars: true,
    includeAnnotations: false,
    includeInvisible: false,
    signal,
  };
}

/** 引擎页文本读取的最小结构；用于测试替身。 */
export type TextPage = Pick<EnginePage, 'getTextContent'>;

/** 读取页面文本内容；页面不支持时返回 null。 */
export type TextContentReader = (
  page: TextPage,
  signal: AbortSignal,
) => Promise<TextContent | null>;