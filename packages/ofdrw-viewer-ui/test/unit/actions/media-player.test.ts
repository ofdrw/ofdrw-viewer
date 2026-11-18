/**
 * 媒体播放器管理器单测（音视频与动作方案设计 §7.3 / §7.4 / §7.7 / §10.2）。
 *
 * 覆盖：两档分级（超限不读内容）、按 resourceId 复用实例、ObjectURL 释放顺序
 * （pause → removeAttribute('src') → load() → revokeObjectURL）、错误码映射、
 * 页淘汰与全量销毁。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaResource } from '@ofdrw/ofdrw-viewer-engine';
import {
  MediaPlayerManager,
  isAutoplayBlocked,
  mapMediaError,
} from '../../../src/actions/handlers/media-player';

/** 构造媒体资源。 */
function resource(overrides: Partial<MediaResource> = {}): MediaResource {
  return {
    id: '10',
    kind: 'video',
    mediaFile: 'Res/video.mp4',
    mimeType: 'video/mp4',
    scope: 'document',
    declaredIn: 'DocumentRes.xml',
    ...overrides,
  } as MediaResource;
}

/** 媒体元素方法替身记录。 */
interface ElementCalls {
  readonly pause: () => void;
  readonly load: () => void;
  readonly events: string[];
}

/** 创建管理器并捕获元素调用。 */
function createManager(options: { maxMediaBytes?: number } = {}) {
  const created: ElementCalls[] = [];
  const events: Array<{ event: string; resourceId: string }> = [];
  const createObjectURL = vi.fn((_blob: Blob) => `blob:test-${createObjectURL.mock.calls.length}`);
  const revokeObjectURL = vi.fn<(url: string) => void>(() => undefined);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });

  // jsdom 的媒体元素没有实现 play/pause/load，这里补最小桩并记录调用顺序。
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  const originalLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement): Promise<void> {
    const calls = (this as unknown as { __calls?: ElementCalls }).__calls;
    calls?.events.push('play');
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement): void {
    const calls = (this as unknown as { __calls?: ElementCalls }).__calls;
    calls?.pause();
    calls?.events.push('pause');
  };
  HTMLMediaElement.prototype.load = function load(this: HTMLMediaElement): void {
    const calls = (this as unknown as { __calls?: ElementCalls }).__calls;
    calls?.load();
    calls?.events.push('load');
  };

  const manager = new MediaPlayerManager({
    ownerDocument: document,
    maxMediaBytes: options.maxMediaBytes ?? 1024,
    masterVolume: 1,
    muteOnAutoplayBlocked: true,
    onEvent: (event, payload) => events.push({ event, resourceId: payload.resourceId }),
  });

  return {
    manager,
    created,
    events,
    createObjectURL,
    revokeObjectURL,
    restore() {
      HTMLMediaElement.prototype.play = originalPlay;
      HTMLMediaElement.prototype.pause = originalPause;
      HTMLMediaElement.prototype.load = originalLoad;
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    },
  };
}

describe('MediaPlayerManager 两档分级', () => {
  it('声明大小超过上限时**不读取内容**，返回 tooLarge', async () => {
    const ctx = createManager({ maxMediaBytes: 100 });
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const result = await ctx.manager.acquire(resource({ sizeBytes: 101 }), 0, readBytes);
    expect(result.tooLarge).toBe(true);
    expect(result.player).toBeUndefined();
    // 关键：分级判定发生在读取之前。
    expect(readBytes).not.toHaveBeenCalled();
    ctx.restore();
  });

  it('声明大小在上限内时读取并创建播放器', async () => {
    const ctx = createManager({ maxMediaBytes: 100 });
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const result = await ctx.manager.acquire(resource({ sizeBytes: 50 }), 0, readBytes);
    expect(result.player).toBeDefined();
    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(ctx.createObjectURL).toHaveBeenCalledTimes(1);
    ctx.restore();
  });

  it('声明大小缺失时按实际字节数二次判定', async () => {
    const ctx = createManager({ maxMediaBytes: 2 });
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const result = await ctx.manager.acquire(resource(), 0, readBytes);
    expect(result.tooLarge).toBe(true);
    ctx.restore();
  });

  it('读取返回空字节时报告加载失败', async () => {
    const ctx = createManager();
    const result = await ctx.manager.acquire(resource(), 0, async () => undefined);
    expect(result.code).toBe('OFD_MEDIA_LOAD_FAILED');
    ctx.restore();
  });
});

describe('MediaPlayerManager 实例复用', () => {
  it('同一 resourceId 复用同一实例（Pause/Resume 的前提）', async () => {
    const ctx = createManager();
    const readBytes = async () => new Uint8Array([1, 2, 3]);
    const first = await ctx.manager.acquire(resource(), 0, readBytes);
    const second = await ctx.manager.acquire(resource(), 0, readBytes);
    expect(second.player).toBe(first.player);
    // 第二次不得重新创建 ObjectURL。
    expect(ctx.createObjectURL).toHaveBeenCalledTimes(1);
    ctx.restore();
  });

  it('并发 acquire 共享同一次读取', async () => {
    const ctx = createManager();
    let release: (value: Uint8Array) => void = () => undefined;
    const readBytes = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve;
        }),
    );
    const first = ctx.manager.acquire(resource(), 0, readBytes);
    const second = ctx.manager.acquire(resource(), 0, readBytes);
    release(new Uint8Array([1]));
    const [a, b] = await Promise.all([first, second]);
    expect(a.player).toBe(b.player);
    expect(readBytes).toHaveBeenCalledTimes(1);
    ctx.restore();
  });

  it('不同 resourceId 各自独立实例', async () => {
    const ctx = createManager();
    const readBytes = async () => new Uint8Array([1]);
    const first = await ctx.manager.acquire(resource({ id: '1' }), 0, readBytes);
    const second = await ctx.manager.acquire(resource({ id: '2' }), 0, readBytes);
    expect(second.player).not.toBe(first.player);
    expect(ctx.createObjectURL).toHaveBeenCalledTimes(2);
    ctx.restore();
  });
});

describe('MediaPlayerManager 释放顺序（Safari 兼容）', () => {
  it('destroyPlayer 依次执行 pause → removeAttribute(src) → load → revokeObjectURL', async () => {
    const ctx = createManager();
    const handle = (await ctx.manager.acquire(resource(), 0, async () => new Uint8Array([1]))).player!;
    const pauseSpy = vi.fn<() => void>(() => undefined);
    const loadSpy = vi.fn<() => void>(() => undefined);
    const calls: ElementCalls = { pause: pauseSpy, load: loadSpy, events: [] as string[] };
    (handle.element as unknown as { __calls: ElementCalls }).__calls = calls;
    // 记录 removeAttribute 与 revoke 的相对顺序。
    const order: string[] = [];
    const originalRemove = handle.element.removeAttribute.bind(handle.element);
    handle.element.removeAttribute = vi.fn((name: string) => {
      if (name === 'src') order.push('removeAttribute');
      originalRemove(name);
    });
    ctx.revokeObjectURL.mockImplementation(() => order.push('revoke'));

    ctx.manager.destroyPlayer(handle);

    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(ctx.revokeObjectURL).toHaveBeenCalledTimes(1);
    // 断流必须早于 revoke。
    expect(order).toEqual(['removeAttribute', 'revoke']);
    ctx.restore();
  });

  it('重复销毁不会重复 revoke', async () => {
    const ctx = createManager();
    const handle = (await ctx.manager.acquire(resource(), 0, async () => new Uint8Array([1]))).player!;
    ctx.manager.destroyPlayer(handle);
    ctx.manager.destroyPlayer(handle);
    expect(ctx.revokeObjectURL).toHaveBeenCalledTimes(1);
    ctx.restore();
  });

  it('destroyByPage 只销毁该页播放器', async () => {
    const ctx = createManager();
    const readBytes = async () => new Uint8Array([1]);
    await ctx.manager.acquire(resource({ id: '1' }), 0, readBytes);
    await ctx.manager.acquire(resource({ id: '2' }), 1, readBytes);
    ctx.manager.destroyByPage(0);
    expect(ctx.manager.playersSnapshot).toHaveLength(1);
    expect(ctx.manager.playersSnapshot[0]!.resourceId).toBe('2');
    ctx.restore();
  });

  it('destroyAll 清空全部并撤销全部 URL', async () => {
    const ctx = createManager();
    const readBytes = async () => new Uint8Array([1]);
    await ctx.manager.acquire(resource({ id: '1' }), 0, readBytes);
    await ctx.manager.acquire(resource({ id: '2' }), 1, readBytes);
    ctx.manager.destroyAll();
    expect(ctx.manager.playersSnapshot).toHaveLength(0);
    expect(ctx.revokeObjectURL).toHaveBeenCalledTimes(2);
    ctx.restore();
  });

  it('destroyByResource 按资源 ID 销毁', async () => {
    const ctx = createManager();
    const handle = (await ctx.manager.acquire(resource(), 0, async () => new Uint8Array([1]))).player!;
    expect(ctx.manager.destroyByResource(handle.resourceId)).toBe(true);
    expect(ctx.manager.destroyByResource(handle.resourceId)).toBe(false);
    ctx.restore();
  });
});

describe('MediaPlayerManager 音量与浏览器限制', () => {
  it('动作音量与主音量相乘', () => {
    const ctx = createManager();
    expect(ctx.manager.resolveVolume(100)).toBeCloseTo(1);
    expect(ctx.manager.resolveVolume(50)).toBeCloseTo(0.5);
    expect(ctx.manager.resolveVolume(0)).toBeCloseTo(0);
    // 越界钳制。
    expect(ctx.manager.resolveVolume(200)).toBeCloseTo(1);
    expect(ctx.manager.resolveVolume(-10)).toBeCloseTo(0);
    ctx.restore();
  });

  it('元素带 playsinline 与 data-ofd-media 标记', async () => {
    const ctx = createManager();
    const handle = (await ctx.manager.acquire(resource(), 0, async () => new Uint8Array([1]))).player!;
    expect(handle.element.getAttribute('playsinline')).toBe('');
    expect(handle.element.getAttribute('webkit-playsinline')).toBe('');
    expect(handle.element.getAttribute('data-ofd-media')).toBe('10');
    ctx.restore();
  });

  it('mapMediaError 映射 CODE 3/4 到解码/不支持', () => {
    expect(mapMediaError({ code: 3 } as MediaError)).toBe('OFD_MEDIA_DECODE_FAILED');
    expect(mapMediaError({ code: 4 } as MediaError)).toBe('OFD_MEDIA_UNSUPPORTED');
    expect(mapMediaError({ code: 1 } as MediaError)).toBe('OFD_MEDIA_LOAD_FAILED');
    expect(mapMediaError(null)).toBe('OFD_MEDIA_LOAD_FAILED');
  });

  it('isAutoplayBlocked 识别 NotAllowedError', () => {
    expect(isAutoplayBlocked({ name: 'NotAllowedError' })).toBe(true);
    expect(isAutoplayBlocked({ name: 'AbortError' })).toBe(false);
    expect(isAutoplayBlocked(null)).toBe(false);
  });
});