/**
 * 极简 XML 构造工具（测试 fixture 专用）。
 *
 * 只负责转义与拼接，不校验 OFD schema；用于生成结构可预期的合成包。
 */

/** XML 元素描述。 */
export interface XmlElementSpec {
  /** 元素名，可带前缀（如 `ofd:Page`）。 */
  name: string;
  /** 属性表；数字按十进制字符串写入。 */
  attrs?: Record<string, string | number>;
  /** 子元素或文本片段（字符串会转义）。 */
  children?: readonly (XmlElementSpec | string)[];
}

/**
 * 转义 XML 文本/属性值。
 *
 * @param value 原始文本。
 * @returns 转义后的文本。
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 序列化单个 XML 元素。
 *
 * @param element 元素描述。
 * @returns XML 文本（无声明）。
 */
export function buildXmlElement(element: XmlElementSpec): string {
  const attrs = Object.entries(element.attrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
  const children = element.children ?? [];
  if (children.length === 0) return `<${element.name}${attrs}/>`;
  const inner = children
    .map((child) => (typeof child === 'string' ? escapeXml(child) : buildXmlElement(child)))
    .join('');
  return `<${element.name}${attrs}>${inner}</${element.name}>`;
}

/**
 * 序列化为带 XML 声明的文档。
 *
 * @param root 根元素。
 * @returns 完整 XML 文本（UTF-8，无 BOM）。
 */
export function buildXmlDocument(root: XmlElementSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${buildXmlElement(root)}`;
}