import { describe, expect, it } from 'vitest';
import type { TextItem, TextQuad } from '@ofdrw/ofdrw-viewer-engine';
import {
  buildTextLayerSpecs,
  buildTextRows,
  buildTextRowsFromSpecs,
  MAX_TEXT_LAYER_NODES,
  screenYOfPagePoint,
  visibleYRangeOf,
  cssLinearOf,
  highlightBoxesForRefs,
  isCjkChar,
  normalizeSelectionText,
  quadBounds,
  shouldSplitChars,
  MM_PER_INCH,
  applyRowGap,
  mergeFlowIntervals,
  projectQuad,
  unprojectRect,
} from '../../../src/text/geometry';
import { contentWithLines, makeChar, makeContent, makeItem, rotatedQuad } from './helpers';

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

  it('大页不截断：超过 5000 个 span 时全部保留', () => {
    const total = 5001;
    const items = Array.from({ length: total }, (_, index) =>
      makeItem({ text: 'a', x: 0, y: index, size: 1, order: index }),
    );
    const specs = buildTextLayerSpecs(makeContent(items));
    expect(specs.spans).toHaveLength(total);
    expect(specs.spans.every((span) => span.kind === 'item')).toBe(true);
    expect(Object.keys(specs)).toEqual(['spans', 'width', 'height', 'dpi', 'truncated']);
    expect(specs.truncated).toBe(false);
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
describe('行划分', () => {
  /** 断言全部 span 恰好出现一次，且行序/行内序满足不变量。 */
  function expectConsistentLayout(content: ReturnType<typeof contentWithLines>): void {
    const layout = buildTextRows(content);
    const all = layout.rows.flatMap((row) => row.spans);
    expect(all).toHaveLength(buildTextLayerSpecs(content).spans.length);
    expect(new Set(all.map((span) => `${span.itemIndex}:${span.charIndex ?? -1}`)).size).toBe(all.length);
    for (const row of layout.rows) {
      expect(row.top).toBeLessThanOrEqual(row.bottom);
      const perp = (left: number, top: number): number =>
        -Math.sin(layout.axisRowRad) * left + Math.cos(layout.axisRowRad) * top;
      for (let index = 0; index < row.spans.length; index += 1) {
        const span = row.spans[index]!;
        const value = perp(span.left, span.top);
        expect(value).toBeGreaterThanOrEqual(row.top - 1e-6);
      }
    }
    for (let index = 1; index < layout.rows.length; index += 1) {
      expect(layout.rows[index]!.top).toBeGreaterThanOrEqual(layout.rows[index - 1]!.top - 1e-6);
    }
  }

  it('横排多行按 y 分行，行 ID 稳定且 top/bottom 等于 span 的 y 区间', () => {
    const content = contentWithLines(['第一行', '第二行', '第三行'], { size: 16 });
    const layout = buildTextRows(content);
    expect(layout.axisRowRad).toBe(0);
    expect(layout.rows).toHaveLength(3);
    const specs = buildTextLayerSpecs(content).spans;
    layout.rows.forEach((row, index) => {
      expect(row.id).toBe(`${index}:${index}`);
      expect(row.spans).toHaveLength(1);
      expect(row.top).toBeCloseTo(specs[index]!.top);
      expect(row.bottom).toBeCloseTo(specs[index]!.top + specs[index]!.height);
    });
    expect(buildTextRows(content).rows.map((row) => row.id)).toEqual(
      layout.rows.map((row) => row.id),
    );
    expectConsistentLayout(content);
  });

  it('多个 item 凑同一行时归并为一行并按阅读方向排序', () => {
    const content = makeContent([
      makeItem({ text: 'World', x: 60, y: 100, size: 16, order: 1 }),
      makeItem({ text: 'Hello', x: 10, y: 100.5, size: 16, order: 0 }),
      makeItem({ text: 'Next', x: 10, y: 140, size: 16, order: 2 }),
    ]);
    const layout = buildTextRows(content);
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows[0]!.spans.map((span) => span.text)).toEqual(['Hello', 'World']);
    expect(layout.rows[1]!.spans.map((span) => span.text)).toEqual(['Next']);
    expect(layout.rows[0]!.id).toBe('0:0');
    expect(layout.rows[1]!.id).toBe('2:1');
    expectConsistentLayout(content);
  });

  it('同一 item 的 item 级与字符级混排强迫同行', () => {
    const base = makeItem({ text: '汉字', x: 100, y: 100, size: 16 });
    const verticalChars = base.chars!.map((char, index) =>
      makeChar(char.text, 100, 84 + index * 40, 16, 16, Math.PI / 2),
    );
    const mixed = makeItem({ text: '汉字', x: 100, y: 100, size: 16, chars: verticalChars });
    expect(shouldSplitChars(mixed)).toBe(true);
    const content = makeContent([
      mixed,
      makeItem({ text: 'far', x: 10, y: 400, size: 16, order: 1 }),
    ]);
    const layout = buildTextRows(content);
    const charRow = layout.rows.find((row) => row.spans.some((span) => span.kind === 'char'))!;
    expect(charRow.spans).toHaveLength(2);
    expect(charRow.spans.map((span) => span.charIndex)).toEqual([0, 1]);
    expect(layout.rows).toHaveLength(2);
    expectConsistentLayout(content);
  });

  it('竖排文字以垂直方向为主轴成行', () => {
    const content = makeContent([
      makeItem({ text: '甲乙', x: 300, y: 100, size: 16, angleRad: Math.PI / 2, order: 0 }),
      makeItem({ text: '丙丁', x: 300, y: 140, size: 16, angleRad: Math.PI / 2, order: 1 }),
      makeItem({ text: '戊己', x: 260, y: 100, size: 16, angleRad: Math.PI / 2, order: 2 }),
    ]);
    const layout = buildTextRows(content);
    expect(Math.abs(Math.sin(layout.axisRowRad))).toBeCloseTo(1, 6);
    expect(layout.rows).toHaveLength(2);
    // 主轴 90° 时主轴法向为 -x：x = 300 的列先于 x = 260 的列。
    expect(layout.rows[0]!.spans.map((span) => span.text)).toEqual(['甲乙', '丙丁']);
    expect(layout.rows[1]!.spans.map((span) => span.text)).toEqual(['戊己']);
    expectConsistentLayout(content);
  });

  it('逐字旋转（每字角度不同）仍按行带归并成一行', () => {
    const chars = ['旋', '转', '字'].map((text, index) =>
      makeChar(text, 50 + index * 20, 100, 16, 16, (index * Math.PI) / 4),
    );
    const item = makeItem({ text: '旋转字', x: 50, y: 100, size: 16, chars });
    const layout = buildTextRows(makeContent([item, makeItem({ text: '尾', x: 10, y: 300, size: 16 })]));
    const rotated = layout.rows.find((row) => row.spans.some((span) => span.charIndex === 1))!;
    expect(rotated.spans.map((span) => span.text)).toEqual(['旋', '转', '字']);
    expectConsistentLayout(makeContent([item]));
  });

  it('空页返回空行表，行带高度下限为 1', () => {
    const layout = buildTextRows(makeContent([]));
    expect(layout.rows).toEqual([]);
    expect(layout.bandHeight).toBe(1);
    expect(layout.axisRowRad).toBe(0);
    const filled = buildTextRows(contentWithLines(['Hello']));
    expect(filled.bandHeight).toBeCloseTo(16);
  });

  it('行划分与页旋转无关：同一内容在四向旋转下行 ID 相同', () => {
    const content = contentWithLines(['第一行', '第二行']);
    const ids = buildTextRows(content).rows.map((row) => row.id);
    expect(ids).toEqual(['0:0', '1:1']);
  });
});

describe('可见区间换算', () => {
  const page = { width: 400, height: 600 };

  it('旋转 0°：可见区间即页内 y 区间', () => {
    const range = visibleYRangeOf(
      { left: 0, top: 100, width: 400, height: 600 },
      { left: 0, top: 200, width: 800, height: 300 },
      page,
      0,
    )!;
    expect(range.top).toBeCloseTo(100);
    expect(range.bottom).toBeCloseTo(400);
  });

  it('旋转 90°/270°：屏幕纵向对应页内 x，页内 y 无可裁剪边界，返回整页 y 区间', () => {
    // 90°/270° 时行（按页内 y 分组）在屏幕上是横向排列，纵向滚动不会让某个 y 区间离开视口，
    // 因此可见 y 区间恒为整页；这是“已知限制”，由文本层按整页构建。
    for (const rotation of [90, 270] as const) {
      const topHalf = visibleYRangeOf(
        { left: 0, top: 0, width: 600, height: 400 },
        { left: 0, top: 0, width: 600, height: 200 },
        page,
        rotation,
      )!;
      expect(topHalf.top).toBeCloseTo(0);
      expect(topHalf.bottom).toBeCloseTo(600);
      const leftHalf = visibleYRangeOf(
        { left: 0, top: 0, width: 600, height: 400 },
        { left: 0, top: 0, width: 300, height: 400 },
        page,
        rotation,
      )!;
      expect(leftHalf.top).toBeCloseTo(0);
      expect(leftHalf.bottom).toBeCloseTo(600);
    }
  });

  it('旋转 180°：屏幕上半部分对应页内下半部分（y 轴反向）', () => {
    const range = visibleYRangeOf(
      { left: 0, top: 0, width: 400, height: 600 },
      { left: 0, top: 0, width: 400, height: 150 },
      page,
      180,
    )!;
    expect(range.top).toBeCloseTo(450);
    expect(range.bottom).toBeCloseTo(600);
    // 屏幕下半部分（150..600）对应页内上半部分（0..450），方向反转仍取到正确 y 区间。
    const lower = visibleYRangeOf(
      { left: 0, top: 0, width: 400, height: 600 },
      { left: 0, top: 150, width: 400, height: 450 },
      page,
      180,
    )!;
    expect(lower.top).toBeCloseTo(0);
    expect(lower.bottom).toBeCloseTo(450);
  });

  it('非整数倍率的页部分可见、完全不可见与完全可见', () => {
    // 页盒 400×(600×1.25)=400×750，容器只露出 200..600。
    const pageRect = { left: 10, top: 50, width: 400, height: 750 };
    const viewport = { left: 0, top: 200, width: 800, height: 300 };
    const partial = visibleYRangeOf(pageRect, viewport, page, 0)!;
    expect(partial.top).toBeCloseTo(((200 - 50) / 750) * 600, 6);
    expect(partial.bottom).toBeCloseTo(((500 - 50) / 750) * 600, 6);
    expect(
      visibleYRangeOf(pageRect, { left: 0, top: 900, width: 800, height: 100 }, page, 0),
    ).toBeNull();
    const whole = visibleYRangeOf(pageRect, { left: 0, top: 0, width: 800, height: 1000 }, page, 0)!;
    expect(whole.top).toBeCloseTo(0);
    expect(whole.bottom).toBeCloseTo(600);
  });

  it('不可测量（0 尺寸）返回 null', () => {
    expect(
      visibleYRangeOf({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 1, height: 1 }, page, 0),
    ).toBeNull();
  });

  it('页面内点换算为屏幕纵坐标', () => {
    const rect = { left: 0, top: 50, width: 400, height: 600 };
    expect(screenYOfPagePoint(rect, 0, 300, page, 0)).toBeCloseTo(350);
    // 90°：页内 (300,300) 的屏幕 x = 600 - 300 = 300，屏幕 y = 300。
    expect(screenYOfPagePoint({ left: 0, top: 0, width: 600, height: 400 }, 300, 300, page, 90)).toBeCloseTo(300);
    expect(Number.isNaN(screenYOfPagePoint({ left: 0, top: 0, width: 0, height: 0 }, 0, 0, page, 0))).toBe(true);
  });
});

describe('选区块几何', () => {
  const horizontalQuad = [
    { x: 10, y: 20 },
    { x: 30, y: 20 },
    { x: 30, y: 40 },
    { x: 10, y: 40 },
  ] as unknown as TextQuad;

  it('projectQuad 把字符四边形投影到主轴坐标系', () => {
    expect(projectQuad(horizontalQuad, 0)).toEqual({
      flowMin: 10,
      flowMax: 30,
      perpMin: 20,
      perpMax: 40,
    });
    // 90° 主轴：flow 沿 y，perp = -x。
    const vertical = projectQuad(horizontalQuad, Math.PI / 2);
    expect(vertical.flowMin).toBeCloseTo(20);
    expect(vertical.flowMax).toBeCloseTo(40);
    expect(vertical.perpMin).toBeCloseTo(-30);
    expect(vertical.perpMax).toBeCloseTo(-10);
  });

  it('mergeFlowIntervals 合并相邻区间并保留独立段', () => {
    expect(mergeFlowIntervals([])).toEqual([]);
    expect(
      mergeFlowIntervals([
        { min: 0, max: 10 },
        { min: 9, max: 11 },
        { min: 12, max: 20 },
        { min: 19.4, max: 25 },
      ]),
    ).toEqual([
      { min: 0, max: 11 },
      { min: 12, max: 25 },
    ]);
    // 间隙恰好 0.5 也合并（设计文档：相差不超过 FLOW_MERGE_EPSILON）。
    expect(
      mergeFlowIntervals([
        { min: 0, max: 10 },
        { min: 10.5, max: 20 },
      ]),
    ).toEqual([{ min: 0, max: 20 }]);
    // 超过 0.5 才保留独立段。
    expect(
      mergeFlowIntervals([
        { min: 0, max: 10 },
        { min: 10.5001, max: 20 },
      ]),
    ).toHaveLength(2);
  });

  it('相邻行 1px 缝隙全部由下行顶边让出，上行底边保持原值', () => {
    const rects = [
      { rowId: 'a', flowMin: 0, flowMax: 10, perpMin: 0, perpMax: 16 },
      { rowId: 'a', flowMin: 20, flowMax: 30, perpMin: 0, perpMax: 16 },
      { rowId: 'b', flowMin: 0, flowMax: 10, perpMin: 16, perpMax: 32 },
    ];
    const adjusted = applyRowGap(rects, 1);
    // 上行完整覆盖到原始 quad 底边，不再各裁 0.5px。
    expect(adjusted[0]!.perpMin).toBeCloseTo(0);
    expect(adjusted[0]!.perpMax).toBeCloseTo(16);
    expect(adjusted[1]!.perpMax).toBeCloseTo(16);
    // 下行顶边让出完整 1px，底边不变。
    expect(adjusted[2]!.perpMin).toBeCloseTo(17);
    expect(adjusted[2]!.perpMax).toBeCloseTo(32);
    expect(adjusted[2]!.perpMin - adjusted[0]!.perpMax).toBeCloseTo(1);
  });

  it('applyRowGap 逐矩形按自身高度封顶，矮矩形不会被压成零高', () => {
    const adjusted = applyRowGap(
      [
        { rowId: 'a', flowMin: 0, flowMax: 10, perpMin: 0, perpMax: 16 },
        // 同一行内的矮矩形：若直接套用整行 1px 收缩量会被压到负高。
        { rowId: 'b', flowMin: 20, flowMax: 30, perpMin: 16, perpMax: 16.2 },
        { rowId: 'b', flowMin: 0, flowMax: 10, perpMin: 16, perpMax: 32 },
      ],
      1,
    );
    // 正常矩形让出完整 1px，行间缝隙保持 1px。
    expect(adjusted[1]!.perpMin - adjusted[0]!.perpMax).toBeCloseTo(0.1);
    expect(adjusted[2]!.perpMin - adjusted[0]!.perpMax).toBeCloseTo(1);
    // 矮矩形最多收缩自身高度的一半，净高为正且可见。
    expect(adjusted[1]!.perpMax - adjusted[1]!.perpMin).toBeCloseTo(0.1);
    expect(adjusted[1]!.perpMax).toBeGreaterThan(adjusted[1]!.perpMin);
  });

  it('applyRowGap 在整行极薄时宁可缩小缝隙也不压没矩形', () => {
    const adjusted = applyRowGap(
      [
        { rowId: 'a', flowMin: 0, flowMax: 10, perpMin: 0, perpMax: 0.2 },
        { rowId: 'b', flowMin: 0, flowMax: 10, perpMin: 0.2, perpMax: 0.4 },
      ],
      1,
    );
    // 上行底边完全不裁；下行只让出自身高度一半 0.1px。
    expect(adjusted[0]!.perpMax - adjusted[0]!.perpMin).toBeCloseTo(0.2);
    expect(adjusted[0]!.perpMax).toBeCloseTo(0.2);
    expect(adjusted[1]!.perpMax - adjusted[1]!.perpMin).toBeCloseTo(0.1);
    expect(adjusted[1]!.perpMin - adjusted[0]!.perpMax).toBeCloseTo(0.1);
    expect(adjusted[1]!.perpMin - adjusted[0]!.perpMax).toBeLessThan(1);
  });

  it('applyRowGap 处理行间重叠时只上移下行顶边', () => {
    const overlap = applyRowGap(
      [
        { rowId: 'a', flowMin: 0, flowMax: 10, perpMin: 0, perpMax: 16 },
        { rowId: 'b', flowMin: 0, flowMax: 10, perpMin: 15, perpMax: 31 },
      ],
      1,
    );
    expect(overlap[0]!.perpMax).toBeCloseTo(16);
    expect(overlap[1]!.perpMin).toBeCloseTo(17);
    expect(overlap[1]!.perpMin - overlap[0]!.perpMax).toBeCloseTo(1);

    // 下行只有 0.4px 高：单侧最多让出 0.2px，缝隙不足 1px 但矩形仍为正高。
    const capped = applyRowGap(
      [
        { rowId: 'a', flowMin: 0, flowMax: 10, perpMin: 0, perpMax: 16 },
        { rowId: 'b', flowMin: 0, flowMax: 10, perpMin: 16, perpMax: 16.4 },
      ],
      1,
    );
    expect(capped[0]!.perpMax).toBeCloseTo(16);
    expect(capped[1]!.perpMin).toBeCloseTo(16.2);
    expect(capped[1]!.perpMax - capped[1]!.perpMin).toBeCloseTo(0.2);
    expect(capped[1]!.perpMin - capped[0]!.perpMax).toBeCloseTo(0.2);
  });

  it('首行、末行与单行选区高度保持不变', () => {
    const adjusted = applyRowGap(
      [
        { rowId: 'a', flowMin: 0, flowMax: 10, perpMin: 0, perpMax: 16 },
        { rowId: 'b', flowMin: 0, flowMax: 10, perpMin: 16, perpMax: 32 },
        { rowId: 'c', flowMin: 0, flowMax: 10, perpMin: 32, perpMax: 48 },
      ],
      1,
    );
    expect(adjusted[0]!.perpMin).toBeCloseTo(0);
    expect(adjusted[0]!.perpMax).toBeCloseTo(16);
    expect(adjusted[2]!.perpMin).toBeCloseTo(33);
    expect(adjusted[2]!.perpMax).toBeCloseTo(48);

    const single = applyRowGap(
      [{ rowId: 'only', flowMin: 0, flowMax: 10, perpMin: 10, perpMax: 26 }],
      1,
    );
    expect(single[0]!.perpMin).toBeCloseTo(10);
    expect(single[0]!.perpMax).toBeCloseTo(26);
  });

  it('竖排（axisRowRad=π/2）投影下同样只收缩下行顶边', () => {
    const axisRowRad = Math.PI / 2;
    const upper = projectQuad(rotatedQuad(300, 100, 16, 16, axisRowRad), axisRowRad);
    const lower = projectQuad(rotatedQuad(284, 100, 16, 16, axisRowRad), axisRowRad);
    const adjusted = applyRowGap(
      [
        { ...upper, rowId: 'a' },
        { ...lower, rowId: 'b' },
      ],
      1,
    );
    expect(adjusted[0]!.perpMin).toBeCloseTo(upper.perpMin);
    expect(adjusted[0]!.perpMax).toBeCloseTo(upper.perpMax);
    expect(adjusted[1]!.perpMin - adjusted[0]!.perpMax).toBeCloseTo(1);
    expect(adjusted[1]!.perpMax).toBeCloseTo(lower.perpMax);
    expect(unprojectRect(adjusted[1]!, axisRowRad).rotationRad).toBeCloseTo(axisRowRad);
  });

  it('unprojectRect 轴对齐时直接返回页面坐标，旋转时返回中心旋转角', () => {
    expect(
      unprojectRect({ flowMin: 10, flowMax: 30, perpMin: 20, perpMax: 40 }, 0),
    ).toEqual({ left: 10, top: 20, width: 20, height: 20, rotationRad: 0 });

    const rotated = unprojectRect(
      { flowMin: 10, flowMax: 30, perpMin: 20, perpMax: 40 },
      Math.PI / 2,
    );
    // 中心 (flow=20, perp=30) → 页面坐标 (-30, 20)，未旋转矩形左上 = 中心 - 半宽高。
    expect(rotated.left).toBeCloseTo(-40);
    expect(rotated.top).toBeCloseTo(10);
    expect(rotated.width).toBeCloseTo(20);
    expect(rotated.height).toBeCloseTo(20);
    expect(rotated.rotationRad).toBeCloseTo(Math.PI / 2);
  });
});


describe('文本层节点上限（t10）', () => {
  // 字符方向不一致会触发字符级拆分，用于验证“先降级 item、再截断”的规则。
  const items = [
    makeItem({
      text: '甲乙',
      x: 10,
      y: 100,
      size: 16,
      order: 0,
      chars: [makeChar('甲', 10, 100, 16, 0), makeChar('乙', 26, 100, 16, 16, Math.PI / 2)],
    }),
    makeItem({
      text: '丙丁',
      x: 10,
      y: 120,
      size: 16,
      order: 1,
      chars: [makeChar('丙', 10, 120, 16, 0), makeChar('丁', 26, 120, 16, 16, Math.PI / 2)],
    }),
    makeItem({
      text: '戊己',
      x: 10,
      y: 140,
      size: 16,
      order: 2,
      chars: [makeChar('戊', 10, 140, 16, 0), makeChar('己', 26, 140, 16, 16, Math.PI / 2)],
    }),
  ];

  it('默认上限为 10 万，普通页不触发截断', () => {
    const specs = buildTextLayerSpecs(makeContent(items));
    expect(MAX_TEXT_LAYER_NODES).toBe(100_000);
    expect(specs.truncated).toBe(false);
    expect(specs.spans).toHaveLength(6);
  });

  it('超限先降级为 item span，仍超限再截断', () => {
    const fallback = buildTextLayerSpecs(makeContent(items), { maxNodes: 4 });
    expect(fallback.spans).toHaveLength(3);
    expect(fallback.spans.every((span) => span.kind === 'item')).toBe(true);
    expect(fallback.truncated).toBe(false);

    const truncated = buildTextLayerSpecs(makeContent(items), { maxNodes: 2 });
    expect(truncated.spans).toHaveLength(2);
    expect(truncated.spans.every((span) => span.kind === 'item')).toBe(true);
    expect(truncated.truncated).toBe(true);
  });

  it('行划分复用同一份 specs，spanCount/truncated 一致', () => {
    const specs = buildTextLayerSpecs(makeContent(items), { maxNodes: 2 });
    const layout = buildTextRowsFromSpecs(specs, makeContent(items));
    expect(layout.spanCount).toBe(2);
    expect(layout.truncated).toBe(true);
    expect(layout.rows.flatMap((row) => row.spans)).toHaveLength(2);
  });
});
