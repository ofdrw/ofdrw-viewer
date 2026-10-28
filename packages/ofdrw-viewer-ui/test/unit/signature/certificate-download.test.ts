/**
 * 证书 DER 下载：文件名清洗、Blob 类型与空字节保护。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  certificateFileName,
  downloadCertificateDer,
} from '../../../src/crypto/certificate-download';
import { captureDownloads } from '../../helpers/environment';
import type { DownloadCapture } from '../../helpers/environment';

let capture: DownloadCapture | null = null;

afterEach(() => {
  capture?.restore();
  capture = null;
});

describe('certificateFileName', () => {
  it('优先使用 CN，并追加清洗后的序列号', () => {
    expect(
      certificateFileName({
        subject: 'C=CN,O=ofdrw,CN=Test Certificate',
        serialNumber: '3e9',
      }),
    ).toBe('Test Certificate-3e9.cer');
    expect(
      certificateFileName({ subject: 'CN=合同/签章:2026', serialNumber: '01/02' }),
    ).toBe('合同_签章_2026-01_02.cer');
  });

  it('无 CN 时使用回退名，无序列号时只保留基础名', () => {
    expect(certificateFileName({ subject: 'O=ofdrw' }, 'signer')).toBe('signer.cer');
    expect(certificateFileName(undefined, 'root')).toBe('root.cer');
  });
});

describe('downloadCertificateDer', () => {
  it('下载 application/pkix-cert 的 DER 字节并释放 Blob URL', () => {
    vi.useFakeTimers();
    capture = captureDownloads();
    const der = new Uint8Array([0x30, 0x82, 0x01, 0x00]);
    expect(
      downloadCertificateDer(
        document,
        der,
        { subject: 'CN=Signer', serialNumber: '01' },
        'signer',
      ),
    ).toBe(true);
    expect(capture.downloads).toHaveLength(1);
    expect(capture.downloads[0]!.filename).toBe('Signer-01.cer');
    expect(capture.downloads[0]!.blob?.type).toBe('application/pkix-cert');
    expect(capture.downloads[0]!.blob?.size).toBe(der.byteLength);
    vi.advanceTimersByTime(1001);
    expect(capture.revoked).toHaveLength(1);
    vi.useRealTimers();
  });

  it('空字节不下载', () => {
    capture = captureDownloads();
    expect(downloadCertificateDer(document, undefined, { subject: 'CN=x' })).toBe(false);
    expect(downloadCertificateDer(document, new Uint8Array(0), { subject: 'CN=x' })).toBe(false);
    expect(capture.downloads).toHaveLength(0);
  });
});