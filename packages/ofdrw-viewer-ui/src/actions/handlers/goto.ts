/**
 * `Goto` 动作处理器（UI 动作处理机制设计 §8.2）。
 *
 * 两种目标形态：
 * - `Dest`：直接复用 `views/shared.ts` 的 `goToDestination()`（含缩放调整、页内偏移、
 *   平滑滚动与无效目标告警），不另写跳转逻辑；
 * - `Bookmark`：按书签名在 `state.document.bookmarks` 中查名称索引取 `dest`，再走同一路径。
 *
 * 目标无效（engine 已用 `W_ACTION_TARGET` 上报且 `dest` 缺省）或书签名查不到时返回
 * `skipped('target-missing')`，不抛错、不打断后续动作。
 */

import type { ActionInfo, BookmarkItem, DocumentDestination } from '@ofdrw/ofdrw-viewer-engine';
import type { NavigationViewer } from '../../views/shared';
import { goToDestination } from '../../views/shared';
import type { ActionExecutionContext, ActionHandler, ActionHandlerResult } from '../types';

/** Goto handler 依赖的宿主能力。 */
export interface GotoHandlerHost {
  /** 兼容 `goToDestination()` 所需的导航视图接口。 */
  readonly navigationViewer: NavigationViewer;
  /** 当前文档的书签（用于书名解析）；无书签时为空数组。 */
  readonly getBookmarks: () => readonly BookmarkItem[];
  /**
   * 引擎文档自身持有的书签快照；省略时只用 `getBookmarks()`。
   *
   * 引擎书签在打开阶段已解析，不受 `bookmarks` 功能开关影响。
   */
  readonly getDocumentBookmarks?: () => readonly BookmarkItem[];
  /** 是否平滑滚动（`actions.smoothGoto`）。 */
  readonly smoothGoto: () => boolean;
}

/**
 * 创建 `Goto` 动作处理器。
 *
 * @param host 宿主能力。
 * @returns 动作处理器。
 */
export function createGotoHandler(host: GotoHandlerHost): ActionHandler {
  /**
   * 书签名索引与其来源快照。
   *
   * 来源数组的引用变化即视为书签集合变化：此时按来源顺序重建索引，使同名书签仍是
   * 「XML 顺序首次出现者生效」。
   */
  let indexedSource: readonly BookmarkItem[] | undefined;
  let indexByName = new Map<string, BookmarkItem>();
  const resolveBookmark = (name: string): BookmarkItem | undefined => {
    const source = host.getDocumentBookmarks?.() ?? host.getBookmarks();
    if (source !== indexedSource) {
      indexedSource = source;
      indexByName = new Map();
      for (const bookmark of source) {
        // 先到先得：同名书签保留首次出现的条目。
        if (!indexByName.has(bookmark.name)) indexByName.set(bookmark.name, bookmark);
      }
    }
    return indexByName.get(name);
  };

  return async (
    _context: ActionExecutionContext,
    action: ActionInfo,
  ): Promise<ActionHandlerResult> => {
    if (action.payload.type !== 'goto') {
      return { outcome: 'skipped', skipReason: 'target-missing' };
    }
    const dest = resolveGotoDestination(action.payload, resolveBookmark);
    if (!dest) {
      return { outcome: 'skipped', skipReason: 'target-missing' };
    }
    const jumped = goToDestination(host.navigationViewer, dest, { smooth: host.smoothGoto() });
    return jumped ? { outcome: 'executed' } : { outcome: 'skipped', skipReason: 'target-missing' };
  };
}

/**
 * 解析 Goto 的跳转目标：优先用 `Dest`，其次按书签名查找。
 *
 * @param payload Goto 动作 payload。
 * @param resolveBookmark 书签名解析函数。
 * @returns 跳转目标；无法解析时 undefined。
 */
function resolveGotoDestination(
  payload: Extract<ActionInfo['payload'], { type: 'goto' }>,
  resolveBookmark: (name: string) => BookmarkItem | undefined,
): DocumentDestination | undefined {
  if (payload.dest) return payload.dest;
  const name = payload.bookmarkName;
  if (!name) return undefined;
  return resolveBookmark(name)?.dest;
}