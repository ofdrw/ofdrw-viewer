/**
 * 渲染器抽象与宿主 Canvas 适配类型。
 *
 * 本文件只依赖 `common/`。自定义渲染器不需要理解 OFD 模型或样式结算；
 * CanvasFactory 是 H5Canvas2DRenderer 的内部扩展点，不从包根导出。
 */

import type {
  Box,
  CanvasImageSourceLike,
  DecodedImage,
  DrawStyle,
  FillRule,
  ImageDataLike,
  ImageHandle,
  Matrix,
  ResolvedPaint,
  Viewport,
} from '../common/types';

/** 宿主 Canvas 的最小接口；不要求 `OffscreenCanvas`、`Path2D` 或 `DOMMatrix` 存在。 */
export interface Canvas2DLike {
  width: number;
  height: number;
  style?: { width: string; height: string };
  /**
   * 获取 2D 上下文。
   *
   * @param type 固定为 `'2d'`。
   * @param options `alpha`/`willReadFrequently` 透传给宿主；不支持时可忽略。
   * @returns 2D 上下文或 `null`。
   */
  getContext(
    type: '2d',
    options?: { alpha?: boolean; willReadFrequently?: boolean },
  ): CanvasRenderingContext2DLike | null;
}

/** Canvas 渐变对象的最小接口。 */
export interface CanvasGradientLike {
  /**
   * 添加颜色停靠点。
   *
   * @param offset 位置，0..1。
   * @param color CSS 颜色字符串。
   */
  addColorStop(offset: number, color: string): void;
}

/** Canvas Pattern 对象的最小接口；`setTransform` 不要求所有平台都支持。 */
export interface CanvasPatternLike {
  setTransform?(matrix: unknown): void;
}

/**
 * 引擎实际使用的 CanvasRenderingContext2D 子集。
 *
 * 只列引擎会调用的方法/属性；不包含文字 API（引擎文字统一走轮廓）和 `filter`。
 */
export interface CanvasRenderingContext2DLike {
  readonly canvas: Canvas2DLike;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(rule?: FillRule): void;
  fill(rule?: FillRule): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  /**
   * 创建 RGBA8 像素缓冲（可选）；Gouraud/LaGouraud 软件光栅化需要。
   *
   * 缺失时 H5 渲染器必须降级为平均色并上报 `W_GOURAUD_APPROX`，最小 Canvas mock
   * 不强制实现。
   *
   * @param width 像素宽。
   * @param height 像素高。
   * @returns 可写像素缓冲。
   */
  createImageData?(width: number, height: number): ImageDataLike;
  /**
   * 写入 RGBA8 像素缓冲（可选）；与 `createImageData` 配套。
   *
   * @param data 像素缓冲。
   * @param dx 目标左上角 x，设备像素。
   * @param dy 目标左上角 y，设备像素。
   */
  putImageData?(data: ImageDataLike, dx: number, dy: number): void;
  drawImage(image: CanvasImageSourceLike, dx: number, dy: number, dw?: number, dh?: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradientLike;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradientLike;
  createPattern(image: CanvasImageSourceLike, repeat: string): CanvasPatternLike | null;
  setLineDash(segments: number[]): void;
  getLineDash(): number[];
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: string | CanvasGradientLike | CanvasPatternLike;
  strokeStyle: string | CanvasGradientLike | CanvasPatternLike;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  imageSmoothingEnabled: boolean;
}

/** 合成模式；与 Canvas `globalCompositeOperation` 的可用集合保持一致。 */
export type CompositeMode =
  | 'source-over'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'destination-in'
  | 'destination-out';

/** 独立合成组的参数。 */
export interface GroupOptions {
  /** group 自身坐标系的 bounds，单位与当前绘制空间一致（通常 mm）。 */
  bounds: Box;
  /** group 坐标 → 当前目标 device 坐标的矩阵。 */
  matrix: Matrix;
  /** 组透明度，0..1；在 group 结束时整体乘一次。 */
  alpha: number;
  /** 是否需要隔离；blend mode / soft mask / 复杂合成时为 true。 */
  isolated?: boolean;
  /** 组合成模式，默认 `source-over`。 */
  composite?: CompositeMode;
}

/**
 * 底层绘制渲染器。
 *
 * 渲染器只接收最终样式、路径、图像、矩阵与 group；不认识 PathObject/DrawParam/PageBlock。
 * `beginPage` 不设置 canvas 尺寸也不清屏，画布生命周期由宿主管理。
 */
export interface Renderer {
  /** 开始一页渲染；不设置 canvas 宽高、不清屏。 */
  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void;
  /** 结束一页渲染，恢复到进入前状态。 */
  endPage(): void;

  save(): void;
  restore(): void;
  setTransform(m: Matrix): void;
  transform(m: Matrix): void;
  translate(x: number, y: number): void;
  /** 将 0..1 的 alpha 与当前 alpha 相乘，不覆盖父级。 */
  multiplyAlpha(alpha: number): void;
  /** 清空内部 scratch，不清除主画布。 */
  clear(): void;

  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  cubicCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  closePath(): void;
  clip(rule: FillRule): void;

  /** 填充当前路径；paint 已由 PaintBinder 绑定。 */
  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void;
  /** 描边当前路径；paint 已由 PaintBinder 绑定。 */
  stroke(style: DrawStyle, paint: ResolvedPaint): void;

  /** 把解码结果转成渲染器内部句柄；核心不假设底层类型。 */
  createImage(image: DecodedImage): ImageHandle;
  /**
   * 绘制图片句柄。
   *
   * @param image 图像句柄。
   * @param transform 图片单位空间 → 当前空间的矩阵。
   * @param alpha 额外透明度，0..1。
   * @param smoothing 是否启用平滑。
   * @param mask 可选蒙版句柄。
   * @param blendMode 可选合成模式；`'multiply'` 用于签章白底，缺省沿用当前 composite
   *   （通常为 `source-over`）。
   */
  drawImage(
    image: ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask?: ImageHandle,
    blendMode?: 'multiply',
  ): void;

  /** 进入独立合成目标；alpha 在 endGroup 时整体应用一次。 */
  beginGroup(options: GroupOptions): void;
  /** 结束独立合成目标；必须恢复进入前的目标、变换、alpha、clip 与 composite。 */
  endGroup(): void;

  /** 释放渲染器内部资源；不关闭主 canvas。 */
  close(): void;
}

/** CanvasFactory 创建的画布条目。 */
export interface CanvasFactoryEntry {
  canvas: Canvas2DLike;
  context: CanvasRenderingContext2DLike;
}

/** H5Canvas2DRenderer 内部的临时画布工厂；不从包根导出。 */
export interface CanvasFactory {
  /**
   * 创建指定像素尺寸的画布。
   *
   * @param width 宽度，像素。
   * @param height 高度，像素。
   * @returns 画布与已获取的 2D 上下文。
   */
  create(width: number, height: number): CanvasFactoryEntry;
  /**
   * 复用画布：修改尺寸并清空。
   *
   * @param entry 已有画布条目。
   * @param width 新宽度，像素。
   * @param height 新高度，像素。
   */
  reset(entry: CanvasFactoryEntry, width: number, height: number): void;
  /**
   * 销毁画布：宽高置 0，释放图形资源。
   *
   * @param entry 要销毁的画布条目。
   */
  destroy(entry: CanvasFactoryEntry): void;
}

/** H5Canvas2DRenderer 构造参数。 */
export interface H5Canvas2DRendererOptions {
  /**
   * 创建临时画布的宿主函数；不传时仅在浏览器 `document` 存在时使用默认工厂。
   * Node/小程序必须显式传入。
   *
   * @param width 宽度，像素。
   * @param height 高度，像素。
   * @returns 宿主画布。
   */
  createCanvas?: (width: number, height: number) => Canvas2DLike;
  /** 是否启用硬件加速语义；默认 false，对应 `willReadFrequently: true`。 */
  enableHWA?: boolean;
}