/**
 * 文档默认样式（设计方案附录 A）。
 *
 * 默认值只描述“文档默认”，对象类型默认值由 `StyleResolver` 按 kind 叠加；
 * 本函数返回的对象不可变，供注释/底纹 tile 作为 styleRoot。
 */

import type { Paint } from '../model/types';
import type { PaintSpec } from '../common/types';
import type { ResolvedStyle } from './types';
import { resolvePaint } from './paint';

/** 文档默认样式输入。 */
export interface DefaultStyleOptions {
  /** 默认线宽，单位 mm，默认 0.353。 */
  lineWidth?: number;
  /** 默认填充色；缺省黑色。 */
  fillColor?: Paint;
  /** 默认描边色；缺省黑色。 */
  strokeColor?: Paint;
}

/** 黑色不透明 PaintSpec。 */
const BLACK: PaintSpec = Object.freeze({ kind: 'color', rgba: Object.freeze({ r: 0, g: 0, b: 0, a: 255 }) });

/**
 * 创建文档默认 ResolvedStyle。
 *
 * @param options 默认值覆盖。
 * @returns 不可变默认样式；长度单位 mm，alpha 为 0..1。
 */
export function createDefaultStyle(options?: DefaultStyleOptions): ResolvedStyle {
  const fillPaint = options?.fillColor ? resolvePaint(options.fillColor) ?? BLACK : BLACK;
  const strokePaint = options?.strokeColor ? resolvePaint(options.strokeColor) ?? BLACK : BLACK;
  return Object.freeze({
    lineWidth: options?.lineWidth ?? 0.353,
    lineCap: 'Butt',
    lineJoin: 'Miter',
    miterLimit: 4.234,
    dashOffset: 0,
    dashPattern: [],
    fillPaint,
    strokePaint,
    fill: false,
    stroke: false,
    fillRule: 'nonzero',
    alpha: 1,
  });
}