/**
 * 按页命中表（UI 动作处理机制设计 §6.5 / §6.6 / §14 决策 6）。
 *
 * 命中表把「动作 → 96 DPI 页面像素几何」预先算好，`pointerup` 时只做线性扫描：
 * 页内动作通常不足 20 个，不引入空间索引。命中顺序取**绘制序从后往前**（数值大的
 * 先命中），与视觉层叠一致：后绘制的图元盖住先绘制的，它的动作应当优先响应。
 *
 * 命中判定只做**外接矩形粗判**：`Action/Region` 的折线路径不参与精确判定（设计 §14
 * 决策 6），因此环形、不规则区域的挖空部分同样算在触发区内。这样同一宿主上的多个
 * 动作共享同一判定，不会出现「一个动作命中、同宿主的另一个不命中」的不一致。
 *
 * 几何计算本身由 engine 的几何 API 提供（与文本层同一套 DPI 口径），本模块只负责把
 * 结果转成命中项、排序与点判定。
 */

import type { ActionInfo } from '@ofdrw/ofdrw-viewer-engine';
import type { ActionBox, ActionPoint, ClickHitItem, ClickHitTable } from './types';

/**
 * 判断点是否落在矩形内（含边界）。
 *
 * @param box 矩形，单位页面 px。
 * @param point 点，单位页面 px。
 * @returns 落在矩形内时 true。
 */
export function isPointInBox(box: ActionBox, point: ActionPoint): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  return (
    point.x >= box.left &&
    point.x <= box.left + box.width &&
    point.y >= box.top &&
    point.y <= box.top + box.height
  );
}

/**
 * 判断命中项是否被点命中。
 *
 * @param item 命中项，几何为页面 px。
 * @param point 点，单位页面 px。
 * @returns 命中时 true。
 */
export function hitTestItem(item: ClickHitItem, point: ActionPoint): boolean {
  return isPointInBox(item.bbox, point);
}

/**
 * 线性扫描取第一个命中的动作组。
 *
 * `items` 已按 `paintOrder` 降序排列，因此「第一个命中」即「层叠最靠上的宿主」，
 * 同一宿主的全部 CLICK 动作一起返回。
 *
 * @param table 命中表。
 * @param point 点，单位页面 px。
 * @returns 命中的动作组（同一宿主，按文档顺序）与宿主矩形；未命中时 undefined。
 */
export function hitTestTable(
  table: ClickHitTable | undefined,
  point: ActionPoint,
): { readonly actions: readonly ActionInfo[]; readonly rect: ActionBox } | undefined {
  if (!table) return undefined;
  for (const item of table.items) {
    if (!hitTestItem(item, point)) continue;
    return { actions: collectCohort(table.items, item), rect: item.bbox };
  }
  return undefined;
}

/**
 * 收集与给定命中项同属一个宿主的全部动作。
 *
 * @param items 命中表全部项，按 `paintOrder` 降序。
 * @param seed 已命中的项。
 * @returns 同一宿主的动作列表，保持 `items` 中的相对顺序。
 */
function collectCohort(
  items: readonly ClickHitItem[],
  seed: ClickHitItem,
): readonly ActionInfo[] {
  const cohort: ActionInfo[] = [];
  for (const item of items) {
    if (item.paintOrder !== seed.paintOrder) continue;
    cohort.push(item.action);
  }
  return cohort.length > 0 ? cohort : [seed.action];
}

/**
 * 由命中项构造命中表。
 *
 * @param items 未排序的命中项。
 * @returns 按 `paintOrder` 降序排列的命中表；无命中项时 undefined。
 */
export function createClickTable(items: readonly ClickHitItem[]): ClickHitTable | undefined {
  if (items.length === 0) return undefined;
  const sorted = [...items].sort((a, b) => b.paintOrder - a.paintOrder);
  return { items: sorted };
}