/**
 * 64 条样本（62 对基准 + manual + dense-text-perf）的批量回归。
 *
 * 默认行为（未设置 `GOLDEN_RUN_ALL=1`）跳过，避免拖慢日常单测。
 * 运行方式：
 *   GOLDEN_RUN_ALL=1 pnpm -C packages/ofdrw-viewer-engine exec vitest run test/e2e/run-all.e2e.test.ts
 *   GOLDEN_RUN_ALL=1 GOLDEN_REQUIRE_ENGINE=1 <同上>   # T9/T11：引擎不可用或有差异即失败
 *
 * 阶段约定：T8 时引擎尚未实现，报告会记录 `engine-unavailable` 并正常退出；
 * 设置 `GOLDEN_REQUIRE_ENGINE=1` 后则要求所有样本可用且所有页通过。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, resolveArtifactsDir } from '../golden/lib/artifacts';
import { compareImages } from '../golden/lib/compare';
import { renderOfdSample } from '../golden/lib/engine';
import { decodePng, computeBBox, computeContentMask } from '../golden/lib/image';
import { isPdftoppmAvailable, renderPdfPageToPng } from '../golden/lib/pdf';
import { computeSummary, sampleOutcome, writeReport } from '../golden/lib/report';
import {
  createEmptySampleReport,
  goldenPagesOf,
  loadSampleManifest,
} from '../golden/lib/samples';
import { DEFAULT_TOLERANCE } from '../golden/lib/types';
import type {
  BBoxPx,
  CompareResult,
  GoldenReport,
  PageComparisonRecord,
  SampleReport,
  Tolerance,
} from '../golden/lib/types';

/** 只由脚本显式开启，避免 `pnpm test` 意外跑全量。 */
const enabled = process.env.GOLDEN_RUN_ALL === '1';
/** 是否要求引擎可用且全部通过（T9/T11 门禁）。 */
const requireEngine = process.env.GOLDEN_REQUIRE_ENGINE === '1';
const dpi = Number(process.env.GOLDEN_DPI ?? 96);
const sampleFilter = process.env.GOLDEN_SAMPLE_FILTER ?? '';
const maxPages = process.env.GOLDEN_MAX_PAGES ? Number(process.env.GOLDEN_MAX_PAGES) : null;
const describeIf = enabled ? describe : describe.skip;

/** 黄金图基线目录（人工确认后提交）。 */
const BASELINE_DIR = join(REPO_ROOT, 'packages', 'ofdrw-viewer-engine', 'test', 'golden', 'baseline');

/** 文件名安全化（保留中文）。 */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_');
}

/** 页号格式化为 3 位。 */
function pageLabel(page: number): string {
  return String(page).padStart(3, '0');
}

/** 创建空页记录。 */
function emptyPageRecord(
  sample: string,
  page: number,
  warnings: PageComparisonRecord['warnings'] = [],
): PageComparisonRecord {
  return {
    sample,
    page,
    status: 'skipped',
    width: null,
    height: null,
    sizeMm: null,
    enginePng: null,
    referencePng: null,
    baselinePng: null,
    diffPng: null,
    metrics: null,
    baselineMetrics: null,
    renderMs: null,
    referenceMs: null,
    warnings,
    error: null,
    notes: [],
  };
}

/** 把 JSON 中的页面尺寸四舍五入到 4 位小数（mm）。 */
function roundMm(value: number): number {
  return Number(value.toFixed(4));
}

describeIf('真实样本回归（62 对 + manual + dense-text-perf）', () => {
  it(
    '批量渲染、PDF 参考对比与报告输出',
    { timeout: 30 * 60_000 },
    async () => {
      const startedAt = performance.now();
      const artifactsDir = resolveArtifactsDir('golden');
      const pagesDir = join(artifactsDir, 'pages');
      mkdirSync(pagesDir, { recursive: true });
      const tolerance: Tolerance = { ...DEFAULT_TOLERANCE };
      const manifest = loadSampleManifest();
      // 优先精确匹配样本名；没有精确命中时按子串匹配（方便成组排查）。
      const exactMatches = manifest.samples.filter((sample) => sample.name === sampleFilter);
      const selected =
        sampleFilter.length === 0
          ? manifest.samples
          : exactMatches.length > 0
            ? exactMatches
            : manifest.samples.filter((sample) => sample.name.includes(sampleFilter));
      if (selected.length === 0) {
        throw new Error(`没有匹配的样本：${sampleFilter}`);
      }
      const pdftoppmReady = isPdftoppmAvailable();
      const sampleReports: SampleReport[] = [];

      /** 保存 PNG 到产物目录，返回相对路径。 */
      const savePng = (fileName: string, png: Uint8Array): string => {
        const absolute = join(pagesDir, fileName);
        writeFileSync(absolute, png);
        return `pages/${fileName}`;
      };

      /** 相对产物目录的链接（用于基线文件）。 */
      const artifactLink = (absolute: string): string =>
        relative(artifactsDir, absolute).split(sep).join('/');

      for (const entry of selected) {
        const report = createEmptySampleReport(entry);
        const sampleStart = performance.now();
        sampleReports.push(report);

        if (!entry.available || !entry.ofd) {
          report.notes.push('本地样本不存在（optional/manual），本次跳过。');
          report.totalMs = performance.now() - sampleStart;
          continue;
        }

        const allPages = goldenPagesOf(entry);
        const pagesToRender =
          maxPages !== null && maxPages > 0 ? allPages.slice(0, maxPages) : allPages;
        const result = await renderOfdSample(join(REPO_ROOT, entry.ofd), {
          dpi,
          pages: pagesToRender,
        });
        report.engineStatus = result.status;
        report.openMs = result.openMs;
        report.ofdPages = result.pageCount;
        report.warnings = result.warnings;
        report.fontMissingCount = result.fontMissingCount;

        if (result.status === 'unavailable') {
          report.notes.push(
            result.error?.message ?? '引擎尚未实现（T8 阶段），仅记录 PDF 页数/尺寸与样本元数据。',
          );
          for (const page of pagesToRender) {
            report.pages.push(emptyPageRecord(entry.name, page));
          }
          report.totalMs = performance.now() - sampleStart;
          continue;
        }
        if (result.status === 'error') {
          report.notes.push(
            `引擎打开失败：${result.error?.code ?? ''} ${result.error?.message ?? '未知错误'}`,
          );
          report.totalMs = performance.now() - sampleStart;
          continue;
        }

        if (
          result.pageCount !== null &&
          entry.pdfPages !== null &&
          result.pageCount !== entry.pdfPages
        ) {
          report.notes.push(`页数不一致：引擎 ${result.pageCount}，PDF ${entry.pdfPages}`);
        }
        if (!pdftoppmReady) {
          report.notes.push('pdftoppm 不可用，无法生成 PDF 参考图。');
        }
        if (!entry.pdf) {
          report.notes.push('PDF 缺失，跳过 PDF 参考对比。');
        }

        for (const rendered of result.pages) {
          const key = `${fileSafe(entry.name)}-p${pageLabel(rendered.page)}`;
          const record = emptyPageRecord(entry.name, rendered.page, rendered.warnings);
          record.width = rendered.width;
          record.height = rendered.height;
          record.sizeMm = {
            width: roundMm(rendered.sizeMm.width),
            height: roundMm(rendered.sizeMm.height),
          };
          record.renderMs = rendered.renderMs;
          record.enginePng = savePng(`${key}-engine.png`, rendered.png);

          if (entry.pdf && pdftoppmReady) {
            const referenceAbs = join(pagesDir, `${key}-ref.png`);
            let engineBBox: BBoxPx | undefined;
            if (entry.referenceOverride?.page === rendered.page) {
              // override 页按引擎实际内容 bbox 对齐权威图，避免非 96 DPI 下声明 bbox 的线性缩放误差。
              const engineImage = decodePng(rendered.png);
              const contentMask = computeContentMask(
                engineImage,
                tolerance.minAlpha,
                tolerance.backgroundDistance,
              );
              const minComponent = Math.max(
                4,
                Math.round(engineImage.width * engineImage.height * 0.00001),
              );
              engineBBox =
                computeBBox(contentMask, engineImage.width, engineImage.height, minComponent) ??
                undefined;
            }
            try {
              const reference = renderPdfPageToPng(
                join(REPO_ROOT, entry.pdf),
                rendered.page,
                referenceAbs,
                dpi,
                { width: rendered.width, height: rendered.height },
                engineBBox,
              );
              record.referenceMs = reference.ms;
              record.referencePng = `pages/${key}-ref.png`;
              const comparison = compareImages(
                decodePng(rendered.png),
                decodePng(readFileSync(referenceAbs)),
                { dpi, tolerance },
              );
              applyComparison(record, comparison, savePng, `${key}-diff.png`);
            } catch (error) {
              record.status = 'reference-missing';
              record.error = {
                message: error instanceof Error ? error.message : String(error),
              };
            }
          } else if (entry.pdf) {
            record.status = 'reference-missing';
            record.notes.push('pdftoppm 不可用，未生成参考图。');
          } else {
            record.notes.push('无 PDF 参考。');
          }

          // 人工确认过的基线（若存在）也参与比较；基线缺失不作为失败。
          const baselineAbs = join(BASELINE_DIR, fileSafe(entry.name), `page-${pageLabel(rendered.page)}.png`);
          if (existsSync(baselineAbs)) {
            record.baselinePng = artifactLink(baselineAbs);
            const baselineComparison = compareImages(
              decodePng(rendered.png),
              decodePng(readFileSync(baselineAbs)),
              { dpi, tolerance, computeDiff: false },
            );
            record.baselineMetrics = baselineComparison.metrics;
            if (!baselineComparison.ok) {
              record.notes.push(`基线与当前输出不一致：${baselineComparison.reasons.join('；')}`);
            }
          }

          report.pages.push(record);
        }

        for (const failure of result.failures) {
          const record = emptyPageRecord(entry.name, failure.page);
          record.status = 'engine-error';
          record.error = { code: failure.code, message: failure.message };
          record.renderMs = failure.renderMs;
          report.pages.push(record);
        }
        report.pages.sort((a, b) => a.page - b.page);
        report.totalMs = performance.now() - sampleStart;
      }

      const durationMs = performance.now() - startedAt;
      const goldenReport: GoldenReport = {
        schemaVersion: 1,
        kind: 'golden-report',
        createdAt: new Date().toISOString(),
        dpi,
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        artifactsDir,
        tolerance,
        mode: 'engine',
        summary: computeSummary(sampleReports, durationMs),
        samples: sampleReports,
      };
      const paths = writeReport(artifactsDir, goldenReport);

      // 控制台摘要，方便 run-all.mjs / CI 日志定位。
      const outcomes = sampleReports.map((sample) => `${sample.name}:${sampleOutcome(sample)}`);
      console.log(`[golden] artifacts=${artifactsDir}`);
      console.log(`[golden] samples=${goldenReport.summary.samples} ${outcomes.join(' ')}`);
      console.log(
        `[golden] pass=${goldenReport.summary.samplesPassed} fail=${goldenReport.summary.samplesFailed} ` +
          `unavailable=${goldenReport.summary.samplesUnavailable} skipped=${goldenReport.summary.samplesSkipped} ` +
          `pages=${goldenReport.summary.pagesPassed}/${goldenReport.summary.pages}`,
      );

      expect(existsSync(paths.jsonPath)).toBe(true);
      expect(existsSync(paths.htmlPath)).toBe(true);
      expect(goldenReport.summary.samples).toBe(selected.length);

      if (requireEngine) {
        expect(goldenReport.summary.samplesUnavailable, '引擎不可用的样本').toBe(0);
        expect(goldenReport.summary.samplesFailed, '失败样本').toBe(0);
        expect(goldenReport.summary.pagesFailed, '失败页').toBe(0);
      }
    },
  );
});

/** 把比较结果写入页记录并落 diff PNG。 */
function applyComparison(
  record: PageComparisonRecord,
  comparison: CompareResult,
  savePng: (fileName: string, png: Uint8Array) => string,
  diffFileName: string,
): void {
  record.status = comparison.status;
  record.metrics = comparison.metrics;
  if (comparison.diffPng) {
    record.diffPng = savePng(diffFileName, comparison.diffPng);
  }
  if (!comparison.ok) {
    record.notes.push(...comparison.reasons);
  }
}