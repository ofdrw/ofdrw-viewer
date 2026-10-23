#!/usr/bin/env node
/**
 * 把 engine 与 crypto 的 CDN 构建产物打成单个压缩包。
 *
 * 产物：`release-assets/cdn-<version>.zip`
 *
 * 前置条件：已执行 `pnpm --filter @ofdrw/ofdrw-viewer-engine build` 与
 * `pnpm --filter @ofdrw/ofdrw-viewer-crypto build`。
 */

import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（脚本位于 `.github/scripts/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 需要打入 CDN 压缩包的产物（相对仓库根）。 */
const CDN_FILES = [
  'packages/ofdrw-viewer-engine/dist/ofdrw-viewer-engine.js',
  'packages/ofdrw-viewer-engine/dist/ofdrw-viewer-engine.min.js',
  'packages/ofdrw-viewer-engine/dist/ofdrw-viewer-engine.min.js.map',
  'packages/ofdrw-viewer-crypto/dist/ofdrw-viewer-crypto.js',
  'packages/ofdrw-viewer-crypto/dist/ofdrw-viewer-crypto.min.js',
  'packages/ofdrw-viewer-crypto/dist/ofdrw-viewer-crypto.min.js.map',
];

/**
 * 读取 engine 包版本号。
 *
 * @returns {Promise<string>} 版本号
 */
async function readVersion() {
  const raw = await readFile(join(REPO_ROOT, 'packages', 'ofdrw-viewer-engine', 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

/**
 * 确认产物文件都存在。
 *
 * @returns {Promise<void>}
 */
async function assertArtifacts() {
  const missing = [];
  for (const file of CDN_FILES) {
    try {
      await access(join(REPO_ROOT, file));
    } catch {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    throw new Error(`缺少 CDN 构建产物，请先构建 engine 与 crypto：\n${missing.join('\n')}`);
  }
}

/**
 * 调用系统 zip 命令打包。
 *
 * @param {string} archivePath 输出压缩包绝对路径
 * @returns {void}
 */
function createZip(archivePath) {
  const result = spawnSync('zip', ['-9', '-j', archivePath, ...CDN_FILES], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`调用 zip 失败：${result.error.message}；请确认 runner 已安装 zip`);
  }
  if (result.status !== 0) {
    throw new Error(`zip 打包失败，退出码 ${result.status}`);
  }
}

/**
 * 打包入口。
 *
 * @returns {Promise<void>}
 */
async function main() {
  await assertArtifacts();
  const version = await readVersion();
  const releaseDir = join(REPO_ROOT, 'release-assets');
  const archivePath = join(releaseDir, `cdn-${version}.zip`);

  await mkdir(releaseDir, { recursive: true });
  await rm(archivePath, { force: true });
  createZip(archivePath);

  console.log(`CDN 产物已生成：release-assets/cdn-${version}.zip`);
}

main().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});