/**
 * 附件侧栏端到端（真实 `OFDViewer` + 内置 UI 外壳）。
 *
 * 覆盖：附件面板在有附件时渲染卡片与勾选框、勾选后按钮切换为“下载选中”、
 * 文档 `Permissions/Export` 为 false 时禁用下载与导出、预览弹框挂到外壳对话框层。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  // 未覆盖的引擎导出保持真实实现，避免新特性读取到 undefined。
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { open: engineMocks.open },
    OFDError: class extends Error {},
    isOFDError: () => false,
    toOFDError: (error: unknown) => error,
  };
});

import type { AttachmentInfo } from '@ofdrw/ofdrw-viewer-engine';
import { getUIShell } from '../../src/ui';
import { getNavigationServices } from '../../src/views/nav';
import { ALLOW_ALL_PERMISSIONS } from '../helpers/document';
import { installDomEnvironment } from '../helpers/environment';
import { openViewer, type EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;

/** 三个附件：图片、文本、PDF。 */
const ATTACHMENTS: readonly AttachmentInfo[] = [
  { id: 'a1', name: '图.png', format: 'PNG', contentType: 'image/png' },
  { id: 'a2', name: '注.txt', format: 'TXT' },
  { id: 'a3', name: '合同.pdf', format: 'PDF' },
];

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/**
 * 打开阅读器并展开附件侧栏。
 *
 * @param documentOptions 额外的内存文档配置。
 * @returns 阅读器实例与外壳。
 */
async function openAttachments(documentOptions = {}) {
  const { viewer } = await openViewer(openMock, {
    pageCount: 1,
    attachments: ATTACHMENTS,
    attachmentContents: {
      a1: new Uint8Array([137, 80, 78, 71]),
      a2: new TextEncoder().encode('纯文本内容'),
    },
    ...documentOptions,
  });
  // 等待附件可用性写入与导航视图注册。
  await vi.waitFor(() => expect(viewer.getFeatureState('attachments').enabled).toBe(true));
  await vi.waitFor(() => expect(getNavigationServices(viewer)).toBeDefined());
  viewer.openSidebar('attachments');
  const view = getNavigationServices(viewer)!.attachments!;
  await vi.waitFor(() => expect(view.getAttachments()).toHaveLength(3));
  return { viewer, shell: getUIShell(viewer)! };
}

describe('附件侧栏端到端', () => {
  it('渲染三个卡片，含勾选框与按类型区分的图标', async () => {
    const { viewer, shell } = await openAttachments();
    const panel = shell.sidebar.getPanel('attachments')!;
    const cards = panel.querySelectorAll<HTMLElement>('.ofd-attachment');
    expect(cards).toHaveLength(3);
    expect(panel.querySelectorAll('.ofd-attachment__check')).toHaveLength(3);
    expect([...cards].map((card) => card.dataset.kind)).toEqual(['image', 'text', 'pdf']);
    viewer.destroy();
  });

  it('勾选两项后导出按钮切换为“下载选中的 2 个附件”', async () => {
    const { viewer, shell } = await openAttachments();
    const panel = shell.sidebar.getPanel('attachments')!;
    const checks = panel.querySelectorAll<HTMLInputElement>('.ofd-attachment__check');
    for (const index of [0, 2]) {
      const checkbox = checks[index] as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
    }
    await vi.waitFor(() =>
      expect(
        panel.querySelector('.ofd-attachments__export')?.getAttribute('aria-label'),
      ).toBe('下载选中的 2 个附件'),
    );
    expect(panel.querySelectorAll('.ofd-attachment[data-selected="true"]')).toHaveLength(2);
    viewer.destroy();
  });

  it('Export 权限为 false 时禁用下载与导出按钮', async () => {
    const { viewer, shell } = await openAttachments({
      permissions: { ...ALLOW_ALL_PERMISSIONS, export: false },
    });
    const panel = shell.sidebar.getPanel('attachments')!;
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>('.ofd-attachment__download')?.disabled).toBe(
        true,
      ),
    );
    expect(panel.querySelector<HTMLButtonElement>('.ofd-attachments__export')?.disabled).toBe(
      true,
    );
    viewer.destroy();
  });

  it('预览弹框挂到外壳对话框层，关闭后移除', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => undefined,
    });

    const { viewer, shell } = await openAttachments();
    const panel = shell.sidebar.getPanel('attachments')!;
    const previewButton = panel.querySelector<HTMLButtonElement>('.ofd-attachment__preview')!;
    expect(previewButton).not.toBeNull();
    previewButton.click();

    const dialogLayer = viewer.getElements().dialogLayer;
    await vi.waitFor(() =>
      expect(dialogLayer.querySelector('.ofd-attachment-preview')).not.toBeNull(),
    );
    const dialog = dialogLayer.querySelector<HTMLElement>('.ofd-attachment-preview')!;
    expect(dialog.querySelector('img')).not.toBeNull();

    (dialog.querySelector('.ofd-attachment-preview__close') as HTMLElement).click();
    await vi.waitFor(() =>
      expect(dialogLayer.querySelector('.ofd-attachment-preview')).toBeNull(),
    );
    viewer.destroy();
  });
});