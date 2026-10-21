/**
 * 渲染器测试辅助：Node canvas 适配、像素读取与计数工厂。
 *
 * 测试文件不属于引擎源码，可以直接依赖 `@napi-rs/canvas`；引擎源码本身不依赖它。
 */

import { createCanvas } from '@napi-rs/canvas';
import type {
  Canvas2DLike,
  CanvasFactoryEntry,
  CanvasRenderingContext2DLike,
} from '../../src/renderer/types';

/** Node canvas 与上下文。 */
export interface NodeCanvasEntry {
  canvas: Canvas2DLike;
  context: CanvasRenderingContext2DLike;
}

/**
 * 创建 Node canvas 并适配成引擎的最小 Canvas 接口。
 *
 * @param width 宽，像素。
 * @param height 高，像素。
 * @returns 画布与上下文。
 */
export function createNodeCanvas(width: number, height: number): NodeCanvasEntry {
  const canvas = createCanvas(width, height) as unknown as Canvas2DLike;
  const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2DLike;
  return { canvas, context };
}

/** 读取单像素 RGBA。 */
export function readPixel(
  context: CanvasRenderingContext2DLike,
  x: number,
  y: number,
): [number, number, number, number] {
  const reader = context as unknown as {
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  };
  const data = reader.getImageData(x, y, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
}

/** 计数工厂；记录每次创建与销毁，便于断言内部 surface 生命周期。 */
export interface CountingFactory {
  /** 传给 H5Canvas2DRenderer 的 createCanvas。 */
  createCanvas(width: number, height: number): Canvas2DLike;
  /** 创建过的画布。 */
  created: Canvas2DLike[];
}

/**
 * 创建基于 Node canvas 的计数工厂。
 *
 * @returns 工厂与创建记录。
 */
export function createCountingFactory(): CountingFactory {
  const created: Canvas2DLike[] = [];
  return {
    created,
    createCanvas(width: number, height: number): Canvas2DLike {
      const canvas = createCanvas(width, height) as unknown as Canvas2DLike;
      created.push(canvas);
      return canvas;
    },
  };
}

/** 等待一帧，确保原生 canvas 的异步资源释放完成（Node 环境无真实帧）。 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 把 CanvasFactoryEntry 转成可读尺寸。
 *
 * @param entry 工厂条目。
 * @returns 宽高。
 */
export function entrySize(entry: CanvasFactoryEntry): { width: number; height: number } {
  return { width: entry.canvas.width, height: entry.canvas.height };
}