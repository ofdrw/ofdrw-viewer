/**
 * 媒体事件与浮层生命周期单测（音视频与动作方案设计 §4.3 / §7.3 / §9.2）。
 *
 * 覆盖：
 * - `destroyPlayer` 主动停止时派发 `stop`，`destroyAll` 批量销毁时静默；
 * - `mapMediaError` 的 `OFD_MEDIA_DECODE_FAILED` 能映射到 `media:error.code = 'decode'`；
 * - `MediaPresenter.presentPopup` 关闭旧浮层时回调 `onPopupClose`，同一实例重复呈现不叠加浮层。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaResource } from '@ofdrw/ofdrw-viewer-engine';
import {
  MediaPlayerManager,
  mapMediaError,
  type MediaPlayerHandle,
} from '../../../src/actions/handlers/media-player';
import { MediaPresenter } from '../../../src/actions/handlers/media-presenter';
import type { Translator } from '../../../src/i18n';

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
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  HTMLMediaElement.prototype.play = originalPlay;
  HTMLMediaElement.prototype.pause = originalPause;
  HTMLMediaElement.prototype.load = originalLoad;
  document.body.innerHTML = '';
});

/** 创建管理器并记录媒体事件。 */
function createManager() {
  const events: Array<{ event: string; resourceId: string; kind: string }> = [];
  const manager = new MediaPlayerManager({
    ownerDocument: document,
    maxMediaBytes: 1024,
    masterVolume: 1,
    muteOnAutoplayBlocked: true,
    onEvent: (event, payload) =>
      events.push({ event, resourceId: payload.resourceId, kind: payload.kind }),
  });
  return { manager, events };
}

describe('媒体 stop 事件', () => {
  it('主动销毁单个播放器时派发 stop（带 resourceId/kind/pageIndex）', async () => {
    const { manager, events } = createManager();
    const handle = (await manager.acquire(resource(), 2, async () => new Uint8Array([1]))).player!;
    manager.destroyPlayer(handle);
    const stop = events.find((event) => event.event === 'stop');
    expect(stop).toEqual({ event: 'stop', resourceId: '10', kind: 'video' });
  });

  it('destroyAll 批量销毁时静默，不逐条派发 stop', async () => {
    const { manager, events } = createManager();
    await manager.acquire(resource({ id: '1' }), 0, async () => new Uint8Array([1]));
    await manager.acquire(resource({ id: '2' }), 1, async () => new Uint8Array([1]));
    manager.destroyAll();
    expect(events.filter((event) => event.event === 'stop')).toHaveLength(0);
    expect(manager.playersSnapshot).toHaveLength(0);
  });

  it('destroyAll 可显式要求派发 stop', async () => {
    const { manager, events } = createManager();
    await manager.acquire(resource(), 0, async () => new Uint8Array([1]));
    manager.destroyAll({ emitStop: true });
    expect(events.filter((event) => event.event === 'stop')).toHaveLength(1);
  });

  it('destroyPlayer({emitStop:false}) 不派发 stop', async () => {
    const { manager, events } = createManager();
    const handle = (await manager.acquire(resource(), 0, async () => new Uint8Array([1]))).player!;
    manager.destroyPlayer(handle, { emitStop: false });
    expect(events).toHaveLength(0);
  });
});

describe('媒体错误码分类', () => {
  it('解码失败映射为 OFD_MEDIA_DECODE_FAILED，可转为 media:error.code=decode', () => {
    const code = mapMediaError({ code: 3 } as MediaError);
    expect(code).toBe('OFD_MEDIA_DECODE_FAILED');
    // `media:error.code` 的分类口径：解码失败必须是 decode，而非 load。
    expect(mapToViewerCode(code)).toBe('decode');
  });

  it('不支持格式映射为 unsupported，其余为 load', () => {
    expect(mapToViewerCode('OFD_MEDIA_UNSUPPORTED')).toBe('unsupported');
    expect(mapToViewerCode('OFD_MEDIA_LOAD_FAILED')).toBe('load');
    expect(mapToViewerCode(undefined)).toBe('load');
  });

  /**
   * 与 `actions/index.ts` 的事件映射保持同一口径。
   *
   * @param code 引擎/播放器错误码。
   * @returns `media:error.code` 分类。
   */
  function mapToViewerCode(code: string | undefined): 'unsupported' | 'decode' | 'load' {
    if (code === 'OFD_MEDIA_UNSUPPORTED') return 'unsupported';
    if (code === 'OFD_MEDIA_DECODE_FAILED') return 'decode';
    return 'load';
  }
});

describe('MediaPresenter 浮层生命周期', () => {
  /** 最小翻译器替身。 */
  const translator = {
    t: (key: string) => key,
    formatNumber: (value: number) => String(value),
  } as unknown as Translator;

  /** 创建挂载在 body 上的根节点与呈现层。 */
  async function createPresenter() {
    const root = document.createElement('div');
    root.className = 'ofd-viewer';
    document.body.appendChild(root);
    const { manager } = createManager();
    const onPopupClose = vi.fn<(handle: MediaPlayerHandle) => void>();
    const presenter = new MediaPresenter({
      root,
      getDialogLayer: () => root,
      getPageView: () => undefined,
      getTranslator: () => translator,
      getOrigin: () => undefined,
      downloadWholeOfd: () => undefined,
      onPopupClose,
    });
    return { root, manager, presenter, onPopupClose };
  }

  it('打开新浮层时关闭旧浮层并回调 onPopupClose 销毁旧句柄', async () => {
    const { manager, presenter, onPopupClose } = await createPresenter();
    const first = (await manager.acquire(resource({ id: '1' }), 0, async () => new Uint8Array([1])))
      .player!;
    const second = (await manager.acquire(resource({ id: '2' }), 0, async () => new Uint8Array([1])))
      .player!;
    presenter.presentPopup(first, 'a');
    presenter.presentPopup(second, 'b');
    expect(onPopupClose).toHaveBeenCalledTimes(1);
    expect(onPopupClose).toHaveBeenCalledWith(first);
    // 同一时刻只保留一个浮层。
    expect(document.querySelectorAll('.ofd-media-popup')).toHaveLength(1);
  });

  it('同一实例已在浮层中时重复呈现不叠加浮层，也不回调关闭', async () => {
    const { manager, presenter, onPopupClose } = await createPresenter();
    const handle = (await manager.acquire(resource(), 0, async () => new Uint8Array([1]))).player!;
    presenter.presentPopup(handle, 'a');
    presenter.presentPopup(handle, 'b');
    expect(document.querySelectorAll('.ofd-media-popup')).toHaveLength(1);
    expect(onPopupClose).not.toHaveBeenCalled();
  });

  it('destroy 只清理浮层，不回调 onPopupClose（由调用方统一销毁）', async () => {
    const { manager, presenter, onPopupClose } = await createPresenter();
    const handle = (await manager.acquire(resource(), 0, async () => new Uint8Array([1]))).player!;
    presenter.presentPopup(handle, 'a');
    presenter.destroy();
    expect(onPopupClose).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.ofd-media-popup')).toHaveLength(0);
  });
});