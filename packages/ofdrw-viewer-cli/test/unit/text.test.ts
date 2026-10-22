import { describe, expect, it } from 'vitest';
import type { TextContent, TextItem } from 'ofdrw-viewer-engine';
import { buildTextRecords } from '../../src/text.js';

/** 构造只包含 text/rect 的文本项，其余字段由 engine 提供。 */
function textItem(
  text: string,
  rect: { x: number; y: number; width: number; height: number },
): TextItem {
  return { text, rect } as TextItem;
}

/** 构造只包含 items 的文本内容；buildTextRecords 仅消费该字段。 */
function content(items: readonly TextItem[]): TextContent {
  return { items } as TextContent;
}

describe('buildTextRecords', () => {
  it('过滤空文本、保持顺序并只输出 text/x/y/w/h', () => {
    const records = buildTextRecords(
      content([
        textItem('发票', { x: 100.5, y: 176.25, width: 48.125, height: 24.5 }),
        textItem('', { x: 1, y: 2, width: 3, height: 4 }),
        textItem('金额\n合计', { x: 400.75, y: 300.5, width: 96, height: 12.25 }),
      ]),
    );

    expect(records).toEqual([
      { text: '发票', x: 100.5, y: 176.25, w: 48.125, h: 24.5 },
      { text: '金额\n合计', x: 400.75, y: 300.5, w: 96, h: 12.25 },
    ]);
    expect(Object.keys(records[0] ?? {})).toEqual(['text', 'x', 'y', 'w', 'h']);
  });

  it('空页返回空数组', () => {
    expect(buildTextRecords(content([]))).toEqual([]);
  });

  it('全部文本项为空时返回空数组', () => {
    expect(
      buildTextRecords(
        content([
          textItem('', { x: 0, y: 0, width: 0, height: 0 }),
          textItem('', { x: 1, y: 1, width: 1, height: 1 }),
        ]),
      ),
    ).toEqual([]);
  });
});
