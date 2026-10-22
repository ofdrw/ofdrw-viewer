/**
 * OFD.xml 的 DocInfo 文档属性解码。
 *
 * 日期保留原文；非法日期或缺失必填名称的自定义字段只 warning 后跳过。
 */

import type { XmlNode } from '../xml/types';
import type { DocInfo } from './types';
import type { DecodeOptions } from './decode';
import { attr, child, childText, children, emitWarning } from './decode-utils';

/** 日期格式：YYYY-MM-DD，可带时间与可选时区。 */
const DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * 解码 DocInfo。
 *
 * @param node `DocInfo` 节点。
 * @param options 解码选项。
 * @returns 文档属性；空字段省略。
 */
export function decodeDocInfo(node: XmlNode, options: DecodeOptions = {}): DocInfo {
  const result: DocInfo = {};
  const docId = childText(node, 'DocID');
  if (docId) result.docId = docId;
  setText(node, 'Title', 'title', result);
  setText(node, 'Author', 'author', result);
  setText(node, 'Subject', 'subject', result);
  setText(node, 'Abstract', 'abstract', result);
  setText(node, 'Creator', 'creator', result);
  setText(node, 'CreatorVersion', 'creatorVersion', result);
  setText(node, 'DocUsage', 'docUsage', result);
  setDate(node, 'CreationDate', 'creationDate', result, options);
  setDate(node, 'ModDate', 'modDate', result, options);

  const rawKeywords = childText(node, 'Keywords');
  if (rawKeywords) {
    const keywords = rawKeywords
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (keywords.length > 0) result.keywords = keywords;
  }

  const customDatasNode = child(node, 'CustomDatas');
  if (customDatasNode) {
    const customData: Record<string, string> = {};
    for (const customNode of children(customDatasNode, 'CustomData')) {
      const name = (attr(customNode, 'Name') ?? '').trim();
      if (!name) {
        emitWarning(options, 'W_METADATA_FIELD', 'CustomData 缺少 Name，已跳过');
        continue;
      }
      customData[name] = (customNode.text ?? '').trim();
    }
    if (Object.keys(customData).length > 0) result.customData = customData;
  }
  return result;
}

/** 读取文本字段；空文本省略。 */
function setText<K extends keyof DocInfo>(
  node: XmlNode,
  element: string,
  key: K,
  target: DocInfo,
): void {
  const value = childText(node, element);
  if (value) target[key] = value as DocInfo[K];
}

/** 读取日期字段；非法日期 warning 后跳过，日期保持原文。 */
function setDate(
  node: XmlNode,
  element: string,
  key: 'creationDate' | 'modDate',
  target: DocInfo,
  options: DecodeOptions,
): void {
  const value = childText(node, element);
  if (!value) return;
  if (!isValidDate(value)) {
    emitWarning(options, 'W_METADATA_FIELD', `${element} 不是合法日期：${JSON.stringify(value)}`);
    return;
  }
  target[key] = value;
}

/** 校验日期文本；接受 YYYY-MM-DD 与带时间的 ISO 形式。 */
function isValidDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) return false;
  }
  // 用 UTC 校验真实日历日，避免 2021-02-31 之类通过。
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
