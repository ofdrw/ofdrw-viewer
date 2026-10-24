/**
 * Document.xml 头部声明解码。
 *
 * 头部声明来源有三处：`Document` 根属性、`Document/PageArea`、`Document/PublicRes`、
 * 以及 `CommonData` 下的 `DocumentRes`/`TemplatePageRes`/`DefaultCS`/`MaxUnitID`。
 * 这里只做 XML → 数据模型转换，路径一律经 `resolvePackagePath` 规范化；
 * 非法数值降级为省略并上报 `W_METADATA_FIELD`，不阻断打开。
 */

import type { XmlNode } from '../xml/types';
import type { DocumentHeader, DocumentPageArea } from '../api/ui-types';
import { resolvePackagePath } from '../container/path';
import type { DecodeOptions } from './decode';
import { attr, child, childText, children, emitWarning, normalizePathSeparators, parseBoxChild } from './decode-utils';

/** 读取一个可选的正整数字段；缺失返回 undefined，非法时省略并 warning。 */
function optionalNumberAttr(
  node: XmlNode,
  name: string,
  options: DecodeOptions | undefined,
): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === '') return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    emitWarning(options, 'W_METADATA_FIELD', `${name} 不是合法的非负整数：${JSON.stringify(raw)}`);
    return undefined;
  }
  return value;
}

/** 解析子元素路径为包内路径；非法路径 warning 后跳过。 */
function resolvePathChild(
  node: XmlNode,
  name: string,
  options: DecodeOptions | undefined,
): string[] {
  const result: string[] = [];
  for (const item of children(node, name)) {
    const raw = (item.text ?? '').trim();
    if (!raw) continue;
    try {
      result.push(resolvePackagePath('', normalizePathSeparators(raw)));
    } catch (error) {
      emitWarning(
        options,
        'W_METADATA_FIELD',
        `${name} 路径非法：${JSON.stringify(raw)}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
  return result;
}

/**
 * 解码页面区三组矩形。
 *
 * @param node 页面区节点（通常为 `PageArea`）。
 * @param options 解码选项；非法矩形通过 warning 上报。
 * @returns 三组矩形均缺失时返回 undefined；几何单位 mm。
 */
function decodePageArea(node: XmlNode, options?: DecodeOptions): DocumentPageArea | undefined {
  const physicalBox = parseBoxChild(node, 'PhysicalBox', options);
  const applicationBox = parseBoxChild(node, 'ApplicationBox', options);
  const bleedBox = parseBoxChild(node, 'BleedBox', options);
  if (!physicalBox && !applicationBox && !bleedBox) return undefined;
  return {
    ...(physicalBox ? { physicalBox } : {}),
    ...(applicationBox ? { applicationBox } : {}),
    ...(bleedBox ? { bleedBox } : {}),
  };
}

/**
 * 解码 Document.xml 头部声明。
 *
 * 相对路径按 `resolvePackagePath('', raw)` 解析，即视为包根相对路径。
 *
 * @param node Document.xml 的 `Document` 根节点。
 * @param options 解码选项；非法数值/路径通过 `W_METADATA_FIELD` 上报。
 * @returns 头部声明；无任何可识别字段时返回 undefined。
 */
export function decodeDocumentHeader(
  node: XmlNode,
  options?: DecodeOptions,
): DocumentHeader | undefined {
  const result: DocumentHeader = {};

  const docId = (attr(node, 'DocID') ?? '').trim();
  if (docId) result.docId = docId;
  const version = (attr(node, 'Version') ?? '').trim();
  if (version) result.version = version;
  const maxUnitId = optionalNumberAttr(node, 'MaxUnitID', options);
  if (maxUnitId !== undefined) result.maxUnitId = maxUnitId;
  const docUsage = (attr(node, 'DocUsage') ?? '').trim();
  if (docUsage) result.docUsage = docUsage;

  // PageArea：标准写法在 Document 根下；部分实现放在 CommonData 下，一并兼容。
  const pageAreaNode = child(node, 'PageArea') ?? child(child(node, 'CommonData') ?? node, 'PageArea');
  const pageArea = pageAreaNode ? decodePageArea(pageAreaNode, options) : undefined;
  if (pageArea) result.pageArea = pageArea;

  const commonDataNode = child(node, 'CommonData');
  const publicRes = resolvePathChild(node, 'PublicRes', options);
  if (publicRes.length > 0) result.publicRes = publicRes;
  if (commonDataNode) {
    const documentRes = resolvePathChild(commonDataNode, 'DocumentRes', options);
    if (documentRes.length > 0) result.documentRes = documentRes;
    const templatePageRes = resolvePathChild(commonDataNode, 'TemplatePageRes', options);
    if (templatePageRes.length > 0) result.templatePageRes = templatePageRes;

    const defaultCs = (childText(commonDataNode, 'DefaultCS') ?? '').trim();
    if (defaultCs) result.defaultCs = defaultCs;
    if (result.maxUnitId === undefined) {
      const commonMaxUnitId = childText(commonDataNode, 'MaxUnitID');
      if (commonMaxUnitId !== undefined) {
        const value = Number(commonMaxUnitId);
        if (Number.isInteger(value) && value >= 0) result.maxUnitId = value;
        else emitWarning(options, 'W_METADATA_FIELD', `MaxUnitID 不是合法的非负整数：${JSON.stringify(commonMaxUnitId)}`);
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
