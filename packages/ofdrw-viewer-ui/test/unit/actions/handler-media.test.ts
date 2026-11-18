/**
 * Sound / Movie handler 单测（音视频与动作方案设计 §7.3 / §7.5）。
 *
 * 覆盖：Movie 四操作符（Play/Stop/Pause/Resume）、实例复用、Sound 的 volume/repeat/
 * synchronous、超限转下载、autoplay 被拦截、内联/弹出两种呈现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInfo, MediaResource } from '@ofdrw/ofdrw-viewer-engine';
import { createMovieHandler } from '../../../src/actions/handlers/movie';
import { createSoundHandler } from '../../../src/actions/handlers/sound';
import { MediaPlayerManager } from '../../../src/actions/handlers/media-player';
import type { ActionExecutionContext } from '../../../src/actions/types';

const VIDEO: MediaResource = {
  id: '10',
  kind: 'video',
  mediaFile: 'Res/video.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 10,
  scope: 'document',
  declaredIn: 'DocumentRes.xml',
};
const AUDIO: MediaResource = {
  id: '12',
  kind: 'audio',
  mediaFile: 'Res/audio.mp3',
  mimeType: 'audio/mpeg',
  sizeBytes: 10,
  scope: 'document',
  declaredIn: 'DocumentRes.xml',
};

/** 构造 movie 动作。 */
function movieAction(operator: 'Play' | 'Stop' | 'Pause' | 'Resume'): ActionInfo {
  return {
    event: 'CLICK',
    type: 'movie',
    owner: { kind: 'object', pageIndex: 0, objectId: '202' },
    payload: { type: 'movie', resourceId: '10', operator },
  } as ActionInfo;
}

/** 构造 sound 动作。 */
function soundAction(overrides: Record<string, unknown> = {}): ActionInfo {
  return {
    event: 'CLICK',
    type: 'sound',
    owner: { kind: 'object', pageIndex: 0, objectId: '205' },
    payload: { type: 'sound', resourceId: '12', volume: 100, repeat: false, synchronous: false, ...overrides },
  } as ActionInfo;
}

const CONTEXT: ActionExecutionContext = {
  trigger: 'CLICK',
  pageIndex: 0,
  anchor: { objectId: '202', bbox: { left: 258.9, top: 128.5, width: 604.7, height: 340.2 } },
};

let originalPlay: typeof HTMLMediaElement.prototype.play;
let originalPause: typeof HTMLMediaElement.prototype.pause;
let originalLoad: typeof HTMLMediaElement.prototype.load;

beforeEach(() => {
  originalPlay = HTMLMediaElement.prototype.play;
  originalPause = HTMLMediaElement.prototype.pause;
  originalLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  let seq = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => `blob:test-${(seq += 1)}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  HTMLMediaElement.prototype.play = originalPlay;
  HTMLMediaElement.prototype.pause = originalPause;
  HTMLMediaElement.prototype.load = originalLoad;
});

/** 创建共享宿主。 */
function createHost(options: { muteOnAutoplayBlocked?: boolean; tooLarge?: boolean } = {}) {
  /** 播放器上报的媒体事件，按发生顺序记录。 */
  const events: Array<{ event: string; resourceId: string }> = [];
  const players = new MediaPlayerManager({
    ownerDocument: document,
    maxMediaBytes: 1024,
    masterVolume: 1,
    muteOnAutoplayBlocked: options.muteOnAutoplayBlocked ?? true,
    onEvent: (event, payload) => events.push({ event, resourceId: payload.resourceId }),
  });
  const presentInline = vi.fn(() => true);
  const presentPopup = vi.fn();
  const removeInline = vi.fn();
  const offerDownload = vi.fn();
  const getMediaResource = vi.fn(async (id: string) =>
    id === '10' ? VIDEO : id === '12' ? AUDIO : undefined,
  );
  const host = {
    players,
    getMediaResource,
    readMediaBytes: async () => (options.tooLarge ? new Uint8Array(2000) : new Uint8Array([1, 2, 3])),
    presentInline,
    presentPopup,
    removeInline,
    offerDownload,
    t: (key: string) => key,
  };
  return {
    players,
    host,
    events,
    presentInline,
    presentPopup,
    removeInline,
    offerDownload,
    getMediaResource,
  };
}

describe('Movie 四操作符', () => {
  it('Play 无实例时创建并从 0 播放', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    const result = await handler(CONTEXT, movieAction('Play'));
    expect(result.outcome).toBe('executed');
    expect(ctx.players.playersSnapshot).toHaveLength(1);
    expect(ctx.presentInline).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('Pause 暂停并保留位置', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    const result = await handler(CONTEXT, movieAction('Pause'));
    expect(result.outcome).toBe('executed');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('Resume 复用同一实例继续播放', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    const instance = ctx.players.playersSnapshot[0];
    await handler(CONTEXT, movieAction('Pause'));
    const result = await handler(CONTEXT, movieAction('Resume'));
    expect(result.outcome).toBe('executed');
    // 关键：仍是同一实例，播放位置得以保留。
    expect(ctx.players.playersSnapshot[0]).toBe(instance);
  });

  it('Stop 销毁实例并移除内联播放器（封面重新可见）', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    const result = await handler(CONTEXT, movieAction('Stop'));
    expect(result.outcome).toBe('executed');
    expect(ctx.removeInline).toHaveBeenCalledTimes(1);
    expect(ctx.players.playersSnapshot).toHaveLength(0);
  });

  it('Pause 无实例时幂等成功，不创建播放器也不发媒体事件', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    const result = await handler(CONTEXT, movieAction('Pause'));
    expect(result.outcome).toBe('executed');
    expect(ctx.players.playersSnapshot).toHaveLength(0);
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    expect(ctx.events).toHaveLength(0);
    expect(ctx.presentInline).not.toHaveBeenCalled();
    expect(ctx.presentPopup).not.toHaveBeenCalled();
  });

  it('Stop 无实例时幂等成功，且不读取媒体资源', async () => {
    const ctx = createHost();
    const getMediaResource = vi.spyOn(ctx.host, 'getMediaResource');
    const handler = createMovieHandler(ctx.host as never);
    const result = await handler(CONTEXT, movieAction('Stop'));
    expect(result.outcome).toBe('executed');
    expect(ctx.removeInline).not.toHaveBeenCalled();
    // 纯状态操作不应产生多余 IO。
    expect(getMediaResource).not.toHaveBeenCalled();
  });

  it('Stop 有实例时销毁并上报 stop', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    ctx.events.length = 0;
    const result = await handler(CONTEXT, movieAction('Stop'));
    expect(result.outcome).toBe('executed');
    expect(ctx.players.playersSnapshot).toHaveLength(0);
    expect(ctx.events.map((event) => event.event)).toContain('stop');
  });

  it('Resume 无实例时退化为 Play（创建实例并从 0 播放）', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    const result = await handler(CONTEXT, movieAction('Resume'));
    expect(result.outcome).toBe('executed');
    expect(ctx.players.playersSnapshot).toHaveLength(1);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(ctx.presentInline).toHaveBeenCalled();
  });

  it('Pause 时元素已脱离文档则先重新呈现', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    const handle = ctx.players.playersSnapshot[0]!;
    handle.element.remove();
    expect(handle.element.isConnected).toBe(false);
    const before = ctx.presentInline.mock.calls.length;
    const result = await handler(CONTEXT, movieAction('Pause'));
    expect(result.outcome).toBe('executed');
    expect(ctx.presentInline.mock.calls.length).toBe(before + 1);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('Resume 时元素已脱离文档则先重新呈现再播放', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    const handle = ctx.players.playersSnapshot[0]!;
    handle.element.remove();
    const before = ctx.presentInline.mock.calls.length;
    const result = await handler(CONTEXT, movieAction('Resume'));
    expect(result.outcome).toBe('executed');
    expect(ctx.presentInline.mock.calls.length).toBe(before + 1);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it('Movie 不阻塞：不返回 waitForEnd', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    const result = await handler(CONTEXT, movieAction('Play'));
    expect(result.waitForEnd).toBeUndefined();
  });
});

describe('Movie 呈现模式', () => {
  it('图元触发且能内联时走内联', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    expect(ctx.presentInline).toHaveBeenCalled();
    expect(ctx.presentPopup).not.toHaveBeenCalled();
  });

  it('文档级触发走弹出式', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    const docAction = {
      ...movieAction('Play'),
      owner: { kind: 'document' },
    } as ActionInfo;
    await handler({ trigger: 'DO', pageIndex: 0 }, docAction);
    expect(ctx.presentInline).not.toHaveBeenCalled();
    expect(ctx.presentPopup).toHaveBeenCalled();
  });

  it('内联失败时降级为弹出式', async () => {
    const ctx = createHost();
    ctx.presentInline.mockReturnValue(false);
    const handler = createMovieHandler(ctx.host as never);
    await handler(CONTEXT, movieAction('Play'));
    expect(ctx.presentPopup).toHaveBeenCalled();
  });
});

describe('Movie 异常与分级', () => {
  it('资源缺失返回 resource-missing', async () => {
    const ctx = createHost();
    const handler = createMovieHandler(ctx.host as never);
    const action = {
      ...movieAction('Play'),
      payload: { type: 'movie', resourceId: '99', operator: 'Play' },
    } as ActionInfo;
    const result = await handler(CONTEXT, action);
    expect(result.skipReason).toBe('resource-missing');
  });

  it('超限时不读内容并提示下载', async () => {
    const ctx = createHost();
    // 声明大小超限：管理器在第一档就拦下。
    const bigVideo = { ...VIDEO, sizeBytes: 999999 };
    const host = {
      ...ctx.host,
      getMediaResource: async () => bigVideo,
    };
    const handler = createMovieHandler(host as never);
    const result = await handler(CONTEXT, movieAction('Play'));
    expect(result.outcome).toBe('skipped');
    expect(ctx.offerDownload).toHaveBeenCalledWith(bigVideo);
  });
});

describe('Sound handler', () => {
  it('设置音量与循环', async () => {
    const ctx = createHost();
    const handler = createSoundHandler(ctx.host as never);
    const result = await handler(CONTEXT, soundAction({ volume: 50, repeat: true }));
    expect(result.outcome).toBe('executed');
    const element = ctx.players.playersSnapshot[0]!.element;
    expect(element.volume).toBeCloseTo(0.5);
    expect(element.loop).toBe(true);
  });

  it('音频走弹出式呈现', async () => {
    const ctx = createHost();
    const handler = createSoundHandler(ctx.host as never);
    await handler(CONTEXT, soundAction());
    expect(ctx.presentPopup).toHaveBeenCalled();
    expect(ctx.presentInline).not.toHaveBeenCalled();
  });

  it('synchronous 且非 repeat 时返回 waitForEnd', async () => {
    const ctx = createHost();
    const handler = createSoundHandler(ctx.host as never);
    const result = await handler(CONTEXT, soundAction({ synchronous: true }));
    expect(result.waitForEnd).toBeInstanceOf(Promise);
  });

  it('synchronous + repeat=true 时同步无效（不返回 waitForEnd）', async () => {
    const ctx = createHost();
    const handler = createSoundHandler(ctx.host as never);
    const result = await handler(CONTEXT, soundAction({ synchronous: true, repeat: true }));
    expect(result.waitForEnd).toBeUndefined();
  });

  it('超限时提示下载且不读内容', async () => {
    const ctx = createHost();
    const bigAudio = { ...AUDIO, sizeBytes: 999999 };
    const host = { ...ctx.host, getMediaResource: async () => bigAudio };
    const handler = createSoundHandler(host as never);
    const result = await handler(CONTEXT, soundAction());
    expect(result.outcome).toBe('skipped');
    expect(ctx.offerDownload).toHaveBeenCalledWith(bigAudio);
    expect(ctx.players.playersSnapshot).toHaveLength(0);
  });
});