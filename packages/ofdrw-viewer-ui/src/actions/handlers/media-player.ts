/**
 * 媒体播放器实例管理（音视频与动作方案设计 §7.3 / §7.4 / §7.7 / §10.2）。
 *
 * 核心职责：
 * - **按 `resourceId` 复用实例**：`Movie@Operator` 的 `Pause`/`Resume` 依赖同一实例，
 *   每次播放都新建 `<video>` 会让暂停位置丢失；
 * - **两档分级**（§7.4）：声明大小 ≤ `maxMediaBytes` 时整块读取 → `Blob` →
 *   `ObjectURL` → 播放；超限则不读内容，提示下载原文件；
 * - **ObjectURL 生命周期**：每个资源一份，销毁时先 `pause()` + `removeAttribute('src')`
 *   + `load()` 再 `revokeObjectURL`（Safari 需要先断流再撤销，否则会中断进行中的请求）；
 * - **浏览器限制**（§7.7）：`playsInline`、autoplay 被拦截时静音重试、`MEDIA_ERR_*`
 *   映射为 `OFD_MEDIA_UNSUPPORTED`。
 *
 * **不做流式播放**：不使用 `MediaSource`、不做 codec 嗅探与分片判定（方案已明确删除）。
 */

import type { MediaResource } from '@ofdrw/ofdrw-viewer-engine';

/** 单个播放器实例。 */
export interface MediaPlayerHandle {
  /** 媒体资源 ID。 */
  readonly resourceId: string;
  /** 媒体类型。 */
  readonly kind: 'audio' | 'video';
  /** 承载元素（`<video>` 或 `<audio>`）。 */
  readonly element: HTMLMediaElement;
  /** 创建时的 ObjectURL；用于释放。 */
  readonly objectUrl: string;
  /** 所在页索引（0-based）；无页上下文（弹出式）时省略。 */
  readonly pageIndex?: number;
  /** 是否已随停止/结束销毁。 */
  destroyed: boolean;
}

/** 播放器管理器选项。 */
export interface MediaPlayerManagerOptions {
  /** 宿主文档；用于创建元素。 */
  readonly ownerDocument: Document;
  /** 单资源读取上限，单位 byte；超过则不读取内容。 */
  readonly maxMediaBytes: number;
  /** 主音量 0..1；与动作 `Volume` 相乘。 */
  readonly masterVolume: number;
  /** 自动播放被拦截时是否静音重试；默认 true。 */
  readonly muteOnAutoplayBlocked: boolean;
  /**
   * 事件回调。
   *
   * @param event 事件名。
   * @param payload 载荷。
   */
  readonly onEvent?: (
    event:
      | 'play'
      | 'pause'
      | 'ended'
      | 'stop'
      | 'error',
    payload: { resourceId: string; kind: 'audio' | 'video'; pageIndex?: number; code?: string },
  ) => void;
  /** 活动播放器数量变化。 */
  readonly onActivePlayersChange?: (count: number) => void;
}

/** 播放器销毁选项。 */
export interface DestroyOptions {
  /**
   * 是否派发 `stop` 事件；默认 true。
   *
   * 由动作或用户主动停止时为 true；文档关闭等批量销毁时传 false。
   */
  readonly emitStop?: boolean;
}

/** 播放结果。 */
export interface MediaPlayResult {
  /** 播放器句柄；失败或超限时省略。 */
  readonly player?: MediaPlayerHandle;
  /** 是否因超限而未读取内容。 */
  readonly tooLarge?: boolean;
  /** 失败码；`outcome` 失败时出现。 */
  readonly code?: string;
  /** 诊断信息。 */
  readonly message?: string;
}

/** 媒体播放器管理器。 */
export class MediaPlayerManager {
  private readonly options: MediaPlayerManagerOptions;
  /** 按资源 ID 复用的播放器实例。 */
  private readonly players = new Map<string, MediaPlayerHandle>();
  /** 资源 ID → 进行中的创建任务，避免并发重复读取字节。 */
  private readonly creating = new Map<string, Promise<MediaPlayResult>>();
  /** 已释放的 ObjectURL，防止重复 revoke。 */
  private readonly released = new Set<string>();

  /**
   * @param options 管理器选项。
   */
  constructor(options: MediaPlayerManagerOptions) {
    this.options = options;
  }

  /** 当前活动播放器数量。 */
  get activeCount(): number {
    let count = 0;
    for (const player of this.players.values()) {
      if (!player.destroyed && !player.element.paused) count += 1;
    }
    return count;
  }

  /** 全部播放器（含已暂停）。 */
  get playersSnapshot(): readonly MediaPlayerHandle[] {
    return [...this.players.values()];
  }

  /**
   * 取得（必要时创建）指定资源的播放器实例。
   *
   * 已存在实例时直接复用——这是 `Pause`/`Resume` 成立的前提。
   *
   * @param resource 媒体资源。
   * @param pageIndex 来源页索引；无页上下文时省略。
   * @param readBytes 读取原始字节；超限时不会被调用。
   * @returns 播放结果。
   */
  async acquire(
    resource: MediaResource,
    pageIndex: number | undefined,
    readBytes: (resource: MediaResource) => Promise<Uint8Array | undefined>,
  ): Promise<MediaPlayResult> {
    const existing = this.players.get(resource.id);
    if (existing && !existing.destroyed) return { player: existing };

    const inflight = this.creating.get(resource.id);
    if (inflight) return inflight;

    const task = this.createPlayer(resource, pageIndex, readBytes);
    this.creating.set(resource.id, task);
    try {
      return await task;
    } finally {
      this.creating.delete(resource.id);
    }
  }

  /**
   * 创建播放器实例。
   *
   * @param resource 媒体资源。
   * @param pageIndex 来源页索引。
   * @param readBytes 字节读取函数。
   * @returns 播放结果。
   */
  private async createPlayer(
    resource: MediaResource,
    pageIndex: number | undefined,
    readBytes: (resource: MediaResource) => Promise<Uint8Array | undefined>,
  ): Promise<MediaPlayResult> {
    // 第一档判定：声明大小超过上限时**不读取内容**，直接转下载提示。
    const size = resource.sizeBytes;
    if (size !== undefined && size > this.options.maxMediaBytes) {
      return { tooLarge: true };
    }
    const bytes = await readBytes(resource);
    if (!bytes || bytes.byteLength === 0) {
      return { code: 'OFD_MEDIA_LOAD_FAILED', message: '媒体资源为空或读取失败' };
    }
    // 读取后再判一次：声明大小可能缺失或不准。
    if (bytes.byteLength > this.options.maxMediaBytes) {
      return { tooLarge: true };
    }

    const blob = new Blob([bytes as unknown as BlobPart], { type: resource.mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const element = this.createElement(resource);
    element.src = objectUrl;

    const handle: MediaPlayerHandle = {
      resourceId: resource.id,
      kind: resource.kind,
      element,
      objectUrl,
      ...(pageIndex === undefined ? {} : { pageIndex }),
      destroyed: false,
    };
    this.players.set(resource.id, handle);
    this.bindEvents(handle);
    return { player: handle };
  }

  /**
   * 创建媒体元素。
   *
   * `playsInline` 保证 iOS Safari 不强制全屏接管；`preload: 'auto'` 让整块 Blob
   * 立即可用。
   *
   * @param resource 媒体资源。
   * @returns 媒体元素。
   */
  private createElement(resource: MediaResource): HTMLMediaElement {
    const element = this.options.ownerDocument.createElement(
      resource.kind === 'video' ? 'video' : 'audio',
    ) as HTMLMediaElement;
    element.className = resource.kind === 'video' ? 'ofd-media ofd-media--video' : 'ofd-media ofd-media--audio';
    element.setAttribute('data-ofd-media', resource.id);
    element.setAttribute('data-ofd-media-kind', resource.kind);
    element.controls = true;
    element.preload = 'auto';
    // iOS Safari：不设 playsInline 会被全屏接管，离开阅读器布局（仅 video 有此属性）。
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    element.setAttribute('playsinline', '');
    element.setAttribute('webkit-playsinline', '');
    return element;
  }

  /**
   * 绑定播放状态事件。
   *
   * @param handle 播放器句柄。
   */
  private bindEvents(handle: MediaPlayerHandle): void {
    const { element } = handle;
    const emit = (event: 'play' | 'pause' | 'ended' | 'stop' | 'error', code?: string): void => {
      this.options.onEvent?.(event, {
        resourceId: handle.resourceId,
        kind: handle.kind,
        ...(handle.pageIndex === undefined ? {} : { pageIndex: handle.pageIndex }),
        ...(code ? { code } : {}),
      });
      this.options.onActivePlayersChange?.(this.activeCount);
    };
    element.addEventListener('play', () => emit('play'));
    element.addEventListener('pause', () => {
      // 停止会先触发 pause；此时不重复上报 pause。
      if (handle.destroyed) return;
      emit('pause');
    });
    element.addEventListener('ended', () => emit('ended'));
    element.addEventListener('error', () => {
      emit('error', mapMediaError(element.error));
    });
  }

  /**
   * 释放单个播放器：先断流再撤销 ObjectURL（Safari 兼容）。
   *
   * @param handle 播放器句柄。
   * @param options `emitStop` 为 true 时派发 `stop`（表示由动作或用户主动停止）；
   *   文档关闭等批量销毁场景传 false，默认 true。
   */
  destroyPlayer(handle: MediaPlayerHandle, options: DestroyOptions = {}): void {
    if (handle.destroyed) return;
    handle.destroyed = true;
    const { element } = handle;
    try {
      element.pause();
    } catch {
      // 元素已脱离文档或浏览器拒绝暂停，不影响后续释放。
    }
    if (options.emitStop !== false) {
      // `pause` 监听在 handle 标记销毁后不再上报，这里补发 `stop` 作为用户可见的停止信号。
      this.options.onEvent?.('stop', {
        resourceId: handle.resourceId,
        kind: handle.kind,
        ...(handle.pageIndex === undefined ? {} : { pageIndex: handle.pageIndex }),
      });
    }
    // 先移除 src 并 load() 断开正在进行的请求，再 revoke：
    // Safari 对仍有请求的 ObjectURL 直接 revoke 会中断播放并可能泄漏。
    element.removeAttribute('src');
    try {
      element.load();
    } catch {
      // 某些环境不支持 load()，忽略。
    }
    element.remove();
    if (this.players.get(handle.resourceId) === handle) {
      this.players.delete(handle.resourceId);
    }
    this.revokeObjectUrl(handle.objectUrl);
    this.options.onActivePlayersChange?.(this.activeCount);
  }

  /**
   * 销毁指定资源 ID 的播放器。
   *
   * @param resourceId 资源 ID。
   * @param options 销毁选项；默认派发 `stop`。
   * @returns 是否销毁了实例。
   */
  destroyByResource(resourceId: string, options: DestroyOptions = {}): boolean {
    const handle = this.players.get(resourceId);
    if (!handle) return false;
    this.destroyPlayer(handle, options);
    return true;
  }

  /**
   * 销毁某一页的全部播放器；页缓存淘汰时调用。
   *
   * @param pageIndex 页索引，0-based。
   * @param options 销毁选项；默认派发 `stop`。
   */
  destroyByPage(pageIndex: number, options: DestroyOptions = {}): void {
    for (const handle of [...this.players.values()]) {
      if (handle.pageIndex === pageIndex) this.destroyPlayer(handle, options);
    }
  }

  /**
   * 销毁全部播放器；文档关闭或组件销毁时调用。
   *
   * 批量销毁默认静默：文档关闭时逐条派发 `stop` 只会产生噪声，宿主关心的是
   * `documentclose` 本身。
   *
   * @param options 销毁选项；省略时不派发 `stop`。
   */
  destroyAll(options: DestroyOptions = { emitStop: false }): void {
    for (const handle of [...this.players.values()]) this.destroyPlayer(handle, options);
    this.players.clear();
    this.creating.clear();
  }

  /**
   * 撤销 ObjectURL；同一 URL 只撤销一次。
   *
   * @param url ObjectURL。
   */
  private revokeObjectUrl(url: string): void {
    if (this.released.has(url)) return;
    this.released.add(url);
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 已在别处撤销或环境不支持，忽略。
    }
  }

  /**
   * 计算元素音量：动作 `Volume`（0..100）与主音量相乘。
   *
   * @param volume 动作声明的音量，0..100。
   * @returns 0..1 的元素音量。
   */
  resolveVolume(volume: number): number {
    const actionVolume = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) / 100 : 1;
    const master = Number.isFinite(this.options.masterVolume)
      ? Math.min(1, Math.max(0, this.options.masterVolume))
      : 1;
    return actionVolume * master;
  }

  /** 是否允许 autoplay 被拦截时静音重试。 */
  get muteOnAutoplayBlocked(): boolean {
    return this.options.muteOnAutoplayBlocked;
  }
}

/**
 * 把 `MediaError.code` 映射为稳定错误码。
 *
 * @param error 媒体错误；元素尚未产生错误时可为 null。
 * @returns 错误码。
 */
export function mapMediaError(error: MediaError | null): string {
  if (!error) return 'OFD_MEDIA_LOAD_FAILED';
  switch (error.code) {
    case 3:
      // MEDIA_ERR_DECODE：能识别格式但解码失败。
      return 'OFD_MEDIA_DECODE_FAILED';
    case 4:
      // MEDIA_ERR_SRC_NOT_SUPPORTED：浏览器不支持该容器/编码。
      return 'OFD_MEDIA_UNSUPPORTED';
    default:
      return 'OFD_MEDIA_LOAD_FAILED';
  }
}

/**
 * 判断播放失败是否属于「自动播放被拦截」。
 *
 * 浏览器在无用户手势的有声自动播放时以 `NotAllowedError` 拒绝 `play()`。
 *
 * @param error `play()` 抛出的错误。
 * @returns 被策略拦截时 true。
 */
export function isAutoplayBlocked(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'NotAllowedError'
  );
}