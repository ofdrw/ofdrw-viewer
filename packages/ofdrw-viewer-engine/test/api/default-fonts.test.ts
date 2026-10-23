/**
 * engine 集成用例：无内嵌字体文档 + defaultFonts → 文字实际绘制、W_FONT_MISSING 消失。
 *
 * 对应设计 §11 集成矩阵；复用 test/api 的合成 OFD 包与 test/font 的字体 fixture，
 * 不依赖真实 OFD 样本或系统字体安装位置。
 */

import { describe, expect, it } from 'vitest';
import type { OFDWarning } from '../../src/warnings';
import type { FontInput } from '../../src/platform/font-provider';
import type { XmlElementSpec } from '../fixtures/xml';
import { ensureFixtures, readFixture } from '../font/fixtures';
import { buildFixtureOfd, openTestDocument, renderPage } from './helpers';

const fixtures = ensureFixtures();

/**
 * 构造文本对象。
 *
 * @param id 对象 ID。
 * @param text 文本内容。
 * @returns TextObject XML 描述。
 */
function textObject(id: number, text: string): XmlElementSpec {
  return {
    name: 'ofd:TextObject',
    attrs: { ID: id, Boundary: '10 10 60 20', Font: 1, Size: 10 },
    children: [
      {
        name: 'ofd:TextCode',
        attrs: { X: 0, Y: 10 },
        children: [text],
      },
    ],
  };
}

/**
 * 构造 100×100mm 的测试 OFD：字体资源只有名称、没有内嵌 FontFile。
 *
 * @param text 页面文本。
 * @returns OFD ZIP 字节。
 */
function buildTextOfd(text: string): Uint8Array {
  return buildFixtureOfd({
    pages: [{ id: 1, widthMm: 100, heightMm: 100, objects: [textObject(1, text)] }],
    documentRes: [
      {
        path: 'Doc_0/Res/Res.xml',
        children: [
          {
            name: 'ofd:Fonts',
            children: [
              {
                name: 'ofd:Font',
                attrs: {
                  ID: 1,
                  FontName: 'Fixture Missing Font',
                  FamilyName: 'Fixture Missing Font',
                  Charset: 'unicode',
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * 渲染首页并统计深色像素与 warning。
 *
 * @param bytes OFD 字节。
 * @param defaultFonts 可选的默认字体输入。
 * @returns 深色像素数与 warning 列表。
 */
async function renderDarkPixels(
  bytes: Uint8Array,
  defaultFonts?: readonly FontInput[],
): Promise<{ dark: number; warnings: OFDWarning[] }> {
  const warnings: OFDWarning[] = [];
  const doc = await openTestDocument(bytes, {
    ...(defaultFonts ? { defaultFonts } : {}),
    onWarning: (warning) => warnings.push(warning),
  });
  try {
    const page = await doc.getPage(0);
    const { canvas, viewport } = await renderPage(page, { dpi: 96 });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const data = canvas.canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index] ?? 255) < 128) dark += 1;
    }
    return { dark, warnings };
  } finally {
    await doc.close();
  }
}

describe('defaultFonts engine 集成', () => {
  it.skipIf(!fixtures.dejavu)(
    '无内嵌字体 + defaultFonts：文字实际绘制且 W_FONT_MISSING 消失',
    async () => {
      const bytes = buildTextOfd('AB');

      // 不传 defaultFonts：与 r11 一致，文字对象被跳过，页面空白且报缺字体。
      const without = await renderDarkPixels(bytes);
      expect(without.warnings.some((warning) => warning.code === 'W_FONT_MISSING')).toBe(true);
      expect(without.dark).toBe(0);

      // 传入 defaultFonts：整段文字用默认字体替代，warning 消失。
      const withDefault = await renderDarkPixels(bytes, [
        { data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' },
      ]);
      expect(withDefault.warnings.some((warning) => warning.code === 'W_FONT_MISSING')).toBe(false);
      expect(withDefault.dark).toBeGreaterThan(0);
    },
  );
});