/**
 * 解密流程使用的最小严格 XML 解析器。
 *
 * 只构建元素树，不处理 DTD/外部实体；拒绝 DOCTYPE、注释上限外的输入与
 * 非法 XML。命名空间按 localName 匹配，因此不依赖 `ofd:` 前缀。
 */

import { SaxesParser } from 'saxes';
import { CryptoError } from '../errors';

/** XML 元素节点。 */
export interface XmlElement {
  /** 完整限定名（含前缀）。 */
  readonly name: string;
  /** 本地名（不含前缀）。 */
  readonly localName: string;
  /** 属性表；同时支持完整名与本地名查找。 */
  readonly attributes: ReadonlyMap<string, string>;
  /** 子元素。 */
  readonly children: XmlElement[];
  /** 直接文本内容（已 trim）。 */
  text: string;
}

/** 解析上限。 */
export interface XmlParseLimits {
  /** XML 文本最大字节数，单位 byte。 */
  readonly maxBytes: number;
  /** 元素最大嵌套深度。 */
  readonly maxDepth: number;
}

/** 默认嵌套深度上限。 */
const DEFAULT_MAX_DEPTH = 128;
/** 元素总数上限，避免实体/超大 XML 消耗内存。 */
const MAX_ELEMENTS = 200_000;

/**
 * 读取元素属性。
 *
 * @param element 元素。
 * @param name 属性名（完整名或本地名）。
 * @returns 属性值；不存在返回 undefined。
 */
export function xmlAttr(element: XmlElement, name: string): string | undefined {
  return element.attributes.get(name);
}

/**
 * 查找第一个指定本地名的子元素。
 *
 * @param element 父元素。
 * @param localName 本地名。
 * @returns 子元素或 undefined。
 */
export function xmlChild(element: XmlElement, localName: string): XmlElement | undefined {
  return element.children.find((child) => child.localName === localName);
}

/**
 * 查找全部指定本地名的子元素。
 *
 * @param element 父元素。
 * @param localName 本地名。
 * @returns 子元素数组。
 */
export function xmlChildren(element: XmlElement, localName: string): XmlElement[] {
  return element.children.filter((child) => child.localName === localName);
}

/**
 * 递归查找第一个指定本地名的后代元素（含自身）。
 *
 * @param element 根元素。
 * @param localName 本地名。
 * @returns 元素或 undefined。
 */
export function xmlFind(element: XmlElement, localName: string): XmlElement | undefined {
  if (element.localName === localName) return element;
  for (const child of element.children) {
    const found = xmlFind(child, localName);
    if (found) return found;
  }
  return undefined;
}

/**
 * 读取子元素文本。
 *
 * @param element 父元素。
 * @param localName 子元素本地名。
 * @returns trim 后的文本；不存在返回 undefined。
 */
export function xmlChildText(element: XmlElement, localName: string): string | undefined {
  const child = xmlChild(element, localName);
  if (!child) return undefined;
  const text = child.text.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * 严格解析 XML 文本。
 *
 * @param text UTF-8 文本。
 * @param limits 大小/深度上限。
 * @returns 根元素。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：XML 非法/超限/含 DOCTYPE。
 */
export function parseXml(text: string, limits: XmlParseLimits): XmlElement {
  if (typeof text !== 'string' || text.length === 0) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'XML 内容为空');
  }
  if (new TextEncoder().encode(text).length > limits.maxBytes) {
    throw new CryptoError('CRYPTO_LIMIT_EXCEEDED', 'XML 大小超过上限');
  }
  const maxDepth = limits.maxDepth > 0 ? limits.maxDepth : DEFAULT_MAX_DEPTH;

  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let elementCount = 0;
  let failure: Error | undefined;

  parser.on('error', (error: Error) => {
    failure ??= error;
  });
  parser.on('doctype', () => {
    failure ??= new Error('不允许 DOCTYPE');
  });
  parser.on('opentag', (tag) => {
    if (failure) return;
    elementCount += 1;
    if (elementCount > MAX_ELEMENTS) {
      failure = new Error('XML 元素数量超过上限');
      return;
    }
    if (stack.length + 1 > maxDepth) {
      failure = new Error('XML 嵌套深度超过上限');
      return;
    }
    const attributes = new Map<string, string>();
    for (const attribute of Object.values(tag.attributes)) {
      attributes.set(attribute.name, attribute.value);
      if (attribute.local !== attribute.name) attributes.set(attribute.local, attribute.value);
    }
    const element: XmlElement = {
      name: tag.name,
      localName: tag.local,
      attributes,
      children: [],
      text: '',
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) {
      failure = new Error('XML 存在多个根元素');
      return;
    } else root = element;
    stack.push(element);
  });
  parser.on('text', (data: string) => {
    if (failure) return;
    const current = stack[stack.length - 1];
    if (current) current.text += data;
  });
  parser.on('cdata', (data: string) => {
    if (failure) return;
    const current = stack[stack.length - 1];
    if (current) current.text += data;
  });
  parser.on('closetag', () => {
    stack.pop();
  });

  try {
    parser.write(text).close();
  } catch (error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
  }
  if (failure) {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', `XML 解析失败：${failure.message}`);
  }
  if (!root) throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'XML 缺少根元素');
  return root;
}

/**
 * 严格 UTF-8 解码。
 *
 * @param bytes 字节。
 * @returns 文本。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：非法 UTF-8。
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CryptoError('CRYPTO_INVALID_PACKAGE', 'XML 不是合法 UTF-8');
  }
}
