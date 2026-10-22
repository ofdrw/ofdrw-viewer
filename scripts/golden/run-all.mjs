#!/usr/bin/env node
/**
 * 批量回归入口：55 对基准样本 + 可选 manual + 可选 dense-text-perf。
 *
 * 通过 vitest（源码 alias）运行 `test/e2e/run-all.e2e.test.ts`，输出：
 * - test/.artifacts/golden/<timestamp>/report.json|html；
 * - pages/*-engine.png / *-ref.png / *-diff.png。
 *
 * 用法：
 *   node scripts/golden/run-all.mjs
 *   node scripts/golden/run-all.mjs --sample manual --dpi 96
 *   node scripts/golden/run-all.mjs --require-engine     # T9/T11 门禁
 *   node scripts/golden/run-all.mjs --max-pages 5
 *
 * 说明：manual/dense-text-perf 不提交仓库；缺失时脚本提示并跳过，不当作失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENGINE_DIR = join(REPO_ROOT, 'packages', 'ofdrw-viewer-engine');

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = {
    dpi: 96,
    sample: '',
    maxPages: null,
    requireEngine: false,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--require-engine') options.requireEngine = true;
    else if (token === '--dpi') options.dpi = Number(argv[++i]);
    else if (token === '--sample') options.sample = argv[++i] ?? '';
    else if (token === '--max-pages') options.maxPages = Number(argv[++i]);
    else if (token === '--out') options.outDir = argv[++i] ?? null;
    else if (token === '--help' || token === '-h') {
      console.log('用法：node scripts/golden/run-all.mjs [--sample <name>] [--dpi 96] [--max-pages N] [--require-engine] [--out <dir>]');
      process.exit(0);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const stamp = (() => {
  const now = new Date();
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  );
})();
const outDir = options.outDir
  ? join(REPO_ROOT, options.outDir)
  : process.env.GOLDEN_OUT_DIR ?? join(REPO_ROOT, 'test', '.artifacts', 'golden', stamp);

const env = {
  ...process.env,
  GOLDEN_RUN_ALL: '1',
  GOLDEN_OUT_DIR: outDir,
  GOLDEN_DPI: String(options.dpi),
};
if (options.requireEngine) env.GOLDEN_REQUIRE_ENGINE = '1';
if (options.sample) env.GOLDEN_SAMPLE_FILTER = options.sample;
if (options.maxPages !== null) env.GOLDEN_MAX_PAGES = String(options.maxPages);

console.log(`[run-all] 产物目录：${outDir}`);
console.log(
  `[run-all] dpi=${options.dpi} sample=${options.sample || '(全部)'} ` +
    `maxPages=${options.maxPages ?? '(不限)'} requireEngine=${options.requireEngine}`,
);

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vitest', 'run', 'test/e2e/run-all.e2e.test.ts', '--reporter=verbose'],
  { cwd: ENGINE_DIR, stdio: 'inherit', env },
);

const reportPath = join(outDir, 'report.json');
if (!existsSync(reportPath)) {
  console.error(`[run-all] 失败：未找到报告 ${reportPath}`);
  process.exit(result.status ?? 1);
}

/** 样本结论（与 report.ts 的 sampleOutcome 保持一致）。 */
function classify(sample) {
  if (!sample.available) return 'skipped';
  if (sample.engineStatus === 'unavailable') return 'unavailable';
  if (sample.engineStatus === 'error') return 'failed';
  const compared = sample.pages.filter(
    (page) => page.status !== 'skipped' && page.status !== 'reference-missing',
  );
  if (compared.length === 0) return 'skipped';
  return compared.some((page) => page.status !== 'pass') ? 'failed' : 'passed';
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const lines = report.samples.map((sample) => {
  const outcome = classify(sample);
  const pages = sample.pages.length;
  return (
    `${sample.name.padEnd(30)} ${outcome.padEnd(11)} ` +
    `pages=${String(pages).padStart(2)}/${String(sample.pdfPages ?? '-').padStart(2)} ` +
    `fonts=${String(sample.fontEntries).padStart(2)} missing=${String(sample.fontMissingCount).padStart(2)} ` +
    `jb2=${String(sample.jb2Entries).padStart(2)} ` +
    `open=${sample.openMs === null ? '-' : sample.openMs.toFixed(1)}ms ` +
    `total=${sample.totalMs.toFixed(1)}ms`
  );
});
console.log('\n[run-all] 样本结果：');
for (const line of lines) console.log(`  ${line}`);
const summary = report.summary;
console.log(
  `\n[run-all] 汇总：样本 ${summary.samplesPassed}/${summary.samples} 通过，` +
    `失败 ${summary.samplesFailed}，引擎不可用 ${summary.samplesUnavailable}，跳过 ${summary.samplesSkipped}；` +
    `页 ${summary.pagesPassed}/${summary.pages} 通过，失败 ${summary.pagesFailed}；` +
    `耗时 ${(summary.durationMs / 1000).toFixed(1)}s`,
);
console.log(`[run-all] 报告：${join(outDir, 'report.html')}`);

for (const optionalName of ['manual', 'dense-text-perf']) {
  const sample = report.samples.find((item) => item.name === optionalName);
  if (sample && !sample.available) {
    console.log(
      `[run-all] 提示：${optionalName}.ofd/${optionalName}.pdf 本地不存在，已跳过（不提交仓库，不视为失败）。`,
    );
  }
}

if (options.requireEngine) {
  const gatingFailures =
    summary.samplesUnavailable + summary.samplesFailed + summary.pagesFailed;
  if (gatingFailures > 0) {
    console.error('[run-all] 门禁失败：存在引擎不可用/失败样本或失败页。');
    process.exit(1);
  }
}

process.exit(result.status ?? 0);
