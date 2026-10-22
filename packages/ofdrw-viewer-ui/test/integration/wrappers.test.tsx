/**
 * 适配层集成基线：Web Component/React/Vue 在真实核心上映射事件、同步属性并销毁。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { createRef } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { flushPromises, mount } from '@vue/test-utils';
import { getUIShell } from '../../src/ui';
import { defineOFDViewerElement, OFDViewerElement } from '../../src/component/ofd-viewer-element';
import { OFDViewer as ReactOFDViewer, type OFDViewerHandle } from '../../src/react';
import { OFDViewer as VueOFDViewer } from '../../src/vue';
import { installDomEnvironment, resetDom } from '../helpers/environment';
import { createMockDocument } from '../helpers/document';
import type { EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;

beforeEach(() => {
  resetDom();
  installDomEnvironment();
  defineOFDViewerElement();
  openMock.mockReset();
  openMock.mockResolvedValue(createMockDocument({ pageCount: 3 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('适配层集成', () => {
  it('Web Component 映射属性与 ofd-* 事件', async () => {
    const source = new ArrayBuffer(8);
    const element = document.createElement('ofd-viewer') as OFDViewerElement;
    const events: Array<{ type: string; detail: unknown }> = [];
    for (const type of [
      'ofd-document-open',
      'ofd-page-rendered',
      'ofd-rotation-change',
      'ofd-state-change',
    ]) {
      element.addEventListener(type, (event) => {
        events.push({ type, detail: (event as CustomEvent).detail });
      });
    }
    element.source = source;
    element.setAttribute('page', '2');
    document.body.append(element);

    await waitFor(() => expect(events.some((event) => event.type === 'ofd-document-open')).toBe(true));
    await waitFor(() => expect(events.some((event) => event.type === 'ofd-page-rendered')).toBe(true));
    expect(element.viewer?.getPageCount()).toBe(3);
    expect(element.viewer?.getPageNumber()).toBe(2);
    expect(getUIShell(element.viewer!)).toBeDefined();

    element.viewer!.setRotation(90);
    await waitFor(() =>
      expect(events.some((event) => event.type === 'ofd-rotation-change')).toBe(true),
    );
    expect(events.find((event) => event.type === 'ofd-rotation-change')?.detail).toEqual({
      rotation: 90,
      previous: 0,
    });
    expect(events.some((event) => event.type === 'ofd-state-change')).toBe(true);

    element.remove();
    expect(element.viewer).toBeNull();
  });

  it('React 回调映射 onDocumentOpen/onPageRendered/onRotationChange', async () => {
    const source = new ArrayBuffer(8);
    const onDocumentOpen = vi.fn();
    const onPageRendered = vi.fn();
    const onRotationChange = vi.fn();
    const onFeaturesChange = vi.fn();
    const ref = createRef<OFDViewerHandle>();
    const { unmount } = render(
      <ReactOFDViewer
        ref={ref}
        source={source}
        onDocumentOpen={onDocumentOpen}
        onPageRendered={onPageRendered}
        onRotationChange={onRotationChange}
        onFeaturesChange={onFeaturesChange}
      />,
    );

    await waitFor(() => expect(onDocumentOpen).toHaveBeenCalledWith({ pageCount: 3 }));
    await waitFor(() => expect(onPageRendered).toHaveBeenCalled());
    const viewer = ref.current?.getInstance();
    expect(viewer).not.toBeNull();
    expect(viewer!.getPageCount()).toBe(3);
    expect(viewer!.getFeatureState('print').enabled).toBe(true);

    viewer!.setRotation(90);
    await waitFor(() =>
      expect(onRotationChange).toHaveBeenCalledWith({ rotation: 90, previous: 0 }),
    );
    viewer!.setFeatures({ print: false });
    await waitFor(() => expect(onFeaturesChange).toHaveBeenCalled());
    expect(viewer!.getFeatureState('print').enabled).toBe(false);

    const root = viewer!.getRoot();
    unmount();
    expect(root.isConnected).toBe(false);
  });

  it('Vue kebab-case 事件与 expose 命令', async () => {
    const source = new ArrayBuffer(8);
    const wrapper = mount(VueOFDViewer, { props: { source } });
    await flushPromises();
    await waitFor(() => expect(wrapper.emitted('document-open')).toBeTruthy());
    await waitFor(() => expect(wrapper.emitted('page-rendered')).toBeTruthy());

    const exposed = wrapper.vm as unknown as {
      getInstance: () => {
        getPageCount(): number;
        getRoot(): HTMLElement;
        setRotation(rotation: 90): void;
      };
      setRotation: (rotation: 90) => void;
    };
    const viewer = exposed.getInstance();
    expect(viewer.getPageCount()).toBe(3);
    exposed.setRotation(90);
    await flushPromises();
    await waitFor(() =>
      expect(wrapper.emitted('rotation-change')?.[0]).toEqual([{ rotation: 90, previous: 0 }]),
    );

    const root = viewer.getRoot();
    wrapper.unmount();
    expect(root.isConnected).toBe(false);
  });
});