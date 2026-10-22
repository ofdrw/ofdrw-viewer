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

import { OFDViewer } from '../../../src/vue/index';

beforeEach(() => {
  FakeViewer.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Vue wrapper', () => {
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
    };

    exposed.goToPage(3);
    exposed.setScale(2);
    expect(viewer.pageCalls).toContain(3);
    expect(viewer.scaleCalls).toContain(2);

    wrapper.unmount();
    expect(viewer.destroyed).toBe(true);
  });
});