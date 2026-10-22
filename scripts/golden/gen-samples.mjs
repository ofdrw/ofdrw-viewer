#!/usr/bin/env node
/**
 * 生成/校验回归样本清单 `packages/ofdrw-viewer-engine/test/golden/samples.json`。
 *
 * - 扫描仓库根 `ofd_pdf_match/` 的 OFD/PDF 配对；
 * - 用 pdfinfo 读取 PDF 页数与首页尺寸；
 * - 用 ZIP 中央目录统计字体/图片/JBIG2 条目；
 * - 按设计方案 19.3 分组并标注优先级；
 * - manual 与 dense-text-perf（可选）做存在性探测：缺失时仍保留条目并标 available=false。
 *
 * 用法：
 *   node scripts/golden/gen-samples.mjs            # 生成/更新清单
 *   node scripts/golden/gen-samples.mjs --check    # 校验清单与样本一致（CI）
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPdfMeta } from './lib/pdf-meta.mjs';
import { scanOfdPackage } from './lib/zip-scan.mjs';
import {
  classifySample,
  MANUAL_SAMPLE,
  OTHER_GROUP,
  TEXT_PERF_SAMPLE,
} from './lib/sample-groups.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SAMPLE_DIR = join(REPO_ROOT, 'ofd_pdf_match');
const OUT_PATH = join(
  REPO_ROOT,
  'packages',
  'ofdrw-viewer-engine',
  'test',
  'golden',
  'samples.json',
);

/**
 * 读取目录中的样本名（不含扩展名）。
 *
 * @returns {string[]} 样本名。
 */
function listSampleNames() {
  const names = new Set();
  for (const dirEntry of readdirSync(SAMPLE_DIR)) {
    const match = /^(.*)\.(ofd|pdf)$/i.exec(dirEntry);
    if (match) names.add(match[1]);
  }
  // 可选样本即使本地不存在也保留清单条目，由脚本/测试做可用性 skip。
  for (const optional of [MANUAL_SAMPLE, TEXT_PERF_SAMPLE]) {
    if (!names.has(optional.name)) names.add(optional.name);
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 扫描单个样本并生成清单条目。
 *
 * @param {string} name 样本名。
 * @returns {object} 清单条目。
 */
function buildEntry(name) {
  const ofdPath = join(SAMPLE_DIR, `${name}.ofd`);
  const pdfPath = join(SAMPLE_DIR, `${name}.pdf`);
  const hasOfd = existsSync(ofdPath);
  const hasPdf = existsSync(pdfPath);
  const available = hasOfd && hasPdf;
  const notes = [];
  const optional = name === MANUAL_SAMPLE.name || name === TEXT_PERF_SAMPLE.name;
  const { groups, priority } = classifySample(name);

  let pdfPages = null;
  let pageSizePt = null;
  let sizeMm = null;
  if (hasPdf) {
    const meta = getPdfMeta(pdfPath);
    pdfPages = meta.pages;
    if (meta.widthPt !== null && meta.heightPt !== null) {
      pageSizePt = { width: meta.widthPt, height: meta.heightPt };
      sizeMm = {
        width: Number(((meta.widthPt * 25.4) / 72).toFixed(3)),
        height: Number(((meta.heightPt * 25.4) / 72).toFixed(3)),
      };
    }
  } else {
    notes.push('PDF 缺失');
  }

  let scan = { fontEntries: 0, imageEntries: 0, jb2Entries: 0, ofdPages: null, names: [] };
  if (hasOfd) {
    try {
      scan = scanOfdPackage(ofdPath);
    } catch (error) {
      notes.push(`OFD 扫描失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    notes.push('OFD 缺失');
  }

  if (name === MANUAL_SAMPLE.name) {
    notes.push(MANUAL_SAMPLE.note);
    if (!available) notes.push('本地样本不存在：T9/T11 将 skip，不作为失败。');
  }
  if (name === TEXT_PERF_SAMPLE.name) {
    notes.push(TEXT_PERF_SAMPLE.note);
    if (!available) notes.push('本地样本不存在：文本性能用例将 skip，不作为失败。');
  }
  if (priority === 'P1' && groups.includes(OTHER_GROUP)) {
    notes.push('未列入 19.3 分组，作为补充回归（P1）。');
  }

  return {
    name,
    groups,
    priority,
    optional,
    available,
    ofd: hasOfd ? `ofd_pdf_match/${name}.ofd` : null,
    pdf: hasPdf ? `ofd_pdf_match/${name}.pdf` : null,
    pdfPages,
    ofdDeclaredPages: scan.ofdPages,
    pageSizePt,
    sizeMm,
    embeddedFonts: scan.fontEntries > 0,
    fontEntries: scan.fontEntries,
    imageEntries: scan.imageEntries,
    jb2Entries: scan.jb2Entries,
    sha256: hasOfd
      ? createHash('sha256').update(readFileSync(ofdPath)).digest('hex')
      : null,
    goldenPages: name === MANUAL_SAMPLE.name ? [...MANUAL_SAMPLE.goldenPages] : [],
    notes,
  };
}

/** 主流程。 */
function main() {
  const checkMode = process.argv.includes('--check');
  if (!existsSync(SAMPLE_DIR)) {
    console.error(`样本目录不存在：${SAMPLE_DIR}`);
    process.exit(1);
  }
  const names = listSampleNames();
  const samples = names.map(buildEntry);
  const missingRequired = samples.filter((sample) => !sample.optional && !sample.available);
  if (missingRequired.length > 0) {
    console.error(`缺少必需样本配对：${missingRequired.map((sample) => sample.name).join(', ')}`);
    process.exit(1);
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceDir: 'ofd_pdf_match',
    count: samples.length,
    samples,
  };

  if (checkMode) {
    if (!existsSync(OUT_PATH)) {
      console.error(`清单不存在：${OUT_PATH}`);
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    const changed = diffManifests(existing, manifest);
    if (changed.length > 0) {
      console.error(`样本清单已过期（${changed.length} 处差异）：`);
      for (const item of changed) console.error(`  - ${item}`);
      console.error('请运行 node scripts/golden/gen-samples.mjs 更新并人工复核。');
      process.exit(1);
    }
    console.log(`样本清单一致：${samples.length} 对（${OUT_PATH}）`);
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  printSummary(samples, OUT_PATH);
}

/**
 * 比较两份清单（忽略 generatedAt），返回差异描述。
 *
 * @param {object} existing 现有清单。
 * @param {object} fresh 新扫描清单。
 * @returns {string[]} 差异列表。
 */
function diffManifests(existing, fresh) {
  const changes = [];
  if (existing.count !== fresh.count) changes.push(`count ${existing.count} → ${fresh.count}`);
  const existingMap = new Map((existing.samples ?? []).map((sample) => [sample.name, sample]));
  for (const sample of fresh.samples) {
    const old = existingMap.get(sample.name);
    if (!old) {
      changes.push(`新增 ${sample.name}`);
      continue;
    }
    for (const key of [
      'available',
      'pdfPages',
      'ofdDeclaredPages',
      'fontEntries',
      'imageEntries',
      'jb2Entries',
      'sha256',
      'goldenPages',
      'groups',
      'priority',
    ]) {
      if (JSON.stringify(old[key]) !== JSON.stringify(sample[key])) {
        changes.push(`${sample.name}.${key}: ${JSON.stringify(old[key])} → ${JSON.stringify(sample[key])}`);
      }
    }
  }
  for (const name of existingMap.keys()) {
    if (!fresh.samples.some((sample) => sample.name === name)) changes.push(`删除 ${name}`);
  }
  return changes;
}

/** 打印摘要。 */
function printSummary(samples, outPath) {
  const groups = new Map();
  for (const sample of samples) {
    for (const group of sample.groups) groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const p0 = samples.filter((sample) => sample.priority === 'P0').length;
  const optionalMissing = samples.filter((sample) => sample.optional && !sample.available).length;
  console.log(`样本清单已写入：${outPath}`);
  console.log(`  总数：${samples.length}（P0 ${p0}，P1 ${samples.length - p0}）`);
  console.log(`  分组：${[...groups.entries()].map(([key, count]) => `${key}=${count}`).join(', ')}`);
  console.log(`  可选样本缺失：${optionalMissing}（manual/dense-text-perf）`);
  const manual = samples.find((sample) => sample.name === MANUAL_SAMPLE.name);
  if (manual) {
    console.log(
      `  manual：available=${manual.available}，PDF ${manual.pdfPages ?? '-'} 页，` +
        `字体 ${manual.fontEntries}，JBIG2 ${manual.jb2Entries}，黄金页 ${manual.goldenPages.join('/')}`,
    );
  }
  const textPerf = samples.find((sample) => sample.name === TEXT_PERF_SAMPLE.name);
  if (textPerf) {
    console.log(
      `  dense-text-perf：available=${textPerf.available}，PDF ${textPerf.pdfPages ?? '-'} 页，` +
        `字体 ${textPerf.fontEntries}，TextObject 性能样本（P0）`,
    );
  }
}

main();
