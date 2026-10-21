/**
 * 平台图片解码接口。
 *
 * 内置 PNG/JPEG 走宿主解码；JBIG2/TIFF 通过 ImageDecoderPlugin 动态注入。
 * 核心只负责读字节、识别格式与缓存，不绑定具体平台图像类型。
 */

import type { DecodedImage } from '../common/types';

/** 图片解码插件；`format` 与图片头部/扩展名识别结果匹配（例如 `jbig2`、`tiff`）。 */
export interface ImageDecoderPlugin {
  /** 插件格式标识，小写字符串。 */
  format: string;
  /**
   * 解码完整图片字节。
   *
   * @param data 图片文件字节。
   * @returns 宽高与平台可绘制数据/对象。
   */
  decode(data: Uint8Array): Promise<DecodedImage>;
}

/** 宿主图片解码器；用于 PNG/JPEG/WebP 等平台原生格式。 */
export interface ImageDecoder {
  /**
   * 解码图片。
   *
   * @param data 图片文件字节。
   * @param hint 可选格式提示；缺省由实现根据 magic 判断。
   * @returns 宽高与平台可绘制数据/对象。
   */
  decode(data: Uint8Array, hint?: { format?: string }): Promise<DecodedImage>;
}