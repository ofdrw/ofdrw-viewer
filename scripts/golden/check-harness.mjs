#!/usr/bin/env node
/**
 * 黄金图 harness 自检（开发期 smoke）。
 *
 * 运行 `test/golden` 下的 fixture/比较/mock/PDF 参考测试，并检查报告产物：
 * - report.json / report.html 存在且可解析；
 * - 至少生成 1 个 diff PNG；
 * - pdftoppm/pdfinfo 可用性提示（PDF 参考测试缺工具时 skip，不硬失败）。
 *
 * 用法：node scripts/golden/check-harness.mjs
 * 退出码：0=通过；1=vitest 失败或产物缺失。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENGINE_DIR = join(REPO_ROOT, 'packages', 'ofdrw-viewer-engine');
const stamp = (() => {
  const now = new Date();
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  );
})();
const outDir = process.env.GOLDEN_OUT_DIR ?? join(REPO_ROOT, 'test', '.artifacts', 'golden', stamp);

/** 探测外部命令。 */
function hasCommand(command, args = ['-v']) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

console.log(`[check-harness] 产物目录：${outDir}`);
console.log(`[check-harness] pdftoppm=${hasCommand('pdftoppm') ? 'ok' : 'missing'} pdfinfo=${hasCommand('pdfinfo') ? 'ok' : 'missing'}`);

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vitest', 'run', 'test/golden', '--reporter=verbose'],
  {
    cwd: ENGINE_DIR,
    stdio: 'inherit',
    env: { ...process.env, GOLDEN_OUT_DIR: outDir },
  },
);

if (result.status !== 0) {
  console.error('[check-harness] 失败：vitest 未通过');
  process.exit(result.status ?? 1);
}

const reportJson = join(outDir, 'report.json');
const reportHtml = join(outDir, 'report.html');
const pagesDir = join(outDir, 'pages');
const problems = [];
if (!existsSync(reportJson)) problems.push(`缺少 ${reportJson}`);
if (!existsSync(reportHtml)) problems.push(`缺少 ${reportHtml}`);
let summary = null;
if (existsSync(reportJson)) {
  try {
    const report = JSON.parse(readFileSync(reportJson, 'utf8'));
    summary = report.summary;
    if (report.schemaVersion !== 1) problems.push('report.schemaVersion 不是 1');
  } catch (error) {
    problems.push(`report.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
const diffFiles = existsSync(pagesDir)
  ? readdirSync(pagesDir).filter((name) => name.endsWith('-diff.png'))
  : [];
if (diffFiles.length === 0) problems.push('未生成 diff PNG（pages/*-diff.png）');

if (problems.length > 0) {
  console.error('[check-harness] 产物校验失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `[check-harness] 通过：samples=${summary?.samples ?? '-'} ` +
    `pages=${summary?.pagesPassed ?? '-'}/${summary?.pages ?? '-'} diff=${diffFiles.length}`,
);
console.log(`[check-harness] 报告：${reportHtml}`);