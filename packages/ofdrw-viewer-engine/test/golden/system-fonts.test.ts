import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_SANS_FONT_PATH,
  BUNDLED_SERIF_FONT_PATH,
  clearSystemSupplementaryFontCache,
  loadSystemSupplementaryFonts,
  systemSupplementaryFontDescription,
  systemSupplementaryFontFamilies,
} from './lib/system-fonts';

describe('黄金图 harness 补充字体', () => {
  it('仓库自带思源宋体与思源黑体，不依赖机器安装的字体', () => {
    expect(existsSync(BUNDLED_SERIF_FONT_PATH)).toBe(true);
    expect(existsSync(BUNDLED_SANS_FONT_PATH)).toBe(true);
    clearSystemSupplementaryFontCache();
    const fonts = loadSystemSupplementaryFonts();
    expect(fonts.length).toBeGreaterThan(0);
    expect(systemSupplementaryFontDescription()).toEqual([
      BUNDLED_SERIF_FONT_PATH,
      BUNDLED_SANS_FONT_PATH,
    ]);
  });

  it('衬线与无衬线族名都命中仓库字体', () => {
    clearSystemSupplementaryFontCache();
    const families = systemSupplementaryFontFamilies();
    expect(families).toContain('SimSun');
    expect(families).toContain('FangSong');
    expect(families).toContain('Times New Roman');
    expect(families).toContain('Noto Sans CJK SC');
    expect(families).toContain('KaiTi');
    expect(families).toContain('Tahoma');
  });

  it('发现阶段只检查路径，不读取字体字节', () => {
    clearSystemSupplementaryFontCache();
    const fonts = loadSystemSupplementaryFonts();
    // 惰性来源在读取前不持有字节；读取一次后才缓存。
    for (const font of fonts) {
      expect(font.family).toBeTruthy();
    }
    const serif = fonts.find((font) => font.family === 'SimSun');
    expect(serif).toBeDefined();
    const first = serif!.data;
    expect(first.byteLength).toBeGreaterThan(0);
    expect(serif!.data).toBe(first);
  });
});