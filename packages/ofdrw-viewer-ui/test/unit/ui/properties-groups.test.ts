/**
 * 文档属性对话框分组展示（设计方案 §6.3）。
 *
 * 覆盖：六个分组的出现顺序、分组内全空时隐藏、DocumentHeader 数组字段多路径
 * 展示、附件清单只读展示、快照不可用时退回状态内字段、文案随语言切换。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialViewerState } from '../../../src/state';
import type { ViewerState } from '../../../src/state';
import type { ViewerDocumentInfo } from '../../../src/types';
import { attachUIShell, getUIShell } from '../../../src/ui';
import type { UIShellHost } from '../../../src/ui';
import { cleanupShells, createRoot } from './helpers';

afterEach(() => {
  cleanupShells();
});

interface PropertiesHost extends UIShellHost {
  setState(next: ViewerState): void;
  emit(event: string): void;
}

/**
 * 创建带 `getDocumentInfo()` 的最小宿主。
 *
 * @param state 初始状态。
 * @param info 文档信息快照；undefined 表示读取失败。
 * @returns 宿主。
 */
function createPropertiesHost(
  state: ViewerState = createInitialViewerState(),
  info: ViewerDocumentInfo | undefined = undefined,
): PropertiesHost {
  const root = createRoot(1280);
  const toolbar = document.createElement('div');
  toolbar.className = 'ofd-viewer__toolbar';
  const body = document.createElement('div');
  body.className = 'ofd-viewer__body';
  const sidebar = document.createElement('div');
  sidebar.className = 'ofd-viewer__sidebar';
  const mask = document.createElement('div');
  mask.className = 'ofd-viewer__sidebar-mask';
  const main = document.createElement('div');
  main.className = 'ofd-viewer__main';
  const findbar = document.createElement('div');
  findbar.className = 'ofd-viewer__findbar';
  body.append(sidebar, mask, main, findbar);
  const dialogLayer = document.createElement('div');
  dialogLayer.className = 'ofd-viewer__dialog-layer';
  const toastLayer = document.createElement('div');
  toastLayer.className = 'ofd-viewer__toast-layer';
  root.append(toolbar, body, dialogLayer, toastLayer);

  let current: ViewerState = {
    ...state,
    document: { ...state.document, pageCount: 2, status: 'ready' },
  };
  const snapshot = info;
  const handlers = new Map<string, Set<() => void>>();

  return {
    getElements: () => ({
      root,
      toolbar,
      body,
      sidebar,
      sidebarMask: mask,
      main,
      findbar,
      dialogLayer,
      toastLayer,
    }),
    getState: () => current,
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      const stored = handler as unknown as () => void;
      set.add(stored);
      return () => set?.delete(stored);
    },
    emit(event) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    setState(next) {
      current = next;
    },
    getDocumentInfo: async () => {
      if (!snapshot) throw new Error('读取失败');
      return snapshot;
    },
    toggleSidebar() {
      return undefined;
    },
    openSidebar() {
      return undefined;
    },
    closeSidebar() {
      return undefined;
    },
    goToPage() {
      return undefined;
    },
    nextPage() {
      return undefined;
    },
    previousPage() {
      return undefined;
    },
    zoomIn() {
      return undefined;
    },
    zoomOut() {
      return undefined;
    },
    setScale() {
      return undefined;
    },
    setZoomMode() {
      return undefined;
    },
    rotateClockwise() {
      return undefined;
    },
    find() {
      return undefined;
    },
    findNext() {
      return undefined;
    },
    findPrevious() {
      return undefined;
    },
    clearFind() {
      return undefined;
    },
    print() {
      return undefined;
    },
    exportImage() {
      return undefined;
    },
    exportImages() {
      return undefined;
    },
    exportOfd() {
      return undefined;
    },
    setFullscreen() {
      return undefined;
    },
  };
}

/**
 * 点击工具栏“文档属性”并等待异步快照渲染完成。
 *
 * @param host 宿主。
 * @returns 属性对话框元素。
 */
async function openProperties(host: PropertiesHost): Promise<HTMLElement> {
  const shell = getUIShell(host)!;
  const button = shell.elements.toolbar.querySelector<HTMLButtonElement>(
    '[data-ofd-control="document-properties"]',
  );
  expect(button).not.toBeNull();
  button!.click();
  // 属性对话框先发起 getDocumentInfo()，resolve 后才 openDialog()。
  await Promise.resolve();
  await Promise.resolve();
  expect(shell.dialogs.currentName).toBe('documentProperties');
  const dialog = shell.elements.dialogLayer.querySelector<HTMLElement>('.ofd-dialog');
  expect(dialog).not.toBeNull();
  return dialog!;
}

/**
 * 读取对话框内分组标题顺序。
 *
 * @param dialog 对话框元素。
 * @returns 标题文本数组。
 */
function groupTitles(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll('.ofd-properties__heading')].map(
    (node) => node.textContent ?? '',
  );
}

/**
 * 构造含全部新字段的元数据快照。
 *
 * @returns 文档信息快照。
 */
function fullSnapshot(): ViewerDocumentInfo {
  return {
    metadata: {
      version: '1.0',
      pageCount: 2,
      packageSize: 20480,
      title: '测试合同',
      author: '张三',
      subject: '主题',
      abstract: '摘要文本',
      keywords: ['合同', '测试'],
      creationDate: '2024-01-01',
      modDate: '2024-02-02',
      creator: 'OFD 工具',
      creatorVersion: '3.1',
      docId: 'doc-1',
      docUsage: 'Normal',
      docType: 'OFD',
      documentHeader: {
        docId: 'doc-header',
        version: '1.0',
        maxUnitId: 42,
        pageArea: {
          physicalBox: { x: 0, y: 0, w: 210, h: 297 },
          applicationBox: { x: 10, y: 10, w: 190, h: 277 },
          bleedBox: { x: 0, y: 0, w: 220, h: 307 },
        },
        publicRes: ['Res/PublicRes.xml', 'Res/OtherPublicRes.xml'],
        documentRes: ['Res/DocumentRes.xml'],
        templatePageRes: ['Res/Template.xml'],
        defaultCs: 'cs-default',
      },
      packageInfo: { docRoot: 'Doc_0', maxUnitId: 99, docBodyCount: 1 },
      commonData: {
        pageArea: { physicalBox: { x: 0, y: 0, w: 210, h: 297 } },
        defaultColorSpaceId: 'cs-common',
        documentVersion: '1.0',
        dataDir: 'Data',
      },
    },
    pageCount: 2,
    pageInfos: [
      { index: 0, widthMm: 210, heightMm: 297 },
      { index: 1, widthMm: 210, heightMm: 297 },
    ],
    permissions: {
      edit: true,
      annot: false,
      export: true,
      signature: true,
      watermark: false,
      printScreen: true,
      print: { printable: true, copies: 3 },
    },
    attachments: [
      { id: 'a1', name: '说明.pdf', format: 'PDF', size: 2048, modDate: '2024-03-03' },
      { id: 'a2', name: '图片.png', format: 'PNG' },
    ],
    signatureCount: 1,
    outlineCount: 4,
    bookmarkCount: 2,
  };
}

describe('文档属性对话框分组', () => {
  it('按设计顺序展示六个分组', async () => {
    const host = createPropertiesHost(createInitialViewerState(), fullSnapshot());
    const dispose = attachUIShell(host);
    const dialog = await openProperties(host);
    expect(groupTitles(dialog)).toEqual([
      '文档属性',
      '包信息',
      '页面设置',
      '颜色与资源',
      '安全与结构',
      '附件清单',
    ]);
    dispose();
  });

  it('新字段值正确展示，资源路径按多行拆分', async () => {
    const host = createPropertiesHost(createInitialViewerState(), fullSnapshot());
    const dispose = attachUIShell(host);
    const dialog = await openProperties(host);
    const text = dialog.textContent ?? '';

    expect(text).toContain('文档类型');
    expect(text).toContain('OFD');
    expect(text).toContain('文档用途');
    expect(text).toContain('Normal');
    expect(text).toContain('摘要文本');
    expect(text).toContain('创建工具版本');
    expect(text).toContain('Doc_0');
    expect(text).toContain('文档体数量');
    expect(text).toContain('210 × 297 mm');
    expect(text).toContain('cs-default');
    expect(text).toContain('数据目录');
    expect(text).toContain('Data');
    expect(text).toContain('不允许');
    expect(text).toContain('说明.pdf');
    expect(text).toContain('PDF');

    const values = [...dialog.querySelectorAll('.ofd-properties dd')].map(
      (node) => node.textContent ?? '',
    );
    const publicRes = values.find((value) => value.includes('PublicRes.xml'));
    // 多路径按换行拼接，由 CSS pre-line 渲染成多行。
    expect(publicRes).toBe('Res/PublicRes.xml\nRes/OtherPublicRes.xml');
    dispose();
  });

  it('分组内全部字段缺失时隐藏该分组', async () => {
    const minimal: ViewerDocumentInfo = {
      metadata: { version: '1.0', pageCount: 1, title: '仅标题' },
      pageCount: 1,
      pageInfos: [{ index: 0, widthMm: 210, heightMm: 297 }],
      permissions: {
        edit: true,
        annot: true,
        export: true,
        signature: true,
        watermark: true,
        printScreen: true,
      },
      attachments: [],
      signatureCount: 0,
      outlineCount: 0,
      bookmarkCount: 0,
    };
    const host = createPropertiesHost(createInitialViewerState(), minimal);
    const dispose = attachUIShell(host);
    const dialog = await openProperties(host);
    const titles = groupTitles(dialog);
    // 文档属性与包信息必有内容（标题/版本/页数）；页面区、资源、附件清单隐藏。
    expect(titles).toContain('文档属性');
    expect(titles).toContain('包信息');
    expect(titles).not.toContain('页面设置');
    expect(titles).not.toContain('颜色与资源');
    expect(titles).not.toContain('附件清单');
    dispose();
  });

  it('快照读取失败时退回状态内字段，不阻断对话框', async () => {
    const state = createInitialViewerState();
    const host = createPropertiesHost(
      {
        ...state,
        document: {
          ...state.document,
          pageCount: 1,
          status: 'ready',
          metadata: { version: '1.0', pageCount: 1, title: '状态内标题' },
        },
      },
      undefined,
    );
    const dispose = attachUIShell(host);
    const dialog = await openProperties(host);
    expect(dialog.textContent).toContain('状态内标题');
    expect(dialog.textContent).toContain('1.0');
    dispose();
  });

  it('英文界面下分组标题走 i18n', async () => {
    const state = createInitialViewerState();
    const host = createPropertiesHost(
      { ...state, ui: { ...state.ui, locale: 'en-US' } },
      fullSnapshot(),
    );
    const dispose = attachUIShell(host);
    const dialog = await openProperties(host);
    expect(groupTitles(dialog)).toContain('Document properties');
    expect(groupTitles(dialog)).toContain('Package information');
    expect(dialog.textContent).toContain('Allowed');
    expect(dialog.textContent).toContain('Not allowed');
    dispose();
  });
});
