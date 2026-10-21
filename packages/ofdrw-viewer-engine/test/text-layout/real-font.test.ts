/**
 * 真实字体 + 布局/轮廓集成测试（设计方案 12.2–12.5）。
 */

import { describe, expect, it } from 'vitest';
import type { PathCommand } from '../../src/common/types';
import { createFontFace } from '../../src/font/face';
import { buildTextPath, drawTextObject, layoutText } from '../../src/render/text';
import { ensureFixtures, readFixture } from '../font/fixtures';
import {
  createRecordingBinder,
  createRecordingRenderer,
  createStyle,
  makeTextCode,
  makeTextObject,
} from './fake-font';

const fixtures = ensureFixtures();

/** 缺少系统字体/样本内嵌字体时 skip；fixture 来源与 skip 策略见 test/font/README.md。 */

/** 检查路径命令中的坐标均为有限数。 */
function assertFiniteCommands(commands: readonly PathCommand[]): void {
  for (const command of commands) {
    switch (command.type) {
      case 'moveTo':
      case 'lineTo':
        expect(Number.isFinite(command.x)).toBe(true);
        expect(Number.isFinite(command.y)).toBe(true);
        break;
      case 'quadraticCurveTo':
        expect(Number.isFinite(command.cpx)).toBe(true);
        expect(Number.isFinite(command.cpy)).toBe(true);
        expect(Number.isFinite(command.x)).toBe(true);
        expect(Number.isFinite(command.y)).toBe(true);
        break;
      case 'bezierCurveTo':
        expect(Number.isFinite(command.cp1x)).toBe(true);
        expect(Number.isFinite(command.cp1y)).toBe(true);
        expect(Number.isFinite(command.cp2x)).toBe(true);
        expect(Number.isFinite(command.cp2y)).toBe(true);
        expect(Number.isFinite(command.x)).toBe(true);
        expect(Number.isFinite(command.y)).toBe(true);
        break;
      case 'closePath':
        break;
    }
  }
}

describe('真实字体布局', () => {
  it.skipIf(!fixtures.dejavu || !fixtures.embeddedCjk)('CJK 缺字回退后仍生成有限轮廓', () => {
    const latin = createFontFace(readFixture(fixtures.dejavu as string));
    const cjk = createFontFace(readFixture(fixtures.embeddedCjk as string), { key: 'cjk-subset' });
    const faces = { primary: latin, fallbacks: [cjk] };
    const object = makeTextObject({
      size: 10,
      codes: [makeTextCode({ text: 'A中', deltaX: [6, 10] })],
    });

    const layout = layoutText(object, faces);
    expect(layout.units).toHaveLength(2);
    expect(layout.units[0].glyphs[0].face).toBe(latin);
    expect(layout.units[1].glyphs[0].face).toBe(cjk);
    expect(layout.endX).toBe(16);

    const path = buildTextPath(object, faces);
    expect(path.length).toBeGreaterThan(10);
    assertFiniteCommands(path);
  });

  it.skipIf(!fixtures.dejavu)('真实 TTF 绘制只产生路径/填充调用', () => {
    const face = createFontFace(readFixture(fixtures.dejavu as string));
    const renderer = createRecordingRenderer();
    const binder = createRecordingBinder();
    drawTextObject(
      { renderer, binder, faces: { primary: face, fallbacks: [] } },
      makeTextObject({ size: 12, codes: [makeTextCode({ text: 'OFD', deltaX: [7, 7, 7] })] }),
      createStyle(),
    );
    expect(renderer.calls.some((call) => call.op === 'fill')).toBe(true);
    expect(renderer.calls.some((call) => call.op === 'moveTo')).toBe(true);
    expect(renderer.calls.some((call) => /Text$/.test(call.op))).toBe(false);
  });
});