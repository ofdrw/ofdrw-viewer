/**
 * 记录渲染器（实现由 T5/dev-renderer 完成）。
 *
 * 记录路径/样式/矩阵/group 调用，不真正绘制，用于测试与命令导出。
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
import { notImplemented } from '../common/not-implemented';

/** 不执行像素绘制的 Renderer 实现。 */
export class RecordingRenderer implements Renderer {
  /** @inheritdoc */
  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void {
    void context;
    void viewport;
    return notImplemented('RecordingRenderer.beginPage');
  }

  /** @inheritdoc */
  endPage(): void {
    return notImplemented('RecordingRenderer.endPage');
  }

  /** @inheritdoc */
  save(): void {
    return notImplemented('RecordingRenderer.save');
  }

  /** @inheritdoc */
  restore(): void {
    return notImplemented('RecordingRenderer.restore');
  }

  /** @inheritdoc */
  setTransform(m: Matrix): void {
    void m;
    return notImplemented('RecordingRenderer.setTransform');
  }

  /** @inheritdoc */
  transform(m: Matrix): void {
    void m;
    return notImplemented('RecordingRenderer.transform');
  }

  /** @inheritdoc */
  translate(x: number, y: number): void {
    void x;
    void y;
    return notImplemented('RecordingRenderer.translate');
  }

  /** @inheritdoc */
  multiplyAlpha(alpha: number): void {
    void alpha;
    return notImplemented('RecordingRenderer.multiplyAlpha');
  }

  /** @inheritdoc */
  clear(): void {
    return notImplemented('RecordingRenderer.clear');
  }

  /** @inheritdoc */
  beginPath(): void {
    return notImplemented('RecordingRenderer.beginPath');
  }

  /** @inheritdoc */
  moveTo(x: number, y: number): void {
    void x;
    void y;
    return notImplemented('RecordingRenderer.moveTo');
  }

  /** @inheritdoc */
  lineTo(x: number, y: number): void {
    void x;
    void y;
    return notImplemented('RecordingRenderer.lineTo');
  }

  /** @inheritdoc */
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    void cpx;
    void cpy;
    void x;
    void y;
    return notImplemented('RecordingRenderer.quadraticCurveTo');
  }

  /** @inheritdoc */
  cubicCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    void cp1x;
    void cp1y;
    void cp2x;
    void cp2y;
    void x;
    void y;
    return notImplemented('RecordingRenderer.cubicCurveTo');
  }

  /** @inheritdoc */
  rect(x: number, y: number, w: number, h: number): void {
    void x;
    void y;
    void w;
    void h;
    return notImplemented('RecordingRenderer.rect');
  }

  /** @inheritdoc */
  closePath(): void {
    return notImplemented('RecordingRenderer.closePath');
  }

  /** @inheritdoc */
  clip(rule: FillRule): void {
    void rule;
    return notImplemented('RecordingRenderer.clip');
  }

  /** @inheritdoc */
  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void {
    void style;
    void paint;
    void rule;
    return notImplemented('RecordingRenderer.fill');
  }

  /** @inheritdoc */
  stroke(style: DrawStyle, paint: ResolvedPaint): void {
    void style;
    void paint;
    return notImplemented('RecordingRenderer.stroke');
  }

  /** @inheritdoc */
  createImage(image: DecodedImage): ImageHandle {
    void image;
    return notImplemented('RecordingRenderer.createImage');
  }

  /** @inheritdoc */
  drawImage(
    image: ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask?: ImageHandle,
  ): void {
    void image;
    void transform;
    void alpha;
    void smoothing;
    void mask;
    return notImplemented('RecordingRenderer.drawImage');
  }

  /** @inheritdoc */
  beginGroup(options: GroupOptions): void {
    void options;
    return notImplemented('RecordingRenderer.beginGroup');
  }

  /** @inheritdoc */
  endGroup(): void {
    return notImplemented('RecordingRenderer.endGroup');
  }

  /** @inheritdoc */
  close(): void {
    return notImplemented('RecordingRenderer.close');
  }
}