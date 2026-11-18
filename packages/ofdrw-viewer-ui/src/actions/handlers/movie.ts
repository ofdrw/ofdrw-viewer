/**
 * `Movie` 动作处理器（音视频与动作方案设计 §7.3 / §7.5）。
 *
 * ## 两种呈现（§7.3）
 *
 * - **嵌入式 inline**：`owner.kind === 'object'` 时，在 `.ofd-page__media-layer` 按图元
 *   矩形放 `<video>`（标准 §12：「图元对象关联的视频播放时，宜使用图元外观区域大小作为
 *   嵌入式播放窗口」）。页面 canvas 上本来就会绘制封面帧，播放中 `<video>` 盖住它，
 *   停止/结束后移除 `<video>` 让封面重新可见。
 * - **弹出式 popup**：文档级/页级/大纲级触发时用模态浮层承载（没有图元矩形可依附）。
 *
 * ## 四操作符（标准表 58）
 *
 * | Operator | 行为 |
 * | --- | --- |
 * | `Play` | 无实例则从 0 开始播放；有实例则从当前位置继续 |
 * | `Stop` | 停止、复位到 0，并销毁实例（封面重新可见） |
 * | `Pause` | 暂停并保留播放位置 |
 * | `Resume` | 从暂停处继续 |
 *
 * **实例必须按 `resourceId` 复用**：若 `Play` 每次都重建 `<video>`，`Pause` 后再
 * `Resume` 就只能从头播放。实例表由 `MediaPlayerManager` 持有。
 *
 * ## 不阻塞
 *
 * `Movie` 标准上无 `Synchronous` 属性，立即返回，后续动作继续执行。
 */

import type { ActionInfo, MediaResource } from '@ofdrw/ofdrw-viewer-engine';
import type {
  ActionHandler,
  ActionHandlerResult,
  ActionExecutionContext,
} from '../types';
import type { MediaPlayerHandle, MediaPlayerManager } from './media-player';
import { startPlayback } from './sound';

/** Movie handler 依赖的宿主能力。 */
export interface MovieHandlerHost {
  /** 播放器管理器。 */
  readonly players: MediaPlayerManager;
  /** 按资源 ID 查找媒体资源。 */
  readonly getMediaResource: (
    resourceId: string,
    pageIndex: number | undefined,
  ) => Promise<MediaResource | undefined>;
  /** 读取媒体字节。 */
  readonly readMediaBytes: (
    resource: MediaResource,
    pageIndex: number | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<Uint8Array | undefined>;
  /**
   * 把播放器嵌入页面媒体层。
   *
   * @param handle 播放器句柄。
   * @param context 执行上下文（含图元锚点矩形）。
   * @returns 是否成功嵌入；false 表示应改用弹出式。
   */
  readonly presentInline: (handle: MediaPlayerHandle, context: ActionExecutionContext) => boolean;
  /**
   * 打开弹出式播放器。
   *
   * @param handle 播放器句柄。
   * @param title 标题。
   */
  readonly presentPopup: (handle: MediaPlayerHandle, title: string) => void;
  /**
   * 移除内联播放器并恢复封面帧可见。
   *
   * @param handle 播放器句柄。
   */
  readonly removeInline: (handle: MediaPlayerHandle) => void;
  /** 超限时提示下载原文件。 */
  readonly offerDownload: (resource: MediaResource) => void;
  /** 当前翻译器文案。 */
  readonly t: (key: 'media.video' | 'media.unsupported') => string;
}

/**
 * 创建 `Movie` 动作处理器。
 *
 * @param host 宿主能力。
 * @returns 动作处理器。
 */
export function createMovieHandler(host: MovieHandlerHost): ActionHandler {
  return async (
    context: ActionExecutionContext,
    action: ActionInfo,
  ): Promise<ActionHandlerResult> => {
    if (action.payload.type !== 'movie') {
      return { outcome: 'skipped', skipReason: 'target-missing' };
    }
    const payload = action.payload;
    const pageIndex = context.pageIndex;

    // `Stop` 是纯状态操作：只作用于已存在的实例，不读取资源。
    if (payload.operator === 'Stop') {
      const existing = findLive(host, payload.resourceId);
      if (!existing) {
        // 没有实例即没有正在播放的视频，停止是幂等的空操作。
        return { outcome: 'executed' };
      }
      host.removeInline(existing);
      host.players.destroyPlayer(existing);
      return { outcome: 'executed' };
    }

    // `Pause` 同样只操作实例：无实例时无事可做，按幂等成功处理。
    if (payload.operator === 'Pause') {
      const existing = findLive(host, payload.resourceId);
      if (!existing) return { outcome: 'executed' };
      await ensurePresented(host, existing, context, action);
      existing.element.pause();
      return { outcome: 'executed' };
    }

    const resource = await host.getMediaResource(payload.resourceId, pageIndex);
    if (!resource) return { outcome: 'skipped', skipReason: 'resource-missing' };

    // `Resume`：无实例时退化为 `Play`（从 0 开始播放），有实例时从暂停处继续。
    if (payload.operator === 'Resume') {
      const existing = findLive(host, payload.resourceId);
      if (existing) {
        await ensurePresented(host, existing, context, action);
        const resumed = await startPlayback(existing.element, host.players.muteOnAutoplayBlocked);
        if (resumed === 'blocked') return { outcome: 'skipped', skipReason: 'autoplay-blocked' };
        if (resumed === 'failed') {
          return {
            outcome: 'failed',
            code: 'OFD_MEDIA_UNSUPPORTED',
            errorReason: 'unsupported',
            message: host.t('media.unsupported'),
          };
        }
        return { outcome: 'executed' };
      }
    }

    // `Play`（以及无实例的 `Resume`）：无实例则创建并从 0 开始；有实例则从当前位置继续。
    const existing = findLive(host, payload.resourceId);
    const acquired = existing
      ? { player: existing }
      : await host.players.acquire(resource, pageIndex, (target) =>
          host.readMediaBytes(target, pageIndex, context.signal),
        );
    if ('tooLarge' in acquired && acquired.tooLarge) {
      host.offerDownload(resource);
      return { outcome: 'skipped', skipReason: 'unsupported' };
    }
    if (!acquired.player) {
      const code = 'code' in acquired ? acquired.code : undefined;
      return {
        outcome: 'failed',
        code: code ?? 'OFD_MEDIA_LOAD_FAILED',
        errorReason: code === 'OFD_MEDIA_UNSUPPORTED' ? 'unsupported' : 'load',
        message: host.t('media.unsupported'),
      };
    }
    const handle = acquired.player;
    await ensurePresented(host, handle, context, action);

    const started = await startPlayback(handle.element, host.players.muteOnAutoplayBlocked);
    if (started === 'blocked') return { outcome: 'skipped', skipReason: 'autoplay-blocked' };
    if (started === 'failed') {
      return {
        outcome: 'failed',
        code: 'OFD_MEDIA_UNSUPPORTED',
        errorReason: 'unsupported',
        message: host.t('media.unsupported'),
      };
    }
    // `Movie` 不阻塞：标准无 `Synchronous` 属性，立即返回。
    return { outcome: 'executed' };
  };
}

/**
 * 查找指定资源的存活实例。
 *
 * @param host 宿主能力。
 * @param resourceId 资源 ID。
 * @returns 播放器句柄；不存在时 undefined。
 */
function findLive(host: MovieHandlerHost, resourceId: string): MediaPlayerHandle | undefined {
  return host.players.playersSnapshot.find(
    (player) => player.resourceId === resourceId && !player.destroyed,
  );
}

/**
 * 确保实例的媒体元素呈现在文档中；已脱离文档时重新呈现。
 *
 * 内联播放器可能因页面重建、浮层关闭等原因被移出 DOM，此时对暂停/继续操作会让用户
 * 看不到任何界面，因此先按 `owner.kind` 重新走内联或弹出式呈现。
 *
 * @param host 宿主能力。
 * @param handle 播放器句柄。
 * @param context 执行上下文（含图元锚点）。
 * @param action 触发动作（用于判定呈现模式）。
 */
async function ensurePresented(
  host: MovieHandlerHost,
  handle: MediaPlayerHandle,
  context: ActionExecutionContext,
  action: ActionInfo,
): Promise<void> {
  if (handle.element.isConnected) return;
  // 呈现模式由 `owner.kind` 决定：图元触发走内联，其余走弹出式。
  const inline = action.owner.kind === 'object' ? host.presentInline(handle, context) : false;
  if (!inline) host.presentPopup(handle, host.t('media.video'));
}