/**
 * T6a 单测共用的假渲染器与样式/模型工厂。
 *
 * 只记录渲染器调用，不做真实绘制；T5 的 H5Canvas2DRenderer 未就绪时，
 * 用它验证 path/clip/image/paint/block 对 Renderer 契约的调用序列。
 */

import type {
  DecodedImage,
  DrawStyle,
  FillRule,
  ImageHandle,
  Matrix,
  ResolvedPaint,
  Viewport,
} from '../../../src/common/types';
import type {
  CanvasRenderingContext2DLike,
  GroupOptions,
  Renderer,
} from '../../../src/renderer/types';
import type { ResolvedStyle } from '../../../src/style/types';

/** 一次渲染器调用记录。 */
export interface RenderCall {
  op: string;
  args: unknown[];
}

/** 记录调用序列的假渲染器。 */
export class FakeRenderer implements Renderer {
  readonly calls: RenderCall[] = [];
  /** 指定操作名抛错，用于验证异常路径的 restore/endGroup。 */
  throwOn: string | null = null;

  beginPage(context: CanvasRenderingContext2DLike, viewport: Viewport): void {
    this.record('beginPage', context, viewport);
  }

  endPage(): void {
    this.record('endPage');
  }

  save(): void {
    this.record('save');
  }

  restore(): void {
    this.record('restore');
  }

  setTransform(m: Matrix): void {
    this.record('setTransform', m);
  }

  transform(m: Matrix): void {
    this.record('transform', m);
  }

  translate(x: number, y: number): void {
    this.record('translate', x, y);
  }

  multiplyAlpha(alpha: number): void {
    this.record('multiplyAlpha', alpha);
  }

  clear(): void {
    this.record('clear');
  }

  beginPath(): void {
    this.record('beginPath');
  }

  moveTo(x: number, y: number): void {
    this.record('moveTo', x, y);
  }

  lineTo(x: number, y: number): void {
    this.record('lineTo', x, y);
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.record('quadraticCurveTo', cpx, cpy, x, y);
  }

  cubicCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.record('cubicCurveTo', cp1x, cp1y, cp2x, cp2y, x, y);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.record('rect', x, y, w, h);
  }

  closePath(): void {
    this.record('closePath');
  }

  clip(rule: FillRule): void {
    this.record('clip', rule);
  }

  fill(style: DrawStyle, paint: ResolvedPaint, rule: FillRule): void {
    this.record('fill', style, paint, rule);
  }

  stroke(style: DrawStyle, paint: ResolvedPaint): void {
    this.record('stroke', style, paint);
  }

  createImage(image: DecodedImage): ImageHandle {
    this.record('createImage', image);
    return { width: image.width, height: image.height };
  }

  drawImage(
    image: ImageHandle,
    transform: Matrix,
    alpha: number,
    smoothing: boolean,
    mask?: ImageHandle,
  ): void {
    this.record('drawImage', image, transform, alpha, smoothing, mask);
  }

  beginGroup(options: GroupOptions): void {
    this.record('beginGroup', options);
  }

  endGroup(): void {
    this.record('endGroup');
  }

  close(): void {
    this.record('close');
  }

  /** 操作名序列。 */
  ops(): string[] {
    return this.calls.map((call) => call.op);
  }

  /** 取某一操作的全部调用。 */
  callsOf(op: string): RenderCall[] {
    return this.calls.filter((call) => call.op === op);
  }

  private record(op: string, ...args: unknown[]): void {
    if (this.throwOn === op) throw new Error(`fake renderer failed on ${op}`);
    this.calls.push({ op, args });
  }
}

/** 测试基线 ResolvedStyle（黑色填充、黑色描边、实线）。 */
export const BASE_STYLE: ResolvedStyle = {
  lineWidth: 0.353,
  lineCap: 'Butt',
  lineJoin: 'Miter',
  miterLimit: 4.234,
  dashOffset: 0,
  dashPattern: [],
  fill: true,
  stroke: true,
  fillRule: 'nonzero',
  alpha: 1,
  fillPaint: { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } },
  strokePaint: { kind: 'color', rgba: { r: 0, g: 0, b: 0, a: 255 } },
};

/** 创建测试用 ImageHandle。 */
export function imageHandle(width = 100, height = 50): ImageHandle {
  return { width, height };
}

/** 收集 warning 的辅助函数。 */
export function warningCollector(): {
  codes: string[];
  warnings: (code: string, message: string, id?: string) => void;
} {
  const codes: string[] = [];
  return {
    codes,
    warnings(code: string, _message: string, _id?: string) {
      codes.push(code);
    },
  };
}