/**
 * 黄金图分类口径：负样本、known tolerance 上限与参考不匹配页。
 *
 * 这些用例直接构造 SampleReport，不依赖真实引擎/样本，防止分类逻辑回退。
 */

import { describe, expect, it } from 'vitest';
import { computeSummary, sampleOutcome } from './lib/report';
import type {
  CompareMetrics,
  PageComparisonRecord,
  SampleReport,
} from './lib/types';

/** 构造一页比较记录。 */
function makePage(overrides: Partial<PageComparisonRecord> = {}): PageComparisonRecord {
  return {
    sample: 'synthetic',
    page: 1,
    status: 'pass',
    width: 100,
    height: 100,
    sizeMm: { width: 100, height: 100 },
    enginePng: 'pages/synthetic-p001-engine.png',
    referencePng: 'pages/synthetic-p001-ref.png',
    baselinePng: null,
    diffPng: null,
    metrics: makeMetrics(),
    baselineMetrics: null,
    renderMs: 1,
    referenceMs: 1,
    warnings: [],
    error: null,
    notes: [],
    ...overrides,
  };
}

/** 构造完整指标。 */
function makeMetrics(overrides: Partial<CompareMetrics> = {}): CompareMetrics {
  return {
    actualSize: { width: 100, height: 100 },
    expectedSize: { width: 100, height: 100 },
    sizeDeltaPx: { width: 0, height: 0 },
    sizeDeltaMm: { width: 0, height: 0 },
    actualBBoxMm: { x: 0, y: 0, width: 100, height: 100 },
    expectedBBoxMm: { x: 0, y: 0, width: 100, height: 100 },
    layoutDeltaMm: 0,
    keyColorMaxDE: 0,
    keyColorCoverageDelta: 0,
    colorP95DE: 0,
    colorSampleCount: 1,
    ssim: 1,
    pixelDiffRatio: 0,
    regions: [],
    edgeDensity: 0,
    ...overrides,
  };
}

/** 构造一个样本报告。 */
function makeSample(overrides: Partial<SampleReport> = {}): SampleReport {
  return {
    name: 'synthetic',
    groups: ['other'],
    priority: 'P1',
    available: true,
    optional: false,
    ofdPath: null,
    pdfPath: null,
    pdfPages: null,
    ofdDeclaredPages: null,
    ofdPages: null,
    sizeMm: null,
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
    notes: [],
    ...overrides,
  };
}

describe('expected-negative 负样本', () => {
  it('W_IMAGE_DECODE + 页面继续 + 内容可见 → expected-negative，不计 failed', () => {
    const sample = makeSample({
      pages: [
        makePage({
          status: 'color-mismatch',
          warnings: [{ code: 'W_IMAGE_DECODE', message: '缺图', pageIndex: 0 }],
        }),
        makePage({ page: 2, status: 'pass' }),
      ],
      negativeSample: {
        pages: [1],
        expectedWarnings: ['W_IMAGE_DECODE'],
        requireContent: true,
        reason: '缺图负样本',
      },
    });
    expect(sampleOutcome(sample)).toBe('expected-negative');
    const summary = computeSummary([sample], 1);
    expect(summary.samplesExpectedNegative).toBe(1);
    expect(summary.samplesFailed).toBe(0);
    expect(summary.pagesExpectedNegative).toBe(1);
    expect(summary.pagesFailed).toBe(0);
  });

  it('缺少预期 warning → failed', () => {
    const sample = makeSample({
      pages: [makePage({ status: 'color-mismatch' })],
      negativeSample: {
        pages: [1],
        expectedWarnings: ['W_IMAGE_DECODE'],
        requireContent: true,
        reason: '缺图负样本',
      },
    });
    expect(sampleOutcome(sample)).toBe('failed');
    expect(computeSummary([sample], 1).samplesFailed).toBe(1);
  });

  it('负样本页无内容 → failed', () => {
    const sample = makeSample({
      pages: [
        makePage({
          status: 'color-mismatch',
          metrics: makeMetrics({ actualBBoxMm: null }),
          warnings: [{ code: 'W_IMAGE_DECODE', message: '缺图', pageIndex: 0 }],
        }),
      ],
      negativeSample: {
        pages: [1],
        expectedWarnings: ['W_IMAGE_DECODE'],
        requireContent: true,
        reason: '缺图负样本',
      },
    });
    expect(sampleOutcome(sample)).toBe('failed');
  });
});

describe('known tolerance 上限', () => {
  it('ΔE 与占比差均在声明上限内 → known-tolerance，不计 failed', () => {
    const sample = makeSample({
      pages: [
        makePage({
          status: 'color-mismatch',
          metrics: makeMetrics({ keyColorMaxDE: 2.39, keyColorCoverageDelta: 0.6126 }),
        }),
      ],
      knownTolerancePages: [
        {
          page: 1,
          maxDeltaE: 2.4,
          maxCoverageDelta: 0.613,
          reason: '仅底色/扫描色差',
        },
      ],
    });
    expect(sampleOutcome(sample)).toBe('known-tolerance');
    const summary = computeSummary([sample], 1);
    expect(summary.samplesKnownTolerance).toBe(1);
    expect(summary.samplesFailed).toBe(0);
    expect(summary.pagesKnownTolerance).toBe(1);
    expect(summary.pagesFailed).toBe(0);
  });

  it('占比差超出声明上限 → failed，不掩盖', () => {
    const sample = makeSample({
      pages: [
        makePage({
          status: 'color-mismatch',
          metrics: makeMetrics({ keyColorMaxDE: 2.39, keyColorCoverageDelta: 0.7 }),
        }),
      ],
      knownTolerancePages: [
        {
          page: 1,
          maxDeltaE: 2.4,
          maxCoverageDelta: 0.613,
          reason: '仅底色/扫描色差',
        },
      ],
    });
    expect(sampleOutcome(sample)).toBe('failed');
    expect(computeSummary([sample], 1).pagesFailed).toBe(1);
  });
});
