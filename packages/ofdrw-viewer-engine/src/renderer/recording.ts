/**
 * 记录渲染器。
 *
 * 记录路径/样式/矩阵/group 调用，不执行任何像素绘制；用于渲染器契约测试、
 * 绘制管线调用序列断言与命令导出。记录内容只包含目标无关类型，不依赖 Canvas 实现。
 */

import type {
  CanvasRenderingContext2DLike,
  GroupOptions,
  Renderer,
} from './types';
import type {
  DecodedImage,
  DrawStyle,
  FillRule,
  ImageHandle,
  Matrix,
  ResolvedPaint,
  Viewport,
} from '../common/types';

/** 一条记录调用；`op` 与 Renderer 方法一一对应。 */
export type RecordingCall =
  | { op: 'beginPage'; viewport: Viewport }
  | { op: 'endPage' }
  | { op: 'save' }
  | { op: 'restore' }
  | { op: 'setTransform'; matrix: Matrix }
  | { op: 'transform'; matrix: Matrix }
  | { op: 'translate'; x: number; y: number }
  | { op: 'multiplyAlpha'; alpha: number }
  | { op: 'clear' }
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
      op: 'createImage';
      width: number;
      height: number;
      handle: ImageHandle;
    }
  | {
      op: 'drawImage';
      image: ImageHandle;
      transform: Matrix;
      alpha: number;
      smoothing: boolean;
      mask?: ImageHandle;
    }
  | { op: 'beginGroup'; options: GroupOptions }
  | { op: 'endGroup' }
  | { op: 'close' };

/** 不执行像素绘制的 Renderer 实现。 */
export class RecordingRenderer implements Renderer {
  /** 按调用顺序记录的全部操作。 */
  readonly calls: RecordingCall[] = [];

  /** 最近一次 `beginPage` 的 viewport；便于测试断言。 */
  lastViewport: Viewport | null = null;

  /** 是否已调用 `close`。 */
  closed = false;

  /** 清空记录（不改变 closed 状态）。 */
  reset(): void {
    this.calls.length = 0;
    this.lastViewport = null;
  }

  /** @inheritdoc */
  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void {
    void context;
    this.lastViewport = viewport;
    this.calls.push({ op: 'beginPage', viewport: { ...viewport } });
  }

  /** @inheritdoc */
  endPage(): void {
    this.calls.push({ op: 'endPage' });
  }

  /** @inheritdoc */
  save(): void {
    this.calls.push({ op: 'save' });
  }

  /** @inheritdoc */
  restore(): void {
    this.calls.push({ op: 'restore' });
  }

  /** @inheritdoc */
  setTransform(m: Matrix): void {
    this.calls.push({ op: 'setTransform', matrix: m });
  }

  /** @inheritdoc */
  transform(m: Matrix): void {
    this.calls.push({ op: 'transform', matrix: m });
  }

  /** @inheritdoc */
  translate(x: number, y: number): void {
    this.calls.push({ op: 'translate', x, y });
  }

  /** @inheritdoc */
  multiplyAlpha(alpha: number): void {
    this.calls.push({ op: 'multiplyAlpha', alpha });
  }

  /** @inheritdoc */
  clear(): void {
    this.calls.push({ op: 'clear' });
  }

  /** @inheritdoc */
  beginPath(): void {
    this.calls.push({ op: 'beginPath' });
  }

  /** @inheritdoc */
  moveTo(x: number, y: number): void {
    this.calls.push({ op: 'moveTo', x, y });
  }

  /** @inheritdoc */
  lineTo(x: number, y: number): void {
    this.calls.push({ op: 'lineTo', x, y });
  }

  /** @inheritdoc */
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.calls.push({ op: 'quadraticCurveTo', cpx, cpy, x, y });
  }

  /** @inheritdoc */
  cubicCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.calls.push({ op: 'cubicCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
  }

  /** @inheritdoc */
  rect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ op: 'rect', x, y, w, h });
  }

  /** @inheritdoc */
  closePath(): void {
    this.calls.push({ op: 'closePath' });
  }

  /** @inheritdoc */
  clip(rule: FillRule): void {
    this.calls.push({ op: 'clip', rule });
  }

  /** @inheritdoc */
  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void {
    this.calls.push({ op: 'fill', style, paint, rule });
  }

  /** @inheritdoc */
  stroke(style: DrawStyle, paint: ResolvedPaint): void {
    this.calls.push({ op: 'stroke', style, paint });
  }

  /**
   * 记录图像创建并返回不透明句柄；不接触任何像素。
   *
   * @param image 平台解码结果。
   * @returns 只含宽高的句柄。
   */
  createImage(image: DecodedImage): ImageHandle {
    const handle: ImageHandle = { width: image.width, height: image.height };
    this.calls.push({ op: 'createImage', width: image.width, height: image.height, handle });
    return handle;
  }

  /** @inheritdoc */
  drawImage(
    image: ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask?: ImageHandle,
  ): void {
    this.calls.push({ op: 'drawImage', image, transform, alpha, smoothing, mask });
  }

  /** @inheritdoc */
  beginGroup(options: GroupOptions): void {
    this.calls.push({ op: 'beginGroup', options: { ...options, bounds: { ...options.bounds } } });
  }

  /** @inheritdoc */
  endGroup(): void {
    this.calls.push({ op: 'endGroup' });
  }

  /** @inheritdoc */
  close(): void {
    this.calls.push({ op: 'close' });
    this.closed = true;
  }
}