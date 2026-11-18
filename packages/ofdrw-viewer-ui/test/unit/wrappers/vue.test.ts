/**
 * Vue wrapper：挂载/卸载、source/features 同步、kebab-case 事件、expose 与 markRaw。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReactive, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { FakeViewer } from './mock-viewer';

vi.mock('../../../src/index', async () => {
  const { FakeViewer: Fake } = await import('./mock-viewer');
  return { OFDViewer: Fake };
});

import {
  VIEWER_EVENT_BRIDGES,
  type ViewerEventBridge,
} from '../../../src/component/support';
import { OFDViewer } from '../../../src/vue/index';

/**
 * 桥接表里每个 Vue emit 对应的 props 回调名（`on-page-change` → `onPageChange`）。
 *
 * @param vueName 桥接表登记的 kebab-case 名称。
 * @returns 组件 props 中对应的回调名。
 */
function toPropsName(vueName: string): string {
  return `on${vueName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}`;
}

/**
 * 为每条桥接生成 `onXxx` 监听器。
 *
 * @returns 组件 props 与按核心事件名索引的监听器表。
 */
function createBridgeProps(): {
  props: Record<string, (payload: unknown) => void>;
  spies: Map<ViewerEventBridge['event'], ReturnType<typeof vi.fn>>;
} {
  const props: Record<string, (payload: unknown) => void> = {};
  const spies = new Map<ViewerEventBridge['event'], ReturnType<typeof vi.fn>>();
  for (const bridge of VIEWER_EVENT_BRIDGES) {
    const spy = vi.fn();
    spies.set(bridge.event, spy);
    props[toPropsName(bridge.vue)] = spy;
  }
  return { props, spies };
}

beforeEach(() => {
  FakeViewer.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Vue wrapper', () => {
  it('允许省略 source，由核心读取页面查询参数', async () => {
    mount(OFDViewer);
    await nextTick();
    await nextTick();
    expect(FakeViewer.instances).toHaveLength(1);
    expect(FakeViewer.instances[0]!.options.source).toBeUndefined();
  });

  it('挂载一次并同步受控属性，实例使用 markRaw 不进入 reactive', async () => {
    const wrapper = mount(OFDViewer, {
      props: {
        source: 'a.ofd',
        page: 2,
        scale: 1.5,
        features: { print: false },
      },
      attrs: { class: 'host-viewer' },
    });
    await nextTick();
    await nextTick();

    expect(FakeViewer.instances).toHaveLength(1);
    const viewer = FakeViewer.instances[0]!;
    expect(viewer.options.initialPage).toBe(2);
    expect(viewer.options.initialScale).toBe(1.5);
    expect(viewer.options.features).toEqual({ print: false });
    expect(wrapper.classes()).toContain('host-viewer');

    const exposed = wrapper.vm as unknown as { getInstance: () => FakeViewer };
    expect(exposed.getInstance()).toBe(viewer);
    expect(isReactive(viewer)).toBe(false);
  });

  it('source/features 变化调用方法且不重建实例', async () => {
    const wrapper = mount(OFDViewer, {
      props: { source: 'a.ofd', features: { print: true } },
    });
    await nextTick();
    const viewer = FakeViewer.instances[0]!;

    await wrapper.setProps({ source: 'b.ofd' });
    await wrapper.setProps({ features: { print: false } });
    await wrapper.setProps({ page: 5 });
    await nextTick();

    expect(viewer.openCalls).toContain('b.ofd');
    expect(viewer.featureCalls.at(-1)).toEqual({ print: false });
    expect(viewer.pageCalls).toContain(5);
    expect(FakeViewer.instances).toHaveLength(1);
  });

  it('核心事件映射为 kebab-case emit', async () => {
    const wrapper = mount(OFDViewer, {
      props: { source: 'a.ofd' },
    });
    await nextTick();
    const viewer = FakeViewer.instances[0]!;

    viewer.emit('pagechanging', { pageNumber: 2, previous: 1 });
    viewer.emit('featureschange', { print: { enabled: false, visible: false, reason: 'host' } });
    await nextTick();

    expect(wrapper.emitted('page-change')?.[0]).toEqual([
      { pageNumber: 2, previous: 1 },
    ]);
    expect(wrapper.emitted('features-change')).toHaveLength(1);
  });

  it('emit 本机字体事件，expose 转发状态与方法', async () => {
    const onLocalFontsChange = vi.fn();
    const wrapper = mount(OFDViewer, {
      props: { source: 'a.ofd', onLocalFontsChange },
    });
    await nextTick();
    const viewer = FakeViewer.instances[0]!;
    const exposed = wrapper.vm as unknown as {
      getLocalFontsStatus: () => { enabled: boolean };
      setLocalFontsEnabled: (enabled: boolean) => Promise<void>;
      onLocalFontsStatusChange: (handler: () => void) => () => void;
    };

    expect(exposed.getLocalFontsStatus()).toBe(viewer.localFontsStatus);
    expect(typeof exposed.onLocalFontsStatusChange(() => undefined)).toBe('function');

    await exposed.setLocalFontsEnabled(true);
    await nextTick();

    expect(viewer.localFontsCalls).toEqual([true]);
    expect(exposed.getLocalFontsStatus().enabled).toBe(true);
    expect(wrapper.emitted('local-fonts-change')).toHaveLength(1);
    expect(onLocalFontsChange).toHaveBeenCalledTimes(1);
  });

  it('遍历桥接表逐个 emit 并调用对应 onXxx 监听器', async () => {
    const { props, spies } = createBridgeProps();
    const wrapper = mount(OFDViewer, { props: { source: 'a.ofd', ...props } });
    await nextTick();
    const viewer = FakeViewer.instances[0]!;

    for (const bridge of VIEWER_EVENT_BRIDGES) {
      const payload = { marker: bridge.event };
      viewer.emit(bridge.event, payload);
      await nextTick();
      const spy = spies.get(bridge.event)!;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(payload);
      expect(wrapper.emitted(bridge.vue)).toHaveLength(1);
    }
    wrapper.unmount();
  });

  it('动作与音视频事件在 emits 中声明并被转发', async () => {
    const onActionExecuted = vi.fn();
    const onActionSkipped = vi.fn();
    const onActionError = vi.fn();
    const onMediaPlay = vi.fn();
    const onMediaPause = vi.fn();
    const onMediaEnded = vi.fn();
    const onMediaStop = vi.fn();
    const onMediaError = vi.fn();
    const wrapper = mount(OFDViewer, {
      props: {
        source: 'a.ofd',
        onActionExecuted,
        onActionSkipped,
        onActionError,
        onMediaPlay,
        onMediaPause,
        onMediaEnded,
        onMediaStop,
        onMediaError,
      },
    });
    await nextTick();
    const viewer = FakeViewer.instances[0]!;
    const declared = wrapper.vm.$options.emits as readonly string[];
    for (const name of [
      'action-executed',
      'action-skipped',
      'action-error',
      'media-play',
      'media-pause',
      'media-ended',
      'media-stop',
      'media-error',
    ]) {
      expect(declared).toContain(name);
    }

    viewer.emit('action:executed', { type: 'Goto', owner: 'page' });
    viewer.emit('action:skipped', { type: 'Sound', reason: 'autoplay-disabled' });
    viewer.emit('action:error', { type: 'URI', code: 'OFD_UNSUPPORTED' });
    viewer.emit('media:play', { resourceId: 'a', kind: 'video' });
    viewer.emit('media:pause', { resourceId: 'a', kind: 'video' });
    viewer.emit('media:ended', { resourceId: 'a', kind: 'video' });
    viewer.emit('media:stop', { resourceId: 'a', kind: 'video' });
    viewer.emit('media:error', { resourceId: 'a', code: 'decode' });
    await nextTick();

    expect(onActionExecuted).toHaveBeenCalledWith({ type: 'Goto', owner: 'page' });
    expect(onActionSkipped).toHaveBeenCalledWith({
      type: 'Sound',
      reason: 'autoplay-disabled',
    });
    expect(onActionError).toHaveBeenCalledWith({ type: 'URI', code: 'OFD_UNSUPPORTED' });
    expect(onMediaPlay).toHaveBeenCalledTimes(1);
    expect(onMediaPause).toHaveBeenCalledTimes(1);
    expect(onMediaEnded).toHaveBeenCalledTimes(1);
    expect(onMediaStop).toHaveBeenCalledTimes(1);
    expect(onMediaError).toHaveBeenCalledWith({ resourceId: 'a', code: 'decode' });
    wrapper.unmount();
  });

  it('expose 转发动作执行与自动执行开关方法', async () => {
    const wrapper = mount(OFDViewer, { props: { source: 'a.ofd' } });
    await nextTick();
    const viewer = FakeViewer.instances[0]!;
    const exposed = wrapper.vm as unknown as {
      executeActions: (
        pageIndex: number,
        event: string,
        options?: { signal?: AbortSignal },
      ) => Promise<readonly string[]>;
      getAutoExecuteActions: () => boolean | undefined;
      setAutoExecuteActions: (enabled: boolean) => void;
      getAutoExecuteActionsToggleAllowed: () => boolean | undefined;
    };

    expect(await exposed.executeActions(0, 'PO')).toEqual(['executed']);
    expect(viewer.executeActionsCalls).toEqual([[0, 'PO']]);

    expect(exposed.getAutoExecuteActions()).toBe(false);
    exposed.setAutoExecuteActions(true);
    expect(viewer.autoExecuteCalls).toEqual([true]);
    expect(exposed.getAutoExecuteActions()).toBe(true);
    expect(exposed.getAutoExecuteActionsToggleAllowed()).toBe(true);
    wrapper.unmount();
  });

  it('expose 提供实例与常用命令，卸载销毁实例', async () => {
    const wrapper = mount(OFDViewer, {
      props: { source: 'a.ofd' },
    });
    await nextTick();
    const viewer = FakeViewer.instances[0]!;
    const exposed = wrapper.vm as unknown as {
      getInstance: () => FakeViewer;
      goToPage: (page: number) => void;
      setScale: (scale: number) => void;
      exportOfd: () => Promise<{ filename: string } | null>;
    };

    exposed.goToPage(3);
    exposed.setScale(2);
    expect((await exposed.exportOfd())?.filename).toBe('fake.ofd');
    expect(viewer.pageCalls).toContain(3);
    expect(viewer.scaleCalls).toContain(2);

    wrapper.unmount();
    expect(viewer.destroyed).toBe(true);
  });
});