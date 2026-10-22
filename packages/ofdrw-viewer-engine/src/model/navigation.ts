/**
 * Document.xml 大纲/书签解码。
 *
 * 只读取 `Outlines`、`Bookmarks` 与 `Goto/Dest` XML，不加载页面内容；
 * `Dest@PageID` 通过页树 ID → 页索引映射，坐标单位 mm。
 */

import type { XmlNode } from '../xml/types';
import type {
  BookmarkItem,
  DocumentDestination,
  DocumentDestinationType,
  OutlineNode,
  ResourceId,
} from './types';
import type { DecodeOptions } from './decode';
import { attr, child, childText, children, emitWarning } from './decode-utils';
import { normalizeResourceId } from './ids';

/** 大纲递归深度上限，防止恶意深树。 */
const MAX_OUTLINE_DEPTH = 64;

/** 支持的 OFD Dest 类型（大小写不敏感）。 */
const DEST_TYPES: Readonly<Record<string, DocumentDestinationType>> = Object.freeze({
  XYZ: 'XYZ',
  FIT: 'Fit',
  FITH: 'FitH',
  FITV: 'FitV',
  FITR: 'FitR',
});

/** 文档导航解码结果。 */
export interface NavigationModel {
  /** 大纲树；无 Outlines 时为空数组。 */
  outlines: OutlineNode[];
  /** 书签列表；无 Bookmarks 时为空数组。 */
  bookmarks: BookmarkItem[];
}

/**
 * 解码 Document.xml 的大纲与书签。
 *
 * 先解析书签，以便大纲的 `Goto/Bookmark` 按名称引用；两者均保持 XML 顺序。
 *
 * @param root Document.xml 根节点。
 * @param pageIds 页 ID 列表（前序）。
 * @param options 解码选项。
 * @returns 大纲与书签。
 */
export function decodeDocumentNavigation(
  root: XmlNode,
  pageIds: readonly ResourceId[],
  options: DecodeOptions = {},
): NavigationModel {
  const pageIndex = buildPageIndex(pageIds);
  const bookmarks = decodeBookmarksWithIndex(root, pageIndex, options);
  const outlines = decodeOutlinesWithIndex(root, pageIndex, bookmarks, options);
  return { outlines, bookmarks };
}

/**
 * 解码书签列表。
 *
 * @param root Document.xml 根节点。
 * @param pageIds 页 ID 列表（前序）。
 * @param options 解码选项。
 * @returns 书签；缺失 Name 的条目 warning 后跳过。
 */
export function decodeBookmarks(
  root: XmlNode,
  pageIds: readonly ResourceId[],
  options: DecodeOptions = {},
): BookmarkItem[] {
  return decodeBookmarksWithIndex(root, buildPageIndex(pageIds), options);
}

/**
 * 解码大纲树。
 *
 * @param root Document.xml 根节点。
 * @param pageIds 页 ID 列表（前序）。
 * @param options 解码选项。
 * @returns 大纲节点；无 Outlines 时为空数组。
 */
export function decodeOutlines(
  root: XmlNode,
  pageIds: readonly ResourceId[],
  options: DecodeOptions = {},
): OutlineNode[] {
  const pageIndex = buildPageIndex(pageIds);
  const bookmarks = decodeBookmarksWithIndex(root, pageIndex, options);
  return decodeOutlinesWithIndex(root, pageIndex, bookmarks, options);
}

/** 建立页 ID → 页索引映射。 */
function buildPageIndex(pageIds: readonly ResourceId[]): Map<ResourceId, number> {
  const result = new Map<ResourceId, number>();
  pageIds.forEach((id, index) => {
    const normalized = normalizeResourceId(id);
    if (normalized && !result.has(normalized)) result.set(normalized, index);
  });
  return result;
}

/** 解码书签并复用已建好的页索引。 */
function decodeBookmarksWithIndex(
  root: XmlNode,
  pageIndex: ReadonlyMap<ResourceId, number>,
  options: DecodeOptions,
): BookmarkItem[] {
  const bookmarksNode = child(root, 'Bookmarks');
  if (!bookmarksNode) return [];
  const result: BookmarkItem[] = [];
  for (const bookmarkNode of children(bookmarksNode, 'Bookmark')) {
    const rawName = attr(bookmarkNode, 'Name') ?? childText(bookmarkNode, 'Name');
    const name = (rawName ?? '').trim();
    if (!name) {
      emitWarning(options, 'W_BOOKMARK_TARGET', 'Bookmark 缺少 Name，已跳过');
      continue;
    }
    const destNode = child(bookmarkNode, 'Dest') ?? findGotoDest(bookmarkNode);
    const dest = destNode
      ? decodeDestination(destNode, pageIndex, options, 'W_BOOKMARK_TARGET')
      : undefined;
    const item: BookmarkItem = { name };
    if (dest) item.dest = dest;
    result.push(item);
  }
  return result;
}

/** 解码大纲树并复用已建好的页索引与书签。 */
function decodeOutlinesWithIndex(
  root: XmlNode,
  pageIndex: ReadonlyMap<ResourceId, number>,
  bookmarks: readonly BookmarkItem[],
  options: DecodeOptions,
): OutlineNode[] {
  const outlinesNode = child(root, 'Outlines');
  if (!outlinesNode) return [];
  const bookmarkIndex = new Map<string, DocumentDestination | undefined>();
  for (const bookmark of bookmarks) {
    if (!bookmarkIndex.has(bookmark.name)) bookmarkIndex.set(bookmark.name, bookmark.dest);
  }
  return children(outlinesNode, 'OutlineElem').map((node) =>
    decodeOutlineNode(node, pageIndex, bookmarkIndex, options, 0),
  );
}

/** 递归解码单个 OutlineElem。 */
function decodeOutlineNode(
  node: XmlNode,
  pageIndex: ReadonlyMap<ResourceId, number>,
  bookmarks: ReadonlyMap<string, DocumentDestination | undefined>,
  options: DecodeOptions,
  depth: number,
): OutlineNode {
  const rawTitle = attr(node, 'Title') ?? childText(node, 'Title');
  const result: OutlineNode = {
    title: (rawTitle ?? '').trim(),
    children: [],
  };
  const expanded = decodeExpanded(attr(node, 'Expanded') ?? childText(node, 'Expanded'));
  if (expanded !== undefined) result.expanded = expanded;

  if (depth >= MAX_OUTLINE_DEPTH) {
    emitWarning(options, 'W_OUTLINE_TARGET', `大纲层级超过 ${MAX_OUTLINE_DEPTH}，已截断子节点`);
  } else {
    result.children = children(node, 'OutlineElem').map((childNode) =>
      decodeOutlineNode(childNode, pageIndex, bookmarks, options, depth + 1),
    );
  }

  const gotoNode = findGoto(node);
  if (!gotoNode) return result;
  const destNode = child(gotoNode, 'Dest');
  if (destNode) {
    const dest = decodeDestination(destNode, pageIndex, options, 'W_OUTLINE_TARGET');
    if (dest) result.dest = dest;
    return result;
  }
  const bookmarkName = (childText(gotoNode, 'Bookmark') ?? attr(gotoNode, 'Bookmark') ?? '').trim();
  if (!bookmarkName) return result;
  const dest = bookmarks.get(bookmarkName);
  if (!dest) {
    emitWarning(options, 'W_OUTLINE_TARGET', `大纲引用的书签 ${JSON.stringify(bookmarkName)} 不存在或目标无效`);
    return result;
  }
  result.dest = dest;
  return result;
}

/** 解析 Expanded 布尔值；非 true/false/1/0 返回 undefined。 */
function decodeExpanded(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/** 查找 OutlineElem/Bookmark 下的 Goto；优先 Actions/Action/Goto。 */
function findGoto(node: XmlNode): XmlNode | undefined {
  const actions = child(node, 'Actions');
  if (actions) {
    for (const action of children(actions, 'Action')) {
      const goto = child(action, 'Goto');
      if (goto) return goto;
    }
  }
  return child(node, 'Goto');
}

/** 查找 Bookmark 下 Goto 的 Dest；兼容直接 Dest。 */
function findGotoDest(node: XmlNode): XmlNode | undefined {
  const goto = findGoto(node);
  return goto ? child(goto, 'Dest') : undefined;
}

/** 解码 Dest；无效时按 warningCode 上报并返回 undefined。 */
function decodeDestination(
  node: XmlNode,
  pageIndex: ReadonlyMap<ResourceId, number>,
  options: DecodeOptions,
  warningCode: 'W_OUTLINE_TARGET' | 'W_BOOKMARK_TARGET',
): DocumentDestination | undefined {
  const rawType = (attr(node, 'Type') ?? '').trim();
  const type = DEST_TYPES[rawType.toUpperCase()];
  if (!type) {
    emitWarning(options, warningCode, `Dest 的 Type 未知：${JSON.stringify(rawType)}`);
    return undefined;
  }
  const rawPageId = (attr(node, 'PageID') ?? '').trim();
  const page = pageIndex.get(normalizeResourceId(rawPageId));
  if (page === undefined) {
    emitWarning(options, warningCode, `Dest 的 PageID 无效：${JSON.stringify(rawPageId)}`);
    return undefined;
  }
  const dest: DocumentDestination = { type, pageIndex: page };
  const fields: Array<[string, 'leftMm' | 'topMm' | 'rightMm' | 'bottomMm']> =
    type === 'XYZ'
      ? [['Left', 'leftMm'], ['Top', 'topMm'], ['Right', 'rightMm'], ['Bottom', 'bottomMm']]
      : type === 'FitH'
        ? [['Top', 'topMm']]
        : type === 'FitV'
          ? [['Left', 'leftMm']]
          : type === 'FitR'
            ? [['Left', 'leftMm'], ['Top', 'topMm'], ['Right', 'rightMm'], ['Bottom', 'bottomMm']]
            : [];
  for (const [name, key] of fields) {
    const value = readOptionalNumber(node, name, options, warningCode);
    if (value === INVALID_NUMBER) return undefined;
    if (value !== undefined) dest[key] = value;
  }
  if (type === 'XYZ') {
    const zoom = readOptionalNumber(node, 'Zoom', options, warningCode);
    if (zoom === INVALID_NUMBER) return undefined;
    if (zoom !== undefined) {
      if (zoom <= 0) {
        emitWarning(options, warningCode, `Dest.Zoom 必须大于 0：${String(zoom)}`);
        return undefined;
      }
      dest.zoom = zoom;
    }
  }
  return dest;
}

/** 非法数值哨兵。 */
const INVALID_NUMBER = Symbol('invalid-number');

/**
 * 读取可选数值属性；缺失返回 undefined，非法返回 INVALID_NUMBER。
 *
 * @param node Dest 节点。
 * @param name 属性名。
 * @param options 解码选项。
 * @param warningCode 目标类 warning 码。
 * @returns 数值、undefined 或非法哨兵。
 */
function readOptionalNumber(
  node: XmlNode,
  name: string,
  options: DecodeOptions,
  warningCode: 'W_OUTLINE_TARGET' | 'W_BOOKMARK_TARGET',
): number | undefined | typeof INVALID_NUMBER {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  const text = raw.trim();
  const value = text.length > 0 ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) {
    emitWarning(options, warningCode, `Dest.${name} 不是合法数值：${JSON.stringify(raw)}`);
    return INVALID_NUMBER;
  }
  return value;
}
