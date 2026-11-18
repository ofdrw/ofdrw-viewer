/**
 * GB/T 33190—2016 条款样例使用的 XML 序列化小工具。
 *
 * 样例文档包含渐变、多媒体、动作等普通夹具不覆盖的节点，节点层级较深，
 * 因此单独提供极简的「元素描述 → XML 文本」转换，避免手写大段字符串时的转义遗漏。
 */

/** 元素描述：名称、属性与子节点（子节点可以是字符串，表示文本节点）。 */
export interface XmlElement {
  /** 元素名，含命名空间前缀，例如 `ofd:PathObject`。 */
  name: string;
  /** 属性表；值会做 XML 转义。 */
  attrs?: Record<string, string | number | boolean>;
  /** 子节点；字符串按文本节点输出并转义。 */
  children?: readonly (XmlElement | string)[];
}

/**
 * 转义 XML 文本与属性值。
 *
 * @param value 原始文本。
 * @returns 转义后的文本。
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把元素描述序列化为 XML 文本。
 *
 * 空元素输出自闭合形式；含文本子节点时不再缩进，保持可读性。
 *
 * @param element 元素描述。
 * @param indent 当前缩进层级，从 0 开始。
 * @returns XML 文本。
 */
export function serializeXml(element: XmlElement, indent = 0): string {
  const pad = '  '.repeat(indent);
  const attrs = Object.entries(element.attrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(typeof value === 'number' ? formatNumber(value) : String(value))}"`)
    .join('');
  const children = element.children ?? [];
  if (children.length === 0) return `${pad}<${element.name}${attrs}/>`;

  const hasTextChild = children.some((child) => typeof child === 'string');
  if (hasTextChild) {
    const inner = children
      .map((child) => (typeof child === 'string' ? escapeXml(child) : serializeXml(child, 0)))
      .join('');
    return `${pad}<${element.name}${attrs}>${inner}</${element.name}>`;
  }
  const body = children
    .map((child) => (typeof child === 'string' ? `${pad}  ${escapeXml(child)}` : serializeXml(child, indent + 1)))
    .join('\n');
  return `${pad}<${element.name}${attrs}>\n${body}\n${pad}</${element.name}>`;
}

/**
 * 序列化完整 XML 文档（含声明）。
 *
 * @param root 根元素。
 * @returns 带 `<?xml?>` 声明的完整文档文本。
 */
export function serializeXmlDocument(root: XmlElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeXml(root)}\n`;
}

/**
 * 按 OFD 惯例格式化数值：最多保留 4 位小数，去掉多余尾零。
 *
 * @param value 数值。
 * @returns 数值文本。
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4)));
}

/**
 * 把数值数组格式化为 OFD 的 `ST_Array` 文本（空格分隔）。
 *
 * @param values 数值数组。
 * @returns 空格分隔的数组文本。
 */
export function formatArray(values: readonly number[]): string {
  return values.map(formatNumber).join(' ');
}