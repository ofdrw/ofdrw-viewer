/**
 * 作业参数与状态的公共类型。
 *
 * 供 `jobs.ts` 与路由层共享，避免循环引用。
 */

import type { ImageFormat } from './params.js';

/** 归一化后的作业参数。 */
export interface JobParams {
  /** 要执行的解析项。 */
  readonly ops: readonly ('images' | 'text' | 'media' | 'attachments')[];
  /** 选中的页号；`undefined` 表示全部页。 */
  readonly pages: readonly number[] | undefined;
  /** 输出 DPI。 */
  readonly dpi: number;
  /** 图片格式。 */
  readonly format: ImageFormat;
  /** JPEG/WebP 编码质量。 */
  readonly quality: number;
  /** 媒体类型过滤。 */
  readonly mediaKind: 'video' | 'audio' | undefined;
  /** 媒体资源 ID 过滤。 */
  readonly mediaId: string | undefined;
  /** 有效期秒数；`-1` 表示永不过期。 */
  readonly ttlSec: number;
}