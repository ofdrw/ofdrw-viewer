/**
 * 图片绘制（实现由 T7/dev-pipeline 完成）。
 *
 * 图片局部空间是单位正方形；默认严格按 identity 1×1 绘制，`strictImageCtm=false`
 * 时才铺满 Boundary（设计方案 3/11.3）。
 */

import type { Matrix } from '../common/types';
import type { ImageObject } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { ImageHandle } from '../common/types';
import type { Renderer } from '../renderer/types';
import { notImplemented } from '../common/not-implemented';

/** 图片绘制上下文。 */
export interface ImageDrawContext {
  renderer: Renderer;
  /** 已解码图片句柄；解码失败时调用方直接跳过。 */
  image: ImageHandle;
  /** 是否使用平滑采样，默认 true。 */
  smoothing?: boolean;
  /** warning 回调；缺 CTM 使用 `W_IMAGE_NO_CTM`。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/**
 * 计算图片单位空间到对象空间的矩阵。
 *
 * @param object 图片对象。
 * @param strictImageCtm 是否严格 identity（默认 true）。
 * @returns 图片变换矩阵。
 */
export function computeImageTransform(object: ImageObject, strictImageCtm: boolean): Matrix {
  void object;
  void strictImageCtm;
  return notImplemented('render.computeImageTransform');
}

/**
 * 绘制图片对象（含边框、蒙版、替换图由调用方选择）。
 *
 * @param context 渲染器与图片句柄。
 * @param object 图片对象。
 * @param style 已结算样式。
 */
export function drawImageObject(
  context: ImageDrawContext,
  object: ImageObject,
  style: ResolvedStyle,
): void {
  void context;
  void object;
  void style;
  return notImplemented('render.drawImageObject');
}