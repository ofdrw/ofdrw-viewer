/**
 * `SignatureService` 功能门控与生命周期测试（直接实例化，不经过 side-effect 注册）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo, SignatureEntryInfo } from '@ofdrw/ofdrw-viewer-engine';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { parseSignedValue } from '@ofdrw/ofdrw-viewer-crypto';
import { OFDViewer } from '../../../src/viewer';
import { SignatureService } from '../../../src/signature/service';
import { readSignedValueFixture } from './fixtures';

const PAGE_INFOS: PageInfo[] = [{ index: 0, widthMm: 210, heightMm: 297 }];

const ENTRIES: readonly SignatureEntryInfo[] = [
  {
    id: 'only',
    type: 'Seal',
    baseLoc: '/Doc_0/Signs/Only/Signature.xml',
    references: [],
    stamps: [
      {
        id: 'stamp-only',
        pageId: '1',
        pageIndex: 0,
        boundary: { x: 1, y: 2, w: 3, h: 4 },
      },
    ],
    signedValuePath: '/Doc_0/Signs/Only/SignedValue.dat',
    hasSignedValue: true,
  },
];

function makeDocument(getSignedValue = vi.fn()) {
  return {
    pageCount: 1,
    getPageInfos: async () => PAGE_INFOS,
    getPage: async (index: number) => ({
      index,
      getSize: () => ({ width: 210, height: 297 }),
      getViewport: (options: { dpi?: number } = {}) => {
        const dpi = options.dpi ?? 96;
        return { width: 794, height: 1123, dpi };
      },
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    }),
    getOutline: async () => [],
    getBookmarks: async () => [],
    getMetadata: async () => ({}),
    getPermissions: async () => ({ edit: true }),
    getSignatureEntries: async () => ENTRIES,
    getSignedValue,
    close: async () => undefined,
  };
}

let viewer: OFDViewer | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  engineMocks.open.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});

afterEach(() => {
  viewer?.destroy();
  viewer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SignatureService 门控', () => {
  it('getSignatures 不解析 SignedValue；功能关闭时服务方法抛 OFD_FEATURE_DISABLED', async () => {
    const getSignedValue = vi.fn(async () => undefined);
    engineMocks.open.mockImplementation(async () => makeDocument(getSignedValue));
    viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
    });
    await viewer.ready;
    const service = new SignatureService(viewer);
    const detach = viewer.attachSignatureService(service);
    try {
      await vi.waitFor(() => expect(service.getSignatures()).toHaveLength(1));
      expect(getSignedValue).not.toHaveBeenCalled();

      viewer.setFeatures({ signatures: false });
      expect(() => service.getSignatures()).toThrow(
        expect.objectContaining({ code: 'OFD_FEATURE_DISABLED', feature: 'signatures' }),
      );
      await expect(service.getSignatureDetail('only')).rejects.toMatchObject({
        code: 'OFD_FEATURE_DISABLED',
      });
      await expect(service.showSignature('only')).rejects.toMatchObject({
        code: 'OFD_FEATURE_DISABLED',
      });
    } finally {
      detach();
      service.destroy();
    }
  });

  it('未知签章 ID 抛 OFD_INVALID_OPTION；destroy 后抛 OFD_DESTROYED', async () => {
    engineMocks.open.mockImplementation(async () => makeDocument());
    viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
    });
    await viewer.ready;
    const service = new SignatureService(viewer);
    const detach = viewer.attachSignatureService(service);
    await vi.waitFor(() => expect(service.getSignatures()).toHaveLength(1));
    await expect(service.getSignatureDetail('missing')).rejects.toMatchObject({
      code: 'OFD_INVALID_OPTION',
    });
    detach();
    service.destroy();
    await expect(service.getSignatureDetail('only')).rejects.toMatchObject({
      code: 'OFD_DESTROYED',
    });
    expect(document.querySelectorAll('.ofd-signature-box')).toHaveLength(0);
  });

  it('解析真实 v4 后缓存详情，避免重复读取签名值', async () => {
    const getSignedValue = vi.fn(async (id: string) => ({
      signatureId: id,
      path: '/Doc_0/Signs/Only/SignedValue.dat',
      data: readSignedValueFixture('SignedValueV4.dat'),
      byteLength: 1,
    }));
    engineMocks.open.mockImplementation(async () => makeDocument(getSignedValue));
    viewer = new OFDViewer({
      crypto: { enabled: false },
      container: document.body,
      source: new ArrayBuffer(8),
      initialScale: 1,
    });
    await viewer.ready;
    const service = new SignatureService(viewer);
    const detach = viewer.attachSignatureService(service);
    try {
      await vi.waitFor(() => expect(service.getSignatures()).toHaveLength(1));
      const first = await service.getSignatureDetail('only');
      const second = await service.getSignatureDetail('only');
      expect(first).toBe(second);
      expect(getSignedValue).toHaveBeenCalledTimes(1);
      expect(first.seal?.name).toBe(
        parseSignedValue(readSignedValueFixture('SignedValueV4.dat')).seal?.name,
      );
    } finally {
      detach();
      service.destroy();
    }
  });
});
