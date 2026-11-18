/**
 * `Sound` 动作处理器（音视频与动作方案设计 §7.3 / §7.4 / §7.5）。
 *
 * 音频没有可视内容，一律用**弹出式**播放器（`<audio>` 自带控件或浮层控制条），
 * 不进入页面媒体层。
 *
 * 属性语义（标准表 57）：
 * - `Volume`（0..100）→ `element.volume`，与主音量 `masterVolume` 相乘；
 * - `Repeat` → `element.loop`，循环播放；
 * - `Synchronous` → 阻塞后续动作直到播放结束；**`Repeat=true` 时该字段无效**
 *   （标准显式规定，否则循环播放会永久阻塞动作队列）。
 *
 * 两档分级与 ObjectURL 生命周期由 {@link MediaPlayerManager} 统一负责。
 */

import type { ActionInfo, MediaResource } from '@ofdrw/ofdrw-viewer-engine';
import type {
  ActionHandler,
  ActionHandlerResult,
  ActionExecutionContext,
} from '../types';
import { isAutoplayBlocked, type MediaPlayerHandle, type MediaPlayerManager } from './media-player';

/** Sound handler 依赖的宿主能力。 */
export interface SoundHandlerHost {
  /** 播放器管理器。 */
  readonly players: MediaPlayerManager;
  /**
   * 按资源 ID 查找媒体资源；`pageIndex` 用于页级资源作用域解析。
   *
   * @param resourceId 资源 ID。
   * @param pageIndex 来源页索引，0-based。
   */
  readonly getMediaResource: (
    resourceId: string,
    pageIndex: number | undefined,
  ) => Promise<MediaResource | undefined>;
  /**
   * 读取媒体字节；超限时由调用方提前拦截，不会被调用。
   *
   * @param resource 媒体资源。
   * @param pageIndex 来源页索引。
   * @param signal 取消信号。
   */
  readonly readMediaBytes: (
    resource: MediaResource,
    pageIndex: number | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<Uint8Array | undefined>;
  /**
   * 打开弹出式播放器承载音频元素。
   *
   * @param handle 播放器句柄。
   * @param title 播放器标题。
   */
  readonly presentPopup: (handle: MediaPlayerHandle, title: string) => void;
  /**
   * 上报呈现失败。
   *
   * 呈现层异常不应中断播放，但需要可观测，避免"声音在响却没有任何界面"。
   *
   * @param error 捕获到的异常。
   */
  readonly reportPresentError?: (error: unknown) => void;
  /** 超限时提示用户下载原文件。 */
  readonly offerDownload: (resource: MediaResource) => void;
  /** 当前翻译器文案。 */
  readonly t: (key: 'media.audio' | 'media.unsupported' | 'media.autoplayBlocked') => string;
}

/**
 * 创建 `Sound` 动作处理器。
 *
 * @param host 宿主能力。
 * @returns 动作处理器。
 */
export function createSoundHandler(host: SoundHandlerHost): ActionHandler {
  return async (
    context: ActionExecutionContext,
    action: ActionInfo,
  ): Promise<ActionHandlerResult> => {
    if (action.payload.type !== 'sound') {
      return { outcome: 'skipped', skipReason: 'target-missing' };
    }
    const payload = action.payload;
    const pageIndex = context.pageIndex;

    const resource = await host.getMediaResource(payload.resourceId, pageIndex);
    if (!resource) return { outcome: 'skipped', skipReason: 'resource-missing' };

    const play = await host.players.acquire(resource, pageIndex, (target) =>
      host.readMediaBytes(target, pageIndex, context.signal),
    );
    if (play.tooLarge) {
      // 超限：不读内容，改为提示下载原文件（与附件大文件降级同款）。
      host.offerDownload(resource);
      return { outcome: 'skipped', skipReason: 'unsupported' };
    }
    if (!play.player) {
      return {
        outcome: 'failed',
        code: play.code ?? 'OFD_MEDIA_LOAD_FAILED',
        errorReason: play.code === 'OFD_MEDIA_UNSUPPORTED' ? 'unsupported' : 'load',
        ...(play.message ? { message: play.message } : {}),
      };
    }

    const handle = play.player;
    const { element } = handle;
    // 音频属性：音量与循环。
    element.volume = host.players.resolveVolume(payload.volume);
    element.loop = payload.repeat === true;

    // 弹出式呈现：音频不可见，需要浮层承载控件。
    // 呈现失败不得阻止播放（用户已点击，静默不播更难排查）；失败时仅上报。
    try {
      host.presentPopup(handle, host.t('media.audio'));
    } catch (error) {
      host.reportPresentError?.(error);
    }

    const started = await startPlayback(element, host.players.muteOnAutoplayBlocked);
    if (started === 'blocked') {
      return { outcome: 'skipped', skipReason: 'autoplay-blocked' };
    }
    if (started === 'failed') {
      return {
        outcome: 'failed',
        code: 'OFD_MEDIA_UNSUPPORTED',
        errorReason: 'unsupported',
        message: host.t('media.unsupported'),
      };
    }

    // `Synchronous` 仅在非循环时生效（标准显式规定）。
    if (payload.synchronous && !payload.repeat) {
      return { outcome: 'executed', waitForEnd: waitForMediaEnd(element) };
    }
    return { outcome: 'executed' };
  };
}

/**
 * 启动播放，处理自动播放被拦截的情况。
 *
 * 浏览器禁止无用户手势的有声自动播放；被 `NotAllowedError` 拒绝时，若允许静音重试，
 * 则置 `muted=true` 再试一次（播放器上提供「取消静音」入口）。
 *
 * @param element 媒体元素。
 * @param muteOnBlocked 是否静音重试。
 * @returns 播放结果。
 */
export async function startPlayback(
  element: HTMLMediaElement,
  muteOnBlocked: boolean,
): Promise<'playing' | 'blocked' | 'failed'> {
  try {
    await element.play();
    return 'playing';
  } catch (error) {
    if (!isAutoplayBlocked(error)) {
      return element.error ? 'failed' : 'blocked';
    }
    if (!muteOnBlocked) return 'blocked';
    try {
      // 静音后重试：静音播放不受 autoplay 策略限制。
      element.muted = true;
      await element.play();
      return 'playing';
    } catch {
      return 'blocked';
    }
  }
}

/**
 * 等待媒体播放结束（含用户停止）。
 *
 * `ended` 或 `pause`（用户主动停止）都视为"结束"，避免 `Synchronous` 动作永久挂起。
 *
 * @param element 媒体元素。
 * @returns 播放结束时 resolve。
 */
export function waitForMediaEnd(element: HTMLMediaElement): Promise<void> {
  return new Promise<void>((resolve) => {
    if (element.ended || element.paused) {
      resolve();
      return;
    }
    const finish = (): void => {
      element.removeEventListener('ended', finish);
      element.removeEventListener('pause', finish);
      resolve();
    };
    element.addEventListener('ended', finish, { once: true });
    // `pause` 也要解除阻塞：用户手动停止或页面关闭时不能永久挂起动作队列。
    element.addEventListener('pause', finish, { once: true });
  });
}