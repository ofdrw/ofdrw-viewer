/**
 * 动作执行器单测（UI 动作处理机制设计 §7）。
 *
 * 覆盖：顺序执行、`Synchronous` 阻塞（`repeat` 时无效）、`Movie` 不阻塞、
 * `maxActionDepth` 循环防护、错误隔离、取消。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionInfo, ActionOwner } from '@ofdrw/ofdrw-viewer-engine';
import { ActionExecutor, DEFAULT_MAX_ACTION_DEPTH } from '../../../src/actions/action-executor';
import type { ActionExecutionContext, ActionHandlerResult } from '../../../src/actions/types';

const PAGE_OWNER: ActionOwner = { kind: 'page', pageIndex: 0 };
const CONTEXT: ActionExecutionContext = { trigger: 'CLICK', pageIndex: 0 };

/** 构造动作。 */
function soundAction(synchronous = false, repeat = false): ActionInfo {
  return {
    event: 'CLICK',
    type: 'sound',
    owner: PAGE_OWNER,
    payload: { type: 'sound', resourceId: '1', volume: 100, repeat, synchronous },
  } as ActionInfo;
}

/** 构造 movie 动作。 */
function movieAction(): ActionInfo {
  return {
    event: 'CLICK',
    type: 'movie',
    owner: PAGE_OWNER,
    payload: { type: 'movie', resourceId: '2', operator: 'Play' },
  } as ActionInfo;
}

/** 记录调用顺序并返回固定结果的处理器。 */
function recording(result: ActionHandlerResult, log: string[], label: string) {
  return async (): Promise<ActionHandlerResult> => {
    log.push(label);
    return result;
  };
}

describe('ActionExecutor 顺序执行', () => {
  it('按顺序依次执行', async () => {
    const executor = new ActionExecutor();
    const log: string[] = [];
    executor.register('goto', recording({ outcome: 'executed' }, log, 'goto'));
    executor.register('uri', recording({ outcome: 'executed' }, log, 'uri'));
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    const uriAction = {
      event: 'CLICK',
      type: 'uri',
      owner: PAGE_OWNER,
      payload: { type: 'uri', uri: 'https://example.com/' },
    } as ActionInfo;
    const outcomes = await executor.execute([gotoAction, uriAction], CONTEXT);
    expect(outcomes).toEqual(['executed', 'executed']);
    expect(log).toEqual(['goto', 'uri']);
  });

  it('单个动作失败不中断后续（错误隔离）', async () => {
    const log: string[] = [];
    const onError = vi.fn();
    const strict = new ActionExecutor({ onError });
    strict.register('goto', async () => {
      log.push('goto');
      throw Object.assign(new Error('boom'), { code: 'OFD_MEDIA_UNSUPPORTED' });
    });
    strict.register('uri', recording({ outcome: 'executed' }, log, 'uri'));
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    const uriAction = {
      event: 'CLICK',
      type: 'uri',
      owner: PAGE_OWNER,
      payload: { type: 'uri', uri: 'https://example.com/' },
    } as ActionInfo;
    const outcomes = await strict.execute([gotoAction, uriAction], CONTEXT);
    expect(outcomes).toEqual(['failed', 'executed']);
    expect(log).toEqual(['goto', 'uri']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toMatchObject({ code: 'OFD_MEDIA_UNSUPPORTED' });
  });

  it('未注册 handler 的动作记为 skipped', async () => {
    const onResult = vi.fn();
    const strict = new ActionExecutor({ onResult });
    const outcomes = await strict.execute([soundAction()], CONTEXT);
    expect(outcomes).toEqual(['skipped']);
    expect(onResult.mock.calls[0]![1]).toMatchObject({ outcome: 'skipped' });
  });
});

describe('ActionExecutor Synchronous 阻塞', () => {
  it('synchronous 为 true 时等待播放结束才继续', async () => {
    const executor = new ActionExecutor();
    let release: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const log: string[] = [];
    executor.register('sound', async () => {
      log.push('sound-start');
      return { outcome: 'executed', waitForEnd: ended };
    });
    executor.register('goto', async () => {
      log.push('goto');
      return { outcome: 'executed' };
    });
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    const run = executor.execute([soundAction(true), gotoAction], CONTEXT);
    await Promise.resolve();
    // 音频尚未结束：后续动作还没开始。
    expect(log).toEqual(['sound-start']);
    release();
    await run;
    expect(log).toEqual(['sound-start', 'goto']);
  });

  it('repeat=true 时 Synchronous 无效（handler 不返回 waitForEnd 即不阻塞）', async () => {
    const executor = new ActionExecutor();
    const log: string[] = [];
    executor.register('sound', async () => {
      log.push('sound-start');
      return { outcome: 'executed' };
    });
    executor.register('goto', async () => {
      log.push('goto');
      return { outcome: 'executed' };
    });
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    await executor.execute([soundAction(true, true), gotoAction], CONTEXT);
    expect(log).toEqual(['sound-start', 'goto']);
  });

  it('Movie 不阻塞：立即返回并继续后续动作', async () => {
    const executor = new ActionExecutor();
    const log: string[] = [];
    executor.register('movie', async () => {
      log.push('movie');
      return { outcome: 'executed' };
    });
    executor.register('goto', async () => {
      log.push('goto');
      return { outcome: 'executed' };
    });
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    await executor.execute([movieAction(), gotoAction], CONTEXT);
    expect(log).toEqual(['movie', 'goto']);
  });
});

describe('ActionExecutor 循环防护与取消', () => {
  it('超过 maxActionDepth 后整组记为 failed 并上报 loop', async () => {
    const onError = vi.fn();
    const executor = new ActionExecutor({ maxActionDepth: 2, onError });
    executor.register('goto', recording({ outcome: 'executed' }, [], 'goto'));
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    // 深度达到上限时直接拒绝执行。
    const outcomes = await executor.execute([gotoAction], CONTEXT, { depth: 2 });
    expect(outcomes).toEqual(['failed']);
    expect(onError.mock.calls[0]![1]).toMatchObject({ reason: 'loop' });
  });

  it('默认深度为 4', () => {
    expect(DEFAULT_MAX_ACTION_DEPTH).toBe(4);
  });

  it('已取消的信号让后续动作记为 cancelled', async () => {
    const executor = new ActionExecutor();
    const controller = new AbortController();
    controller.abort();
    executor.register('goto', recording({ outcome: 'executed' }, [], 'goto'));
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    const outcomes = await executor.execute([gotoAction], CONTEXT, { signal: controller.signal });
    expect(outcomes).toEqual(['cancelled']);
  });

  it('cancelAll 之后新执行仍可用（重新开始一轮）', async () => {
    const executor = new ActionExecutor();
    executor.register('goto', recording({ outcome: 'executed' }, [], 'goto'));
    executor.cancelAll();
    expect(executor.cancelled).toBe(false);
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    expect(await executor.execute([gotoAction], CONTEXT)).toEqual(['executed']);
  });

  it('handler 抛 AbortError 记为 cancelled 而非 failed', async () => {
    const executor = new ActionExecutor();
    executor.register('goto', async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    const gotoAction = { event: 'CLICK', type: 'goto', owner: PAGE_OWNER, payload: { type: 'goto' } } as ActionInfo;
    expect(await executor.execute([gotoAction], CONTEXT)).toEqual(['cancelled']);
  });
});
describe('ActionExecutor 并发与取消', () => {
  it('并发执行互不污染嵌套深度：阻塞中的一组不会让后续执行被误判为死循环', async () => {
    const executor = new ActionExecutor({ maxActionDepth: 4 });
    const onError = vi.fn();
    const worker = new ActionExecutor({ maxActionDepth: 4, onError });
    executor.register('sound', async (context) => {
      await new Promise<void>((resolve) => {
        context.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { outcome: 'executed' };
    });
    worker.register('movie', async () => ({ outcome: 'executed' }));
    // 场景等价于「Sound@Synchronous 阻塞期间用户继续点击」——两组执行同时存在。
    const blocked = executor.execute([soundAction()], CONTEXT);
    await Promise.resolve();
    // 期间的多次独立执行全部正常完成，不会被前面的阻塞组污染深度。
    const results: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const outcomes = await executor.execute([movieAction()], CONTEXT).then(() => 'ok');
      results.push(outcomes);
    }
    expect(results).toHaveLength(6);
    expect(onError).not.toHaveBeenCalled();
    executor.cancelAll();
    await blocked;
  });

  it('handler 在 await 期间被取消时，结果按 cancelled 处理且不派发结果事件', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const executor = new ActionExecutor({ onResult, onError });
    const controller = new AbortController();
    executor.register('movie', async () => {
      // 模拟长时间加载：取消发生在 await 期间。
      await Promise.resolve();
      controller.abort();
      return { outcome: 'executed' };
    });
    const outcomes = await executor.execute([movieAction()], CONTEXT, {
      signal: controller.signal,
    });
    expect(outcomes).toEqual(['cancelled']);
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('cancelAll 之后排队中的动作被直接丢弃，不再调用 handler', async () => {
    const handler = vi.fn(async () => ({ outcome: 'executed' }) as ActionHandlerResult);
    const executor = new ActionExecutor();
    executor.register('movie', handler);
    const controller = new AbortController();
    controller.abort();
    const outcomes = await executor.execute([movieAction(), movieAction()], CONTEXT, {
      signal: controller.signal,
    });
    expect(outcomes).toEqual(['cancelled', 'cancelled']);
    expect(handler).not.toHaveBeenCalled();
  });
});
