/**
 * drawTextObject 绘制行为测试（设计方案 12.5/12.6、19.6 文字只走轮廓）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolvedPaint } from '../../src/common/types';
import {
  MAX_GLYPHS_PER_BATCH,
  SYNTHETIC_BOLD_WIDTH_FACTOR,
  drawTextObject,
} from '../../src/render/text';
import type { TextDrawContext } from '../../src/render/text';
import {
  callsOf,
  createEmptyFace,
  createFakeFace,
  createFakeFaceSet,
  createRecordingBinder,
  createRecordingRenderer,
  createStyle,
  makeTextCode,
  makeTextObject,
} from './fake-font';

const SOURCE_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

/** 每个字符一个三角形轮廓的假字体。 */
function createDrawFace(options: { bold?: boolean; italic?: boolean } = {}) {
  return createFakeFace({
    unitsPerEm: 1000,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    glyphs: [
      { gid: 1, advanceWidth: 1000, codePoints: [0x41] },
      { gid: 2, advanceWidth: 1000, codePoints: [0x42] },
    ],
  });
}

/** 组装绘制上下文。 */
function createContext(faces = createFakeFaceSet(createDrawFace())) {
  const renderer = createRecordingRenderer();
  const binder = createRecordingBinder();
  const warnings: string[] = [];
  const context: TextDrawContext = {
    renderer,
    binder,
    faces,
    onWarning: (code, message) => warnings.push(`${code}:${message}`),
  };
  return { context, renderer, binder, warnings };
}

describe('文字填充/描边', () => {
  it('所有字形合并为一条路径，一次 fill(nonzero)', () => {
    const { context, renderer } = createContext();
    drawTextObject(
      context,
      makeTextObject({ codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })] }),
      createStyle(),
    );
    expect(callsOf(renderer.calls, 'beginPath')).toHaveLength(1);
    const fills = callsOf(renderer.calls, 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0][2]).toBe('nonzero');
    expect(callsOf(renderer.calls, 'moveTo')).toHaveLength(2);
    expect(callsOf(renderer.calls, 'stroke')).toHaveLength(0);
  });

  it('fill + stroke 复用同一条路径', () => {
    const { context, renderer } = createContext();
    drawTextObject(
      context,
      makeTextObject({ codes: [makeTextCode({ text: 'AB', deltaX: [5, 5] })] }),
      createStyle({ fill: true, stroke: true, lineWidth: 0.353 }),
    );
    expect(callsOf(renderer.calls, 'beginPath')).toHaveLength(1);
    expect(callsOf(renderer.calls, 'fill')).toHaveLength(1);
    expect(callsOf(renderer.calls, 'stroke')).toHaveLength(1);
  });

  it('style.fill=false 时不填充；size<=0 直接跳过', () => {
    const { context, renderer } = createContext();
    drawTextObject(
      context,
      makeTextObject({ codes: [makeTextCode({ text: 'A', deltaX: [5] })] }),
      createStyle({ fill: false, stroke: false }),
    );
    expect(renderer.calls).toHaveLength(0);

    const zero = createContext();
    drawTextObject(
      zero.context,
      makeTextObject({ size: 0, codes: [makeTextCode({ text: 'A' })] }),
      createStyle(),
    );
    expect(zero.renderer.calls).toHaveLength(0);
  });

  it('Paint 无法绑定时不产生绘制调用', () => {
    const renderer = createRecordingRenderer();
    const context: TextDrawContext = {
      renderer,
      binder: {
        bind: (): ResolvedPaint | undefined => undefined,
        clear: (): void => undefined,
      },
      faces: createFakeFaceSet(createDrawFace()),
    };
    drawTextObject(
      context,
      makeTextObject({ codes: [makeTextCode({ text: 'A' })] }),
      createStyle(),
    );
    expect(renderer.calls).toHaveLength(0);
  });
});

describe('合成粗体', () => {
  it('weight>=600 且字体非粗体时追加同色描边', () => {
    const { context, renderer } = createContext();
    drawTextObject(
      context,
      makeTextObject({
        weight: 700,
        size: 10,
        codes: [makeTextCode({ text: 'A', deltaX: [5] })],
      }),
      createStyle({ fill: true, stroke: false }),
    );
    const strokes = callsOf(renderer.calls, 'stroke');
    expect(strokes).toHaveLength(1);
    const style = strokes[0][0] as { lineWidth: number; lineJoin: string };
    expect(style.lineWidth).toBeCloseTo(10 * SYNTHETIC_BOLD_WIDTH_FACTOR, 6);
    expect(style.lineJoin).toBe('Round');
    // 合成粗体不改变 Delta 推进。
    const fills = callsOf(renderer.calls, 'fill');
    expect(fills).toHaveLength(1);
  });

  it('对象本身有描边时叠加而不是替换', () => {
    const { context, renderer } = createContext();
    drawTextObject(
      context,
      makeTextObject({
        weight: 700,
        codes: [makeTextCode({ text: 'A', deltaX: [5] })],
      }),
      createStyle({ fill: true, stroke: true, lineWidth: 0.353 }),
    );
    const strokes = callsOf(renderer.calls, 'stroke');
    expect(strokes).toHaveLength(2);
    expect((strokes[0][0] as { lineWidth: number }).lineWidth).toBeCloseTo(0.2, 6);
    expect((strokes[1][0] as { lineWidth: number }).lineWidth).toBe(0.353);
  });

  it('字体自带粗体或 syntheticBold=false 时不叠加', () => {
    const boldContext = createContext(createFakeFaceSet(createDrawFace({ bold: true })));
    drawTextObject(
      boldContext.context,
      makeTextObject({ weight: 700, codes: [makeTextCode({ text: 'A' })] }),
      createStyle(),
    );
    expect(callsOf(boldContext.renderer.calls, 'stroke')).toHaveLength(0);

    const disabled = createContext();
    drawTextObject(
      disabled.context,
      makeTextObject({ weight: 700, codes: [makeTextCode({ text: 'A' })] }),
      createStyle(),
      { syntheticBold: false },
    );
    expect(callsOf(disabled.renderer.calls, 'stroke')).toHaveLength(0);
  });
});

describe('大批量字形分批', () => {
  it('超过阈值时按批 beginPath/fill', () => {
    const { context, renderer } = createContext();
    const glyphCount = MAX_GLYPHS_PER_BATCH * 2 + 1;
    drawTextObject(
      context,
      makeTextObject({ codes: [makeTextCode({ text: 'A'.repeat(glyphCount) })] }),
      createStyle(),
    );
    const expectedBatches = Math.ceil(glyphCount / MAX_GLYPHS_PER_BATCH);
    expect(callsOf(renderer.calls, 'beginPath')).toHaveLength(expectedBatches);
    expect(callsOf(renderer.calls, 'fill')).toHaveLength(expectedBatches);
  });
});

describe('无字体/缺字容错', () => {
  it('无任何字形时不抛错、不产生绘制调用，只 warning 一次', () => {
    const { context, renderer, warnings } = createContext(
      createFakeFaceSet(createEmptyFace()),
    );
    expect(() =>
      drawTextObject(
        context,
        makeTextObject({ codes: [makeTextCode({ text: 'ABC' })] }),
        createStyle(),
      ),
    ).not.toThrow();
    expect(renderer.calls).toHaveLength(0);
    expect(warnings.filter((warning) => warning.startsWith('W_GLYPH_MISSING'))).toHaveLength(1);
  });
});

describe('文字实现不得调用 Canvas 文字 API', () => {
  it('font/ 与 render/text.ts 源码中不存在文字 API 调用', () => {
    const files = [
      'render/text.ts',
      'font/face.ts',
      'font/glyph.ts',
      'font/provider.ts',
      'font/types.ts',
      'font/aliases.ts',
    ];
    const forbidden = /\b(fillText|strokeText|measureText)\s*\(/;
    for (const file of files) {
      const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
      expect(source, `${file} 不应调用 Canvas 文字 API`).not.toMatch(forbidden);
    }
  });
});