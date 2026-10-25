/**
 * React wrapper：实例复用、source/features 同步、事件、ref 与 StrictMode 清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef, StrictMode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { FakeViewer } from './mock-viewer';

vi.mock('../../../src/index', async () => {
  const { FakeViewer: Fake } = await import('./mock-viewer');
  return { OFDViewer: Fake };
});

import {
  OFDViewer,
  type OFDViewerHandle,
} from '../../../src/react/index';

beforeEach(() => {
  FakeViewer.reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('React wrapper', () => {
  it('允许省略 source，由核心读取页面查询参数', async () => {
    render(<OFDViewer />);
    await waitFor(() => expect(FakeViewer.instances).toHaveLength(1));
    expect(FakeViewer.instances[0]!.options.source).toBeUndefined();
  });

  it('挂载一次并同步受控属性，不重建实例', async () => {
    const { rerender, container } = render(
      <OFDViewer source="a.ofd" page={2} scale={1.5} features={{ print: false }} />,
    );
    await waitFor(() => expect(FakeViewer.instances).toHaveLength(1));
    const viewer = FakeViewer.instances[0]!;
    expect(container.querySelector('.fake-ofd-viewer')).not.toBeNull();
    expect(viewer.options.initialPage).toBe(2);
    expect(viewer.options.initialScale).toBe(1.5);
    expect(viewer.options.features).toEqual({ print: false });

    rerender(
      <OFDViewer source="b.ofd" page={3} scale={2} features={{ find: false }} />,
    );
    await waitFor(() => expect(viewer.openCalls).toContain('b.ofd'));
    expect(viewer.pageCalls).toContain(3);
    expect(viewer.scaleCalls).toContain(2);
    expect(viewer.featureCalls.at(-1)).toEqual({ find: false });
    expect(FakeViewer.instances).toHaveLength(1);
  });

  it('事件回调映射为 onXxx，且细节载荷不变', async () => {
    const onPageChange = vi.fn();
    const onError = vi.fn();
    render(
      <OFDViewer
        source="a.ofd"
        onPageChange={onPageChange}
        onError={onError}
      />,
    );
    await waitFor(() => expect(FakeViewer.instances).toHaveLength(1));
    const viewer = FakeViewer.instances[0]!;

    act(() => {
      viewer.emit('pagechanging', { pageNumber: 2, previous: 1 });
      viewer.emit('error', { code: 'OFD_OPEN_FAILED', message: 'bad' });
    });

    expect(onPageChange).toHaveBeenCalledWith({ pageNumber: 2, previous: 1 });
    expect(onError).toHaveBeenCalledWith({ code: 'OFD_OPEN_FAILED', message: 'bad' });
  });

  it('forwardRef 暴露方法子集与 getInstance', async () => {
    const ref = createRef<OFDViewerHandle>();
    render(<OFDViewer ref={ref} source="a.ofd" />);
    await waitFor(() => expect(ref.current).not.toBeNull());
    const viewer = FakeViewer.instances[0]!;
    expect(ref.current!.getInstance()).toBe(viewer);

    ref.current!.goToPage(4);
    ref.current!.setScale(1.25);
    ref.current!.setRotation(90);
    await ref.current!.print();
    const exported = await ref.current!.exportOfd();
    expect(exported?.filename).toBe('fake.ofd');

    expect(viewer.pageCalls).toContain(4);
    expect(viewer.scaleCalls).toContain(1.25);
    expect(viewer.rotationCalls).toContain(90);
    expect(viewer.printCalls).toBe(1);
    expect(ref.current!.getState()).toBe(viewer.getState());
  });

  it('ref 句柄转发本机字体方法与事件回调', async () => {
    const ref = createRef<OFDViewerHandle>();
    const onLocalFontsChange = vi.fn();
    render(<OFDViewer ref={ref} source="a.ofd" onLocalFontsChange={onLocalFontsChange} />);
    await waitFor(() => expect(ref.current).not.toBeNull());
    const viewer = FakeViewer.instances[0]!;

    expect(ref.current!.getLocalFontsStatus()).toBe(viewer.localFontsStatus);
    const unsubscribe = ref.current!.onLocalFontsStatusChange(() => undefined);
    expect(typeof unsubscribe).toBe('function');

    await act(async () => {
      await ref.current!.setLocalFontsEnabled(true);
    });
    expect(viewer.localFontsCalls).toEqual([true]);
    expect(ref.current!.getLocalFontsStatus().enabled).toBe(true);
    // 事件经桥接表转发为 onLocalFontsChange 回调。
    await waitFor(() => expect(onLocalFontsChange).toHaveBeenCalledTimes(1));
    expect(onLocalFontsChange.mock.calls[0]![0]).toMatchObject({ enabled: true });
    unsubscribe();
  });

  it('StrictMode 双挂载后只保留一个活跃实例，卸载全部销毁', async () => {
    const { unmount } = render(
      <StrictMode>
        <OFDViewer source="a.ofd" />
      </StrictMode>,
    );
    await waitFor(() => expect(FakeViewer.instances.length).toBeGreaterThanOrEqual(1));

    const active = FakeViewer.instances.filter((viewer) => !viewer.destroyed);
    expect(active).toHaveLength(1);
    expect(FakeViewer.instances.length).toBeLessThanOrEqual(2);

    unmount();
    expect(FakeViewer.instances.every((viewer) => viewer.destroyed)).toBe(true);
  });
});