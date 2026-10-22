import { describe, expect, it } from 'vitest';
import type { TextItem } from '@ofdrw/ofdrw-viewer-engine';
import {
  buildTextLayerSpecs,
  cssLinearOf,
  highlightBoxesForRefs,
  isCjkChar,
  normalizeSelectionText,
  quadBounds,
  shouldSplitChars,
  MAX_TEXT_LAYER_NODES,
  MM_PER_INCH,
} from '../../../src/text/geometry';
import { makeChar, makeContent, makeItem, rotatedQuad } from './helpers';

describe('文本层几何', () => {
  it('96 DPI item span 与 canvas 使用同一 CSS px 坐标', () => {
    const item = makeItem({ text: 'Hello', x: 10, y: 100, size: 16 });
    const specs = buildTextLayerSpecs(makeContent([item]));
    expect(specs.dpi).toBe(96);
    expect(specs.spans).toHaveLength(1);
    const span = specs.spans[0]!;
    expect(span.kind).toBe('item');
    expect(span.className).toBe('ofd-text-item');
    expect(span.text).toBe('Hello');
    expect(span.left).toBeCloseTo(10);
    expect(span.top).toBeCloseTo(84);
    expect(span.width).toBeCloseTo(40);
    expect(span.height).toBeCloseTo(16);
    expect(span.fontSize).toBeCloseTo(16);
    expect(span.lineHeight).toBeCloseTo(16);
    expect(span.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    expect(span.angle).toBeCloseTo(0);
  });

  it('非 96 DPI 文本会归一化到 96 DPI CSS 坐标', () => {
    const dpi = 192;
    const transform = [dpi / MM_PER_INCH, 0, 0, dpi / MM_PER_INCH, 0, 0] as TextItem['transform'];
    const item = makeItem({ text: 'Hello', x: 20, y: 200, size: 32, transform });
    const content = makeContent([item], { dpi });
    const specs = buildTextLayerSpecs(content);
    expect(specs.width).toBeCloseTo((210 / MM_PER_INCH) * 96);
    expect(specs.height).toBeCloseTo((297 / MM_PER_INCH) * 96);
    const span = specs.spans[0]!;
    expect(span.left).toBeCloseTo(10);
    expect(span.top).toBeCloseTo(84);
    expect(span.width).toBeCloseTo(40);
    expect(span.fontSize).toBeCloseTo(16);
    expect(span.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    expect(span.angle).toBeCloseTo(0);
  });

  it('旋转文本的 item span 使用矩阵并保持字符单元对齐', () => {
    const size = 10;
    const s = 96 / MM_PER_INCH;
    const base = makeItem({ text: 'AB', x: 100, y: 50, size, chars: [] });
    const item: TextItem = {
      ...base,
      transform: [0, s, -s, 0, 0, 0] as TextItem['transform'],
      quad: rotatedQuad(100, 50, 20, size, Math.PI / 2),
      advance: 20,
    };
    const specs = buildTextLayerSpecs(makeContent([item]));
    const span = specs.spans[0]!;
    // 局部上边 (0,-size) 经 90° 旋转后为 (size,0)。
    expect(span.left).toBeCloseTo(110);
    expect(span.top).toBeCloseTo(50);
    expect(span.transform).toBe('matrix(0, 1, -1, 0, 0, 0)');
    expect(span.angle).toBeCloseTo(Math.PI / 2);
    const linear = cssLinearOf(item.transform, 96);
    expect(linear).toEqual({ a: 0, b: 1, c: -1, d: 0 });
  });

  it('字符方向与 item 不一致时拆成字符 span', () => {
    const base = makeItem({ text: '汉字', x: 100, y: 100, size: 16 });
    const chars = base.chars!.map((char, index) =>
      makeChar(char.text, 100 + index * 16, 100, 16, 16, Math.PI / 2),
    );
    const item: TextItem = { ...base, chars, advance: 32 };
    expect(shouldSplitChars(item)).toBe(true);
    const specs = buildTextLayerSpecs(makeContent([item]));
    expect(specs.spans.map((span) => span.kind)).toEqual(['char', 'char']);
    const first = specs.spans[0]!;
    expect(first.className).toBe('ofd-text-char');
    expect(first.text).toBe('汉');
    expect(first.left).toBeCloseTo(116);
    expect(first.top).toBeCloseTo(100);
    expect(first.transform).toMatch(/^rotate\(/);
  });

  it('节点超过上限时合并为 item span 并标记截断', () => {
    const items = Array.from({ length: MAX_TEXT_LAYER_NODES + 1000 }, (_, index) =>
      makeItem({ text: 'a', x: 0, y: index, size: 1, order: index }),
    );
    const specs = buildTextLayerSpecs(makeContent(items));
    expect(specs.spans).toHaveLength(MAX_TEXT_LAYER_NODES);
    expect(specs.truncated).toBe(true);
    expect(specs.spans.every((span) => span.kind === 'item')).toBe(true);
  });

  it('命中高亮框按字符 quad 生成并合并同一行', () => {
    const content = makeContent([makeItem({ text: 'abc', x: 10, y: 100, size: 16 })]);
    const boxes = highlightBoxesForRefs(content, [
      { itemIndex: 0, charIndex: 0 },
      { itemIndex: 0, charIndex: 1 },
      { itemIndex: 0, charIndex: 2 },
    ]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.x).toBeCloseTo(10);
    expect(boxes[0]!.y).toBeCloseTo(84);
    expect(boxes[0]!.width).toBeCloseTo(24);
    expect(boxes[0]!.height).toBeCloseTo(16);
    expect(highlightBoxesForRefs(content, [])).toEqual([]);
  });

  it('四边形包围盒与 CJK 判定', () => {
    const bounds = quadBounds(rotatedQuad(10, 20, 8, 16, Math.PI / 2));
    expect(bounds.width).toBeCloseTo(16);
    expect(bounds.height).toBeCloseTo(8);
    expect(isCjkChar('中')).toBe(true);
    expect(isCjkChar('A')).toBe(false);
    expect(isCjkChar('，')).toBe(true);
  });

  it('选区文本合并空白并保留段落换行', () => {
    expect(normalizeSelectionText('Hello   world\n\n 第二 行 ')).toBe(
      'Hello world\n\n第二 行',
    );
    expect(normalizeSelectionText('\n\n')).toBe('');
  });
});