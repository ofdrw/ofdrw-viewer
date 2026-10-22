/**
 * Node 侧图片解码插件。
 *
 * engine 核心不直接依赖原生图像库；PNG/JPEG/WebP 由 CLI 用
 * `@napi-rs/canvas.loadImage` 解码成可绘制对象后注入 `imageDecoders`。
 */

import { Buffer } from 'node:buffer';
import type { ImageDecoderPlugin } from 'ofdrw-viewer-engine';
import { loadCanvasModule } from './canvas.js';

/** 支持的宿主图片格式。 */
const NODE_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;

/**
 * 创建单个格式的解码插件。
 *
 * @param format 小写格式标识，与 engine 识别结果一致
 */
function createNodeImageDecoder(
  format: (typeof NODE_IMAGE_FORMATS)[number],
): ImageDecoderPlugin {
  return {
    format,
    async decode(data: Uint8Array) {
      const image = await loadCanvasModule().loadImage(Buffer.from(data));
      return {
        width: image.width,
        height: image.height,
        data: image,
        kind: 'source' as const,
      };
    },
  };
}

/** PNG/JPEG/WebP 解码插件，注入 `OFDOpenOptions.imageDecoders`。 */
export const nodeImageDecoders: readonly ImageDecoderPlugin[] = NODE_IMAGE_FORMATS.map(
  (format) => createNodeImageDecoder(format),
);
