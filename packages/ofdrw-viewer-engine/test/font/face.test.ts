/**
 * FontFace 解析测试（设计方案 12.1/12.2/12.8）。
 */

import { describe, expect, it } from 'vitest';
import { OFDError } from '../../src/errors';
import { createFontFace, createFontFaces, disposeFontFace } from '../../src/font/face';
import type { FontWarningCallback } from '../../src/font/types';
import { ensureFixtures, readFixture } from './fixtures';

const fixtures = ensureFixtures();

/** 缺少系统字体/样本内嵌字体时 skip；fixture 来源与 skip 策略见 test/font/README.md。 */

/** 收集字体层 warning。 */
function collectWarnings(): { callback: FontWarningCallback; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    callback: (code, message) => warnings.push(`${code}:${message}`),
  };
}

describe('createFontFace', () => {
  it.skipIf(!fixtures.dejavu)('解析正常 TTF 并记录 metrics/轮廓', () => {
    const face = createFontFace(readFixture(fixtures.dejavu as string));
    expect(face.unitsPerEm).toBe(2048);
    expect(face.numGlyphs).toBeGreaterThan(5000);
    expect(face.hasCmap).toBe(true);
    expect(face.family).toContain('DejaVu');
    expect(face.bold).toBe(false);
    expect(face.italic).toBe(false);

    const glyph = face.glyphForCodePoint('A'.codePointAt(0) as number);
    expect(glyph).not.toBeNull();
    expect(glyph?.id).toBe(36);
    expect(glyph?.advanceWidth).toBeGreaterThan(0);
    expect(glyph?.path.some((command) => command.type === 'moveTo')).toBe(true);
    expect(glyph?.path.length).toBeGreaterThan(3);
  });

  it.skipIf(!fixtures.dejavu)('显式 gid 只对指定/内嵌字体开放', () => {
    const bytes = readFixture(fixtures.dejavu as string);
    const matched = createFontFace(bytes, { fontName: 'DejaVu Sans' });
    expect(matched.explicitGlyphs).toBe(true);

    const substitute = createFontFace(bytes, { fontName: 'DejaVu Sans', substitute: true });
    expect(substitute.explicitGlyphs).toBe(false);

    const renamed = createFontFace(bytes, { fontName: 'Not The Font' });
    expect(renamed.explicitGlyphs).toBe(false);

    const embedded = createFontFace(bytes, { fontName: 'Not The Font', authoritative: true });
    expect(embedded.explicitGlyphs).toBe(true);
  });

  it.skipIf(!fixtures.dejavuBold)('识别字体自带粗体', () => {
    const face = createFontFace(readFixture(fixtures.dejavuBold as string));
    expect(face.bold).toBe(true);
    expect(face.weightClass ?? 0).toBeGreaterThanOrEqual(600);
  });

  it.skipIf(!fixtures.dejavuOblique)('识别字体自带斜体', () => {
    const face = createFontFace(readFixture(fixtures.dejavuOblique as string));
    expect(face.italic).toBe(true);
  });

  it.skipIf(!fixtures.stripped)('解析无 cmap/name/OS2 剥离子集：显式 gid 可用', () => {
    const face = createFontFace(readFixture(fixtures.stripped as string), { fontName: 'Subset' });
    expect(face.hasCmap).toBe(false);
    expect(face.unitsPerEm).toBe(256);
    expect(face.numGlyphs).toBeGreaterThan(1);
    // 剥离子集没有 name 表：family 回退到调用方给出的名称。
    expect(face.family).toBe('Subset');
    expect(face.glyphForCodePoint(0x4e2d)).toBeNull();

    const glyph = face.glyph(11);
    expect(glyph).not.toBeNull();
    expect(glyph?.id).toBe(11);
    expect(glyph?.advanceWidth).toBe(128);
    expect(glyph?.path.length).toBe(11);
  });

  it.skipIf(!fixtures.embeddedCjk)('解析真实 OFD 内嵌 CJK TTF', () => {
    const face = createFontFace(readFixture(fixtures.embeddedCjk as string));
    expect(face.hasCmap).toBe(true);
    expect(face.unitsPerEm).toBe(256);
    const glyph = face.glyphForCodePoint(0x4e2d);
    expect(glyph?.id).toBe(1117);
    expect(glyph?.path.length).toBeGreaterThan(10);
  });

  it.skipIf(!fixtures.cffOtf)('解析单字体 CFF CID（OTF）', () => {
    const face = createFontFace(readFixture(fixtures.cffOtf as string));
    expect(face.hasCmap).toBe(true);
    expect(face.unitsPerEm).toBe(1000);
    const glyph = face.glyphForCodePoint(0x9ad8);
    expect(glyph).not.toBeNull();
    expect(glyph?.path.length).toBeGreaterThan(10);
    // 显式 gid 路径同样可用（CFF CID 不依赖 getGlyph(char)）。
    expect(face.glyph(3)?.path.length).toBeGreaterThan(0);
  });

  it.skipIf(!fixtures.notoTtc)('TTC 按 FontName 选面，失败取第 0 个并 warning', () => {
    const bytes = readFixture(fixtures.notoTtc as string);
    const faces = createFontFaces(bytes);
    expect(faces.length).toBe(5);
    expect(new Set(faces.map((face) => face.key)).size).toBe(5);
    expect(faces[0].unitsPerEm).toBe(1000);

    const sc = createFontFace(bytes, { fontName: 'Noto Serif CJK SC' });
    expect(sc.family).toContain('SC');
    expect(sc.glyphForCodePoint(0x9ad8)?.path.length).toBeGreaterThan(10);

    const byIndex = createFontFace(bytes, { index: 2 });
    expect(byIndex.family).toContain('SC');

    const { callback, warnings } = collectWarnings();
    const unmatched = createFontFace(bytes, { fontName: '不存在的字体', onWarning: callback });
    expect(unmatched.family).toContain('JP');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('W_FONT_MISSING');
  });

  it.skipIf(!fixtures.broken)('损坏字体抛 OFD_FONT_PARSE', () => {
    let thrown: unknown;
    try {
      createFontFace(readFixture(fixtures.broken as string));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OFDError);
    expect((thrown as OFDError).code).toBe('OFD_FONT_PARSE');
  });

  it.skipIf(!fixtures.dejavu)('字体面内部按 gid 缓存字形对象', () => {
    const face = createFontFace(readFixture(fixtures.dejavu as string));
    const first = face.glyph(36);
    const second = face.glyph(36);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(face.glyph(-1)).toBeNull();
    expect(face.glyph(face.numGlyphs)).toBeNull();
  });

  it.skipIf(!fixtures.dejavu)('disposeFontFace 可重复调用且不抛错', () => {
    const face = createFontFace(readFixture(fixtures.dejavu as string));
    expect(() => {
      disposeFontFace(face);
      disposeFontFace(face);
    }).not.toThrow();
  });

  it('空字节抛 OFD_FONT_PARSE', () => {
    expect(() => createFontFace(new Uint8Array(0))).toThrowError(OFDError);
  });
});