#!/usr/bin/env node
/**
 * 从本地 OFD 样本提取包内条目到 `test/.fixtures/`（调试/脱敏用）。
 *
 * 业务原件只读；提取结果位于 .gitignore 忽略的 `test/.fixtures/`，不得提交。
 * 条目路径做安全校验：拒绝绝对路径与 `..` 段，防止写出目标目录。
 *
 * 用法：
 *   node scripts/golden/extract-fixture.mjs --sample hello
 *   node scripts/golden/extract-fixture.mjs --ofd path/to/file.ofd --out test/.fixtures/custom
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEntries, readEntry } from './lib/zip-scan.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 解析 `--key value` 参数。 */
function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, 'true');
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sampleName = args.get('sample');
if (!sampleName && !args.get('ofd')) {
  console.error('用法：node scripts/golden/extract-fixture.mjs --sample <name> [--out <dir>]');
  process.exit(1);
}

const ofdPath = args.get('ofd')
  ? resolve(REPO_ROOT, args.get('ofd'))
  : join(REPO_ROOT, 'ofd_pdf_match', `${sampleName}.ofd`);
const outDir = args.get('out')
  ? resolve(REPO_ROOT, args.get('out'))
  : join(REPO_ROOT, 'test', '.fixtures', sampleName ?? 'sample');

const buffer = readFileSync(ofdPath);
const entries = listEntries(buffer);
let totalBytes = 0;
for (const entry of entries) {
  // 目录条目（以 / 结尾）只建目录，不能当文件写，否则后续子文件会 EEXIST。
  if (entry.name.endsWith('/')) {
    mkdirSync(resolve(outDir, normalize(entry.name)), { recursive: true });
    continue;
  }
  const normalized = normalize(entry.name).split(sep).join('/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    console.warn(`跳过不安全条目：${entry.name}`);
    continue;
  }
  const target = resolve(outDir, normalized);
  if (target !== outDir && !target.startsWith(outDir + sep)) {
    console.warn(`跳过越界条目：${entry.name}`);
    continue;
  }
  const data = readEntry(buffer, entry.name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  totalBytes += data.length;
}
console.log(`已提取 ${entries.length} 个条目到 ${outDir}（${(totalBytes / 1024).toFixed(1)} KiB）`);
console.log('提示：test/.fixtures/ 已被 .gitignore 忽略，不要提交业务原件。');