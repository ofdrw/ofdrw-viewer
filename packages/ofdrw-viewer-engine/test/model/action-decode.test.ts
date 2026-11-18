import { describe, expect, it, vi } from 'vitest';
import { decodeActions, decodeRegion } from '../../src/model/action-decode';
import type { ActionDecodeContext } from '../../src/model/action-decode';
import { buildPageIndex } from '../../src/model/navigation';
import type { OFDWarning } from '../../src/warnings';
import type { ActionOwner } from '../../src/model/types';
import { leaf, node } from './xml';

/** 构造解码上下文；页 ID `1`/`2` 映射到页索引 0/1。 */
function context(overrides: Partial<ActionDecodeContext> = {}): ActionDecodeContext {
  return { pageIndex: buildPageIndex(['1', '2']), ...overrides };
}

/** 收集 warning。 */
function warnCode(calls: ReturnType<typeof vi.fn>): string[] {
  return calls.mock.calls.map((call) => (call[0] as OFDWarning).code);
}

/** 图元宿主。 */
const OBJECT: ActionOwner = { kind: 'object', pageIndex: 0, objectId: '30' };
/** 页宿主。 */
const PAGE: ActionOwner = { kind: 'page', pageIndex: 0 };
/** 文档宿主。 */
const DOCUMENT: ActionOwner = { kind: 'document' };
/** 大纲宿主。 */
const OUTLINE: ActionOwner = { kind: 'outline', path: [0, 1] };

/**
 * 构造 `Actions` 节点。
 *
 * @param items 若干 `Action` 节点。
 * @returns `Actions` 节点。
 */
function actions(...items: ReturnType<typeof node>[]): ReturnType<typeof node> {
  return node('Actions', {}, items);
}

/**
 * 构造单个 `Action` 节点。
 *
 * @param attrs `Action` 属性（如 `Event`）。
 * @param bodies 动作体节点。
 * @returns `Action` 节点。
 */
function action(attrs: Record<string, string>, ...bodies: ReturnType<typeof node>[]): ReturnType<typeof node> {
  return node('Action', attrs, bodies);
}

describe('decodeActions 基本行为', () => {
  it('无 Actions 节点返回空数组且不 warning', () => {
    const onWarning = vi.fn();
    expect(decodeActions(node('ImageObject', { ID: '1' }, []), OBJECT, context({ onWarning }))).toEqual([]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('Actions 位于 Border/AbbreviatedData 之后仍能按节点名找到', () => {
    const root = node('PathObject', { ID: '30' }, [
      node('Border', { LineWidth: '1' }),
      leaf('AbbreviatedData', 'M 0 0 L 10 10'),
      actions(action({ Event: 'CLICK' }, node('Sound', { ResourceID: '12' }))),
    ]);
    const result = decodeActions(root, OBJECT, context());
    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toMatchObject({
      type: 'sound',
      resourceId: '12',
      volume: 100,
      repeat: false,
      synchronous: false,
    });
    expect(result[0]?.event).toBe('CLICK');
    expect(result[0]?.owner).toEqual(OBJECT);
  });

  it('五种动作体 × 三种事件 × 四种宿主均可解码', () => {
    const bodies: Array<[string, ReturnType<typeof node>, Record<string, unknown>]> = [
      ['Goto', node('Goto', {}, [node('Dest', { Type: 'XYZ', PageID: '2', Left: '10' })]), { type: 'goto' }],
      ['URI', node('URI', { URI: 'https://example.com', Target: '_blank' }), { type: 'uri', uri: 'https://example.com', target: '_blank' }],
      ['GotoA', node('GotoA', { AttachID: 'a1', NewWindow: 'false' }), { type: 'gotoa', attachId: 'a1', newWindow: false }],
      ['Sound', node('Sound', { ResourceID: '12', Volume: '50', Repeat: 'true', Synchronous: 'true' }), { type: 'sound', volume: 50, repeat: true, synchronous: true }],
      ['Movie', node('Movie', { ResourceID: '10', Operator: 'Pause' }), { type: 'movie', operator: 'Pause' }],
    ];
    const events = ['DO', 'PO', 'CLICK'] as const;
    const owners: ActionOwner[] = [DOCUMENT, PAGE, OBJECT, OUTLINE];
    for (const [name, body, expected] of bodies) {
      for (const event of events) {
        for (const owner of owners) {
          const onWarning = vi.fn();
          const host = node('Host', {}, [actions(action({ Event: event }, body))]);
          const result = decodeActions(host, owner, context({ onWarning }));
          expect(result, `${name}/${event}`).toHaveLength(1);
          expect(result[0]?.event).toBe(event);
          expect(result[0]?.payload).toMatchObject(expected);
          expect(result[0]?.owner).toEqual(owner);
          // 事件与宿主不匹配只提示，不影响解码。
          const codes = warnCode(onWarning);
          expect(codes.every((code) => code === 'W_ACTION_EVENT_MISMATCH')).toBe(true);
        }
      }
    }
  });

  it('Goto 的 Dest 与 Bookmark 复用 documentDestination', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [
      actions(
        action({ Event: 'CLICK' }, node('Goto', {}, [node('Dest', { Type: 'FitH', PageID: '#2', Top: '5' })])),
        action({ Event: 'CLICK' }, node('Goto', { Bookmark: 'B1' })),
      ),
    ]);
    const result = decodeActions(root, OBJECT, context({ onWarning }));
    expect(result[0]?.payload).toMatchObject({ type: 'goto', dest: { type: 'FitH', pageIndex: 1, topMm: 5 } });
    expect(result[1]?.payload).toMatchObject({ type: 'goto', bookmarkName: 'B1' });
    expect(onWarning).not.toHaveBeenCalled();
  });
});

describe('宽容解码与 warning 码', () => {
  it('缺 Event / 非法 Event / 无动作体 → W_ACTION_INVALID 并跳过', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [
      actions(
        action({}, node('Sound', { ResourceID: '1' })),
        action({ Event: 'HOVER' }, node('Sound', { ResourceID: '1' })),
        action({ Event: 'CLICK' }),
      ),
    ]);
    expect(decodeActions(root, OBJECT, context({ onWarning }))).toEqual([]);
    expect(warnCode(onWarning)).toEqual(['W_ACTION_INVALID', 'W_ACTION_INVALID', 'W_ACTION_INVALID']);
  });

  it('多动作体取第一个并报 W_ACTION_MULTIPLE_BODY', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [
      actions(
        action({ Event: 'CLICK' }, node('URI', { URI: 'https://a' }), node('Sound', { ResourceID: '1' })),
      ),
    ]);
    const result = decodeActions(root, OBJECT, context({ onWarning }));
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('uri');
    expect(warnCode(onWarning)).toContain('W_ACTION_MULTIPLE_BODY');
  });

  it('Sound@ResourceID 缺失或非数字 → W_ACTION_INVALID 并跳过', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [
      actions(
        action({ Event: 'CLICK' }, node('Sound', {})),
        action({ Event: 'CLICK' }, node('Sound', { ResourceID: 'abc' })),
      ),
    ]);
    expect(decodeActions(root, OBJECT, context({ onWarning }))).toEqual([]);
    expect(warnCode(onWarning)).toEqual(['W_ACTION_INVALID', 'W_ACTION_INVALID']);
  });

  it('Volume 越界钳制、Operator 非法回退 Play、布尔非法回退', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [
      actions(
        action({ Event: 'CLICK' }, node('Sound', { ResourceID: '1', Volume: '150', Repeat: 'yes' })),
        action({ Event: 'CLICK' }, node('Sound', { ResourceID: '1', Volume: '-3' })),
        action({ Event: 'CLICK' }, node('Movie', { ResourceID: '2', Operator: 'Fast' })),
      ),
    ]);
    const result = decodeActions(root, OBJECT, context({ onWarning }));
    expect(result[0]?.payload).toMatchObject({ volume: 100, repeat: false });
    expect(result[1]?.payload).toMatchObject({ volume: 0 });
    expect(result[2]?.payload).toMatchObject({ operator: 'Play' });
    const codes = warnCode(onWarning);
    expect(codes.filter((code) => code === 'W_ACTION_FIELD')).toHaveLength(4);
  });

  it('Goto 的 Dest 无效 → payload 不含 dest 且报 W_ACTION_TARGET', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [
      actions(
        action({ Event: 'CLICK' }, node('Goto', {}, [node('Dest', { Type: 'XYZ', PageID: '99' })])),
      ),
    ]);
    const result = decodeActions(root, OBJECT, context({ onWarning }));
    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toEqual({ type: 'goto' });
    expect(warnCode(onWarning)).toContain('W_ACTION_TARGET');
  });

  it('引用的资源不存在 → 保留动作并报 W_ACTION_RESOURCE_MISSING', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [actions(action({ Event: 'CLICK' }, node('Movie', { ResourceID: '77' })))]);
    const result = decodeActions(
      root,
      OBJECT,
      context({ onWarning, hasResource: (id) => id === '10' }),
    );
    expect(result).toHaveLength(1);
    expect(warnCode(onWarning)).toContain('W_ACTION_RESOURCE_MISSING');
    expect((onWarning.mock.calls[0]?.[0] as OFDWarning).resourceId).toBe('77');
  });

  it('动作数超过 maxActionsPerNode → W_ACTION_LIMIT 并截断', () => {
    const onWarning = vi.fn();
    const root = node('Host', {}, [
      actions(
        action({ Event: 'CLICK' }, node('Movie', { ResourceID: '1' })),
        action({ Event: 'CLICK' }, node('Movie', { ResourceID: '2' })),
        action({ Event: 'CLICK' }, node('Movie', { ResourceID: '3' })),
      ),
    ]);
    const result = decodeActions(root, OBJECT, context({ onWarning, maxActionsPerNode: 2 }));
    expect(result.map((item) => (item.payload as { resourceId: string }).resourceId)).toEqual(['1', '2']);
    expect(warnCode(onWarning)).toEqual(['W_ACTION_LIMIT']);
  });

  it('warning 带上宿主页索引与对象 ID', () => {
    const onWarning = vi.fn();
    decodeActions(
      node('Host', {}, [actions(action({}, node('Sound', { ResourceID: '1' })))]),
      OBJECT,
      context({ onWarning }),
    );
    const warning = onWarning.mock.calls[0]?.[0] as OFDWarning;
    expect(warning.pageIndex).toBe(0);
    expect(warning.objectId).toBe('30');
  });
});

describe('decodeRegion', () => {
  it('解析 Move/Line/CubicBezier/QuadraticBezier/Close 并计算外接矩形', () => {
    const regionNode = node('Region', {}, [
      node('Area', {}, [
        node('Move', { Point: '10 10' }),
        node('Line', { Point: '50 10' }),
        node('Line', { Point: '50 40' }),
        node('Close', {}),
      ]),
    ]);
    const region = decodeRegion(regionNode, OBJECT, context());
    expect(region?.bbox).toEqual({ x: 10, y: 10, w: 40, h: 30 });
    expect(region?.areas).toHaveLength(1);
    expect(region?.areas[0]?.[0]?.map((item) => item.type)).toEqual([
      'moveTo',
      'lineTo',
      'lineTo',
      'closePath',
    ]);
  });

  it('贝塞尔控制点参与外接矩形', () => {
    const regionNode = node('Region', {}, [
      node('Area', {}, [
        node('Move', { Point: '0 0' }),
        node('CubicBezier', { Point: '0 20 20 20 20 0' }),
      ]),
    ]);
    const region = decodeRegion(regionNode, OBJECT, context());
    expect(region?.bbox).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    expect(region?.areas[0]?.[0]?.[1]).toMatchObject({ type: 'bezierCurveTo' });
  });

  it('无有效路径时丢弃区域并报 W_ACTION_REGION', () => {
    const onWarning = vi.fn();
    expect(decodeRegion(node('Region', {}, []), OBJECT, context({ onWarning }))).toBeUndefined();
    expect(warnCode(onWarning)).toEqual(['W_ACTION_REGION']);
  });

  it('Action 带 Region 时写入 action.region', () => {
    const root = node('Host', {}, [
      node('Actions', {}, [
        node('Action', { Event: 'CLICK' }, [
          node('Movie', { ResourceID: '10' }),
          node('Region', {}, [node('Area', {}, [node('Move', { Point: '1 1' }), node('Line', { Point: '2 2' })])]),
        ]),
      ]),
    ]);
    const result = decodeActions(root, OBJECT, context());
    expect(result[0]?.region?.bbox).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });
});