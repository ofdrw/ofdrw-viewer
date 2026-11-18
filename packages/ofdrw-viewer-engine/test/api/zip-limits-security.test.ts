/**
 * ZIP 单条目上限与总解压上限的安全边界回归。
 *
 * 单条目上限（`maxEntryBytes`）改为读取时判定后，必须确认两条边界仍然成立：
 * 1. 非音视频条目（图片）在读取时仍按 `maxEntryBytes` 拒绝；
 * 2. 总解压大小仍在打开阶段约束整个包。
 */

import { describe, expect, it } from 'vitest';
import { isOFDError } from '../../src/errors';
import type { OFDWarning } from '../../src/warnings';
import { buildFixtureOfd, createTestCanvas, openTestDocument } from './helpers';

/**
 * 取错误码。
 *
 * @param error 抛出的错误。
 * @returns OFD 错误码；非 OFDError 时返回其字符串表示。
 */
function code(error: unknown): string {
  return isOFDError(error) ? error.code : String(error);
}

/** 构造带一张声明为 Image 的资源、但底层条目为 80MiB 的包。 */
function bigImageOfd(size: number): Uint8Array {
  return buildFixtureOfd({
    pages: [
      {
        id: 1,
        widthMm: 100,
        heightMm: 100,
        objects: [
          {
            name: 'ofd:ImageObject',
            attrs: { ID: '21', Boundary: '10 10 20 20', ResourceID: '20', CTM: '20 0 0 20 0 0' },
          },
        ],
      },
    ],
    publicRes: [{ path: 'Doc_0/PublicRes.xml', children: [{
      name: 'ofd:MultiMedias', children: [{
        name: 'ofd:MultiMedia', attrs: { ID: 20, Type: 'Image', Format: 'PNG' },
        children: [{ name: 'ofd:MediaFile', children: ['big.png'] }],
      }],
    }] }],
    extraEntries: [{ name: 'Doc_0/big.png', data: new Uint8Array(size), method: 'store' }],
  });
}

describe('安全边界', () => {
  it('超过 maxEntryBytes 的图片条目：包可打开，但取图仍按 maxEntryBytes 拒绝', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(bigImageOfd(80 * 1024 * 1024), {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      // 打开成功：条目大小不再在打开阶段判定。
      const page = await doc.getPage(0);
      expect(page.index).toBe(0);
      // 图片读取仍按 maxEntryBytes 限流（decodeImage → container.read），超限不渲染该图。
      const viewport = page.getViewport({ dpi: 96 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createTestCanvas(width, height);
      await page.render({ canvasContext: canvas.context, viewport: { width, height, dpi: 96 } }).promise;
      const imageWarnings = warnings.filter((warning) => warning.code === 'W_IMAGE_DECODE');
      expect(
        imageWarnings.some((warning) => warning.message.includes('超过限制 67108864')),
      ).toBe(true);
    } finally {
      await doc.close();
    }
  }, 120_000);

  it('多个大条目累计超过 maxTotalUncompressedBytes 时打开阶段即拒绝', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: `Doc_0/blob${i}.bin`, data: new Uint8Array(60 * 1024 * 1024), method: 'store' as const,
    }));
    const bytes = buildFixtureOfd({
      pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [] }],
      extraEntries: entries,
    });
    const error = await openTestDocument(bytes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(code(error)).toBe('OFD_LIMIT_EXCEEDED');
  }, 120_000);
});
