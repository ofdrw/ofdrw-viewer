import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearSystemSupplementaryFontCache,
  loadSystemSupplementaryFonts,
  systemSupplementaryFontDescription,
} from './lib/system-fonts';

/** 覆盖字体路径的环境变量名，与 system-fonts 实现一致。 */
const FONT_PATH_ENV = 'GOLDEN_SUPPLEMENTARY_FONT';

describe('黄金图 harness 补充字体懒加载', () => {
  it('发现阶段只检查路径，不读取字体字节', () => {
    const previous = process.env[FONT_PATH_ENV];
    const directory = mkdtempSync(join(tmpdir(), 'ofd-lazy-font-'));
    process.env[FONT_PATH_ENV] = directory;
    clearSystemSupplementaryFontCache();
    try {
      // 目录被当作字体路径时 existsSync 仍为 true；若发现阶段读取会抛 EISDIR。
      const fonts = loadSystemSupplementaryFonts();
      expect(fonts).toHaveLength(1);
      expect(fonts[0]?.family).toBe('GOLDEN_SUPPLEMENTARY_FONT');
      expect(systemSupplementaryFontDescription()).toEqual([directory]);
    } finally {
      clearSystemSupplementaryFontCache();
      if (previous === undefined) delete process.env[FONT_PATH_ENV];
      else process.env[FONT_PATH_ENV] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('宿主无字体文件时安全降级为空列表', () => {
    const previous = process.env[FONT_PATH_ENV];
    process.env[FONT_PATH_ENV] = join(tmpdir(), 'ofd-not-exist-font.ttf');
    clearSystemSupplementaryFontCache();
    try {
      expect(loadSystemSupplementaryFonts()).toEqual([]);
      expect(systemSupplementaryFontDescription()).toEqual([]);
    } finally {
      clearSystemSupplementaryFontCache();
      if (previous === undefined) delete process.env[FONT_PATH_ENV];
      else process.env[FONT_PATH_ENV] = previous;
    }
  });
});