/**
 * 字体来源匹配、字体库缓存与逐字形回退测试（设计方案 12.2）。
 */

import { describe, expect, it } from 'vitest';
import type { FontInput, FontMatchRequest, FontProvider } from '../../src/platform/font-provider';
import type { FontResource } from '../../src/model/types';
import type { FontWarningCallback } from '../../src/font/types';
import {
  FontLibrary,
  fontResourceRequest,
  resolveGlyph,
} from '../../src/font/provider';
import {
  DEFAULT_FONT_ALIASES,
  expandFontName,
  fontNamesMatch,
  normalizeFontName,
} from '../../src/font/aliases';
import { ensureFixtures, readFixture } from './fixtures';
import { createFakeFace } from '../text-layout/fake-font';

const fixtures = ensureFixtures();

/** 缺少系统字体/样本内嵌字体时 skip；fixture 来源与 skip 策略见 test/font/README.md。 */

/** 构造字体资源。 */
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

/** 收集字体层 warning。 */
function collectWarnings(): { callback: FontWarningCallback; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    callback: (code, message) => warnings.push(`${code}:${message}`),
  };
}

describe('字体名别名', () => {
  it('归一化大小写/空格/标点', () => {
    expect(normalizeFontName('Microsoft YaHei')).toBe('microsoftyahei');
    expect(normalizeFontName(' 宋体 ')).toBe('宋体');
  });

  it('内置别名组互通', () => {
    expect(fontNamesMatch('宋体', 'SimSun')).toBe(true);
    expect(fontNamesMatch('黑体', 'SimHei')).toBe(true);
    expect(fontNamesMatch('楷体', 'KaiTi')).toBe(true);
    expect(fontNamesMatch('仿宋', 'FangSong')).toBe(true);
    expect(fontNamesMatch('小标宋体', 'HGXBS_CNKI')).toBe(true);
    expect(fontNamesMatch('小标宋体', '华光小标宋_CNKI')).toBe(true);
    expect(fontNamesMatch('微软雅黑', 'Microsoft YaHei')).toBe(true);
    expect(fontNamesMatch('Noto Serif CJK SC', '宋体')).toBe(true);
    expect(fontNamesMatch('DejaVu Sans', 'SimSun')).toBe(false);
    expect(fontNamesMatch('Nimbus Roman', 'Times New Roman')).toBe(true);
    expect(fontNamesMatch('NimbusRoman-Regular', 'Times New Roman')).toBe(true);
  });

  it('宿主可扩展别名组', () => {
    const aliases = [...DEFAULT_FONT_ALIASES, ['测试字体', 'Test Font']];
    expect(fontNamesMatch('测试字体', 'test-font', aliases)).toBe(true);
    expect(expandFontName('Test Font', aliases)).toContain('测试字体');
  });
});

describe('fontResourceRequest', () => {
  it('把 FontResource 转成 FontProvider 请求', () => {
    const resource = makeFontResource({
      fontName: '宋体',
      familyName: 'SimSun',
      charset: 'prc',
      bold: true,
      italic: true,
      serif: true,
      fixedSize: true,
    });
    expect(fontResourceRequest(resource)).toEqual({
      fontName: '宋体',
      familyName: 'SimSun',
      charset: 'prc',
      bold: true,
      italic: true,
      serif: true,
      fixedSize: true,
    });
  });
});

describe('FontLibrary 内嵌字体缓存', () => {
  it.skipIf(!fixtures.dejavu)('同一 fontFile + 字体名复用同一 FontFace', () => {
    const library = new FontLibrary();
    const first = makeFontResource({ id: '1', fontFile: 'Res/font.ttf' });
    const second = makeFontResource({ id: '2', fontFile: 'Res/font.ttf' });
    const bytes = readFixture(fixtures.dejavu as string);
    const faceA = library.registerEmbedded(first, bytes);
    const faceB = library.registerEmbedded(second, bytes);
    expect(faceA).not.toBeNull();
    expect(faceB).toBe(faceA);

    const faceC = library.registerEmbedded(
      makeFontResource({ id: '3', fontFile: 'Res/font.ttf', fontName: 'Other Name' }),
      bytes,
    );
    expect(faceC).not.toBe(faceA);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('FontResource 声明的粗/斜体参与合成样式判定', () => {
    const library = new FontLibrary();
    const face = library.registerEmbedded(
      makeFontResource({ id: '1', bold: true, italic: true, fontFile: 'Res/dejavu.ttf' }),
      readFixture(fixtures.dejavu as string),
    );
    expect(face?.bold).toBe(true);
    expect(face?.italic).toBe(true);
    library.dispose();
  });

  it.skipIf(!fixtures.notoTtc)('同一 TTC 按不同 FontName 选择不同字体面', () => {
    const library = new FontLibrary();
    const bytes = readFixture(fixtures.notoTtc as string);
    const sc = library.registerEmbedded(
      makeFontResource({ id: '1', fontName: 'Noto Serif CJK SC', fontFile: 'Res/noto.ttc' }),
      bytes,
    );
    const jp = library.registerEmbedded(
      makeFontResource({ id: '2', fontName: 'Noto Serif CJK JP', fontFile: 'Res/noto.ttc' }),
      bytes,
    );
    expect(sc?.family).toContain('SC');
    expect(jp?.family).toContain('JP');
    expect(sc).not.toBe(jp);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('解析失败时 warning 而非抛错', () => {
    const { callback, warnings } = collectWarnings();
    const library = new FontLibrary({ onWarning: callback });
    const face = library.registerEmbedded(
      makeFontResource({ id: '9', fontFile: 'Res/broken.ttf' }),
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(face).toBeNull();
    expect(warnings.some((warning) => warning.startsWith('W_FONT_MISSING'))).toBe(true);
    library.dispose();
  });
});

describe('FontLibrary 宿主 provider 与补充字体', () => {
  it.skipIf(!fixtures.dejavu)('调用 provider 并把返回字节解析为主字体', async () => {
    const requests: FontMatchRequest[] = [];
    const provider: FontProvider = {
      async match(request) {
        requests.push(request);
        return { data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' };
      },
    };
    const library = new FontLibrary({ fontProvider: provider });
    const resource = makeFontResource({ fontName: 'DejaVu Sans' });
    const faces = await library.resolve(resource);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(fontResourceRequest(resource));
    expect(faces?.primary.family).toContain('DejaVu');
    expect(faces?.fallbacks).toEqual([]);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('provider 返回替代 family 时不信任显式 gid', async () => {
    const provider: FontProvider = {
      async match() {
        return { data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' };
      },
    };
    const library = new FontLibrary({ fontProvider: provider });
    const faces = await library.resolve(makeFontResource({ fontName: 'Not The Font' }));
    expect(faces?.primary.family).toContain('DejaVu');
    expect(faces?.primary.explicitGlyphs).toBe(false);
    const resolved = resolveGlyph(0x41, 36, faces!);
    expect(resolved?.explicit).not.toBe(true);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('provider 抛错时 warning 并继续回退', async () => {
    const { callback, warnings } = collectWarnings();
    const provider: FontProvider = {
      match() {
        throw new Error('provider boom');
      },
    };
    const library = new FontLibrary({
      fontProvider: provider,
      supplementaryFonts: [{ data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' }],
      onWarning: callback,
    });
    const faces = await library.resolve(makeFontResource());
    expect(faces?.primary.family).toContain('DejaVu');
    expect(warnings.some((warning) => warning.includes('FontProvider 匹配失败'))).toBe(true);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('无 provider 时使用 loadInput 读取 url 来源', async () => {
    const loaded: FontInput[] = [];
    const provider: FontProvider = {
      async match() {
        return { url: 'https://example.test/font.ttf', family: 'DejaVu Sans' };
      },
    };
    const library = new FontLibrary({
      fontProvider: provider,
      loadInput(input) {
        loaded.push(input);
        return readFixture(fixtures.dejavu as string);
      },
    });
    const faces = await library.resolve(makeFontResource());
    expect(loaded).toHaveLength(1);
    expect(faces?.primary.family).toContain('DejaVu');
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('supplementaryFonts 的 path 来源经 loadInput 读取并采用实际 family', async () => {
    const loaded: FontInput[] = [];
    const library = new FontLibrary({
      supplementaryFonts: [{ path: fixtures.dejavu as string }],
      loadInput(input) {
        loaded.push(input);
        if (!('path' in input)) return null;
        return readFixture(input.path);
      },
    });
    const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(loaded).toEqual([{ path: fixtures.dejavu as string }]);
    expect(faces?.primary.family).toContain('DejaVu');
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu || !fixtures.embeddedCjk)('supplementaryFonts 作为缺字回退', async () => {
    const library = new FontLibrary({
      supplementaryFonts: [
        { data: readFixture(fixtures.embeddedCjk as string), family: 'SimSun' },
      ],
    });
    const libraryFaces = library.registerEmbedded(
      makeFontResource({ id: '1', fontName: 'DejaVu Sans', fontFile: 'Res/dejavu.ttf' }),
      readFixture(fixtures.dejavu as string),
    );
    expect(libraryFaces).not.toBeNull();
    const faces = await library.resolve(
      makeFontResource({ id: '1', fontName: 'DejaVu Sans', fontFile: 'Res/dejavu.ttf' }),
    );
    expect(faces).not.toBeNull();
    expect(faces?.fallbacks.length).toBeGreaterThan(0);

    const latin = resolveGlyph(0x41, undefined, faces!);
    expect(latin?.fallback).toBe(false);
    const cjk = resolveGlyph(0x4e2d, undefined, faces!);
    expect(cjk).not.toBeNull();
    expect(cjk?.fallback).toBe(true);
    expect(cjk?.glyph.id).toBe(1117);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('无内嵌/无 provider 时 supplementaryFonts 作为主字体', async () => {
    const library = new FontLibrary({
      supplementaryFonts: [{ data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' }],
    });
    const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(faces?.primary.family).toContain('DejaVu');
    expect(resolveGlyph(0x41, undefined, faces!)?.face).toBe(faces?.primary);
    library.dispose();
  });

  it('完全无字体时返回 null 并 W_FONT_MISSING', async () => {
    const { callback, warnings } = collectWarnings();
    const library = new FontLibrary({ onWarning: callback });
    const faces = await library.resolve(makeFontResource({ fontFile: 'missing.ttf' }));
    expect(faces).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('W_FONT_MISSING');
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('dispose 后 resolve 返回 null', async () => {
    const library = new FontLibrary();
    library.dispose();
    expect(await library.resolve(makeFontResource())).toBeNull();
  });
});

describe('resolveGlyph', () => {
  it.skipIf(!fixtures.dejavu || !fixtures.stripped)('显式 gid 只对主字体有效', () => {
    const library = new FontLibrary();
    const primary = library.registerEmbedded(
      makeFontResource({ id: '1', fontName: 'Subset', fontFile: 'Res/subset.otf' }),
      readFixture(fixtures.stripped as string),
    );
    expect(primary).not.toBeNull();
    const fallback = library.registerEmbedded(
      makeFontResource({ id: '2', fontName: 'DejaVu Sans', fontFile: 'Res/dejavu.ttf' }),
      readFixture(fixtures.dejavu as string),
    );
    const faces = { primary: primary!, fallbacks: [fallback!] };

    const explicit = resolveGlyph(0x4e2d, 11, faces);
    expect(explicit?.face).toBe(primary);
    expect(explicit?.glyph.id).toBe(11);

    // 主字体无 cmap 且无显式 gid 时，逐字形回退到 DejaVu（DejaVu 无“中”字形）。
    const missing = resolveGlyph(0x4e2d, undefined, faces);
    expect(missing).toBeNull();
    library.dispose();
  });
});
describe('resolveGlyph 与替代字体', () => {
  it('explicitGlyphs=false 时忽略显式 gid，改用 cmap/回退', () => {
    const primary = createFakeFace({
      explicitGlyphs: false,
      glyphs: [{ gid: 5, advanceWidth: 100 }],
    });
    const fallback = createFakeFace({
      glyphs: [{ gid: 7, advanceWidth: 200, codePoints: [0x4e2d] }],
    });
    const resolved = resolveGlyph(0x4e2d, 5, { primary, fallbacks: [fallback] });
    expect(resolved?.face).toBe(fallback);
    expect(resolved?.glyph.id).toBe(7);
    expect(resolved?.fallback).toBe(true);
  });

  it('explicitGlyphs=true 时优先使用显式 gid', () => {
    const primary = createFakeFace({
      explicitGlyphs: true,
      glyphs: [{ gid: 5, advanceWidth: 100 }],
    });
    const resolved = resolveGlyph(0x4e2d, 5, { primary, fallbacks: [] });
    expect(resolved?.face).toBe(primary);
    expect(resolved?.glyph.id).toBe(5);
  });

  it.skipIf(!fixtures.dejavu)('supplementary 实际 family 与请求完全匹配时信任显式 gid', async () => {
    const library = new FontLibrary({
      supplementaryFonts: [
        { data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' },
      ],
    });
    const faces = await library.resolve(
      makeFontResource({ fontName: 'DejaVu Sans', familyName: 'DejaVu Sans' }),
    );
    expect(faces?.primary.family).toContain('DejaVu');
    expect(faces?.primary.explicitGlyphs).toBe(true);
    const resolved = resolveGlyph(0x41, 36, faces!);
    expect(resolved?.face).toBe(faces?.primary);
    expect(resolved?.explicit).toBe(true);
    expect(resolved?.glyph.id).toBe(36);
    library.dispose();
  });

  it.skipIf(!fixtures.times || !fixtures.nimbusRoman)(
    '精确 Times family 优先于 Nimbus 别名替代',
    async () => {
      const library = new FontLibrary({
        supplementaryFonts: [
          { data: readFixture(fixtures.nimbusRoman as string), family: 'Nimbus Roman' },
          { data: readFixture(fixtures.times as string), family: 'Times New Roman' },
        ],
      });
      const faces = await library.resolve(
        makeFontResource({ fontName: 'Times New Roman', familyName: 'Times New Roman' }),
      );
      expect(faces?.primary.family).toBe('Times New Roman');
      expect(faces?.primary.explicitGlyphs).toBe(true);
      library.dispose();
    },
  );

  it.skipIf(!fixtures.times)('Times New Roman 精确 family 采用显式连字 GID', async () => {
    const library = new FontLibrary({
      supplementaryFonts: [
        { data: readFixture(fixtures.times as string), family: 'Times New Roman' },
      ],
    });
    const faces = await library.resolve(
      makeFontResource({ fontName: 'Times New Roman', familyName: 'Times New Roman' }),
    );
    expect(faces?.primary.family).toBe('Times New Roman');
    expect(faces?.primary.explicitGlyphs).toBe(true);
    const resolved = resolveGlyph(0x66, 191, faces!);
    expect(resolved?.face).toBe(faces?.primary);
    expect(resolved?.explicit).toBe(true);
    expect(resolved?.glyph.id).toBe(191);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu)('supplementary 字体标记为替代字体，不套用原字体 GID', async () => {
    const library = new FontLibrary({
      supplementaryFonts: [
        { data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' },
      ],
    });
    const faces = await library.resolve(makeFontResource({ fontName: 'Missing Font' }));
    expect(faces).not.toBeNull();
    expect(faces?.primary.explicitGlyphs).toBe(false);
    const resolved = resolveGlyph(0x41, 37, faces!);
    expect(resolved?.glyph.id).toBe(36);
    library.dispose();
  });

  it.skipIf(!fixtures.dejavu || !fixtures.nimbusRoman)(
    'Times 请求时优先选择 Nimbus Roman 衬线替代字体',
    async () => {
      const library = new FontLibrary({
        supplementaryFonts: [
          { data: readFixture(fixtures.dejavu as string), family: 'DejaVu Sans' },
          { data: readFixture(fixtures.nimbusRoman as string), family: 'Nimbus Roman' },
        ],
      });
      const faces = await library.resolve(makeFontResource({ fontName: 'Times New Roman' }));
      expect(faces?.primary.family).toContain('Nimbus');
      expect(faces?.primary.explicitGlyphs).toBe(false);
      const resolved = resolveGlyph(0x41, 36, faces!);
      expect(resolved?.explicit).not.toBe(true);
      library.dispose();
    },
  );
});
