/**
 * 证书下载。
 *
 * 只接受证书 DER 字节；不接受 PEM 文本或私钥，避免把私钥写入下载文件。
 * 文件内容为 DER 编码，扩展名使用 Windows 可识别的 `.cer`。
 */

import { downloadBlob, sanitizeFileName } from '../export/filename';

/** 下载所需的证书摘要字段。 */
export interface DownloadableCertificateSummary {
  /** 主题 DN。 */
  readonly subject?: string;
  /** 序列号十六进制。 */
  readonly serialNumber?: string;
}

/** 从主题 DN 中提取 CN。 */
function subjectCN(subject: string | undefined): string | undefined {
  if (!subject) return undefined;
  const match = /(?:^|,)\s*CN=([^,]+)/i.exec(subject);
  return match?.[1]?.trim() || undefined;
}

/**
 * 构造证书文件名。
 *
 * @param summary 证书摘要；用于取 CN/序列号。
 * @param fallback 无 CN 时的基础名。
 * @returns 经过清理的 `.cer` 文件名。
 */
export function certificateFileName(
  summary: DownloadableCertificateSummary | undefined,
  fallback = 'certificate',
): string {
  const cn = subjectCN(summary?.subject);
  const base = sanitizeFileName(cn || fallback) || fallback;
  const serial = summary?.serialNumber
    ? sanitizeFileName(summary.serialNumber).slice(0, 32)
    : '';
  return `${base}${serial ? `-${serial}` : ''}.cer`;
}

/**
 * 下载证书 DER。
 *
 * @param doc 宿主文档。
 * @param der 证书 DER 字节；为空时不下载。
 * @param summary 证书摘要；用于命名。
 * @param fallback 无 CN 时的基础名。
 * @returns 是否已发起下载。
 */
export function downloadCertificateDer(
  doc: Document,
  der: Uint8Array | undefined,
  summary: DownloadableCertificateSummary | undefined,
  fallback = 'certificate',
): boolean {
  if (!der || der.byteLength === 0) return false;
  const bytes = new Uint8Array(der);
  const blob = new Blob([bytes], { type: 'application/pkix-cert' });
  downloadBlob(doc, blob, certificateFileName(summary, fallback));
  return true;
}