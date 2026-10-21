/**
 * saxes 封装与 XML 辅助访问。
 *
 * 解析时使用 `xmlns:false`、忽略命名空间前缀，节点名只保留 local name；
 * 必须拒绝 DTD/外部实体（XXE），并限制节点数与嵌套深度。
 */

import { SaxesParser } from 'saxes';
import type { XmlNode, XmlParseOptions, XmlParser } from './types';
import { OFDError } from '../errors';

/** 默认最大节点数。 */
const DEFAULT_MAX_NODES = 200_000;
/** 默认最大嵌套深度。 */
const DEFAULT_MAX_DEPTH = 128;

/**
 * 已知的标准拼写错误 → 规范属性名。
 *
 * 解析时把错误拼写同时写入规范名，方便模型层按规范名读取；
 * `getAttr` 也会做同样的兼容查找。
 */
const ATTRIBUTE_TYPO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  LineWidth: ['LineWidth', 'LincWidth'],
  Scrim: ['Scrim', 'Scrif'],
  CodePosition: ['CodePosition', 'CodecPosition'],
  CodeCount: ['CodeCount', 'CodecCount'],
};

/** 反向别名表：错误拼写 → 规范名。 */
const TYPO_TO_CANONICAL: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const [canonical, candidates] of Object.entries(ATTRIBUTE_TYPO_ALIASES)) {
    for (const candidate of candidates) {
      if (candidate !== canonical) map[candidate] = canonical;
    }
  }
  return map;
})();

/** 基于 saxes 的解析器；`xmlns:false`，不处理命名空间。 */
export class SaxesXmlParser implements XmlParser {
  /**
   * 解析 XML。
   *
   * @param xml UTF-8 文本或字节。
   * @param options 解析限制。
   * @returns 根节点。
   * @throws OFDError `OFD_XML_PARSE`/`OFD_LIMIT_EXCEEDED` 当 XML 非法或超限时。
   */
  parse(xml: string | Uint8Array, options?: XmlParseOptions): XmlNode {
    const text = decodeXmlText(xml);
    if (text.trim().length === 0) {
      throw new OFDError('OFD_XML_PARSE', 'XML 内容为空');
    }
    if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) {
      throw new OFDError('OFD_XML_PARSE', 'XML 包含 DTD/实体声明，已按 XXE 防护拒绝');
    }

    const maxNodes = normalizeLimit(options?.maxNodes, DEFAULT_MAX_NODES);
    const maxDepth = normalizeLimit(options?.maxDepth, DEFAULT_MAX_DEPTH);
    const parser = new SaxesParser({ xmlns: false });
    const stack: XmlNode[] = [];
    const texts: string[][] = [];
    let root: XmlNode | undefined;
    let nodeCount = 0;

    parser.on('doctype', () => {
      throw new OFDError('OFD_XML_PARSE', 'XML 包含 DOCTYPE，已拒绝');
    });

    parser.on('opentag', (tag) => {
      nodeCount += 1;
      if (maxNodes > 0 && nodeCount > maxNodes) {
        throw new OFDError('OFD_LIMIT_EXCEEDED', `XML 节点数超过限制 ${maxNodes}`);
      }
      if (maxDepth > 0 && stack.length >= maxDepth) {
        throw new OFDError('OFD_LIMIT_EXCEEDED', `XML 嵌套深度超过限制 ${maxDepth}`);
      }

      const parent = stack[stack.length - 1];
      if (!parent && root) {
        throw new OFDError('OFD_XML_PARSE', 'XML 存在多个根节点');
      }
      const node: XmlNode = {
        name: localName(tag.name),
        attrs: convertAttributes(tag.attributes),
        children: [],
      };
      if (parent) parent.children.push(node);
      else root = node;
      stack.push(node);
      texts.push([]);
    });

    parser.on('text', (value) => {
      texts[texts.length - 1]?.push(value);
    });

    parser.on('cdata', (value) => {
      texts[texts.length - 1]?.push(value);
    });

    parser.on('closetag', () => {
      const node = stack.pop();
      const chunks = texts.pop();
      if (!node) return;
      if (chunks && chunks.length > 0) {
        const value = chunks.join('');
        if (value.length > 0) node.text = value;
      }
    });

    parser.on('error', (error) => {
      throw new OFDError('OFD_XML_PARSE', `XML 解析失败：${error.message}`, { cause: error });
    });

    try {
      parser.write(text).close();
    } catch (error) {
      if (error instanceof OFDError) throw error;
      throw new OFDError('OFD_XML_PARSE', `XML 解析失败：${String(error)}`, { cause: error });
    }
    if (!root) throw new OFDError('OFD_XML_PARSE', 'XML 缺少根节点');
    return root;
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
  return new SaxesXmlParser().parse(xml, options);
}

/**
 * 按精确名称取属性；已知标准拼写错误会回退到兼容名。
 *
 * @param node XML 节点。
 * @param name 属性名（大小写敏感）。
 * @returns 属性值或 undefined。
 */
export function getAttr(node: XmlNode, name: string): string | undefined {
  const direct = node.attrs[name];
  if (direct !== undefined) return direct;
  const candidates = ATTRIBUTE_TYPO_ALIASES[name];
  if (candidates) {
    for (const candidate of candidates) {
      const value = node.attrs[candidate];
      if (value !== undefined) return value;
    }
  }
  const canonical = TYPO_TO_CANONICAL[name];
  if (canonical !== undefined) return node.attrs[canonical];
  return undefined;
}

/**
 * 按精确名称取必需属性。
 *
 * @param node XML 节点。
 * @param name 属性名。
 * @returns 属性值；缺失时抛 OFDError `OFD_XML_PARSE`。
 */
export function getRequiredAttr(node: XmlNode, name: string): string {
  const value = getAttr(node, name);
  if (value === undefined) {
    throw new OFDError('OFD_XML_PARSE', `节点 ${node.name} 缺少必需属性 ${name}`);
  }
  return value;
}

/**
 * 取第一个指定名称的子节点。
 *
 * @param node 父节点。
 * @param name 子节点 local name。
 * @returns 子节点或 undefined。
 */
export function getChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

/**
 * 取所有指定名称的子节点。
 *
 * @param node 父节点。
 * @param name 子节点 local name。
 * @returns 子节点数组（保持文档顺序）。
 */
export function getChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/**
 * 取节点文本（仅叶子，去前后空白）。
 *
 * @param node XML 节点。
 * @returns 文本或空串。
 */
export function getText(node: XmlNode): string {
  return (node.text ?? '').trim();
}

/**
 * 取 local name。
 *
 * @param name 原始标签/属性名，可能带 `prefix:`。
 * @returns `:` 之后的部分。
 */
function localName(name: string): string {
  const index = name.lastIndexOf(':');
  return index >= 0 ? name.slice(index + 1) : name;
}

/**
 * 把 saxes 属性表转换为 XmlNode 属性表。
 *
 * 保留原始属性名；带前缀的属性额外写入 local name（不覆盖同名属性）；
 * 跳过 `xmlns` 声明与已知拼写错误的兼容别名写入。
 *
 * @param attributes saxes 的 `name → value` 表。
 * @returns 属性表。
 */
function convertAttributes(attributes: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(attributes)) {
    if (rawName === 'xmlns' || rawName.startsWith('xmlns:')) continue;
    if (!(rawName in result)) result[rawName] = value;
    const local = localName(rawName);
    if (local !== rawName && !(local in result)) result[local] = value;
  }
  for (const [canonical, candidates] of Object.entries(ATTRIBUTE_TYPO_ALIASES)) {
    if (result[canonical] !== undefined) continue;
    for (const candidate of candidates) {
      const value = result[candidate];
      if (value !== undefined) {
        result[canonical] = value;
        break;
      }
    }
  }
  return result;
}

/**
 * 解码 XML 字节；UTF-8（含 BOM）。
 *
 * @param xml 文本或字节。
 * @returns 文本。
 */
function decodeXmlText(xml: string | Uint8Array): string {
  if (typeof xml === 'string') return xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const text = new TextDecoder('utf-8').decode(xml);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 归一化解析限制；0/负数/非有限值使用默认值。
 *
 * @param value 原始限制。
 * @param fallback 默认限制。
 * @returns 非负限制。
 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}