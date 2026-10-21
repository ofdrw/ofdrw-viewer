/**
 * Node 测试用图片解码插件（PNG/JPEG/WebP）。
 *
 * 生产包不依赖 `@napi-rs/canvas`；该插件只在测试中通过
 * `OFDOpenOptions.imageDecoders` 注入，供引擎核心的 `PreparePageLoader.decodeImage`
 * 走平台解码路径。T7 的 `test/api` 与 QA 的黄金图/回归测试共用本 helper。
 *
 * 注意：JBIG2/TIFF 由 T5b 提供的专用插件负责，不在本 helper 范围内。
 */

import { loadImage } from '@napi-rs/canvas';
import type { DecodedImage } from '../../src/common/types';
import type { ImageDecoderPlugin } from '../../src/platform/image-decoder';
import { OFDError } from '../../src/errors';

/** `@napi-rs/canvas` 1.0.13 在 Node 端可解码的常见格式（与 OFD ImageFormat 命名一致）。 */
export const NODE_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;

/** 本 helper 支持的格式。 */
export type NodeImageFormat = (typeof NODE_IMAGE_FORMATS)[number];

/**
 * 创建一个 Node 图片解码插件。
 *
 * @param format 插件格式标识；必须与图片头部识别结果一致（例如 `png`、`jpeg`）。
 * @returns 基于 `@napi-rs/canvas.loadImage` 的解码插件。
 */
export function createNodeImageDecoderPlugin(format: string): ImageDecoderPlugin {
  const normalizedFormat = format.trim().toLowerCase();
  if (!normalizedFormat) {
    throw new Error('createNodeImageDecoderPlugin: format 不能为空');
  }
  return {
    format: normalizedFormat,
    /**
     * 解码图片字节。
     *
     * @param data 图片文件字节。
     * @returns 宽高与可被 Canvas2D `drawImage` 消费的 Node 图像对象。
     * @throws OFDError 解码失败或尺寸非法时（code=OFD_IMAGE_DECODE）。
     */
    async decode(data: Uint8Array): Promise<DecodedImage> {
      try {
        // loadImage 的 Buffer 路径最稳定；Buffer 视图共享原字节，不复制像素数据。
        const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const image = await loadImage(bytes);
        const width = image.naturalWidth > 0 ? image.naturalWidth : image.width;
        const height = image.naturalHeight > 0 ? image.naturalHeight : image.height;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error(`图片尺寸非法：${width} × ${height}`);
        }
        return { width, height, data: image, kind: 'source' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new OFDError('OFD_IMAGE_DECODE', `Node 图片解码失败（${normalizedFormat}）：${message}`, {
          cause: error,
        });
      }
    },
  };
}

/**
 * 批量创建 Node 图片解码插件。
 *
 * @param formats 需要支持的格式；默认覆盖 PNG/JPEG/WebP。
 * @returns 可直接传给 `OFDOpenOptions.imageDecoders` 的插件数组。
 */
export function createNodeImageDecoderPlugins(
  formats: readonly string[] = NODE_IMAGE_FORMATS,
): ImageDecoderPlugin[] {
  return formats.map((format) => createNodeImageDecoderPlugin(format));
}

/** 常用插件集合；测试可直接展开传给 `imageDecoders`。 */
export const nodeImageDecoders: readonly ImageDecoderPlugin[] = Object.freeze(
  createNodeImageDecoderPlugins(),
);