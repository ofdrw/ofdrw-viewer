/**
 * 裁剪区应用（实现由 T7/dev-pipeline 完成）。
 *
 * Clip 间取交集、Clip 内 area 取并集；必须在对象 CTM 之前应用。
 * 每个 Area 的变换：`Area.CTM × T(Path.Boundary) × Path.CTM`。
 */

import type { Clip } from '../model/types';
import type { Renderer } from '../renderer/types';
import { notImplemented } from '../common/not-implemented';

/** 裁剪上下文。 */
export interface ClipContext {
  renderer: Renderer;
  /** warning 回调；不支持组合使用 `W_UNSUPPORTED_CLIP`。 */
  onWarning?: (code: string, message: string) => void;
}

/**
 * 应用对象的 Clips（对象空间，CTM 之前）。
 *
 * @param context 渲染器与 warning 回调。
 * @param clips 裁剪项列表；空数组/undefined 时不做任何事。
 */
export function applyClips(context: ClipContext, clips: readonly Clip[] | undefined): void {
  void context;
  void clips;
  return notImplemented('render.applyClips');
}