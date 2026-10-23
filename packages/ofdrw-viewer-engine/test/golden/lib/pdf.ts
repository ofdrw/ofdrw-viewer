/**
 * PDF 参考渲染（poppler `pdftoppm` / `pdfinfo`）。
 *
 * PDF 只作为版式/位置参考；渲染 DPI 必须与引擎输出一致（默认 96）。
 * 命令不可用时由调用方 skip，不硬失败。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { REPO_ROOT } from './artifacts';
import { alignContentToBBox, decodePng, encodePng, resizeImageContain } from './image';
import { loadSampleManifest } from './samples';
import type { ReferenceOverride } from './types';

/** PDF 元信息。 */
export interface PdfInfo {
  /** 页数；解析失败时为 null。 */
  pages: number | null;
  /** 首页尺寸，pt；解析失败时为 null。 */
  pageSizePt: { width: number; height: number } | null;
  /** 原始 pdfinfo 输出（调试用）。 */
  raw: string;
}

let pdftoppmAvailable: boolean | null = null;
let pdfinfoAvailable: boolean | null = null;

/**
 * 检查 `pdftoppm` 是否可用（结果缓存）。
 *
 * @returns 可用返回 true。
 */
export function isPdftoppmAvailable(): boolean {
  if (pdftoppmAvailable === null) {
    pdftoppmAvailable = probeCommand('pdftoppm', ['-v']);
  }
  return pdftoppmAvailable;
}

/**
 * 检查 `pdfinfo` 是否可用（结果缓存）。
 *
 * @returns 可用返回 true。
 */
export function isPdfinfoAvailable(): boolean {
  if (pdfinfoAvailable === null) {
    pdfinfoAvailable = probeCommand('pdfinfo', ['-v']);
  }
  return pdfinfoAvailable;
}

/** 探测命令是否可执行；`-v` 通常输出到 stderr 且退出码 0。 */
function probeCommand(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, [...args], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * 读取 PDF 页数/首页尺寸。
 *
 * @param pdfPath PDF 路径。
 * @param page 指定页（1 起）；默认首页。
 * @returns 元信息；命令不可用时 pages/pageSize 为 null。
 */
export function getPdfInfo(pdfPath: string, page = 1): PdfInfo {
  if (!isPdfinfoAvailable()) return { pages: null, pageSizePt: null, raw: 'pdfinfo 不可用' };
  let raw = '';
  try {
    raw = execFileSync('pdfinfo', ['-f', String(page), '-l', String(page), pdfPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    return { pages: null, pageSizePt: null, raw: String(error) };
  }
  const pagesMatch = /^Pages:\s+(\d+)/m.exec(raw);
  // 带 -f/-l 时 pdfinfo 输出 `Page    N size:`；不带时输出 `Page size:`。
  const sizeMatch = /^Page(?:\s+\d+)?\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(raw);
  return {
    pages: pagesMatch ? Number(pagesMatch[1]) : null,
    pageSizePt: sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : null,
    raw,
  };
}

/**
 * 查找某 PDF 页的人工参考覆盖。
 *
 * 只匹配清单中显式声明 `referenceOverride` 的样本；未声明时返回 undefined，
 * 继续走 pdftoppm。
 *
 * @param pdfPath PDF 绝对/相对路径。
 * @param page 页号（1 起）。
 * @returns 参考覆盖配置；未命中时返回 undefined。
 */
function findReferenceOverride(pdfPath: string, page: number): ReferenceOverride | undefined {
  const absolute = resolve(pdfPath);
  for (const sample of loadSampleManifest().samples) {
    if (!sample.pdf || !sample.referenceOverride || sample.referenceOverride.page !== page) continue;
    if (resolve(REPO_ROOT, sample.pdf) === absolute) return sample.referenceOverride;
  }
  return undefined;
}

/**
 * 将人工权威图等比缩放并写入参考 PNG。
 *
 * 清单中的 width/height 按 96 DPI 记录；实际输出 DPI 变化时同步等比缩放，
 * 避免 150 DPI 下出现只由参考覆盖图尺寸引起的 size-mismatch。
 *
 * @param override 参考覆盖配置。
 * @param outPngPath 输出 PNG 绝对路径。
 * @param dpi 输出 DPI，默认 96。
 * @param targetSize 引擎实际输出尺寸（像素）；声明时优先使用，保证 override 页尺寸严格一致。
 * @param targetContentBBoxPx 引擎实际内容 bbox（像素）；声明时按该 bbox 对齐权威图内容。
 * @returns 输出路径与耗时（ms）。
 */
function renderReferenceOverride(
  override: ReferenceOverride,
  outPngPath: string,
  dpi = 96,
  targetSize?: { width: number; height: number },
  targetContentBBoxPx?: { x: number; y: number; width: number; height: number },
): { path: string; ms: number } {
  const sourcePath = isAbsolute(override.path) ? override.path : join(REPO_ROOT, override.path);
  if (!existsSync(sourcePath)) throw new Error(`参考覆盖图不存在：${sourcePath}`);
  mkdirSync(dirname(outPngPath), { recursive: true });
  const start = performance.now();
  const source = decodePng(new Uint8Array(readFileSync(sourcePath)));
  // 96 DPI 时清单 width/height 已是引擎尺寸；其它 DPI 或引擎声明 targetSize 时按物理尺寸等比缩放。
  const width = targetSize?.width ?? Math.max(1, Math.round(override.width * (dpi / 96)));
  const height = targetSize?.height ?? Math.max(1, Math.round(override.height * (dpi / 96)));
  const scaleX = width / override.width;
  const scaleY = height / override.height;
  // 非 96 DPI 时引擎内容 bbox 与 96 DPI 声明不一定线性等比（字体/换行亚像素差异），
  // 优先使用引擎实际内容 bbox 对齐，保持“权威内容区对齐引擎内容区”的 override 语义。
  const targetBBox =
    targetContentBBoxPx ??
    (override.targetContentBBoxPx
      ? {
          x: Math.round(override.targetContentBBoxPx.x * scaleX),
          y: Math.round(override.targetContentBBoxPx.y * scaleY),
          width: Math.max(1, Math.round(override.targetContentBBoxPx.width * scaleX)),
          height: Math.max(1, Math.round(override.targetContentBBoxPx.height * scaleY)),
        }
      : undefined);
  const normalized = targetBBox
    ? alignContentToBBox(source, width, height, targetBBox)
    : resizeImageContain(source, width, height);
  writeFileSync(outPngPath, encodePng(normalized));
  return { path: outPngPath, ms: performance.now() - start };
}

/**
 * 用 pdftoppm 渲染 PDF 单页为 PNG（96 DPI 时 1 pt = 4/3 px）。
 *
 * 若该页在样本清单中声明了 `referenceOverride`，改用人工权威图缩放输出；
 * 仅影响声明页，其他页仍按 PDF 渲染。
 *
 * @param pdfPath PDF 路径。
 * @param page 页号（1 起）。
 * @param outPngPath 输出 PNG 绝对路径。
 * @param dpi 输出 DPI，默认 96。
 * @param targetSize 引擎实际输出尺寸（像素）；仅供 referenceOverride 对齐使用。
 * @param targetContentBBoxPx 引擎实际内容 bbox（像素）；仅供 referenceOverride 对齐使用。
 * @returns 输出路径与耗时（ms）。
 */
export function renderPdfPageToPng(
  pdfPath: string,
  page: number,
  outPngPath: string,
  dpi = 96,
  targetSize?: { width: number; height: number },
  targetContentBBoxPx?: { x: number; y: number; width: number; height: number },
): { path: string; ms: number } {
  const override = findReferenceOverride(pdfPath, page);
  if (override) return renderReferenceOverride(override, outPngPath, dpi, targetSize, targetContentBBoxPx);
  if (!isPdftoppmAvailable()) throw new Error('pdftoppm 不可用，无法渲染 PDF 参考图');
  if (!existsSync(pdfPath)) throw new Error(`PDF 不存在：${pdfPath}`);
  mkdirSync(dirname(outPngPath), { recursive: true });
  const prefix = outPngPath.replace(/\.png$/i, '');
  const start = performance.now();
  execFileSync(
    'pdftoppm',
    ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', pdfPath, prefix],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return { path: outPngPath, ms: performance.now() - start };
}
