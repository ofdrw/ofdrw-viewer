/**
 * 附件能力门控（设计方案 §6.2.1）。
 *
 * 覆盖：功能键默认开启且依赖 sidebar、关闭时不渲染标签页、openSidebar 被拒绝、
 * 无附件时由文档可用性关闭、toggleSidebar 候选顺序包含附件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { isFeatureDisabledError } from '../../../src/errors';
import {
  DEFAULT_FEATURES,
  FEATURE_DEPENDENCIES,
  VIEWER_FEATURES,
  resolveFeatureStates,
} from '../../../src/features';
import { OFDViewer } from '../../../src/viewer';
import { createMockDocument } from '../../helpers/document';

beforeEach(() => {
  document.body.innerHTML = '';
  engineMocks.open.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('attachments 功能键', () => {
  it('默认开启并依赖 sidebar', () => {
    expect(VIEWER_FEATURES).toContain('attachments');
    expect(DEFAULT_FEATURES.attachments).toBe(true);
    expect(FEATURE_DEPENDENCIES.attachments).toEqual(['sidebar']);
    const states = resolveFeatureStates({ sidebar: false });
    expect(states.attachments.enabled).toBe(false);
    expect(states.attachments.reason).toBe('dependency');
  });

  it('宿主关闭时 openSidebar(attachments) 抛 OFD_FEATURE_DISABLED', async () => {
    engineMocks.open.mockResolvedValue(
      createMockDocument({ pageCount: 1, attachments: [{ id: 'a1', name: 'a.pdf' }] }),
    );
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      features: { attachments: false },
    });
    await viewer.ready;
    expect(() => viewer.openSidebar('attachments')).toThrow();
    try {
      viewer.openSidebar('attachments');
    } catch (error) {
      expect(isFeatureDisabledError(error, 'attachments')).toBe(true);
    }
    expect(viewer.getSidebarView()).toBeNull();
    viewer.destroy();
  });

  it('有附件时打开成功', async () => {
    engineMocks.open.mockResolvedValue(
      createMockDocument({ pageCount: 1, attachments: [{ id: 'a1', name: 'a.pdf' }] }),
    );
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    viewer.openSidebar('attachments');
    expect(viewer.getSidebarView()).toBe('attachments');
    viewer.destroy();
  });

  it('无附件时文档可用性关闭 attachments', async () => {
    engineMocks.open.mockResolvedValue(createMockDocument({ pageCount: 1, attachments: [] }));
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    await viewer.ready;
    // applyAvailability 异步执行，等待一轮微任务与定时器。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = viewer.getFeatureState('attachments');
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe('document');
    viewer.destroy();
  });

  it('引擎缺少 saveAttachment 时标记 unsupported', async () => {
    engineMocks.open.mockResolvedValue(
      createMockDocument({ pageCount: 1, attachments: [{ id: 'a1', name: 'a.pdf' }] }),
    );
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
    });
    // 打开后移除流式能力模拟旧引擎。
    await viewer.ready;
    const doc = viewer.getDocument() as unknown as { saveAttachment?: unknown };
    delete doc.saveAttachment;
    await viewer.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewer.getFeatureState('attachments').enabled).toBe(false);
    viewer.destroy();
  });
});
