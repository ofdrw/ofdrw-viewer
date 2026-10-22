import { describe, expect, it } from 'vitest';
import type { TextItem } from '@ofdrw/ofdrw-viewer-engine';
import {
  charRefsForRange,
  createPageSearchSource,
  findPageMatches,
  highlightBoxesForRange,
  normalizeQuery,
} from '../../../src/text/search';
import { makeContent, makeItem } from './helpers';

/** 构造单页搜索源。 */
function sourceOf(text: string, y = 100) {
  return createPageSearchSource(
    makeContent([makeItem({ text, x: 10, y, size: 16 })]),
    1,
  );
}

describe('查找文本映射', () => {
  it('规范化查询空白', () => {
    expect(normalizeQuery('  hello   world  ')).toBe('hello world');
    expect(normalizeQuery('\n\t')).toBe('');
  });

  it('按大小写与全词匹配', () => {
    const source = sourceOf('Cat concatenate cat');
    const insensitive = findPageMatches(source, 'cat', {
      caseSensitive: false,
      wholeWord: false,
    });
    expect(insensitive.map((match) => match.text)).toEqual(['Cat', 'cat', 'cat']);
    const sensitive = findPageMatches(source, 'cat', {
      caseSensitive: true,
      wholeWord: false,
    });
    expect(sensitive).toHaveLength(2);
    const wholeWord = findPageMatches(source, 'cat', {
      caseSensitive: false,
      wholeWord: true,
    });
    expect(wholeWord.map((match) => match.start)).toEqual([0, 16]);
  });

  it('跨 TextItem 命中并映射到两个 item 的字符', () => {
    const content = makeContent([
      makeItem({ text: 'Hello', x: 10, y: 100, size: 16, order: 0 }),
      makeItem({ text: 'world', x: 60, y: 100, size: 16, order: 1 }),
    ]);
    const source = createPageSearchSource(content, 1);
    expect(source.text).toBe('Hello world');
    const matches = findPageMatches(source, 'lo wo', {
      caseSensitive: false,
      wholeWord: false,
    });
    expect(matches).toHaveLength(1);
    const refs = charRefsForRange(source, matches[0]!.start, matches[0]!.end);
    expect(refs.some((ref) => ref.itemIndex === 0)).toBe(true);
    expect(refs.some((ref) => ref.itemIndex === 1)).toBe(true);
  });

  it('正则元字符按字面量匹配', () => {
    const source = sourceOf('value a.b here');
    const matches = findPageMatches(source, 'a.b', {
      caseSensitive: false,
      wholeWord: false,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe('a.b');
  });

  it('单页命中上限生效', () => {
    const source = sourceOf('x x x x x');
    const matches = findPageMatches(source, 'x', {
      caseSensitive: false,
      wholeWord: false,
      maxMatches: 3,
    });
    expect(matches).toHaveLength(3);
  });

  it('无字符数据时退化为 item 级高亮', () => {
    const item = makeItem({ text: 'fallback', x: 10, y: 100, size: 16 });
    const noChars: TextItem = { ...item, chars: undefined };
    const source = createPageSearchSource(makeContent([noChars]), 1);
    const matches = findPageMatches(source, 'fallback', {
      caseSensitive: false,
      wholeWord: false,
    });
    expect(matches).toHaveLength(1);
    const refs = charRefsForRange(source, matches[0]!.start, matches[0]!.end);
    expect(refs).toEqual([{ itemIndex: 0, charIndex: -1 }]);
    expect(highlightBoxesForRange(source, matches[0]!.start, matches[0]!.end)).toHaveLength(1);
  });

  it('空白折叠后仍可跨 item 查找', () => {
    const content = makeContent([
      makeItem({ text: 'alpha   beta', x: 10, y: 100, size: 16 }),
    ]);
    const source = createPageSearchSource(content, 1);
    expect(source.text).toBe('alpha beta');
    expect(
      findPageMatches(source, 'alpha beta', {
        caseSensitive: false,
        wholeWord: false,
      }),
    ).toHaveLength(1);
  });
});