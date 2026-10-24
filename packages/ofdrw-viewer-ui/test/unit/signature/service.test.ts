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
import type { VerificationReport } from '@ofdrw/ofdrw-viewer-crypto';

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
import { VERIFICATION_RESET_EVENT } from '../../../src/crypto/service';
import { captureDownloads } from '../../helpers/environment';
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
      expect(dialog!.textContent).toContain('根证书链验证');
      expect(dialog!.textContent).toContain('证书链结果独立展示，不影响签名/完整性验证结果。');
      expect(dialog!.textContent).toContain('未验证：尚未生成验证报告，证书链未校验。');
      const trustTag = dialog!.querySelector<HTMLElement>(
        '[data-ofd-control="signature-trust-tag"]',
      );
      expect(trustTag?.dataset.trust).toBe('unknown');
      expect(trustTag?.textContent).toBe('可信状态未知');
      expect(dialog!.textContent).not.toContain('证书链通过');
    });
    const dialog = document.querySelector('.ofd-dialog')!;
    expect(dialog.textContent).not.toContain('验签通过');
    expect(dialog.textContent).not.toContain('签名有效');

    const detail = await viewer.getSignatureDetail('s1');
    expect(detail.seal?.name).toBe('OFD R&W 测试用印章');
    expect(detail.seal?.image?.data?.byteLength).toBeGreaterThan(0);
    expect(detail.signer?.certificate?.subjectAttributes?.cn).toBe('Test Certificate');
    expect(detail.validation).toEqual({
      status: 'not-verified',
      note: '本面板仅展示签章信息，未进行签名验证/证书链校验。',
    });
  });

  it('详情：链可信时签章者显示“可信”，签发时间与根证书链验证栏来自验证报告', async () => {
    viewer = await createViewer();
    const report = {
      overall: 'valid',
      package: {
        ofdVersion: '1.0',
        encrypted: false,
        decrypted: false,
        packageSize: 128,
        entryCount: 9,
        signatureCount: 1,
        integrityPresent: false,
      },
      integrity: null,
      signatures: [
        {
          id: 's1',
          type: 'Seal',
          version: 'v4',
          baseLoc: 'Doc_0/Signs/Signatures.xml',
          status: 'valid',
          signature: { status: 'valid' },
          dataHash: { status: 'valid' },
          references: { status: 'valid', total: 1, checked: 1, failures: [] },
          signingTime: '2026-10-23T07:59:26.000Z',
          signingTimeSource: 'time-info',
          certificate: {
            status: 'valid',
            trustRootConfigured: true,
            signer: {
              subject: 'CN=Test Certificate,O=ofdrw,C=CN',
              issuer: 'CN=Root CA,O=ofdrw,C=CN',
              serialNumber: '01',
              notBefore: '2026-01-01T00:00:00Z',
              notAfter: '2027-01-01T00:00:00Z',
              fingerprintSha256: 'a'.repeat(64),
              isCA: false,
            },
            trustAnchor: {
              subject: 'CN=Root CA,O=ofdrw,C=CN',
              issuer: 'CN=Root CA,O=ofdrw,C=CN',
              serialNumber: '02',
              notBefore: '2025-01-01T00:00:00Z',
              notAfter: '2030-01-01T00:00:00Z',
              fingerprintSha256: 'b'.repeat(64),
              isCA: true,
            },
            chain: [
              {
                subject: 'CN=Test Certificate,O=ofdrw,C=CN',
                issuer: 'CN=Root CA,O=ofdrw,C=CN',
                serialNumber: '01',
                notBefore: '2026-01-01T00:00:00Z',
                notAfter: '2027-01-01T00:00:00Z',
                fingerprintSha256: 'a'.repeat(64),
                isCA: false,
              },
            ],
            currentTime: '2026-10-24T00:00:00Z',
            revocation: 'not-checked',
            issues: [],
          },
          seal: { status: 'valid', esId: 'seal-1', name: '测试印章' },
          timestamp: {
            status: 'parsed-not-verified',
            tokenPresent: true,
            tokenLength: 64,
            genTime: '2026-10-23T07:59:26.000Z',
            note: '已解析，未验证',
          },
          issues: [],
        },
      ],
      rootsConfigured: true,
      warnings: [],
      startedAt: '2026-10-24T00:00:00Z',
      durationMs: 8,
    } as unknown as VerificationReport;
    vi.spyOn(viewer, 'isFeatureEnabled').mockReturnValue(true);
    vi.spyOn(viewer, 'getVerificationReport').mockReturnValue(report);
    const capture = captureDownloads();
    try {
      await viewer.showSignature('s1');
      await vi.waitFor(() => {
        const dialog = document.querySelector<HTMLElement>('.ofd-dialog');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain('根证书链验证');
      });
      const dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
      expect(dialog.textContent).toContain('签发时间');
      expect(dialog.textContent).toContain('2026-10-23 15:59:26');
      const tag = dialog.querySelector<HTMLElement>('[data-ofd-control="signature-trust-tag"]')!;
      expect(tag.dataset.trust).toBe('trusted');
      expect(tag.textContent).toBe('可信');
      const chain = dialog.querySelector<HTMLElement>('[data-ofd-control="signature-chain-section"]')!;
      expect(chain.textContent).toContain('链状态');
      expect(chain.textContent).toContain('有效');
      expect(chain.textContent).toContain('是否配置信任根');
      expect(chain.textContent).toContain('是');
      expect(chain.textContent).toContain('CN=Test Certificate');
      expect(chain.textContent).toContain('CN=Root CA');
      expect(chain.textContent).toContain('a'.repeat(64));
      expect(dialog.textContent).not.toContain('证书链通过');

      const download = dialog.querySelector<HTMLButtonElement>(
        '[data-ofd-control="signature-signer-cert-download"]',
      );
      expect(download).not.toBeNull();
      download!.click();
      await vi.waitFor(() => expect(capture.downloads).toHaveLength(1));
      expect(capture.downloads[0]!.filename).toMatch(/\.der$/);
      expect(capture.downloads[0]!.filename).toContain('Test Certificate');
      expect(capture.downloads[0]!.blob?.type).toBe('application/pkix-cert');
      expect((await capture.downloads[0]!.blob!.arrayBuffer()).byteLength).toBeGreaterThan(0);
    } finally {
      capture.restore();
    }
  });

  it('签章详情用真实 picture.data 渲染图片，并在关闭时释放 Blob URL', async () => {
    viewer = await createViewer();
    const capture = captureDownloads();
    try {
      await viewer.showSignature('s1');
      await vi.waitFor(() => {
        const dialog = document.querySelector<HTMLElement>('.ofd-dialog');
        expect(dialog).not.toBeNull();
        expect(dialog!.querySelector('.ofd-seal-image img')).not.toBeNull();
      });
      const dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
      const img = dialog.querySelector<HTMLImageElement>('.ofd-seal-image img')!;
      expect(img.alt).toContain('OFD R&W 测试用印章');
      expect(img.getAttribute('src')).toMatch(/^blob:/);
      expect(dialog.querySelector('.ofd-seal-image__caption')?.textContent).toContain('mm');
      expect(dialog.querySelector<HTMLElement>('.ofd-signature-badge')?.dataset.status).toBe(
        'not-verified',
      );
      expect(dialog.textContent).toContain('时间戳未包含');

      document.querySelector<HTMLButtonElement>('.ofd-dialog__close')!.click();
      await vi.waitFor(() => expect(capture.revoked.length).toBeGreaterThan(0));
    } finally {
      capture.restore();
    }
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
      expect(
        [...panel!.querySelectorAll<HTMLElement>('.ofd-signature-badge')].map(
          (element) => element.dataset.status,
        ),
      ).toEqual(['not-verified', 'not-verified', 'not-verified', 'not-verified', 'not-verified']);

      await vi.waitFor(() => {
        expect(panel!.textContent).toContain('OFD R&W 测试用印章');
        expect(panel!.textContent).toContain('Test Certificate');
      });
      expect(panel!.textContent).toContain('盖章');
      expect(panel!.textContent).toContain('签名');
      expect(panel!.textContent).toContain('第 2 页');
      expect(panel!.textContent).not.toMatch(/[▣✎]/);

      const first = panel!.querySelector<HTMLButtonElement>(
        '.ofd-signature-summary-item[data-signature-id="s1"]',
      );
      expect(first!.getAttribute('aria-haspopup')).toBe('dialog');
      expect(first!.getAttribute('aria-label')).toContain('盖章');
      expect(first!.getAttribute('aria-label')).toContain('第 1 页');
      first!.click();
      await vi.waitFor(() => {
        const dialog = document.querySelector('.ofd-dialog');
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).toContain('签章信息（未验证）');
        expect(dialog!.textContent).toContain('印章名称');
        expect(first!.dataset.selected).toBe('true');
        expect(first!.getAttribute('aria-current')).toBe('true');
      });
    } finally {
      detachShell();
    }
  });

  it('关闭详情后清除卡片选中态，报告刷新也不会重新标记', async () => {
    viewer = await createViewer();
    const detachShell = attachUIShell(viewer);
    try {
      viewer.openSidebar('signatures');
      const shell = getUIShell(viewer)!;
      const panel = shell.getSidebarPanel('signatures')!;
      await vi.waitFor(() => {
        expect(panel.querySelectorAll('.ofd-signature-summary-item')).toHaveLength(5);
      });
      const first = panel.querySelector<HTMLButtonElement>(
        '.ofd-signature-summary-item[data-signature-id="s1"]',
      )!;
      first.click();
      await vi.waitFor(() => {
        expect(document.querySelector('.ofd-dialog')).not.toBeNull();
        expect(first.dataset.selected).toBe('true');
        expect(first.getAttribute('aria-current')).toBe('true');
      });

      document.querySelector<HTMLButtonElement>('.ofd-dialog__close')!.click();
      await vi.waitFor(() => {
        expect(document.querySelector('.ofd-dialog')).toBeNull();
        expect(first.dataset.selected).toBeUndefined();
        expect(first.hasAttribute('aria-current')).toBe(false);
      });

      viewer.getRoot().dispatchEvent(new Event(VERIFICATION_RESET_EVENT));
      await vi.waitFor(() => {
        expect(panel.querySelectorAll('[data-selected="true"]')).toHaveLength(0);
        expect(panel.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
      });
    } finally {
      detachShell();
    }
  });

  it('详情保持打开时报告刷新重渲染仍只标记对应卡片', async () => {
    viewer = await createViewer();
    const detachShell = attachUIShell(viewer);
    try {
      viewer.openSidebar('signatures');
      const shell = getUIShell(viewer)!;
      const panel = shell.getSidebarPanel('signatures')!;
      await vi.waitFor(() => {
        expect(panel.querySelectorAll('.ofd-signature-summary-item')).toHaveLength(5);
      });
      const first = panel.querySelector<HTMLButtonElement>(
        '.ofd-signature-summary-item[data-signature-id="s1"]',
      )!;
      first.click();
      await vi.waitFor(() => {
        expect(document.querySelector('.ofd-dialog')).not.toBeNull();
        expect(first.dataset.selected).toBe('true');
      });

      viewer.getRoot().dispatchEvent(new Event(VERIFICATION_RESET_EVENT));
      await vi.waitFor(() => {
        const selected = panel.querySelectorAll<HTMLElement>(
          '.ofd-signature-summary-item[data-selected="true"]',
        );
        expect(selected).toHaveLength(1);
        expect(selected[0]!.dataset.signatureId).toBe('s1');
        expect(selected[0]!.getAttribute('aria-current')).toBe('true');
        expect(document.querySelector('.ofd-dialog')).not.toBeNull();
      });
    } finally {
      detachShell();
    }
  });

  it('详情新增签发时间/签章者证书标签使用 CryptoText 英文文案', async () => {
    viewer = await createViewer();
    viewer.setLocale('en-US');
    await viewer.showSignature('s1');
    await vi.waitFor(() => {
      expect(document.querySelector('.ofd-dialog')).not.toBeNull();
    });
    const dialog = document.querySelector<HTMLElement>('.ofd-dialog')!;
    expect(dialog.textContent).toContain('Signing time');
    expect(dialog.textContent).toContain('Signer certificate');
    expect(dialog.textContent).not.toContain('签发时间');
    expect(dialog.textContent).not.toContain('签章者证书');
  });
});
