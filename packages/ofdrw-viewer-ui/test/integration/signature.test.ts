/**
 * 签章集成基线：摘要字段映射、真实 SignedValue 详情、页面覆盖层、缺少
 * SignedValue 的降级与“不验签”声明。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', () => ({
  OFDDocument: { open: engineMocks.open },
  OFDError: class extends Error {},
  isOFDError: () => false,
  toOFDError: (error: unknown) => error,
}));

import { MM_TO_CSS_PX } from '../../src/page-layout';
import { installDomEnvironment } from '../helpers/environment';
import {
  createSignatureEntry,
  HAS_SIGNATURE_FIXTURES,
  readSignedValueFixture,
} from '../helpers/signature';
import { openViewer, type EngineOpenMock } from '../helpers/viewer';

const openMock = engineMocks.open as unknown as EngineOpenMock;

/** 真实样本缺失时跳过，并在报告中保留 skipped 计数。 */
const itWithFixture = HAS_SIGNATURE_FIXTURES ? it : it.skip;

beforeEach(() => {
  document.body.innerHTML = '';
  installDomEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 等待签章摘要与页面覆盖层就绪。 */
async function waitForSignature(
  viewer: Awaited<ReturnType<typeof openViewer>>['viewer'],
  pageNumber = 2,
): Promise<HTMLElement> {
  await vi.waitFor(() => expect(viewer.getSignatures()).toHaveLength(1));
  await vi.waitFor(() => {
    expect(
      viewer.getPageView(pageNumber)!.signatureLayer.querySelectorAll('.ofd-signature-box')
        .length,
    ).toBe(1);
  });
  return viewer
    .getPageView(pageNumber)!
    .signatureLayer.querySelector<HTMLElement>('.ofd-signature-box')!;
}

describe('签章集成：真实 SignedValue', () => {
  itWithFixture('摘要字段与 V4 详情的印章/签章者映射（不验签）', async () => {
    const data = readSignedValueFixture('SignedValueV4.dat');
    const entry = createSignatureEntry();
    const { viewer } = await openViewer(openMock, {
      pageCount: 3,
      signatures: [entry],
      signedValues: { 'sig-1': data },
    });

    await vi.waitFor(() => expect(viewer.getSignatures()).toHaveLength(1));
    expect(viewer.getSignatures()[0]).toMatchObject({
      id: 'sig-1',
      type: 'Seal',
      baseLoc: 'Signs/Signature.xml',
      hasSignedValue: true,
      stamps: [{ pageIndex: 1 }],
    });

    const detail = await viewer.getSignatureDetail('sig-1');
    expect(detail.entry.id).toBe('sig-1');
    expect(detail.seal).toMatchObject({
      version: 'v4',
      esId: '51f044b76510434e9bc67a1185c2fba5',
      name: 'OFD R&W 测试用印章',
      image: { format: 'PNG', widthMm: 40, heightMm: 40 },
    });
    expect(detail.signer).toMatchObject({
      signedAt: '2020-10-12T11:14:03.000Z',
      signedAtSource: 'timeInfo',
      algorithm: { oid: '1.2.156.10197.1.501', name: 'SM2-with-SM3' },
    });
    expect(detail.signer?.certificate?.subjectAttributes?.cn).toBe('Test Certificate');
    expect(detail.validation.status).toBe('not-verified');
    expect(detail.validation.note).toContain('未进行签名验证');
    expect(detail.warnings ?? []).toEqual([]);
    viewer.destroy();
  });

  itWithFixture('覆盖层按 mm→px 定位/裁剪，点击定位并打开详情', async () => {
    const data = readSignedValueFixture('SignedValueV4.dat');
    const entry = createSignatureEntry();
    const { viewer } = await openViewer(openMock, {
      pageCount: 3,
      signatures: [entry],
      signedValues: { 'sig-1': data },
    });

    const overlay = await waitForSignature(viewer, 2);
    const scale = viewer.getScale();
    const pxPerMm = MM_TO_CSS_PX * scale;
    expect(overlay.dataset.signatureId).toBe('sig-1');
    expect(overlay.dataset.pageNumber).toBe('2');
    expect(Number.parseFloat(overlay.style.left)).toBeCloseTo(10 * pxPerMm, 3);
    expect(Number.parseFloat(overlay.style.top)).toBeCloseTo(12 * pxPerMm, 3);
    expect(Number.parseFloat(overlay.style.width)).toBeCloseTo(40 * pxPerMm, 3);
    expect(Number.parseFloat(overlay.style.height)).toBeCloseTo(30 * pxPerMm, 3);
    expect(overlay.style.clipPath).toContain('inset(');
    expect(overlay.dataset.clip).toBe('true');

    overlay.click();
    await vi.waitFor(() => expect(viewer.getPageNumber()).toBe(2));
    await vi.waitFor(() => {
      const body = document.querySelector('.ofd-dialog__body');
      expect(body?.textContent).toContain('OFD R&W 测试用印章');
      expect(body?.textContent).toContain('未验证');
    });
    viewer.destroy();
  });
});

describe('签章集成：降级与门控', () => {
  it('缺少 SignedValue.dat 时详情降级 warning，不抛错也不伪装验证通过', async () => {
    const entry = createSignatureEntry({ hasSignedValue: false, signedValuePath: undefined });
    const { viewer } = await openViewer(openMock, {
      pageCount: 3,
      signatures: [entry],
      signedValues: {},
    });
    const overlay = await waitForSignature(viewer, 2);
    expect(overlay).not.toBeNull();

    const detail = await viewer.getSignatureDetail('sig-1');
    expect(detail.validation.status).toBe('not-verified');
    expect(detail.seal).toBeUndefined();
    expect(detail.signer).toMatchObject({ signedAt: entry.signatureDateTime });
    expect((detail.warnings ?? []).map((warning) => warning.code)).toContain(
      'W_SIGNATURE_RESOURCE',
    );
    expect(
      (detail.warnings ?? []).some((warning) => warning.message.includes('签章信息不完整')),
    ).toBe(true);
    viewer.destroy();
  });

  it('features.signatures=false 时清理覆盖层并禁用详情 API', async () => {
    const entry = createSignatureEntry();
    const { viewer } = await openViewer(
      openMock,
      { pageCount: 3, signatures: [entry] },
      { features: { signatures: false } },
    );
    expect(viewer.getFeatureState('signatures')).toMatchObject({
      enabled: false,
      reason: 'host',
    });
    expect(viewer.getPageView(1)!.signatureLayer.hidden).toBe(true);
    expect(
      viewer.getRoot().querySelectorAll('.ofd-signature-box'),
    ).toHaveLength(0);
    await expect(viewer.getSignatureDetail('sig-1')).rejects.toMatchObject({
      code: 'OFD_FEATURE_DISABLED',
      feature: 'signatures',
    });
    viewer.destroy();
  });
});