/**
 * 图片绘制。
 *
 * 图片局部空间是单位正方形；默认严格按 identity 1×1 绘制，`strictImageCtm=false`
 * 时才铺满 Boundary（设计方案 3/11.3）。图片数据只通过单位矩形 + 当前对象变换绘制，
 * 边框在 Boundary 矩形上绘制，不受图片 CTM 影响。
 */

import type { ImageHandle, Matrix } from '../common/types';
import type { ImageObject } from '../model/types';
import type { ResolvedStyle } from '../style/types';
import type { Renderer } from '../renderer/types';
import { IDENTITY_MATRIX, invertMatrix, scaleMatrix } from '../common/matrix';
import { normalizeDrawStyle } from './display-list';

/** 替换图选择模式；`auto` 仅在 dpi>200 时优先替换图。 */
export type ImageSubstitutionMode = 'auto' | 'always' | 'never';

/** 默认输出 DPI。 */
const DEFAULT_DPI = 96;

/** 图片绘制上下文。 */
export interface ImageDrawContext {
  renderer: Renderer;
  /** 已解码主图句柄；解码失败时调用方直接跳过。 */
  image: ImageHandle;
  /**
   * 已解码蒙版句柄。
   *
   * 由调用方按 `ImageObject.imageMask` 资源 ID 解码；H5 renderer 内部用
   * destination-in 合成。engine 不持有 scratch canvas。
   */
  mask?: ImageHandle;
  /** 已解码替换图句柄（按 `ImageObject.substitution` 资源 ID 解码）。 */
  substitutionImage?: ImageHandle;
  /** 替换图选择模式，默认 `auto`。 */
  substitutionMode?: ImageSubstitutionMode;
  /** 输出 DPI；`auto` 模式下 >200 才使用替换图，默认 96。 */
  dpi?: number;
  /** 缺 CTM 时是否严格 identity（默认 true）；false 时铺满 Boundary。 */
  strictImageCtm?: boolean;
  /** 是否使用平滑采样，默认 true。 */
  smoothing?: boolean;
  /** warning 回调；缺 CTM 使用 `W_IMAGE_NO_CTM`。 */
  onWarning?: (code: string, message: string, objectId?: string) => void;
}

/**
 * 计算图片单位空间到对象空间的矩阵。
 *
 * 有 CTM 时直接返回 CTM；无 CTM 时默认返回 identity（严格模式，图片为 1mm×1mm），
 * `strictImageCtm=false` 时返回 `S(Boundary.w, Boundary.h)`，兼容“铺满边界”的旧行为。
 * 结果不包含 Boundary 平移；平移由对象分发层统一处理。
 *
 * @param object 图片对象。
 * @param strictImageCtm 是否严格 identity（默认 true）。
 * @returns 图片变换矩阵。
 */
export function computeImageTransform(object: ImageObject, strictImageCtm: boolean): Matrix {
  if (object.ctm) return object.ctm;
  if (strictImageCtm) return IDENTITY_MATRIX;
  return scaleMatrix(IDENTITY_MATRIX, object.boundary.w, object.boundary.h);
}

/**
 * 绘制图片对象（含边框、蒙版、替换图）。
 *
 * 调用方必须已完成 `save → translate(Boundary) → Boundary clip → Clips → transform(CTM)
 * → multiplyAlpha`；本函数在 CTM 空间内绘制单位正方形图片，边框通过逆 CTM 回到
 * 对象空间，保证边框不随图片旋转/缩放。
 *
 * @param context 渲染器、图片/蒙版/替换图句柄。
 * @param object 图片对象。
 * @param style 已结算样式（当前图片绘制不使用 Paint，保留参数供边框/降级扩展）。
 */
export function drawImageObject(
  context: ImageDrawContext,
  object: ImageObject,
  style: ResolvedStyle,
): void {
  void style;
  const { renderer } = context;
  const strict = context.strictImageCtm ?? true;
  const smoothing = context.smoothing ?? true;
  const warn = (code: string, message: string): void => {
    context.onWarning?.(code, message, object.id);
  };

  if (!object.ctm) {
    warn('W_IMAGE_NO_CTM', '图片缺少 CTM，按 identity 单位矩形绘制');
  }

  const selected = selectImage(context, object, warn);
  const mask = selectMask(context, object, warn);

  // 图片始终以单位矩形绘制：当前空间若已含对象 CTM，identity 即正确；
  // 无 CTM 且 strictImageCtm=false 时，用 Boundary 尺寸补一个缩放。
  renderer.save();
  if (!object.ctm && !strict) {
    renderer.transform(scaleMatrix(IDENTITY_MATRIX, object.boundary.w, object.boundary.h));
  }
  renderer.drawImage(selected, IDENTITY_MATRIX, 1, smoothing, mask);
  renderer.restore();

  drawBorder(context, object, warn);
}

/**
 * 选择主图/替换图。
 *
 * @param context 绘制上下文。
 * @param object 图片对象。
 * @param warn warning 回调。
 * @returns 实际绘制的图片句柄。
 */
function selectImage(
  context: ImageDrawContext,
  object: ImageObject,
  warn: (code: string, message: string) => void,
): ImageHandle {
  const mode = context.substitutionMode ?? 'auto';
  const dpi = Number.isFinite(context.dpi) && (context.dpi as number) > 0 ? (context.dpi as number) : DEFAULT_DPI;
  const wantsSubstitution =
    Boolean(object.substitution) &&
    mode !== 'never' &&
    (mode === 'always' || dpi > 200);
  if (!wantsSubstitution) return context.image;
  if (context.substitutionImage) return context.substitutionImage;
  warn('W_IMAGE_DECODE', `替换图资源 ${object.substitution} 未解码，已回退主图`);
  return context.image;
}

/**
 * 选择蒙版句柄。
 *
 * @param context 绘制上下文。
 * @param object 图片对象。
 * @param warn warning 回调。
 * @returns 蒙版句柄；没有蒙版时返回 undefined。
 */
function selectMask(
  context: ImageDrawContext,
  object: ImageObject,
  warn: (code: string, message: string) => void,
): ImageHandle | undefined {
  if (!object.imageMask) return undefined;
  if (context.mask) return context.mask;
  warn('W_IMAGE_DECODE', `蒙版图资源 ${object.imageMask} 未解码，已忽略蒙版`);
  return undefined;
}

/**
 * 在对象空间绘制图片边框。
 *
 * 边框路径位于 `(0,0,Boundary.w,Boundary.h)`，支持圆角与虚线；线宽 ≤0 时按设计不画。
 * 通过逆 CTM 抵消当前空间中的图片变换，避免边框随图片旋转/缩放。
 *
 * @param context 绘制上下文。
 * @param object 图片对象。
 * @param warn warning 回调。
 */
function drawBorder(
  context: ImageDrawContext,
  object: ImageObject,
  warn: (code: string, message: string) => void,
): void {
  const border = object.border;
  if (!border || !(border.lineWidth > 0)) return;
  const width = Math.abs(object.boundary.w);
  const height = Math.abs(object.boundary.h);
  if (!(width > 0) || !(height > 0)) return;

  const inverse = invertMatrix(computeImageTransform(object, context.strictImageCtm ?? true));
  if (!inverse) {
    warn('W_BAD_PATH', '图片变换不可逆，边框已跳过');
    return;
  }
  const radiusX = Math.max(0, Math.min(border.horizontalRadius, width / 2));
  const radiusY = Math.max(0, Math.min(border.verticalRadius, height / 2));
  const drawStyle = normalizeDrawStyle({
    lineWidth: border.lineWidth,
    lineCap: 'Butt',
    lineJoin: 'Round',
    miterLimit: 4.234,
    dashOffset: border.dashOffset,
    dashPattern: border.dashPattern,
  });

  context.renderer.save();
  context.renderer.transform(inverse);
  emitRoundedRect(context.renderer, 0, 0, width, height, radiusX, radiusY);
  context.renderer.stroke(drawStyle, {
    kind: 'color',
    rgba: {
      r: border.color.r,
      g: border.color.g,
      b: border.color.b,
      a: border.color.a,
    },
  });
  context.renderer.restore();
}

/**
 * 输出圆角矩形路径（从左上角顺时针）。
 *
 * @param renderer 目标渲染器。
 * @param x 左上角 X，对象空间单位。
 * @param y 左上角 Y，对象空间单位。
 * @param width 宽，对象空间单位。
 * @param height 高，对象空间单位。
 * @param radiusX 水平圆角半径，已 clamp 到 [0,width/2]。
 * @param radiusY 垂直圆角半径，已 clamp 到 [0,height/2]。
 */
function emitRoundedRect(
  renderer: Renderer,
  x: number,
  y: number,
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
): void {
  const rx = radiusX;
  const ry = radiusY;
  renderer.beginPath();
  renderer.moveTo(x + rx, y);
  renderer.lineTo(x + width - rx, y);
  if (rx > 0 || ry > 0) {
    renderer.quadraticCurveTo(x + width, y, x + width, y + ry);
  }
  renderer.lineTo(x + width, y + height - ry);
  if (rx > 0 || ry > 0) {
    renderer.quadraticCurveTo(x + width, y + height, x + width - rx, y + height);
  }
  renderer.lineTo(x + rx, y + height);
  if (rx > 0 || ry > 0) {
    renderer.quadraticCurveTo(x, y + height, x, y + height - ry);
  }
  renderer.lineTo(x, y + ry);
  if (rx > 0 || ry > 0) {
    renderer.quadraticCurveTo(x, y, x + rx, y);
  }
  renderer.closePath();
}