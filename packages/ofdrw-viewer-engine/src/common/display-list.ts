/**
 * 目标无关的绘制命令列表。
 *
 * DisplayList 只描述“画什么”，不包含 Canvas/DOM/Node 类型，也不包含 OFD 模型；
 * 它可用于底纹 tile、独立块缓存、RecordingRenderer 断言和自定义渲染器回放。
 */

import type { Box, DrawStyle, ImageHandle, Matrix, ResolvedPaint, FillRule } from './types';

/** 单条绘制命令；与 `Renderer` 的方法一一对应（group 由渲染器内部合成，不进入 DisplayList）。 */
export type DrawCommand =
  | { op: 'save' }
  | { op: 'restore' }
  | { op: 'setTransform'; matrix: Matrix }
  | { op: 'transform'; matrix: Matrix }
  | { op: 'translate'; x: number; y: number }
  | { op: 'multiplyAlpha'; alpha: number }
  | { op: 'beginPath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'quadraticCurveTo'; cpx: number; cpy: number; x: number; y: number }
  | {
      op: 'cubicCurveTo';
      cp1x: number;
      cp1y: number;
      cp2x: number;
      cp2y: number;
      x: number;
      y: number;
    }
  | { op: 'rect'; x: number; y: number; w: number; h: number }
  | { op: 'closePath' }
  | { op: 'clip'; rule: FillRule }
  | { op: 'fill'; style: DrawStyle; paint: ResolvedPaint; rule: FillRule }
  | { op: 'stroke'; style: DrawStyle; paint: ResolvedPaint }
  | {
      op: 'drawImage';
      image: ImageHandle;
      transform: Matrix;
      alpha: number;
      smoothing: boolean;
      mask?: ImageHandle;
    }
  | { op: 'clear' };

/**
 * 一组目标无关的绘制命令及其覆盖范围。
 *
 * `bounds` 为命令覆盖范围，单位与命令中的坐标一致（通常 mm），用于渲染器估算
 * scratch/tile 尺寸；命令执行前由调用方保证已有正确的变换与裁剪状态。
 */
export interface DisplayList {
  readonly commands: readonly DrawCommand[];
  readonly bounds: Box;
}