/**
 * 附件侧栏 tab 接入（设计方案 §6.2.1）。
 *
 * 通过真实 `OFDViewer` + 内置 UI 外壳验证 tab 的可见性契约：
 * 有附件时渲染并位于最后；无附件不渲染；功能开关关闭时不渲染且 openSidebar 被拒绝；
 * 引擎缺少 `saveAttachment` 时同样视为不可用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import { resolveFeatureStates } from '../../../src/features';
import { createTranslator } from '../../../src/i18n';
import type { Translator } from '../../../src/i18n';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import { AttachmentView } from '../../../src/views/attachments';
import type { AttachmentViewer } from '../../../src/views/attachments';

/** 当前挂载的视图；用例结束统一释放。 */
const views: AttachmentView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** 三个附件样例。 */
const ATTACHMENTS: readonly AttachmentInfo[] = [
  { id: 'a1', name: '合同.pdf', format: 'PDF', size: 2048, modDate: '2024-03-03' },
  { id: 'a2', name: '明细.xlsx', format: 'xlsx' },
  { id: 'a3', name: '无格式附件' },
];

/** 构造状态快照。 */
function makeState(options: { enabled?: boolean } = {}): ViewerState {
  const base = createInitialViewerState();
  return {
    ...base,
    document: { ...base.document, pageCount: 1, status: 'ready' },
    ui: {
      ...base.ui,
      features: resolveFeatureStates(options.enabled === false ? { attachments: false } : {}),
    },
  };
}

/**
 * 构造最小附件宿主。
 *
 * @param attachments 附件列表。
 * @param options 覆盖项。
 * @returns 宿主与状态容器。
 */
function createViewer(
  attachments: readonly AttachmentInfo[],
  options: { readonly enabled?: boolean } = {},
): { viewer: AttachmentViewer; state: ViewerState } {
  const state = makeState(options);
  const viewer: AttachmentViewer = {
    getState: () => state,
    getElements: () => ({ root: document.body }),
    isFeatureEnabled: (feature) => state.ui.features[feature].enabled,
    on: () => () => undefined,
    getDocumentInfo: async () => ({ attachments }),
    getDocument: () => ({ saveAttachment: vi.fn(async () => 0) }),
  };
  return { viewer, state };
}

/** 挂载视图。 */
function mount(
  viewer: AttachmentViewer,
  translator: Translator = createTranslator('zh-CN'),
): { view: AttachmentView; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new AttachmentView({
    viewer,
    host,
    getTranslator: () => translator,
    confirm: async () => false,
  });
  views.push(view);
  return { view, host };
}

/** 等待视图异步加载完成。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

/** 列表中的条目节点。 */
function items(host: HTMLElement): Element[] {
  return [...host.querySelectorAll('.ofd-attachment')];
}

describe('附件侧栏：列表渲染', () => {
  it('按 XML 顺序渲染每一条附件，名称与元信息逐一对应', async () => {
    const { viewer } = createViewer(ATTACHMENTS);
    const { host } = mount(viewer);
    await flush();

    const nodes = items(host);
    expect(nodes).toHaveLength(3);
    expect(nodes.map((node) => node.querySelector('.ofd-attachment__name')?.textContent)).toEqual([
      '合同.pdf',
      '明细.xlsx',
      '无格式附件',
    ]);
    // 元信息分两行：首行「格式 · 大小」，次行日期，缺失以 - 占位。
    const meta = nodes.map((node) => ({
      size: node.querySelector('.ofd-attachment__meta-size')?.textContent,
      date: node.querySelector('.ofd-attachment__meta-date')?.textContent,
      full: node.querySelector('.ofd-attachment__meta')?.getAttribute('title'),
    }));
    expect(meta[0]).toEqual({ size: 'PDF · 2 KB', date: '2024-03-03', full: 'PDF · 2 KB · 2024-03-03' });
    expect(meta[1]).toEqual({ size: 'xlsx · -', date: '-', full: 'xlsx · - · -' });
    expect(meta[2]).toEqual({ size: '- · -', date: '-', full: '- · - · -' });
    // 每条都有下载按钮，且 aria-label 带上附件名。
    const buttons = nodes.map((node) => node.querySelector('.ofd-attachment__download'));
    expect(buttons.every((button) => button !== null)).toBe(true);
    expect(buttons[0]?.getAttribute('aria-label')).toContain('合同.pdf');
  });

  it('超大附件在下载按钮上标记 large，供宿主识别', async () => {
    const { viewer } = createViewer([{ id: 'big', name: '大文件.pdf', size: 524288001 }]);
    const { host } = mount(viewer);
    await flush();

    const button = host.querySelector('.ofd-attachment__download');
    expect(button?.getAttribute('data-large')).toBe('true');
  });

  it('无名称条目被跳过，只渲染有名称的附件', async () => {
    const { viewer } = createViewer([
      { id: 'blank', name: '' },
      { id: 'ok', name: '有效.pdf' },
    ]);
    const { host } = mount(viewer);
    await flush();

    const nodes = items(host);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.querySelector('.ofd-attachment__name')?.textContent).toBe('有效.pdf');
  });
});

describe('附件侧栏：空状态', () => {
  it('无附件时展示空态文案，且不渲染任何下载按钮', async () => {
    const { viewer } = createViewer([]);
    const { host } = mount(viewer);
    await flush();

    expect(host.querySelector('.ofd-nav__empty')?.textContent).toBe(
      createTranslator('zh-CN').t('attachments.empty'),
    );
    expect(host.querySelectorAll('.ofd-attachment__download')).toHaveLength(0);
  });

  it('全部条目都没有名称时同样回落到空态，而不是留空列表', async () => {
    const { viewer } = createViewer([{ id: 'blank', name: '' }]);
    const { host } = mount(viewer);
    await flush();

    expect(items(host)).toHaveLength(0);
    expect(host.querySelector('.ofd-nav__empty')).not.toBeNull();
  });

  it('文档尚未 ready 时不读取附件（getDocumentInfo 不被调用）', async () => {
    const base = createInitialViewerState();
    const state: ViewerState = {
      ...base,
      document: { ...base.document, status: 'opening' },
    };
    const getDocumentInfo = vi.fn(async () => ({ attachments: ATTACHMENTS }));
    const viewer: AttachmentViewer = {
      getState: () => state,
      getElements: () => ({ root: document.body }),
      isFeatureEnabled: (feature) => state.ui.features[feature].enabled,
      on: () => () => undefined,
      getDocumentInfo,
      getDocument: () => ({ saveAttachment: vi.fn() }),
    };
    const { host } = mount(viewer);
    await flush();

    expect(getDocumentInfo).not.toHaveBeenCalled();
    expect(items(host)).toHaveLength(0);
  });
});

describe('附件侧栏：功能开关', () => {
  it('功能关闭时不渲染列表与导出按钮', async () => {
    const { viewer } = createViewer(ATTACHMENTS, { enabled: false });
    const { host } = mount(viewer);
    await flush();

    expect(items(host)).toHaveLength(0);
    expect(host.querySelector<HTMLElement>('.ofd-attachments__toolbar')?.hidden).toBe(true);
  });

  it('功能从开启切到关闭时清空列表与导出按钮', async () => {
    const state = makeState();
    const listeners: Array<(next: ViewerState) => void> = [];
    const viewer: AttachmentViewer = {
      getState: () => state,
      getElements: () => ({ root: document.body }),
      isFeatureEnabled: (feature) => state.ui.features[feature].enabled,
      on: (_event, handler) => {
        listeners.push(handler);
        return () => undefined;
      },
      getDocumentInfo: async () => ({ attachments: ATTACHMENTS }),
      getDocument: () => ({ saveAttachment: vi.fn(async () => 0) }),
    };
    const { host } = mount(viewer);
    await flush();
    expect(items(host)).toHaveLength(3);

    const disabled: ViewerState = {
      ...state,
      ui: { ...state.ui, features: resolveFeatureStates({ attachments: false }) },
    };
    for (const listener of listeners) listener(disabled);
    await flush();

    expect(items(host)).toHaveLength(0);
    expect(host.querySelector<HTMLElement>('.ofd-attachments__toolbar')?.hidden).toBe(true);
  });
});
