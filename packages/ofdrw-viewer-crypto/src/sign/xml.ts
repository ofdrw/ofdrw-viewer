/**
 * 轻量 XML 解析（签章/完整性元数据专用）。
 *
 * 设计目标：
 * - 只构建简单的元素树，元素/属性统一使用**本地名**（忽略命名空间前缀），
 *   兼容 `ofd:` 前缀与默认命名空间两种写法；
 * - 保留元素直接文本，便于读取 `BaseLoc`、`CheckValue` 等路径/摘要；
 * - 限制输入大小、嵌套深度与节点数量，避免恶意 XML 造成 DoS；
 * - 不解析 DTD/外部实体（saxes 默认不加载外部实体），不执行任何脚本。
 *
 * 本模块只被 sign/seal/integrity/verify 内部使用，不属于包公共 API。
 */

import { SaxesParser, type SaxesTagNS } from 'saxes';
import { CryptoError } from '../errors';
import { DEFAULT_CRYPTO_LIMITS } from '../types/limits';
import { utf8Decode } from '../util/bytes';

/** XML 元素树节点。 */
export class XmlElement {
  /** 元素本地名（不含命名空间前缀）。 */
  readonly name: string;
  /** 属性：本地名 → 值；同名不同命名空间的属性以后出现者为准。 */
  readonly attributes: ReadonlyMap<string, string>;
  /** 子元素（只含元素，不含文本节点）。 */
  readonly children: readonly XmlElement[];
  /** 直接子文本（已去除首尾空白）。 */
  readonly text: string;

  /**
   * 创建节点；仅供解析器内部使用。
   *
   * @param name 元素本地名。
   * @param attributes 属性表。
   * @param children 子元素。
   * @param text 直接文本。
   */
  constructor(
    name: string,
    attributes: ReadonlyMap<string, string>,
    children: readonly XmlElement[],
    text: string,
  ) {
    this.name = name;
    this.attributes = attributes;
    this.children = children;
    this.text = text;
  }

  /**
   * 读取属性值（按本地名）。
   *
   * @param name 属性本地名，例如 `BaseLoc`。
   * @returns 属性值；不存在时返回 undefined。
   */
  attribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  /**
   * 查找第一个指定名称的直接子元素。
   *
   * @param name 子元素本地名。
   * @returns 子元素或 undefined。
   */
  find(name: string): XmlElement | undefined {
    return this.children.find((child) => child.name === name);
  }

  /**
   * 查找全部指定名称的直接子元素。
   *
   * @param name 子元素本地名。
   * @returns 子元素数组；没有时为空数组。
   */
  findAll(name: string): readonly XmlElement[] {
    return this.children.filter((child) => child.name === name);
  }

  /**
   * 按层级查找后代元素。
   *
   * @param names 依次匹配的元素本地名。
   * @returns 命中的后代元素；任一层缺失时返回 undefined。
   */
  findPath(...names: readonly string[]): XmlElement | undefined {
    let current: XmlElement | undefined = this;
    for (const name of names) {
      current = current.find(name);
      if (!current) return undefined;
    }
    return current;
  }

  /**
   * 读取直接子元素的文本。
   *
   * @param name 子元素本地名。
   * @returns 去除首尾空白后的文本；子元素不存在时返回 undefined。
   */
  textOf(name: string): string | undefined {
    return this.find(name)?.text;
  }
}

/** XML 解析选项。 */
export interface ParseXmlOptions {
  /** 输入字节上限，单位 byte；默认 `maxAsn1Bytes`。 */
  readonly maxBytes?: number;
  /** 最大嵌套深度（层）；默认 `maxAsn1Depth`。 */
  readonly maxDepth?: number;
  /** 最大元素数量；默认 100,000。 */
  readonly maxNodes?: number;
}

/** 默认最大元素数量。 */
const DEFAULT_MAX_XML_NODES = 100_000;

/**
 * 解析 XML 为元素树。
 *
 * @param bytes UTF-8 编码的 XML 字节。
 * @param options 大小/深度/节点上限。
 * @returns 根元素。
 * @throws CryptoError `CRYPTO_INVALID_PACKAGE`：XML 语法错误或没有根元素；
 *   `CRYPTO_LIMIT_EXCEEDED`：超过上限；`CRYPTO_INVALID_ARGUMENT`：参数非法。
 */
export function parseXml(bytes: Uint8Array, options: ParseXmlOptions = {}): XmlElement {
  if (!(bytes instanceof Uint8Array)) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'XML 输入必须是 Uint8Array');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Bytes;
  const maxDepth = options.maxDepth ?? DEFAULT_CRYPTO_LIMITS.maxAsn1Depth;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_XML_NODES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'XML maxBytes 必须是正整数');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'XML maxDepth 必须是正整数');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new CryptoError('CRYPTO_INVALID_ARGUMENT', 'XML maxNodes 必须是正整数');
  }
  if (bytes.length === 0) throw xmlError('XML 输入为空');
  if (bytes.length > maxBytes) {
    throw new CryptoError(
      'CRYPTO_LIMIT_EXCEEDED',
      `XML 大小 ${bytes.length} byte 超过上限 ${maxBytes} byte`,
    );
  }

  const text = stripBom(utf8Decode(bytes));
  const parser = new SaxesParser({ xmlns: true });
  const stack: MutableNode[] = [];
  let rootNode: MutableNode | undefined;
  let nodeCount = 0;
  let failure: CryptoError | undefined;

  const appendText = (value: string): void => {
    const current = stack[stack.length - 1];
    if (current) current.text += value;
  };

  parser.on('opentag', (tag: SaxesTagNS) => {
    nodeCount += 1;
    if (nodeCount > maxNodes) {
      failure ??= new CryptoError(
        'CRYPTO_LIMIT_EXCEEDED',
        `XML 元素数量超过上限 ${maxNodes}`,
      );
      return;
    }
    if (stack.length + 1 > maxDepth) {
      failure ??= new CryptoError('CRYPTO_LIMIT_EXCEEDED', `XML 嵌套深度超过上限 ${maxDepth}`);
      return;
    }
    const attributes = new Map<string, string>();
    for (const attribute of Object.values(tag.attributes)) {
      attributes.set(attribute.local || attribute.name, attribute.value);
    }
    const node: MutableNode = {
      name: tag.local || localNameOf(tag.name),
      attributes,
      children: [],
      text: '',
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else rootNode = node;
    stack.push(node);
  });

  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('error', (error: Error) => {
    failure ??= xmlError(`XML 解析失败：${error.message}`);
  });

  try {
    parser.write(text).close();
  } catch (error) {
    if (failure) throw failure;
    throw xmlError(`XML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (failure) throw failure;
  if (!rootNode) throw xmlError('XML 没有根元素');
  return toXmlElement(rootNode);
}

/**
 * 把可变节点树转换为只读元素树。
 *
 * @param node 可变节点。
 * @returns 只读元素。
 */
function toXmlElement(node: MutableNode): XmlElement {
  const children = Object.freeze(node.children.map((child) => toXmlElement(child)));
  return new XmlElement(node.name, node.attributes, children, node.text.trim());
}

/** 解析过程中的可变节点。 */
interface MutableNode {
  /** 本地名。 */
  name: string;
  /** 属性表。 */
  attributes: Map<string, string>;
  /** 子节点。 */
  children: MutableNode[];
  /** 直接文本。 */
  text: string;
}

/**
 * 去掉 UTF-8 BOM。
 *
 * @param text 文本。
 * @returns 无 BOM 文本。
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 构造 XML 解析错误。
 *
 * @param message 诊断信息。
 * @returns CryptoError。
 */
function xmlError(message: string): CryptoError {
  return new CryptoError('CRYPTO_INVALID_PACKAGE', message);
}

/**
 * 去掉 `prefix:` 前缀。
 *
 * @param name 限定名。
 * @returns 本地名。
 */
function localNameOf(name: string): string {
  const index = name.indexOf(':');
  return index >= 0 ? name.slice(index + 1) : name;
}
