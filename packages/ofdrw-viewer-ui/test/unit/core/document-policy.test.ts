/**
 * 文档声明在阅读器中的生效：`VPreferences` 初始视图、`Permissions` 入口门控。
 *
 * 引擎被替换为返回最小文档的替身，Document.xml 声明通过真实 ZIP 包字节提供，
 * 覆盖“声明 → 打开流程 → 视图/功能状态”的完整链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { PageInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { open: engineMocks.open },
    OFDError: class extends Error {},
    isOFDError: () => false,
    toOFDError: (error: unknown) => error,
  };
});

import { OFDViewer } from '../../../src/viewer';
import { isFeatureDisabledError } from '../../../src/errors';

/** 构造 2 页的引擎文档替身。 */
function makeDocument(): unknown {
  const infos: PageInfo[] = [
    { index: 0, widthMm: 210, heightMm: 297 },
    { index: 1, widthMm: 210, heightMm: 297 },
  ];
  return {
    pageCount: 2,
    getPageInfos: async () => infos,
    getPage: async (index: number) => ({
      index,
      getSize: () => ({ width: 210, height: 297 }),
      getViewport: () => ({ width: 794, height: 1123 }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => ({ items: [], chars: [] }),
      exportImage: async () => {
        throw new Error('not implemented');
      },
    }),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount: 2, title: '合同标题' }),
    getPermissions: async () => ({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    }),
    getSignatureEntries: async () => [],
    getSignedValue: async () => undefined,
    close: async () => undefined,
  };
}

/** 生成带 `Document.xml` 声明的最小 OFD 包。 */
function buildOfd(document: string): ArrayBuffer {
  const bytes = zipSync({
    'OFD.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.0" DocType="OFD">' +
        '<ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>',
    ),
    'Doc_0/Document.xml': strToU8(document),
  });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 以 Document 根包裹声明片段。 */
function documentXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">
  ${inner}
</ofd:Document>`;
}

/** 创建阅读器。 */
function createViewer(source: ArrayBuffer): OFDViewer {
  return new OFDViewer({
    crypto: { enabled: false },
    container: document.body,
    source,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => makeDocument());
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

describe('VPreferences 生效', () => {
  it('ZoomMode=FitWidth 时初始缩放切换为适合宽度', async () => {
    const viewer = createViewer(
      buildOfd(documentXml('<VPreferences><ZoomMode>FitWidth</ZoomMode></VPreferences>')),
    );
    await viewer.ready;
    // 默认 initialScale='auto'（等同适合宽度），显式声明后模式落在 page-width。
    expect(viewer.getState().view.zoomMode).toBe('page-width');
    expect(viewer.getState().document.policy?.viewPreferencesApplied).toBe(true);
    await viewer.destroy();
  });

  it('Zoom 固定倍率在 ZoomMode=Default 时生效', async () => {
    const viewer = createViewer(
      buildOfd(
        documentXml('<VPreferences><ZoomMode>Default</ZoomMode><Zoom>1.5</Zoom></VPreferences>'),
      ),
    );
    await viewer.ready;
    expect(viewer.getState().view.scale).toBeCloseTo(1.5, 2);
    await viewer.destroy();
  });

  it('PageMode=UseOutlines 自动打开大纲侧栏', async () => {
    const viewer = createViewer(
      buildOfd(documentXml('<VPreferences><PageMode>UseOutlines</PageMode></VPreferences>')),
    );
    await viewer.ready;
    expect(viewer.getState().view.sidebarView).toBe('outline');
    await viewer.destroy();
  });

  it('HideToolbar 隐藏工具栏，HideWindowUI 隐藏对话框层', async () => {
    const viewer = createViewer(
      buildOfd(
        documentXml(
          '<VPreferences><HideToolbar>true</HideToolbar><HideWindowUI>true</HideWindowUI></VPreferences>',
        ),
      ),
    );
    await viewer.ready;
    expect(viewer.getState().document.policy?.hideToolbar).toBe(true);
    expect(viewer.getElements().toolbar.hidden).toBe(true);
    expect(viewer.getElements().dialogLayer.hidden).toBe(true);
    await viewer.destroy();
  });

  it('TabDisplay=DocTitle 且有标题时采用文档标题', async () => {
    const viewer = createViewer(
      buildOfd(documentXml('<VPreferences><TabDisplay>DocTitle</TabDisplay></VPreferences>')),
    );
    await viewer.ready;
    // 元数据异步读取完成后写入 aria-label。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewer.getRoot().getAttribute('aria-label')).toBe('合同标题');
    await viewer.destroy();
  });

  it('内存来源的声明照常生效（可安全复用）', async () => {
    // 随机读源与引擎容器共享同一个字节源实例、再次打开容器会改变其可读状态，
    // 因此阅读器只为内存来源与加密路径读取声明；内存来源可安全复用。
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: buildOfd(
        documentXml('<VPreferences><PageMode>UseOutlines</PageMode></VPreferences>'),
      ),
    });
    await viewer.ready;
    // 内存 ArrayBuffer 来源属于可安全复用的来源，声明照常生效。
    expect(viewer.getState().view.sidebarView).toBe('outline');
    await viewer.destroy();
  });

  it('宿主关闭 documentPolicy.viewPreferences 时按宿主配置', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: buildOfd(
        documentXml('<VPreferences><PageMode>UseOutlines</PageMode></VPreferences>'),
      ),
      documentPolicy: { viewPreferences: false },
    });
    await viewer.ready;
    expect(viewer.getState().view.sidebarView).toBeNull();
    expect(viewer.getState().document.policy?.viewPreferencesApplied).toBe(false);
    await viewer.destroy();
  });

  it('没有 VPreferences 时保持宿主默认视图', async () => {
    const viewer = createViewer(buildOfd(documentXml('<Pages></Pages>')));
    await viewer.ready;
    expect(viewer.getState().view.sidebarView).toBeNull();
    expect(viewer.getState().view.zoomMode).toBe('auto');
    await viewer.destroy();
  });
});

describe('Permissions 生效', () => {
  it('Print@Copies=0 时打印功能按文档关闭', async () => {
    const viewer = createViewer(
      buildOfd(documentXml('<Permissions><Print Printable="true" Copies="0"/></Permissions>')),
    );
    await viewer.ready;
    expect(viewer.getState().document.policy?.printBlocked).toBe(true);
    expect(viewer.getFeatureState('print').enabled).toBe(false);
    await expect(viewer.print()).rejects.toSatisfy((error: unknown) =>
      isFeatureDisabledError(error, 'print'),
    );
    await viewer.destroy();
  });

  it('PrintScreen=false 时复制文本被拒绝，选区与查找功能关闭', async () => {
    const viewer = createViewer(
      buildOfd(documentXml('<Permissions><PrintScreen>false</PrintScreen></Permissions>')),
    );
    await viewer.ready;
    expect(viewer.getFeatureState('selection').enabled).toBe(false);
    expect(viewer.getFeatureState('find').enabled).toBe(false);
    expect(viewer.getState().document.policy?.allowCopy).toBe(false);
    await expect(viewer.copySelection()).rejects.toSatisfy((error: unknown) =>
      isFeatureDisabledError(error, 'selection'),
    );
    await viewer.destroy();
  });

  it('Signature=false 时验证功能关闭；Watermark=false 只记录不门控入口', async () => {
    const viewer = createViewer(
      buildOfd(
        documentXml(
          '<Permissions><Signature>false</Signature><Watermark>false</Watermark></Permissions>',
        ),
      ),
    );
    await viewer.ready;
    expect(viewer.getState().document.policy?.allowSignature).toBe(false);
    expect(viewer.getState().document.policy?.allowWatermark).toBe(false);
    expect(viewer.getFeatureState('verification').enabled).toBe(false);
    await viewer.destroy();
  });

  it('Export=false 时导出功能按文档关闭', async () => {
    const viewer = createViewer(
      buildOfd(documentXml('<Permissions><Export>false</Export></Permissions>')),
    );
    await viewer.ready;
    expect(viewer.getFeatureState('export').enabled).toBe(false);
    expect(viewer.getFeatureState('export').reason).toBe('document');
    await viewer.destroy();
  });

  it('宿主关闭 documentPolicy.permissions 时不门控入口', async () => {
    const viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: buildOfd(
        documentXml('<Permissions><PrintScreen>false</PrintScreen><Print Copies="0"/></Permissions>'),
      ),
      documentPolicy: { permissions: false },
    });
    await viewer.ready;
    expect(viewer.getFeatureState('print').enabled).toBe(true);
    expect(viewer.getFeatureState('selection').enabled).toBe(true);
    expect(viewer.getState().document.policy?.printBlocked).toBe(false);
    expect(viewer.getState().document.policy?.allowCopy).toBe(true);
    await viewer.destroy();
  });

  it('没有 Permissions 节点时全部入口可用', async () => {
    const viewer = createViewer(buildOfd(documentXml('<Pages></Pages>')));
    await viewer.ready;
    expect(viewer.getFeatureState('print').enabled).toBe(true);
    expect(viewer.getFeatureState('selection').enabled).toBe(true);
    expect(viewer.getState().document.policy?.expired).toBe(false);
    await viewer.destroy();
  });
});
