/**
 * DisplayList 构建器。
 *
 * 该构建器只记录目标无关命令，不执行绘制；render 层用它生成底纹 tile、
 * 独立块缓存与调试快照。平移/放置不写入列表，由回放方在正确变换下执行。
 */

import type { DisplayList, DrawCommand } from '../common/display-list';
import type { Box, DrawStyle, FillRule, ImageHandle, Matrix, ResolvedPaint } from '../common/types';
import type { Renderer } from '../renderer/types';

/** 斜接限制的安全默认值（设计方案附录 A）。 */
const DEFAULT_MITER_LIMIT = 4.234;

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

/**
 * 归一化绘制线型，只保留渲染器可安全消费的字段。
 *
 * 规则：线宽/斜接限制/虚线偏移必须是有限数；虚线至少两段、非负且至少一段为正，
 * 否则按实线处理（此时偏移强制为 0）。函数不修改入参，返回新的普通对象。
 *
 * @param style 已结算或记录在显示列表中的线型；长度单位与当前对象空间一致（通常 mm）。
 * @returns 可安全传给渲染器的线型。
 */
export function normalizeDrawStyle(style: DrawStyle): DrawStyle {
  const lineWidth = Number.isFinite(style.lineWidth) && style.lineWidth >= 0 ? style.lineWidth : 0;
  const miterLimit =
    Number.isFinite(style.miterLimit) && style.miterLimit > 0
      ? style.miterLimit
      : DEFAULT_MITER_LIMIT;
  const rawDash = Array.isArray(style.dashPattern) ? style.dashPattern : [];
  const dashPattern = rawDash.filter((value) => Number.isFinite(value) && value >= 0);
  const hasDash =
    dashPattern.length === rawDash.length &&
    dashPattern.length >= 2 &&
    dashPattern.some((value) => value > 0);
  const dashOffset =
    hasDash && Number.isFinite(style.dashOffset) ? style.dashOffset : 0;
  return {
    lineWidth,
    lineCap: style.lineCap,
    lineJoin: style.lineJoin,
    miterLimit,
    dashOffset,
    dashPattern: hasDash ? dashPattern.slice() : [],
  };
}

/**
 * 显示列表图片解析器。
 *
 * 准备阶段构建独立块时没有渲染器，无法创建真实 `ImageHandle`，因此显示列表里
 * 可能保存占位句柄；绘制阶段在调用 `renderer.drawImage` 前通过该回调物化。
 *
 * @param handle 显示列表中的图片/蒙版句柄。
 * @param role 句柄用途：主图或蒙版。
 * @returns 当前渲染器可直接消费的句柄。
 */
export type DisplayListImageResolver = (
  handle: ImageHandle,
  role: 'image' | 'mask',
) => ImageHandle;

/**
 * 物化显示列表中的图片/蒙版占位句柄。
 *
 * 底纹 tile 在准备阶段没有渲染器，图片命令只能保存占位句柄；绘制阶段在把 tile
 * 交给渲染器前用该函数生成新的显示列表，避免占位句柄进入 `Renderer.drawImage`。
 * 原显示列表保持不变，可继续作为缓存复用。
 *
 * @param list 原显示列表。
 * @param resolveImage 占位句柄物化函数。
 * @returns 图片/蒙版已替换的新显示列表。
 */
export function materializeDisplayListImages(
  list: DisplayList,
  resolveImage: DisplayListImageResolver,
): DisplayList {
  return {
    bounds: list.bounds,
    commands: list.commands.map((command) => {
      if (command.op !== 'drawImage') return command;
      return {
        ...command,
        image: resolveImage(command.image, 'image'),
        ...(command.mask ? { mask: resolveImage(command.mask, 'mask') } : {}),
      };
    }),
  };
}

/**
 * 回放目标无关的绘制命令到渲染器。
 *
 * 调用方负责在回放前设置正确的变换与裁剪；列表中的 `setTransform/transform/translate`
 * 会按记录顺序执行，但不会替调用方补页面矩阵。
 *
 * @param renderer 目标渲染器。
 * @param list 已构建的显示列表；命令按数组顺序执行。
 * @param resolveImage 可选的图片/蒙版句柄物化函数；省略时原样传给渲染器。
 */
export function replayDisplayList(
  renderer: Renderer,
  list: DisplayList,
  resolveImage?: DisplayListImageResolver,
): void {
  for (const command of list.commands) {
    switch (command.op) {
      case 'save':
        renderer.save();
        break;
      case 'restore':
        renderer.restore();
        break;
      case 'setTransform':
        renderer.setTransform(command.matrix);
        break;
      case 'transform':
        renderer.transform(command.matrix);
        break;
      case 'translate':
        renderer.translate(command.x, command.y);
        break;
      case 'multiplyAlpha':
        renderer.multiplyAlpha(command.alpha);
        break;
      case 'clear':
        renderer.clear();
        break;
      case 'beginPath':
        renderer.beginPath();
        break;
      case 'moveTo':
        renderer.moveTo(command.x, command.y);
        break;
      case 'lineTo':
        renderer.lineTo(command.x, command.y);
        break;
      case 'quadraticCurveTo':
        renderer.quadraticCurveTo(command.cpx, command.cpy, command.x, command.y);
        break;
      case 'cubicCurveTo':
        renderer.cubicCurveTo(
          command.cp1x,
          command.cp1y,
          command.cp2x,
          command.cp2y,
          command.x,
          command.y,
        );
        break;
      case 'rect':
        renderer.rect(command.x, command.y, command.w, command.h);
        break;
      case 'closePath':
        renderer.closePath();
        break;
      case 'clip':
        renderer.clip(command.rule);
        break;
      case 'fill':
        renderer.fill(command.style, command.paint, command.rule);
        break;
      case 'stroke':
        renderer.stroke(command.style, command.paint);
        break;
      case 'drawImage': {
        const image = resolveImage ? resolveImage(command.image, 'image') : command.image;
        const mask = command.mask
          ? (resolveImage ? resolveImage(command.mask, 'mask') : command.mask)
          : undefined;
        renderer.drawImage(
          image,
          command.transform,
          command.alpha,
          command.smoothing,
          mask,
        );
        break;
      }
      default: {
        // 穷尽检查：新增 DrawCommand 时此处会编译报错，避免静默漏画。
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }
}