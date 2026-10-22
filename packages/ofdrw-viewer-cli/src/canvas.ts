/**
 * Node Canvas 加载与适配。
 *
 * 普通 Node 从 node_modules 加载 `@napi-rs/canvas`；SEA 可执行文件由后续
 * 打包任务通过环境变量注入解压目录。engine 只依赖最小 Canvas 接口，这里
 * 负责把原生 Canvas/编码能力适配成 engine 的 `Canvas2DLike` / `EncodeImage`。
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as CanvasModule from '@napi-rs/canvas';
import type { Canvas2DLike } from '@ofdrw/ofdrw-viewer-engine';
import type { ImageFormat } from './output.js';

const require = createRequire(import.meta.url);

let cachedModule: typeof CanvasModule | undefined;

/**
 * 加载 `@napi-rs/canvas` 模块。
 *
 * 普通 Node 按包名解析；SEA 启动包装会先解压资产并设置 `OFDRW_CANVAS_DIR`
 * 与 `NAPI_RS_NATIVE_LIBRARY_PATH`，此处从资产目录加载。
 */
export function loadCanvasModule(): typeof CanvasModule {
  if (cachedModule === undefined) {
    const assetDir = process.env.OFDRW_CANVAS_DIR;
    cachedModule =
      assetDir === undefined || assetDir.trim() === ''
        ? (require('@napi-rs/canvas') as typeof CanvasModule)
        : (require(join(assetDir, 'canvas')) as typeof CanvasModule);
  }
  return cachedModule;
}

/**
 * 创建 engine 可用的离屏画布。
 *
 * @param width 画布宽度，设备像素
 * @param height 画布高度，设备像素
 */
export function createCanvasLike(width: number, height: number): Canvas2DLike {
  return loadCanvasModule().createCanvas(width, height) as unknown as Canvas2DLike;
}

/**
 * 把整页 Canvas 编码为指定格式的图片字节。
 *
 * PNG 输出无损、忽略质量；JPEG/WebP 使用传入质量（CLI 固定 0.9）。
 *
 * @param canvas engine 传入的整页画布
 * @param format 目标格式
 * @param quality 0..1 的编码质量
 * @returns 编码后的图片字节
 */
export function encodeCanvasImage(
  canvas: Canvas2DLike,
  format: ImageFormat,
  quality: number,
): Uint8Array {
  const nodeCanvas = canvas as unknown as CanvasModule.Canvas;
  switch (format) {
    case 'png':
      return nodeCanvas.toBuffer('image/png');
    case 'jpeg':
      return nodeCanvas.toBuffer('image/jpeg', quality);
    case 'webp':
      return nodeCanvas.toBuffer('image/webp', quality);
  }
}
