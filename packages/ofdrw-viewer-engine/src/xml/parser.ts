/**
 * saxes 封装与 XML 辅助访问（实现由 T2/dev-foundation 完成）。
 *
 * 解析时忽略命名空间、按 local name 输出；必须拒绝 DTD/外部实体。
 */

import type { XmlNode, XmlParseOptions, XmlParser } from './types';
import { notImplemented } from '../common/not-implemented';

/** 基于 saxes 的解析器；`xmlns:false`，不处理命名空间。 */
export class SaxesXmlParser implements XmlParser {
  /**
   * 解析 XML。
   *
   * @param xml UTF-8 文本或字节。
   * @param options 解析限制。
   * @returns 根节点。
   */
  parse(xml: string | Uint8Array, options?: XmlParseOptions): XmlNode {
    void xml;
    void options;
    return notImplemented('SaxesXmlParser.parse');
  }
}

/**
 * 解析 XML 文本/字节（默认使用 SaxesXmlParser）。
 *
 * @param xml UTF-8 文本或字节。
 * @param options 解析限制。
 * @returns 根节点。
 */
export function parseXml(xml: string | Uint8Array, options?: XmlParseOptions): XmlNode {
  void xml;
  void options;
  return notImplemented('xml.parseXml');
}

/**
 * 按精确名称取属性；已知标准拼写错误由调用方传入兼容名。
 *
 * @param node XML 节点。
 * @param name 属性名。
 * @returns 属性值或 undefined。
 */
export function getAttr(node: XmlNode, name: string): string | undefined {
  void node;
  void name;
  return notImplemented('xml.getAttr');
}

/**
 * 按精确名称取必需属性。
 *
 * @param node XML 节点。
 * @param name 属性名。
 * @returns 属性值；缺失时抛 OFDError。
 */
export function getRequiredAttr(node: XmlNode, name: string): string {
  void node;
  void name;
  return notImplemented('xml.getRequiredAttr');
}

/**
 * 取第一个指定名称的子节点。
 *
 * @param node 父节点。
 * @param name 子节点 local name。
 * @returns 子节点或 undefined。
 */
export function getChild(node: XmlNode, name: string): XmlNode | undefined {
  void node;
  void name;
  return notImplemented('xml.getChild');
}

/**
 * 取所有指定名称的子节点。
 *
 * @param node 父节点。
 * @param name 子节点 local name。
 * @returns 子节点数组。
 */
export function getChildren(node: XmlNode, name: string): XmlNode[] {
  void node;
  void name;
  return notImplemented('xml.getChildren');
}

/**
 * 取节点文本（仅叶子）。
 *
 * @param node XML 节点。
 * @returns 文本或空串。
 */
export function getText(node: XmlNode): string {
  void node;
  return notImplemented('xml.getText');
}