/**
 * H5 Canvas2D 默认渲染器（实现由 T5/dev-renderer 完成）。
 *
 * 不直接依赖 DOM：临时画布通过宿主注入的 `createCanvas` 或浏览器默认工厂获取。
 * 不在本层使用 fillText/strokeText/measureText。
 */

import type {
  CanvasRenderingContext2DLike,
  CompositeMode,
  GroupOptions,
  H5Canvas2DRendererOptions,
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

/** 默认 H5 Canvas2D 渲染器；内部管理 scratch/pattern/group 画布。 */
export class H5Canvas2DRenderer implements Renderer {
  private readonly options: H5Canvas2DRendererOptions;

  /**
   * @param options 宿主 createCanvas 与 HWA 选项；Node/小程序必须传 createCanvas。
   */
  constructor(options: H5Canvas2DRendererOptions = {}) {
    this.options = options;
    void this.options;
  }

  /** @inheritdoc */
  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void {
    void context;
    void viewport;
    return notImplemented('H5Canvas2DRenderer.beginPage');
  }

  /** @inheritdoc */
  endPage(): void {
    return notImplemented('H5Canvas2DRenderer.endPage');
  }

  /** @inheritdoc */
  save(): void {
    return notImplemented('H5Canvas2DRenderer.save');
  }

  /** @inheritdoc */
  restore(): void {
    return notImplemented('H5Canvas2DRenderer.restore');
  }

  /** @inheritdoc */
  setTransform(m: Matrix): void {
    void m;
    return notImplemented('H5Canvas2DRenderer.setTransform');
  }

  /** @inheritdoc */
  transform(m: Matrix): void {
    void m;
    return notImplemented('H5Canvas2DRenderer.transform');
  }

  /** @inheritdoc */
  translate(x: number, y: number): void {
    void x;
    void y;
    return notImplemented('H5Canvas2DRenderer.translate');
  }

  /** @inheritdoc */
  multiplyAlpha(alpha: number): void {
    void alpha;
    return notImplemented('H5Canvas2DRenderer.multiplyAlpha');
  }

  /** @inheritdoc */
  clear(): void {
    return notImplemented('H5Canvas2DRenderer.clear');
  }

  /** @inheritdoc */
  beginPath(): void {
    return notImplemented('H5Canvas2DRenderer.beginPath');
  }

  /** @inheritdoc */
  moveTo(x: number, y: number): void {
    void x;
    void y;
    return notImplemented('H5Canvas2DRenderer.moveTo');
  }

  /** @inheritdoc */
  lineTo(x: number, y: number): void {
    void x;
    void y;
    return notImplemented('H5Canvas2DRenderer.lineTo');
  }

  /** @inheritdoc */
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    void cpx;
    void cpy;
    void x;
    void y;
    return notImplemented('H5Canvas2DRenderer.quadraticCurveTo');
  }

  /** @inheritdoc */
  cubicCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    void cp1x;
    void cp1y;
    void cp2x;
    void cp2y;
    void x;
    void y;
    return notImplemented('H5Canvas2DRenderer.cubicCurveTo');
  }

  /** @inheritdoc */
  rect(x: number, y: number, w: number, h: number): void {
    void x;
    void y;
    void w;
    void h;
    return notImplemented('H5Canvas2DRenderer.rect');
  }

  /** @inheritdoc */
  closePath(): void {
    return notImplemented('H5Canvas2DRenderer.closePath');
  }

  /** @inheritdoc */
  clip(rule: FillRule): void {
    void rule;
    return notImplemented('H5Canvas2DRenderer.clip');
  }

  /** @inheritdoc */
  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void {
    void style;
    void paint;
    void rule;
    return notImplemented('H5Canvas2DRenderer.fill');
  }

  /** @inheritdoc */
  stroke(style: DrawStyle, paint: ResolvedPaint): void {
    void style;
    void paint;
    return notImplemented('H5Canvas2DRenderer.stroke');
  }

  /** @inheritdoc */
  createImage(image: DecodedImage): ImageHandle {
    void image;
    return notImplemented('H5Canvas2DRenderer.createImage');
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
    return notImplemented('H5Canvas2DRenderer.drawImage');
  }

  /** @inheritdoc */
  beginGroup(options: GroupOptions): void {
    void options;
    return notImplemented('H5Canvas2DRenderer.beginGroup');
  }

  /** @inheritdoc */
  endGroup(): void {
    return notImplemented('H5Canvas2DRenderer.endGroup');
  }

  /** @inheritdoc */
  close(): void {
    return notImplemented('H5Canvas2DRenderer.close');
  }

  /**
   * 当前合成模式；供内部/测试断言使用。
   *
   * @returns 合成模式。
   */
  get compositeMode(): CompositeMode {
    return notImplemented('H5Canvas2DRenderer.compositeMode');
  }
}