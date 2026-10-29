/**
 * 文本模块入口（设计方案 §9）。
 *
 * 顶层调用 `registerViewerExtension` 注册扩展：每个 `OFDViewer` 实例创建时挂载
 * `FindController`（同时承接选区方法）与 `TextLayerService`，不需要核心 import
 * 文本模块。最终入口（t9）只需 side-effect import 本文件。
 *
 * 功能依赖：`features.textLayer=false` 时核心会把 `find`/`selection` 置为不可用；
 * 文本模块自身也会拒绝查找/选区调用并清空文本层。
 */

import type { OFDViewer, ViewerFindService, ViewerTextLayerService } from '../viewer';
import { registerViewerExtension } from '../viewer';
import { FindController } from './find-controller';
import { SelectionManager } from './selection';
import { TextLayerService } from './text-layer';
import type { TextViewerHost } from './viewer-bridge';
import { createViewerBridge } from './viewer-bridge';

/** 文本模块所需的挂载能力；`OFDViewer` 结构兼容。 */
export interface TextViewerAttachHost extends TextViewerHost {
  /** 挂载查找服务。 */
  attachFindController(service: ViewerFindService): () => void;
  /** 挂载文本层服务。 */
  attachTextLayerService(service: ViewerTextLayerService): () => void;
}

/**
 * 把文本层、查找与选区挂载到阅读器实例。
 *
 * @param viewer 阅读器实例。
 * @returns 清理函数；销毁实例时调用。
 */
export function attachTextModule(viewer: OFDViewer): () => void {
  const host = viewer as unknown as TextViewerAttachHost;
  const bridge = createViewerBridge(host);
  let selection: SelectionManager | null = null;
  const textLayer = new TextLayerService(host, bridge, {
    ...viewer.getTextLayerOptions(),
    // 淘汰页/整页重建前开启抑制窗口，避免 DOM 副作用清空快照。
    onDomMutation: () => selection?.suppressSelectionChangeForDomMutation(),
  });
  selection = new SelectionManager(host, bridge, textLayer);
  const find = new FindController(host, bridge, textLayer);

  // 核心只有一个 find 服务槽：查找与选区方法统一在这层对象上转发。
  const service: ViewerFindService = {
    find: (query, options) => find.find(query, options),
    findNext: () => find.findNext(),
    findPrevious: () => find.findPrevious(),
    clearFind: () => find.clearFind(),
    getSelectedText: () => selection.getSelectedText(),
    copySelection: () => selection.copySelection(),
    clearSelection: () => selection.clearSelection(),
  };

  const detachFind = host.attachFindController(service);
  const detachTextLayer = host.attachTextLayerService(textLayer);

  return () => {
    find.destroy();
    selection.destroy();
    textLayer.destroy();
    detachFind();
    detachTextLayer();
  };
}

/**
 * 注册文本模块扩展；供统一入口调用。
 *
 * @param register 核心的扩展注册函数（`registerViewerExtension`）。
 */
export function installTextModule(
  register: (extension: (viewer: OFDViewer) => void | (() => void)) => unknown,
): void {
  register(attachTextModule);
}

// 顶层注册：所有在此之后创建/已存在的阅读器都会自动应用文本模块。
installTextModule(registerViewerExtension);

export { FindController } from './find-controller';
export type { FindControllerOptions } from './find-controller';
export { SelectionManager } from './selection';
export type {
  SelectionFragment,
  SelectionModel,
  SelectionSnapshot,
} from './selection';
export { TextLayerService, createTextSpan } from './text-layer';
export type { TextLayerServiceOptions } from './text-layer';
export { createViewerBridge, textContentOptions } from './viewer-bridge';
export type {
  TextViewerHost,
  ViewerBridge,
  ViewerTextLayerServiceLike,
} from './viewer-bridge';
export {
  MAX_TEXT_LAYER_NODES,
  TEXT_LAYER_DPI,
  buildTextLayerSpecs,
  buildTextRows,
  buildTextRowsFromSpecs,
} from './geometry';
export type {
  BuildTextLayerOptions,
  HighlightBox,
  TextLayerSpecs,
  TextRow,
  TextRowLayout,
  TextSpanSpec,
} from './geometry';
export type { FindHighlightRenderer, FindMatch, SliceScheduler } from './types';
export {
  createPageSearchSource,
  findPageMatches,
  highlightBoxesForRange,
  normalizeQuery,
} from './search';