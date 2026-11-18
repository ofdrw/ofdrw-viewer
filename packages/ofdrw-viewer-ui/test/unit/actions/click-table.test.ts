/**
 * 动作命中表单测（UI 动作处理机制设计 §6.5 / §6.6 / §14 决策 6）。
 *
 * 覆盖：矩形粗判、绘制序（z 序）取法、同一宿主多动作共命中、Region 只做外接矩形判定。
 */
import { describe, expect, it } from 'vitest';
import type { ActionInfo, ActionOwner } from '@ofdrw/ofdrw-viewer-engine';
import { createClickTable, hitTestTable, isPointInBox } from '../../../src/actions/click-table';
import type { ClickHitItem } from '../../../src/actions/types';

/** 构造一个最小 CLICK 动作。 */
function makeAction(owner: ActionOwner, type: ActionInfo['type'] = 'goto'): ActionInfo {
  return {
    event: 'CLICK',
    type,
    owner,
    payload:
      type === 'goto'
        ? { type: 'goto', dest: { type: 'XYZ', pageIndex: 0 } }
        : { type: 'uri', uri: 'https://example.com/' },
  } as ActionInfo;
}

/** 构造一个命中项。 */
function item(
  action: ActionInfo,
  bbox: { left: number; top: number; width: number; height: number },
  paintOrder: number,
  source: ClickHitItem['source'] = 'object',
): ClickHitItem {
  return { action, bbox, source, paintOrder };
}

describe('isPointInBox', () => {
  it('包含边界，空矩形不命中', () => {
    const box = { left: 10, top: 20, width: 30, height: 40 };
    expect(isPointInBox(box, { x: 10, y: 20 })).toBe(true);
    expect(isPointInBox(box, { x: 40, y: 60 })).toBe(true);
    expect(isPointInBox(box, { x: 9.9, y: 20 })).toBe(false);
    expect(isPointInBox({ left: 0, top: 0, width: 0, height: 10 }, { x: 0, y: 5 })).toBe(false);
  });
});

describe('ClickTable 命中与 z 序', () => {
  const pageOwner: ActionOwner = { kind: 'page', pageIndex: 0 };

  it('从后往前扫：绘制序大的（层叠靠上）优先命中', () => {
    const below = makeAction({ kind: 'object', pageIndex: 0, objectId: '1' });
    const above = makeAction({ kind: 'object', pageIndex: 0, objectId: '2' });
    const table = createClickTable([
      item(below, { left: 0, top: 0, width: 100, height: 100 }, 0),
      item(above, { left: 50, top: 50, width: 100, height: 100 }, 1),
    ]);
    // 重叠区域应命中上面的那个。
    const hit = hitTestTable(table, { x: 60, y: 60 });
    expect(hit?.actions[0]?.owner).toEqual({ kind: 'object', pageIndex: 0, objectId: '2' });
    // 只有下层覆盖的区域命中下层。
    const lower = hitTestTable(table, { x: 10, y: 10 });
    expect(lower?.actions[0]?.owner).toEqual({ kind: 'object', pageIndex: 0, objectId: '1' });
  });

  it('命中结果附带宿主矩形，供弹出式定位使用', () => {
    const action = makeAction(pageOwner);
    const bbox = { left: 4, top: 6, width: 10, height: 12 };
    const table = createClickTable([item(action, bbox, 0)]);
    expect(hitTestTable(table, { x: 5, y: 7 })?.rect).toEqual(bbox);
  });

  it('同一宿主的多个动作一起命中并按原序返回（几何不同也同组）', () => {
    const owner: ActionOwner = { kind: 'object', pageIndex: 0, objectId: '7' };
    const first = makeAction(owner, 'goto');
    const second = makeAction(owner, 'uri');
    const table = createClickTable([
      item(first, { left: 0, top: 0, width: 10, height: 10 }, 0),
      item(second, { left: 0, top: 0, width: 20, height: 20 }, 0),
    ]);
    const hit = hitTestTable(table, { x: 5, y: 5 });
    expect(hit?.actions).toHaveLength(2);
    expect(hit?.actions[0]).toBe(first);
    expect(hit?.actions[1]).toBe(second);
  });

  it('同一页面上无 ID 图元的多个动作共享分组，一次点击全部返回', () => {
    const owner: ActionOwner = { kind: 'object', pageIndex: 0 };
    const first = makeAction(owner, 'goto');
    const second = makeAction(owner, 'uri');
    const table = createClickTable([
      item(first, { left: 0, top: 0, width: 10, height: 10 }, 0),
      item(second, { left: 0, top: 0, width: 10, height: 10 }, 0),
    ]);
    expect(hitTestTable(table, { x: 5, y: 5 })?.actions).toHaveLength(2);
  });

  it('未命中返回 undefined，空表返回 undefined', () => {
    const action = makeAction(pageOwner);
    const table = createClickTable([item(action, { left: 0, top: 0, width: 10, height: 10 }, 0)]);
    expect(hitTestTable(table, { x: 50, y: 50 })).toBeUndefined();
    expect(hitTestTable(undefined, { x: 0, y: 0 })).toBeUndefined();
    expect(createClickTable([])).toBeUndefined();
  });

  it('带 Region 的动作只按外接矩形判定，不做精确路径命中', () => {
    const action = makeAction(pageOwner);
    const table = createClickTable([
      item(action, { left: 0, top: 0, width: 100, height: 80 }, 0, 'region'),
    ]);
    // 矩形内任意点都命中，包括 Region 折线可能挖空的位置。
    expect(hitTestTable(table, { x: 50, y: 40 })?.actions[0]).toBe(action);
    expect(hitTestTable(table, { x: 1, y: 1 })?.actions[0]).toBe(action);
    // 矩形外不命中。
    expect(hitTestTable(table, { x: 101, y: 40 })).toBeUndefined();
  });

  it('命中项按 paintOrder 降序排列', () => {
    const a = makeAction({ kind: 'object', pageIndex: 0, objectId: 'a' });
    const b = makeAction({ kind: 'object', pageIndex: 0, objectId: 'b' });
    const table = createClickTable([
      item(a, { left: 0, top: 0, width: 10, height: 10 }, 3),
      item(b, { left: 0, top: 0, width: 10, height: 10 }, 9),
    ]);
    expect(table?.items.map((entry) => entry.paintOrder)).toEqual([9, 3]);
  });
});