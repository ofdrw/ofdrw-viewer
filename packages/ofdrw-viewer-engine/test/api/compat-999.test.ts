/**
 * 999.ofd 兼容性回归：非内嵌字体补充、页面积回退与注释空外观 warning 语义。
 *
 * 字体用例依赖本机 Windows 字体目录；目录不存在时 skip，不伪造通过。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OFDWarning } from '../../src/warnings';
import { openTestDocument, renderPage } from './helpers';

/** 999.ofd 路径。 */
const SAMPLE = fileURLToPath(
  new URL('../../../../ofd_pdf_match/999.ofd', import.meta.url),
);

/** 本机 Windows 字体目录（WSL 路径）。 */
const WINDOWS_FONTS = '/mnt/c/Windows/Fonts';

/** 引擎支持的字体扩展名。 */
const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;

/** 系统字体绝对路径；目录缺失时为空。 */
const FONT_PATHS = existsSync(WINDOWS_FONTS)
  ? readdirSync(WINDOWS_FONTS)
      .filter((name) => FONT_FILE.test(name))
      .sort()
      .map((name) => join(WINDOWS_FONTS, name))
  : [];

/** 读取样本字节。 */
function sampleBytes(): Uint8Array {
  return new Uint8Array(readFileSync(SAMPLE));
}

/** 渲染一页并返回 RGBA 像素。 */
async function renderPixels(doc: Awaited<ReturnType<typeof openTestDocument>>): Promise<Uint8ClampedArray> {
  const page = await doc.getPage(0);
  const { canvas, viewport } = await renderPage(page, { dpi: 48 });
  const context = canvas.canvas.getContext('2d');
  return context.getImageData(
    0,
    0,
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height)),
  ).data;
}

/** 统计两张同尺寸图片的像素差异数量。 */
function countDifferentPixels(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  let count = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 4) {
    if (
      Math.abs((left[index] ?? 0) - (right[index] ?? 0)) > 8 ||
      Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)) > 8 ||
      Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0)) > 8
    ) {
      count += 1;
    }
  }
  return count;
}

describe('999.ofd 兼容性回归', () => {
  it('空注释 Appearance 只提示一次', async () => {
    const warnings: OFDWarning[] = [];
    const doc = await openTestDocument(sampleBytes(), {
      onWarning: (warning) => warnings.push(warning),
    });
    try {
      await renderPixels(doc);
      expect(warnings.filter((warning) => warning.code === 'W_ANNOT_EMPTY')).toHaveLength(1);
      // 999 的页面 Area 完整，不应产生页面积回退 warning。
      expect(
        warnings.filter(
          (warning) =>
            warning.code === 'W_BAD_NUMBER' && /Area|PhysicalBox|回退/.test(warning.message),
        ),
      ).toEqual([]);
    } finally {
      await doc.close();
    }
  });

  it.skipIf(FONT_PATHS.length === 0)(
    '非内嵌字体从补充字体目录加载后 W_FONT_MISSING 归零且文字可见',
    async () => {
      const withoutFonts = await openTestDocument(sampleBytes());
      let withoutPixels: Uint8ClampedArray;
      try {
        withoutPixels = await renderPixels(withoutFonts);
      } finally {
        await withoutFonts.close();
      }

      const warnings: OFDWarning[] = [];
      // engine 不再读取本地路径：测试宿主先读成字节，再交给 supplementaryFonts。
      const supplementaryFonts = FONT_PATHS.map((path) => ({
        data: new Uint8Array(readFileSync(path)),
      }));
      const withFonts = await openTestDocument(sampleBytes(), {
        supplementaryFonts,
        onWarning: (warning) => warnings.push(warning),
      });
      let withPixels: Uint8ClampedArray;
      try {
        withPixels = await renderPixels(withFonts);
      } finally {
        await withFonts.close();
      }

      expect(warnings.filter((warning) => warning.code === 'W_FONT_MISSING')).toEqual([]);
      // 补充字体恢复 999 的正文文字；无字体时这些区域为空白。
      expect(countDifferentPixels(withoutPixels, withPixels)).toBeGreaterThan(500);
    },
    180_000,
  );
});