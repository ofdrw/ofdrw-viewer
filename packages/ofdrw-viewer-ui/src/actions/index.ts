/**
 * 动作模块入口（UI 动作处理机制设计 §3.1 / §3.2）。
 *
 * 顶层调用 `registerViewerExtension` 注册扩展：每个 `OFDViewer` 实例创建时挂载
 * `ActionService`，不需要核心 import 动作模块。最终入口只需 side-effect import
 * 本文件。
 *
 * **单一入口**：所有动作执行都必须经 `ActionService.execute()`；大纲、书签、图元、
 * 宿主 API 都不得各自调用 `goToDestination` 或直接开始播放。
 *
 * ## 已知限制
 *
 * - **图层隐藏不参与命中**：图元所在图层被隐藏时，其 `CLICK` 动作目前仍参与命中。
 *   engine 的 `ActionInfo` 不携带图层归属（`getPageActionsByEvent` 也不返回），
 *   靠 `PageContentFilter` 反推不可靠；该场景罕见，第一版不处理，详见
 *   docs/UI动作处理机制设计.md §11.1「图层显示控制」一行。
 * - **Region 精度**：只做外接矩形粗判 + even-odd 折线精判（贝塞尔固定 8 段离散），
 *   不做可配置曲线精度（设计 §14 已定决策 6）。
 */

import type {
  ActionEvent,
  ActionGeometryEntry,
  ActionInfo,
  AttachmentInfo,
  BookmarkItem,
  MediaResource,
} from '@ofdrw/ofdrw-viewer-engine';
import { buildAttachmentFilename, triggerAttachmentDownload } from '../attachment-utils';
import { askExternalLinkGrant, getUIShell, type UIShellHost } from '../ui';
import type { NavigationViewer } from '../views/shared';
import type { OFDViewer, ViewerActionService } from '../viewer';
import { registerViewerExtension } from '../viewer';
import type { MessageKey } from '../i18n';
import type { ViewerState } from '../state';
import type { ViewerEventMap, ViewerEventName } from '../types';
import {
  ActionService,
  resolveViewerActionsOptions,
  type ViewerActionsOptions,
} from './action-service';
import type { ActionBridge, ActionViewerHost } from './types';
import { registerActionHandlers } from './handlers';
import { MediaPlayerManager } from './handlers/media-player';
import { MediaPresenter } from './handlers/media-presenter';
import type { MovieHandlerHost } from './handlers/movie';
import type { SoundHandlerHost } from './handlers/sound';
import { ACTION_GEOMETRY_DPI } from './geometry';
import { UI_WARNING_CODES } from '../diagnostics';

/**
 * 单个音视频资源的读取上限，byte（256 MiB）。
 *
 * 与引擎 `ResourceLimits.maxMediaBytes` 默认值一致。超过该值时不读取内容，UI 改为
 * 提示下载原文件（音视频与动作方案设计 §7.4 的两档分级）。
 */
const DEFAULT_MAX_MEDIA_BYTES = 256 * 1024 * 1024;

/** 引擎文档的媒体查询能力；`OFDDocument` 结构兼容。 */
interface MediaDocumentSource {
  getMediaResource?(
    resourceId: string,
    options?: { pageIndex?: number },
  ): Promise<MediaResource | undefined>;
  getMediaData?(
    resourceId: string,
    options?: { pageIndex?: number; signal?: AbortSignal },
  ): Promise<Uint8Array | undefined>;
}

/** 动作模块所需的挂载能力；`OFDViewer` 结构兼容。 */
export interface ActionViewerAttachHost extends ActionViewerHost {
  /** 挂载动作服务。 */
  attachActionService(service: ViewerActionService): () => void;
  /** 更新动作状态（核心内部入口）。 */
  patchActions(patch: Partial<ViewerState['actions']>): void;
  /** 提交状态并派发 `statechange`。 */
  commit?(): void;
  /** 派发事件（核心内部入口）。 */
  emit?<K extends ViewerEventName>(event: K, payload: ViewerEventMap[K]): void;
  /** 上报 warning（核心内部入口）。 */
  warn?(code: string, message: string, pageIndex?: number): void;
}

/** 引擎文档的动作查询能力；`OFDDocument` 结构兼容。 */
interface ActionDocumentSource {
  getDocumentActions?(): readonly ActionInfo[];
  getPageActionsByEvent?(
    pageIndex: number,
    event: ActionEvent,
    options?: { signal?: AbortSignal },
  ): Promise<readonly ActionInfo[]>;
  getPageActionGeometries?(
    pageIndex: number,
    options?: { dpi?: number; signal?: AbortSignal },
  ): Promise<readonly ActionGeometryEntry[]>;
}

/**
 * 把动作服务挂载到阅读器实例。
 *
 * @param viewer 阅读器实例。
 * @param options 动作选项；省略时使用核心解析后的默认值。
 * @returns 清理函数；销毁实例时调用。
 */
export function attachActionModule(viewer: OFDViewer, options?: ViewerActionsOptions): () => void {
  const host = viewer as unknown as ActionViewerAttachHost;
  const bridge = createActionBridge(host);
  // 未显式传入选项时取核心解析后的宿主预设（`ViewerOptions.actions`）。
  const resolved =
    options ??
    (viewer as unknown as { getActionOptions?(): ViewerActionsOptions }).getActionOptions?.();
  /** Goto 是否平滑滚动；由 `actions.smoothGoto` 决定，缺省 true。 */
  const smoothGoto = resolved?.smoothGoto !== false;
  /**
   * 当前文档的附件元信息；`GotoA` 按 `attachId` 在此查找。
   *
   * 文档打开时发起一次读取（不等待），handler 侧 await 同一个 Promise：点击早于读取
   * 完成也不会误判附件不存在。读取失败 resolve 为空数组，不 reject。
   */
  let attachmentPromise: Promise<readonly AttachmentInfo[]> = Promise.resolve([]);
  /**
   * 附件读取的代次；每次文档打开递增。
   *
   * 跨文档时旧读取的回写必须被丢弃，否则 A 文档的结果会覆盖 B 文档的附件清单。
   */
  let attachmentToken = 0;
  /** 读取一次当前文档的附件元信息；失败或能力缺失时返回空数组。 */
  const readAttachments = async (): Promise<readonly AttachmentInfo[]> => {
    const document = host.getDocument() as {
      getAttachments?(): Promise<readonly AttachmentInfo[]>;
    } | null;
    // 引擎文档自身持有附件缓存，直接读取可省掉整个文档信息快照的聚合开销。
    if (typeof document?.getAttachments === 'function') {
      try {
        return (await document.getAttachments()) ?? [];
      } catch {
        return [];
      }
    }
    const info = await host.getDocumentInfo?.();
    return (info as { attachments?: readonly AttachmentInfo[] } | undefined)?.attachments ?? [];
  };
  /**
   * 引擎文档书签的快照；供 `Goto` 按书签名解析，文档关闭时清空。
   *
   * 引擎文档自身持有书签数据，不依赖 `state.document.bookmarks` 的异步同步与
   * `bookmarks` 功能开关。
   */
  let documentBookmarks: readonly BookmarkItem[] = [];
  /** 读取当前文档的附件与书签；两者互不影响，各自失败都只回退为空。 */
  const loadDocumentExtras = (): void => {
    const token = ++attachmentToken;
    attachmentPromise = readAttachments().then((attachments) =>
      token === attachmentToken ? attachments : [],
    );
    void readDocumentBookmarks(host).then((bookmarks) => {
      if (token === attachmentToken) documentBookmarks = bookmarks;
    });
  };
  const service = new ActionService({
    host,
    bridge,
    options: resolveViewerActionsOptions(resolved),
    loadPageActions: async (pageIndex, event, signal) => {
      const document = host.getDocument() as ActionDocumentSource | null;
      if (typeof document?.getPageActionsByEvent !== 'function') return [];
      return document.getPageActionsByEvent(pageIndex, event, { signal });
    },
    // 几何全部由 engine 换算（96 DPI、未旋转页面像素），UI 不做 mm → px。
    loadPageGeometries: async (pageIndex, signal) => {
      const document = host.getDocument() as ActionDocumentSource | null;
      if (typeof document?.getPageActionGeometries !== 'function') return [];
      return document.getPageActionGeometries(pageIndex, { dpi: ACTION_GEOMETRY_DPI, signal });
    },
  });

  // 媒体层：播放器实例按 resourceId 复用（Pause/Resume 的前提），ObjectURL 由其统一释放。
  const players = new MediaPlayerManager({
    ownerDocument: host.getRoot().ownerDocument,
    // 单资源读取上限取引擎默认 256 MiB；引擎侧读取前还会按同一上限再预检一次。
    maxMediaBytes: DEFAULT_MAX_MEDIA_BYTES,
    masterVolume: 1,
    muteOnAutoplayBlocked: true,
    onEvent: (event, payload) => {
      // 播放状态变化映射为 ViewerEvent（`media:*`）。
      const eventName = `media:${event}` as const;
      if (event === 'error') {
        // 播放失败同时进事件与诊断通道：事件给宿主程序，warning 给排查日志。
        host.warn?.(
          UI_WARNING_CODES.W_MEDIA_PLAY,
          `媒体播放失败：${payload.resourceId}（${String(payload.code)}）`,
          payload.pageIndex,
        );
        host.emit?.('media:error', {
          resourceId: payload.resourceId,
          kind: payload.kind,
          ...(payload.pageIndex === undefined ? {} : { pageIndex: payload.pageIndex }),
          code: mapMediaErrorCode(payload.code),
        });
        return;
      }
      host.emit?.(eventName, {
        resourceId: payload.resourceId,
        kind: payload.kind,
        ...(payload.pageIndex === undefined ? {} : { pageIndex: payload.pageIndex }),
      });
    },
    onActivePlayersChange: (count) => service.setActivePlayers(count),
  });

  const presenter = new MediaPresenter({
    root: host.getRoot(),
    // 惰性获取并回退根节点：actions 扩展注册可能早于 UI shell 挂载。
    // 根节点 `.ofd-viewer` 是 `position: relative`，浮层的绝对定位与百分比尺寸都以它为参照。
    getDialogLayer: () => {
      const layer = host.getElements().dialogLayer;
      return layer && layer.isConnected ? layer : host.getRoot();
    },
    getPageView: (pageNumber) => host.getPageView(pageNumber),
    getTranslator: () => host.getTranslator(),
    getOrigin: () => host.getState().document.origin,
    ...(host.readSourceBytes ? { readSourceBytes: () => host.readSourceBytes!() } : {}),
    downloadWholeOfd: (bytes, filename) => {
      triggerAttachmentDownload(
        host.getRoot().ownerDocument,
        new Blob([bytes as unknown as BlobPart], { type: 'application/ofd' }),
        filename,
      );
    },
    // 内联播放器的关闭按钮：停止并销毁该实例，让封面帧重新可见。
    onInlineClose: (handle) => {
      players.destroyByResource(handle.resourceId);
    },
    // 弹出式浮层被替换：旧句柄必须销毁，否则其媒体元素脱离文档后继续出声。
    onPopupClose: (handle) => {
      players.destroyPlayer(handle);
    },
  });

  // 自动执行开关的初值来自宿主选项；用户在「关于」里修改时走 setAutoExecute。
  const detach = host.attachActionService({
    executeActions: (pageIndex, event, execOptions) =>
      service.executeActions(pageIndex, event, execOptions),
    runActions: (actions, context) => service.runActions(actions, context),
    hitTestAt: (clientX, clientY) => service.hitTestAt(clientX, clientY),
    setAutoExecute: (enabled) => service.setAutoExecute(enabled),
    get autoExecute() {
      return service.autoExecute;
    },
    get allowUserToggle() {
      return service.allowUserToggle;
    },
    releasePage: (pageNumber) => {
      // 页缓存淘汰：先销毁该页播放器（内含 pause → 断流 → revokeObjectURL），
      // 再删除页动作集合；顺序反了会让已卸载的播放器短暂继续出声。
      players.destroyByPage(pageNumber - 1);
      service.releasePage(pageNumber);
    },
    destroy: () => service.destroy(),
  });
  service.start();
  const offDocumentOpen = host.on('documentopen', () => loadDocumentExtras());
  const offDocumentClose = host.on('documentclose', () => {
    // 代次递增后，进行中的旧读取回写一律丢弃。
    attachmentToken += 1;
    attachmentPromise = Promise.resolve([]);
    documentBookmarks = [];
    // 文档关闭：关闭浮层、销毁全部播放器并撤销 ObjectURL，避免后台继续播放。
    presenter.destroy();
    players.destroyAll();
  });
  /** 取媒体资源；缺失时返回 undefined（handler 转 skipped），并上报诊断。 */
  const getMediaResource = async (resourceId: string, pageIndex: number | undefined) => {
    const document = host.getDocument() as MediaDocumentSource | null;
    if (typeof document?.getMediaResource !== 'function') return undefined;
    try {
      const resource = await document.getMediaResource(
        resourceId,
        pageIndex === undefined ? {} : { pageIndex },
      );
      if (!resource) {
        host.warn?.(
          UI_WARNING_CODES.W_MEDIA_RESOURCE,
          `媒体资源不存在：${resourceId}`,
          pageIndex,
        );
      }
      return resource;
    } catch (error) {
      host.warn?.(
        UI_WARNING_CODES.W_MEDIA_RESOURCE,
        `媒体资源查询失败：${resourceId}（${error instanceof Error ? error.message : String(error)}）`,
        pageIndex,
      );
      return undefined;
    }
  };

  /** 读取媒体字节；超限由引擎抛 OFD_LIMIT_EXCEEDED，这里转成 undefined 交由分级处理。 */
  const readMediaBytes = async (
    resource: MediaResource,
    pageIndex: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | undefined> => {
    const document = host.getDocument() as MediaDocumentSource | null;
    if (typeof document?.getMediaData !== 'function') return undefined;
    try {
      return await document.getMediaData(resource.id, {
        ...(pageIndex === undefined ? {} : { pageIndex }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      host.warn?.(
        UI_WARNING_CODES.W_MEDIA_RESOURCE,
        `媒体数据读取失败：${resource.id}（${error instanceof Error ? error.message : String(error)}）`,
        pageIndex,
      );
      return undefined;
    }
  };

  const translator = host.getTranslator();
  const mediaSoundHost: SoundHandlerHost = {
    players,
    getMediaResource,
    readMediaBytes,
    presentPopup: (handle, title) => presenter.presentPopup(handle, title),
    reportPresentError: (error) => {
      // 呈现层异常不应吞掉：走 warning 通道便于宿主与用户发现问题。
      host.warn?.(
        UI_WARNING_CODES.W_MEDIA_PLAY,
        `音频播放器浮层创建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    },
    offerDownload: (resource) => void presenter.offerDownload(resource),
    t: (key) => translator.t(key),
  };
  const mediaMovieHost: MovieHandlerHost = {
    players,
    getMediaResource,
    readMediaBytes,
    presentInline: (handle, context) => presenter.presentInline(handle, context),
    presentPopup: (handle, title) => presenter.presentPopup(handle, title),
    removeInline: (handle) => presenter.removeInline(handle),
    offerDownload: (resource) => void presenter.offerDownload(resource),
    t: (key) => translator.t(key),
  };

  // 五种动作 handler：Goto / URI / GotoA / Sound / Movie 全部接通。
  registerActionHandlers({
    executor: service.executor,
    goto: {
      navigationViewer: host as unknown as NavigationViewer,
      getBookmarks: () => host.getState().document.bookmarks ?? [],
      getDocumentBookmarks: () => documentBookmarks,
      smoothGoto: () => smoothGoto,
    },
    uri: {
      confirm: (request) => requestExternalLinkGrant(host, request),
      getBaseUrl: () => resolveDocumentBaseUrl(host),
    },
    gotoAttachment: {
      getAttachments: () => attachmentPromise,
      getDocument: () => host.getDocument(),
      download: (bytes, filename, mimeType) => {
        triggerAttachmentDownload(
          host.getRoot().ownerDocument,
          new Blob([bytes as unknown as BlobPart], { type: mimeType }),
          filename,
        );
      },
      buildFilename: (attachment) => buildAttachmentFilename(attachment),
    },
    sound: mediaSoundHost,
    movie: mediaMovieHost,
  });

  return () => {
    offDocumentOpen();
    offDocumentClose();
    // 先关浮层再销毁播放器：浮层里的元素需要先归还，避免残留 DOM 引用。
    presenter.destroy();
    players.destroyAll();
    service.destroy();
    detach();
  };
}

/**
 * 解析当前文档的基地址；用于 `URI` 动作的相对地址解析。
 *
 * 优先级：URL 来源的地址 → 页面地址。内存字节（`Blob`/`ArrayBuffer`）打开时没有
 * 可比较的文档地址，返回页面地址兜底，相对链接仍能按当前站点解析。
 *
 * @param host 阅读器宿主。
 * @returns 基地址；无可解析地址时 undefined。
 */
function resolveDocumentBaseUrl(host: ActionViewerAttachHost): string | undefined {
  const origin = host.getState().document.origin;
  if (origin?.kind === 'url') return origin.url;
  if (typeof location !== 'undefined') return location.href;
  return undefined;
}

/**
 * 把媒体错误码映射为 `ViewerEvent['media:error'].code` 的分类。
 *
 * @param code 引擎/播放器错误码。
 * @returns 失败分类：浏览器不支持为 `unsupported`，解码失败为 `decode`，其余为 `load`。
 */
function mapMediaErrorCode(code: string | undefined): 'unsupported' | 'decode' | 'load' {
  if (code === 'OFD_MEDIA_UNSUPPORTED') return 'unsupported';
  if (code === 'OFD_MEDIA_DECODE_FAILED') return 'decode';
  return 'load';
}

/**
 * 读取当前文档的书签，供 `Goto` 按书签名解析跳转目标（设计 §8.2）。
 *
 * 优先取引擎文档自身的书签：打开阶段已解析，不受 `bookmarks` 功能开关门控，也不必
 * 等待 `state.document.bookmarks` 的异步同步；引擎不支持或读取失败时回退到状态快照。
 *
 * @param host 阅读器宿主。
 * @returns 书签列表，保持 XML 顺序；不可用时为空数组。
 */
async function readDocumentBookmarks(
  host: ActionViewerAttachHost,
): Promise<readonly BookmarkItem[]> {
  const document = host.getDocument() as {
    getBookmarks?(): Promise<readonly BookmarkItem[]>;
  } | null;
  if (typeof document?.getBookmarks === 'function') {
    try {
      return (await document.getBookmarks()) ?? [];
    } catch {
      // 引擎读取失败时回退到状态快照，书签名解析仍可能成功。
    }
  }
  return host.getState().document.bookmarks ?? [];
}

/**
 * 弹出外部链接确认框；复用内置 UI 的 `alertdialog`。
 *
 * @param host 阅读器宿主。
 * @param request 确认请求。
 * @returns 用户确认时 true；未挂载内置 UI 时按取消处理。
 */
function requestExternalLinkGrant(
  host: ActionViewerAttachHost,
  request: { readonly url: string; readonly host: string; readonly target: '_self' | '_blank' },
): Promise<boolean> {
  return askExternalLinkGrant(getUIShell(host as unknown as UIShellHost), request);
}

/**
 * 创建动作模块与核心之间的桥接。
 *
 * 核心的 `patchActions`/`commit`/`emit`/`warn` 是内部入口；缺失时（测试替身或未来
 * 公开接口替换）降级为空操作，模块仍可本地运行。
 *
 * @param host 阅读器宿主。
 * @returns 桥接对象。
 */
function createActionBridge(host: ActionViewerAttachHost): ActionBridge {
  const translator = host.getTranslator();
  return {
    patchActions(patch) {
      host.patchActions(patch);
    },
    commit() {
      host.commit?.();
    },
    emit(event, payload) {
      host.emit?.(event, payload);
    },
    warn(code, message, pageIndex) {
      if (pageIndex === undefined) host.warn?.(code, message);
      else host.warn?.(code, message, pageIndex);
    },
    t: (key: MessageKey, vars) => translator.t(key, vars),
  };
}

/**
 * 注册动作模块扩展；供统一入口调用。
 *
 * @param register 核心的扩展注册函数（`registerViewerExtension`）。
 * @param options 动作选项。
 */
export function installActionModule(
  register: (extension: (viewer: OFDViewer) => void | (() => void)) => unknown,
  options?: ViewerActionsOptions,
): void {
  register((viewer) => attachActionModule(viewer, options));
}

// 顶层注册：所有在此之后创建/已存在的阅读器都会自动应用动作模块。
installActionModule(registerViewerExtension);

export { ActionService, resolveViewerActionsOptions } from './action-service';
export type { ResolvedViewerActionsOptions, ViewerActionsOptions } from './action-service';
export { ActionExecutor, DEFAULT_MAX_ACTION_DEPTH } from './action-executor';
export type { ActionExecutorOptions, ExecuteActionsOptions } from './action-executor';
export { PointerRouter, DRAG_THRESHOLD_PX } from './pointer-router';
export { createClickTable, hitTestTable, hitTestItem, isPointInBox } from './click-table';
export { ACTION_GEOMETRY_DPI, toActionBox } from './geometry';
export type {
  ActionAnchor,
  ActionBox,
  ActionHandler,
  ActionHandlerResult,
  ActionOutcome,
  ActionPoint,
  ActionTrigger,
  ClickHitItem,
  ClickHitTable,
  PageActionSet,
} from './types';