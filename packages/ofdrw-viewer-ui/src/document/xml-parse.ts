/**
 * Document.xml 的最小 XML 解析。
 *
 * 引擎不导出 XML 解析器，而 Document.xml 的 `VPreferences`/`Permissions` 需要阅读器
 * 自行读取；这里提供一个只覆盖 OFD 声明所需能力的解析器：元素、属性、文本，忽略
 * 注释/处理指令/CDATA 结束标记。拒绝 DOCTYPE 与外部实体，避免 XXE。
 */

import type { DeclarationsXmlNode } from './xml-node';

/** 解析上限。 */
const MAX_DEPTH = 128;
const MAX_NODES = 200_000;

/** 可变的解析中间节点。 */
interface MutableNode {
  name: string;
  attrs: Record<string, string>;
  children: MutableNode[];
  texts: string[];
}

/** 命名空间声明属性；其值不参与属性比对。 */
const XMLNS_ATTR = /^xmlns(:[\w.-]+)?$/;

/**
 * 解析 OFD 包内 XML 声明文件。
 *
 * @param bytes UTF-8 编码的 XML 字节。
 * @returns 根节点（local name 语义）。
 * @throws {Error} DOCTYPE、结构非法、超出节点/深度上限时。
 */
export function parseDocumentXml(bytes: Uint8Array): DeclarationsXmlNode {
  const text = new TextDecoder('utf-8').decode(bytes);
  const stack: MutableNode[] = [];
  let root: MutableNode | undefined;
  let nodes = 0;
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open === -1) break;
    const close = findTagEnd(text, open);
    if (close === -1) break;
    const inner = text.slice(open + 1, close);
    const between = text.slice(index, open);
    if (between && stack.length > 0) stack[stack.length - 1]!.texts.push(decodeEntities(between));
    index = close + 1;
    if (inner.startsWith('!DOCTYPE') || inner.startsWith('!doctype')) {
      throw new Error('XML 包含 DOCTYPE，已拒绝');
    }
    if (inner.startsWith('!--') || inner.startsWith('?') || inner.startsWith('!')) {
      // 注释、处理指令、CDATA 结束标记：不属于声明节点内容。
      if (inner.startsWith('![CDATA[') && stack.length > 0) {
        stack[stack.length - 1]!.texts.push(inner.slice(8));
      } else if (inner.startsWith('![') && stack.length > 0) {
        stack[stack.length - 1]!.texts.push(inner.slice(2));
      }
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const node = stack.pop();
      if (!node || localNameOf(node.name) !== localNameOf(name)) {
        throw new Error(`XML 标签不匹配：${name}`);
      }
      continue;
    }
    const { tag, attrs } = splitTag(body);
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error('XML 节点数超过限制');
    const node: MutableNode = { name: tag, attrs, children: [], texts: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root) throw new Error('XML 存在多个根节点');
    else root = node;
    if (selfClosing) continue;
    if (stack.length >= MAX_DEPTH) throw new Error('XML 嵌套深度超过限制');
    stack.push(node);
  }
  if (!root || stack.length > 0) throw new Error('XML 结构不完整');
  return freezeNode(root);
}

/** 找到标签结束的 `>`，引号内的 `>` 不算结束。 */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let index = from + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

/**
 * 拆分标签名与属性。
 *
 * 标签名与属性名统一去掉命名空间前缀（OFD 标准示例使用 `ofd:` 前缀）。
 *
 * @param body 标签内部文本（不含 `<>` 与结尾 `/`）。
 * @returns local name 形式的标签名与属性表。
 */
function splitTag(body: string): { tag: string; attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  const match = /^[\w:.-]+/.exec(body);
  const tag = match?.[0] ?? '';
  if (!tag) throw new Error('XML 标签名缺失');
  const rest = body.slice(tag.length);
  const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let item: RegExpExecArray | null;
  while ((item = attrPattern.exec(rest)) !== null) {
    const rawName = item[1]!;
    if (XMLNS_ATTR.test(rawName)) continue;
    attrs[localNameOf(rawName)] = decodeEntities(item[2] ?? item[3] ?? '');
  }
  return { tag: localNameOf(tag), attrs };
}

/** 去掉命名空间前缀。 */
function localNameOf(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/** 解码 XML 实体。 */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const codePoint = entity.startsWith('#x') || entity.startsWith('#X')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
    }
  });
}

/** 冻结为只读节点。 */
function freezeNode(node: MutableNode): DeclarationsXmlNode {
  const text = node.texts.join('').trim();
  return {
    name: node.name,
    attrs: node.attrs,
    children: node.children.map(freezeNode),
    ...(text ? { text } : {}),
  };
}
