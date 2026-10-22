/**
 * PDF 参考渲染链路自检：合成 PDF → pdftoppm @96 DPI → 与 Canvas 合成页比较。
 *
 * pdftoppm 不可用时 skip；业务原件不参与本测试。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, resolveArtifactsDir } from './lib/artifacts';
import { compareImages } from './lib/compare';
import { decodePng } from './lib/image';
import { buildMockReferencePdf, renderMockCanvas } from './lib/mock-page';
import { getPdfInfo, isPdftoppmAvailable, renderPdfPageToPng } from './lib/pdf';
import { findSample, loadSampleManifest } from './lib/samples';

const describeIf = isPdftoppmAvailable() ? describe : describe.skip;

// 真实样本只读取仓库现有 ofd_pdf_match/，缺失时跳过（业务原件不提交新副本）。
const manifest = loadSampleManifest();
const hello = findSample(manifest, 'hello');
const helloPdf = hello?.pdf ? join(REPO_ROOT, hello.pdf) : null;
const helloAvailable = helloPdf !== null && existsSync(helloPdf);
const z = findSample(manifest, 'z');
const zPdf = z?.pdf ? join(REPO_ROOT, z.pdf) : null;
const zAvailable = zPdf !== null && existsSync(zPdf) && z?.referenceOverride !== undefined;

describeIf('PDF 参考渲染（poppler）', () => {
  it('合成 PDF 渲染为 400×300 PNG，并与 Canvas 页在容差内一致', () => {
    const artifactsDir = resolveArtifactsDir('golden');
    const pdfPath = join(artifactsDir, 'mock-reference.pdf');
    const pngPath = join(artifactsDir, 'pages', 'mock-pdf-ref.png');
    writeFileSync(pdfPath, buildMockReferencePdf());

    const info = getPdfInfo(pdfPath);
    expect(info.pages).toBe(1);
    expect(info.pageSizePt?.width).toBeCloseTo(300, 2);
    expect(info.pageSizePt?.height).toBeCloseTo(225, 2);

    const rendered = renderPdfPageToPng(pdfPath, 1, pngPath, 96);
    expect(rendered.ms).toBeGreaterThanOrEqual(0);
    const reference = decodePng(new Uint8Array(readFileSync(pngPath)));
    expect(reference.width).toBe(400);
    expect(reference.height).toBe(300);

    const canvasPage = renderMockCanvas('base');
    const comparison = compareImages(canvasPage.image, reference, { dpi: 96 });
    console.log(
      `[pdf-reference] status=${comparison.status} ` +
        `layoutΔ=${comparison.metrics.layoutDeltaMm?.toFixed(4)}mm ` +
        `keyΔE=${comparison.metrics.keyColorMaxDE.toFixed(2)} ` +
        `ssim=${comparison.metrics.ssim.toFixed(4)} ` +
        `pixelDiff=${(comparison.metrics.pixelDiffRatio * 100).toFixed(3)}%`,
    );
    expect(comparison.metrics.sizeDeltaPx).toEqual({ width: 0, height: 0 });
    expect(comparison.metrics.layoutDeltaMm).not.toBeNull();
    expect(comparison.metrics.layoutDeltaMm!).toBeLessThanOrEqual(0.5);
    expect(comparison.metrics.keyColorMaxDE).toBeLessThanOrEqual(5);
    expect(comparison.ok, comparison.reasons.join('；')).toBe(true);
  });

  it.skipIf(!zAvailable)('z p2 referenceOverride 按目标内容 bbox 归一化为 794×1123', () => {
    const pngPath = join(resolveArtifactsDir('golden'), 'pages', 'z-p002-authoritative-ref.png');
    const rendered = renderPdfPageToPng(zPdf!, 2, pngPath, 96);
    expect(rendered.ms).toBeGreaterThanOrEqual(0);
    const image = decodePng(new Uint8Array(readFileSync(pngPath)));
    expect(image.width).toBe(794);
    expect(image.height).toBe(1123);
    expect(z!.referenceOverride!.targetContentBBoxPx).toEqual({ x: 120, y: 129, width: 551, height: 723 });
  });

  it.skipIf(!helloAvailable)('真实样本 hello.pdf 首页可渲染，尺寸与样本清单一致', () => {
    const sample = hello!;
    const pngPath = join(resolveArtifactsDir('golden'), 'pages', 'hello-p001-ref.png');
    const info = getPdfInfo(helloPdf!);
    expect(info.pages).toBe(sample.pdfPages);
    expect(info.pageSizePt).not.toBeNull();

    const rendered = renderPdfPageToPng(helloPdf!, 1, pngPath, 96);
    expect(rendered.ms).toBeGreaterThanOrEqual(0);
    const image = decodePng(new Uint8Array(readFileSync(pngPath)));
    // pdftoppm 对 pt→px 可能四舍五入或截断，允许 1 px 误差。
    expect(Math.abs(image.width - (info.pageSizePt!.width / 72) * 96)).toBeLessThanOrEqual(1);
    expect(Math.abs(image.height - (info.pageSizePt!.height / 72) * 96)).toBeLessThanOrEqual(1);
    expect((image.width * 25.4) / 96).toBeCloseTo(sample.sizeMm!.width, 0);
    expect((image.height * 25.4) / 96).toBeCloseTo(sample.sizeMm!.height, 0);
  });
});