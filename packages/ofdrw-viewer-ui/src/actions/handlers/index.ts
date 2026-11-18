/**
 * 动作 handler 注册（UI 动作处理机制设计 §8）。
 *
 * 五种动作各有一个 handler；本文件负责把它们注册到 `ActionExecutor`：
 * - `Goto` / `URI` / `GotoA`：P5；
 * - `Sound` / `Movie`：P6（依赖媒体层与两档分级）。
 *
 * 未注册的类型由执行器按 `skipped` 处理并上报，不会让页面渲染失败。
 */

import type { ActionExecutor } from '../action-executor';
import { createGotoHandler, type GotoHandlerHost } from './goto';
import { createUriHandler, type UriHandlerHost } from './uri';
import { createGotoAttachmentHandler, type GotoAttachmentHandlerHost } from './goto-attachment';
import { createSoundHandler, type SoundHandlerHost } from './sound';
import { createMovieHandler, type MovieHandlerHost } from './movie';

/** handler 注册选项。 */
export interface ActionHandlersOptions {
  /** 执行器。 */
  readonly executor: ActionExecutor;
  /** `Goto` 宿主能力。 */
  readonly goto: GotoHandlerHost;
  /** `URI` 宿主能力。 */
  readonly uri: UriHandlerHost;
  /** `GotoA` 宿主能力。 */
  readonly gotoAttachment: GotoAttachmentHandlerHost;
  /** `Sound` 宿主能力；省略时不注册该 handler。 */
  readonly sound?: SoundHandlerHost;
  /** `Movie` 宿主能力；省略时不注册该 handler。 */
  readonly movie?: MovieHandlerHost;
}

/**
 * 把五种动作 handler 注册到执行器。
 *
 * @param options 注册选项。
 */
export function registerActionHandlers(options: ActionHandlersOptions): void {
  const { executor } = options;
  executor.register('goto', createGotoHandler(options.goto));
  executor.register('uri', createUriHandler(options.uri));
  executor.register('gotoa', createGotoAttachmentHandler(options.gotoAttachment));
  if (options.sound) executor.register('sound', createSoundHandler(options.sound));
  if (options.movie) executor.register('movie', createMovieHandler(options.movie));
}

export { createGotoHandler } from './goto';
export type { GotoHandlerHost } from './goto';
export { createUriHandler } from './uri';
export type { UriHandlerHost } from './uri';
export { createGotoAttachmentHandler } from './goto-attachment';
export type { AttachmentSaveSource, GotoAttachmentHandlerHost } from './goto-attachment';
export { createSoundHandler, startPlayback, waitForMediaEnd } from './sound';
export type { SoundHandlerHost } from './sound';
export { createMovieHandler } from './movie';
export type { MovieHandlerHost } from './movie';
export {
  MediaPlayerManager,
  isAutoplayBlocked,
  mapMediaError,
} from './media-player';
export type {
  DestroyOptions,
  MediaPlayResult,
  MediaPlayerHandle,
  MediaPlayerManagerOptions,
} from './media-player';
export { MediaPresenter } from './media-presenter';
export type { ClosePopupOptions, MediaPresenterOptions } from './media-presenter';