/**
 * XML 节点最小读取工具（local name 语义）。
 *
 * 结构上与引擎 XML 解析结果兼容（`name`/`attrs`/`children`/`text`），只服务于
 * Document.xml 声明补全，不进入公共导出面。
 */

/** XML 节点。 */
export interface DeclarationsXmlNode {
  /** local name（已去掉命名空间前缀）。 */
  readonly name: string;
  /** 属性表；属性名大小写敏感。 */
  readonly attrs: Readonly<Record<string, string>>;
  /** 子节点，按文档顺序。 */
  readonly children: readonly DeclarationsXmlNode[];
  /** 叶子文本。 */
  readonly text?: string;
}

/**
 * 取第一个指定名称的直接子节点。
 *
 * @param node 父节点；可为空。
 * @param name 子节点 local name。
 * @returns 子节点或 undefined。
 */
export function childNode(
  node: DeclarationsXmlNode | undefined,
  name: string,
): DeclarationsXmlNode | undefined {
  return node?.children.find((child) => child.name === name);
}

/**
 * 取节点的叶子文本（去前后空白）。
 *
 * @param node 节点；可为空。
 * @returns 文本或空串。
 */
export function nodeText(node: DeclarationsXmlNode | undefined): string {
  return (node?.text ?? '').trim();
}

/**
 * 取节点属性值；已知标准拼写错误回退到兼容名。
 *
 * @param node 节点；可为空。
 * @param name 属性名（大小写敏感）。
 * @returns 属性值或 undefined。
 */
export function nodeAttr(
  node: DeclarationsXmlNode | undefined,
  name: string,
): string | undefined {
  const value = node?.attrs[name];
  return value === undefined ? undefined : value.trim();
}
