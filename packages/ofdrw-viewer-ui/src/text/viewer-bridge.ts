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
import type {
  PageInfo,
  TextContent,
  TextContentOptions,
  TextQuad,
} from '@ofdrw/ofdrw-viewer-engine';
import type { PageView } from '../page-view';
import type { FindState, Rotation, ViewerState } from '../state';
import type { CharRef } from './geometry';
import type { SelectionModel } from './selection';
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
  /** 页文本层构建完成后通知核心更新页级缓存（可选）。 */
  textLayerPageBuilt?(pageNumber: number): void;
  /** 选区 pin 集合变化后通知核心重新裁剪缓存（可选）。 */
  textLayerPinsChanged?(): void;
  /**
   * 分帧构建中选区 pin 的 span 数超出预算时通知核心清空选区（可选）。
   *
   * 文本层会先解除 pin 并发出 `W_SELECTION_UNPINNABLE`；若宿主持有选区快照，
   * 应在此清空，避免用户看到已失效的高亮。
   */
  textLayerPinBudgetExceeded?(): void;
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
  /**
   * 返回指定字符在 96 DPI 文本层坐标系中的四边形。
   *
   * @param pageNumber 页码，1-based。
   * @param refs 字符引用。
   * @returns 与 `refs` 等长的四边形数组；字符缺失或页文本未就绪时为 null。
   */
  getCharQuads(pageNumber: number, refs: readonly CharRef[]): (TextQuad | null)[];
  /**
   * 返回指定字符所属行的稳定标识。
   *
   * @param pageNumber 页码，1-based。
   * @param ref 字符引用。
   * @returns 行标识；无法判定时返回 null。
   */
  getRowIdOf(pageNumber: number, ref: CharRef): string | null;
  /**
   * 返回指定页的行主轴方向。
   *
   * @param pageNumber 页码，1-based。
   * @returns 主轴方向，单位弧度；页文本未就绪时返回 null。
   */
  getAxisRowRad(pageNumber: number): number | null;
  /**
   * 按选区模型/快照重绘块状选区层；`legacy` 模式恢复浏览器原生高亮。
   *
   * 查询替身可省略该能力；省略时不产生块状高亮，不影响选区文本抽取。
   *
   * @param model 统一选区模型或完整快照；空片段表示清空。
   */
  renderSelection?(model: SelectionModel): void;
  /**
   * 更新选区端点页 pin 集合。
   *
   * @param pages 端点页页码（1-based）；空数组表示释放全部 pin。
   * @returns pinned span 是否在上限内；false 表示调用方应清空选区。
   */
  setPinnedPages?(pages: readonly number[]): boolean;
  /** 读取当前 pin 页集合（1-based）。 */
  getPinnedPages?(): readonly number[];
  /** 释放指定页的文本层 DOM 与页数据；由核心缓存淘汰调用。 */
  releasePage?(pageNumber: number): void;
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