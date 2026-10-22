/**
 * 回归样本清单（57 对：55 对基准样本 + 可选 manual + 可选 dense-text-perf）。
 *
 * 清单由 `scripts/golden/gen-samples.mjs` 生成；测试只读取与校验，
 * 业务原件不复制进仓库。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { KnownTolerancePage, SampleReport } from './types';

/** 设计方案 19.3 的分组键（顺序固定，便于报告展示）。 */
export const REQUIRED_GROUPS = Object.freeze([
  'basic-text-path',
  'horizontal-delta',
  'transparency-blend',
  'image',
  'scan-jbig2',
  'clip-composite',
  'pattern',
  'annotation-seal',
  'irregular-structure',
]);

/** manual 样本的特殊分组键。 */
export const MANUAL_GROUP = 'scan-image-ctm';

/** 文本性能样本的补充分组键（不在 19.3 九组内）。 */
export const TEXT_PERF_GROUP = 'text-perf';

/** 其余样本的分组键。 */
export const OTHER_GROUP = 'other';

/** 样本清单条目。 */
export interface SampleManifestEntry {
  /** 样本名（不含扩展名）。 */
  name: string;
  /** 分组。 */
  groups: string[];
  /** 优先级。 */
  priority: 'P0' | 'P1';
  /** 是否可选（manual/dense-text-perf 缺失时 skip）。 */
  optional: boolean;
  /** 本地是否存在。 */
  available: boolean;
  /** OFD 仓库相对路径。 */
  ofd: string | null;
  /** PDF 仓库相对路径。 */
  pdf: string | null;
  /** PDF 页数。 */
  pdfPages: number | null;
  /** OFD 包内 Document.xml 声明的页数。 */
  ofdDeclaredPages: number | null;
  /** 首页尺寸，pt。 */
  pageSizePt: { width: number; height: number } | null;
  /** 首页尺寸，mm。 */
  sizeMm: { width: number; height: number } | null;
  /** 是否含内嵌字体。 */
  embeddedFonts: boolean;
  /** 字体条目数。 */
  fontEntries: number;
  /** 图片条目数。 */
  imageEntries: number;
  /** JBIG2 条目数。 */
  jb2Entries: number;
  /** 文件 SHA-256（用于识别样本是否被替换）。 */
  sha256: string | null;
  /** 只对这些页做黄金图（1 起）；空表示全部。 */
  goldenPages: number[];
  /** 备注。 */
  notes: string[];
  /** 人工确认的参考配对不匹配页（1 起）；差异不记为引擎缺陷。 */
  referenceMismatchPages?: number[];
  /** 参考配对不匹配原因。 */
  referenceMismatchReason?: string;
  /** 人工确认的 known tolerance 页；这些页不记为引擎失败。 */
  knownTolerancePages?: KnownTolerancePage[];
}

/** 清单文件结构。 */
export interface SampleManifest {
  /** schema 版本。 */
  schemaVersion: 1;
  /** 生成时间（ISO 8601）。 */
  generatedAt: string;
  /** 样本来源目录（仓库相对）。 */
  sourceDir: string;
  /** 条目数。 */
  count: number;
  /** 条目。 */
  samples: SampleManifestEntry[];
}

/** 默认清单路径：`test/golden/samples.json`。 */
export const DEFAULT_MANIFEST_PATH = fileURLToPath(new URL('../samples.json', import.meta.url));

/**
 * 读取样本清单。
 *
 * @param manifestPath 清单路径；默认 `test/golden/samples.json`。
 * @returns 清单。
 */
export function loadSampleManifest(manifestPath = DEFAULT_MANIFEST_PATH): SampleManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as SampleManifest;
}

/**
 * 按名称查找样本。
 *
 * @param manifest 清单。
 * @param name 样本名。
 * @returns 条目；不存在时返回 undefined。
 */
export function findSample(manifest: SampleManifest, name: string): SampleManifestEntry | undefined {
  return manifest.samples.find((sample) => sample.name === name);
}

/**
 * 计算需要生成黄金图的页列表（1 起）。
 *
 * @param sample 清单条目。
 * @returns 页号列表；清单未限定页时返回 1..pdfPages，页数未知时返回 [1]。
 */
export function goldenPagesOf(sample: SampleManifestEntry): number[] {
  if (sample.goldenPages.length > 0) return [...sample.goldenPages];
  if (sample.pdfPages && sample.pdfPages > 0) {
    return Array.from({ length: sample.pdfPages }, (_, index) => index + 1);
  }
  return [1];
}

/**
 * 由清单条目创建空的样本报告骨架。
 *
 * @param sample 清单条目。
 * @returns 可填充的样本报告。
 */
export function createEmptySampleReport(sample: SampleManifestEntry): SampleReport {
  return {
    name: sample.name,
    groups: [...sample.groups],
    priority: sample.priority,
    available: sample.available,
    optional: sample.optional,
    ofdPath: sample.ofd,
    pdfPath: sample.pdf,
    pdfPages: sample.pdfPages,
    ofdDeclaredPages: sample.ofdDeclaredPages,
    ofdPages: null,
    sizeMm: sample.sizeMm,
    embeddedFonts: sample.embeddedFonts,
    fontEntries: sample.fontEntries,
    imageEntries: sample.imageEntries,
    jb2Entries: sample.jb2Entries,
    goldenPages: [...sample.goldenPages],
    engineStatus: sample.available ? 'skipped' : 'skipped',
    openMs: null,
    totalMs: 0,
    fontMissingCount: 0,
    warnings: [],
    pages: [],
    notes: [...sample.notes],
    ...(sample.referenceMismatchPages ? { referenceMismatchPages: [...sample.referenceMismatchPages] } : {}),
    ...(sample.referenceMismatchReason ? { referenceMismatchReason: sample.referenceMismatchReason } : {}),
    ...(sample.knownTolerancePages ? { knownTolerancePages: sample.knownTolerancePages.map((page) => ({ ...page })) } : {}),
  };
}
