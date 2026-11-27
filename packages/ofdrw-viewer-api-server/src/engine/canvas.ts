/**
 * `@napi-rs/canvas` 加载与 engine Canvas 适配。
 *
 * 普通 Node 从 node_modules 加载原生模块；打包版（SEA/单文件）可通过环境变量
 * `OFDRW_CANVAS_DIR` 指定解压目录，从该目录加载 `canvas`。engine 只依赖最小
 * Canvas 接口，这里把原生 Canvas 与图片编码适配成 `Canvas2DLike`/`EncodeImage`。
 *
 * SEA 产物中没有 `import.meta.url`，此时由入口通过 `OFDRW_SEA_NODE_MODULES`
 * 提供依赖解析根。
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as CanvasModule from '@napi-rs/canvas';
import type { Canvas2DLike, PageImageFormat } from '@ofdrw/ofdrw-viewer-engine';

const require = createRequire(resolveModuleBase());

/**
 * 计算 `createRequire` 的解析基准。
 *
 * 普通运行时使用本模块的 URL；SEA 中以解压出的依赖目录为基准
 * （打包产物中没有可用的 `import.meta.url`，会退回 `__filename`）。
 *
 * @returns 文件 URL 或绝对路径
 */
function resolveModuleBase(): string | URL {
  const seaRoot = process.env.OFDRW_SEA_NODE_MODULES;
  if (seaRoot !== undefined && seaRoot.trim() !== '') return join(seaRoot, 'index.js');
  // 打包产物中没有 import.meta.url，退回当前文件路径（同为绝对路径）。
  return import.meta.url ?? __filename;
}

/** 模块级缓存；同一进程只解析一次原生模块。 */
let cachedModule: typeof CanvasModule | undefined;

/**
 * 加载 `@napi-rs/canvas` 模块。
 *
 * `OFDRW_CANVAS_DIR` 非空时从 `<OFDRW_CANVAS_DIR>/canvas` 加载，否则按包名解析。
 *
 * @returns 原生 Canvas 模块
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
 * @param width 画布宽度，单位：设备像素
 * @param height 画布高度，单位：设备像素
 * @returns engine `Canvas2DLike`
 */
export function createCanvasLike(width: number, height: number): Canvas2DLike {
  return loadCanvasModule().createCanvas(width, height) as unknown as Canvas2DLike;
}

/**
 * 把整页 Canvas 编码为指定格式的图片字节。
 *
 * PNG 无损并忽略质量；JPEG/WebP 使用传入质量。
 *
 * @param canvas engine 传入的整页画布
 * @param format 目标格式 `png`/`jpeg`/`webp`
 * @param quality 编码质量，0..1，仅 JPEG/WebP 生效
 * @returns 编码后的图片字节
 */
export function encodeCanvasImage(
  canvas: Canvas2DLike,
  format: PageImageFormat,
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