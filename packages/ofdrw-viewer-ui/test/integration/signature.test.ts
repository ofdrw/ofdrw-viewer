/**
 * 签章集成基线：摘要字段映射、真实 SignedValue 详情、页面覆盖层、缺少
 * SignedValue 的降级与“不验签”声明。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@ofdrw/ofdrw-viewer-engine', async (importOriginal) => {
  // 未覆盖的引擎导出（常量、类型辅助）保持真实实现，避免新特性读取到 undefined。
  const actual = await importOriginal<typeof import('@ofdrw/ofdrw-viewer-engine')>();
  return {
    ...actual,
    OFDDocument: { open: engineMocks.open },
    OFDError: class extends Error {},
    isOFDError: () => false,
    toOFDError: (error: unknown) => error,
  };
});

import { parseSignedValue } from '@ofdrw/ofdrw-viewer-crypto';
import { MM_TO_CSS_PX } from '../../src/page-layout';
import { installDomEnvironment } from '../helpers/environment';
import { createSignatureEntry, readSignedValueFixture } from '../helpers/signature';
import { openViewer, type EngineOpenMock } from '../helpers/viewer';
import { UI_WARNING_CODES } from '../../src/diagnostics';

const openMock = engineMocks.open as unknown as EngineOpenMock;

/** V4 签章样本解析结果；期望值取自夹具本身，不硬编码样本内容。 */
const PARSED_V4 = parseSignedValue(readSignedValueFixture('SignedValueV4.dat'));

/** V4 样本印章名称。 */
const SEAL_NAME = PARSED_V4.seal?.name ?? '';

/** V4 样本签章者证书 CN。 */
const SIGNER_CN =
  PARSED_V4.certificate?.subject.match(/(?:^|,)CN=([^,]+)/)?.[1] ?? '';

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
  it('摘要字段与 V4 详情的印章/签章者映射（不验签）', async () => {
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
      esId: PARSED_V4.seal?.esId,
      name: SEAL_NAME,
      image: { format: 'PNG', widthMm: 40, heightMm: 40 },
    });
    expect(detail.signer).toMatchObject({
      signedAt: PARSED_V4.signedAt,
      signedAtSource: 'timeInfo',
      algorithm: { oid: '1.2.156.10197.1.501', name: 'SM2-with-SM3' },
    });
    expect(detail.signer?.certificate?.subjectAttributes?.cn).toBe(SIGNER_CN);
    expect(detail.validation.status).toBe('not-verified');
    expect(detail.validation.note).toContain('未进行签名验证');
    expect(detail.warnings ?? []).toEqual([]);
    viewer.destroy();
  });

  it('覆盖层按 mm→px 定位/裁剪，点击定位并打开详情', async () => {
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
      expect(body?.textContent).toContain(SEAL_NAME);
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
      UI_WARNING_CODES.W_SIGNATURE_RESOURCE,
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