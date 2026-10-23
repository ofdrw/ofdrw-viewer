/**
 * defaultFonts 缺省字体单元测试（对应 docs/渲染字体缺省方案设计.md §4-§6、§11）。
 *
 * 复用 `test/font/fixtures.ts` 的字体 fixture；来源缺失时显式 skip，
 * 不联网、不依赖运行环境里的真实系统字体。
 */

import { describe, expect, it } from 'vitest';
import { FontLibrary, resolveGlyph } from '../../src/font/provider';
import type { FontResource } from '../../src/model/types';
import type { FontInput, FontProvider } from '../../src/platform/font-provider';
import type { FontWarningCallback } from '../../src/font/types';
import { ensureFixtures, readFixture } from './fixtures';

const fixtures = ensureFixtures();

/**
 * 构造字体资源。
 *
 * @param overrides 覆盖字段。
 * @returns 字体资源。
 */
function makeFontResource(overrides: Partial<FontResource> = {}): FontResource {
  return {
    id: '1',
    fontName: 'DejaVu Sans',
    charset: 'unicode',
    serif: false,
    bold: false,
    italic: false,
    fixedSize: false,
    ...overrides,
  };
}

/**
 * 构造内存字节来源的字体输入。
 *
 * @param path 字体 fixture 路径。
 * @param family 可选 family；缺省时由 FontLibrary 生成 default-&lt;index&gt;。
 * @returns 字体输入。
 */
function dataInput(path: string, family?: string): FontInput {
  const data = readFixture(path);
  return family === undefined ? { data } : { data, family };
}

/**
 * 收集字体层 warning。
 *
 * @returns warning 回调与消息数组。
 */
function collectWarnings(): { callback: FontWarningCallback; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    callback: (code, message) => warnings.push(`${code}:${message}`),
  };
}

describe('defaultFonts 主字体选择', () => {
  it.skipIf(!fixtures.dejavu)('无内嵌/无 provider 时作为主字体', async () => {
    const library = new FontLibrary({
      defaultFonts: [dataInput(fixtures.dejavu as string, 'DejaVu Sans')],
    });
    const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));

    expect(faces).not.toBeNull();
    expect(faces?.primary.key.startsWith('default:')).toBe(true);
    expect(faces?.primary.family).toContain('DejaVu');
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu || !fixtures.cjkTtf)(
    '优先于 supplementaryFonts：即使补充字体名称更匹配，默认字体仍作主字体',
    async () => {
      const library = new FontLibrary({
        defaultFonts: [dataInput(fixtures.dejavu as string, 'DejaVu Sans')],
        supplementaryFonts: [
          { data: readFixture(fixtures.cjkTtf as string), family: 'Droid Sans Fallback' },
        ],
      });
      const faces = await library.resolve(makeFontResource({ fontName: 'Droid Sans Fallback' }));

      // §4.1 固定优先级：default 先于 supplementary，不按跨层评分反超。
      expect(faces?.primary.family).toContain('DejaVu');
      expect(faces?.fallbacks.some((face) => face.family.includes('Droid'))).toBe(true);
      library.dispose();
    },
  );

  it.skipIf(!fixtures.dejavu || !fixtures.cjkTtf)(
    '多个 defaultFonts 按字体名评分选择，而非取第一个',
    async () => {
      const library = new FontLibrary({
        defaultFonts: [
          dataInput(fixtures.cjkTtf as string, 'Droid Sans Fallback'),
          dataInput(fixtures.dejavu as string, 'DejaVu Sans'),
        ],
      });
      // 第一个来源与请求无关；评分后应选中第二项。
      const faces = await library.resolve(makeFontResource({ fontName: 'DejaVu Sans' }));

      expect(faces?.primary.family).toContain('DejaVu');
      library.dispose();
    },
  );

  it.skipIf(!fixtures.notoTtc)('TTC/OTC 展开全部字体面参与评分', async () => {
    const bytes = readFixture(fixtures.notoTtc as string);
    const library = new FontLibrary({ defaultFonts: [{ data: bytes }] });
    const sc = await library.resolve(
      makeFontResource({
        fontName: 'Noto Serif CJK SC',
        familyName: 'Noto Serif CJK SC',
      }),
    );
    const jp = await library.resolve(
      makeFontResource({
        id: '2',
        fontName: 'Noto Serif CJK JP',
        familyName: 'Noto Serif CJK JP',
      }),
    );

    expect(sc?.primary.family).toContain('Noto Serif CJK SC');
    expect(jp?.primary.family).toContain('Noto Serif CJK JP');
    library.dispose();
  });
});

describe('defaultFonts 与精确来源', () => {
  it.skipIf(!fixtures.dejavu)('内嵌字体命中时不作为主字体', async () => {
    const font = makeFontResource({ fontFile: 'Res/embedded.ttf' });
    const library = new FontLibrary({
      defaultFonts: [dataInput(fixtures.dejavu as string, 'DejaVu Sans')],
    });
    library.registerEmbedded(font, readFixture(fixtures.dejavu as string));
    const faces = await library.resolve(font);

    expect(faces?.primary.key.startsWith('embedded:')).toBe(true);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu || !fixtures.cjkTtf)('provider 命中时不作为主字体', async () => {
    const provider: FontProvider = {
      async match() {
        return { data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' };
      },
    };
    const library = new FontLibrary({
      fontProvider: provider,
      defaultFonts: [dataInput(fixtures.cjkTtf as string, 'Droid Sans Fallback')],
    });
    const faces = await library.resolve(makeFontResource({ fontName: 'DejaVu Sans' }));

    // provider 返回的 DejaVu 是精确来源，默认的 Droid 不参与主字体选择。
    expect(faces?.primary.family).toContain('DejaVu');
    expect(faces?.primary.family).not.toContain('Droid');
    library.dispose();
  });
});

describe('defaultFonts 显式 GID 与缓存', () => {
  it.skipIf(!fixtures.dejavu)('替代字体 explicitGlyphs=false：CGTransform 显式 GID 被忽略并走 cmap', async () => {
    const library = new FontLibrary({
      defaultFonts: [dataInput(fixtures.dejavu as string, 'DejaVu Sans')],
    });
    const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(faces?.primary.explicitGlyphs).toBe(false);

    // DejaVu 的 'A'（U+0041）cmap gid 为 36；显式给 37 时应被忽略并返回 36。
    const resolved = resolveGlyph(0x41, 37, faces!);
    expect(resolved).not.toBeNull();
    expect(resolved?.explicit).toBeUndefined();
    expect(resolved?.face).toBe(faces?.primary);
    expect(resolved?.glyph.id).toBe(36);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('clear() 后重新解析 defaultFonts', async () => {
    const library = new FontLibrary({
      defaultFonts: [dataInput(fixtures.dejavu as string, 'DejaVu Sans')],
    });

    const first = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(first?.primary.family).toContain('DejaVu');

    library.clear();
    const second = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(second?.primary.family).toContain('DejaVu');
    // clear() 丢弃字体面缓存，重新解析应产生新的实例。
    expect(second).not.toBe(first);
    expect(second?.primary).not.toBe(first?.primary);
    library.dispose();
  });
});

describe('defaultFonts 失败降级与回退链', () => {
  it.skipIf(!fixtures.dejavu)('来源缺少 data 只 warning 并继续后续来源', async () => {
    const { callback, warnings } = collectWarnings();
    const legacy = [
      { path: '/fonts/null.ttf', family: 'Null Font' },
      { url: 'https://example.test/font.ttf', family: 'Url Font' },
    ] as unknown as FontInput[];
    const library = new FontLibrary({
      defaultFonts: [...legacy, dataInput(fixtures.dejavu as string, 'DejaVu Sans')],
      onWarning: callback,
    });

    const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(faces?.primary.family).toContain('DejaVu');
    expect(warnings.filter((warning) => warning.includes('字体来源缺少 data'))).toHaveLength(2);
    expect(warnings.every((warning) => warning.includes('W_FONT_MISSING'))).toBe(true);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu || !fixtures.broken)(
    '单个来源解析失败只 warning 并继续后续来源',
    async () => {
      const { callback, warnings } = collectWarnings();
      const library = new FontLibrary({
        defaultFonts: [
          { data: readFixture(fixtures.broken as string), family: 'Broken Font' },
          dataInput(fixtures.dejavu as string, 'DejaVu Sans'),
        ],
        onWarning: callback,
      });

      const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
      expect(faces?.primary.family).toContain('DejaVu');
      expect(warnings.some((warning) => warning.includes('字体解析失败'))).toBe(true);
      library.dispose();
    },
  );

  it.skipIf(!fixtures.dejavu || !fixtures.cjkTtf)(
    '单个来源超过 maxFontBytes 时 warning 并继续后续来源',
    async () => {
      const { callback, warnings } = collectWarnings();
      const library = new FontLibrary({
        // Droid 约 4 MiB 超限；DejaVu 约 760 KiB 仍可解析。
        defaultFonts: [
          dataInput(fixtures.cjkTtf as string, 'Droid Sans Fallback'),
          dataInput(fixtures.dejavu as string, 'DejaVu Sans'),
        ],
        maxFontBytes: 1024 * 1024,
        onWarning: callback,
      });

      const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
      expect(faces?.primary.family).toContain('DejaVu');
      expect(warnings.some((warning) => warning.includes('超过'))).toBe(true);
      library.dispose();
    },
  );

  it.skipIf(!fixtures.dejavu || !fixtures.cjkTtf)(
    '内嵌字体命中时 defaultFonts 仍进入逐字形回退链',
    async () => {
      const font = makeFontResource({ fontFile: 'Res/embedded.ttf' });
      const library = new FontLibrary({
        defaultFonts: [dataInput(fixtures.cjkTtf as string, 'Droid Sans Fallback')],
      });
      library.registerEmbedded(font, readFixture(fixtures.dejavu as string));
      const faces = await library.resolve(font);

      expect(faces?.primary.key.startsWith('embedded:')).toBe(true);
      expect(faces?.fallbacks.some((face) => face.family.includes('Droid'))).toBe(true);
      library.dispose();
    },
  );
});

describe('defaultFonts 兼容性', () => {
  it.skipIf(!fixtures.dejavu)('不传 defaultFonts 时保持原有行为', async () => {
    const { callback, warnings } = collectWarnings();
    const library = new FontLibrary({
      supplementaryFonts: [dataInput(fixtures.dejavu as string, 'DejaVu Sans')],
      onWarning: callback,
    });
    const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(faces?.primary.family).toContain('DejaVu');
    expect(warnings).toEqual([]);

    // 无任何字体来源时仍是 null + W_FONT_MISSING（r11 行为）。
    const empty = new FontLibrary({ onWarning: callback });
    expect(await empty.resolve(makeFontResource())).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('W_FONT_MISSING');

    library.dispose();
    empty.dispose();
  });
});