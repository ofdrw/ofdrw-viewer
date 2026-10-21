/**
 * PDF 元信息读取（pdfinfo）。
 *
 * PDF 仅作版式参考；页码/页尺寸用于清单与黄金图尺寸校验。
 */

import { execFileSync, spawnSync } from 'node:child_process';

let available = null;

/**
 * 检查 pdfinfo 是否可用（缓存）。
 *
 * @returns 可用返回 true。
 */
export function hasPdfinfo() {
  if (available === null) {
    available = spawnSync('pdfinfo', ['-v'], { stdio: 'ignore' }).status === 0;
  }
  return available;
}

/**
 * 读取 PDF 页数与首页尺寸。
 *
 * @param pdfPath PDF 路径。
 * @returns `{pages, widthPt, heightPt}`；不可用/失败时字段为 null。
 */
export function getPdfMeta(pdfPath) {
  if (!hasPdfinfo()) return { pages: null, widthPt: null, heightPt: null };
  try {
    const text = execFileSync('pdfinfo', [pdfPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pagesMatch = /^Pages:\s+(\d+)/m.exec(text);
    const sizeMatch = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(text);
    return {
      pages: pagesMatch ? Number(pagesMatch[1]) : null,
      widthPt: sizeMatch ? Number(sizeMatch[1]) : null,
      heightPt: sizeMatch ? Number(sizeMatch[2]) : null,
    };
  } catch {
    return { pages: null, widthPt: null, heightPt: null };
  }
}