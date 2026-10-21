/**
 * mock 页面场景（harness 自检专用，不经过引擎）。
 *
 * 页面固定为 400×300 px @96 DPI（= 300×225 pt），用矩形/三角形/直线覆盖
 * 内容 bbox、关键色、位移与尺寸变化，并生成对应的最小 PDF 参考。
 * 场景坐标均为像素，左上原点；PDF 侧按 0.75 pt/px 换算并翻转 y 轴。
 */

import { createCanvas } from '@napi-rs/canvas';
import { buildMinimalPdf } from './minimal-pdf';
import { decodePng } from './image';
import type { ImageLike } from './types';

/** mock 页面宽度，像素。 */
export const MOCK_WIDTH = 400;
/** mock 页面高度，像素。 */
export const MOCK_HEIGHT = 300;
/** 96 DPI 下 1 px 对应的 pt 数。 */
const PT_PER_PX = 72 / 96;

/** mock 变体。 */
export type MockVariant = 'base' | 'shift1' | 'shift5' | 'color' | 'size' | 'blank' | 'no-triangle';

/** 场景绘制参数。 */
interface SceneOptions {
  offsetX: number;
  offsetY: number;
  /** 是否交换红/绿两块颜色。 */
  swapColors: boolean;
  /** 是否绘制蓝色三角形。 */
  triangle: boolean;
  /** 是否绘制黑色直线。 */
  line: boolean;
}

const DEFAULT_SCENE: SceneOptions = {
  offsetX: 0,
  offsetY: 0,
  swapColors: false,
  triangle: true,
  line: true,
};

/**
 * 在 2D 上下文绘制 mock 场景。
 *
 * @param ctx Canvas 2D 上下文（结构上与引擎 CanvasRenderingContext2DLike 兼容）。
 * @param options 场景参数。
 */
export function drawMockScene(
  ctx: {
    fillStyle: unknown;
    strokeStyle: unknown;
    lineWidth: number;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    closePath(): void;
    fill(): void;
    stroke(): void;
    fillRect(x: number, y: number, w: number, h: number): void;
  },
  options: SceneOptions = DEFAULT_SCENE,
): void {
  const { offsetX: ox, offsetY: oy } = options;
  // 红色矩形
  ctx.fillStyle = options.swapColors ? 'rgb(30, 122, 50)' : 'rgb(220, 20, 30)';
  ctx.fillRect(30 + ox, 40 + oy, 120, 100);
  // 蓝色三角形
  if (options.triangle) {
    ctx.fillStyle = 'rgb(20, 40, 200)';
    ctx.beginPath();
    ctx.moveTo(250 + ox, 40 + oy);
    ctx.lineTo(380 + ox, 40 + oy);
    ctx.lineTo(315 + ox, 130 + oy);
    ctx.closePath();
    ctx.fill();
  }
  // 绿色矩形
  ctx.fillStyle = options.swapColors ? 'rgb(220, 20, 30)' : 'rgb(30, 122, 50)';
  ctx.fillRect(80 + ox, 170 + oy, 60, 40);
  // 黑色直线
  if (options.line) {
    ctx.strokeStyle = 'rgb(0, 0, 0)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(40 + ox, 240 + oy);
    ctx.lineTo(300 + ox, 220 + oy);
    ctx.stroke();
  }
}

/** 变体到场景参数的映射。 */
function sceneForVariant(variant: MockVariant): SceneOptions {
  switch (variant) {
    case 'shift1':
      return { ...DEFAULT_SCENE, offsetX: 1, offsetY: 1 };
    case 'shift5':
      return { ...DEFAULT_SCENE, offsetX: 5, offsetY: 5 };
    case 'color':
      return { ...DEFAULT_SCENE, swapColors: true };
    case 'no-triangle':
      return { ...DEFAULT_SCENE, triangle: false };
    case 'blank':
      return DEFAULT_SCENE;
    case 'base':
    case 'size':
    default:
      return DEFAULT_SCENE;
  }
}

/**
 * 渲染 mock 页面为 RGBA 图像。
 *
 * @param variant 变体；`size` 使用 410×300 画布，`blank` 只留白底。
 * @returns 图像与 PNG 字节。
 */
export function renderMockCanvas(variant: MockVariant): { image: ImageLike; png: Uint8Array } {
  const width = variant === 'size' ? MOCK_WIDTH + 10 : MOCK_WIDTH;
  const height = MOCK_HEIGHT;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  if (variant !== 'blank') drawMockScene(ctx, sceneForVariant(variant));
  const png = new Uint8Array(canvas.toBuffer('image/png'));
  return { image: decodePng(png), png };
}

/** 构造与 `base` 场景一致的 PDF 参考（300×225 pt @96 DPI）。 */
export function buildMockReferencePdf(): Uint8Array {
  const widthPt = MOCK_WIDTH * PT_PER_PX;
  const heightPt = MOCK_HEIGHT * PT_PER_PX;
  const y = (pxY: number): number => heightPt - pxY * PT_PER_PX;
  const x = (pxX: number): number => pxX * PT_PER_PX;
  const rect = (pxX: number, pxY: number, w: number, h: number, rgb: readonly number[]): string =>
    `${rgb.join(' ')} rg\n${x(pxX)} ${y(pxY + h)} ${w * PT_PER_PX} ${h * PT_PER_PX} re f\n`;
  const triangle = [
    [250, 40],
    [380, 40],
    [315, 130],
  ]
    .map(([pxX, pxY], index) => `${x(pxX!)} ${y(pxY!)} ${index === 0 ? 'm' : 'l'}`)
    .join('\n');

  const content = [
    '1 1 1 rg',
    `0 0 ${widthPt} ${heightPt} re f`,
    rect(30, 40, 120, 100, [220 / 255, 20 / 255, 30 / 255]),
    `${20 / 255} ${40 / 255} ${200 / 255} rg`,
    `${triangle}`,
    'h f',
    rect(80, 170, 60, 40, [30 / 255, 122 / 255, 50 / 255]),
    '0 0 0 RG',
    '2.25 w',
    `${x(40)} ${y(240)} m ${x(300)} ${y(220)} l S`,
  ].join('\n');

  return buildMinimalPdf({ widthPt, heightPt, content });
}