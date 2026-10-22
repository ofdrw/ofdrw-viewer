/**
 * T15a smoke：page.exportImage / encodeImage 的 r8 契约类型。
 *
 * t60 才实现导出；此测试只锁公共类型形状与默认值文档口径，避免后续实现
 * 改签名。类型错误由 typecheck 直接暴露。
 */

import { describe, expect, it } from 'vitest';
import type { OFDOpenOptions as PublicOFDOpenOptions } from '@ofdrw/ofdrw-viewer-engine';
import type {
  EncodeImage,
  OFDOpenOptions,
  PageImageExportOptions,
  PageImageFormat,
  PageImageMime,
  PageImageResult,
} from '../../src/api/types';

describe('r8 页面图片导出契约', () => {
  it('参数、结果与编码钩子可组合', async () => {
    const options: PageImageExportOptions = {
      dpi: 144,
      format: 'png',
      quality: 0.92,
      background: null,
      signal: new AbortController().signal,
    };
    const result: PageImageResult = {
      data: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      width: 1,
      height: 1,
      dpi: 144,
    };
    const formats: PageImageFormat[] = ['png', 'jpeg', 'webp'];
    const mimeByFormat: Record<PageImageFormat, PageImageMime> = {
      png: 'image/png',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    };
    const encode: EncodeImage = async (canvas, format, quality) => {
      expect(canvas.width).toBeGreaterThan(0);
      expect(mimeByFormat[format]).toContain('/');
      expect(quality).toBeGreaterThan(0);
      return new Uint8Array([format.length]);
    };
    const open: OFDOpenOptions = {
      source: { kind: 'arraybuffer', data: new Uint8Array() },
      createCanvas: (width, height) => ({
        width,
        height,
        getContext: () => null,
      }),
      encodeImage: encode,
    };

    const publicOpen: PublicOFDOpenOptions = open;
    expect(publicOpen.encodeImage).toBe(encode);
    expect(result.mime).toBe('image/png');
    expect(formats).toHaveLength(3);
    expect(options.background).toBeNull();
  });
});
