/**
 * 签章服务集成测试（使用真实 OFDViewer + 假引擎文档）。
 *
 * 覆盖：side-effect 注册、按页分组列表、StampAnnot 覆盖层定位/裁剪、
 * 点击打开详情、SignedValue.dat 缺失/损坏降级、features 门控、不读取 Seal.esl。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PageInfo,
  SignatureEntryInfo,
  SignedValueFile,
} from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { OFDViewer } from '../../../src/viewer';
import { attachUIShell, getUIShell } from '../../../src/ui';
import '../../../src/views/signatures';
import {
  corruptSignedValue,
  readSignedValueFixture,
} from './fixtures';

/** 页尺寸；A4。 */
const PAGE_INFOS: PageInfo[] = [
  { index: 0, widthMm: 210, heightMm: 297 },
  { index: 1, widthMm: 210, heightMm: 297 },
];

/** 签章 XML 摘要：v4、v5 多戳记、缺签名值、损坏签名值。 */
const SIGNATURE_ENTRIES: readonly SignatureEntryInfo[] = [
  {
    id: 's1',
    type: 'Seal',
    baseLoc: '/Doc_0/Signs/S1/Signature.xml',
    provider: { name: 'provider-a', company: 'company-a', version: '1.0' },
    signatureDateTime: '2026-01-02 03:04:05',
    references: [{ fileRef: '/Doc_0/Document.xml' }],
    stamps: [
      {
        id: 'stamp-1',
        pageId: '1',
        pageIndex: 0,
        boundary: { x: 10, y: 20, w: 40, h: 30 },
        clip: { x: 2, y: 3, w: 20, h: 15 },
      },
    ],
    signedValuePath: '/Doc_0/Signs/S1/SignedValue.dat',
    hasSignedValue: true,
  },
  {
    id: 's2',
    type: 'Sign',
    baseLoc: '/Doc_0/Signs/S2/Signature.xml',
    signatureDateTime: '2026-02-03 04:05:06',
    references: [{ fileRef: '/Doc_0/Document.xml' }],
    stamps: [
      {
        id: 'stamp-2a',
        pageId: '1',
        pageIndex: 0,
        boundary: { x: 60, y: 80, w: 30, h: 20 },
      },
      {
        id: 'stamp-2b',
        pageId: '2',
        pageIndex: 1,
        boundary: { x: 5, y: 6, w: 10, h: 10 },
      },
    ],
    signedValuePath: '/Doc_0/Signs/S2/SignedValue.dat',
    hasSignedValue: true,
  },
  {
    id: 's3',
    type: 'Seal',
    baseLoc: '/Doc_0/Signs/S3/Signature.xml',
    references: [],
    stamps: [],
    hasSignedValue: false,
  },
  {
    id: 's4',
    type: 'Seal',
    baseLoc: '/Doc_0/Signs/S4/Signature.xml',
    references: [],
    stamps: [
      {
        id: 'stamp-4',
        pageId: '1',
        pageIndex: 0,
        boundary: { x: 1, y: 1, w: 5, h: 5 },
      },
    ],
    signedValuePath: '/Doc_0/Signs/S4/SignedValue.dat',
    hasSignedValue: true,
  },
];

/** 引擎页最小实现。 */
function makePage(index: number): {
  index: number;
  getSize: () => { width: number; height: number };
  getViewport: (options?: { dpi?: number }) => { width: number; height: number; dpi: number };
  render: () => { promise: Promise<void>; cancel: () => void };
} {
  return {
    index,
    getSize: () => ({ width: 210, height: 297 }),
    getViewport: (options = {}) => {
      const dpi = options.dpi ?? 96;
      return {
        width: Math.ceil((210 / 25.4) * dpi),
        height: Math.ceil((297 / 25.4) * dpi),
        dpi,
      };
    },
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  };
}

/** 假引擎文档。 */
function makeDocument() {
  const signedValues = new Map<string, Uint8Array>([
    ['s1', readSignedValueFixture('SignedValueV4.dat')],
    ['s2', readSignedValueFixture('SignedValueV5.dat')],
    ['s4', corruptSignedValue()],
  ]);
  return {
    pageCount: 2,
    getPageInfos: async () => PAGE_INFOS,
    getPage: async (index: number) => makePage(index),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({ version: '1.0', pageCount: 2 }),
    getPermissions: async () => ({
      edit: true,
      annot: true,
      export: true,
      signature: true,
      watermark: true,
      printScreen: true,
    }),
    getSignatureEntries: async () => SIGNATURE_ENTRIES,
    getSignedValue: async (signatureId: string): Promise<SignedValueFile | undefined> => {
      const data = signedValues.get(signatureId);
      if (!data) return undefined;
      return {
        signatureId,
        path: `/Doc_0/Signs/${signatureId}/SignedValue.dat`,
        data: Uint8Array.from(data),
        byteLength: data.byteLength,
      };
    },
    close: async () => undefined,
  };
}

let viewer: OFDViewer | null = null;
let currentDocument: ReturnType<typeof makeDocument>;

beforeEach(() => {
  document.body.innerHTML = '';
  currentDocument = makeDocument();
  engineMocks.open.mockReset();
  engineMocks.open.mockImplementation(async () => currentDocument);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

afterEach(() => {
  viewer?.destroy();
  viewer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 创建并等待阅读器打开、摘要加载完成。 */
async function createViewer(): Promise<OFDViewer> {
  const instance = new OFDViewer({
      crypto: { enabled: false },
    container: document.body,
    source: new ArrayBuffer(8),
    initialScale: 1,
  });
  await instance.ready;
  await vi.waitFor(() => expect(instance.getSignatures()).toHaveLength(4));
  return instance;
}

describe('SignatureService 覆盖层与详情', () => {
  it('side-effect 注册签章服务，覆盖层按 Boundary/Clip（mm→px）定位', async () => {
    viewer = await createViewer();
    viewer.setScale(1);

    await vi.waitFor(() => {
      expect(document.querySelectorAll('.ofd-signature-box')).toHaveLength(4);
    });
    const box = document.querySelector<HTMLButtonElement>(
      '.ofd-signature-box[data-signature-id="s1"]',
    );
    expect(box).not.toBeNull();
    expect(box!.parentElement?.classList.contains('ofd-page__signature-layer')).toBe(true);
    expect(box!.dataset.pageNumber).toBe('1');
    expect(Number.parseFloat(box!.style.left)).toBeCloseTo((10 * 96) / 25.4, 2);
    expect(Number.parseFloat(box!.style.top)).toBeCloseTo((20 * 96) / 25.4, 2);
    expect(Number.parseFloat(box!.style.width)).toBeCloseTo((40 * 96) / 25.4, 2);
    expect(Number.parseFloat(box!.style.height)).toBeCloseTo((30 * 96) / 25.4, 2);
    expect(box!.style.clipPath).toContain('inset(');

    box!.click();
    await vi.waitFor(() => {
      const dialog = document.querySelector('.ofd-dialog');
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain('未验证');
      expect(dialog!.textContent).toContain('OFD R&W 测试用印章');
      expect(dialog!.textContent).toContain('Test Certificate');
      expect(dialog!.textContent).toContain('本面板仅展示签章信息，未进行签名验证/证书链校验。');
    });
    const dialog = document.querySelector('.ofd-dialog')!;
    expect(dialog.textContent).not.toContain('验签通过');
    expect(dialog.textContent).not.toContain('签名有效');

    const detail = await viewer.getSignatureDetail('s1');
    expect(detail.seal?.name).toBe('OFD R&W 测试用印章');
    expect(detail.signer?.certificate?.subjectAttributes?.cn).toBe('Test Certificate');
    expect(detail.validation).toEqual({
      status: 'not-verified',
      note: '本面板仅展示签章信息，未进行签名验证/证书链校验。',
    });
  });

  it('SignedValue.dat 缺失/损坏时条目仍展示，详情降级为“签章信息不完整”', async () => {
    viewer = await createViewer();

    const missing = await viewer.getSignatureDetail('s3');
    expect(missing.entry.id).toBe('s3');
    expect(missing.seal).toBeUndefined();
    expect(missing.signer?.signedAt).toBeUndefined();
    expect(missing.validation.status).toBe('not-verified');
    expect(missing.warnings?.map((warning) => warning.code)).toContain(
      'W_SIGNATURE_RESOURCE',
    );
    expect(missing.warnings?.[0]?.message).toContain('缺少签名值文件');

    const corrupt = await viewer.getSignatureDetail('s4');
    expect(corrupt.warnings?.map((warning) => warning.code)).toContain(
      'W_SIGNATURE_ASN1',
    );
    expect(corrupt.warnings?.[0]?.message).toContain('签章信息不完整');

    const valid = await viewer.getSignatureDetail('s2');
    expect(valid.seal?.version).toBe('v5');
    expect(valid.signer?.signedAt).toBe('2026-04-24T08:53:26.000Z');
  });

  it('features.signatures=false 时覆盖层清空、方法抛 OFD_FEATURE_DISABLED', async () => {
    viewer = await createViewer();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.ofd-signature-box')).toHaveLength(4);
    });

    viewer.setFeatures({ signatures: false });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.ofd-signature-box')).toHaveLength(0);
    });
    await expect(viewer.getSignatureDetail('s1')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'signatures',
    });
    await expect(viewer.showSignature('s1')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'signatures',
    });

    viewer.setFeatures({ signatures: true });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.ofd-signature-box')).toHaveLength(4);
    });
  });

  it('不读取 Seal.esl、不暴露 getSealFile', async () => {
    viewer = await createViewer();
    await viewer.getSignatureDetail('s1');
    expect('getSealFile' in currentDocument).toBe(false);
    expect('getSeal' in currentDocument).toBe(false);
  });
});

describe('SignatureService 侧栏列表', () => {
  it('按页分组显示类型/时间/签章者 CN/页码，并带“未验证”徽标', async () => {
    viewer = await createViewer();
    const detachShell = attachUIShell(viewer);
    try {
      viewer.openSidebar('signatures');
      const shell = getUIShell(viewer);
      expect(shell).toBeDefined();
      const panel = shell!.getSidebarPanel('signatures');
      expect(panel).not.toBeNull();

      await vi.waitFor(() => {
        const items = panel!.querySelectorAll('.ofd-signature-summary-item');
        expect(items).toHaveLength(5);
      });
      const headings = [...panel!.querySelectorAll('.ofd-signature-group-title')].map(
        (element) => element.textContent,
      );
      expect(headings).toEqual(['第 1 页', '第 2 页', '未定位页面']);
      const badges = [...panel!.querySelectorAll('.ofd-signature-badge')].map(
        (element) => element.textContent,
      );
      expect(badges).toEqual(['未验证', '未验证', '未验证', '未验证', '未验证']);

      await vi.waitFor(() => {
        expect(panel!.textContent).toContain('OFD R&W 测试用印章');
        expect(panel!.textContent).toContain('Test Certificate');
      });
      expect(panel!.textContent).toContain('盖章');
      expect(panel!.textContent).toContain('签名');
      expect(panel!.textContent).toContain('第 2 页');

      const first = panel!.querySelector<HTMLButtonElement>(
        '.ofd-signature-summary-item[data-signature-id="s1"]',
      );
      first!.click();
      await vi.waitFor(() => {
        const dialog = document.querySelector('.ofd-dialog');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain('签章信息（未验证）');
        expect(dialog!.textContent).toContain('印章名称');
      });
    } finally {
      detachShell();
    }
  });
});