/**
 * 页树展开（实现由 T3/dev-model 完成）。
 *
 * `Pages` 可嵌套，`Page` 为叶子；递归前序遍历，页 ID 重复时保留先出现者并 warning。
 */

import type { XmlNode } from '../xml/types';
import { resolvePackagePath } from '../container/path';
import type { PageRef, PageTree } from './types';
import type { DecodeOptions } from './decode';
import { normalizeResourceId } from './ids';
import { attr, emitWarning } from './decode-utils';

/**
 * 从 Document.xml 的 Pages 子树展开页引用。
 *
 * @param pagesRoot `<Pages>` 节点。
 * @param baseDir Document.xml 所在目录，用于解析 BaseLoc。
 * @param options warning 选项；页 ID 重复/BaseLoc 非法时上报。
 * @returns 前序遍历的页树。
 */
export function flattenPageTree(
  pagesRoot: XmlNode,
  baseDir: string,
  options?: DecodeOptions,
): PageTree {
  const pages: PageRef[] = [];
  const seen = new Set<string>();
  const context = {
    ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
  };

  /**
   * 递归访问 Pages/Page。
   *
   * @param node 当前 Pages/Page 节点。
   */
  const visit = (node: XmlNode): void => {
    if (node.name === 'Page') {
      const rawId = attr(node, 'ID');
      const id = normalizeResourceId(rawId);
      if (!id) {
        emitWarning(context, 'W_BAD_NUMBER', 'Page 缺少 ID，已跳过');
        return;
      }
      if (seen.has(id)) {
        emitWarning(context, 'W_DUPLICATE_RESOURCE', `页 ID 重复：${id}，保留先出现者`, {
          resourceId: id,
        });
        return;
      }
      const baseLocRaw = attr(node, 'BaseLoc');
      let loc = '';
      if (baseLocRaw === undefined || baseLocRaw.trim() === '') {
        emitWarning(context, 'W_BAD_NUMBER', `Page ${id} 缺少 BaseLoc`, { resourceId: id });
      } else {
        try {
          loc = resolvePackagePath(baseDir, baseLocRaw.trim());
        } catch (error) {
          emitWarning(context, 'W_BAD_NUMBER', `Page ${id} 的 BaseLoc 非法：${JSON.stringify(baseLocRaw)}（${String(error)}）`, {
            resourceId: id,
          });
        }
      }
      seen.add(id);
      pages.push({ id, loc });
      return;
    }
    if (node.name === 'Pages') {
      for (const child of node.children) {
        if (child.name === 'Page' || child.name === 'Pages') visit(child);
      }
    }
  };

  visit(pagesRoot);
  return { pages, pageCount: pages.length };
}