/**
 * 文本查找的纯函数层（设计方案 §9.4）。
 *
 * 把一页的 `TextContent` 展平成便于匹配的字符串，同时记录每个输出字符到
 * `TextItem`/`TextChar` 的映射；命中区间再映射回字符 quad 生成高亮框。该模块不
 * 访问 DOM、不做调度，由 `FindController` 负责分片、取消与代次。
 */

import type { TextContent } from '@ofdrw/ofdrw-viewer-engine';
import type { CharRef, HighlightBox } from './geometry';
import { highlightBoxesForRefs } from './geometry';

/** 单页可搜索文本与字符映射。 */
export interface PageSearchSource {
  /** 页码，1-based。 */
  readonly pageNumber: number;
  /** 归一化后的可搜索文本（空白折叠，item 之间以空格分隔）。 */
  readonly text: string;
  /** item 片段映射。 */
  readonly segments: readonly PageCharSegment[];
  /** 原始文本内容；用于命中后取字符 quad。 */
  readonly content: TextContent;
}

/** 一个 TextItem 在可搜索文本中的片段。 */
export interface PageCharSegment {
  /** 在 `text` 中的起始下标（UTF-16）。 */
  readonly textStart: number;
  /** 在 `text` 中的结束下标（不含）。 */
  readonly textEnd: number;
  /** TextItem 下标。 */
  readonly itemIndex: number;
  /** 每个输出 UTF-16 单元对应的 TextChar 下标；-1 表示无字符映射。 */
  readonly charIndices: readonly number[];
}

/** 页面命中区间。 */
export interface PageMatchRange {
  /** 在 `PageSearchSource.text` 中的起始下标（含）。 */
  readonly start: number;
  /** 在 `PageSearchSource.text` 中的结束下标（不含）。 */
  readonly end: number;
  /** 命中的原始文本。 */
  readonly text: string;
}

/** 单页匹配选项。 */
export interface PageMatchOptions {
  /** 是否区分大小写。 */
  readonly caseSensitive: boolean;
  /** 是否全词匹配（仅对拉丁文有效）。 */
  readonly wholeWord: boolean;
  /** 单页命中上限；0 表示不限。 */
  readonly maxMatches?: number;
}

/** 判断字符是否 ASCII 单词字符，用于全词匹配边界。 */
function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

/**
 * 规范化查询：去首尾空白、折叠连续空白。
 *
 * @param query 原始查询。
 * @returns 规范化查询；空字符串表示清除查找。
 */
export function normalizeQuery(query: string): string {
  return String(query ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 转义正则元字符。
 *
 * @param value 原始文本。
 * @returns 可安全放入 RegExp 的字符串。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构建单页可搜索文本。
 *
 * 规则：item 内连续空白折叠为一个空格；item 之间插入一个空格，便于查询跨 item
 * 命中（例如同一行的两个 TextObject）；中文不做分词，也不额外插空格。
 *
 * @param content 页面文本内容。
 * @param pageNumber 页码，1-based。
 * @returns 可搜索文本与映射。
 */
export function createPageSearchSource(
  content: TextContent,
  pageNumber: number,
): PageSearchSource {
  const segments: PageCharSegment[] = [];
  let text = '';
  const items = content.items ?? [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex]!;
    if (!item.text) continue;
    const codePoints = Array.from(item.text);
    if (codePoints.length === 0) continue;
    if (text.length > 0) text += ' ';
    const textStart = text.length;
    const charIndices: number[] = [];
    const aligned = item.chars !== undefined && item.chars.length === codePoints.length;
    let charIndex = 0;
    let lastWasSpace = text.length > 0;
    for (const codePoint of codePoints) {
      const whitespace = /^\s$/u.test(codePoint);
      if (whitespace && lastWasSpace) {
        charIndex += 1;
        continue;
      }
      const emitted = whitespace ? ' ' : codePoint;
      const mapped = aligned ? charIndex : -1;
      for (let unit = 0; unit < emitted.length; unit += 1) charIndices.push(mapped);
      text += emitted;
      lastWasSpace = whitespace;
      charIndex += 1;
    }
    if (text.length > textStart) {
      segments.push({
        textStart,
        textEnd: text.length,
        itemIndex,
        charIndices,
      });
    }
  }

  return { pageNumber, text, segments, content };
}

/**
 * 在单页文本中查找匹配区间。
 *
 * @param source 页面可搜索文本。
 * @param query 已规范化查询（非空）。
 * @param options 大小写/全词/上限。
 * @returns 命中区间，按文本顺序。
 */
export function findPageMatches(
  source: PageSearchSource,
  query: string,
  options: PageMatchOptions,
): PageMatchRange[] {
  const maxMatches = Math.max(0, options.maxMatches ?? 0);
  if (!query || source.text.length === 0) return [];
  const pattern = new RegExp(escapeRegExp(query), options.caseSensitive ? 'g' : 'gi');
  const matches: PageMatchRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source.text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (options.wholeWord) {
      const before = start > 0 ? source.text[start - 1] : undefined;
      const after = end < source.text.length ? source.text[end] : undefined;
      if (isWordChar(before) || isWordChar(after)) {
        pattern.lastIndex = Math.max(pattern.lastIndex, start + 1);
        continue;
      }
    }
    matches.push({ start, end, text: match[0] });
    if (maxMatches > 0 && matches.length >= maxMatches) break;
    // 查询非空，正常不会出现零宽匹配；防御性推进，避免死循环。
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return matches;
}

/**
 * 把命中区间映射回字符引用。
 *
 * 优先使用字符级映射；若该页没有字符数据（includeChars=false），退化为命中的
 * item 级引用，用整段 TextItem.quad 近似高亮。
 *
 * @param source 页面可搜索文本。
 * @param start 起始下标。
 * @param end 结束下标。
 * @returns 去重后的字符引用。
 */
export function charRefsForRange(
  source: PageSearchSource,
  start: number,
  end: number,
): CharRef[] {
  const refs: CharRef[] = [];
  const fallbackItems = new Set<number>();
  for (const segment of source.segments) {
    if (segment.textEnd <= start || segment.textStart >= end) continue;
    const from = Math.max(start, segment.textStart);
    const to = Math.min(end, segment.textEnd);
    let mapped = false;
    for (let index = from; index < to; index += 1) {
      const charIndex = segment.charIndices[index - segment.textStart];
      if (charIndex === undefined || charIndex < 0) continue;
      mapped = true;
      const previous = refs[refs.length - 1];
      if (previous && previous.itemIndex === segment.itemIndex && previous.charIndex === charIndex) {
        continue;
      }
      refs.push({ itemIndex: segment.itemIndex, charIndex });
    }
    if (!mapped) fallbackItems.add(segment.itemIndex);
  }
  // 混排页中，无字符数据的 item 也要有整段高亮，不能因其他 item 有字符而丢失。
  for (const itemIndex of fallbackItems) refs.push({ itemIndex, charIndex: -1 });
  return refs;
}

/**
 * 计算命中区间的高亮框。
 *
 * @param source 页面可搜索文本。
 * @param start 起始下标。
 * @param end 结束下标。
 * @returns 高亮框，单位 CSS px（96 DPI）。
 */
export function highlightBoxesForRange(
  source: PageSearchSource,
  start: number,
  end: number,
): HighlightBox[] {
  return highlightBoxesForRefs(source.content, charRefsForRange(source, start, end));
}