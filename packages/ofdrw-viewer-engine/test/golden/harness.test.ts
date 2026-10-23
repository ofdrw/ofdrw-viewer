/**
 * 黄金图 harness mock 端到端自检（不依赖引擎实现）。
 *
 * 用 @napi-rs/canvas 渲染合成页面，比较：
 * - 基准页自身 → pass；
 * - 1 px 位移 → pass（1 设备像素容差）；
 * - 5 px 位移 → layout-mismatch；
 * - 颜色互换 → color-mismatch；
 * - 画布变大 10 px → size-mismatch；
 * - 缺失图元 → layout-mismatch。
 *
 * 输出 report.json / report.html / pages/*-diff.png，用于人工或 CI 校验。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveArtifactsDir } from './lib/artifacts';
import { compareImages } from './lib/compare';
import { decodePng, encodePng } from './lib/image';
import { renderMockCanvas, type MockVariant } from './lib/mock-page';
import { computeSummary, writeReport } from './lib/report';
import { DEFAULT_TOLERANCE } from './lib/types';
import type {
  GoldenReport,
  PageComparisonRecord,
  SampleReport,
  Tolerance,
} from './lib/types';

const DPI = 96;
const MM_PER_PX = 25.4 / DPI;

/** 期望的 mock 比较结论。 */
const CASES: ReadonlyArray<{ variant: MockVariant; expected: PageComparisonRecord['status'] }> = [
  { variant: 'base', expected: 'pass' },
  { variant: 'shift1', expected: 'pass' },
  { variant: 'shift5', expected: 'layout-mismatch' },
  { variant: 'color', expected: 'color-mismatch' },
  { variant: 'size', expected: 'size-mismatch' },
  { variant: 'no-triangle', expected: 'layout-mismatch' },
];

describe('黄金图 harness（mock）', () => {
  it('生成 JSON/HTML/diff 报告并判定 6 类场景', () => {
    const artifactsDir = resolveArtifactsDir('golden');
    const pagesDir = join(artifactsDir, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    const tolerance: Tolerance = { ...DEFAULT_TOLERANCE };
    const reference = renderMockCanvas('base');
    const sample: SampleReport = {
      name: 'mock-selfcheck',
      groups: ['mock'],
      priority: 'P0',
      available: true,
      optional: false,
      ofdPath: null,
      pdfPath: null,
      pdfPages: null,
      ofdDeclaredPages: null,
      ofdPages: null,
      sizeMm: { width: 400 * MM_PER_PX, height: 300 * MM_PER_PX },
      embeddedFonts: false,
      fontEntries: 0,
      imageEntries: 0,
      jb2Entries: 0,
      goldenPages: [],
      engineStatus: 'ok',
      openMs: 0,
      totalMs: 0,
      fontMissingCount: 0,
      warnings: [],
      pages: [],
      notes: ['harness 自检：合成页面，不依赖引擎。'],
    };

    CASES.forEach((testCase, index) => {
      const actual = renderMockCanvas(testCase.variant);
      const page = index + 1;
      const key = `mock-p${String(page).padStart(3, '0')}`;
      const engineName = `${key}-engine.png`;
      const referenceName = `${key}-ref.png`;
      writeFileSync(join(pagesDir, engineName), actual.png);
      writeFileSync(join(pagesDir, referenceName), reference.png);

      const comparison = compareImages(actual.image, reference.image, { dpi: DPI, tolerance });
      let diffPng: string | null = null;
      if (comparison.diffPng) {
        const diffName = `${key}-diff.png`;
        writeFileSync(join(pagesDir, diffName), comparison.diffPng);
        diffPng = `pages/${diffName}`;
      }
      const record: PageComparisonRecord = {
        sample: sample.name,
        page,
        status: comparison.status,
        width: actual.image.width,
        height: actual.image.height,
        sizeMm: {
          width: Number((actual.image.width * MM_PER_PX).toFixed(4)),
          height: Number((actual.image.height * MM_PER_PX).toFixed(4)),
        },
        enginePng: `pages/${engineName}`,
        referencePng: `pages/${referenceName}`,
        baselinePng: null,
        diffPng,
        metrics: comparison.metrics,
        baselineMetrics: null,
        renderMs: null,
        referenceMs: null,
        warnings: [],
        error: null,
        notes: comparison.reasons,
      };
      sample.pages.push(record);
      expect(comparison.status, `variant=${testCase.variant}`).toBe(testCase.expected);
    });

    sample.totalMs = 12;
    const report: GoldenReport = {
      schemaVersion: 1,
      kind: 'mock-selfcheck',
      createdAt: new Date().toISOString(),
      dpi: DPI,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      artifactsDir,
      tolerance,
      mode: 'mock',
      summary: computeSummary([sample], sample.totalMs),
      samples: [sample],
    };
    const paths = writeReport(artifactsDir, report);

    expect(existsSync(paths.jsonPath)).toBe(true);
    expect(existsSync(paths.htmlPath)).toBe(true);

    const saved = JSON.parse(readFileSync(paths.jsonPath, 'utf8')) as GoldenReport;
    expect(saved.summary.pages).toBe(6);
    expect(saved.summary.pagesPassed).toBe(2);
    expect(saved.summary.pagesFailed).toBe(4);
    expect(saved.samples[0]!.pages.map((page) => page.status)).toEqual(
      CASES.map((testCase) => testCase.expected),
    );

    const html = readFileSync(paths.htmlPath, 'utf8');
    expect(html).toContain('mock-selfcheck');

    // diff PNG 必须是合法图片（check-harness 会再做文件存在性校验）。
    for (const page of saved.samples[0]!.pages) {
      if (!page.diffPng) continue;
      const diff = decodePng(readFileSync(join(artifactsDir, page.diffPng)));
      // diff 图按两图公共区域生成（尺寸差场景下会小于实际图）。
      expect(diff.width).toBe(Math.min(page.width ?? diff.width, 400));
      expect(diff.height).toBe(Math.min(page.height ?? diff.height, 300));
      // 再编码一次确保可被浏览器/报告正常打开。
      expect(encodePng(diff).byteLength).toBeGreaterThan(0);
    }
  });
});