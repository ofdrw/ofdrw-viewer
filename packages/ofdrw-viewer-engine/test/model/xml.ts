import type { XmlNode } from '../../src/xml/types';

/**
 * 手工构造 XmlNode，避免 T3 单测依赖 T2 parser 实现。
 *
 * @param name local name。
 * @param attrs 属性表。
 * @param children 子节点。
 * @param text 叶子文本。
 * @returns XmlNode。
 */
export function node(
  name: string,
  attrs: Record<string, string> = {},
  children: XmlNode[] = [],
  text?: string,
): XmlNode {
  return text === undefined ? { name, attrs, children } : { name, attrs, children, text };
}

/** 构造带文本的叶子节点。 */
export function leaf(name: string, text: string, attrs: Record<string, string> = {}): XmlNode {
  return node(name, attrs, [], text);
}