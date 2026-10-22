/**
 * XML → 数据模型解码。
 *
 * 解析策略见设计方案 8.1/8.5：未知节点忽略、缺失属性用默认值并 warning、
 * 单个 XML 解析失败不应拖垮整个文档。
 */

import type { Box } from '../common/types';
import type { XmlNode } from '../xml/types';
import type { OFDWarning } from '../warnings';
import type {
  Annotation,
  ColorSpaceDef,
  CommonData,
  DocumentModel,
  DocInfo,
  PageModel,
  PageTree,
  ResourceDefinitionSet,
  ResourceId,
  TemplatePageDef,
} from './types';
import { dirnameOf, resolvePackagePath } from '../container/path';
import { normalizeResourceId } from './ids';
import { attr, child, childText, children, emitWarning, normalizePathSeparators, parseBoxChild } from './decode-utils';
import type { ContentDecodeContext } from './content';
import { decodeAnnotationsNode, decodePageBlockNode, decodePageContentNode } from './content';
import { decodeResourceSet } from './resource-decode';
import { flattenPageTree } from './page-tree';
import { decodeDocumentNavigation } from './navigation';
import { decodeDocInfo } from './doc-info';
import { decodePermissions } from './permissions';

/**
 * 解码函数通用选项。
 *
 * 所有 `decode*` 函数都把该对象放在参数末位，保持既有参数兼容；
 * 不允许通过隐藏字段二次解码绕过。
 */
export interface DecodeOptions {
  /** warning 回调；用于坏数字/缺失必选属性/重复 ID 等。 */
  onWarning?: (warning: OFDWarning) => void;
  /** 已解析的颜色空间表；Content 解码时解析颜色值使用。 */
  colorSpaces?: ReadonlyMap<ResourceId, ColorSpaceDef>;
  /** 默认颜色空间 ID（DefaultCS）；缺省回退 RGB。 */
  defaultColorSpaceId?: ResourceId;
}

/** OFD.xml 解析结果。 */
export interface OfdRootInfo {
  /** OFD 版本，例如 `1.0`。 */
  version: string;
  /** 文档根目录（DocRoot），包内绝对路径，已去掉前导 `/`。 */
  docRoots: string[];
  /** 选中的文档索引；默认 0。 */
  docRootIndex: number;
  /** DocBody 顺序对应的 DocInfo；DocBody 无 DocInfo 时为 undefined。 */
  docInfos: Array<DocInfo | undefined>;
}

/**
 * 解析 OFD.xml。
 *
 * @param root OFD.xml 根节点。
 * @param options 解码选项；DocInfo 非法字段通过 warning 上报。
 * @returns 版本、DocRoot 列表与各 DocBody 的 DocInfo。
 */
export function decodeOfdRoot(root: XmlNode, options?: DecodeOptions): OfdRootInfo {
  const version = (attr(root, 'Version') ?? '1.0').trim() || '1.0';
  const docRoots: string[] = [];
  const docInfos: Array<DocInfo | undefined> = [];
  const pushDocRoot = (value: string | undefined): boolean => {
    if (value === undefined) return false;
    const normalized = normalizeDocRoot(value);
    if (!normalized) return false;
    docRoots.push(normalized);
    return true;
  };
  // 标准结构：OFD/DocBody/DocRoot；同时兼容根节点直接放 DocRoot 的简化文件。
  for (const docBody of children(root, 'DocBody')) {
    const pushed = pushDocRoot(childText(docBody, 'DocRoot'));
    if (pushed) {
      const infoNode = child(docBody, 'DocInfo');
      docInfos.push(infoNode ? decodeDocInfo(infoNode, options) : undefined);
    }
  }
  // 简化文件可能把 DocRoot 直接放在 OFD 根下；支持多个。
  for (const docRoot of children(root, 'DocRoot')) {
    pushDocRoot((docRoot.text ?? '').trim());
  }
  return { version, docRoots, docRootIndex: 0, docInfos };
}

/**
 * 规范化 DocRoot：去前导/尾随 `/`、统一分隔符、拒绝 `..`。
 *
 * @param raw 原始 DocRoot。
 * @returns 包内目录；非法时返回空串。
 */
function normalizeDocRoot(raw: string): string {
  const value = normalizePathSeparators(raw)
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!value) return '';
  if (value.split('/').some((segment) => segment === '..')) return '';
  return value;
}

/**
 * 解析 Document.xml。
 *
 * @param root Document.xml 根节点。
 * @param filePath Document.xml 的包内路径。
 * @param options 解码选项。
 * @returns 文档模型（页引用由页树解码后填充）。
 */
export function decodeDocument(
  root: XmlNode,
  filePath: string,
  options?: DecodeOptions,
): DocumentModel {
  const baseDir = dirnameOf(filePath);
  const context = { ...(options?.onWarning ? { onWarning: options.onWarning } : {}) };
  const commonDataNode = child(root, 'CommonData');
  const commonData = commonDataNode ? decodeCommonData(commonDataNode, baseDir, options) : undefined;
  const pagesNode = child(root, 'Pages');
  let tree: PageTree = { pages: [], pageCount: 0 };
  if (pagesNode) {
    tree = flattenPageTree(pagesNode, baseDir, options);
  } else {
    emitWarning(context, 'W_BAD_NUMBER', 'Document 缺少 Pages 节点，按 0 页处理');
  }
  let annotationsFile: string | undefined;
  const annotationsRaw = childText(root, 'Annotations');
  if (annotationsRaw) {
    annotationsFile = resolveRelativePath(baseDir, annotationsRaw, options?.onWarning);
  }
  let attachmentsFile: string | undefined;
  const attachmentsRaw = childText(root, 'Attachments');
  if (attachmentsRaw) {
    attachmentsFile = resolveRelativePath(baseDir, attachmentsRaw, options?.onWarning);
  }
  const version = (attr(root, 'Version') ?? '').trim();
  const navigation = decodeDocumentNavigation(
    root,
    tree.pages.map((page) => page.id),
    options,
  );
  const permissions = decodePermissions(child(root, 'Permissions'), options);
  return {
    id: normalizeResourceId(attr(root, 'ID')),
    version,
    docRoot: baseDir,
    ofdFile: '',
    pages: tree.pages,
    pageCount: tree.pageCount,
    ...(commonData ? { commonData } : {}),
    templatePages: commonData?.templatePages ?? {},
    ...(annotationsFile ? { annotationsFile } : {}),
    ...(attachmentsFile ? { attachmentsFile } : {}),
    pageAnnotIndex: {},
    outlines: navigation.outlines,
    bookmarks: navigation.bookmarks,
    permissions,
  };
}

/**
 * 解码 CommonData。
 *
 * @param node `CommonData` 节点。
 * @param baseDir Document.xml 目录，用于解析资源与模板路径。
 * @param options 解码选项。
 * @returns 公共数据；路径均已解析为包内绝对路径。
 */
function decodeCommonData(node: XmlNode, baseDir: string, options?: DecodeOptions): CommonData {
  const context = { ...(options?.onWarning ? { onWarning: options.onWarning } : {}) };
  const result: CommonData = {};
  const pageAreaNode = child(node, 'PageArea');
  if (pageAreaNode) {
    const area = parseBoxChild(pageAreaNode, 'PhysicalBox', context);
    if (area) result.pageArea = area;
  }
  const publicRes: string[] = [];
  for (const item of children(node, 'PublicRes')) {
    const raw = (item.text ?? '').trim();
    if (!raw) continue;
    const resolved = resolveRelativePath(baseDir, raw, options?.onWarning);
    if (resolved) publicRes.push(resolved);
  }
  if (publicRes.length > 0) result.publicRes = publicRes;
  const documentRes: string[] = [];
  for (const item of children(node, 'DocumentRes')) {
    const raw = (item.text ?? '').trim();
    if (!raw) continue;
    const resolved = resolveRelativePath(baseDir, raw, options?.onWarning);
    if (resolved) documentRes.push(resolved);
  }
  if (documentRes.length > 0) result.documentRes = documentRes;
  const defaultRes = childText(node, 'DefaultRes');
  if (defaultRes) {
    const resolved = resolveRelativePath(baseDir, defaultRes, options?.onWarning);
    if (resolved) result.defaultRes = resolved;
  }
  const maxUnitId = childText(node, 'MaxUnitID');
  if (maxUnitId) result.maxUnitId = normalizeResourceId(maxUnitId);
  const defaultColorSpace = childText(node, 'DefaultCS');
  if (defaultColorSpace) result.defaultColorSpaceId = normalizeResourceId(defaultColorSpace);
  const templatePages: Record<ResourceId, TemplatePageDef> = {};
  for (const templateNode of children(node, 'TemplatePage')) {
    const id = normalizeResourceId(attr(templateNode, 'ID'));
    if (!id) {
      emitWarning(context, 'W_BAD_NUMBER', 'TemplatePage 缺少 ID，已跳过');
      continue;
    }
    if (templatePages[id]) {
      emitWarning(context, 'W_DUPLICATE_RESOURCE', `TemplatePage ID 重复：${id}，保留先出现者`, {
        resourceId: id,
      });
      continue;
    }
    const baseLocRaw = childText(templateNode, 'BaseLoc') ?? attr(templateNode, 'BaseLoc');
    if (!baseLocRaw) {
      emitWarning(context, 'W_BAD_NUMBER', `TemplatePage ${id} 缺少 BaseLoc，已跳过`, { resourceId: id });
      continue;
    }
    const baseLoc = resolveRelativePath(baseDir, baseLocRaw, options?.onWarning, id);
    if (!baseLoc) continue;
    const zOrderRaw = (attr(templateNode, 'ZOrder') ?? 'Background').trim();
    const zOrder =
      zOrderRaw === 'Background' || zOrderRaw === 'Body' || zOrderRaw === 'Foreground'
        ? zOrderRaw
        : 'Background';
    templatePages[id] = { id, baseLoc, zOrder };
  }
  if (Object.keys(templatePages).length > 0) result.templatePages = templatePages;
  return result;
}

/**
 * 解析相对 Document.xml 目录的包内路径。
 *
 * @param baseDir Document.xml 目录。
 * @param raw 相对/绝对路径。
 * @param onWarning warning 回调。
 * @param resourceId 资源 ID，用于 warning。
 * @returns 包内绝对路径；非法时 undefined。
 */
function resolveRelativePath(
  baseDir: string,
  raw: string,
  onWarning?: (warning: OFDWarning) => void,
  resourceId?: ResourceId,
): string | undefined {
  try {
    return resolvePackagePath(baseDir, normalizePathSeparators(raw.trim()));
  } catch (error) {
    const warning: OFDWarning = {
      code: 'W_BAD_NUMBER',
      message: `路径非法：${JSON.stringify(raw)}（${String(error)}）`,
    };
    if (resourceId) warning.resourceId = resourceId;
    onWarning?.(warning);
    return undefined;
  }
}

/**
 * 解析单个 Content.xml 为页面模型。
 *
 * @param root Content.xml 根节点。
 * @param pageId 页资源 ID。
 * @param filePath Content.xml 的包内路径。
 * @param options 解码选项。
 * @returns 页面模型；失败时由调用方返回空页并 warning。
 */
export function decodePageContent(
  root: XmlNode,
  pageId: ResourceId,
  filePath: string,
  options?: DecodeOptions,
): PageModel {
  const baseDir = dirnameOf(filePath);
  const context: ContentDecodeContext = {
    ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
    ...(options?.colorSpaces ? { colorSpaces: options.colorSpaces } : {}),
    ...(options?.defaultColorSpaceId ? { defaultColorSpaceId: options.defaultColorSpaceId } : {}),
    resolvePath: (raw: string) => resolveRelativePath(baseDir, raw, options?.onWarning),
  };
  context.decodePageBlock = (node) => decodePageBlockNode(node, context);
  return decodePageContentNode(root, pageId, context);
}

/**
 * 解析 PageRes.xml / PublicRes.xml / DocumentRes.xml。
 *
 * @param root 资源 XML 根节点。
 * @param filePath 资源 XML 的包内路径。
 * @param options 解码选项。
 * @returns 资源定义集合（尚未建立作用域）。
 */
export function decodePageResources(
  root: XmlNode,
  filePath: string,
  options?: DecodeOptions,
): ResourceDefinitionSet {
  return decodeResourceSet(root, filePath, options);
}

/**
 * 解析分页注释文件 Annotations.xml / Annotation.xml。
 *
 * @param root 注释 XML 根节点。
 * @param pageIds 页 ID → 索引映射所用的页 ID 列表。
 * @param options 解码选项。
 * @returns 注释模型数组。
 */
export function decodeAnnotations(
  root: XmlNode,
  pageIds: readonly ResourceId[],
  options?: DecodeOptions,
): Annotation[] {
  const context: ContentDecodeContext = {
    ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
    ...(options?.colorSpaces ? { colorSpaces: options.colorSpaces } : {}),
    ...(options?.defaultColorSpaceId ? { defaultColorSpaceId: options.defaultColorSpaceId } : {}),
  };
  context.decodePageBlock = (node) => decodePageBlockNode(node, context);
  return decodeAnnotationsNode(root, pageIds, context);
}

/** Annotations.xml 索引解码结果。 */
export interface DecodedAnnotationsIndex {
  /** Annotations.xml 的包内路径。 */
  annotationsFile: string;
  /** 页 ID → 分页注释文件路径。 */
  pageAnnotIndex: Record<ResourceId, string>;
}

/**
 * 解析 Document.xml/Annotations 指向的索引文件（Page PageID/FileLoc）。
 *
 * 只建立索引，不加载页面注释内容；T6b 按 page.id 懒加载。
 *
 * @param root Annotations.xml 根节点。
 * @param baseDir Annotations.xml 所在目录，用于解析 FileLoc。
 * @param options warning 选项。
 * @returns 注释文件路径与页 ID → FileLoc 索引。
 */
export function decodeAnnotationsIndex(
  root: XmlNode,
  baseDir: string,
  options?: DecodeOptions,
): DecodedAnnotationsIndex {
  const pageAnnotIndex: Record<ResourceId, string> = {};
  for (const pageNode of children(root, 'Page')) {
    const pageId = normalizeResourceId(attr(pageNode, 'PageID'));
    if (!pageId) {
      emitWarning(options, 'W_BAD_NUMBER', 'Annotations/Page 缺少 PageID，已跳过');
      continue;
    }
    if (pageAnnotIndex[pageId]) {
      emitWarning(options, 'W_DUPLICATE_RESOURCE', `注释页 ID 重复：${pageId}，保留先出现者`, {
        resourceId: pageId,
      });
      continue;
    }
    const fileLoc = childText(pageNode, 'FileLoc') ?? attr(pageNode, 'FileLoc');
    if (!fileLoc) {
      emitWarning(options, 'W_ANNOT_EMPTY', `注释页 ${pageId} 缺少 FileLoc，已跳过`, { resourceId: pageId });
      continue;
    }
    const resolved = resolveRelativePath(baseDir, fileLoc, options?.onWarning, pageId);
    if (resolved) pageAnnotIndex[pageId] = resolved;
  }
  // 输入没有文件路径；调用方（Document.annotationsFile）持有 Annotations.xml 路径。
  return { annotationsFile: '', pageAnnotIndex };
}

/**
 * 填充文档的页树与页数。
 *
 * @param model 文档模型。
 * @param tree 页树。
 * @returns 更新后的文档模型（返回新对象）。
 */
export function attachPageTree(model: DocumentModel, tree: PageTree): DocumentModel {
  return { ...model, pages: tree.pages, pageCount: tree.pageCount };
}