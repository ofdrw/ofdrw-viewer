/**
 * DisplayList 构建器。
 *
 * 该构建器只记录目标无关命令，不执行绘制；render 层用它生成底纹 tile、
 * 独立块缓存与调试快照。平移/放置不写入列表，由回放方在正确变换下执行。
 */

import type { DisplayList, DrawCommand } from '../common/display-list';
import type { Box, DrawStyle, FillRule, ImageHandle, Matrix, ResolvedPaint } from '../common/types';

/** 可变的 DisplayList 构建器；`build()` 后不应继续复用。 */
export class DisplayListBuilder {
  private readonly commands: DrawCommand[] = [];

  /**
   * @param bounds 覆盖范围，单位与命令坐标一致（通常 mm）。
   */
  constructor(private readonly bounds: Box) {}

  /** 追加 `save` 命令。 */
  save(): this {
    return this.push({ op: 'save' });
  }

  /** 追加 `restore` 命令。 */
  restore(): this {
    return this.push({ op: 'restore' });
  }

  /**
   * 追加绝对变换命令。
   *
   * @param matrix 2×3 矩阵。
   */
  setTransform(matrix: Matrix): this {
    return this.push({ op: 'setTransform', matrix });
  }

  /**
   * 追加相对变换命令。
   *
   * @param matrix 2×3 矩阵。
   */
  transform(matrix: Matrix): this {
    return this.push({ op: 'transform', matrix });
  }

  /**
   * 追加平移命令。
   *
   * @param x X 方向平移量，当前空间单位。
   * @param y Y 方向平移量，当前空间单位。
   */
  translate(x: number, y: number): this {
    return this.push({ op: 'translate', x, y });
  }

  /**
   * 追加透明度乘法命令。
   *
   * @param alpha 透明度，0..1。
   */
  multiplyAlpha(alpha: number): this {
    return this.push({ op: 'multiplyAlpha', alpha });
  }

  /** 追加清空命令。 */
  clear(): this {
    return this.push({ op: 'clear' });
  }

  /** 追加 `beginPath`。 */
  beginPath(): this {
    return this.push({ op: 'beginPath' });
  }

  /**
   * 追加 `moveTo`。
   *
   * @param x X 坐标，当前空间单位。
   * @param y Y 坐标，当前空间单位。
   */
  moveTo(x: number, y: number): this {
    return this.push({ op: 'moveTo', x, y });
  }

  /**
   * 追加 `lineTo`。
   *
   * @param x X 坐标，当前空间单位。
   * @param y Y 坐标，当前空间单位。
   */
  lineTo(x: number, y: number): this {
    return this.push({ op: 'lineTo', x, y });
  }

  /**
   * 追加二次贝塞尔曲线。
   *
   * @param cpx 控制点 X。
   * @param cpy 控制点 Y。
   * @param x 终点 X。
   * @param y 终点 Y。
   */
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): this {
    return this.push({ op: 'quadraticCurveTo', cpx, cpy, x, y });
  }

  /**
   * 追加三次贝塞尔曲线。
   *
   * @param cp1x 控制点 1 X。
   * @param cp1y 控制点 1 Y。
   * @param cp2x 控制点 2 X。
   * @param cp2y 控制点 2 Y。
   * @param x 终点 X。
   * @param y 终点 Y。
   */
  cubicCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): this {
    return this.push({ op: 'cubicCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
  }

  /**
   * 追加矩形路径。
   *
   * @param x 左上角 X。
   * @param y 左上角 Y。
   * @param w 宽度。
   * @param h 高度。
   */
  rect(x: number, y: number, w: number, h: number): this {
    return this.push({ op: 'rect', x, y, w, h });
  }

  /** 追加 `closePath`。 */
  closePath(): this {
    return this.push({ op: 'closePath' });
  }

  /**
   * 追加裁剪命令。
   *
   * @param rule 填充规则。
   */
  clip(rule: FillRule): this {
    return this.push({ op: 'clip', rule });
  }

  /**
   * 追加填充命令。
   *
   * @param style 最终线型。
   * @param paint 已绑定的 Paint。
   * @param rule 填充规则。
   */
  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): this {
    return this.push({ op: 'fill', style, paint, rule });
  }

  /**
   * 追加描边命令。
   *
   * @param style 最终线型。
   * @param paint 已绑定的 Paint。
   */
  stroke(style: DrawStyle, paint: ResolvedPaint): this {
    return this.push({ op: 'stroke', style, paint });
  }

  /**
   * 追加图片绘制命令。
   *
   * @param image 图像句柄。
   * @param transform 图片单位空间到当前空间的矩阵。
   * @param alpha 透明度，0..1。
   * @param smoothing 是否平滑采样。
   * @param mask 可选蒙版句柄。
   */
  drawImage(
    image: ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask?: ImageHandle,
  ): this {
    const command: DrawCommand = { op: 'drawImage', image, transform, alpha, smoothing };
    if (mask) command.mask = mask;
    return this.push(command);
  }

  /**
   * 完成构建。
   *
   * @returns 不可变 DisplayList 快照。
   */
  build(): DisplayList {
    return { commands: this.commands.slice(), bounds: this.bounds };
  }

  private push(command: DrawCommand): this {
    this.commands.push(command);
    return this;
  }
}