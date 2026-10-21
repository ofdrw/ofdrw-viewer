/**
 * Gouraud/LaGouraud 软件光栅化（实现由 T5/dev-renderer 完成）。
 *
 * 三角形内按重心坐标线性插值；EdgeFlag 控制四边形对角线；输出 RGBA8 像素。
 * 渲染器在内部离屏 canvas 使用，engine 不持有 surface。
 */

import type { ImageDataLike, Matrix, MeshShadingSpec } from '../common/types';
import { notImplemented } from '../common/not-implemented';

/** 光栅化请求。 */
export interface GouraudRasterRequest {
  spec: MeshShadingSpec;
  /** 对象空间 → 目标像素空间的矩阵。 */
  matrix: Matrix;
  /** 输出宽度，像素。 */
  width: number;
  /** 输出高度，像素。 */
  height: number;
  /** 单图元 bbox 像素上限；超过时降采样并 warning。 */
  maxPixels?: number;
}

/**
 * 将网格渐变光栅化为 RGBA8。
 *
 * @param request 网格、矩阵、输出尺寸与像素上限。
 * @returns RGBA8 像素（straight alpha）。
 */
export function rasterizeMeshShading(request: GouraudRasterRequest): ImageDataLike {
  void request;
  return notImplemented('render.rasterizeMeshShading');
}