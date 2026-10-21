/**
 * XML 解析层冻结契约。
 *
 * 只描述解析结果与解析器接口；具体 saxes 封装、数字/布尔解析放在 `xml/parser.ts`
 * 与 `xml/numbers.ts`。本文件保持类型-only，方便其他模块只读复用。
 */

/** XML 节点；只保留 local name、属性、子节点与叶子文本。 */
export interface XmlNode {
  /** local name（已去掉命名空间前缀）。 */
  name: string;
  /** 属性表；属性名大小写敏感。 */
  attrs: Record<string, string>;
  /** 子节点，按文档顺序。 */
  children: XmlNode[];
  /** 叶子文本；仅叶子节点可能非空。 */
  text?: string;
}

/** XML 解析限制。 */
export interface XmlParseOptions {
  /** 最大节点数，默认 200000。 */
  maxNodes?: number;
  /** 最大嵌套深度，默认 128。 */
  maxDepth?: number;
}

/** XML 解析器；实现必须拒绝 DTD/外部实体（XXE）。 */
export interface XmlParser {
  /**
   * 解析完整 XML 文本/字节。
   *
   * @param xml UTF-8 文本或字节。
   * @param options 解析限制。
   * @returns 根节点。
   */
  parse(xml: string | Uint8Array, options?: XmlParseOptions): XmlNode;
}

/** 坏数字回调；用于把 `W_BAD_NUMBER` 交给上层统一去重。 */
export type BadNumberHandler = (raw: string | undefined, fallback: number, reason: string) => void;

/** `toNumber` 的签名：解析数值，失败时返回 fallback 并报告。 */
export type ToNumber = (
  raw: string | undefined,
  fallback: number,
  onBadNumber?: BadNumberHandler,
) => number;

/** `toNumberArray` 的签名：解析数值数组，支持 `g <count> <value>` 压缩组。 */
export type ToNumberArray = (
  raw: string | undefined,
  fallback: readonly number[],
  onBadNumber?: BadNumberHandler,
) => number[];

/** `toBoolean` 的签名：`true/1/yes` 为真，`false/0/no` 为假。 */
export type ToBoolean = (
  raw: string | undefined,
  fallback: boolean,
  onBadNumber?: BadNumberHandler,
) => boolean;