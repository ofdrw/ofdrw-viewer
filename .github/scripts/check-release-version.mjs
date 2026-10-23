#!/usr/bin/env node
/**
 * 校验发布标签与四个包的版本号是否一致。
 *
 * 版本号以各包 `package.json` 为准：打标签前必须先把四个包统一改成目标版本，
 * 避免出现“源码是旧版本、Release 是另一个版本”的情况。
 *
 * 用法：
 *   node .github/scripts/check-release-version.mjs <tag>
 *
 * 参数：
 *   tag - 发布标签，形如 `v0.1.0` 或 `v0.2.0-beta.1`
 *
 * 输出：
 *   校验通过时向 `GITHUB_OUTPUT` 写入 `version=<x.y.z>`，并以 0 退出；
 *   标签格式错误或版本不一致时输出 `::error::` 并以 1 退出。
 */

import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（脚本位于 `.github/scripts/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 参与发布的包：包名与相对仓库根目录的路径。 */
const PACKAGES = [
  { name: '@ofdrw/ofdrw-viewer-engine', dir: 'packages/ofdrw-viewer-engine' },
  { name: '@ofdrw/ofdrw-viewer-crypto', dir: 'packages/ofdrw-viewer-crypto' },
  { name: '@ofdrw/ofdrw-viewer-ui', dir: 'packages/ofdrw-viewer-ui' },
  { name: '@ofdrw/ofdrw-viewer-cli', dir: 'packages/ofdrw-viewer-cli' },
];

/** 合法标签：`v` + 语义化版本，可选预发布或构建后缀。捕获组 1 为不带 v 的版本号。 */
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * 输出 GitHub Actions 错误注解并终止进程。
 *
 * @param {string} message 错误说明
 * @returns {never}
 */
function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/**
 * 读取指定包的版本号。
 *
 * @param {string} packageDir 包目录（相对仓库根）
 * @returns {Promise<string>} `package.json` 中的 version 字段
 */
async function readPackageVersion(packageDir) {
  const file = join(REPO_ROOT, packageDir, 'package.json');
  const raw = await readFile(file, 'utf8');
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`${file} 缺少 version 字段`);
  }
  return pkg.version;
}

/**
 * 校验入口。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const tag = process.argv[2];
  if (!tag) {
    fail('缺少标签参数；用法：node .github/scripts/check-release-version.mjs v0.1.0');
  }

  const matched = TAG_PATTERN.exec(tag);
  if (!matched) {
    fail(`标签格式不合法：${tag}；应为 v<主版本>.<次版本>.<修订版本>[-预发布]`);
  }
  const version = matched[1];

  const mismatches = [];
  for (const pkg of PACKAGES) {
    const actual = await readPackageVersion(pkg.dir);
    if (actual !== version) {
      mismatches.push(`  ${pkg.name}：${actual}（期望 ${version}）`);
    }
  }

  if (mismatches.length > 0) {
    fail(`标签 ${tag} 与包版本不一致，请先统一修改 package.json：\n${mismatches.join('\n')}`);
  }

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `version=${version}\n`, 'utf8');
  }

  console.log(`标签 ${tag} 与四个包版本一致：${version}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});