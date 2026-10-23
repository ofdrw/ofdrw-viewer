/**
 * 印章图片与时间格式化单元测试。
 *
 * 覆盖 MIME 推断、Blob URL 生命周期、缺失/矢量/未知格式降级，以及 UTC+8
 * 固定格式；不依赖运行环境时区。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createSealImageElement,
  sealImageMime,
} from '../../../src/crypto/seal-image';
import { formatShanghaiDateTime } from '../../../src/crypto/time';
import { captureDownloads } from '../../helpers/environment';
import type { DownloadCapture } from '../../helpers/environment';

/** 最小 PNG 头 + 任意字节，仅用于 MIME/对象 URL 断言。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let capture: DownloadCapture | null = null;

afterEach(() => {
  capture?.restore();
  capture = null;
});

describe('formatShanghaiDateTime', () => {
  it('把 UTC 时间固定换算为 Asia/Shanghai（UTC+8）', () => {
    expect(formatShanghaiDateTime('2026-10-23T07:59:26.000Z')).toBe('2026-10-23 15:59:26');
    expect(formatShanghaiDateTime('2026-10-22T17:51:06Z')).toBe('2026-10-23 01:51:06');
    expect(formatShanghaiDateTime('2026-01-01T00:00:00+08:00')).toBe('2026-01-01 00:00:00');
  });

  it('缺失或非法时间返回 undefined', () => {
    expect(formatShanghaiDateTime(undefined)).toBeUndefined();
    expect(formatShanghaiDateTime('')).toBeUndefined();
    expect(formatShanghaiDateTime('not-a-date')).toBeUndefined();
  });
});

describe('sealImageMime', () => {
  it('大小写/别名归一化', () => {
    expect(sealImageMime('PNG')).toBe('image/png');
    expect(sealImageMime('jpg')).toBe('image/jpeg');
    expect(sealImageMime('JPEG')).toBe('image/jpeg');
    expect(sealImageMime('svg')).toBe('image/svg+xml');
  });

  it('OFD 矢量与未知格式不映射为位图 MIME', () => {
    expect(sealImageMime('ofd')).toBeUndefined();
    expect(sealImageMime('tiff')).toBeUndefined();
  });
});

describe('createSealImageElement', () => {
  it('有图片字节时生成带 alt、按 mm 比例与可释放 Blob URL 的 img', () => {
    capture = captureDownloads();
    const handle = createSealImageElement(
      document,
      { format: 'PNG', widthMm: 40, heightMm: 40, data: PNG_BYTES },
      { label: '测试印章' },
    );
    expect(handle).not.toBeNull();
    const image = handle!.element.querySelector('img');
    expect(image).not.toBeNull();
    expect(image!.alt).toBe('印章图片：测试印章');
    expect(image!.getAttribute('src')).toBe('blob:ofd-test-1');
    expect(image!.style.width).toBe('151.18110236220474px');
    expect(handle!.element.querySelector('figcaption')?.textContent).toContain('40 × 40 mm');
    expect(capture.blobs.get('blob:ofd-test-1')?.type).toBe('image/png');
    expect(capture.blobs.get('blob:ofd-test-1')?.size).toBe(PNG_BYTES.byteLength);

    handle!.revoke();
    handle!.revoke();
    expect(capture.revoked).toEqual(['blob:ofd-test-1']);
  });

  it('缺少图片字节时输出文字降级而不是空图', () => {
    const handle = createSealImageElement(
      document,
      { format: 'PNG', widthMm: 40, heightMm: 40 },
      { label: '缺失章' },
    );
    expect(handle?.element.querySelector('img')).toBeNull();
    expect(handle?.element.textContent).toContain('印章图片数据缺失');
  });

  it('OFD 矢量章给出不可直接预览的明确降级', () => {
    const handle = createSealImageElement(
      document,
      { format: 'ofd', widthMm: 40, heightMm: 40, data: PNG_BYTES },
      { label: '矢量章' },
    );
    expect(handle?.element.textContent).toContain('矢量（OFD）');
    expect(handle?.element.textContent).toContain('覆盖层');
  });

  it('未知格式保留格式名并降级', () => {
    const handle = createSealImageElement(
      document,
      { format: 'tiff', widthMm: 40, heightMm: 40, data: PNG_BYTES },
      { label: '未知章' },
    );
    expect(handle?.element.textContent).toContain('tiff');
    expect(handle?.element.querySelector('img')).toBeNull();
  });

  it('无图片信息时返回 null', () => {
    expect(createSealImageElement(document, undefined, { label: 'x' })).toBeNull();
  });
});